// npm run eval -- --seed 42 --preset eval --configs rules,lite-single --sample 10 --max-requests 40 --confirm
// npm run eval -- --configs rules,lite-single,flash-single --cache replay     (free: answers from a record)
// npm run eval:smoke            (demo preset, one repeat, hard caps, skipped without an API key)
// npm run eval -- stress        (rules throughput only; free)
//
// Anything that sends a request to a model does NOTHING until --confirm, and needs a ceiling
// (--max-requests for Gemini's free tier, --max-cost-usd for Claude): without them it prints what it would do
// and exits, and the API keys are not used. With --cache replay nothing is sent, so it runs without either.
//
// Which model "lite", "flash" and "claude" mean comes from LLM_CHAIN (the first and second Gemini entries and
// the first Anthropic entry). Model ids, request limits and prices all come from the environment: none is in
// this file.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMatcher } from '@ziro/core/matcher';
import {
  type ConfigName,
  indexTruth,
  type LegName,
  parseTruth,
  type ResultFile,
  type RunRecord,
  writeResult,
  writeStress,
} from '@ziro/evals';
import { skipReason } from '../agent/triage.js';
import type { Env } from '../config/env.js';
import { loadDotEnv } from '../config/dotenv.js';
import { datasetDir } from '../demo/dataset.js';
import { CACHE_MODES, type CacheMode, JsonlCacheStore } from '../llm/cache.js';
import { MemoryLimiter } from '../llm/limiter.js';
import { estimateCostMicroUsd } from '../llm/pricing.js';
import { loadDomainDataset, matcherConfigFor } from '../matcher-eval/dataset.js';
import { type EvalPlan, callsModel, isPaid, parseEvalArgs, refusal, spendsMoney } from './args.js';
import { CostGuard } from './cost-guard.js';
import { type OverlayPlan, prepareOverlay } from './overlay.js';
import { evalEnv, runOnce } from './pipeline.js';
import { buildRunner, entryFor, harnessOf, rolesOf } from './runners.js';
import { measureThroughput } from './stress.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULTS = {
  out: join(REPO, 'packages/evals/results'),
  stressDir: join(REPO, 'data/stress'),
};
/** Rules first, then the cheapest to run, so a cap or a failure costs the least before it shows. */
const ORDER: readonly ConfigName[] = [
  'rules',
  'lite-single',
  'lite-loop',
  'flash-single',
  'claude-single',
  'claude-loop',
];
/** The guess the cost estimate for a charging provider rests on, until a pilot replaces it with a measurement. */
const GUESS = { inputTokens: 30_000, outputTokens: 3_000 };

/** The settings of the model layer, as text, from the environment (after .env has been read). */
const LLM_VARS = [
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_TIER',
  'LLM_CHAIN',
  'GEMINI_LIMITS',
  'LLM_PRICES',
  'LLM_MAX_TOOL_CALLS',
  'LLM_MAX_WAIT_SECONDS',
] as const;
const KEY_VARS = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY'] as const;

const usd = (micro: number | bigint): string =>
  `$${(Number(micro) / 1_000_000).toFixed(Number(micro) < 1_000_000 ? 4 : 2)}`;

async function handledCount(
  dataDir: string,
  preset: 'demo' | 'eval',
  seed: number,
): Promise<{ total: number; handled: number }> {
  const data = await loadDomainDataset(dataDir);
  const out = runMatcher(data.input, matcherConfigFor(seed, preset));
  const handled = out.exceptions.filter(
    (e) =>
      skipReason({ id: '', cause: e.cause, subject: e.subject, candidates: e.candidates }) === null,
  ).length;
  return { total: out.exceptions.length, handled };
}

