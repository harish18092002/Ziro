// The shapes an import hands back. Plain JSON: paise travel as integer strings (never bigint),
// so a report can be returned over HTTP and stored in the audit trail as it is.

/** Reported errors are capped so a file of garbage cannot produce a response of garbage. */
export const MAX_REPORTED_ERRORS = 100;
/** The audit trail keeps fewer: it records that errors happened, the report lists them. */
export const MAX_AUDITED_ERRORS = 20;

export type RowErrorCode =
  | 'csv_syntax'
  | 'column_count'
  | 'invalid_value'
  | 'duplicate_key'
  | 'conflict'
  | 'unknown_settlement';

export interface RowError {
  /** 1-based data row (the header is row 0), matching the `row-<n>` keys of the bank source refs. */
  readonly row: number;
  /** The physical line the row starts on; null for records that did not come from a CSV. */
  readonly line: number | null;
  readonly field: string | null;
  readonly code: RowErrorCode;
  readonly reason: string;
}

export type ImportWarningCode =
  | 'unknown_column'
  | 'no_rows'
  | 'balance_break'
  | 'balance_order'
  | 'source_note'
  /** Razorpay could not supply part of the window (see Gap). */
  | 'partial_import';

export interface ImportWarning {
  readonly code: ImportWarningCode;
  readonly row: number | null;
  readonly reason: string;
}

/** ok: everything landed. partial: some rows were rejected or conflicted, or Razorpay could not supply part of the window. rejected: nothing was usable. */
export type ImportStatus = 'ok' | 'partial' | 'rejected';

export interface RowCounts {
  /** Data rows in the file, readable or not. */
  readonly total: number;
  /** Rows that passed validation. */
  readonly valid: number;
  readonly inserted: number;
  /** Already imported with identical content: a re-import. */
  readonly unchanged: number;
  /** Already imported with DIFFERENT content: reported, never overwritten. */
  readonly conflicts: number;
  /** Rows that failed validation. */
  readonly rejected: number;
}

export interface CsvImportReport {
  readonly runId: string;
  readonly source: 'ledger' | 'bank';
  readonly status: ImportStatus;
  readonly fileName: string | null;
  /** sha-256 of the uploaded bytes: the same file always gives the same hash. */
  readonly fileHash: string;
  readonly bytes: number;
  readonly rows: RowCounts;
  /** What the readable rows add up to, in paise, for checking against the merchant's own totals. */
  readonly controlTotals: Readonly<Record<string, string>>;
  readonly errors: readonly RowError[];
  /** All errors, including those past the cap. */
  readonly errorCount: number;
  readonly warnings: readonly ImportWarning[];
  /** Why the whole file was refused; empty unless status is `rejected`. */
  readonly fatal: readonly string[];
}

export function capErrors(errors: readonly RowError[]): {
  readonly errors: readonly RowError[];
  readonly errorCount: number;
} {
  return { errors: errors.slice(0, MAX_REPORTED_ERRORS), errorCount: errors.length };
}

export function statusOf(fatal: readonly string[], errorCount: number): ImportStatus {
  if (fatal.length > 0) return 'rejected';
  return errorCount > 0 ? 'partial' : 'ok';
}
