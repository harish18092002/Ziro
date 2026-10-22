// Ledger and bank-statement CSV files -> validated rows. Pure: no database, no IO, so everything
// here is testable with a string. Every problem is collected as (row, field, reason) and the rest of
// the file carries on; only a file that cannot be read at all (no usable header) is refused whole.
import { formatRupees, type Paise } from '@ziro/core/money';
import {
  bindHeader,
  type CsvRecord,
  extractUtr,
  findForbiddenCharacter,
  normalizeRef,
  parseAmountCell,
  parseBalanceCell,
  parseBusinessDateCell,
  parseCsv,
  parseOptionalAmountCell,
  type Parsed,
  type UtrQuality,
} from '@ziro/core/normalize';
import { z } from 'zod';
import { importHash } from '../razorpay/identity.js';
import type { ImportWarning, RowError } from './report.js';

export interface RowBase {
  readonly row: number;
  readonly line: number;
  /** The record's identity within the run: `(run_id, source_ref)` is unique in the database. */
  readonly sourceRef: string;
  readonly importHash: string;
  /** The known columns exactly as received. Untrusted. */
  readonly raw: Readonly<Record<string, string>>;
}

export interface LedgerRow extends RowBase {
  readonly orderRef: string;
  readonly amount: Paise;
  readonly businessDate: string;
  readonly customerRef: string | null;
  readonly memo: string | null;
}

export interface BankRow extends RowBase {
  readonly valueDate: string;
  readonly direction: 'credit' | 'debit';
  readonly amount: Paise;
  readonly narration: string;
  readonly utr: string | null;
  readonly utrQuality: UtrQuality | null;
  readonly balance: Paise | null;
}

export interface ParsedCsv<R> {
  /** Why the whole file is unusable; empty when it can be imported. */
  readonly fatal: readonly string[];
  /** Data rows in the file, readable or not. */
  readonly totalRows: number;
  /** Rows that passed validation, in file order. */
  readonly rows: readonly R[];
  readonly errors: readonly RowError[];
  readonly warnings: readonly ImportWarning[];
  readonly controlTotals: Readonly<Record<string, string>>;
}

const MAX_REF = 200;
const MAX_TEXT = 2000;

// --- cell checks -----------------------------------------------------------------------------

function refCell(raw: string, required: boolean): Parsed<string | null> {
  const ref = normalizeRef(raw);
  if (ref === null) return required ? { ok: false, reason: 'is empty' } : { ok: true, value: null };
  if (ref.length > MAX_REF) {
    return { ok: false, reason: `is ${ref.length} characters; the limit is ${MAX_REF}` };
  }
  const bad = findForbiddenCharacter(ref);
  return bad === null
    ? { ok: true, value: ref }
    : { ok: false, reason: `contains a forbidden character (${bad})` };
}

/** Free text is kept exactly as received (untrusted), only refused if unsafe or too long. */
function freeText(raw: string): Parsed<string> {
  if (raw.length > MAX_TEXT) {
    return { ok: false, reason: `is ${raw.length} characters; the limit is ${MAX_TEXT}` };
  }
  const bad = findForbiddenCharacter(raw);
  return bad === null
    ? { ok: true, value: raw }
    : { ok: false, reason: `contains a forbidden character (${bad})` };
}

interface IssueSink {
  addIssue(issue: { code: 'custom'; message: string; path: string[] }): void;
}

type Values<R extends Record<string, Parsed<unknown>>> = {
  [K in keyof R]: R[K] extends Parsed<infer V> ? V : never;
};

/** All the values if every check passed; otherwise reports each failure against its field. */
function unwrap<R extends Record<string, Parsed<unknown>>>(
  sink: IssueSink,
  checks: R,
): Values<R> | null {
  const values: Record<string, unknown> = {};
  let failed = false;
  for (const [field, result] of Object.entries(checks)) {
    if (result.ok) values[field] = result.value;
    else {
      failed = true;
      sink.addIssue({ code: 'custom', message: result.reason, path: [field] });
    }
  }
  return failed ? null : (values as Values<R>);
}

// --- row schemas -----------------------------------------------------------------------------

const ledgerCells = z.object({
  order_ref: z.string(),
  order_date: z.string(),
  amount: z.string(),
  customer_ref: z.string(),
  memo: z.string(),
});

const ledgerValues = ledgerCells.transform((cells, ctx) => {
  const v = unwrap(ctx, {
    order_ref: refCell(cells.order_ref, true),
    order_date: parseBusinessDateCell(cells.order_date),
    amount: parseAmountCell(cells.amount),
    customer_ref: refCell(cells.customer_ref, false),
    memo: freeText(cells.memo),
  });
  if (v === null) return z.NEVER;
  return {
    orderRef: v.order_ref as string,
    businessDate: v.order_date,
    amount: v.amount,
    customerRef: v.customer_ref,
    memo: v.memo.trim() === '' ? null : v.memo,
  };
});

