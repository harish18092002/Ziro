import { describe, expect, it } from 'vitest';
import { REASON_CODES, ReasonCode, reasonCodeSchema } from './index.js';

// A literal copy of CLAUDE.md §8, in order. If §8 changes (via an ADR), this list changes with it.
const SECTION_8 = [
  'FEE_GST_DEDUCTION',
  'BATCHED_SETTLEMENT',
  'PARTIAL_REFUND_NETTED',
  'FULL_REFUND',
  'CHARGEBACK_ADJUSTMENT',
  'DUPLICATE_PAYMENT',
  'LEDGER_WITHOUT_PAYMENT',
  'PAYMENT_WITHOUT_LEDGER',
  'UTR_MISSING_OR_GARBLED',
  'LEDGER_AMOUNT_EDITED',
  'TIMEZONE_DATE_SHIFT',
  'SETTLEMENT_DELAYED',
  'FEE_OVERCHARGE',
  'UNKNOWN',
];

// Compile-time exhaustiveness: adding a ReasonCode without extending this map is a type error.
const EVERY_CODE: Record<ReasonCode, true> = {
  FEE_GST_DEDUCTION: true,
  BATCHED_SETTLEMENT: true,
  PARTIAL_REFUND_NETTED: true,
  FULL_REFUND: true,
  CHARGEBACK_ADJUSTMENT: true,
  DUPLICATE_PAYMENT: true,
  LEDGER_WITHOUT_PAYMENT: true,
  PAYMENT_WITHOUT_LEDGER: true,
  UTR_MISSING_OR_GARBLED: true,
  LEDGER_AMOUNT_EDITED: true,
  TIMEZONE_DATE_SHIFT: true,
  SETTLEMENT_DELAYED: true,
  FEE_OVERCHARGE: true,
  UNKNOWN: true,
};

describe('ReasonCode', () => {
  it('is exactly the 14 codes of CLAUDE.md §8, in order', () => {
    expect(REASON_CODES).toEqual(SECTION_8);
    expect(REASON_CODES).toHaveLength(14);
    expect(Object.keys(EVERY_CODE)).toEqual(SECTION_8);
  });

  it('maps every key to the identical string', () => {
    for (const [key, value] of Object.entries(ReasonCode)) expect(value).toBe(key);
  });

  it('validates through zod', () => {
    for (const code of SECTION_8) expect(reasonCodeSchema.safeParse(code).success, code).toBe(true);
    for (const bad of ['', 'fee_gst_deduction', 'FEE', 'OTHER', 'UNKNOWN ', 5, null]) {
      expect(reasonCodeSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});
