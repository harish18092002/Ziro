import { assertInRange, MoneyError, type Paise } from './paise.js';

/**
 * Strict rupee grammar. Digits only, or Indian lakh/crore grouping (1,23,456 / 12,345 / 1,234),
 * then an optional fraction of one or two digits. No sign, no whitespace, no currency symbol, no
 * Western grouping (123,456). Junk is rejected rather than interpreted: callers trim and strip.
 */
const RUPEES =
  /^(?:(?<plain>0|[1-9]\d*)|(?<grouped>[1-9]\d?(?:,\d{2})*,\d{3}))(?:\.(?<fraction>\d{1,2}))?$/;

const MAX_INPUT_LENGTH = 64;

export interface ParseRupeesOptions {
  /** Accept one leading "-". Off by default: bank/ledger amounts are unsigned. */
  allowNegative?: boolean;
}

/** Parses "1,23,456.50" or "123456.5" into Paise. Never rounds: a third decimal is an error. */
export function parseRupees(input: string, options: ParseRupeesOptions = {}): Paise {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_INPUT_LENGTH) {
    throw new MoneyError('INVALID_FORMAT', 'rupee amount must be a non-empty string');
  }
  const negative = input.startsWith('-');
  if (negative && !options.allowNegative) {
    throw new MoneyError('INVALID_FORMAT', 'negative rupee amounts are not allowed here');
  }
  const unsigned = negative ? input.slice(1) : input;

  const groups = RUPEES.exec(unsigned)?.groups;
  if (!groups) {
    throw new MoneyError('INVALID_FORMAT', 'not a valid rupee amount');
  }
  const rupees = BigInt((groups['plain'] ?? groups['grouped'] ?? '').replaceAll(',', ''));
  const fraction = BigInt((groups['fraction'] ?? '').padEnd(2, '0') || '0');
  const magnitude = rupees * 100n + fraction;

  if (negative && magnitude === 0n) {
    throw new MoneyError('INVALID_FORMAT', 'negative zero is not a valid rupee amount');
  }
  return assertInRange(negative ? -magnitude : magnitude);
}

/** "123456" -> "1,23,456"; the last three digits stay together, the rest group in pairs. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(?:\d{2})+(?!\d))/g, ',');
  return `${head},${digits.slice(-3)}`;
}

export interface FormatRupeesOptions {
  /** Prefix with the rupee sign. Off by default so the output round-trips through parseRupees. */
  symbol?: boolean;
}

/** Always two decimals, Indian grouping: 12345650 -> "1,23,456.50". */
export function formatRupees(amount: Paise, options: FormatRupeesOptions = {}): string {
  const negative = amount < 0n;
  const magnitude: bigint = negative ? 0n - amount : amount;
  const rupees = groupIndian((magnitude / 100n).toString());
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${options.symbol ? '₹' : ''}${rupees}.${fraction}`;
}
