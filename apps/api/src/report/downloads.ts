// The files a finance person takes away: the run report (JSON and CSV), the exceptions, and the journal
// entries the agent drafted. They are built from the same reads the console shows, so a download can never
// disagree with the page. Amounts are plain rupees with two decimals in CSV (a spreadsheet can sum them)
// and integer-paise strings in JSON. Every text cell goes through `csvCell`, which defuses formulas.
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../db/db.module.js';
import type { Executor } from '../db/executor.js';
import { agentProposals, reconExceptions, reviews } from '../db/schema.js';
import { type Cell, plainRupees, toCsv } from './csv.js';
import { authorOf, ReportService } from './report.service.js';

const PAGE = 200;
/** A CSV past this is not something to open in a spreadsheet; the response says how many rows it left out. */
export const MAX_EXPORT_ROWS = 20_000;

export interface DownloadFile {
  readonly filename: string;
  readonly contentType: string;
  readonly body: string;
  /** Rows the file left out because of MAX_EXPORT_ROWS. Zero for every run this project produces. */
  readonly omitted: number;
}

type Items = Awaited<ReturnType<ReportService['exceptions']>>['items'];

// What the agent stored, as it was stored: integer paise as digit strings.
const storedEntry = z.object({
  memo: z.string(),
  lines: z.array(
    z.object({
      account: z.string(),
      debit: z.string().regex(/^\d+$/),
      credit: z.string().regex(/^\d+$/),
    }),
  ),
});

const rupees = (paiseText: string): string => plainRupees(BigInt(paiseText));
const percent = (share: number | null): string => (share === null ? '' : (share * 100).toFixed(1));
const shortId = (id: string): string => id.slice(0, 8);

