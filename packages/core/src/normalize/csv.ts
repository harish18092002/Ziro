// A strict RFC 4180 reader that never gives up on a whole file because of one bad row.
//
// A damaged record becomes an issue (row, line, reason) and reading resumes on the next physical
// line, so one stray quote cannot swallow ten thousand good rows. Accepted: a BOM, CRLF / LF / CR
// line ends, quoted fields with embedded commas, quotes ("") and line breaks, empty fields. Not
// accepted: a quote inside an unquoted field, text after a closing quote, a quote that never
// closes. Blank lines are skipped and do not consume a row number.
//
// Numbering: the header is row 0, data rows are 1, 2, 3... (matching datagen's `row-<n>` keys), and
// `line` is the physical line a record starts on, for finding it in an editor.

export interface CsvRecord {
  readonly row: number;
  readonly line: number;
  readonly cells: readonly string[];
}

export interface CsvIssue {
  readonly row: number;
  readonly line: number;
  readonly reason: string;
}

export interface CsvTable {
  /** Row 0; null when the first record was unreadable (the issue list says why). */
  readonly header: CsvRecord | null;
  /** Readable data records, in file order. */
  readonly records: readonly CsvRecord[];
  /** Records that could not be read; they are absent from `records`. */
  readonly issues: readonly CsvIssue[];
}

const COMMA = 44;
const QUOTE = 34;
const CR = 13;
const LF = 10;
const BOM = 0xfeff;

type RecordRead =
  | { readonly ok: true; readonly cells: string[]; readonly end: number }
  | { readonly ok: false; readonly reason: string; readonly at: number };

const isTerminator = (code: number): boolean => code === CR || code === LF;

function readRecord(text: string, start: number): RecordRead {
  const cells: string[] = [];
  let i = start;
  for (;;) {
    if (text.charCodeAt(i) === QUOTE) {
      i += 1;
      let cell = '';
      for (;;) {
        const close = text.indexOf('"', i);
        if (close === -1) return { ok: false, reason: 'a quoted field is never closed', at: start };
        cell += text.slice(i, close);
        if (text.charCodeAt(close + 1) === QUOTE) {
          cell += '"';
          i = close + 2;
        } else {
          i = close + 1;
          break;
        }
      }
      const after = text.charCodeAt(i);
      if (!(Number.isNaN(after) || after === COMMA || isTerminator(after))) {
        return { ok: false, reason: 'unexpected text after a closing quote', at: i };
      }
      cells.push(cell);
    } else {
      let j = i;
      for (;;) {
        const code = text.charCodeAt(j);
        if (Number.isNaN(code) || code === COMMA || isTerminator(code)) break;
        if (code === QUOTE) {
          return {
            ok: false,
            reason: 'a quote inside an unquoted field (quote the whole field and double the quote)',
            at: j,
          };
        }
        j += 1;
      }
      cells.push(text.slice(i, j));
      i = j;
    }
    if (text.charCodeAt(i) === COMMA) {
      i += 1;
      continue;
    }
    return { ok: true, cells, end: i };
  }
}

/** The index just past the line terminator at `i` (CRLF counts once), or `i` if there is none. */
function pastTerminator(text: string, i: number): number {
  const code = text.charCodeAt(i);
  if (code === CR) return text.charCodeAt(i + 1) === LF ? i + 2 : i + 1;
  return code === LF ? i + 1 : i;
}

/** The index of the start of the line after the one containing `from`. */
function nextLineStart(text: string, from: number): number {
  let i = from;
  while (i < text.length && !isTerminator(text.charCodeAt(i))) i += 1;
  return pastTerminator(text, i);
}

/** Line breaks in text[from, to): CRLF, lone CR and lone LF each count once. */
function lineBreaksIn(text: string, from: number, to: number): number {
  let breaks = 0;
  for (let i = from; i < to; i++) {
    const code = text.charCodeAt(i);
    if (code === LF || (code === CR && text.charCodeAt(i + 1) !== LF)) breaks += 1;
  }
  return breaks;
}

export function parseCsv(input: string): CsvTable {
  const text = input.charCodeAt(0) === BOM ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  const issues: CsvIssue[] = [];
  let header: CsvRecord | null = null;
  let headerSeen = false;
  let dataRows = 0;
  let pos = 0;
  let line = 1;

  while (pos < text.length) {
    if (isTerminator(text.charCodeAt(pos))) {
      pos = pastTerminator(text, pos);
      line += 1;
      continue;
    }
    const row = headerSeen ? ++dataRows : 0;
    const read = readRecord(text, pos);
    let next: number;
    if (read.ok) {
      const record: CsvRecord = { row, line, cells: read.cells };
      if (headerSeen) records.push(record);
      else header = record;
      next = pastTerminator(text, read.end);
    } else {
      issues.push({ row, line, reason: read.reason });
      next = nextLineStart(text, read.at);
    }
    line += lineBreaksIn(text, pos, next);
    pos = next;
    headerSeen = true;
  }
  return { header, records, issues };
}

export interface HeaderSpec {
  readonly required: readonly string[];
  readonly optional?: readonly string[];
}

export type HeaderBinding =
  | {
      readonly ok: true;
      /** Column name -> index. Only the columns in the spec. */
      readonly columns: Readonly<Record<string, number>>;
      /** How many cells every data record must have. */
      readonly width: number;
      /** Columns present in the file but not understood. Reported, never fatal. */
      readonly ignored: readonly string[];
    }
  | { readonly ok: false; readonly problems: readonly string[] };

const headerName = (cell: string): string => cell.trim().toLowerCase();

/** Matches a file's header to the columns an importer needs. Names compare trimmed, case-insensitive. */
export function bindHeader(header: readonly string[], spec: HeaderSpec): HeaderBinding {
  const wanted = new Set([...spec.required, ...(spec.optional ?? [])]);
  const columns: Record<string, number> = {};
  const ignored: string[] = [];
  const problems: string[] = [];

  header.forEach((cell, index) => {
    const name = headerName(cell);
    if (!wanted.has(name)) {
      ignored.push(cell.trim());
    } else if (name in columns) {
      problems.push(`column "${name}" appears more than once`);
    } else {
      columns[name] = index;
    }
  });
  for (const name of spec.required) {
    if (!(name in columns)) problems.push(`required column "${name}" is missing`);
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, columns, width: header.length, ignored };
}