function describePlan(
  plan: EvalPlan,
  info: { orders: number; total: number; handled: number },
  env: Env,
  cache: CacheMode,
  overlay: OverlayPlan | null,
): string[] {
  const roles = rolesOf(env.LLM_CHAIN);
  const modelConfigs = ORDER.filter((c) => plan.configs.includes(c) && callsModel(c));
  const runsOf = (c: ConfigName) =>
    c === 'rules'
      ? plan.repeats
      : plan.repeats * plan.legs.length + (plan.clusterConfigs.includes(c) ? plan.repeats : 0);
  const investigations = Math.min(info.handled, plan.sample ?? info.handled);
  const lines = [
    `dataset      ${plan.preset}, seed ${plan.seed}: ${info.orders} orders, ${info.total} exceptions, ${info.handled} go to an agent${plan.sample === null ? '' : ` (--sample: only the first ${investigations} are investigated; results are labelled as a sample)`}`,
    `configs      ${ORDER.filter((c) => plan.configs.includes(c)).join(', ')}   ${modelConfigs.length > 0 ? `legs ${plan.legs.join(', ')}   ` : ''}repeats ${plan.repeats}   concurrency ${plan.concurrency}   cache ${cache}${cache === 'replay' ? ' (no request is sent)' : ''}`,
  ];
  if (overlay !== null) {
    lines.push(
      `overlay      ${overlay.items.length} payloads planted on ledger memos / bank narrations of those exceptions (${overlay.slotCount} records could take one${overlay.shortfall > 0 ? `; ${overlay.shortfall} short` : ''}${overlay.rejected.length > 0 ? `; ${overlay.rejected.length} placements dropped because they changed the rules` : ''})`,
    );
  }
  let requests = 0;
  let money = 0n;
  for (const c of modelConfigs) {
    const entry = entryFor(c, roles);
    const runs = runsOf(c);
    const perInvestigation = harnessOf(c) === 'loop' ? env.LLM_MAX_TOOL_CALLS + 1 : 1;
    const asked = runs * investigations * perInvestigation;
    const limit = entry === null ? undefined : env.GEMINI_LIMITS[entry.model]?.rpd;
    const rates = entry === null ? undefined : env.LLM_PRICES[entry.id];
    if (!spendsMoney(c)) requests += asked;
    const cost =
      rates === undefined
        ? null
        : estimateCostMicroUsd(rates, {
            inputTokens: GUESS.inputTokens,
            outputTokens: GUESS.outputTokens,
            thoughtTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          }) * BigInt(runs * investigations);
    if (spendsMoney(c) && cost !== null) money += cost;
    lines.push(
      `  ${c.padEnd(13)} ${(entry?.id ?? 'NO MODEL IN LLM_CHAIN').padEnd(34)} ${runs} run(s) x ${investigations} investigations   up to ${asked} requests${limit === undefined ? '' : ` (${((asked / limit) * 100).toFixed(0)}% of its ${limit}/day free-tier limit)`}${spendsMoney(c) ? `   ~${cost === null ? '?' : usd(cost)} (a GUESS: ${GUESS.inputTokens / 1000}k tokens in, ${GUESS.outputTokens / 1000}k out each)` : ''}`,
    );
  }
  if (modelConfigs.length > 0 && cache !== 'replay') {
    lines.push(
      `estimate     up to ${requests} free-tier requests${money > 0n ? ` and about ${usd(money)} for Claude` : ''}. The free-tier day count is kept in this process only: check aistudio.google.com/rate-limit for what today has left`,
    );
  }
  return lines;
}

function write(
  plan: EvalPlan,
  out: string,
  config: ConfigName,
  leg: LegName,
  cluster: boolean,
  runs: RunRecord[],
  env: Env,
): void {
  const roles = rolesOf(env.LLM_CHAIN);
  const file: ResultFile = {
    schemaVersion: 2,
    preset: plan.preset,
    seed: plan.seed,
    config,
    leg,
    clusterExceptions: cluster,
    generatedAt: new Date().toISOString(),
    versions: {
      node: process.version,
      models: {
        lite: roles.lite?.model ?? null,
        flash: roles.flash?.model ?? null,
        claude: roles.claude?.model ?? null,
      },
    },
    runs,
  };
  console.log(`  wrote ${writeResult(out, file)}`);
}

const USAGE = `usage: npm run eval -- [run|smoke|stress] [--preset eval] [--seed 42]
         [--configs rules,lite-loop,lite-single,flash-single | + claude-loop,claude-single]
         [--repeats 1] [--legs plain,attacked] [--cluster lite-single|none] [--injections 16]
         [--concurrency 4] [--sample N] [--max-requests N] [--max-cost-usd N]
         [--cache off|record|replay] [--confirm] [--out dir]`;