@Injectable()
export class DownloadService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    private readonly report: ReportService,
  ) {}

  private async everyException(runId: string): Promise<{ items: Items; omitted: number }> {
    const items: Items = [];
    let total = 0;
    for (let offset = 0; offset < MAX_EXPORT_ROWS; offset += PAGE) {
      const page = await this.report.exceptions(runId, { filter: 'all', limit: PAGE, offset });
      total = page.total;
      items.push(...page.items);
      if (offset + PAGE >= page.total) break;
    }
    return { items, omitted: Math.max(0, total - items.length) };
  }

  // --- the run report -------------------------------------------------------------------------------------

  async reportJson(runId: string): Promise<DownloadFile> {
    const overview = await this.report.overview(runId);
    const { items, omitted } = await this.everyException(runId);
    const journal = await this.journalLines(runId);
    const body = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: 'Synthetic data and Razorpay test mode. Amounts are integer paise, as strings.',
        overview,
        exceptions: items,
        journalEntries: journal,
      },
      null,
      2,
    );
    return {
      filename: `ziro-${shortId(runId)}-report.json`,
      contentType: 'application/json; charset=utf-8',
      body,
      omitted,
    };
  }

  async reportCsv(runId: string): Promise<DownloadFile> {
    const o = await this.report.overview(runId);
    const rows: Cell[][] = [];
    const add = (section: string, item: string, count: Cell, paise: string | null, note = '') =>
      rows.push([section, item, count, paise === null ? '' : rupees(paise), note]);

    add('source', 'ledger entries', o.sources.ledger.records, o.sources.ledger.amountPaise);
    add(
      'source',
      'payments captured',
      o.sources.payments.captured,
      o.sources.payments.capturedPaise,
      `${o.sources.payments.records} payments in all`,
    );
    add('source', 'payment fees (GST included)', null, o.sources.payments.feesPaise);
    add('source', 'refunds', o.sources.refunds.records, o.sources.refunds.amountPaise);
    add('source', 'settlements', o.sources.settlements.records, o.sources.settlements.amountPaise);
    add(
      'source',
      'bank credits',
      o.sources.bank.credits.records,
      o.sources.bank.credits.amountPaise,
    );
    add('source', 'bank debits', o.sources.bank.debits.records, o.sources.bank.debits.amountPaise);

    for (const c of o.coverage) {
      add(
        'coverage',
        c.type,
        c.total,
        null,
        `matched ${c.matched}; in an exception ${c.inException}; ignored ${c.ignored}; match rate ${percent(c.matchRate)}%`,
      );
    }
    for (const t of o.matching.byTier) {
      add(
        'match',
        t.label,
        t.records,
        null,
        `${t.groups} groups; ${percent(t.share)}% of matched records`,
      );
    }

    add('gap', 'still open', o.gap.cases.open, o.gap.openPaise);
    add('gap', 'proposed, awaiting a person', o.gap.cases.awaiting, o.gap.awaitingPaise);
    add(
      'gap',
      'unreconciled (open + awaiting)',
      null,
      o.gap.gapPaise,
      'the number to bring to zero',
    );
    add('gap', 'explained', o.gap.cases.explained, o.gap.explainedPaise);

    for (const r of o.exceptionsByReason) {
      add(
        'exceptions',
        r.reasonCode,
        r.total,
        null,
        `open ${r.open}; proposed ${r.proposed}; resolved ${r.resolved}; dismissed ${r.dismissed}`,
      );
    }
    add(
      'agent',
      o.llm.agent ?? 'none',
      o.llm.calls,
      null,
      `model cost ${o.llm.costUsd} USD; ${o.llm.tokensIn} tokens in; ${o.llm.tokensOut} tokens out`,
    );
    add(
      'time',
      'run',
      null,
      null,
      o.time.seconds === null ? 'not finished' : `${o.time.seconds} s`,
    );

    return {
      filename: `ziro-${shortId(runId)}-report.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: toCsv(['section', 'item', 'count', 'amount_inr', 'note'], rows),
      omitted: 0,
    };
  }

  // --- the exceptions -------------------------------------------------------------------------------------

  async exceptionsCsv(runId: string): Promise<DownloadFile> {
    const { items, omitted } = await this.everyException(runId);
    const rows = items.map((e): Cell[] => [
      e.id,
      e.reasonCode,
      e.status,
      e.cause,
      rupees(e.amountAtStakePaise),
      e.subject?.type,
      e.subject?.key,
      e.subject === null || e.subject === undefined ? '' : rupees(e.subject.amountPaise),
      e.subject?.date,
      e.candidates,
      e.proposal?.verdict,
      e.proposal?.reasonCode,
      e.proposal?.confidence,
      e.proposal?.suggestedAction,
      e.proposal?.author,
      e.proposal?.verifier,
      e.review?.decision,
      e.review?.reviewer,
      e.note,
    ]);
    return {
      filename: `ziro-${shortId(runId)}-exceptions.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: toCsv(
        [
          'exception_id',
          'reason_code',
          'status',
          'cause',
          'amount_at_stake_inr',
          'subject_type',
          'subject_key',
          'subject_amount_inr',
          'subject_date',
          'candidates',
          'proposal_verdict',
          'proposal_reason_code',
          'proposal_confidence',
          'suggested_action',
          'proposed_by',
          'verifier',
          'review_decision',
          'reviewed_by',
          'rule_note',
        ],
        rows,
      ),
      omitted,
    };
  }

  // --- the journal entries --------------------------------------------------------------------------------

  /**
   * One line per journal line, for the latest proposal of each exception. A draft the verifier refused is
   * not listed (it is not something to post), and a person's rejection is shown as such. Every entry
   * balances to the paise because the schema that stored it required that.
   */
  private async journalLines(runId: string) {
    const proposals = await this.db
      .select({ p: agentProposals, e: reconExceptions })
      .from(agentProposals)
      .innerJoin(reconExceptions, eq(reconExceptions.id, agentProposals.exceptionId))
      .where(and(eq(reconExceptions.runId, runId)))
      .orderBy(desc(agentProposals.attempt), desc(agentProposals.createdAt));
    const latest = new Map<string, (typeof proposals)[number]>();
    for (const row of proposals) if (!latest.has(row.e.id)) latest.set(row.e.id, row);

    const withEntry = [...latest.values()].filter(
      (r) => r.p.draftJournalEntry !== null && r.p.verifierStatus !== 'rejected',
    );
    if (withEntry.length === 0) return [];

    const decisions = await this.db
      .select()
      .from(reviews)
      .where(
        inArray(
          reviews.proposalId,
          withEntry.map((r) => r.p.id),
        ),
      );
    const subjects = await this.report.describe(
      new Map([
        [
          'ledger_entry',
          withEntry.filter((r) => r.e.subjectType === 'ledger_entry').map((r) => r.e.subjectId),
        ],
        [
          'rzp_payment',
          withEntry.filter((r) => r.e.subjectType === 'rzp_payment').map((r) => r.e.subjectId),
        ],
        [
          'rzp_refund',
          withEntry.filter((r) => r.e.subjectType === 'rzp_refund').map((r) => r.e.subjectId),
        ],
        [
          'rzp_settlement',
          withEntry.filter((r) => r.e.subjectType === 'rzp_settlement').map((r) => r.e.subjectId),
        ],
        [
          'bank_line',
          withEntry.filter((r) => r.e.subjectType === 'bank_line').map((r) => r.e.subjectId),
        ],
      ]),
    );

    // A stable order, so the same run always numbers its entries the same way.
    withEntry.sort((a, b) =>
      (subjects.get(a.e.subjectId)?.key ?? a.e.id).localeCompare(
        subjects.get(b.e.subjectId)?.key ?? b.e.id,
      ),
    );
    return withEntry.flatMap((row, index) => {
      const entry = storedEntry.parse(row.p.draftJournalEntry);
      const decision = decisions.find((d) => d.proposalId === row.p.id)?.decision;
      const state =
        decision === 'approved'
          ? 'approved'
          : decision === 'rejected'
            ? 'rejected by a person'
            : 'awaiting review';
      const number = `JE-${String(index + 1).padStart(4, '0')}`;
      return entry.lines.map((line) => ({
        entry: number,
        exceptionId: row.e.id,
        reasonCode: row.p.reasonCode,
        about: subjects.get(row.e.subjectId)?.key ?? '',
        memo: entry.memo,
        account: line.account,
        debitPaise: line.debit,
        creditPaise: line.credit,
        proposedBy: authorOf(row.p.model),
        state,
      }));
    });
  }

  async journalCsv(runId: string): Promise<DownloadFile> {
    await this.report.run(runId);
    const lines = await this.journalLines(runId);
    return {
      filename: `ziro-${shortId(runId)}-journal-entries.csv`,
      contentType: 'text/csv; charset=utf-8',
      body: toCsv(
        [
          'entry',
          'exception_id',
          'reason_code',
          'about',
          'memo',
          'account',
          'debit_inr',
          'credit_inr',
          'proposed_by',
          'state',
        ],
        lines.map((l): Cell[] => [
          l.entry,
          l.exceptionId,
          l.reasonCode,
          l.about,
          l.memo,
          l.account,
          rupees(l.debitPaise),
          rupees(l.creditPaise),
          l.proposedBy,
          l.state,
        ]),
      ),
      omitted: 0,
    };
  }
}
