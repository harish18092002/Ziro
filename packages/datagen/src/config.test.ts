import { describe, expect, it } from 'vitest';
import { countFor, PRESET_NAMES, PRESETS, resolveConfig, validateConfig } from './config.js';

describe('countFor', () => {
  it('rounds a basis-point share half-up, exactly', () => {
    const cases: [number, number, number][] = [
      [200, 500, 10],
      [300, 500, 15],
      [100, 500, 5],
      [50, 50, 0], // 0.25 -> 0
      [100, 50, 1], // 0.5 -> 1 (half up)
      [150, 50, 1], // 0.75 -> 1
      [250, 50, 1], // 1.25 -> 1
      [350, 50, 2], // 1.75 -> 2
      [0, 12345, 0],
      [10_000, 77, 77],
      [75, 100_000, 750],
    ];
    for (const [bps, pool, expected] of cases)
      expect(countFor(bps, pool), `${bps} bps of ${pool}`).toBe(expected);
  });
});

describe('presets', () => {
  it('has the three presets at the specified sizes', () => {
    expect([...PRESET_NAMES]).toEqual(['demo', 'eval', 'stress']);
    expect(PRESETS.demo.orders).toBe(50);
    expect(PRESETS.eval.orders).toBe(500);
    expect(PRESETS.stress.orders).toBe(100_000);
  });

  it('gives stress roughly 100k bank lines: settlements plus noise', () => {
    const stress = PRESETS.stress;
    expect(stress.bank.noiseLines).toBeGreaterThan(95_000);
    expect(stress.bank.noiseLines).toBeLessThan(105_000);
  });

  it.each(PRESET_NAMES)('%s resolves and validates', (preset) => {
    const config = resolveConfig(42, preset);
    expect(config.seed).toBe(42);
    expect(config.preset).toBe(preset);
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('applies overrides without mutating the preset', () => {
    const before = JSON.stringify(PRESETS.eval.rates);
    const config = resolveConfig(1, 'eval', {
      orders: 200,
      rates: { FULL_REFUND: 100 },
      bank: { noiseLines: 5 },
    });
    expect(config.orders).toBe(200);
    expect(config.rates.FULL_REFUND).toBe(100);
    expect(config.rates.PARTIAL_REFUND_NETTED).toBe(PRESETS.eval.rates.PARTIAL_REFUND_NETTED);
    expect(config.bank.noiseLines).toBe(5);
    expect(config.bank.decoyBps).toBe(PRESETS.eval.bank.decoyBps);
    expect(JSON.stringify(PRESETS.eval.rates)).toBe(before);
  });

  it('boosts demo so every order-level anomaly appears at least once', () => {
    const { rates, orders } = PRESETS.demo;
    for (const [code, bps] of Object.entries(rates) as [string, number][]) {
      if (code === 'SETTLEMENT_DELAYED' || code === 'UTR_MISSING_OR_GARBLED') continue;
      expect(countFor(bps, orders), code).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps eval counts large enough to measure (at least 5 of each)', () => {
    const { rates, orders } = PRESETS.eval;
    for (const [code, bps] of Object.entries(rates) as [string, number][]) {
      if (code === 'SETTLEMENT_DELAYED' || code === 'UTR_MISSING_OR_GARBLED') continue;
      expect(countFor(bps, orders), code).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('validateConfig', () => {
  const bad = (override: Parameters<typeof resolveConfig>[2], match: RegExp) =>
    expect(() => resolveConfig(1, 'eval', override)).toThrow(match);

  it('rejects impossible settings with a clear message', () => {
    bad({ orders: 0 }, /orders/);
    bad({ days: 10, tailDays: 12 }, /tailDays/);
    bad({ startDate: '2026-02-30' }, /calendar date/);
    bad({ rates: { FULL_REFUND: 10_001 } }, /FULL_REFUND/);
    bad({ failedAttemptBps: -1 }, /bps/);
  });

  it('rejects anomaly rates that need more orders than exist', () => {
    bad({ orders: 10, rates: { FULL_REFUND: 6000, PARTIAL_REFUND_NETTED: 6000 } }, /only 10 exist/);
  });

  it('rejects a bad seed', () => {
    for (const seed of [-1, 1.5, 2 ** 32])
      expect(() => resolveConfig(seed, 'demo')).toThrow(/seed/);
  });
});
