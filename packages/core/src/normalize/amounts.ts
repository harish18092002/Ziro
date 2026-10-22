import { MoneyError, type Paise, parseRupees } from '../money/index.js';
import { accept, type Parsed, reject } from './result.js';

// A currency symbol, "Rs.", a trailing "Dr"/"Cr" or Western grouping is not guessed at: the cell is
// rejected with a reason, so the file can be fixed rather than silently misread (CLAUDE.md §4.3).

function whyNotRupees(cell: string, allowNegative: boolean): string {
  if (cell.startsWith('-') && !allowNegative)
    return `"${cell}" is negative; amounts are unsigned here`;
  if (/[^\d,.-]/.test(cell)) {
    return `"${cell}" contains something other than digits, commas and a decimal point (no currency symbols or text)`;
  }
  if (/\.\d{3,}/.test(cell)) return `"${cell}" has more than 2 decimal places`;
  if (cell.includes(',')) {
    return `"${cell}" is not valid Indian digit grouping (use 1,23,456.50 or 123456.50)`;
  }
  return `"${cell}" is not a valid rupee amount`;
}

function parse(cell: string, allowNegative: boolean): Parsed<Paise> {
  try {
    return accept(parseRupees(cell, { allowNegative }));
  } catch (err) {
    if (err instanceof MoneyError && err.code === 'OUT_OF_RANGE') {
      return reject(`"${cell}" is larger than any amount Ziro can store`);
    }
    if (err instanceof MoneyError) return reject(whyNotRupees(cell, allowNegative));
    throw err;
  }
}

/** A required unsigned rupee amount ("1,23,456.50") as paise. */
export function parseAmountCell(input: string): Parsed<Paise> {
  const cell = input.trim();
  if (cell === '') return reject('is empty');
  return parse(cell, false);
}

/** An unsigned rupee amount that may be blank (a bank statement's unused debit or credit column). */
export function parseOptionalAmountCell(input: string): Parsed<Paise | null> {
  const cell = input.trim();
  if (cell === '') return accept(null);
  return parse(cell, false);
}

/** A running balance: signed, because an overdrawn account exists. Blank is "not provided". */
export function parseBalanceCell(input: string): Parsed<Paise | null> {
  const cell = input.trim();
  if (cell === '') return accept(null);
  return parse(cell, true);
}
