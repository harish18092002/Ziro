// What the user asked the eval to do, and the rules about what it may do unasked. Pure, so the safety
// rules are tested: a run that can use a model does nothing without --confirm and a ceiling.
//
// Two ceilings, because there are two kinds of spend: --max-requests for the Gemini free tier (it costs no
// money but a day's allowance is small) and --max-cost-usd for a provider that charges (Claude).
import { CONFIGS, type ConfigName, LEGS, type LegName } from '@ziro/evals';
import { CACHE_MODES, type CacheMode } from '../llm/cache.js';
import { callsModel, spendsMoney } from './runners.js';

export { callsModel, spendsMoney };

export type Command = 'run' | 'smoke' | 'stress';

export interface EvalPlan {
  readonly command: Command;
  readonly preset: 'demo' | 'eval';
  readonly seed: number;
  readonly configs: readonly ConfigName[];
  readonly repeats: number;
  readonly legs: readonly LegName[];
  /** Configs that also get a run with CLUSTER_EXCEPTIONS on. */
  readonly clusterConfigs: readonly ConfigName[];
  readonly injections: number;
  readonly concurrency: number;
  /** Total ceiling for the whole invocation, in USD, for configs that charge. */
  readonly maxCostUsd: number | null;
  /** Total ceiling on requests sent to providers for the whole invocation. */
  readonly maxRequests: number | null;
  /** Run only the first N investigations of each run (a quick look, not a score); null runs them all. */
  readonly sample: number | null;
  /** The cache mode named on the command line, or null to use LLM_CACHE. */
  readonly cache: CacheMode | null;
  readonly confirm: boolean;
  readonly out: string | null;
  readonly stress: boolean;
  readonly stressDir: string;
}

export const SMOKE_MAX_COST_USD = 0.25;
export const SMOKE_MAX_REQUESTS = 30;
/** The configs a plain `npm run eval` runs: the rules and the free-tier Gemini ones. Claude is asked for by name. */
export const DEFAULT_CONFIGS = 'rules,lite-loop,lite-single,flash-single';

export type Parsed = { readonly plan: EvalPlan } | { readonly error: string };

const list = <T extends string>(
  text: string,
  allowed: readonly T[],
  what: string,
): T[] | string => {
  const items = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = items.find((i) => !(allowed as readonly string[]).includes(i));
  if (bad !== undefined) return `unknown ${what} "${bad}" (choose from ${allowed.join(', ')})`;
  if (items.length === 0) return `${what} list is empty`;
  return [...new Set(items)] as T[];
};

/** A positive whole number from a flag, or null when it was not given. */
function count(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  max: number,
): number | null | string {
  const raw = flags.get(name);
  if (raw === undefined) return null;
  const n = Number(raw);
  if (typeof raw !== 'string' || !Number.isInteger(n) || n < 1 || n > max) {
    return `--${name} must be a whole number from 1 to ${max}`;
  }
  return n;
}

