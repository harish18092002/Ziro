import { generate, renderToStrings, resolveConfig } from '@ziro/datagen';
import { describe, expect, it } from 'vitest';
import { type AcceptedGroup, classifyKeys, scoreGroups, scoreReasonCodes } from './score.js';
import { expectedCodes, indexTruth, parseTruth, type Truth } from './truth.js';

// A small truth with every shape that matters: a whole order group, a payout, a group with a record
// the rules cannot link, a record that belongs to no group, and anomalies on a record and on a group.
const truth = (): Truth =>
  parseTruth({
    meta: { seed: 1, preset: 'demo', config: { orders: 3 } },
    groups: [
      {
        id: 'OG-1',
        kind: 'order',
        members: ['ledger_entry:A', 'rzp_order:o1', 'rzp_payment:p1'],
        anomalies: [],
      },
      {
        id: 'OG-2',
        kind: 'order',
        members: ['ledger_entry:B', 'rzp_payment:p2', 'rzp_refund:r2'],
        anomalies: ['FULL_REFUND'],
      },
      {
        id: 'OG-3',
        kind: 'order',
        members: ['ledger_entry:C', 'rzp_payment:p3', 'rzp_payment:p3b'],
        anomalies: ['DUPLICATE_PAYMENT'],
      },
      {
        id: 'PG-1',
        kind: 'payout',
        members: ['rzp_settlement:s1', 'bank_line:row-1', 'settlement_item:s1:p1'],
        anomalies: [],
      },
      { id: 'OG-4', kind: 'order', members: ['rzp_order:only-an-order'], anomalies: [] },
    ],
    anomalies: [
      {
        id: 'AN-1',
        reasonCode: 'LEDGER_AMOUNT_EDITED',
        records: [{ type: 'ledger_entry', key: 'A' }],
      },
    ],
    records: [
      { type: 'ledger_entry', key: 'A', groupId: 'OG-1', reasonCodes: ['TIMEZONE_DATE_SHIFT'] },
      { type: 'ledger_entry', key: 'D', groupId: null, reasonCodes: [] },
      { type: 'bank_line', key: 'row-9', groupId: null, reasonCodes: [] },
    ],
  });

const index = indexTruth(truth());
const group = (id: string, origin: 'rule' | 'agent', ...keys: string[]): AcceptedGroup => ({
  id,
  origin,
  kind: 'order',
  keys,
});

describe('classifyKeys', () => {
  it('tells an exact group from a partial one from a false one', () => {
    expect(classifyKeys(index, ['ledger_entry:A', 'rzp_payment:p1'])).toEqual({
      kind: 'exact',
      home: 'OG-1',
    });
    expect(classifyKeys(index, ['ledger_entry:C', 'rzp_payment:p3'])).toEqual({
      kind: 'partial',
      home: 'OG-3',
    });
    expect(classifyKeys(index, ['ledger_entry:A', 'rzp_payment:p2'])).toMatchObject({
      kind: 'false',
      homes: ['OG-1', 'OG-2'],
    });
  });

  it('calls a link to a record that is in no truth group false, and ignores repeats', () => {
    expect(classifyKeys(index, ['ledger_entry:A', 'ledger_entry:D'])).toMatchObject({
      kind: 'false',
      homes: ['OG-1', 'none'],
    });
    expect(
      classifyKeys(index, ['ledger_entry:A', 'ledger_entry:A', 'rzp_payment:p1']),
    ).toMatchObject({ kind: 'exact' });
  });
});

