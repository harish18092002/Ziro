// CSV for people who will open it in a spreadsheet. The cells include text that strangers wrote (memos,
// narrations, order references) and text a model wrote, and a spreadsheet treats a cell that begins with
// = + - @ (or a tab or carriage return) as a formula. So every text cell that could be read as one is
// prefixed with an apostrophe, which makes the spreadsheet show it as plain text. Numbers are never
// touched: a negative amount is a number, not a formula.
export type Cell = string | number | bigint | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: Cell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function csvRow(cells: readonly Cell[]): string {
  return cells.map(csvCell).join(',');
}

/** A header and rows, CRLF-separated as RFC 4180 asks, with a final newline. */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

/** Paise as plain rupees with two decimals and no grouping: "12345.50". For spreadsheets, not for eyes. */
export function plainRupees(paise: bigint): string {
  const negative = paise < 0n;
  const magnitude = negative ? -paise : paise;
  const rupees = magnitude / 100n;
  const fraction = (magnitude % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${rupees}.${fraction}`;
}
