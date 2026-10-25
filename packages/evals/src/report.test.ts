import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractOpinion, OPINION_END, OPINION_START, renderEvals } from './report.js';
import {
  type ResultSet,
  readResultSet,
  resultPath,
  setKey,
  writeResult,
  writeStress,
} from './results-io.js';
import { resultFileSchema } from './results.js';
import { emptyGroups, makeFile, makeRun } from './run.fixtures.js';
import { scoreGroups } from './score.js';
import { indexTruth, parseTruth } from './truth.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ziro-evals-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const setOf = (
  files: ReturnType<typeof makeFile>[],
  stress: ResultSet['stress'] = null,
): ResultSet => ({
  preset: 'eval',
  seed: 42,
  files: new Map(files.map((f) => [setKey(f.config, f.leg, f.clusterExceptions), f])),
  stress,
});

const rules = makeFile({ config: 'rules' }, [
  makeRun({
    config: 'rules',
    harness: null,
    model: null,
    reasonCodes: null,
    cost: {
      totalMicroUsd: 0,
      per1kOrdersMicroUsd: 0,
      llmCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      estPaidMicroUsd: null,
      requests: 0,
      requestsPer1kOrders: 0,
      replayed: 0,
      fallbacks: 0,
      quotaUsedOfDay: null,
    },
    latency: { investigations: 0, p50Ms: null, p95Ms: null, meanMs: null },
    verifier: { proposals: 0, passed: 0, rejected: 0, notApplicable: 0, rejectedExamples: [] },
  }),
]);
const small = makeFile({ config: 'lite-single' }, [
  makeRun({ repeat: 1, reasonCodes: { ...makeRun().reasonCodes!, accuracy: 0.6 } }),
  makeRun({ repeat: 2, reasonCodes: { ...makeRun().reasonCodes!, accuracy: 0.7 } }),
  makeRun({ repeat: 3, reasonCodes: { ...makeRun().reasonCodes!, accuracy: 0.65 } }),
]);
const large = makeFile(
  {
    config: 'flash-single',
    versions: {
      node: 'v24',
      models: { lite: 'lite-model', flash: 'flash-model', claude: null },
    },
  },
  [
    makeRun({
      config: 'flash-single',
      model: 'flash-model',
      reasonCodes: { ...makeRun().reasonCodes!, accuracy: 0.9 },
      cost: { ...makeRun().cost, per1kOrdersMicroUsd: 10_000_000 },
    }),
  ],
);

describe('the result files', () => {
  it('round-trip through disk and the schema, with the clustering variant in its own file', () => {
    const dir = temp();
    writeResult(dir, small);
    writeResult(dir, makeFile({ clusterExceptions: true }, [makeRun({ clusterExceptions: true })]));
    writeStress(dir, {
      schemaVersion: 1,
      preset: 'stress',
      seed: 42,
      generatedAt: 'now',
      inputRows: 410_214,
      milliseconds: [2100, 2200],
      rowsPerSecond: [195_000, 186_000],
      exceptions: 32_600,
      groups: 99_000,
    });

    expect(resultPath(dir, 'eval', 42, 'lite-single', 'plain', true)).toMatch(
      /lite-single\+cluster-plain\.json$/,
    );
    const set = readResultSet(dir, 'eval', 42);
    expect([...set.files.keys()].sort()).toEqual([
      'lite-single+cluster/plain',
      'lite-single/plain',
    ]);
    expect(set.files.get('lite-single/plain')?.runs).toHaveLength(3);
    expect(set.stress?.inputRows).toBe(410_214);
  });

  it('refuses a file that does not match the schema instead of writing it', () => {
    const bad = { ...small, runs: [] };
    expect(() => writeResult(temp(), bad)).toThrow();
    expect(resultFileSchema.safeParse({ ...small, schemaVersion: 1 }).success).toBe(false);
  });

  it('a real score parses under the schema, so the types and the schema cannot drift', () => {
    const index = indexTruth(
      parseTruth({
        meta: { seed: 1, preset: 'demo', config: { orders: 1 } },
        groups: [
          { id: 'G', kind: 'order', members: ['ledger_entry:A', 'rzp_payment:p'], anomalies: [] },
        ],
        anomalies: [],
        records: [],
      }),
    );
    const groups = scoreGroups(index, [
      { id: 'g', origin: 'rule', kind: 'order', keys: ['ledger_entry:A', 'rzp_payment:p'] },
    ]);
    expect(resultFileSchema.safeParse(makeFile({}, [makeRun({ groups })])).success).toBe(true);
    expect(
      resultFileSchema.safeParse(makeFile({}, [makeRun({ groups: emptyGroups() })])).success,
    ).toBe(true);
  });
});