describe('scoreGroups', () => {
  it('counts only truth groups with two or more records the matcher can link', () => {
    // OG-4 is an order alone and PG-1 loses its settlement item: 4 linkable groups remain.
    expect(scoreGroups(index, []).truthGroups).toBe(4);
  });

  it('scores a clean run: exact, partial, precision and match rate to the group', () => {
    const s = scoreGroups(index, [
      group('g1', 'rule', 'ledger_entry:A', 'rzp_payment:p1'),
      group('g2', 'rule', 'ledger_entry:B', 'rzp_payment:p2', 'rzp_refund:r2'),
      group('g3', 'rule', 'ledger_entry:C', 'rzp_payment:p3'),
      { id: 'g4', origin: 'rule', kind: 'payout', keys: ['rzp_settlement:s1', 'bank_line:row-1'] },
    ]);
    expect(s).toMatchObject({
      truthGroups: 4,
      exact: 3,
      partial: 1,
      matchRate: 0.75,
      matchRateWithPartial: 1,
      incomplete: 1,
      falseMatches: 0,
      precision: 1,
      accepted: { total: 4, rule: 4, agent: 0 },
    });
    expect(s.byKind).toEqual({
      order: { truth: 3, exact: 2, partial: 1 },
      payout: { truth: 1, exact: 1, partial: 0 },
    });
  });

  it('counts a group that mixes two truth groups as a FALSE MATCH and keeps it as an example', () => {
    const s = scoreGroups(index, [
      group('good', 'rule', 'ledger_entry:A', 'rzp_payment:p1'),
      group('bad', 'agent', 'ledger_entry:A', 'rzp_payment:p2'),
    ]);
    expect(s.falseMatches).toBe(1);
    expect(s.precision).toBe(0.5);
    expect(s.agentAdded).toEqual({ accepted: 1, exact: 0, falseMatches: 1 });
    expect(s.falseMatchExamples[0]).toMatchObject({
      groupId: 'bad',
      origin: 'agent',
      homes: ['OG-1', 'OG-2'],
    });
  });

  it('does not credit the same truth group twice, and prefers exact over partial', () => {
    const s = scoreGroups(index, [
      group('a', 'rule', 'ledger_entry:C', 'rzp_payment:p3'),
      group('b', 'agent', 'ledger_entry:C', 'rzp_payment:p3', 'rzp_payment:p3b'),
    ]);
    expect(s.exact).toBe(1);
    expect(s.partial).toBe(0);
    expect(s.agentAdded.exact).toBe(1);
  });

  it('has no precision for no accepted groups, rather than 100%', () => {
    const s = scoreGroups(index, []);
    expect(s.precision).toBeNull();
    expect(s.matchRate).toBe(0);
  });

  it('never reports more false matches than accepted groups, nor exact + partial above the truth', () => {
    const keys = [
      'ledger_entry:A',
      'rzp_payment:p1',
      'ledger_entry:B',
      'rzp_payment:p2',
      'ledger_entry:D',
    ];
    for (let mask = 1; mask < 2 ** keys.length; mask += 1) {
      const picked = keys.filter((_, i) => (mask >> i) & 1);
      const s = scoreGroups(index, [group('x', 'agent', ...picked)]);
      expect(s.falseMatches + s.exact + s.partial).toBeLessThanOrEqual(1 + s.truthGroups);
      expect(s.falseMatches).toBeLessThanOrEqual(s.accepted.total);
    }
  });
});

