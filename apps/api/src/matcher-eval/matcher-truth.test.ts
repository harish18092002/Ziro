// The rule matcher against datagen's ground truth. It SHOULD miss the injected anomalies: that is the
// agent's job. What it must never do is match wrongly, or lose a record.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MatcherOutput, runMatcher } from '@ziro/core/matcher';
import { afterAll, describe, expect, it } from 'vitest';
import { makeSyntheticDataset, type TempDataset } from '../razorpay/razorpay.fixtures.js';
import { type DomainDataset, loadDomainDataset, matcherConfigFor } from './dataset.js';

interface Truth {
  groups: { id: string; kind: 'order' | 'payout'; members: string[]; anomalies: string[] }[];
  anomalies: { id: string; reasonCode: string; records: { type: string; key: string }[] }[];
  records: { type: string; key: string; groupId: string | null; reasonCodes: string[] }[];
}

// The five record types the matcher links; truth.json also names orders and settlement items.
const MATCHED_TYPES = new Set([
  'ledger_entry',
  'rzp_payment',
  'rzp_refund',
  'rzp_settlement',
  'bank_line',
]);
const isMatched = (key: string): boolean => MATCHED_TYPES.has(key.slice(0, key.indexOf(':')));

interface Measured {
  readonly truthGroups: Record<'order' | 'payout', number>;
  readonly exact: Record<'order' | 'payout', number>;
  /** Found, but missing records the rules cannot link (a duplicate payment and its refund). */
  readonly partial: Record<'order' | 'payout', number>;
  readonly falseLinks: number;
  readonly lostRecords: number;
  readonly groupCodeWrong: number;
  readonly groupCodes: Record<string, number>;
  readonly exceptionCodeWrong: number;
  readonly byAnomaly: Record<string, Record<string, number>>;
}

function measure(out: MatcherOutput, data: DomainDataset, truth: Truth): Measured {
  const keyOf = (id: string): string => data.truthKey.get(id) as string;
  const truthGroupOf = new Map<string, string>();
  const truthMembers = new Map<string, Set<string>>();
  for (const g of truth.groups) {
    const members = new Set(g.members.filter(isMatched));
    truthMembers.set(g.id, members);
    for (const key of members) truthGroupOf.set(key, g.id);
  }
  const reasonsOf = new Map(truth.records.map((r) => [`${r.type}:${r.key}`, r.reasonCodes]));

  // --- every rule group against the truth group its members belong to ---
  let falseLinks = 0;
  let groupCodeWrong = 0;
  const groupCodes: Record<string, number> = {};
  const truthGroupById = new Map(truth.groups.map((g) => [g.id, g]));
  const found = new Map<string, 'exact' | 'partial'>();
  for (const group of out.groups) {
    const keys = group.members.map((m) => keyOf(m.recordId));
    const homes = new Set(keys.map((k) => truthGroupOf.get(k) ?? 'none'));
    if (homes.size !== 1 || homes.has('none')) {
      falseLinks += 1;
      continue;
    }
    const home = [...homes][0] as string;
    const whole = truthMembers.get(home) as Set<string>;
    found.set(home, keys.length === whole.size ? 'exact' : 'partial');
    // Truth records some explanations on the record (a date shift) and others on the group (a chargeback).
    const code = group.reasonCode;
    if (code !== null) {
      const agreed =
        keys.some((k) => reasonsOf.get(k)?.includes(code)) ||
        truthGroupById.get(home)?.anomalies.includes(code) === true;
      if (!agreed) groupCodeWrong += 1;
      groupCodes[`${group.kind}/${code}`] = (groupCodes[`${group.kind}/${code}`] ?? 0) + 1;
    }
  }

  // --- every code the rules put on an exception against what truth says about that record ---
  let exceptionCodeWrong = 0;
  for (const e of out.exceptions) {
    if (e.reasonCode === 'UNKNOWN') continue;
    if (!reasonsOf.get(keyOf(e.subject.recordId))?.includes(e.reasonCode)) exceptionCodeWrong += 1;
  }

  // --- where did the records of each injected anomaly end up? ---
  const groupedKeys = new Set(out.groups.flatMap((g) => g.members.map((m) => keyOf(m.recordId))));
  const exceptionKeys = new Set(out.exceptions.map((e) => keyOf(e.subject.recordId)));
  const byAnomaly: Record<string, Record<string, number>> = {};
  for (const anomaly of truth.anomalies) {
    const keys = anomaly.records.map((r) => `${r.type}:${r.key}`).filter(isMatched);
    const outcome = keys.some((k) => exceptionKeys.has(k))
      ? 'raised for the agent'
      : keys.length > 0 && keys.every((k) => groupedKeys.has(k))
        ? 'matched by rules'
        : 'ignored or not a matcher record';
    const row = (byAnomaly[anomaly.reasonCode] ??= {});
    row[outcome] = (row[outcome] ?? 0) + 1;
  }

  const placed = [
    ...out.groups.flatMap((g) => g.members.map((m) => m.recordId)),
    ...out.exceptions.map((e) => e.subject.recordId),
    ...out.ignored.map((i) => i.subject.recordId),
  ];
  const lostRecords = data.truthKey.size - new Set(placed).size;

  const count = (kind: 'order' | 'payout', how?: 'exact' | 'partial') =>
    truth.groups.filter(
      (g) => g.kind === kind && (how === undefined ? true : found.get(g.id) === how),
    ).length;
  return {
    truthGroups: { order: count('order'), payout: count('payout') },
    exact: { order: count('order', 'exact'), payout: count('payout', 'exact') },
    partial: { order: count('order', 'partial'), payout: count('payout', 'partial') },
    falseLinks,
    lostRecords,
    groupCodeWrong,
    groupCodes,
    exceptionCodeWrong,
    byAnomaly,
  };
}