const bankCells = z.object({
  value_date: z.string(),
  narration: z.string(),
  debit: z.string(),
  credit: z.string(),
  balance: z.string(),
});

const bankValues = bankCells.transform((cells, ctx) => {
  const v = unwrap(ctx, {
    value_date: parseBusinessDateCell(cells.value_date),
    narration: freeText(cells.narration),
    debit: parseOptionalAmountCell(cells.debit),
    credit: parseOptionalAmountCell(cells.credit),
    balance: parseBalanceCell(cells.balance),
  });
  if (v === null) return z.NEVER;

  // A blank or 0.00 cell means "not this side": statements often print 0.00 in the unused column.
  const debit = v.debit !== null && v.debit > 0n ? v.debit : null;
  const credit = v.credit !== null && v.credit > 0n ? v.credit : null;
  if (debit !== null && credit !== null) {
    ctx.addIssue({
      code: 'custom',
      message: 'both debit and credit have an amount',
      path: ['debit'],
    });
    return z.NEVER;
  }
  const amount = debit ?? credit;
  if (amount === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'neither debit nor credit has a non-zero amount',
      path: ['credit'],
    });
    return z.NEVER;
  }
  const found = extractUtr(v.narration);
  return {
    valueDate: v.value_date,
    direction: credit === null ? ('debit' as const) : ('credit' as const),
    amount,
    narration: v.narration,
    utr: found.utr,
    utrQuality: found.quality,
    balance: v.balance,
  };
});

// --- the shared reader -----------------------------------------------------------------------

interface FileSpec<V, R extends RowBase> {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly values: z.ZodType<V>;
  /** The record's identity; a repeat within one file is refused. */
  readonly sourceRef: (value: V, row: number) => string;
  /** The column a repeated key is reported against. */
  readonly keyField: string | null;
  readonly build: (value: V, base: RowBase) => R;
}

type Read<R> = Omit<ParsedCsv<R>, 'controlTotals'>;

const unusable = <R>(fatal: readonly string[]): Read<R> => ({
  fatal,
  totalRows: 0,
  rows: [],
  errors: [],
  warnings: [],
});

/** A file refused before any row was read (empty, not UTF-8): the same shape as any other result. */
export const refusedFile = <R>(reason: string): ParsedCsv<R> => ({
  ...unusable<R>([reason]),
  controlTotals: {},
});

function readFile<V, R extends RowBase>(text: string, spec: FileSpec<V, R>): Read<R> {
  const table = parseCsv(text);
  if (table.header === null) {
    const why = table.issues[0]?.reason;
    return unusable([
      why === undefined ? 'the file is empty' : `the header row is unreadable: ${why}`,
    ]);
  }
  const bound = bindHeader(table.header.cells, {
    required: spec.required,
    optional: spec.optional,
  });
  if (!bound.ok) return unusable(bound.problems);

  const known = [...spec.required, ...spec.optional];
  const errors: RowError[] = table.issues
    .filter((issue) => issue.row > 0)
    .map((issue) => ({
      row: issue.row,
      line: issue.line,
      field: null,
      code: 'csv_syntax' as const,
      reason: issue.reason,
    }));
  const warnings: ImportWarning[] = bound.ignored.map((name) => ({
    code: 'unknown_column' as const,
    row: null,
    reason: `column "${name}" is not used and was ignored`,
  }));

  const rows: R[] = [];
  const firstSeen = new Map<string, number>();
  for (const record of table.records) {
    const built = readRecord(record, bound.width, bound.columns, known, spec, firstSeen);
    if ('errors' in built) errors.push(...built.errors);
    else rows.push(built.row);
  }
  errors.sort((a, b) => a.row - b.row);
  const totalRows = table.records.length + table.issues.filter((i) => i.row > 0).length;
  if (totalRows === 0) {
    warnings.push({ code: 'no_rows', row: null, reason: 'the file has a header but no data rows' });
  }
  return { fatal: [], totalRows, rows, errors, warnings };
}

