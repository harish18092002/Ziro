import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { findForbiddenCharacter } from '@ziro/core/normalize';
import { count, eq, and, inArray } from 'drizzle-orm';
import { appendAudit } from '../audit/audit.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import type { Executor } from '../db/executor.js';
import {
  bankLines,
  ledgerEntries,
  reconRuns,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
  settlementItems,
} from '../db/schema.js';
import { resolveDataDir } from '../razorpay/data-dir.js';
import { RazorpayApiError, RazorpayConfigError } from '../razorpay/errors.js';
import { deterministicUuid } from '../razorpay/identity.js';
import { RazorpaySourceFactory } from '../razorpay/razorpay.module.js';
import { type RazorpaySource, summarizeProvenance } from '../razorpay/source.js';
import {
  type BankRow,
  type LedgerRow,
  type ParsedCsv,
  parseBankCsv,
  parseLedgerCsv,
  refusedFile,
  type RowBase,
} from './csv-files.js';
import {
  fetchBundle,
  ImportRangeError,
  type RazorpayBundle,
  type RazorpayWindow,
  SETTLEMENT_LOOKAHEAD_DAYS,
  windowFor,
} from './razorpay-bundle.js';
import {
  type BundleOutcome,
  type EntityCounts,
  type EntityKey,
  writeBundle,
} from './razorpay-records.js';
import {
  capErrors,
  type CsvImportReport,
  type ImportStatus,
  type ImportWarning,
  MAX_AUDITED_ERRORS,
  type RowError,
  statusOf,
} from './report.js';
import type { CreateRunInput, RazorpayImportInput } from './requests.js';
import { type WriteOutcome, writeSourceRows } from './write.js';

export interface RunView {
  readonly id: string;
  readonly status: string;
  readonly razorpaySource: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly createdAt: string;
}

export interface TableCount {
  readonly total: number;
  readonly bySource: Readonly<Record<string, number>>;
}

export interface RunSummary {
  readonly run: RunView;
  readonly records: Readonly<
    Record<
      | 'ledgerEntries'
      | 'bankLines'
      | 'rzpPayments'
      | 'rzpRefunds'
      | 'rzpSettlements'
      | 'settlementItems',
      TableCount
    >
  >;
}

export interface RazorpayImportReport {
  readonly runId: string;
  readonly source: 'razorpay';
  readonly status: ImportStatus;
  readonly window: RazorpayWindow;
  readonly entities: Readonly<Record<EntityKey, EntityCounts>>;
  /** Where each entity's data actually came from: the UI labels synthetic data honestly with this. */
  readonly provenance: readonly {
    readonly entity: string;
    readonly source: string;
    readonly reason: string;
    readonly requests: number;
  }[];
  /** True when real test-mode and synthetic data are in one run: it will not reconcile (ADR-008). */
  readonly mixed: boolean;
  readonly errors: readonly RowError[];
  readonly errorCount: number;
  readonly warnings: readonly ImportWarning[];
}

export interface DemoResult {
  readonly run: RunView;
  readonly reports: {
    readonly ledger: CsvImportReport;
    readonly bank: CsvImportReport;
    readonly razorpay: RazorpayImportReport;
  };
}

export interface UploadedCsv {
  readonly buffer: Buffer;
  readonly originalName: string | undefined;
}

type RunStatus = (typeof reconRuns.$inferSelect)['status'];
type PreparedCsv =
  | { readonly kind: 'ledger'; readonly parsed: ParsedCsv<LedgerRow> }
  | { readonly kind: 'bank'; readonly parsed: ParsedCsv<BankRow> };

interface UploadInfo {
  readonly bytes: number;
  readonly fileHash: string;
  readonly fileName: string | null;
}

/** The longest window the demo preset can span: the synthetic dataset answers for all of it. */
const WIDE: RazorpayWindow = {
  from: '2000-01-01',
  to: '2099-12-31',
  settlementsThrough: '2099-12-31',
};
const DEMO_COMMAND = 'npm run datagen -- --seed 42 --preset demo --out data/demo';
const OPEN_STATUSES: readonly RunStatus[] = ['created', 'ingesting'];

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function safeFileName(name: string | undefined): string | null {
  const base = name?.split(/[\\/]/).pop() ?? '';
  return base === '' || findForbiddenCharacter(base) !== null ? null : base.slice(0, 200);
}

