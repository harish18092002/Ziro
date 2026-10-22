import { z } from 'zod';
import { MoneyError, paise, type Paise } from '../money/index.js';

/**
 * Paise on the way in: a bigint, a safe-integer number (Razorpay's JSON) or a canonical integer
 * string (our own JSON, since JSON cannot carry a bigint). Always comes out as a branded bigint;
 * floats and out-of-range values become validation issues.
 */
export const paiseSchema = z.union([z.bigint(), z.number(), z.string()]).transform((value, ctx) => {
  try {
    return paise(value);
  } catch (err) {
    if (!(err instanceof MoneyError)) throw err;
    ctx.addIssue({ code: 'custom', message: err.message });
    return z.NEVER;
  }
});

/** Gross amounts, fees and tax are never negative. */
export const nonNegativePaiseSchema = paiseSchema.refine((value: Paise) => value >= 0n, {
  error: 'must not be negative',
});

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1) return false;
  const length = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day <= length;
}

/** A calendar date in IST (Asia/Kolkata) as YYYY-MM-DD: the only kind of date matching compares. */
export const businessDateSchema = z.string().refine(isCalendarDate, {
  error: 'must be a valid YYYY-MM-DD date',
});
export type BusinessDate = z.output<typeof businessDateSchema>;

/** An instant with an explicit offset, e.g. 2026-10-22T09:30:00Z or ...+05:30. */
export const instantSchema = z.iso.datetime({ offset: true });

export const uuidSchema = z.uuid();

export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha-256 hex');

/** Where a record came from. Synthetic and test-mode data only (CLAUDE.md §4.6). */
export const SOURCES = ['csv', 'synthetic', 'razorpay_testmode'] as const;
export const sourceSchema = z.enum(SOURCES);
export type Source = z.output<typeof sourceSchema>;

export const rzpPaymentIdSchema = z.string().regex(/^pay_[A-Za-z0-9]+$/, 'must look like pay_...');
export const rzpRefundIdSchema = z.string().regex(/^rfnd_[A-Za-z0-9]+$/, 'must look like rfnd_...');
export const rzpSettlementIdSchema = z
  .string()
  .regex(/^setl_[A-Za-z0-9]+$/, 'must look like setl_...');
/** An ISO 4217 code. Razorpay settles in INR; anything else is read faithfully so the verifier can refuse it. */
export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { error: 'must be a 3-letter currency code such as INR' });

export const rzpOrderIdSchema = z
  .string()
  .regex(/^order_[A-Za-z0-9]+$/, 'must look like order_...');

/** Fields every ingested source record carries (the schema mirrors them as columns). */
export const sourceRecordShape = {
  id: uuidSchema,
  runId: uuidSchema,
  source: sourceSchema,
  /** The record's id in its origin: pay_..., a CSV row key, a bank line number. */
  sourceRef: z.string().min(1).max(200),
  /** sha-256 of the canonical record: detects a changed re-import. Not unique by design. */
  importHash: sha256HexSchema,
} as const;
