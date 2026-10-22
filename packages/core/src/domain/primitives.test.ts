import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_PAISE, MIN_PAISE } from '../money/index.js';
import {
  businessDateSchema,
  instantSchema,
  nonNegativePaiseSchema,
  paiseSchema,
  rzpOrderIdSchema,
  rzpPaymentIdSchema,
  rzpRefundIdSchema,
  rzpSettlementIdSchema,
  sha256HexSchema,
  sourceSchema,
} from './index.js';

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('paiseSchema', () => {
  it('accepts bigint, safe-integer number and canonical integer string, outputting a bigint', () => {
    expect(paiseSchema.parse(12345650n)).toBe(12345650n);
    expect(paiseSchema.parse(12345650)).toBe(12345650n);
    expect(paiseSchema.parse('12345650')).toBe(12345650n);
    expect(paiseSchema.parse('-5')).toBe(-5n);
  });

  it('rejects floats, non-canonical strings, other types and out-of-range values', () => {
    const bad = [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      '1.5',
      '01',
      '1e3',
      ' 1',
      '',
      true,
      null,
      undefined,
      {},
      MAX_PAISE + 1n,
      '9223372036854775808',
    ];
    for (const [i, value] of bad.entries()) {
      expect(ok(paiseSchema, value), `bad case #${i}`).toBe(false);
    }
  });

  it('round-trips every in-range value as a bigint or as its integer string', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: MIN_PAISE, max: MAX_PAISE }), (p) => {
        expect(paiseSchema.parse(p)).toBe(p);
        expect(paiseSchema.parse(p.toString())).toBe(p);
      }),
      { numRuns: 500, examples: [[MAX_PAISE], [MIN_PAISE], [0n]] },
    );
  });
});

describe('nonNegativePaiseSchema', () => {
  it('allows zero and positives, rejects negatives', () => {
    expect(nonNegativePaiseSchema.parse('0')).toBe(0n);
    expect(nonNegativePaiseSchema.parse(5)).toBe(5n);
    expect(ok(nonNegativePaiseSchema, -1)).toBe(false);
    expect(ok(nonNegativePaiseSchema, '-1')).toBe(false);
  });
});

describe('businessDateSchema', () => {
  it('accepts real calendar dates, including leap days', () => {
    for (const d of ['2026-10-22', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01']) {
      expect(ok(businessDateSchema, d), d).toBe(true);
    }
  });

  it('rejects impossible or malformed dates', () => {
    const bad = [
      '2023-02-29',
      '1900-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '2026-10-00',
      '2026-1-1',
      '22-10-2026',
      '2026/10/22',
      '2026-10-22T00:00:00Z',
      '',
    ];
    for (const d of bad) expect(ok(businessDateSchema, d), d).toBe(false);
  });
});

describe('instantSchema', () => {
  it('requires an explicit offset', () => {
    expect(ok(instantSchema, '2026-10-22T09:30:00Z')).toBe(true);
    expect(ok(instantSchema, '2026-10-22T15:00:00+05:30')).toBe(true);
    expect(ok(instantSchema, '2026-10-22T09:30:00')).toBe(false);
    expect(ok(instantSchema, '2026-10-22')).toBe(false);
  });
});

describe('ids, hashes and sources', () => {
  it('checks Razorpay id prefixes', () => {
    expect(ok(rzpPaymentIdSchema, 'pay_Abc123')).toBe(true);
    expect(ok(rzpPaymentIdSchema, 'rfnd_Abc123')).toBe(false);
    expect(ok(rzpPaymentIdSchema, 'pay_')).toBe(false);
    expect(ok(rzpRefundIdSchema, 'rfnd_Abc123')).toBe(true);
    expect(ok(rzpSettlementIdSchema, 'setl_7IZKKI4Pnt2kEe')).toBe(true);
    expect(ok(rzpSettlementIdSchema, 'setl-7IZ')).toBe(false);
    expect(ok(rzpOrderIdSchema, 'order_Xyz789')).toBe(true);
    expect(ok(rzpOrderIdSchema, 'ORD-1')).toBe(false);
  });

  it('accepts only lowercase 64-char sha-256 hex', () => {
    expect(ok(sha256HexSchema, 'a'.repeat(64))).toBe(true);
    expect(ok(sha256HexSchema, 'A'.repeat(64))).toBe(false);
    expect(ok(sha256HexSchema, 'a'.repeat(63))).toBe(false);
    expect(ok(sha256HexSchema, 'g'.repeat(64))).toBe(false);
  });

  it('allows only csv, synthetic and razorpay_testmode as sources', () => {
    for (const s of ['csv', 'synthetic', 'razorpay_testmode'])
      expect(ok(sourceSchema, s)).toBe(true);
    for (const s of ['razorpay_live', 'live', '', 'CSV'])
      expect(ok(sourceSchema, s), s).toBe(false);
  });
});
