// datagen's truth.json, read the way the eval needs it. Only the fields the scoring uses are required;
// the rest of the file is left alone (loose objects), so a generator that adds a field does not break
// the eval, and one that drops a field it relies on does.
import { z } from 'zod';

const recordSchema = z.looseObject({
  type: z.string(),
  key: z.string(),
  groupId: z.string().nullable(),
  reasonCodes: z.array(z.string()),
  injection: z
    .looseObject({ field: z.string(), style: z.string(), text: z.string() })
    .nullable()
    .optional(),
});

const groupSchema = z.looseObject({
  id: z.string(),
  kind: z.enum(['order', 'payout']),
  /** `type:key`, including types the matcher never links (orders, settlement items). */
  members: z.array(z.string()),
  /** Reason codes that explain the group as a whole (a chargeback, a delayed payout). */
  anomalies: z.array(z.string()),
});

const anomalySchema = z.looseObject({
  id: z.string(),
  reasonCode: z.string(),
  records: z.array(z.looseObject({ type: z.string(), key: z.string() })),
  detail: z.record(z.string(), z.string()).optional(),
});

export const truthSchema = z.looseObject({
  meta: z.looseObject({
    seed: z.number(),
    preset: z.string(),
    config: z.looseObject({ orders: z.number() }),
  }),
  groups: z.array(groupSchema),
  anomalies: z.array(anomalySchema),
  records: z.array(recordSchema),
});
export type Truth = z.output<typeof truthSchema>;
export type TruthGroup = Truth['groups'][number];
export type TruthRecord = Truth['records'][number];
export type TruthAnomaly = Truth['anomalies'][number];

export function parseTruth(json: unknown): Truth {
  return truthSchema.parse(json);
}

/** The five record types the matcher links; truth also names orders and settlement items. */
export const MATCHED_TYPES: ReadonlySet<string> = new Set([
  'ledger_entry',
  'rzp_payment',
  'rzp_refund',
  'rzp_settlement',
  'bank_line',
]);
export const isMatchable = (key: string): boolean =>
  MATCHED_TYPES.has(key.slice(0, key.indexOf(':')));
export const truthKey = (r: { type: string; key: string }): string => `${r.type}:${r.key}`;

export interface TruthIndex {
  readonly truth: Truth;
  /** Matchable record key -> the truth group it belongs to. */
  readonly groupOf: ReadonlyMap<string, string>;
  /** Truth group id -> its matchable member keys. */
  readonly members: ReadonlyMap<string, ReadonlySet<string>>;
  readonly groupById: ReadonlyMap<string, TruthGroup>;
  readonly record: ReadonlyMap<string, TruthRecord>;
  /** Record key -> reason codes of every anomaly that lists the record. */
  readonly anomalyCodes: ReadonlyMap<string, ReadonlySet<string>>;
}

export function indexTruth(truth: Truth): TruthIndex {
  const groupOf = new Map<string, string>();
  const members = new Map<string, Set<string>>();
  for (const g of truth.groups) {
    const keys = new Set(g.members.filter(isMatchable));
    members.set(g.id, keys);
    for (const key of keys) groupOf.set(key, g.id);
  }
  const anomalyCodes = new Map<string, Set<string>>();
  for (const a of truth.anomalies) {
    for (const r of a.records) {
      const key = truthKey(r);
      const set = anomalyCodes.get(key) ?? new Set<string>();
      set.add(a.reasonCode);
      anomalyCodes.set(key, set);
    }
  }
  return {
    truth,
    groupOf,
    members,
    groupById: new Map(truth.groups.map((g) => [g.id, g])),
    record: new Map(truth.records.map((r) => [truthKey(r), r])),
    anomalyCodes,
  };
}

/**
 * The reason codes that are right for an exception on this record: the codes on the record itself,
 * the codes of anomalies that list it, and the codes that explain the group it belongs to (truth puts
 * some explanations on a record, such as a date shift, and others on the group, such as a chargeback).
 * A record truth says nothing about is expected to be UNKNOWN.
 */
export function expectedCodes(index: TruthIndex, key: string): ReadonlySet<string> {
  const codes = new Set<string>(index.record.get(key)?.reasonCodes ?? []);
  for (const c of index.anomalyCodes.get(key) ?? []) codes.add(c);
  const home = index.groupOf.get(key);
  if (home !== undefined) for (const c of index.groupById.get(home)?.anomalies ?? []) codes.add(c);
  if (codes.size === 0) codes.add('UNKNOWN');
  return codes;
}
