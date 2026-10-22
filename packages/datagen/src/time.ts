// Calendar and IST arithmetic on plain integers: no Date, no Intl, no locale, no timezone database.
// India has a fixed UTC+05:30 offset and no DST, so every conversion is exact integer maths.
//
// This is deliberately independent of the future @ziro/core normalizer. The generator is the oracle
// the normalizer is evaluated against, so the two must not share a (possibly wrong) implementation.
// Tests cross-check these functions against Intl.

export const SECONDS_PER_DAY = 86_400;
export const IST_OFFSET_SECONDS = 19_800;

export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = floorDiv(y, 400);
  const yearOfEra = y - era * 400;
  const monthIndex = (month + 9) % 12; // March = 0
  const dayOfYear = floorDiv(153 * monthIndex + 2, 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

export interface Civil {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function civilFromDays(days: number): Civil {
  const z = days + 719_468;
  const era = floorDiv(z, 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = floorDiv(
    dayOfEra - floorDiv(dayOfEra, 1460) + floorDiv(dayOfEra, 36_524) - floorDiv(dayOfEra, 146_096),
    365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100));
  const monthIndex = floorDiv(5 * dayOfYear + 2, 153);
  const day = dayOfYear - floorDiv(153 * monthIndex + 2, 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * 400;
  return { year: month <= 2 ? year + 1 : year, month, day };
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` to a day number. Throws on malformed or impossible dates. */
export function parseIsoDay(text: string): number {
  const match = ISO_DATE.exec(text);
  if (!match) throw new RangeError(`not a YYYY-MM-DD date: ${text}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days = daysFromCivil(year, month, day);
  const back = civilFromDays(days);
  if (back.year !== year || back.month !== month || back.day !== day) {
    throw new RangeError(`not a real calendar date: ${text}`);
  }
  return days;
}

const two = (n: number): string => String(n).padStart(2, '0');

export function formatIsoDay(days: number): string {
  const { year, month, day } = civilFromDays(days);
  return `${String(year).padStart(4, '0')}-${two(month)}-${two(day)}`;
}

/** `DD<sep>MM<sep>YYYY`, the way Indian exports write dates. */
export function formatDmy(days: number, separator: string): string {
  const { year, month, day } = civilFromDays(days);
  return `${two(day)}${separator}${two(month)}${separator}${String(year).padStart(4, '0')}`;
}

/** 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday. */
export function weekday(days: number): number {
  return (((days + 4) % 7) + 7) % 7;
}

/** The IST calendar day (as a day number) that an epoch-seconds instant falls on. */
export function istDay(epochSeconds: number): number {
  return floorDiv(epochSeconds + IST_OFFSET_SECONDS, SECONDS_PER_DAY);
}

/** Seconds since IST midnight, 0..86399. */
export function istSecondOfDay(epochSeconds: number): number {
  const shifted = epochSeconds + IST_OFFSET_SECONDS;
  return shifted - floorDiv(shifted, SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

/** Epoch seconds for an IST day number plus a second-of-day (which may spill into later days). */
export function epochFromIst(day: number, secondOfDay: number): number {
  return day * SECONDS_PER_DAY + secondOfDay - IST_OFFSET_SECONDS;
}

/** Weekends and a set of fixed-date holidays are not bank business days. */
export class BusinessCalendar {
  private readonly fixed: ReadonlySet<string>;

  /** @param fixedHolidays `MM-DD` strings, applied every year. */
  constructor(fixedHolidays: readonly string[]) {
    this.fixed = new Set(fixedHolidays);
  }

  isBusinessDay(days: number): boolean {
    const dow = weekday(days);
    if (dow === 0 || dow === 6) return false;
    const { month, day } = civilFromDays(days);
    return !this.fixed.has(`${two(month)}-${two(day)}`);
  }

  /** `count` business days after `days` (count 0 returns the next business day on or after it). */
  addBusinessDays(days: number, count: number): number {
    let current = days;
    let remaining = count;
    while (remaining > 0) {
      current += 1;
      if (this.isBusinessDay(current)) remaining -= 1;
    }
    while (!this.isBusinessDay(current)) current += 1;
    return current;
  }
}
