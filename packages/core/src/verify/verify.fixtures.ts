// Test support for the verifier: a snapshot built from the matcher's record builders. Not part of the
// production build (see tsconfig.build.json).
import type {
  BankLine,
  LedgerEntry,
  RecordRef,
  RzpPayment,
  RzpRefund,
  RzpSettlement,
  SettlementItem,
} from '../domain/index.js';
import { matcherConfig } from '../matcher/index.js';
import { RUN } from '../matcher/matcher.fixtures.js';
import {
  DEFAULT_ORDER_DATE_WINDOW_DAYS,
  recordKey,
  type VerifierConfig,
  type VerifierSnapshot,
} from './types.js';

export { RUN };
export const OTHER_RUN = '00000000-0000-4000-8000-0000000000bb';

export const config = (over: Partial<VerifierConfig> = {}): VerifierConfig => ({
  ...matcherConfig(),
  orderDateWindowDays: DEFAULT_ORDER_DATE_WINDOW_DAYS,
  ...over,
});

export interface Records {
  readonly ledger?: readonly LedgerEntry[];
  readonly payments?: readonly RzpPayment[];
  readonly refunds?: readonly RzpRefund[];
  readonly settlements?: readonly RzpSettlement[];
  readonly items?: readonly SettlementItem[];
  readonly banks?: readonly BankLine[];
  /** Records already in an accepted group. */
  readonly accepted?: readonly RecordRef[];
  readonly runId?: string;
}

const byId = <T extends { id: string }>(list: readonly T[] = []): Map<string, T> =>
  new Map(list.map((r) => [r.id, r]));

export function snapshotOf(records: Records): VerifierSnapshot {
  const items = new Map<string, SettlementItem[]>();
  for (const item of records.items ?? []) {
    items.set(item.settlementId, [...(items.get(item.settlementId) ?? []), item]);
  }
  return {
    runId: records.runId ?? RUN,
    ledger: byId(records.ledger),
    payments: byId(records.payments),
    refunds: byId(records.refunds),
    settlements: byId(records.settlements),
    bankLines: byId(records.banks),
    settlementItems: items,
    paymentsByRzpId: new Map((records.payments ?? []).map((p) => [p.paymentId, p])),
    refundsByRzpId: new Map((records.refunds ?? []).map((r) => [r.refundId, r])),
    accepted: new Set((records.accepted ?? []).map(recordKey)),
  };
}

export const link = (recordType: RecordRef['recordType'], record: { id: string }): RecordRef => ({
  recordType,
  recordId: record.id,
});
export const L = (r: LedgerEntry) => link('ledger_entry', r);
export const P = (r: RzpPayment) => link('rzp_payment', r);
export const R = (r: RzpRefund) => link('rzp_refund', r);
export const S = (r: RzpSettlement) => link('rzp_settlement', r);
export const B = (r: BankLine) => link('bank_line', r);
