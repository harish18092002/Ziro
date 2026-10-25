import { describe, expect, it } from 'vitest';
import { nextPacificMidnightMs, pacificDate, pacificOffsetMs } from './pacific.js';

const at = (iso: string): number => Date.parse(iso);
const HOUR = 3_600_000;

describe('pacificDate', () => {
  it('changes at 07:00 UTC in summer (PDT, UTC-7)', () => {
    expect(pacificDate(at('2026-07-01T06:59:59Z'))).toBe('2026-06-30');
    expect(pacificDate(at('2026-07-01T07:00:00Z'))).toBe('2026-07-01');
  });

  it('changes at 08:00 UTC in winter (PST, UTC-8)', () => {
    expect(pacificDate(at('2026-12-01T07:59:59Z'))).toBe('2026-11-30');
    expect(pacificDate(at('2026-12-01T08:00:00Z'))).toBe('2026-12-01');
  });

  it('is not the UTC date: late evening in Los Angeles is already tomorrow in UTC', () => {
    expect(pacificDate(at('2026-10-25T23:30:00Z'))).toBe('2026-10-25');
    expect(pacificDate(at('2026-10-26T05:00:00Z'))).toBe('2026-10-25');
  });
});

describe('pacificOffsetMs', () => {
  it('reads the offset from the zone data', () => {
    expect(pacificOffsetMs(at('2026-07-01T12:00:00Z'))).toBe(-7 * HOUR);
    expect(pacificOffsetMs(at('2026-12-01T12:00:00Z'))).toBe(-8 * HOUR);
  });
});

describe('nextPacificMidnightMs', () => {
  it('is 07:00 UTC the next day in summer and 08:00 UTC in winter', () => {
    expect(nextPacificMidnightMs(at('2026-07-01T12:00:00Z'))).toBe(at('2026-07-02T07:00:00Z'));
    expect(nextPacificMidnightMs(at('2026-12-01T12:00:00Z'))).toBe(at('2026-12-02T08:00:00Z'));
  });

  it('is strictly after the instant, also one second before midnight', () => {
    const now = at('2026-07-01T06:59:59Z');
    expect(nextPacificMidnightMs(now)).toBe(at('2026-07-01T07:00:00Z'));
    expect(nextPacificMidnightMs(at('2026-07-01T07:00:00Z'))).toBe(at('2026-07-02T07:00:00Z'));
  });

  it('is the date change, to the second, on every day of a year (including both clock changes)', () => {
    for (let day = 0; day < 366; day += 1) {
      const now = at('2026-01-01T12:00:00Z') + day * 86_400_000;
      const reset = nextPacificMidnightMs(now);
      expect(reset).toBeGreaterThan(now);
      expect(pacificDate(reset)).not.toBe(pacificDate(reset - 1000));
      expect(pacificDate(reset - 1000)).toBe(pacificDate(now));
    }
  });

  it('makes the day after the clocks go back 25 hours long (2026-11-01)', () => {
    const start = at('2026-11-01T07:00:00Z'); // 00:00 PDT
    expect(pacificDate(start)).toBe('2026-11-01');
    expect(nextPacificMidnightMs(start) - start).toBe(25 * HOUR);
  });

  it('makes the day the clocks go forward 23 hours long (2026-03-08)', () => {
    const start = at('2026-03-08T08:00:00Z'); // 00:00 PST
    expect(pacificDate(start)).toBe('2026-03-08');
    expect(nextPacificMidnightMs(start) - start).toBe(23 * HOUR);
  });
});
