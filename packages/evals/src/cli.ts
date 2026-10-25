// Rebuilds EVALS.md from the stored results. Free: it reads JSON and calls nothing. The paid part (running
// the model configs) is `npm run eval` in apps/api, which writes the JSON this reads.
//
//   npm run eval:report [-- --preset eval --seed 42 --results <dir> --out <file> --readme <file>]
//
// It also rewrites the results table in README.md (between its RESULTS markers) from the same files.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readResultSet } from './results-io.js';
import { renderEvals, renderReadmeResults, replaceReadmeBlock } from './report.js';

const { values } = parseArgs({
  options: {
    preset: { type: 'string', default: 'eval' },
    seed: { type: 'string', default: '42' },
    results: { type: 'string', default: fileURLToPath(new URL('../results', import.meta.url)) },
    out: { type: 'string', default: fileURLToPath(new URL('../../../EVALS.md', import.meta.url)) },
    readme: {
      type: 'string',
      default: fileURLToPath(new URL('../../../README.md', import.meta.url)),
    },
    stressSeed: { type: 'string', default: '42' },
  },
});

const seed = Number(values.seed);
const stressSeed = Number(values.stressSeed);
if (!Number.isInteger(seed) || !Number.isInteger(stressSeed)) {
  console.error('usage: eval:report [-- --preset eval --seed 42 --results <dir> --out <file>]');
  process.exit(2);
}

const out = values.out;
const set = readResultSet(values.results, values.preset, seed, stressSeed);
if (set.files.size === 0 && set.stress === null) {
  console.error(`no results for ${values.preset}-${seed} in ${values.results}. Run: npm run eval`);
  process.exit(1);
}
const previous = existsSync(out) ? readFileSync(out, 'utf8') : null;
writeFileSync(out, renderEvals({ set, previous }));
console.log(
  `wrote ${out} from ${set.files.size} result file(s)${set.stress ? ' and the stress throughput' : ''}`,
);

if (existsSync(values.readme)) {
  const readme = readFileSync(values.readme, 'utf8');
  const { text, found } = replaceReadmeBlock(readme, renderReadmeResults(set));
  if (found) {
    if (text !== readme) writeFileSync(values.readme, text);
    console.log(`updated the results table in ${values.readme}`);
  } else {
    console.log(`${values.readme} has no RESULTS markers; left alone`);
  }
}
