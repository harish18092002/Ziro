import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GST_RATE_BPS,
  gstOnFee,
  MAX_PAISE,
  MoneyError,
  type MoneyErrorCode,
  paise,
  percentOfHalfUp,
} from './index.js';

interface FeeCase {
  readonly name: string;
  /** Payment amount in paise. */
  readonly amount: bigint;
  /** Razorpay's fee rate in basis points. */
  readonly feeBps: number;
  /** Hand-computed base fee: amount * feeBps / 10_000, half-up. */
  readonly fee: bigint;
  /** Hand-computed GST: fee * 18% (1800 bps), half-up. */
  readonly gst: bigint;
}

// Every expected value below was worked out by hand, not produced by the code under test.
const CASES: readonly FeeCase[] = [
  { name: '2% of Rs 1,000.00', amount: 100000n, feeBps: 200, fee: 2000n, gst: 360n },
  { name: 'fee tie 51.5 rounds up', amount: 2575n, feeBps: 200, fee: 52n, gst: 9n }, // 9.36 -> 9
  { name: 'fee 51.48 rounds down', amount: 2574n, feeBps: 200, fee: 51n, gst: 9n }, // 9.18 -> 9
  { name: '2% of Rs 100.00', amount: 10000n, feeBps: 200, fee: 200n, gst: 36n },
  { name: 'GST 0.36 rounds down to 0', amount: 100n, feeBps: 200, fee: 2n, gst: 0n },
  { name: 'fee 0.02 rounds to 0', amount: 1n, feeBps: 200, fee: 0n, gst: 0n },
  { name: 'fee 0.98 rounds up to 1', amount: 49n, feeBps: 200, fee: 1n, gst: 0n }, // 0.18 -> 0
  {
    name: 'Razorpay wallet sample: fee 5900 = 5000 + tax 900',
    amount: 250000n,
    feeBps: 200,
    fee: 5000n,
    gst: 900n,
  },
  {
    name: 'Razorpay netbanking sample: fee 50 = 42 + tax 8',
    amount: 2100n,
    feeBps: 200,
    fee: 42n,
    gst: 8n,
  }, // 7.56 -> 8
  {
    name: 'Razorpay UPI sample: fee 24 = 20 + tax 4',
    amount: 1000n,
    feeBps: 200,
    fee: 20n,
    gst: 4n,
  }, // 3.6 -> 4
  { name: 'fee 1999.98 rounds up to 2000', amount: 99999n, feeBps: 200, fee: 2000n, gst: 360n },
  { name: '1.99% rate', amount: 12345n, feeBps: 199, fee: 246n, gst: 44n }, // 245.6655 -> 246; 44.28 -> 44
  {
    name: 'Rs 1e13 payment, no float error',
    amount: 1_000_000_000_000_000n,
    feeBps: 200,
    fee: 20_000_000_000_000n,
    gst: 3_600_000_000_000n,
  },
  { name: '0.9% rate, fee 299.997 -> 300', amount: 33333n, feeBps: 90, fee: 300n, gst: 54n },
  { name: 'GST tie 4.5 rounds up to 5', amount: 1250n, feeBps: 200, fee: 25n, gst: 5n },
  { name: 'GST tie 13.5 rounds up to 14', amount: 3750n, feeBps: 200, fee: 75n, gst: 14n },
  { name: 'GST tie 22.5 rounds up to 23', amount: 6250n, feeBps: 200, fee: 125n, gst: 23n },
  { name: 'fee tie 12.5 -> 13; GST 2.34 -> 2', amount: 500n, feeBps: 250, fee: 13n, gst: 2n },
  { name: 'fee tie 1.5 -> 2; GST 0.36 -> 0', amount: 150n, feeBps: 100, fee: 2n, gst: 0n },
  { name: '50% rate, fee tie 49.5 -> 50; GST 9', amount: 99n, feeBps: 5000, fee: 50n, gst: 9n },
];

function codeOf(fn: () => unknown): MoneyErrorCode {
  try {
    fn();
  } catch (err) {
    if (err instanceof MoneyError) return err.code;
    throw err;
  }
  throw new Error('expected a MoneyError, nothing was thrown');
}

describe('fee + GST table', () => {
  it('has exactly 20 hand-computed cases', () => {
    expect(CASES).toHaveLength(20);
  });

  it.each(CASES)('$name', ({ amount, feeBps, fee, gst }) => {
    const computedFee = percentOfHalfUp(paise(amount), feeBps);
    expect(computedFee).toBe(fee);
    expect(gstOnFee(computedFee)).toBe(gst);
  });
});

