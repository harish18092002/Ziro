import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatRupees, MAX_PAISE, MIN_PAISE, MoneyError, paise, parseRupees } from './index.js';

const ACCEPTED: readonly (readonly [string, bigint])[] = [
  ['0', 0n],
  ['0.5', 50n],
  ['0.05', 5n],
  ['0.50', 50n],
  ['1', 100n],
  ['123456.5', 12345650n],
  ['1,23,456.50', 12345650n],
  ['1,234', 123400n],
  ['12,345.67', 1234567n],
  ['1,00,00,000', 1_000_000_000n],
  ['99,99,99,999.99', 99_999_999_999n], // 99 crore + 99 lakh + 99 thousand + 999 = 999,999,999 rupees
  ['92233720368547758.07', 9_223_372_036_854_775_807n],
];

const REJECTED: readonly string[] = [
  '',
  ' 1',
  '1 ',
  '₹1',
  'Rs. 1',
  'INR 1',
  '1.234',
  '1.',
  '.5',
  '-1',
  '+1',
  '1e3',
  '0x10',
  '1_000',
  '1,2,3',
  '123,456', // Western grouping
  '1,234,567', // Western grouping
  '12,34',
  '1,23,45',
  '1,,234',
  '01',
  '00.50',
  '1.2.3',
  '٣', // Arabic-Indic digit
  '１２', // fullwidth digits
  'NaN',
  'Infinity',
  '92233720368547758.08', // one paisa over int64
  '1'.repeat(65),
];

function failsWithMoneyError(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    if (err instanceof MoneyError) return true;
    throw err;
  }
}

const anyPaise = fc.bigInt({ min: MIN_PAISE, max: MAX_PAISE }).map((n) => paise(n));
const nonNegativePaise = fc.bigInt({ min: 0n, max: MAX_PAISE }).map((n) => paise(n));

describe('parseRupees()', () => {
  it.each(ACCEPTED)('parses %j to %s paise', (input, expected) => {
    expect(parseRupees(input)).toBe(expected);
  });

  it.each(REJECTED)('rejects %j', (input) => {
    expect(failsWithMoneyError(() => parseRupees(input))).toBe(true);
  });

  it('rejects non-strings', () => {
    expect(failsWithMoneyError(() => parseRupees(12 as unknown as string))).toBe(true);
  });

  describe('with allowNegative', () => {
    const options = { allowNegative: true };

    it('accepts one leading minus', () => {
      expect(parseRupees('-1,23,456.50', options)).toBe(-12345650n);
      expect(parseRupees('-0.01', options)).toBe(-1n);
    });

    it('still rejects junk, double signs and negative zero', () => {
      for (const bad of ['-', '--1', '-0', '-0.00', '- 1', '-1.234', '+1']) {
        expect(
          failsWithMoneyError(() => parseRupees(bad, options)),
          bad,
        ).toBe(true);
      }
    });
  });
});

describe('formatRupees()', () => {
  const CASES: readonly (readonly [bigint, string])[] = [
    [0n, '0.00'],
    [5n, '0.05'],
    [50n, '0.50'],
    [100n, '1.00'],
    [123456n, '1,234.56'],
    [12345650n, '1,23,456.50'],
    [1_000_000_000n, '1,00,00,000.00'],
    [-5n, '-0.05'],
    [-12345650n, '-1,23,456.50'],
    [9_223_372_036_854_775_807n, '92,23,37,20,36,85,47,758.07'],
    [-9_223_372_036_854_775_807n, '-92,23,37,20,36,85,47,758.07'],
  ];

  it.each(CASES)('formats %s paise as %j', (value, expected) => {
    expect(formatRupees(paise(value))).toBe(expected);
  });

  it('adds the rupee sign on request, after any minus', () => {
    expect(formatRupees(paise(12345650n), { symbol: true })).toBe('₹1,23,456.50');
    expect(formatRupees(paise(-500n), { symbol: true })).toBe('-₹5.00');
  });
});

describe('rupees properties', () => {
  it('parse(format(p)) === p over the whole int64 range', () => {
    fc.assert(
      fc.property(anyPaise, (p) => {
        expect(parseRupees(formatRupees(p), { allowNegative: true })).toBe(p);
      }),
      {
        numRuns: 1000,
        examples: [[MAX_PAISE], [MIN_PAISE], [paise(0n)], [paise(1n)], [paise(-1n)]],
      },
    );
  });

  it('format digits equal an independent plain-digit rendering', () => {
    fc.assert(
      fc.property(anyPaise, (p) => {
        const magnitude: bigint = p < 0n ? 0n - p : p;
        const plain = `${p < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n)
          .toString()
          .padStart(2, '0')}`;
        expect(formatRupees(p).replaceAll(',', '')).toBe(plain);
      }),
      { numRuns: 500 },
    );
  });

  it('parses a plain-digit rendering without relying on format', () => {
    fc.assert(
      fc.property(nonNegativePaise, (p) => {
        const plain = `${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;
        expect(parseRupees(plain)).toBe(p);
      }),
      { numRuns: 500 },
    );
  });

  it('a single decimal digit means tenths of a rupee, never hundredths', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.integer({ min: 0, max: 9 }),
        (r, d) => {
          expect(parseRupees(`${r}.${d}`)).toBe(r * 100n + BigInt(d) * 10n);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('format always produces valid Indian grouping', () => {
    fc.assert(
      fc.property(nonNegativePaise, (p) => {
        expect(formatRupees(p)).toMatch(/^(?:\d{1,3}|[1-9]\d?(?:,\d{2})*,\d{3})\.\d{2}$/);
      }),
      { numRuns: 500 },
    );
  });

  it('junk either throws MoneyError or parses to a value that survives a format round trip', () => {
    const alphabet = [...'0123456789,.-+ ₹Rs'];
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...alphabet), maxLength: 24 }), (input) => {
        let parsed;
        try {
          parsed = parseRupees(input, { allowNegative: true });
        } catch (err) {
          expect(err).toBeInstanceOf(MoneyError);
          return;
        }
        expect(parseRupees(formatRupees(parsed), { allowNegative: true })).toBe(parsed);
      }),
      { numRuns: 2000 },
    );
  });
});
