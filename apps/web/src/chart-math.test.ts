import { describe, expect, it } from 'vitest';
import {
  compact,
  easeOutCubic,
  labelFits,
  ratio,
  scaleBig,
  segmentWeights,
  toBig,
} from './chart-math';

describe('toBig', () => {
  it('reads integer paise and is zero for anything else', () => {
    expect(toBig('12345650')).toBe(12345650n);
    expect(toBig('-47300')).toBe(-47300n);
    for (const bad of [null, undefined, '', '12.5', 'abc', '1e3']) expect(toBig(bad)).toBe(0n);
  });
});

describe('ratio', () => {
  it('is the share in ten-thousandths, worked out in integers', () => {
    expect(ratio(1n, 2n)).toBe(0.5);
    expect(ratio(475n, 500n)).toBe(0.95);
    expect(ratio(1n, 3n)).toBe(0.3333);
  });
  it('stays inside [0, 1] and is zero for an empty whole or part', () => {
    expect(ratio(5n, 0n)).toBe(0);
    expect(ratio(0n, 9n)).toBe(0);
    expect(ratio(-3n, 9n)).toBe(0);
    expect(ratio(9n, 3n)).toBe(1);
  });
  it('does not lose precision on amounts beyond a double', () => {
    const big = 9_007_199_254_740_993n * 1000n;
    expect(ratio(big / 4n, big)).toBe(0.25);
  });
});

describe('easeOutCubic and scaleBig', () => {
  it('starts at 0, ends at 1 and never overshoots', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
  it('counts up in whole units and lands exactly on the target', () => {
    expect(scaleBig(20_419_089n, 0)).toBe(0n);
    expect(scaleBig(20_419_089n, 1)).toBe(20_419_089n);
    expect(scaleBig(20_419_089n, 2)).toBe(20_419_089n);
    const half = scaleBig(20_419_089n, 0.5);
    expect(half > 10_000_000n && half < 10_500_000n).toBe(true);
    expect(scaleBig(-1000n, 1)).toBe(-1000n);
  });
});

describe('compact', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1284, '1,284'],
    [12_900, '12.9K'],
    [250_000, '250K'],
    [4_200_000, '4.2M'],
  ])('%s is %s', (n, shown) => {
    expect(compact(n)).toBe(shown);
  });
});

describe('segmentWeights', () => {
  it('shares a bar in proportion and keeps every non-empty segment visible', () => {
    expect(segmentWeights([475n, 25n, 0n])).toEqual([9500, 500, 0]);
    // Worked out in integers and floored to the ten-thousandth, so the big segment gives up a hair.
    expect(segmentWeights([1_000_000n, 1n])).toEqual([9999, 1]);
  });
  it('is all zeros for an empty bar', () => {
    expect(segmentWeights([0n, 0n])).toEqual([0, 0]);
    expect(segmentWeights([])).toEqual([]);
  });
});

describe('labelFits', () => {
  it('puts a label inside a segment only when it fits with padding', () => {
    expect(labelFits(0.5, 6)).toBe(true);
    expect(labelFits(0.05, 6)).toBe(false);
    expect(labelFits(0.2, 20)).toBe(false);
  });
});