function readRecord<V, R extends RowBase>(
  record: CsvRecord,
  width: number,
  columns: Readonly<Record<string, number>>,
  known: readonly string[],
  spec: FileSpec<V, R>,
  firstSeen: Map<string, number>,
): { row: R } | { errors: RowError[] } {
  const fail = (code: RowError['code'], field: string | null, reason: string) => ({
    errors: [{ row: record.row, line: record.line, field, code, reason }],
  });
  if (record.cells.length !== width) {
    return fail('column_count', null, `expected ${width} columns, found ${record.cells.length}`);
  }

  const raw: Record<string, string> = {};
  for (const name of known) {
    const index = columns[name];
    raw[name] = index === undefined ? '' : (record.cells[index] ?? '');
  }
  const parsed = spec.values.safeParse(raw);
  if (!parsed.success) {
    // Every bad field of the row is reported, so one pass over the report fixes the whole row.
    return {
      errors: parsed.error.issues.map((issue) => ({
        row: record.row,
        line: record.line,
        field: String(issue.path[0] ?? ''),
        code: 'invalid_value' as const,
        reason: issue.message,
      })),
    };
  }

  const sourceRef = spec.sourceRef(parsed.data, record.row);
  const earlier = firstSeen.get(sourceRef);
  if (earlier !== undefined) {
    return fail(
      'duplicate_key',
      spec.keyField,
      `repeats ${sourceRef}, first seen on row ${earlier}; only the first is kept`,
    );
  }
  firstSeen.set(sourceRef, record.row);
  return {
    row: spec.build(parsed.data, {
      row: record.row,
      line: record.line,
      sourceRef,
      importHash: importHash(raw),
      raw,
    }),
  };
}

// --- the two files ---------------------------------------------------------------------------

const sumPaise = (values: Iterable<Paise>): string => {
  let total = 0n;
  for (const value of values) total += value;
  return total.toString();
};

export function parseLedgerCsv(text: string): ParsedCsv<LedgerRow> {
  const read = readFile<z.output<typeof ledgerValues>, LedgerRow>(text, {
    required: ['order_ref', 'order_date', 'amount'],
    optional: ['customer_ref', 'memo'],
    values: ledgerValues,
    // The merchant's own order reference is the identity: re-uploading a reordered or extended
    // ledger finds the same rows, and the same order twice in one file is an error, not a guess.
    sourceRef: (value) => value.orderRef,
    keyField: 'order_ref',
    build: (value, base) => ({ ...base, ...value }),
  });
  return { ...read, controlTotals: { totalPaise: sumPaise(read.rows.map((r) => r.amount)) } };
}

export function parseBankCsv(text: string): ParsedCsv<BankRow> {
  const read = readFile<z.output<typeof bankValues>, BankRow>(text, {
    required: ['value_date', 'narration', 'debit', 'credit'],
    optional: ['balance'],
    values: bankValues,
    // A statement line has no natural key, and two identical lines are legitimate, so its position
    // in the file is its identity (the same key datagen's truth.json uses).
    sourceRef: (_value, row) => `row-${row}`,
    keyField: null,
    build: (value, base) => ({ ...base, ...value }),
  });
  return {
    ...read,
    warnings: [...read.warnings, ...balanceChainWarnings(read.rows)],
    controlTotals: {
      creditsPaise: sumPaise(
        read.rows.filter((r) => r.direction === 'credit').map((r) => r.amount),
      ),
      debitsPaise: sumPaise(read.rows.filter((r) => r.direction === 'debit').map((r) => r.amount)),
    },
  };
}

// --- balance continuity ----------------------------------------------------------------------

const MAX_BALANCE_WARNINGS = 5;
const signed = (row: BankRow): bigint =>
  row.direction === 'credit' ? row.amount : 0n - row.amount;

/**
 * A statement's running balance must chain: each balance is the previous one plus the line. A break
 * means a row was dropped or misread, which is exactly what zero tolerance on amounts needs to see.
 * A newest-first statement chains in reverse and gets one note instead of hundreds of breaks.
 * Only adjacent, readable rows with balances are compared; rejected rows are reported separately.
 */
export function balanceChainWarnings(rows: readonly BankRow[]): ImportWarning[] {
  const pairs: { prev: BankRow; cur: BankRow }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1] as BankRow;
    const cur = rows[i] as BankRow;
    if (cur.row === prev.row + 1 && prev.balance !== null && cur.balance !== null) {
      pairs.push({ prev, cur });
    }
  }
  const forwardBreaks = pairs.filter(
    ({ prev, cur }) => (prev.balance as bigint) + signed(cur) !== cur.balance,
  );
  if (forwardBreaks.length === 0) return [];

  const reverseBreaks = pairs.filter(
    ({ prev, cur }) => (cur.balance as bigint) + signed(prev) !== prev.balance,
  );
  if (reverseBreaks.length === 0) {
    return [
      {
        code: 'balance_order',
        row: null,
        reason:
          'the statement runs newest first: its balances chain in reverse order, with no breaks',
      },
    ];
  }

  const shown = forwardBreaks.slice(0, MAX_BALANCE_WARNINGS).map(({ prev, cur }) => ({
    code: 'balance_break' as const,
    row: cur.row,
    reason: `balance ${formatRupees(cur.balance as Paise)} does not equal the previous balance ${formatRupees(prev.balance as Paise)} ${cur.direction === 'credit' ? 'plus' : 'minus'} ${formatRupees(cur.amount)}: a row may be missing or misread`,
  }));
  const more = forwardBreaks.length - shown.length;
  return more > 0
    ? [...shown, { code: 'balance_break', row: null, reason: `and ${more} more balance breaks` }]
    : shown;
}