describe('expectedCodes and scoreReasonCodes', () => {
  it('collects codes from the record, the anomalies that list it and the group, else UNKNOWN', () => {
    expect([...expectedCodes(index, 'ledger_entry:A')].sort()).toEqual([
      'LEDGER_AMOUNT_EDITED',
      'TIMEZONE_DATE_SHIFT',
    ]);
    expect([...expectedCodes(index, 'ledger_entry:B')]).toEqual(['FULL_REFUND']);
    expect([...expectedCodes(index, 'bank_line:row-9')]).toEqual(['UNKNOWN']);
    expect([...expectedCodes(index, 'ledger_entry:nobody')]).toEqual(['UNKNOWN']);
  });

  it('scores accuracy, separates abstentions, and lists what was wrong', () => {
    const s = scoreReasonCodes(index, [
      {
        exceptionId: 'e1',
        subjectKey: 'ledger_entry:A',
        verdict: 'EXPLAINED_NO_MATCH',
        agentCode: 'LEDGER_AMOUNT_EDITED',
      },
      {
        exceptionId: 'e2',
        subjectKey: 'ledger_entry:B',
        verdict: 'EXPLAINED_NO_MATCH',
        agentCode: 'DUPLICATE_PAYMENT',
      },
      {
        exceptionId: 'e3',
        subjectKey: 'bank_line:row-9',
        verdict: 'NEEDS_HUMAN',
        agentCode: 'UNKNOWN',
      },
      {
        exceptionId: 'e4',
        subjectKey: 'bank_line:row-9',
        verdict: 'EXPLAINED_NO_MATCH',
        agentCode: 'FULL_REFUND',
      },
    ]);
    expect(s).toMatchObject({ handled: 4, concluded: 3, abstained: 1, correct: 2, accuracy: 0.5 });
    expect(s.accuracyConcluded).toBeCloseTo(1 / 3);
    expect(s.byExpected['UNKNOWN']).toEqual({ n: 2, correct: 1 });
    expect(s.wrong.map((w) => w.exceptionId)).toEqual(['e2', 'e4']);
    expect(s.wrong[0]).toMatchObject({ expected: ['FULL_REFUND'], got: 'DUPLICATE_PAYMENT' });
  });

  it('has no accuracy for no exceptions', () => {
    expect(scoreReasonCodes(index, [])).toMatchObject({
      handled: 0,
      accuracy: null,
      accuracyConcluded: null,
    });
  });
});

describe('against the real truth.json of the eval preset (seed 42)', () => {
  const files = renderToStrings(generate(resolveConfig(42, 'eval')));
  const real = indexTruth(parseTruth(JSON.parse(files.get('truth.json') as string)));

  it('parses, and has the groups the matcher measurements are built on', () => {
    expect(real.truth.meta.config.orders).toBe(500);
    expect(real.truth.groups.length).toBe(534);
  });

  it('a perfect run scores 100% with no false match, and each group alone is exact', () => {
    const perfect: AcceptedGroup[] = real.truth.groups
      .map((g): AcceptedGroup => ({
        id: g.id,
        origin: 'rule',
        kind: g.kind,
        keys: [...(real.members.get(g.id) ?? [])],
      }))
      .filter((g) => g.keys.length >= 2);
    const s = scoreGroups(real, perfect);
    expect(s.matchRate).toBe(1);
    expect(s.falseMatches).toBe(0);
    expect(s.precision).toBe(1);
    expect(s.partial).toBe(0);
  });

  it('merging any two neighbouring truth groups into one accepted group is always a false match', () => {
    const linkable = real.truth.groups
      .filter((g) => (real.members.get(g.id)?.size ?? 0) >= 2)
      .slice(0, 40);
    for (let i = 0; i + 1 < linkable.length; i += 2) {
      const [a, b] = [linkable[i], linkable[i + 1]];
      const keys = [...(real.members.get(a!.id) ?? []), ...(real.members.get(b!.id) ?? [])];
      expect(classifyKeys(real, keys).kind).toBe('false');
    }
  });
});

describe('the cases a mutation check found untested', () => {
  it('a group made ONLY of records that belong to no truth group is a false match, not an incomplete one', () => {
    // Two unrelated records linked to each other: the purest false match there is.
    const alone = classifyKeys(index, ['ledger_entry:D', 'bank_line:row-9']);
    expect(alone).toEqual({ kind: 'false', homes: ['none'] });
    const s = scoreGroups(index, [group('junk', 'agent', 'ledger_entry:D', 'bank_line:row-9')]);
    expect(s.falseMatches).toBe(1);
    expect(s.incomplete).toBe(0);
    expect(s.precision).toBe(0);
  });

  it('an exact group is not downgraded to partial by an incomplete one that comes after it', () => {
    const s = scoreGroups(index, [
      group('b', 'agent', 'ledger_entry:C', 'rzp_payment:p3', 'rzp_payment:p3b'),
      group('a', 'rule', 'ledger_entry:C', 'rzp_payment:p3'),
    ]);
    expect(s.exact).toBe(1);
    expect(s.partial).toBe(0);
  });
});