function describeUpload(file: UploadedCsv): UploadInfo {
  return {
    bytes: file.buffer.length,
    fileHash: sha256(file.buffer),
    fileName: safeFileName(file.originalName),
  };
}

function prepareCsv(kind: 'ledger' | 'bank', buffer: Buffer): PreparedCsv {
  const refuse = (reason: string): PreparedCsv =>
    kind === 'ledger'
      ? { kind, parsed: refusedFile<LedgerRow>(reason) }
      : { kind, parsed: refusedFile<BankRow>(reason) };
  if (buffer.length === 0) return refuse('the file is empty');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return refuse('the file is not valid UTF-8 (save it as "CSV UTF-8" and upload it again)');
  }
  return kind === 'ledger'
    ? { kind, parsed: parseLedgerCsv(text) }
    : { kind, parsed: parseBankCsv(text) };
}

const toRunView = (row: typeof reconRuns.$inferSelect): RunView => ({
  id: row.id,
  status: row.status,
  razorpaySource: row.razorpaySource,
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  createdAt: row.createdAt.toISOString(),
});

const tally = (rows: readonly { source: string; n: number }[]): TableCount => ({
  total: rows.reduce((total, row) => total + row.n, 0),
  bySource: Object.fromEntries(rows.map((row) => [row.source, row.n])),
});

