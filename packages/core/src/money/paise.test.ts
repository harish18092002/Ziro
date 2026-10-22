import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  add,
  isPaise,
  MAX_PAISE,
  MIN_PAISE,
  MoneyError,
  type MoneyErrorCode,
  paise,
  sub,
  sum,
  ZERO,
} from './index.js';

function codeOf(fn: () => unknown): MoneyErrorCode {
  try {
    fn();
  } catch (err) {
    if (err instanceof MoneyError) return err.code;
    throw err;
  }
  throw new Error('expected a MoneyError, nothing was thrown');
}

// Three operands of this size still fit int64, so associativity is not defeated by the range check.
const OPERAND = 2n ** 61n;
const operand = fc.bigInt({ min: -OPERAND, max: OPERAND }).map((n) => paise(n));
// Up to 100 of these sum to well under int64.
const small = fc.bigInt({ min: -(2n ** 40n), max: 2n ** 40n }).map((n) => paise(n));

describe('paise()', () => {
  it('accepts bigints, safe-integer numbers and canonical integer strings', () => {
    expect(paise(12345650n)).toBe(12345650n);
    expect(paise(12345650)).toBe(12345650n);
    expect(paise('12345650')).toBe(12345650n);
    expect(paise('-5')).toBe(-5n);
    expect(paise('0')).toBe(0n);
  });

  it('keeps full precision beyond 2^53 for bigints and strings', () => {
    expect(paise(9007199254740993n)).toBe(9007199254740993n);
    expect(paise('9007199254740993')).toBe(9007199254740993n);
  });

  it('defines the int64 range, symmetric around zero', () => {
    expect(MAX_PAISE).toBe(2n ** 63n - 1n);
    expect(MIN_PAISE).toBe(-(2n ** 63n - 1n));
    expect(ZERO).toBe(0n);
    expect(paise(MAX_PAISE)).toBe(MAX_PAISE);
    expect(paise(MIN_PAISE)).toBe(MIN_PAISE);
  });

  it('rejects non-integers and unsafe numbers', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53)]) {
      expect(
        codeOf(() => paise(bad)),
        String(bad),
      ).toBe('NOT_INTEGER');
    }
  });

  it('rejects non-canonical integer strings', () => {
    for (const bad of ['', ' 1', '1 ', '1.5', '01', '+1', '1e3', '0x10', '1,000', '-', 'abc']) {
      expect(
        codeOf(() => paise(bad)),
        JSON.stringify(bad),
      ).toBe('INVALID_FORMAT');
    }
  });

  it('rejects values outside int64', () => {
    expect(codeOf(() => paise(MAX_PAISE + 1n))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => paise(MIN_PAISE - 1n))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => paise('9223372036854775808'))).toBe('OUT_OF_RANGE');
  });
});

describe('isPaise()', () => {
  it('is true only for bigints in range', () => {
    expect(isPaise(0n)).toBe(true);
    expect(isPaise(MAX_PAISE)).toBe(true);
    expect(isPaise(MAX_PAISE + 1n)).toBe(false);
    expect(isPaise(5)).toBe(false);
    expect(isPaise('5')).toBe(false);
    expect(isPaise(undefined)).toBe(false);
  });
});

describe('add / sub / sum', () => {
  it('computes exact values', () => {
    expect(add(paise(150n), paise(250n))).toBe(400n);
    expect(sub(paise(150n), paise(250n))).toBe(-100n);
    expect(sum([paise(1n), paise(2n), paise(3n)])).toBe(6n);
    expect(sum([])).toBe(ZERO);
  });

  it('throws on overflow instead of wrapping', () => {
    expect(codeOf(() => add(MAX_PAISE, paise(1n)))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => sub(MIN_PAISE, paise(1n)))).toBe('OUT_OF_RANGE');
    expect(codeOf(() => sum([MAX_PAISE, paise(1n)]))).toBe('OUT_OF_RANGE');
  });

  it('range-checks only the final total of a sum, so order never matters at the edges', () => {
    expect(sum([MAX_PAISE, paise(1n), paise(-1n)])).toBe(MAX_PAISE);
    expect(sum([paise(1n), paise(-1n), MAX_PAISE])).toBe(MAX_PAISE);
  });

  describe('properties', () => {
    it('add is associative', () => {
      fc.assert(
        fc.property(operand, operand, operand, (a, b, c) => {
          expect(add(add(a, b), c)).toBe(add(a, add(b, c)));
        }),
        { numRuns: 500 },
      );
    });

    it('add is commutative and ZERO is the identity', () => {
      fc.assert(
        fc.property(operand, operand, (a, b) => {
          expect(add(a, b)).toBe(add(b, a));
          expect(add(a, ZERO)).toBe(a);
        }),
        { numRuns: 500 },
      );
    });

    it('sub undoes add', () => {
      fc.assert(
        fc.property(operand, operand, (a, b) => {
          expect(sub(add(a, b), b)).toBe(a);
          expect(sub(a, a)).toBe(ZERO);
        }),
        { numRuns: 500 },
      );
    });

    it('sum is a fold of add', () => {
      fc.assert(
        fc.property(fc.array(small, { maxLength: 100 }), (xs) => {
          expect(sum(xs)).toBe(xs.reduce(add, ZERO));
        }),
        { numRuns: 300 },
      );
    });

    it('sum is independent of order', () => {
      fc.assert(
        fc.property(
          fc
            .array(small, { maxLength: 60 })
            .chain((xs) =>
              fc.tuple(
                fc.constant(xs),
                fc.shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length }),
              ),
            ),
          ([xs, shuffled]) => {
            expect(sum(shuffled)).toBe(sum(xs));
          },
        ),
        { numRuns: 300 },
      );
    });

    it('sum splits over concatenation', () => {
      fc.assert(
        fc.property(
          fc.array(small, { maxLength: 50 }),
          fc.array(small, { maxLength: 50 }),
          (xs, ys) => {
            expect(sum([...xs, ...ys])).toBe(add(sum(xs), sum(ys)));
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});