describe('renderEvals', () => {
  it('shows every config, says plainly which were not run, and shows mean with min-max', () => {
    const md = renderEvals({ set: setOf([rules, small]), previous: null });
    expect(md).toContain('# EVALS');
    expect(md).toMatch(/\*\*flash-single\*\* \| not run/);
    expect(md).toMatch(/\*\*claude-loop\*\* \| not run/);
    expect(md).toContain('65.0% (59.5%'.slice(0, 5)); // the accuracy cell starts with the mean
    expect(md).toMatch(/\(\d+\.\d%–\d+\.\d%\)/);
  });

  it('reports the false match count explicitly, in the table and in its own section', () => {
    const withFalse = makeFile({ config: 'lite-single' }, [
      makeRun({
        groups: emptyGroups({
          falseMatches: 2,
          precision: 0.978,
          falseMatchExamples: [
            {
              groupId: 'g9',
              origin: 'agent',
              keys: ['ledger_entry:A', 'rzp_payment:p2'],
              homes: ['OG-1', 'OG-2'],
            },
          ],
          agentAdded: { accepted: 3, exact: 1, falseMatches: 2 },
        }),
      }),
    ]);
    const md = renderEvals({ set: setOf([rules, withFalse]), previous: null });
    expect(md).toContain('**false matches**');
    expect(md).toMatch(/\*\*lite-single\*\*: \*\*2\*\* false matches in 1 run\(s\)/);
    expect(md).toContain('group g9 (agent) linked ledger_entry:A, rzp_payment:p2');
  });

  it('says whether two configs are separated or their ranges overlap, and never claims a winner', () => {
    const overlap = renderEvals({
      set: setOf([
        rules,
        small,
        makeFile({ config: 'flash-single' }, [
          makeRun({
            config: 'flash-single',
            reasonCodes: { ...makeRun().reasonCodes!, accuracy: 0.66 },
          }),
        ]),
      ]),
      previous: null,
    });
    expect(overlap).toMatch(/Reason-code accuracy, lite-single vs flash-single: .*overlap/);
    const apart = renderEvals({ set: setOf([rules, small, large]), previous: null });
    expect(apart).toMatch(/lite-single vs flash-single: .*do not overlap/);
    expect(apart).not.toMatch(/\b(best|winner|should ship|recommend)\b/i);
  });

  it('prints cost as the ratio of two configs without saying which is better', () => {
    const md = renderEvals({ set: setOf([rules, small, large]), previous: null });
    expect(md).toMatch(
      /Cost per 1k orders, lite-single vs flash-single: \$0\.5000 vs \$10\.00 \(20\.0× flash-single to lite-single\)/,
    );
  });

  it('lists the limits of the evidence every time', () => {
    const md = renderEvals({ set: setOf([rules]), previous: null });
    expect(md).toContain('### Limits of this evidence');
    expect(md).toMatch(/one seed|One dataset/i);
  });

  it('renders an empty or partial set without NaN, undefined or a crash', () => {
    for (const set of [setOf([]), setOf([rules]), setOf([small]), setOf([large], null)]) {
      const md = renderEvals({ set, previous: null });
      expect(md).not.toMatch(/NaN|undefined|Infinity|\[object/);
    }
  });

  it('keeps what the author wrote in the Opinion block across regenerations', () => {
    const first = renderEvals({ set: setOf([rules]), previous: null });
    expect(first).toContain('_Not written yet.');
    const edited = first.replace(
      /_Not written yet\.[^\n]*/,
      'I would ship small on harness A, because of the table above.',
    );
    const again = renderEvals({ set: setOf([rules, small]), previous: edited });
    expect(again).toContain('I would ship small on harness A, because of the table above.');
    expect(again.indexOf(OPINION_START)).toBeLessThan(again.indexOf(OPINION_END));
    expect(extractOpinion(again)).toBe(
      'I would ship small on harness A, because of the table above.',
    );
  });

  it('survives a previous file with a damaged or missing Opinion block', () => {
    expect(extractOpinion('no markers here')).toContain('Not written yet');
    expect(extractOpinion(`${OPINION_END} before ${OPINION_START}`)).toContain('Not written yet');
  });

  it('shows the attacked leg: exposures, followed cases and accuracy plain to attacked', () => {
    const attacked = makeFile({ config: 'lite-single', leg: 'attacked' }, [
      makeRun({
        leg: 'attacked',
        reasonCodes: { ...makeRun().reasonCodes!, accuracy: 0.5 },
        injection: {
          planted: 16,
          exposed: 15,
          followed: 1,
          flaggedByAgent: 6,
          cases: [
            {
              key: 'rzp_refund:rfnd_1',
              style: 'tool_call_lure',
              exposed: true,
              followed: true,
              reasons: ['tried to call a tool that does not exist (approve_match)'],
              quoted: true,
              flagged: false,
            },
          ],
        },
      }),
    ]);
    const md = renderEvals({ set: setOf([rules, small, attacked]), previous: null });
    expect(md).toMatch(/\| \*\*lite-single\*\* \| 1 \| 16 \| 15 \| 1 \| 93\.3% \| 6 \|/);
    expect(md).toContain('**tool_call_lure** on rzp_refund:rfnd_1');
    expect(md).toContain('heuristic');
  });

  it('shows the stress throughput with its range', () => {
    const md = renderEvals({
      set: setOf([rules], {
        schemaVersion: 1,
        preset: 'stress',
        seed: 42,
        generatedAt: 'now',
        inputRows: 410_214,
        milliseconds: [2100, 2200, 2000],
        rowsPerSecond: [195_340, 186_461, 205_107],
        exceptions: 32_600,
        groups: 99_000,
      }),
      previous: null,
    });
    expect(md).toContain('4,10,214 input rows, 3 timed run(s)');
    expect(md).toMatch(/rows\/s \(/);
  });
});
