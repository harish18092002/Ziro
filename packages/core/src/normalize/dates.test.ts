import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseBusinessDateCell } from './dates.js';

const ok = (input: string): string => {
  const parsed = parseBusinessDateCell(input);
  if (!parsed.ok) throw new Error(`expected ${input} to parse: ${parsed.reason}`);
  return parsed.value;
};
const reason = (input: string): string => {
  const parsed = parseBusinessDateCell(input);
  if (parsed.ok) throw new Error(`expected ${input} to be rejected, got ${parsed.value}`);
  return parsed.reason;
};

describe('parseBusinessDateCell: date-only spellings', () => {
  it.each([
    ['01-09-2026', '2026-09-01'],
    ['1-9-2026', '2026-09-01'],
    ['01/09/2026', '2026-09-01'],
    ['31/12/2026', '2026-12-31'],
    ['29-02-2028', '2028-02-29'], // leap day
    ['2026-09-01', '2026-09-01'],
    ['  01-09-2026  ', '2026-09-01'],
  ])('%s -> %s', (input, expected) => {
    expect(ok(input)).toBe(expected);
  });

  it.each([
    ['29-02-2026', /not a real calendar date/], // not a leap year
    ['31-04-2026', /not a real calendar date/],
    ['00-01-2026', /not a real calendar date/],
    ['09/13/2026', /not a real calendar date/], // month-first is never assumed
    ['1969-12-31', /not a real calendar date/],
    ['01-09-26', /not a recognised date/], // two-digit year
    ['01-09/2026', /not a recognised date/], // mixed separators
    ['01.09.2026', /not a recognised date/],
    ['2026-9-1', /not a recognised date/], // ISO must be zero-padded
    ['September 1, 2026', /not a recognised date/],
    ['', /is empty/],
    ['   ', /is empty/],
  ])('rejects %j', (input, why) => {
    expect(reason(input)).toMatch(why);
  });
});

describe('parseBusinessDateCell: time stamps become IST business dates', () => {
  it.each([
    ['2026-09-01T23:45:00+05:30', '2026-09-01'], // already IST
    ['2026-09-01T18:29:59Z', '2026-09-01'], // last second of the IST day
    ['2026-09-01T18:30:00Z', '2026-09-02'], // IST midnight
    ['2026-09-01 10:00:00 +0530', '2026-09-01'],
    ['2026-09-01T10:00:00-05:00', '2026-09-01'], // 15:00Z = 20:30 IST
    ['2026-09-01T20:00:00-05:00', '2026-09-02'], // 01:00Z next day = 06:30 IST
    ['2026-09-01T10:00:00.123Z', '2026-09-01'],
    ['2026-12-31T20:00:00Z', '2027-01-01'], // crosses a year end
    ['2026-09-01T10:00z', '2026-09-01'],
  ])('%s -> %s', (input, expected) => {
    expect(ok(input)).toBe(expected);
  });

  it.each([
    ['2026-09-01T10:00:00', /not a recognised date/], // no offset: would be a guess
    ['2026-09-01T24:00:00Z', /not a valid time/],
    ['2026-09-01T10:60:00Z', /not a valid time/],
    ['2026-09-01T10:00:60Z', /not a valid time/],
    ['2026-09-01T10:00:00+15:00', /not a valid time/],
    ['2026-02-30T10:00:00Z', /not a real calendar date/],
  ])('rejects %j', (input, why) => {
    expect(reason(input)).toMatch(why);
  });

  // Independent oracle: Intl, which knows nothing of this code.
  const intlIst = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  it('agrees with Intl for any instant written in UTC', () => {
    fc.assert(
      fc.property(fc.integer({ min: 86_400, max: 4_102_444_800 }), (epoch) => {
        const text = new Date(epoch * 1000).toISOString();
        expect(ok(text)).toBe(intlIst.format(new Date(epoch * 1000)));
      }),
      { numRuns: 2000 },
    );
  });

  it('agrees with Intl for any instant written in any offset', () => {
    const offsetMinutes = fc.integer({ min: -14 * 4, max: 14 * 4 }).map((q) => q * 15);
    fc.assert(
      fc.property(fc.integer({ min: 172_800, max: 4_102_444_800 }), offsetMinutes, (epoch, off) => {
        const local = new Date((epoch + off * 60) * 1000).toISOString().slice(0, 19);
        const sign = off < 0 ? '-' : '+';
        const abs = Math.abs(off);
        const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
        expect(ok(`${local}${zone}`)).toBe(intlIst.format(new Date(epoch * 1000)));
      }),
      { numRuns: 2000 },
    );
  });
});

describe('parseBusinessDateCell: calendar validity against the JS Date oracle', () => {
  it('accepts exactly the days that exist', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1970, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        (year, month, day) => {
          const exists = new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
          const text = `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
          const parsed = parseBusinessDateCell(text);
          expect(parsed.ok).toBe(exists);
          if (parsed.ok) {
            expect(parsed.value).toBe(
              `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
            );
          }
        },
      ),
      { numRuns: 3000 },
    );
  });
});