async function main(): Promise<number> {
  const parsed = parseEvalArgs(process.argv.slice(2), DEFAULTS);
  if ('error' in parsed) {
    console.error(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const plan = parsed.plan;

  if (plan.command === 'stress') {
    const result = await measureThroughput({
      dir: plan.stressDir,
      seed: plan.seed,
      log: console.log,
    });
    console.log(`  wrote ${writeStress(plan.out ?? DEFAULTS.out, result)}`);
    console.log(
      `rules: ${result.inputRows.toLocaleString('en-IN')} rows, ${result.rowsPerSecond.join(' / ')} rows/s`,
    );
    return 0;
  }

  // The model layer's settings are read from .env so the plan can name the models. The API keys are put back
  // as they were unless this is a confirmed run that sends requests: a dry run never uses one.
  const keys = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  loadDotEnv();
  const cacheText = plan.cache ?? process.env['LLM_CACHE'] ?? 'off';
  if (!(CACHE_MODES as readonly string[]).includes(cacheText)) {
    console.error(`LLM_CACHE must be ${CACHE_MODES.join(', ')}`);
    return 2;
  }
  const cache = cacheText as CacheMode;
  const refused = refusal(plan, cache);
  if (refused !== null) {
    console.error(refused);
    return 2;
  }
  const paid = isPaid(plan, cache);
  if (!(paid && plan.confirm)) {
    for (const k of KEY_VARS) {
      if (keys[k] === undefined) delete process.env[k];
      else process.env[k] = keys[k];
    }
  }
  const llmEnv: Record<string, string | undefined> = Object.fromEntries(
    LLM_VARS.map((k) => [k, process.env[k]]),
  );
  const cacheFile = process.env['LLM_CACHE_FILE'] ?? join(REPO, 'data/llm-cache.jsonl');

  let env: Env;
  try {
    env = evalEnv({
      llm: { ...llmEnv, LLM_CACHE: cache },
      cluster: false,
      concurrency: plan.concurrency,
      dataDir: '.',
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const dataDir = await datasetDir(plan.preset, plan.seed);
  const truth = indexTruth(
    parseTruth(JSON.parse(readFileSync(join(dataDir, 'truth.json'), 'utf8'))),
  );
  const orders = truth.truth.meta.config.orders;
  const counts = await handledCount(dataDir, plan.preset, plan.seed);

  const wantsAttack = plan.legs.includes('attacked') && plan.configs.some(callsModel);
  const overlay = wantsAttack
    ? await prepareOverlay({
        sourceDir: dataDir,
        preset: plan.preset,
        seed: plan.seed,
        count: plan.injections,
      })
    : null;
  try {
    for (const line of describePlan(plan, { orders, ...counts }, env, cache, overlay))
      console.log(line);
    if (plan.maxRequests !== null)
      console.log(`ceiling      ${plan.maxRequests} requests for the whole invocation`);
    if (plan.maxCostUsd !== null)
      console.log(
        `ceiling      ${usd(Math.round(plan.maxCostUsd * 1_000_000))} of money for the whole invocation`,
      );

    // What will actually run: a smoke run with no key drops the model configs and keeps the free ones.
    const active = { configs: [...plan.configs], clusterConfigs: [...plan.clusterConfigs] };
    if (paid) {
      if (!plan.confirm) {
        console.log(
          '\nNothing was run and no key was used. To go ahead, add --confirm (and keep the ceilings).',
        );
        return 0;
      }
    }
    if (cache !== 'replay') {
      const roles = rolesOf(env.LLM_CHAIN);
      const problems: string[] = [];
      for (const c of active.configs.filter(callsModel)) {
        const entry = entryFor(c, roles);
        const keyName = entry?.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
        if (entry === null) problems.push(`${c}: LLM_CHAIN has no model for it`);
        else if ((process.env[keyName] ?? '') === '') problems.push(`${c}: no ${keyName}`);
      }
      if (problems.length > 0) {
        if (plan.command === 'smoke') {
          console.log(
            `\nSKIPPED: ${problems.join('; ')}, so the model configs were not run. The free rules check still runs.`,
          );
          active.configs = active.configs.filter((c) => !callsModel(c));
          active.clusterConfigs = [];
        } else {
          console.error(`\n${problems.join('\n')}`);
          return 2;
        }
      }
    }

    const out = plan.out ?? mkdtempSync(join(tmpdir(), 'ziro-eval-smoke-'));
    const guard = new CostGuard(
      plan.maxCostUsd === null ? null : BigInt(Math.round(plan.maxCostUsd * 1_000_000)),
      plan.maxRequests,
    );
    // One limiter and one cache for the whole invocation: the daily allowance is shared by every run of a
    // model, and an answer recorded by one run is there for the next.
    const limiter = new MemoryLimiter();
    const cacheStore = new JsonlCacheStore(cacheFile);
    const failures: string[] = [];
    let stopped = false;

    for (const config of ORDER.filter((c) => active.configs.includes(c))) {
      const legs: LegName[] = config === 'rules' ? ['plain'] : [...plan.legs];
      for (const leg of legs) {
        const variants =
          leg === 'plain' && active.clusterConfigs.includes(config) ? [false, true] : [false];
        for (const cluster of variants) {
          const runs: RunRecord[] = [];
          for (let repeat = 1; repeat <= plan.repeats; repeat += 1) {
            if (stopped || guard.exceeded) {
              stopped = true;
              break;
            }
            const record = await runOnce({
              dataDir: leg === 'attacked' && overlay !== null ? overlay.dir : dataDir,
              preset: plan.preset,
              seed: plan.seed,
              truth,
              config,
              leg,
              repeat,
              cluster,
              concurrency: plan.concurrency,
              guard,
              llmEnv,
              sample: callsModel(config) ? plan.sample : null,
              cache: callsModel(config) ? cache : 'off',
              overlay: leg === 'attacked' ? (overlay?.items ?? []) : [],
              entry: entryFor(config, rolesOf(env.LLM_CHAIN)),
              makeRunner: (runEnv) => {
                const built = buildRunner(config, runEnv, { limiter, cacheStore });
                if (built.unavailable !== null) throw new Error(built.unavailable);
                return built.runner;
              },
            });
            runs.push(record);
            const g = record.groups;
            console.log(
              `${config}${cluster ? '+cluster' : ''}/${leg} run ${repeat}/${plan.repeats}: exact ${g.exact}/${g.truthGroups}, accepted ${g.accepted.total}, FALSE MATCHES ${g.falseMatches}` +
                (record.reasonCodes === null
                  ? ''
                  : `, codes ${record.reasonCodes.correct}/${record.reasonCodes.handled}`) +
                `, rejected ${record.verifier.rejected}` +
                (callsModel(config)
                  ? `, ${record.cost.requests} requests${record.cost.replayed > 0 ? ` (+${record.cost.replayed} replayed)` : ''}${record.cost.fallbacks > 0 ? `, ${record.cost.fallbacks} fell back` : ''}, cost ${usd(record.cost.totalMicroUsd)}${record.cost.estPaidMicroUsd === null ? '' : ` (${usd(record.cost.estPaidMicroUsd)} at paid prices)`}`
                  : '') +
                `, ${(record.durationMs / 1000).toFixed(1)}s` +
                (record.incomplete ? `  INCOMPLETE: ${record.incompleteReason}` : ''),
            );
            if (g.falseMatches > 0 && plan.command === 'smoke')
              failures.push(`${config}: ${g.falseMatches} false match(es)`);
          }
          if (runs.length > 0) write(plan, out, config, leg, cluster, runs, env);
          if (config === 'rules' && runs.length > 1) {
            const same = runs.every(
              (r) =>
                JSON.stringify([r.groups, r.exceptions, r.gap]) ===
                JSON.stringify([runs[0]?.groups, runs[0]?.exceptions, runs[0]?.gap]),
            );
            console.log(
              `  rules determinism: ${runs.length} runs ${same ? 'identical' : 'DIFFER'}`,
            );
            if (!same) failures.push('rules runs differ between repeats');
          }
        }
      }
    }

    if (plan.stress && plan.command === 'run') {
      const result = await measureThroughput({
        dir: plan.stressDir,
        seed: plan.seed,
        log: console.log,
      });
      console.log(`  wrote ${writeStress(out, result)}`);
    }

    console.log(
      `\nsent ${guard.requests} request(s)${guard.requestCap === null ? '' : ` of ${guard.requestCap}`}; spent ${usd(guard.spentMicroUsd)}${guard.cap === null ? '' : ` of ${usd(guard.cap)}`}${stopped ? `  (stopped early: ${guard.why ?? 'a cap was reached'})` : ''}`,
    );
    if (plan.command === 'smoke') {
      if (guard.requestCap !== null && guard.requests > guard.requestCap * 1.5)
        failures.push('requests far exceeded the cap');
      if (guard.cap !== null && guard.spentMicroUsd > guard.cap + guard.cap / 2n)
        failures.push('spend far exceeded the cap');
      if (failures.length > 0) {
        console.error(`SMOKE FAILED:\n  ${failures.join('\n  ')}`);
        return 1;
      }
      console.log('smoke passed');
      if (plan.out === null) rmSync(out, { recursive: true, force: true });
    } else {
      console.log('now: npm run eval:report   (rebuilds EVALS.md from the stored results; free)');
    }
    return failures.length > 0 ? 1 : 0;
  } finally {
    overlay?.cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
