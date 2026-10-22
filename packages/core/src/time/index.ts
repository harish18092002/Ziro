// Epoch seconds <-> IST calendar dates, in pure integer arithmetic. India is a fixed UTC+05:30 with
// no daylight saving, so no timezone database is needed.
//
// Razorpay timestamps are Unix seconds (UTC); the business date Ziro reconciles on is the IST
// calendar date. The two disagree for five and a half hours every day, which is exactly where
// TIMEZONE_DATE_SHIFT lives, so this must be exact.
//
// DELIBERATELY not the same algorithm as @ziro/datagen's generator: that one uses closed-form
// civil-date formulas, this one walks years and months. They are cross-checked against each other
// and against Intl in tests, so one shared mistake cannot make the generator and the parser agree
// on a wrong answer.

const SECONDS_PER_DAY = 86_400;
const IST_OFFSET_SECONDS = 19_800;
const FIRST_YEAR = 1970;
const LAST_YEAR = 9999;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInYear = (year: number): number => (isLeapYear(year) ? 366 : 365);

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : (MONTH_LENGTHS[month - 1] as number);
}

interface Civil {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Days since 1970-01-01 -> calendar date, by subtracting whole years then whole months. */
function civilFromDays(days: number): Civil {
  let year = FIRST_YEAR;
  let left = days;
  while (left >= daysInYear(year)) {
    left -= daysInYear(year);
    year += 1;
  }
  let month = 1;
  while (left >= daysInMonth(year, month)) {
    left -= daysInMonth(year, month);
    month += 1;
  }
  return { year, month, day: left + 1 };
}

/** Calendar date -> days since 1970-01-01, by adding whole years then whole months. */
function daysFromCivil({ year, month, day }: Civil): number {
  let days = 0;
  for (let y = FIRST_YEAR; y < year; y++) days += daysInYear(y);
  for (let m = 1; m < month; m++) days += daysInMonth(year, m);
  return days + (day - 1);
}

const two = (n: number): string => String(n).padStart(2, '0');
const isoDate = ({ year, month, day }: Civil): string =>
  `${String(year).padStart(4, '0')}-${two(month)}-${two(day)}`;

function assertEpoch(epochSeconds: number): void {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) {
    throw new RangeError('epoch seconds must be a non-negative integer');
  }
  if (epochSeconds >= daysFromCivil({ year: LAST_YEAR + 1, month: 1, day: 1 }) * SECONDS_PER_DAY) {
    throw new RangeError('epoch seconds is beyond the year 9999');
  }
}

/** The IST calendar date (`YYYY-MM-DD`) of a Unix-seconds instant: Ziro's business date. */
export function istBusinessDate(epochSeconds: number): string {
  assertEpoch(epochSeconds);
  const shifted = epochSeconds + IST_OFFSET_SECONDS;
  return isoDate(civilFromDays((shifted - (shifted % SECONDS_PER_DAY)) / SECONDS_PER_DAY));
}

/** A Unix-seconds instant as a UTC ISO-8601 timestamp, `YYYY-MM-DDTHH:MM:SSZ`. */
export function instantFromEpoch(epochSeconds: number): string {
  assertEpoch(epochSeconds);
  const secondOfDay = epochSeconds % SECONDS_PER_DAY;
  const date = isoDate(civilFromDays((epochSeconds - secondOfDay) / SECONDS_PER_DAY));
  const hours = (secondOfDay - (secondOfDay % 3600)) / 3600;
  const minutes = ((secondOfDay % 3600) - (secondOfDay % 60)) / 60;
  return `${date}T${two(hours)}:${two(minutes)}:${two(secondOfDay % 60)}Z`;
}

function parseBusinessDate(date: string): Civil {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (
    !match ||
    year < FIRST_YEAR ||
    year > LAST_YEAR ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new RangeError(`not a valid YYYY-MM-DD business date: ${date}`);
  }
  return { year, month, day };
}

/** The inclusive Unix-second bounds of one IST calendar day: its first and last second. */
export function istDayBounds(date: string): {
  readonly fromEpoch: number;
  readonly toEpoch: number;
} {
  const fromEpoch = daysFromCivil(parseBusinessDate(date)) * SECONDS_PER_DAY - IST_OFFSET_SECONDS;
  if (fromEpoch < 0) throw new RangeError(`${date} starts before the Unix epoch`);
  return { fromEpoch, toEpoch: fromEpoch + SECONDS_PER_DAY - 1 };
}

/** `date` moved by a whole number of days (negative goes back). */
export function addDaysToBusinessDate(date: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new RangeError('days must be an integer');
  const target = daysFromCivil(parseBusinessDate(date)) + days;
  if (target < 0) throw new RangeError('date would be before 1970-01-01');
  return isoDate(civilFromDays(target));
}

/** True for a real calendar date written `YYYY-MM-DD`. */
export function isBusinessDate(value: string): boolean {
  try {
    parseBusinessDate(value);
    return true;
  } catch {
    return false;
  }
}