describe('percentOfHalfUp()', () => {
  it('accepts bps as a bigint or a safe-integer number', () => {
    expect(percentOfHalfUp(paise(100000n), 200n)).toBe(2000n);
    expect(percentOfHalfUp(paise(100000n), 200)).toBe(2000n);
  });

  it('rounds exact ties up, never to even', () => {
    expect(percentOfHalfUp(paise(1n), 5000)).toBe(1n); // 0.5 -> 1
    expect(percentOfHalfUp(paise(3n), 5000)).toBe(2n); // 1.5 -> 2
    expect(percentOfHalfUp(paise(5n), 5000)).toBe(3n); // 2.5 -> 3 (banker's rounding would give 2)
  });

  it('is exact where a float would not be', () => {
    // 1.15% of Rs 10.00 is exactly 11.5 paise -> 12; a float would carry binary representation error.
    expect(percentOfHalfUp(paise(1000n), 115)).toBe(12n);
    expect(percentOfHalfUp(paise(MAX_PAISE / 10_000n), 10_000)).toBe(MAX_PAISE / 10_000n);
  });

  it('rejects negative amounts, negative or fractional bps', () => {
    expect(codeOf(() => percentOfHalfUp(paise(-1n), 200))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => percentOfHalfUp(paise(1n), -1))).toBe('INVALID_ARGUMENT');
    expect(codeOf(() => percentOfHalfUp(paise(1n), 1.5))).toBe('NOT_INTEGER');
    expect(codeOf(() => percentOfHalfUp(paise(1n), Number.NaN))).toBe('NOT_INTEGER');
  });

  it('throws instead of overflowing int64', () => {
    expect(codeOf(() => percentOfHalfUp(MAX_PAISE, 20_000))).toBe('OUT_OF_RANGE');
  });
});

describe('gstOnFee()', () => {
  it('defaults to 18%', () => {
    expect(GST_RATE_BPS).toBe(1800);
    expect(gstOnFee(paise(100n))).toBe(18n);
  });

  it('honours another rate, rounding half-up', () => {
    expect(gstOnFee(paise(100n), 500)).toBe(5n);
    expect(gstOnFee(paise(10n), 500)).toBe(1n); // 0.5 -> 1
  });
});

describe('fee properties', () => {
  // Keeps amount * bps comfortably inside what int64 can hold after division.
  const amount = fc.bigInt({ min: 0n, max: 2n ** 50n }).map((n) => paise(n));
  const bps = fc.integer({ min: 0, max: 100_000 });
  const rate = fc.integer({ min: 0, max: 10_000 });

  it('is never negative', () => {
    fc.assert(
      fc.property(amount, bps, (a, b) => {
        expect(percentOfHalfUp(a, b)).toBeGreaterThanOrEqual(0n);
      }),
      { numRuns: 1000 },
    );
  });

  it('GST on any fee is never negative and never exceeds the fee', () => {
    fc.assert(
      fc.property(amount, (fee) => {
        const gst = gstOnFee(fee);
        expect(gst).toBeGreaterThanOrEqual(0n);
        expect(gst).toBeLessThanOrEqual(fee);
      }),
      { numRuns: 1000, examples: [[paise(0n)], [paise(1n)], [paise(25n)]] },
    );
  });

  it('at most 100% never exceeds the amount', () => {
    fc.assert(
      fc.property(amount, rate, (a, r) => {
        expect(percentOfHalfUp(a, r)).toBeLessThanOrEqual(a);
      }),
      { numRuns: 1000 },
    );
  });

  it('matches an independently written half-up oracle', () => {
    fc.assert(
      fc.property(amount, bps, (a, b) => {
        // floor((2ab + 10_000) / 20_000) is round-half-up of ab / 10_000, written differently.
        expect(percentOfHalfUp(a, b)).toBe((2n * a * BigInt(b) + 10_000n) / 20_000n);
      }),
      { numRuns: 1000 },
    );
  });

  it('is within half a paisa of the exact value, ties going up', () => {
    fc.assert(
      fc.property(amount, bps, (a, b) => {
        const exactTimes10k = a * BigInt(b); // the exact result, scaled by 10_000
        const r = percentOfHalfUp(a, b);
        // r - 1/2 <= exact < r + 1/2 with ties (exact = r - 1/2) rounded up to r.
        expect(20_000n * r).toBeGreaterThan(2n * exactTimes10k - 10_000n);
        expect(20_000n * r).toBeLessThanOrEqual(2n * exactTimes10k + 10_000n);
      }),
      { numRuns: 1000 },
    );
  });

  it('is monotonic in the amount', () => {
    fc.assert(
      fc.property(amount, amount, bps, (a1, a2, b) => {
        const [lo, hi] = a1 <= a2 ? [a1, a2] : [a2, a1];
        expect(percentOfHalfUp(lo, b)).toBeLessThanOrEqual(percentOfHalfUp(hi, b));
      }),
      { numRuns: 1000 },
    );
  });

  it('is exact on whole-rupee multiples at whole-percent rates', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 100 }),
        (rupees, pct) => {
          expect(percentOfHalfUp(paise(rupees * 100n), pct * 100)).toBe(rupees * BigInt(pct));
        },
      ),
      { numRuns: 500 },
    );
  });
});
