import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  costMicroUsd,
  formatMicroUsd,
  parseMicroUsd,
  PRICED_PROMPT_LIMIT,
  PricingError,
  ratesFor,
} from './pricing.js';

const usage = {
  inputTokens: 10_000,
  outputTokens: 2_000,
  cacheReadTokens: 20_000,
  cacheWriteTokens: 5_000,
};

describe('costMicroUsd', () => {
  // Hand-computed, in micro-USD per million tokens:
  //  Haiku 5.5:  10,000 x 100,000 + 2,000 x 500,000 + 5,000 x 125,000 + 20,000 x 10,000
  //            = 1.0e9 + 1.0e9 + 6.25e8 + 2.0e8 = 2.825e9  ->  2,825 micro-USD = $0.002825
  it('prices a Haiku 5.5 call exactly', () => {
    expect(costMicroUsd('claude-haiku-5-5', usage)).toBe(2_825n);
  });

  //  Sonnet 5.5: 10,000 x 2e6 + 2,000 x 1e7 + 5,000 x 2.5e6 + 20,000 x 1e5
  //            = 2e10 + 2e10 + 1.25e10 + 2e9 = 5.45e10  ->  54,500 micro-USD = $0.0545
  it('prices a Sonnet 5.5 call exactly', () => {
    expect(costMicroUsd('claude-sonnet-5-5', usage)).toBe(54_500n);
  });

  it('rounds a fraction of a micro-dollar up, never down', () => {
    // 1 input token on Haiku is 0.1 micro-USD.
    expect(
      costMicroUsd('claude-haiku-5-5', {
        ...usage,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(1n);
    expect(
      costMicroUsd('claude-haiku-5-5', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0n);
  });

  it('prices a dated snapshot like its model, and refuses an unknown or lookalike one', () => {
    expect(costMicroUsd('claude-haiku-5-5-20261001', usage)).toBe(2_825n);
    expect(ratesFor('claude-haiku-5-50')).toBeUndefined();
    expect(() => costMicroUsd('claude-mystery-9', usage)).toThrow(PricingError);
    expect(() => costMicroUsd('', usage)).toThrow(PricingError);
  });

  it('refuses a prompt above the tier it can price, counting cached tokens', () => {
    const at = {
      inputTokens: 40_000,
      outputTokens: 0,
      cacheReadTokens: 40_000,
      cacheWriteTokens: 20_000,
    };
    expect(PRICED_PROMPT_LIMIT).toBe(100_000);
    expect(() => costMicroUsd('claude-haiku-5-5', at)).not.toThrow();
    expect(() => costMicroUsd('claude-haiku-5-5', { ...at, inputTokens: 40_001 })).toThrow(/tier/);
  });

  it('is monotonic in every token count', () => {
    fc.assert(
      fc.property(
        fc.record({
          inputTokens: fc.integer({ min: 0, max: 20_000 }),
          outputTokens: fc.integer({ min: 0, max: 20_000 }),
          cacheReadTokens: fc.integer({ min: 0, max: 20_000 }),
          cacheWriteTokens: fc.integer({ min: 0, max: 20_000 }),
        }),
        fc.constantFrom('inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'),
        fc.integer({ min: 1, max: 1_000 }),
        (base, field, extra) => {
          const more = { ...base, [field]: base[field] + extra };
          expect(costMicroUsd('claude-sonnet-5-5', more)).toBeGreaterThanOrEqual(
            costMicroUsd('claude-sonnet-5-5', base),
          );
        },
      ),
    );
  });
});

describe('formatMicroUsd / parseMicroUsd', () => {
  it('writes the six decimals numeric(12,6) holds', () => {
    expect(formatMicroUsd(2_825n)).toBe('0.002825');
    expect(formatMicroUsd(0n)).toBe('0.000000');
    expect(formatMicroUsd(1_000_000n)).toBe('1.000000');
    expect(formatMicroUsd(12_345_678n)).toBe('12.345678');
  });

  it('round-trips, and reads what Postgres returns for the column', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 999_999_999_999n }), (n) => {
        expect(parseMicroUsd(formatMicroUsd(n))).toBe(n);
      }),
    );
    expect(parseMicroUsd('4.2')).toBe(4_200_000n);
    expect(parseMicroUsd('0')).toBe(0n);
  });

  it('rejects negatives and rubbish', () => {
    expect(() => formatMicroUsd(-1n)).toThrow(PricingError);
    for (const bad of ['', '-1', '1.2345678', 'abc', '1,5'])
      expect(() => parseMicroUsd(bad)).toThrow(PricingError);
  });
});