export function parseEvalArgs(
  argv: readonly string[],
  defaults: { out: string; stressDir: string },
): Parsed {
  const [first, ...rest] = argv;
  const command: Command = first === 'smoke' || first === 'stress' ? first : 'run';
  const args = first === 'smoke' || first === 'stress' || first === 'run' ? rest : argv;

  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (!a.startsWith('--')) return { error: `unexpected argument "${a}"` };
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (name === undefined) return { error: `bad flag "${a}"` };
    if (inline !== undefined) flags.set(name, inline);
    else if (args[i + 1] !== undefined && !args[i + 1]?.startsWith('--'))
      flags.set(name, args[(i += 1)] as string);
    else flags.set(name, true);
  }
  const text = (name: string, fallback: string): string => {
    const v = flags.get(name);
    return typeof v === 'string' ? v : fallback;
  };
  const known = new Set([
    'seed',
    'preset',
    'configs',
    'repeats',
    'legs',
    'cluster',
    'injections',
    'concurrency',
    'max-cost-usd',
    'max-requests',
    'sample',
    'cache',
    'confirm',
    'out',
    'stress',
    'stress-dir',
    'no-stress',
  ]);
  for (const k of flags.keys()) if (!known.has(k)) return { error: `unknown flag --${k}` };

  const preset = command === 'smoke' ? 'demo' : text('preset', 'eval');
  if (preset !== 'demo' && preset !== 'eval')
    return { error: `--preset must be demo or eval (stress has its own command), got "${preset}"` };
  const seed = Number(text('seed', '42'));
  if (!Number.isInteger(seed) || seed < 0 || seed > 4_294_967_295)
    return { error: '--seed must be an unsigned 32-bit integer' };

  const configs = list(
    text('configs', command === 'smoke' ? 'rules,lite-single' : DEFAULT_CONFIGS),
    CONFIGS,
    'config',
  );
  if (typeof configs === 'string') return { error: configs };
  const legs = list(text('legs', command === 'smoke' ? 'plain' : 'plain,attacked'), LEGS, 'leg');
  if (typeof legs === 'string') return { error: legs };
  // Clustering is a variant of a config that is being run anyway. The default (lite-single) applies only
  // when it is among the configs; naming a config that is not being run is a mistake worth saying so.
  const clusterText = flags.get('cluster');
  const asked =
    clusterText === 'none'
      ? []
      : list(
          typeof clusterText === 'string' ? clusterText : 'lite-single',
          CONFIGS,
          'cluster config',
        );
  if (typeof asked === 'string') return { error: asked };
  if (typeof clusterText === 'string' && clusterText !== 'none') {
    const stray = asked.find((c) => !configs.includes(c));
    if (stray !== undefined) return { error: `--cluster ${stray} needs ${stray} in --configs` };
  }
  const clusterConfigs = command === 'smoke' ? [] : asked.filter((c) => configs.includes(c));

  // One repeat by default: a repeat of a model config is a request budget spent again.
  const repeats = Number(text('repeats', '1'));
  const injections = Number(text('injections', '16'));
  const concurrency = Number(text('concurrency', '4'));
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
    return { error: '--repeats must be 1 to 10' };
  if (!Number.isInteger(injections) || injections < 0 || injections > 100)
    return { error: '--injections must be 0 to 100' };
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    return { error: '--concurrency must be 1 to 16' };

  const capText = flags.get('max-cost-usd');
  const cap =
    capText === undefined ? (command === 'smoke' ? SMOKE_MAX_COST_USD : null) : Number(capText);
  if (cap !== null && !(Number.isFinite(cap) && cap > 0))
    return { error: '--max-cost-usd must be a positive number of dollars' };

  const requests = count(flags, 'max-requests', 1_000_000);
  if (typeof requests === 'string') return { error: requests };
  const sample = count(flags, 'sample', 100_000);
  if (typeof sample === 'string') return { error: sample };

  const cacheText = flags.get('cache');
  if (cacheText !== undefined && !(CACHE_MODES as readonly unknown[]).includes(cacheText)) {
    return { error: `--cache must be ${CACHE_MODES.join(', ')}` };
  }

  const confirm = flags.get('confirm') === true || flags.get('confirm') === 'true';
  const out = flags.get('out');
  const wantsStress =
    command === 'stress' ||
    (command === 'run' &&
      flags.get('no-stress') !== true &&
      configs.includes('rules') &&
      flags.get('stress') !== 'false');

  return {
    plan: {
      command,
      preset,
      seed,
      configs,
      repeats,
      legs: legs.filter((l) => l === 'plain' || injections > 0),
      clusterConfigs,
      injections,
      concurrency,
      maxCostUsd: cap,
      maxRequests: requests ?? (command === 'smoke' ? SMOKE_MAX_REQUESTS : null),
      sample,
      cache: (cacheText as CacheMode | undefined) ?? null,
      confirm,
      out: typeof out === 'string' ? out : command === 'smoke' ? null : defaults.out,
      stress: wantsStress,
      stressDir: text('stress-dir', defaults.stressDir),
    },
  };
}

const named = (plan: EvalPlan): ConfigName[] => [...plan.configs, ...plan.clusterConfigs];

/**
 * Why this plan may not run as it stands; null if it may. `cache` is the mode that will be in force:
 * in replay nothing is sent to a provider, so no ceiling is needed.
 */
export function refusal(plan: EvalPlan, cache: CacheMode): string | null {
  if (plan.command === 'stress' || cache === 'replay') return null;
  const configs = named(plan);
  if (configs.some(spendsMoney) && plan.maxCostUsd === null) {
    return 'a run that calls Claude needs a money ceiling: pass --max-cost-usd <dollars>';
  }
  if (configs.some((c) => callsModel(c) && !spendsMoney(c)) && plan.maxRequests === null) {
    return 'a run that calls Gemini needs a request ceiling (the free tier is small): pass --max-requests <n>';
  }
  return null;
}

/** Does this plan send requests to a provider, so that it must wait for --confirm? */
export const isPaid = (plan: EvalPlan, cache: CacheMode): boolean =>
  plan.command !== 'stress' && cache !== 'replay' && named(plan).some(callsModel);
