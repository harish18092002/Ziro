// npm run eval -- --seed 42 --preset eval --configs rules,small,large,harnessB --repeats 3 --max-cost-usd 30 --confirm
// npm run eval:smoke            (demo preset, one repeat, hard cap, skipped without an API key)
// npm run eval -- stress        (rules throughput only; free)
//
// Anything that calls a model does NOTHING until --confirm, and needs --max-cost-usd: without them it prints
// what it would do and what that is expected to cost, and exits. The API key is not even read until then.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { costMicroUsd, ratesFor } from '../agent/pricing.js';
import { skipReason } from '../agent/triage.js';
import { loadDotEnv } from '../config/dotenv.js';
import { datasetDir } from '../demo/dataset.js';
import { loadDomainDataset, matcherConfigFor } from '../matcher-eval/dataset.js';
import { type EvalPlan, isPaid, parseEvalArgs, refusal, spendsMoney } from './args.js';
import { CostGuard } from './cost-guard.js';
import { type OverlayPlan, prepareOverlay } from './overlay.js';
import { runOnce } from './pipeline.js';
import { buildRunner, modelFor } from './runners.js';
import { measureThroughput } from './stress.js';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const DEFAULTS = {
  out: join(REPO, 'packages/evals/results'),
  stressDir: join(REPO, 'data/stress'),
};
/** Cheapest first, so a cost cap or a failure costs the least before it shows. */
const ORDER: readonly ConfigName[] = ['rules', 'small', 'harnessB', 'large'];
/** The guess the cost estimate rests on, until a pilot replaces it with a measurement. */
const GUESS = { inputTokens: 30_000, outputTokens: 3_000 };

const usd = (micro: number | bigint): string =>
  `$${(Number(micro) / 1_000_000).toFixed(Number(micro) < 1_000_000 ? 4 : 2)}`;

