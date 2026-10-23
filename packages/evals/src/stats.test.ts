import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mean, percentile, ratio, summarize } from './stats.js';

describe('summarize', () => {
  it('gives mean and min-max, and null (never zero) for no data', () => {
    expect(summarize([2, 4, 9])).toEqual({ n: 3, mean: 5, min: 2, max: 9 });
    expect(summarize([7])).toEqual({ n: 1, mean: 7, min: 7, max: 7 });
    expect(summarize([])).toBeNull();
    expect(mean([])).toBeNaN();
  });

  it('keeps the mean between the extremes (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 50 }),
        (xs) => {
          const s = summarize(xs);
          expect(s).not.toBeNull();
          expect(s!.min).toBeLessThanOrEqual(s!.mean + 1e-6);
          expect(s!.mean).toBeLessThanOrEqual(s!.max + 1e-6);
        },
      ),
    );
  });
});

describe('percentile (nearest rank)', () => {
  const ten = [15, 20, 35, 40, 50, 55, 60, 70, 80, 100];

  it.each([
    [0, 15],
    [10, 15],
    [25, 35],
    [50, 50],
    [90, 80],
    [95, 100],
    [100, 100],
  ])('p%i of ten values is %i', (p, expected) => {
    expect(percentile(ten, p)).toBe(expected);
  });

  it('does not depend on the order of the data, and is always a value that was there', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 100 }),
        (xs, p) => {
          const v = percentile(xs, p);
          expect(xs).toContain(v);
          expect(percentile([...xs].reverse(), p)).toBe(v);
        },
      ),
    );
  });

  it('is monotonic in p, and rejects a p outside 0 to 100', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 40 }),
        (xs) => {
          expect(percentile(xs, 50)).toBeLessThanOrEqual(percentile(xs, 95));
        },
      ),
    );
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => percentile([1], -1)).toThrow(RangeError);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe('ratio', () => {
  it('is null, not NaN or Infinity, when there is nothing to divide by', () => {
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(3, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
  });
});
