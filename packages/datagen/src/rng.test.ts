import { describe, expect, it } from 'vitest';
import { Rng } from './rng.js';

describe('Rng', () => {
  it('gives the same stream for the same seed, on every machine', () => {
    const a = Rng.fromSeed(42);
    const b = Rng.fromSeed(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('pins the first outputs for seed 42, so an accidental algorithm change is caught', () => {
    // Golden values. If this fails, every dataset ever generated has changed: that must be a
    // deliberate, versioned decision (bump GENERATOR_VERSION), never an accident.
    const rng = Rng.fromSeed(42);
    expect([rng.next(), rng.next(), rng.next(), rng.next(), rng.next()]).toEqual(GOLDEN_SEED_42);
  });

  it('gives different streams for different seeds', () => {
    const a = Rng.fromSeed(1);
    const b = Rng.fromSeed(2);
    const same = Array.from({ length: 50 }, () => a.next() === b.next()).filter(Boolean).length;
    expect(same).toBeLessThan(2);
  });

  it('rejects seeds that are not unsigned 32-bit integers', () => {
    for (const bad of [-1, 1.5, 2 ** 32, Number.NaN])
      expect(() => Rng.fromSeed(bad)).toThrow(RangeError);
    expect(() => Rng.fromSeed(0)).not.toThrow();
    expect(() => Rng.fromSeed(2 ** 32 - 1)).not.toThrow();
  });

  describe('int', () => {
    it('stays inside the inclusive range and reaches both ends', () => {
      const rng = Rng.fromSeed(7);
      const seen = new Set<number>();
      for (let i = 0; i < 5000; i++) {
        const n = rng.int(-3, 3);
        expect(n).toBeGreaterThanOrEqual(-3);
        expect(n).toBeLessThanOrEqual(3);
        seen.add(n);
      }
      expect([...seen].sort((x, y) => x - y)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    });

    it('is uniform to within sampling noise', () => {
      const rng = Rng.fromSeed(11);
      const counts = new Array<number>(10).fill(0);
      for (let i = 0; i < 100_000; i++) {
        const k = rng.int(0, 9);
        counts[k] = (counts[k] ?? 0) + 1;
      }
      for (const c of counts) {
        expect(c).toBeGreaterThan(9_000);
        expect(c).toBeLessThan(11_000);
      }
    });

    it('returns the only value of a one-value range, and rejects bad ranges', () => {
      const rng = Rng.fromSeed(1);
      expect(rng.int(5, 5)).toBe(5);
      expect(() => rng.int(3, 2)).toThrow(RangeError);
      expect(() => rng.int(0.5, 2)).toThrow(RangeError);
      expect(() => rng.int(0, 2 ** 33)).toThrow(RangeError);
    });
  });

  describe('fork', () => {
    it('depends on the label, not on how much the parent has been used', () => {
      const parent = Rng.fromSeed(5);
      const untouched = Rng.fromSeed(5);
      for (let i = 0; i < 123; i++) parent.next();
      expect(parent.fork('orders').next()).toBe(untouched.fork('orders').next());
    });

    it('gives each label its own stream', () => {
      const root = Rng.fromSeed(5);
      expect(root.fork('a').next()).not.toBe(root.fork('b').next());
      expect(root.fork('a').fork('x').next()).not.toBe(root.fork('a').fork('y').next());
    });
  });

  it('shuffles into a deterministic permutation of the same elements', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const a = Rng.fromSeed(9).shuffle([...items]);
    const b = Rng.fromSeed(9).shuffle([...items]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(items);
    expect(a).not.toEqual(items);
  });

  it('chance(bps) is never at 0 and always at 10000, and near half at 5000', () => {
    const rng = Rng.fromSeed(3);
    expect(Array.from({ length: 500 }, () => rng.chance(0)).some(Boolean)).toBe(false);
    expect(Array.from({ length: 500 }, () => rng.chance(10_000)).every(Boolean)).toBe(true);
    const half = Array.from({ length: 10_000 }, () => rng.chance(5000)).filter(Boolean).length;
    expect(half).toBeGreaterThan(4_700);
    expect(half).toBeLessThan(5_300);
  });

  it('weighted never picks a zero-weight item and rejects all-zero weights', () => {
    const rng = Rng.fromSeed(4);
    const picks = new Set(
      Array.from({ length: 500 }, () =>
        rng.weighted([
          { value: 'a', weight: 1 },
          { value: 'b', weight: 0 },
          { value: 'c', weight: 3 },
        ]),
      ),
    );
    expect(picks).toEqual(new Set(['a', 'c']));
    expect(() => rng.weighted([{ value: 'x', weight: 0 }])).toThrow(RangeError);
  });

  it('builds digit and alphabet strings of the requested length', () => {
    const rng = Rng.fromSeed(8);
    expect(rng.digits(12)).toMatch(/^\d{12}$/);
    expect(rng.string('ab', 20)).toMatch(/^[ab]{20}$/);
  });
});

const GOLDEN_SEED_42: number[] = [3906264042, 3148981386, 1001388498, 2778385631, 2018102812];
