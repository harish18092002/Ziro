import { epochFromUtc, isBusinessDate, istBusinessDate } from '../time/index.js';
import { accept, type Parsed, reject } from './result.js';

// Three date spellings are understood, each unambiguous on its own:
//   DD-MM-YYYY  and  DD/MM/YYYY  (Indian exports: day first, four-digit year)
//   YYYY-MM-DD                   (ISO)
// plus an ISO date-time WITH an explicit offset or Z, converted to the IST calendar date.
// Never MM/DD/YYYY, never a two-digit year, never a date-time with no offset: each of those would
// be a guess, and a wrong business date puts a payment in the wrong settlement window.

const DAY_FIRST = /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;

const two = (value: string): string => value.padStart(2, '0');

function checked(isoDate: string, original: string): Parsed<string> {
  return isBusinessDate(isoDate)
    ? accept(isoDate)
    : reject(`"${original}" is not a real calendar date (the year must be 1970 or later)`);
}

function offsetSeconds(text: string): number | null {
  if (text.toUpperCase() === 'Z') return 0;
  const digits = text.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
  if (hours > 14 || minutes > 59) return null;
  const magnitude = hours * 3600 + minutes * 60;
  return text.startsWith('-') ? -magnitude : magnitude;
}

function fromDateTime(match: RegExpExecArray, original: string): Parsed<string> {
  const [, date = '', hh = '', mm = '', ss = '0', zone = ''] = match;
  const hours = Number(hh);
  const minutes = Number(mm);
  const seconds = Number(ss);
  const offset = offsetSeconds(zone);
  if (hours > 23 || minutes > 59 || seconds > 59 || offset === null) {
    return reject(`"${original}" is not a valid time or UTC offset`);
  }
  const day = checked(date, original);
  if (!day.ok) return day;
  try {
    return accept(
      istBusinessDate(epochFromUtc(date, hours * 3600 + minutes * 60 + seconds) - offset),
    );
  } catch {
    return reject(`"${original}" is outside the supported date range`);
  }
}

/** A date cell as an IST business date `YYYY-MM-DD`, or the reason it was not accepted. */
export function parseBusinessDateCell(input: string): Parsed<string> {
  const cell = input.trim();
  if (cell === '') return reject('is empty');

  const dayFirst = DAY_FIRST.exec(cell);
  if (dayFirst) {
    const [, day = '', , month = '', year = ''] = dayFirst;
    return checked(`${year}-${two(month)}-${two(day)}`, cell);
  }
  const iso = ISO_DATE.exec(cell);
  if (iso) return checked(cell, cell);

  const dateTime = ISO_DATETIME.exec(cell);
  if (dateTime) return fromDateTime(dateTime, cell);

  return reject(
    `"${cell}" is not a recognised date (use DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, or an ISO time with an offset)`,
  );
}
