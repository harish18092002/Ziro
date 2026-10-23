// Rules throughput on the stress preset: pure CPU, no database, no model, so it costs nothing and can
// be run any time. The same measurement as `npm run bench:matcher`, written down as a result file.
import { existsSync } from 'node:fs';
import { runMatcher } from '@ziro/core/matcher';
import { generate, resolveConfig, writeDataset } from '@ziro/datagen';
import type { StressFile } from '@ziro/evals';
import { loadDomainDataset, matcherConfigFor } from '../matcher-eval/dataset.js';

export const STRESS_RUNS = 3;

export async function measureThroughput(options: {
  dir: string;
  seed: number;
  log?: (line: string) => void;
}): Promise<StressFile> {
  const log = options.log ?? (() => undefined);
  if (!existsSync(`${options.dir}/truth.json`)) {
    log(`generating the stress dataset in ${options.dir} (about 15 seconds; it is git-ignored)`);
    writeDataset(options.dir, generate(resolveConfig(options.seed, 'stress')));
  }
  const data = await loadDomainDataset(options.dir);
  const config = matcherConfigFor(options.seed, 'stress');
  const i = data.input;
  const rows =
    i.ledger.length +
    i.payments.length +
    i.refunds.length +
    i.settlements.length +
    i.settlementItems.length +
    i.bankLines.length;

  runMatcher(i, config); // warm-up, not timed
  const milliseconds: number[] = [];
  let out = runMatcher(i, config);
  for (let n = 0; n < STRESS_RUNS; n += 1) {
    const start = performance.now();
    out = runMatcher(i, config);
    milliseconds.push(performance.now() - start);
  }
  return {
    schemaVersion: 1,
    preset: 'stress',
    seed: options.seed,
    generatedAt: new Date().toISOString(),
    inputRows: rows,
    milliseconds: milliseconds.map((m) => Math.round(m)),
    rowsPerSecond: milliseconds.map((m) => Math.round(rows / (m / 1000))),
    exceptions: out.exceptions.length,
    groups: out.groups.length,
  };
}
