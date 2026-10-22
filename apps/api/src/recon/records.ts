// Database rows as the pure domain records @ziro/core works on. The rows were validated on the way
// in and are guarded by CHECK constraints, so this only renames and converts (paise to the branded
// type, timestamps to ISO strings).
import type {
  BankLine,
  LedgerEntry,
  RzpPayment,
  RzpRefund,
  RzpSettlement,
  SettlementItem,
} from '@ziro/core/domain';
import { paise } from '@ziro/core/money';
import type {
  bankLines,
  ledgerEntries,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
  settlementItems,
} from '../db/schema.js';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

const base = (r: {
  id: string;
  runId: string;
  source: LedgerEntry['source'];
  sourceRef: string;
  importHash: string;
}) => ({
  id: r.id,
  runId: r.runId,
  source: r.source,
  sourceRef: r.sourceRef,
  importHash: r.importHash,
});

export const ledgerOf = (r: Row<typeof ledgerEntries>): LedgerEntry => ({
  ...base(r),
  orderRef: r.orderRef,
  amount: paise(r.amountPaise),
  businessDate: r.businessDate,
  customerRef: r.customerRef,
  memo: r.memo,
});

export const paymentOf = (r: Row<typeof rzpPayments>): RzpPayment => ({
  ...base(r),
  paymentId: r.rzpId,
  orderId: r.rzpOrderId,
  receipt: r.receipt,
  currency: r.currency,
  amount: paise(r.amountPaise),
  fee: paise(r.feePaise),
  tax: paise(r.taxPaise),
  amountRefunded: paise(r.amountRefundedPaise),
  method: r.method,
  status: r.status,
  captured: r.captured,
  createdAt: r.rzpCreatedAt.toISOString(),
  businessDate: r.businessDate,
});

export const refundOf = (r: Row<typeof rzpRefunds>): RzpRefund => ({
  ...base(r),
  refundId: r.rzpId,
  paymentId: r.rzpPaymentId,
  currency: r.currency,
  amount: paise(r.amountPaise),
  status: r.status,
  createdAt: r.rzpCreatedAt.toISOString(),
  businessDate: r.businessDate,
});

export const settlementOf = (r: Row<typeof rzpSettlements>): RzpSettlement => ({
  ...base(r),
  settlementId: r.rzpId,
  amount: paise(r.amountPaise),
  fees: paise(r.feesPaise),
  tax: paise(r.taxPaise),
  utr: r.utr,
  status: r.status,
  createdAt: r.rzpCreatedAt.toISOString(),
  businessDate: r.businessDate,
});

/** A settlement line names its settlement by uuid in the database and by Razorpay id in the domain. */
export const itemOf = (
  r: Row<typeof settlementItems>,
  settlementRzpId: string,
): SettlementItem => ({
  ...base(r),
  settlementId: settlementRzpId,
  itemType: r.itemType,
  entityId: r.rzpEntityId,
  paymentId: r.rzpPaymentId,
  orderId: r.rzpOrderId,
  currency: r.currency,
  amount: paise(r.amountPaise),
  fee: paise(r.feePaise),
  tax: paise(r.taxPaise),
  debit: paise(r.debitPaise),
  credit: paise(r.creditPaise),
  settledAt: r.settledAt === null ? null : r.settledAt.toISOString(),
  description: r.description,
});

export const bankLineOf = (r: Row<typeof bankLines>): BankLine => ({
  ...base(r),
  valueDate: r.valueDate,
  direction: r.direction,
  amount: paise(r.amountPaise),
  narration: r.narration,
  utr: r.utr,
  utrQuality: r.utrQuality,
  balance: r.balancePaise === null ? null : paise(r.balancePaise),
});