const datasets: TempDataset[] = [];
afterAll(() => datasets.forEach((d) => d.cleanup()));

async function run(preset: 'demo' | 'eval', seed: number) {
  const generated = makeSyntheticDataset(preset, seed);
  datasets.push(generated);
  const data = await loadDomainDataset(generated.dir);
  const truth = JSON.parse(readFileSync(join(generated.dir, 'truth.json'), 'utf8')) as Truth;
  const out = runMatcher(data.input, matcherConfigFor(seed, preset));
  return { data, truth, out, measured: measure(out, data, truth) };
}

describe.each([
  ['demo', 42],
  ['eval', 42],
  ['eval', 7],
  ['eval', 2026],
] as const)('rules-only matching against truth.json: %s preset, seed %i', (preset, seed) => {
  it('never links records that truth says belong apart, never loses a record, never mislabels', async () => {
    const { measured, out, data } = await run(preset, seed);
    expect(measured.falseLinks).toBe(0);
    expect(measured.lostRecords).toBe(0);
    expect(measured.groupCodeWrong).toBe(0);
    expect(measured.exceptionCodeWrong).toBe(0);
    expect(out.groups.every((g) => g.residual === 0n)).toBe(true);
    expect(data.truthKey.size).toBeGreaterThan(0);
  });

  it('finds the large majority of the groups truth contains', async () => {
    const { measured } = await run(preset, seed);
    const found = (kind: 'order' | 'payout') =>
      (measured.exact[kind] + measured.partial[kind]) / measured.truthGroups[kind];
    expect(found('order')).toBeGreaterThan(0.9);
    expect(found('payout')).toBeGreaterThan(0.9);
  });
});

describe('the eval preset, seed 42: what the rules solve and what they leave to the agent', () => {
  it('reports the measured outcome', async () => {
    const { measured } = await run('eval', 42);
    expect(measured).toMatchInlineSnapshot(`
      {
        "byAnomaly": {
          "CHARGEBACK_ADJUSTMENT": {
            "matched by rules": 5,
          },
          "DUPLICATE_PAYMENT": {
            "raised for the agent": 10,
          },
          "FEE_OVERCHARGE": {
            "matched by rules": 15,
          },
          "FULL_REFUND": {
            "matched by rules": 15,
          },
          "LEDGER_AMOUNT_EDITED": {
            "raised for the agent": 10,
          },
          "LEDGER_WITHOUT_PAYMENT": {
            "raised for the agent": 15,
          },
          "PARTIAL_REFUND_NETTED": {
            "matched by rules": 20,
          },
          "PAYMENT_WITHOUT_LEDGER": {
            "raised for the agent": 10,
          },
          "SETTLEMENT_DELAYED": {
            "matched by rules": 4,
          },
          "TIMEZONE_DATE_SHIFT": {
            "matched by rules": 15,
          },
          "UTR_MISSING_OR_GARBLED": {
            "matched by rules": 9,
            "raised for the agent": 1,
          },
        },
        "exact": {
          "order": 472,
          "payout": 48,
        },
        "exceptionCodeWrong": 0,
        "falseLinks": 0,
        "groupCodeWrong": 0,
        "groupCodes": {
          "order/FULL_REFUND": 15,
          "order/PARTIAL_REFUND_NETTED": 20,
          "order/TIMEZONE_DATE_SHIFT": 15,
          "payout/CHARGEBACK_ADJUSTMENT": 4,
          "payout/SETTLEMENT_DELAYED": 3,
        },
        "lostRecords": 0,
        "partial": {
          "order": 3,
          "payout": 0,
        },
        "truthGroups": {
          "order": 485,
          "payout": 49,
        },
      }
    `);
  });
});
