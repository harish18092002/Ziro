import { z } from 'zod';

/**
 * Why a record could not be matched 1:1 (CLAUDE.md §8). Extend only via an ADR: the database enum,
 * the agent prompt and the eval ground truth all key off this list.
 */
export const ReasonCode = {
  FEE_GST_DEDUCTION: 'FEE_GST_DEDUCTION',
  BATCHED_SETTLEMENT: 'BATCHED_SETTLEMENT',
  PARTIAL_REFUND_NETTED: 'PARTIAL_REFUND_NETTED',
  FULL_REFUND: 'FULL_REFUND',
  CHARGEBACK_ADJUSTMENT: 'CHARGEBACK_ADJUSTMENT',
  DUPLICATE_PAYMENT: 'DUPLICATE_PAYMENT',
  LEDGER_WITHOUT_PAYMENT: 'LEDGER_WITHOUT_PAYMENT',
  PAYMENT_WITHOUT_LEDGER: 'PAYMENT_WITHOUT_LEDGER',
  UTR_MISSING_OR_GARBLED: 'UTR_MISSING_OR_GARBLED',
  LEDGER_AMOUNT_EDITED: 'LEDGER_AMOUNT_EDITED',
  TIMEZONE_DATE_SHIFT: 'TIMEZONE_DATE_SHIFT',
  SETTLEMENT_DELAYED: 'SETTLEMENT_DELAYED',
  FEE_OVERCHARGE: 'FEE_OVERCHARGE',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ReasonCode = (typeof ReasonCode)[keyof typeof ReasonCode];

export const REASON_CODES: readonly ReasonCode[] = Object.values(ReasonCode);

export const reasonCodeSchema = z.enum(ReasonCode);
