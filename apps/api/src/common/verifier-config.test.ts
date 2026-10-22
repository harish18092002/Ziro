import { DEFAULT_MATCHER_CONFIG } from '@ziro/core/matcher';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOWS,
  toVerifierConfig,
  verifierConfigOf,
  windowsSchema,
} from './verifier-config.js';

describe('the default windows', () => {
  it('are exactly the matcher defaults, so rules and verifier agree out of the box', () => {
    const config = toVerifierConfig(DEFAULT_WINDOWS);
    expect(config.windowBusinessDays).toBe(DEFAULT_MATCHER_CONFIG.windowBusinessDays);
    expect(config.settlementLagBusinessDays).toBe(DEFAULT_MATCHER_CONFIG.settlementLagBusinessDays);
    expect(config.delayHorizonBusinessDays).toBe(DEFAULT_MATCHER_CONFIG.delayHorizonBusinessDays);
    expect(config.dateShiftWindowMinutes).toBe(DEFAULT_MATCHER_CONFIG.dateShiftWindowMinutes);
    expect(config.retryReceiptPattern?.source).toBe(
      DEFAULT_MATCHER_CONFIG.retryReceiptPattern?.source,
    );
    expect([...config.calendar.weekendDays]).toEqual([
      ...DEFAULT_MATCHER_CONFIG.calendar.weekendDays,
    ]);
    expect(config.orderDateWindowDays).toBe(3);
  });

  it('survive a round trip through JSON, as they do in the run config', () => {
    const stored = JSON.parse(JSON.stringify(DEFAULT_WINDOWS)) as unknown;
    expect(windowsSchema.parse(stored)).toEqual(DEFAULT_WINDOWS);
  });
});

describe('verifierConfigOf', () => {
  it("uses the run's own windows when it carries them", () => {
    const windows = {
      ...DEFAULT_WINDOWS,
      windowBusinessDays: 5,
      holidays: ['2026-10-02'],
      retryReceiptPattern: null,
    };
    const out = verifierConfigOf({ windows });
    expect(out.source).toBe('run');
    expect(out.config.windowBusinessDays).toBe(5);
    expect(out.config.calendar.holidays.has('2026-10-02')).toBe(true);
    expect(out.config.retryReceiptPattern).toBeNull();
  });

  it('falls back to the defaults, and says so, for a run without a snapshot or with a damaged one', () => {
    for (const config of [
      {},
      null,
      { windows: { windowBusinessDays: 'three' } },
      { windows: { ...DEFAULT_WINDOWS, orderDateWindowDays: -1 } },
    ]) {
      const out = verifierConfigOf(config);
      expect(out.source).toBe('default');
      expect(out.windows).toEqual(DEFAULT_WINDOWS);
    }
  });

  it('refuses an invalid regular expression, an unknown key and out-of-range numbers', () => {
    expect(windowsSchema.safeParse({ ...DEFAULT_WINDOWS, retryReceiptPattern: '(' }).success).toBe(
      false,
    );
    expect(windowsSchema.safeParse({ ...DEFAULT_WINDOWS, extra: 1 }).success).toBe(false);
    expect(windowsSchema.safeParse({ ...DEFAULT_WINDOWS, weekendDays: [7] }).success).toBe(false);
    expect(windowsSchema.safeParse({ ...DEFAULT_WINDOWS, holidays: ['2026/10/02'] }).success).toBe(
      false,
    );
  });
});
