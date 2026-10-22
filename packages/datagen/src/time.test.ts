import { describe, expect, it } from 'vitest';
import { addBusinessDaysIso, istOf } from './datagen.fixtures.js';
import { Rng } from './rng.js';
import {
  BusinessCalendar,
  civilFromDays,
  daysFromCivil,
  epochFromIst,
  formatDmy,
  formatIsoDay,
  istDay,
  istSecondOfDay,
  parseIsoDay,
  weekday,
} from './time.js';

const isoViaDate = (days: number): string => new Date(days * 86_400_000).toISOString().slice(0, 10);

describe('civil date maths', () => {
  it('agrees with Date for every day from 1970 to 2134', () => {
    for (let days = 0; days <= 60_000; days++) {
      expect(formatIsoDay(days), `day ${days}`).toBe(isoViaDate(days));
    }
  });

  it('round-trips through civil form, including leap days and dates before 1970', () => {
    for (let days = -40_000; days <= 80_000; days += 7) {
      const { year, month, day } = civilFromDays(days);
      expect(daysFromCivil(year, month, day)).toBe(days);
    }
    expect(formatIsoDay(parseIsoDay('2024-02-29'))).toBe('2024-02-29');
    expect(parseIsoDay('1970-01-01')).toBe(0);
  });

  it('rejects malformed and impossible dates', () => {
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2023-02-29',
      '26-01-01',
      '2026/01/01',
      '',
    ]) {
      expect(() => parseIsoDay(bad), bad).toThrow(RangeError);
    }
  });

  it('formats Indian-style day-month-year', () => {
    expect(formatDmy(parseIsoDay('2026-10-22'), '-')).toBe('22-10-2026');
    expect(formatDmy(parseIsoDay('2026-01-05'), '/')).toBe('05/01/2026');
  });

  it('knows the weekday', () => {
    for (let days = 0; days <= 60_000; days += 13) {
      expect(weekday(days), `day ${days}`).toBe(new Date(days * 86_400_000).getUTCDay());
    }
    expect(weekday(parseIsoDay('2026-10-22'))).toBe(4); // Thursday
  });
});

describe('IST conversion', () => {
  it('matches Intl for 20,000 random instants between 2020 and 2035', () => {
    const rng = Rng.fromSeed(2026);
    const from = 1_577_836_800; // 2020-01-01
    const to = 2_082_758_400; // 2036-01-01
    for (let i = 0; i < 20_000; i++) {
      const epoch = from + rng.int(0, to - from);
      const expected = istOf(epoch);
      expect(formatIsoDay(istDay(epoch)), `epoch ${epoch}`).toBe(expected.date);
      expect(istSecondOfDay(epoch), `epoch ${epoch}`).toBe(expected.secondOfDay);
    }
  });

  it('puts 18:30 UTC on the next IST day (the date-shift edge)', () => {
    const utc = Date.UTC(2026, 3, 1, 18, 30, 0) / 1000; // 2026-04-01 18:30:00Z = 2026-04-02 00:00 IST
    expect(formatIsoDay(istDay(utc))).toBe('2026-04-02');
    expect(istSecondOfDay(utc)).toBe(0);
    expect(formatIsoDay(istDay(utc - 1))).toBe('2026-04-01');
    expect(istSecondOfDay(utc - 1)).toBe(86_399);
  });

  it('inverts epochFromIst', () => {
    const day = parseIsoDay('2026-10-22');
    for (const second of [0, 1, 19_800, 43_200, 84_600, 86_399]) {
      const epoch = epochFromIst(day, second);
      expect(istDay(epoch)).toBe(day);
      expect(istSecondOfDay(epoch)).toBe(second);
    }
  });
});

describe('BusinessCalendar', () => {
  const cal = new BusinessCalendar(['05-01', '08-15']);
  const iso = (s: string): number => parseIsoDay(s);

  it('skips weekends: Friday + 2 business days is Tuesday', () => {
    expect(formatIsoDay(cal.addBusinessDays(iso('2026-04-03'), 2))).toBe('2026-04-07');
  });

  it('skips fixed holidays: Thursday 30 April + 1 is Monday 4 May, because 1 May is a holiday', () => {
    expect(formatIsoDay(cal.addBusinessDays(iso('2026-04-30'), 1))).toBe('2026-05-04');
  });

  it('counts zero as "the next business day on or after"', () => {
    expect(formatIsoDay(cal.addBusinessDays(iso('2026-04-04'), 0))).toBe('2026-04-06'); // Saturday -> Monday
    expect(formatIsoDay(cal.addBusinessDays(iso('2026-04-06'), 0))).toBe('2026-04-06');
  });

  it('agrees with an independent implementation over many start dates', () => {
    const holidays = ['05-01', '08-15'];
    for (let days = iso('2026-01-01'); days < iso('2027-01-01'); days++) {
      for (const count of [0, 1, 2, 5]) {
        expect(
          formatIsoDay(cal.addBusinessDays(days, count)),
          `${formatIsoDay(days)} +${count}`,
        ).toBe(addBusinessDaysIso(formatIsoDay(days), count, holidays));
      }
    }
  });
});