@Injectable()
export class IngestService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(ENV) private readonly env: Env,
    private readonly razorpay: RazorpaySourceFactory,
  ) {}

  // --- runs ------------------------------------------------------------------------------------

  async createRun(input: CreateRunInput): Promise<RunView> {
    return this.db.transaction((tx) =>
      this.insertRun(tx, { ...input, razorpaySource: this.env.RAZORPAY_SOURCE, demo: false }),
    );
  }

  async getRun(runId: string): Promise<RunSummary> {
    const [run] = await this.db.select().from(reconRuns).where(eq(reconRuns.id, runId));
    if (!run) throw new NotFoundException(`run ${runId} does not exist`);
    const [ledger, bank, payments, refunds, settlements, items] = await Promise.all([
      this.db
        .select({ source: ledgerEntries.source, n: count() })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.runId, runId))
        .groupBy(ledgerEntries.source),
      this.db
        .select({ source: bankLines.source, n: count() })
        .from(bankLines)
        .where(eq(bankLines.runId, runId))
        .groupBy(bankLines.source),
      this.db
        .select({ source: rzpPayments.source, n: count() })
        .from(rzpPayments)
        .where(eq(rzpPayments.runId, runId))
        .groupBy(rzpPayments.source),
      this.db
        .select({ source: rzpRefunds.source, n: count() })
        .from(rzpRefunds)
        .where(eq(rzpRefunds.runId, runId))
        .groupBy(rzpRefunds.source),
      this.db
        .select({ source: rzpSettlements.source, n: count() })
        .from(rzpSettlements)
        .where(eq(rzpSettlements.runId, runId))
        .groupBy(rzpSettlements.source),
      this.db
        .select({ source: settlementItems.source, n: count() })
        .from(settlementItems)
        .where(eq(settlementItems.runId, runId))
        .groupBy(settlementItems.source),
    ]);
    return {
      run: toRunView(run),
      records: {
        ledgerEntries: tally(ledger),
        bankLines: tally(bank),
        rzpPayments: tally(payments),
        rzpRefunds: tally(refunds),
        rzpSettlements: tally(settlements),
        settlementItems: tally(items),
      },
    };
  }

  private async insertRun(
    tx: Executor,
    args: {
      readonly id?: string;
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly razorpaySource: 'synthetic' | 'testmode';
      readonly demo: boolean;
    },
  ): Promise<RunView> {
    const [row] = await tx
      .insert(reconRuns)
      .values({
        ...(args.id === undefined ? {} : { id: args.id }),
        razorpaySource: args.razorpaySource,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        config: {
          ingest: {
            settlementLookaheadDays: SETTLEMENT_LOOKAHEAD_DAYS,
            maxImportBytes: this.env.IMPORT_MAX_BYTES,
          },
        },
      })
      .returning();
    if (!row) throw new Error('inserting the run returned no row');
    await appendAudit(tx, {
      runId: row.id,
      actor: 'system',
      action: 'run.create',
      entityType: 'recon_run',
      entityId: row.id,
      detail: {
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        razorpaySource: args.razorpaySource,
        demo: args.demo,
      },
    });
    return toRunView(row);
  }

  /** Locks the run and refuses a missing one or one that is past ingestion. Returns its status. */
  private async lockOpenRun(tx: Executor, runId: string): Promise<RunStatus> {
    const [run] = await tx
      .select({ status: reconRuns.status })
      .from(reconRuns)
      .where(eq(reconRuns.id, runId))
      .for('update');
    if (!run) throw new NotFoundException(`run ${runId} does not exist`);
    if (!OPEN_STATUSES.includes(run.status)) {
      throw new ConflictException(
        `run is ${run.status}: imports are only accepted before matching starts`,
      );
    }
    return run.status;
  }

  /** The first successful import moves the run from `created` to `ingesting`, and says so. */
  private async markIngesting(tx: Executor, runId: string, was: RunStatus): Promise<void> {
    if (was !== 'created') return;
    await tx.update(reconRuns).set({ status: 'ingesting' }).where(eq(reconRuns.id, runId));
    await appendAudit(tx, {
      runId,
      actor: 'system',
      action: 'run.status_changed',
      entityType: 'recon_run',
      entityId: runId,
      detail: { from: 'created', to: 'ingesting' },
    });
  }

  // --- CSV imports -----------------------------------------------------------------------------

  async importCsv(
    runId: string,
    kind: 'ledger' | 'bank',
    file: UploadedCsv,
  ): Promise<CsvImportReport> {
    const upload = describeUpload(file);
    const prepared = prepareCsv(kind, file.buffer);
    return this.db.transaction((tx) => this.applyCsv(tx, runId, prepared, upload));
  }

  private async applyCsv(
    tx: Executor,
    runId: string,
    prepared: PreparedCsv,
    upload: UploadInfo,
  ): Promise<CsvImportReport> {
    const was = await this.lockOpenRun(tx, runId);
    const { parsed } = prepared;

    let outcome: WriteOutcome = { inserted: 0, unchanged: 0, conflicts: [] };
    if (parsed.fatal.length === 0) {
      outcome =
        prepared.kind === 'ledger'
          ? await this.writeLedger(tx, runId, prepared.parsed.rows)
          : await this.writeBank(tx, runId, prepared.parsed.rows);
      await this.markIngesting(tx, runId, was);
    }

    const rowsByRef = new Map<string, RowBase>();
    for (const row of parsed.rows as readonly RowBase[]) rowsByRef.set(row.sourceRef, row);
    const conflictErrors: RowError[] = outcome.conflicts.map((sourceRef) => ({
      row: rowsByRef.get(sourceRef)?.row ?? 0,
      line: rowsByRef.get(sourceRef)?.line ?? null,
      field: null,
      code: 'conflict',
      reason: `${sourceRef} was already imported with different content; imported rows are never overwritten (start a new run to use a corrected file)`,
    }));
    const allErrors = [...parsed.errors, ...conflictErrors].sort((a, b) => a.row - b.row);
    const { errors, errorCount } = capErrors(allErrors);

    const report: CsvImportReport = {
      runId,
      source: prepared.kind,
      status: statusOf(parsed.fatal, allErrors.length),
      fileName: upload.fileName,
      fileHash: upload.fileHash,
      bytes: upload.bytes,
      rows: {
        total: parsed.totalRows,
        valid: parsed.rows.length,
        inserted: outcome.inserted,
        unchanged: outcome.unchanged,
        conflicts: outcome.conflicts.length,
        rejected: parsed.totalRows - parsed.rows.length,
      },
      controlTotals: parsed.controlTotals,
      errors,
      errorCount,
      warnings: parsed.warnings,
      fatal: parsed.fatal,
    };
    await appendAudit(tx, {
      runId,
      actor: 'system',
      action: `import.${prepared.kind}`,
      entityType: 'recon_run',
      entityId: runId,
      detail: {
        source: 'csv',
        fileName: report.fileName,
        fileHash: report.fileHash,
        bytes: report.bytes,
        status: report.status,
        rows: report.rows,
        controlTotals: report.controlTotals,
        errorCount,
        errors: allErrors.slice(0, MAX_AUDITED_ERRORS),
        warnings: report.warnings.length,
        fatal: report.fatal,
      },
    });
    return report;
  }

  private writeLedger(
    tx: Executor,
    runId: string,
    rows: readonly LedgerRow[],
  ): Promise<WriteOutcome> {
    return writeSourceRows({
      rows,
      lookup: (refs) =>
        tx
          .select({ sourceRef: ledgerEntries.sourceRef, importHash: ledgerEntries.importHash })
          .from(ledgerEntries)
          .where(and(eq(ledgerEntries.runId, runId), inArray(ledgerEntries.sourceRef, refs))),
      insert: async (batch) =>
        (
          await tx
            .insert(ledgerEntries)
            .values(
              batch.map((r) => ({
                id: deterministicUuid(runId, 'ledger_entry', r.sourceRef),
                runId,
                source: 'csv' as const,
                sourceRef: r.sourceRef,
                importHash: r.importHash,
                raw: { ...r.raw },
                orderRef: r.orderRef,
                amountPaise: r.amount,
                businessDate: r.businessDate,
                customerRef: r.customerRef,
                memo: r.memo,
              })),
            )
            .onConflictDoNothing({ target: [ledgerEntries.runId, ledgerEntries.sourceRef] })
            .returning({ sourceRef: ledgerEntries.sourceRef })
        ).map((r) => r.sourceRef),
    });
  }

  private writeBank(tx: Executor, runId: string, rows: readonly BankRow[]): Promise<WriteOutcome> {
    return writeSourceRows({
      rows,
      lookup: (refs) =>
        tx
          .select({ sourceRef: bankLines.sourceRef, importHash: bankLines.importHash })
          .from(bankLines)
          .where(and(eq(bankLines.runId, runId), inArray(bankLines.sourceRef, refs))),
      insert: async (batch) =>
        (
          await tx
            .insert(bankLines)
            .values(
              batch.map((r) => ({
                id: deterministicUuid(runId, 'bank_line', r.sourceRef),
                runId,
                source: 'csv' as const,
                sourceRef: r.sourceRef,
                importHash: r.importHash,
                raw: { ...r.raw },
                valueDate: r.valueDate,
                direction: r.direction,
                amountPaise: r.amount,
                narration: r.narration,
                utr: r.utr,
                utrQuality: r.utrQuality,
                balancePaise: r.balance,
              })),
            )
            .onConflictDoNothing({ target: [bankLines.runId, bankLines.sourceRef] })
            .returning({ sourceRef: bankLines.sourceRef })
        ).map((r) => r.sourceRef),
    });
  }

  // --- Razorpay import -------------------------------------------------------------------------

  async importRazorpay(runId: string, input: RazorpayImportInput): Promise<RazorpayImportReport> {
    // Refuse a missing or closed run before any request goes out to Razorpay.
    await this.db.transaction((tx) => this.lockOpenRun(tx, runId));
    const window = windowFor(input.from, input.to);
    const bundle = await this.fetchWith(() => this.razorpay.forRun(runId), window);
    return this.db.transaction((tx) => this.applyRazorpay(tx, runId, bundle, window));
  }

  /** Fetches a window from a source, turning source failures into the right HTTP errors. */
  private async fetchWith(
    makeSource: () => RazorpaySource,
    window: RazorpayWindow,
  ): Promise<RazorpayBundle> {
    try {
      return await fetchBundle(makeSource(), window);
    } catch (err) {
      if (err instanceof ImportRangeError) throw new UnprocessableEntityException(err.message);
      if (err instanceof RazorpayConfigError) {
        throw new ServiceUnavailableException('the Razorpay source is not configured correctly');
      }
      if (err instanceof RazorpayApiError) {
        throw new BadGatewayException(
          `Razorpay did not answer usefully (status ${err.statusCode})`,
        );
      }
      throw err;
    }
  }

  private async applyRazorpay(
    tx: Executor,
    runId: string,
    bundle: RazorpayBundle,
    window: RazorpayWindow,
  ): Promise<RazorpayImportReport> {
    const was = await this.lockOpenRun(tx, runId);
    const outcome: BundleOutcome = await writeBundle(tx, runId, bundle);
    await this.markIngesting(tx, runId, was);

    const allErrors = [...outcome.errors].sort((a, b) => a.row - b.row);
    const { errors, errorCount } = capErrors(allErrors);
    const summary = summarizeProvenance(bundle.provenance);
    const report: RazorpayImportReport = {
      runId,
      source: 'razorpay',
      status: statusOf([], allErrors.length),
      window,
      entities: outcome.entities,
      provenance: bundle.provenance.map((p) => ({
        entity: p.entity,
        source: p.source,
        reason: p.reason,
        requests: p.requests,
      })),
      mixed: summary.mixed,
      errors,
      errorCount,
      warnings: bundle.provenance.flatMap((p) =>
        p.warnings.map((reason) => ({ code: 'source_note' as const, row: null, reason })),
      ),
    };
    await appendAudit(tx, {
      runId,
      actor: 'system',
      action: 'import.razorpay',
      entityType: 'recon_run',
      entityId: runId,
      detail: {
        window,
        status: report.status,
        entities: report.entities,
        provenance: report.provenance,
        mixed: report.mixed,
        errorCount,
        errors: allErrors.slice(0, MAX_AUDITED_ERRORS),
        warnings: report.warnings.length,
      },
    });
    return report;
  }

  // --- the demo preset -------------------------------------------------------------------------

  /**
   * A new run holding the demo dataset, in ONE transaction: either all of it is there or none.
   * The CSVs go through the very same parse-and-write path as an upload, and Razorpay's side comes
   * from the synthetic source whatever RAZORPAY_SOURCE says, so the demo never touches Razorpay.
   */
  async createDemo(): Promise<DemoResult> {
    const dir = resolveDataDir(this.env.SYNTHETIC_DATA_DIR);
    const [ledgerFile, bankFile] = await Promise.all([
      this.readDemoFile(dir, 'ledger.csv'),
      this.readDemoFile(dir, 'bank_statement.csv'),
    ]);
    const runId = randomUUID();
    // Always the generated dataset, whatever RAZORPAY_SOURCE says: the demo never calls Razorpay.
    const synthetic = await this.fetchWith(() => this.razorpay.synthetic(runId), WIDE);

    const ledger = prepareCsv('ledger', ledgerFile);
    const bank = prepareCsv('bank', bankFile);

    const datesOf = (csv: PreparedCsv): string[] =>
      csv.kind === 'ledger'
        ? csv.parsed.rows.map((r) => r.businessDate)
        : csv.parsed.rows.map((r) => r.valueDate);
    const dates = [
      ...datesOf(ledger),
      ...datesOf(bank),
      ...synthetic.payments.map((s) => s.record.businessDate),
      ...synthetic.refunds.map((s) => s.record.businessDate),
      ...synthetic.settlements.map((s) => s.record.businessDate),
    ].sort();
    const periodStart = dates[0];
    const periodEnd = dates[dates.length - 1];
    if (periodStart === undefined || periodEnd === undefined) {
      throw new ServiceUnavailableException(
        `the demo data is empty; regenerate it: ${DEMO_COMMAND}`,
      );
    }

    return this.db.transaction(async (tx) => {
      await this.insertRun(tx, {
        id: runId,
        periodStart,
        periodEnd,
        razorpaySource: 'synthetic',
        demo: true,
      });
      const reports = {
        ledger: await this.applyCsv(
          tx,
          runId,
          ledger,
          describeUpload({ buffer: ledgerFile, originalName: 'ledger.csv' }),
        ),
        bank: await this.applyCsv(
          tx,
          runId,
          bank,
          describeUpload({ buffer: bankFile, originalName: 'bank_statement.csv' }),
        ),
        razorpay: await this.applyRazorpay(tx, runId, synthetic, {
          from: periodStart,
          to: periodEnd,
          settlementsThrough: periodEnd,
        }),
      };
      // Read the run back: the imports moved it on from `created`, and the caller should see that.
      const [run] = await tx.select().from(reconRuns).where(eq(reconRuns.id, runId));
      if (!run) throw new Error('the demo run vanished inside its own transaction');
      return { run: toRunView(run), reports };
    });
  }

  private async readDemoFile(dir: string, name: string): Promise<Buffer> {
    try {
      return await readFile(join(dir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ServiceUnavailableException(`demo data is not generated; run: ${DEMO_COMMAND}`);
      }
      throw err;
    }
  }
}
