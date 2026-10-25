import { describe, expect, it } from 'vitest';
import { README_END, README_START, renderReadmeResults, replaceReadmeBlock } from './report.js';
import { type ResultSet, setKey } from './results-io.js';
import { makeFile, makeRun } from './run.fixtures.js';

const setOf = (files: ReturnType<typeof makeFile>[]): ResultSet => ({
  preset: 'eval',
  seed: 42,
  files: new Map(files.map((f) => [setKey(f.config, f.leg, f.clusterExceptions), f])),
  stress: null,
});

const noCost = {
  totalMicroUsd: 0,
  per1kOrdersMicroUsd: 0,
  llmCalls: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  sdkReportedMicroUsd: null,
};
const rules = makeFile({ config: 'rules' }, [
  makeRun({
    config: 'rules',
    harness: null,
    model: null,
    reasonCodes: null,
    durationMs: 2_309,
    cost: noCost,
    latency: { investigations: 0, p50Ms: null, p95Ms: null, meanMs: null },
    verifier: { proposals: 0, passed: 0, rejected: 0, notApplicable: 0, rejectedExamples: [] },
    gap: { strictPaise: '20419089', optimisticPaise: '20419089' },
  }),
]);

describe('renderReadmeResults', () => {
  it('shows the rules column with its numbers and says plainly that the model columns have not run', () => {
    const md = renderReadmeResults(setOf([rules]));
    expect(md).toContain('Rules only');
    expect(md).toContain('Rules + small model');
    expect(md).toContain('₹2,04,190.89');
    expect(md).toContain('2.3 s for all 500 orders');
    expect(md).toContain('| $0');
    expect(md).toContain('no agent');
    expect(md.match(/not run yet/g)?.length).toBe(12); // six rows x two model columns
  });

  it('shows a model column as mean and range over its repeats, with the verifier count and the cost', () => {
    const small = makeFile({ config: 'small' }, [
      makeRun({ repeat: 1, groups: { ...makeRun().groups, matchRate: 0.97, falseMatches: 0 } }),
      makeRun({ repeat: 2, groups: { ...makeRun().groups, matchRate: 0.99, falseMatches: 0 } }),
    ]);
    const md = renderReadmeResults(setOf([rules, small]));
    expect(md).toMatch(/98\.0% \(97\.0%–99\.0%\)/);
    expect(md).toMatch(/\d+ of \d+/); // verifier: refused of proposals
    expect(md).toMatch(/\$\d+\.\d+/); // cost per 1k orders
    expect(md).toContain('per investigation (p50 / p95)');
    expect(md.match(/not run yet/g)?.length).toBe(6); // only the large column is left
  });

  it('is laid out as Prettier lays out a table, so the README stays prettier-clean', () => {
    const lines = renderReadmeResults(setOf([rules])).split('\n');
    const table = lines.filter((l) => l.startsWith('|'));
    const widths = table.map((l) => [...l].length);
    expect(new Set(widths).size).toBe(1); // every row is the same width
    expect(table[1]).toMatch(/^\| -{3,} \| -{3,} \| -{3,} \| -{3,} \|$/);
  });

  it('renders an empty set without NaN or undefined', () => {
    const md = renderReadmeResults(setOf([]));
    expect(md).not.toMatch(/NaN|undefined/);
    expect(md.match(/not run yet/g)?.length).toBe(18);
  });

  it('points at EVALS.md and the command that rebuilds it', () => {
    const md = renderReadmeResults(setOf([rules]));
    expect(md).toContain('[EVALS.md](EVALS.md)');
    expect(md).toContain('npm run eval:report');
  });
});

describe('replaceReadmeBlock', () => {
  const readme = `# Title\n\nintro\n\n${README_START}\nold table\n${README_END}\n\nafter\n`;

  it('replaces what is between the markers and nothing else', () => {
    const { text, found } = replaceReadmeBlock(readme, 'NEW');
    expect(found).toBe(true);
    expect(text).toBe(`# Title\n\nintro\n\n${README_START}\nNEW\n${README_END}\n\nafter\n`);
  });

  it('is idempotent: running it twice with the same content changes nothing more', () => {
    const once = replaceReadmeBlock(readme, 'NEW').text;
    expect(replaceReadmeBlock(once, 'NEW').text).toBe(once);
  });

  it.each([
    ['no markers', '# Title\n'],
    ['only a start marker', `x ${README_START} y`],
    ['markers in the wrong order', `${README_END} a ${README_START}`],
  ])('leaves a README with %s exactly as it was, and says so', (_name, text) => {
    expect(replaceReadmeBlock(text, 'NEW')).toEqual({ text, found: false });
  });
});
