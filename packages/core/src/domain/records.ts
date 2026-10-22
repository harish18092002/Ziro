import { z } from 'zod';
import { UTR_QUALITIES } from '../normalize/utr.js';
import {
  businessDateSchema,
  instantSchema,
  nonNegativePaiseSchema,
  paiseSchema,
  rzpOrderIdSchema,
  rzpPaymentIdSchema,
  rzpRefundIdSchema,
  rzpSettlementIdSchema,
  sourceRecordShape,
} from './primitives.js';

/** The merchant's own record of an order. `memo` is free text and UNTRUSTED. */
export const ledgerEntrySchema = z.strictObject({
  ...sourceRecordShape,
  orderRef: z.string().min(1).max(200),
  amount: nonNegativePaiseSchema,
  businessDate: businessDateSchema,
  customerRef: z.string().min(1).max(200).nullable(),
  memo: z.string().max(2000).nullable(),
});
export type LedgerEntry = z.output<typeof ledgerEntrySchema>;

export const PAYMENT_STATUSES = [
  'created',
  'authorized',
  'captured',
  'refunded',
  'failed',
] as const;

/**
 * A Razorpay payment. `fee` INCLUDES GST and `tax` is the GST portion of it (Razorpay payment
 * entity docs), so the base fee is `fee - tax`. Tax is not forced to equal 18% of anything: some
 * documented samples carry a fee with tax 0, and judging that is the verifier's job.
 */
export const rzpPaymentSchema = z
  .strictObject({
    ...sourceRecordShape,
    paymentId: rzpPaymentIdSchema,
    orderId: rzpOrderIdSchema.nullable(),
    /** The order's `receipt`, which equals the ledger's order_ref. */
    receipt: z.string().min(1).max(200).nullable(),
    amount: nonNegativePaiseSchema,
    fee: nonNegativePaiseSchema,
    tax: nonNegativePaiseSchema,
    amountRefunded: nonNegativePaiseSchema,
    method: z.string().min(1).max(50),
    status: z.enum(PAYMENT_STATUSES),
    captured: z.boolean(),
    createdAt: instantSchema,
    businessDate: businessDateSchema,
  })
  .refine((p) => p.tax <= p.fee, {
    error: 'tax is part of the fee, so it cannot exceed it',
    path: ['tax'],
  })
  .refine((p) => p.amountRefunded <= p.amount, {
    error: 'cannot refund more than the payment amount',
    path: ['amountRefunded'],
  });
export type RzpPayment = z.output<typeof rzpPaymentSchema>;

export const rzpRefundSchema = z.strictObject({
  ...sourceRecordShape,
  refundId: rzpRefundIdSchema,
  paymentId: rzpPaymentIdSchema,
  amount: nonNegativePaiseSchema,
  status: z.string().min(1).max(50),
  createdAt: instantSchema,
  businessDate: businessDateSchema,
});
export type RzpRefund = z.output<typeof rzpRefundSchema>;

export const SETTLEMENT_STATUSES = ['created', 'processed', 'failed'] as const;

/**
 * Razorpay's payout to the bank. `amount` is the net payout. `fees` and `tax` are informational
 * (both 0 for a normal settlement per the docs): the real accounting is in the settlement items.
 */
export const rzpSettlementSchema = z.strictObject({
  ...sourceRecordShape,
  settlementId: rzpSettlementIdSchema,
  amount: nonNegativePaiseSchema,
  fees: nonNegativePaiseSchema,
  tax: nonNegativePaiseSchema,
  /** As reported, possibly garbled; normalization derives a clean UTR separately. */
  utr: z.string().min(1).max(100).nullable(),
  status: z.enum(SETTLEMENT_STATUSES),
  createdAt: instantSchema,
  businessDate: businessDateSchema,
});
export type RzpSettlement = z.output<typeof rzpSettlementSchema>;

export const SETTLEMENT_ITEM_TYPES = ['payment', 'refund', 'transfer', 'adjustment'] as const;

/** One line of Razorpay's settlement recon report. Debit/credit semantics are checked by the verifier. */
export const settlementItemSchema = z.strictObject({
  ...sourceRecordShape,
  settlementId: rzpSettlementIdSchema,
  itemType: z.enum(SETTLEMENT_ITEM_TYPES),
  /** The settled transaction's id (pay_..., rfnd_..., an adjustment or transfer id). */
  entityId: z.string().min(1).max(100),
  paymentId: rzpPaymentIdSchema.nullable(),
  orderId: rzpOrderIdSchema.nullable(),
  amount: nonNegativePaiseSchema,
  fee: nonNegativePaiseSchema,
  tax: nonNegativePaiseSchema,
  debit: nonNegativePaiseSchema,
  credit: nonNegativePaiseSchema,
  settledAt: instantSchema.nullable(),
  description: z.string().max(1000).nullable(),
});
export type SettlementItem = z.output<typeof settlementItemSchema>;

export const BANK_DIRECTIONS = ['credit', 'debit'] as const;

/** One row of the bank statement. `narration` is free text and UNTRUSTED. */
export const bankLineSchema = z
  .strictObject({
    ...sourceRecordShape,
    valueDate: businessDateSchema,
    direction: z.enum(BANK_DIRECTIONS),
    amount: nonNegativePaiseSchema,
    narration: z.string().max(2000),
    /** Extracted from the narration by normalization; null when absent or unrecoverable. */
    utr: z.string().min(1).max(100).nullable(),
    /**
     * How far to trust `utr`: a `truncated` one is only a fragment (never equal to a full UTR) and a
     * `repaired` one is a look-alike correction. Null exactly when `utr` is null.
     */
    utrQuality: z.enum(UTR_QUALITIES).nullable(),
    /** Running balance when the statement provides one. Signed: overdrafts exist. */
    balance: paiseSchema.nullable(),
  })
  .refine((line) => (line.utr === null) === (line.utrQuality === null), {
    error: 'utr and utrQuality are either both set or both null',
    path: ['utrQuality'],
  });
export type BankLine = z.output<typeof bankLineSchema>;
