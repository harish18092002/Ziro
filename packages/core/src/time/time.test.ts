import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDaysToBusinessDate,
  instantFromEpoch,
  isBusinessDate,
  istBusinessDate,
  istDayBounds,
} from './index.js';

const ist = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const intlIstDate = (epoch: number): string => ist.format(new Date(epoch * 1000));
const intlInstant = (epoch: number): string =>
  new Date(epoch * 1000).toISOString().replace('.000Z', 'Z');

// 2100-01-01T00:00:00Z
const YEAR_2100 = 4_102_444_800;

describe('istBusinessDate', () => {
  it('agrees with Intl for any instant up to the year 2100', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: YEAR_2100 }), (epoch) => {
        expect(istBusinessDate(epoch)).toBe(intlIstDate(epoch));
      }),
      { numRuns: 5000, examples: [[0], [86_399], [86_400], [YEAR_2100], [951_782_399]] },
    );
  });

  it('turns over at 18:30 UTC, the IST midnight', () => {
    const utcMidnightPlus = (h: number, m: number, s: number): number =>
      Date.UTC(2026, 3, 1, h, m, s) / 1000; // 2026-04-01
    expect(istBusinessDate(utcMidnightPlus(18, 29, 59))).toBe('2026-04-01');
    expect(istBusinessDate(utcMidnightPlus(18, 30, 0))).toBe('2026-04-02');
    expect(istBusinessDate(utcMidnightPlus(0, 0, 0))).toBe('2026-04-01'); // 05:30 IST same day
  });

  it('handles leap days and year ends', () => {
    expect(istBusinessDate(Date.UTC(2024, 1, 29, 10, 0, 0) / 1000)).toBe('2024-02-29');
    expect(istBusinessDate(Date.UTC(2023, 1, 28, 19, 0, 0) / 1000)).toBe('2023-03-01');
    expect(istBusinessDate(Date.UTC(2100, 1, 28, 19, 0, 0) / 1000)).toBe('2100-03-01'); // 2100 is not leap
    expect(istBusinessDate(Date.UTC(2026, 11, 31, 19, 0, 0) / 1000)).toBe('2027-01-01');
  });

  it('rejects anything that is not a plausible Unix-seconds integer', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 253_402_300_800]) {
      expect(() => istBusinessDate(bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe('instantFromEpoch', () => {
  it('matches Date.toISOString for any instant up to 2100', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: YEAR_2100 }), (epoch) => {
        expect(instantFromEpoch(epoch)).toBe(intlInstant(epoch));
      }),
      { numRuns: 5000, examples: [[0], [59], [3599], [86_399]] },
    );
  });

  it('passes the shape check the domain uses (explicit Z offset, no fraction)', () => {
    expect(instantFromEpoch(1_760_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

describe('istDayBounds', () => {
  it('brackets exactly one IST day: first and last second', () => {
    for (const date of ['2026-04-01', '2024-02-29', '2026-12-31', '2027-01-01', '2100-03-01']) {
      const { fromEpoch, toEpoch } = istDayBounds(date);
      expect(toEpoch - fromEpoch).toBe(86_399);
      expect(istBusinessDate(fromEpoch), date).toBe(date);
      expect(istBusinessDate(toEpoch), date).toBe(date);
      expect(istBusinessDate(fromEpoch - 1), date).toBe(addDaysToBusinessDate(date, -1));
      expect(istBusinessDate(toEpoch + 1), date).toBe(addDaysToBusinessDate(date, 1));
    }
  });

  it('round-trips with istBusinessDate for random dates', () => {
    fc.assert(
      fc.property(fc.integer({ min: 100_000, max: YEAR_2100 }), (epoch) => {
        const date = istBusinessDate(epoch);
        const { fromEpoch, toEpoch } = istDayBounds(date);
        expect(epoch).toBeGreaterThanOrEqual(fromEpoch);
        expect(epoch).toBeLessThanOrEqual(toEpoch);
      }),
      { numRuns: 3000 },
    );
  });

  it('rejects impossible and out-of-range dates', () => {
    for (const bad of [
      '2026-02-30',
      '2023-02-29',
      '2026-13-01',
      '2026-00-10',
      '26-01-01',
      '1969-12-31',
      '1970-01-01',
      '',
    ]) {
      expect(() => istDayBounds(bad), bad).toThrow(RangeError);
    }
  });
});

describe('addDaysToBusinessDate / isBusinessDate', () => {
  it('moves across month, year and leap boundaries', () => {
    expect(addDaysToBusinessDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysToBusinessDate('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDaysToBusinessDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToBusinessDate('2026-04-01', -7)).toBe('2026-03-25');
    expect(addDaysToBusinessDate('2026-04-01', 0)).toBe('2026-04-01');
  });

  it('agrees with Date over a year of single-day steps', () => {
    let expected = Date.UTC(2026, 0, 1);
    let current = '2026-01-01';
    for (let i = 0; i < 800; i++) {
      expect(current).toBe(new Date(expected).toISOString().slice(0, 10));
      current = addDaysToBusinessDate(current, 1);
      expected += 86_400_000;
    }
  });

  it('validates', () => {
    expect(isBusinessDate('2026-02-28')).toBe(true);
    expect(isBusinessDate('2026-02-29')).toBe(false);
    expect(isBusinessDate('hello')).toBe(false);
    expect(() => addDaysToBusinessDate('2026-04-01', 1.5)).toThrow(RangeError);
  });
});
