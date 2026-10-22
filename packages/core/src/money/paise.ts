/**
 * Integer paise (1/100 rupee). Branded so a bare bigint or number cannot be passed where money is
 * expected. There is no floating-point anywhere in this module (enforced by ESLint).
 */
export type Paise = bigint & { readonly __brand: 'Paise' };

/**
 * Largest magnitude a Paise may take. It is the int64 maximum, so every Paise fits a Postgres
 * `bigint` column. The range is symmetric so negating a value can never overflow.
 */
export const MAX_PAISE = 9_223_372_036_854_775_807n as Paise;
export const MIN_PAISE = (0n - MAX_PAISE) as Paise;
export const ZERO = 0n as Paise;

export type MoneyErrorCode = 'NOT_INTEGER' | 'OUT_OF_RANGE' | 'INVALID_FORMAT' | 'INVALID_ARGUMENT';

export class MoneyError extends Error {
  constructor(
    readonly code: MoneyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

const INTEGER_STRING = /^-?(?:0|[1-9]\d*)$/;

/** Throws OUT_OF_RANGE unless `value` fits the int64 paise range. */
export function assertInRange(value: bigint): Paise {
  if (value > MAX_PAISE || value < MIN_PAISE) {
    throw new MoneyError('OUT_OF_RANGE', 'paise value is outside the int64 range');
  }
  return value as Paise;
}

/**
 * Builds a Paise from a bigint, a safe-integer number (Razorpay sends JSON integers) or a
 * canonical integer string (the JSON wire format for paise). Anything fractional is rejected.
 */
export function paise(value: bigint | number | string): Paise {
  if (typeof value === 'bigint') return assertInRange(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new MoneyError('NOT_INTEGER', 'paise must be a safe integer');
    }
    return assertInRange(BigInt(value));
  }
  if (!INTEGER_STRING.test(value)) {
    throw new MoneyError('INVALID_FORMAT', 'paise string must be a canonical integer');
  }
  return assertInRange(BigInt(value));
}

/** True for any bigint inside the paise range (the brand itself cannot be checked at runtime). */
export function isPaise(value: unknown): value is Paise {
  return typeof value === 'bigint' && value <= MAX_PAISE && value >= MIN_PAISE;
}

/** Exact sum, range-checked. Overflow throws rather than wrapping. */
export function add(a: Paise, b: Paise): Paise {
  return assertInRange(a + b);
}

/** Exact difference, range-checked. The result may be negative (a shortfall). */
export function sub(a: Paise, b: Paise): Paise {
  return assertInRange(a - b);
}

/**
 * Exact sum of many amounts. Intermediate totals are exact bigints; only the final total is
 * range-checked, so the result does not depend on the order of the inputs.
 */
export function sum(values: Iterable<Paise>): Paise {
  let total = 0n;
  for (const value of values) total += value;
  return assertInRange(total);
}
