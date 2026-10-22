// Times the rule matcher on a datagen dataset (the stress preset by default: about 100,000 ledger
// rows and 100,000 bank lines). Loading the files is reported separately and is NOT in the rate:
// the figure is the matcher alone, over every input row it was given.
//
//   npm run datagen -- --seed 42 --preset stress --out data/stress
//   npm run bench:matcher [-- --dir data/stress --seed 42 --preset stress --runs 5]
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runMatcher } from '@ziro/core/matcher';
import { PRESETS, type PresetName } from '@ziro/datagen';
import { loadDomainDataset, matcherConfigFor } from '../matcher-eval/dataset.js';
import { resolveDataDir } from '../razorpay/data-dir.js';

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: 'data/stress' },
    preset: { type: 'string', default: 'stress' },
    seed: { type: 'string', default: '42' },
    runs: { type: 'string', default: '5' },
  },
});

const preset = values.preset as PresetName;
const seed = Number(values.seed);
const runs = Number(values.runs);
if (!Object.keys(PRESETS).includes(preset) || !Number.isInteger(seed) || !(runs >= 1)) {
  console.error('usage: bench:matcher [-- --dir data/stress --preset stress --seed 42 --runs 5]');
  process.exit(2);
}

const dir = resolveDataDir(values.dir ?? 'data/stress');
if (!existsSync(dir)) {
  console.error(`no dataset at ${dir}. Generate it first (about 15 seconds):`);
  console.error(
    `  npm run datagen -- --seed ${seed} --preset ${preset} --out ${values.dir ?? 'data/stress'}`,
  );
  process.exit(2);
}

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MiB`;
const ms = (value: number): string => `${value.toFixed(0)} ms`;
const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

const loadStart = performance.now();
const data = await loadDomainDataset(dir);
const loadMs = performance.now() - loadStart;
const config = matcherConfigFor(seed, preset);
const i = data.input;
const rows =
  i.ledger.length +
  i.payments.length +
  i.refunds.length +
  i.settlements.length +
  i.settlementItems.length +
  i.bankLines.length;

runMatcher(i, config); // warm-up: lets the engine compile the hot paths; not timed
const times: number[] = [];
let out = runMatcher(i, config);
for (let n = 0; n < runs; n++) {
  const start = performance.now();
  out = runMatcher(i, config);
  times.push(performance.now() - start);
}
const best = median(times);

console.log(`dataset      ${dir}  (${preset}, seed ${seed})`);
console.log(`input rows   ${rows.toLocaleString('en-IN')}`);
console.log(
  `             ledger ${i.ledger.length.toLocaleString('en-IN')}, payments ${i.payments.length.toLocaleString('en-IN')}, refunds ${i.refunds.length.toLocaleString('en-IN')}, ` +
    `settlements ${i.settlements.length.toLocaleString('en-IN')}, recon lines ${i.settlementItems.length.toLocaleString('en-IN')}, bank lines ${i.bankLines.length.toLocaleString('en-IN')}`,
);
console.log(`load         ${ms(loadMs)}  (parsing and mapping, not counted below)`);
console.log(
  `match        median ${ms(best)}  min ${ms(Math.min(...times))}  max ${ms(Math.max(...times))}  over ${runs} runs`,
);
console.log(`rate         ${Math.round(rows / (best / 1000)).toLocaleString('en-IN')} rows/sec`);
console.log(
  `result       ${out.groups.length.toLocaleString('en-IN')} groups, ${out.exceptions.length.toLocaleString('en-IN')} exceptions, ${out.ignored.length.toLocaleString('en-IN')} ignored`,
);
const causes = new Map<string, number>();
for (const e of out.exceptions) {
  const key = `${e.cause} (${e.reasonCode})`;
  causes.set(key, (causes.get(key) ?? 0) + 1);
}
for (const [cause, n] of [...causes].sort((a, b) => b[1] - a[1])) {
  console.log(`  exception    ${n.toLocaleString('en-IN').padStart(7)}  ${cause}`);
}
console.log(
  `memory       rss ${mib(process.memoryUsage().rss)}, heap ${mib(process.memoryUsage().heapUsed)}`,
);