function sdkVersion(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    let dir = dirname(entry);
    for (let i = 0; i < 4; i += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@anthropic-ai/claude-agent-sdk') return pkg.version ?? null;
      } catch {
        // keep climbing
      }
      dir = dirname(dir);
    }
  } catch {
    // not installed
  }
  return null;
}

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
  models: { small: string; large: string },
  overlay: OverlayPlan | null,
): string[] {
  const paidConfigs = ORDER.filter((c) => plan.configs.includes(c) && spendsMoney(c));
  const runsOf = (c: ConfigName) =>
    c === 'rules'
      ? plan.repeats
      : plan.repeats * plan.legs.length + (plan.clusterConfigs.includes(c) ? plan.repeats : 0);
  const lines = [
    `dataset      ${plan.preset}, seed ${plan.seed}: ${info.orders} orders, ${info.total} exceptions, ${info.handled} go to an agent`,
    `configs      ${ORDER.filter((c) => plan.configs.includes(c)).join(', ')}   ${paidConfigs.length > 0 ? `legs ${plan.legs.join(', ')}   ` : ''}repeats ${plan.repeats}   concurrency ${plan.concurrency}`,
  ];
  if (overlay !== null) {
    lines.push(
      `overlay      ${overlay.items.length} payloads planted on ledger memos / bank narrations of those exceptions (${overlay.slotCount} records could take one${overlay.shortfall > 0 ? `; ${overlay.shortfall} short` : ''}${overlay.rejected.length > 0 ? `; ${overlay.rejected.length} placements dropped because they changed the rules` : ''})`,
    );
  }
  let total = 0n;
  for (const c of paidConfigs) {
    const model = modelFor(c, models) ?? '';
    const per =
      ratesFor(model) === undefined
        ? null
        : costMicroUsd(model, {
            inputTokens: GUESS.inputTokens,
            outputTokens: GUESS.outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
    const runCost = per === null ? null : per * BigInt(info.handled);
    if (runCost !== null) total += runCost * BigInt(runsOf(c));
    lines.push(
      `  ${c.padEnd(9)} ${model.padEnd(20)} ${runsOf(c)} run(s) x ${info.handled} investigations   ~${runCost === null ? '?' : usd(runCost)} per run (a GUESS: ${GUESS.inputTokens / 1000}k tokens in, ${GUESS.outputTokens / 1000}k out each, no caching)`,
    );
  }
  if (paidConfigs.length > 0)
    lines.push(
      `estimate     about ${usd(total)} in all, if the guess is right; a pilot replaces the guess with a measurement`,
    );
  return lines;
}

function write(
  plan: EvalPlan,
  out: string,
  config: ConfigName,
  leg: LegName,
  cluster: boolean,
  runs: RunRecord[],
  models: { small: string; large: string },
): void {
  const file: ResultFile = {
    schemaVersion: 1,
    preset: plan.preset,
    seed: plan.seed,
    config,
    leg,
    clusterExceptions: cluster,
    generatedAt: new Date().toISOString(),
    versions: {
      node: process.version,
      agentSdk: config === 'harnessB' ? sdkVersion() : null,
      models,
    },
    runs,
  };
  console.log(`  wrote ${writeResult(out, file)}`);
}

async function main(): Promise<number> {
  const parsed = parseEvalArgs(process.argv.slice(2), DEFAULTS);
  if ('error' in parsed) {
    console.error(
      `${parsed.error}\n\nusage: npm run eval -- [run|smoke|stress] [--preset eval] [--seed 42] [--configs rules,small,large,harnessB] [--repeats 3]\n         [--legs plain,attacked] [--cluster small|none] [--injections 16] [--concurrency 4] [--max-cost-usd N] [--confirm] [--out dir]`,
    );
    return 2;
  }
  const plan = parsed.plan;
  const refused = refusal(plan);
  if (refused !== null) {
    console.error(refused);
    return 2;
  }

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

  const dataDir = await datasetDir(plan.preset, plan.seed);
  const truth = indexTruth(
    parseTruth(JSON.parse(readFileSync(join(dataDir, 'truth.json'), 'utf8'))),
  );
  const orders = truth.truth.meta.config.orders;
  const counts = await handledCount(dataDir, plan.preset, plan.seed);

  // The key is read only for a confirmed run that spends money.
  const paid = isPaid(plan);
  if (paid && plan.confirm) loadDotEnv();
  const models = {
    small: process.env['AGENT_MODEL_SMALL'] ?? 'claude-haiku-5-5',
    large: process.env['AGENT_MODEL_LARGE'] ?? 'claude-sonnet-5-5',
  };
  const unpriced = paid
    ? [models.small, models.large].filter((m) => ratesFor(m) === undefined)
    : [];
  if (unpriced.length > 0) {
    console.error(`no known price for ${unpriced.join(', ')}; add it to agent/pricing.ts first`);
    return 2;
  }

  const wantsAttack = plan.legs.includes('attacked') && plan.configs.some(spendsMoney);
  const overlay = wantsAttack
    ? await prepareOverlay({
        sourceDir: dataDir,
        preset: plan.preset,
        seed: plan.seed,
        count: plan.injections,
      })
    : null;
  try {
    for (const line of describePlan(plan, { orders, ...counts }, models, overlay))
      console.log(line);
    if (plan.maxCostUsd !== null)
      console.log(
        `ceiling      ${usd(Math.round(plan.maxCostUsd * 1_000_000))} for the whole invocation`,
      );

    // What will actually run: a smoke run with no key drops the model configs and keeps the free ones.
    const active = { configs: [...plan.configs], clusterConfigs: [...plan.clusterConfigs] };
    let apiKey = '';
    if (paid) {
      if (!plan.confirm) {
        console.log(
          '\nNothing was run and no key was read. To go ahead, add --confirm (and keep --max-cost-usd).',
        );
        return 0;
      }
      apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
      if (apiKey === '') {
        if (plan.command === 'smoke') {
          console.log(
            '\nSKIPPED: no ANTHROPIC_API_KEY, so the model configs were not run. The free rules check still runs.',
          );
          active.configs = active.configs.filter((c) => !spendsMoney(c));
          active.clusterConfigs = [];
        } else {
          console.error('\nno ANTHROPIC_API_KEY in the environment or .env');
          return 2;
        }
      }
    }

    const out = plan.out ?? mkdtempSync(join(tmpdir(), 'ziro-eval-smoke-'));
    const guard = new CostGuard(
      plan.maxCostUsd === null ? null : BigInt(Math.round(plan.maxCostUsd * 1_000_000)),
    );
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
            const created: (() => void)[] = [];
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
              models,
              overlay: leg === 'attacked' ? (overlay?.items ?? []) : [],
              model: modelFor(config, models),
              makeRunner: (telemetry) => {
                const built = buildRunner(config, { apiKey, ...models }, telemetry);
                created.push(built.close);
                return built.runner;
              },
            }).finally(() => created.forEach((close) => close()));
            runs.push(record);
            const g = record.groups;
            console.log(
              `${config}${cluster ? '+cluster' : ''}/${leg} run ${repeat}/${plan.repeats}: exact ${g.exact}/${g.truthGroups}, accepted ${g.accepted.total}, FALSE MATCHES ${g.falseMatches}` +
                (record.reasonCodes === null
                  ? ''
                  : `, codes ${record.reasonCodes.correct}/${record.reasonCodes.handled}`) +
                `, rejected ${record.verifier.rejected}, cost ${usd(record.cost.totalMicroUsd)} (spent ${usd(guard.spentMicroUsd)}), ${(record.durationMs / 1000).toFixed(1)}s` +
                (record.incomplete ? `  INCOMPLETE: ${record.incompleteReason}` : ''),
            );
            if (g.falseMatches > 0 && plan.command === 'smoke')
              failures.push(`${config}: ${g.falseMatches} false match(es)`);
          }
          if (runs.length > 0) write(plan, out, config, leg, cluster, runs, models);
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
      `\nspent ${usd(guard.spentMicroUsd)}${guard.cap === null ? '' : ` of ${usd(guard.cap)}`}${stopped ? '  (stopped early: the cap was reached)' : ''}`,
    );
    if (plan.command === 'smoke') {
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
