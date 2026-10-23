// The files a finance person takes away: the run report (JSON and CSV), the exceptions with the next step
// for each, and the vouchers for the books. They are built from the same reads the console shows, so a
// download can never disagree with the page. Amounts are plain rupees with two decimals in CSV (a
// spreadsheet can sum them) and integer-paise strings in JSON. Every text cell goes through `csvCell`,
// which defuses formulas. The voucher formats are described in ADR-014.
import { Injectable } from '@nestjs/common';
import { type Cell, plainRupees, toCsv } from './csv.js';
import { ReportService } from './report.service.js';
import { LINE_HEADER, lineRows, PAIR_HEADER, pairRows, type Voucher } from './tally.js';

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

const rupees = (paiseText: string): string => plainRupees(BigInt(paiseText));
const percent = (share: number | null): string => (share === null ? '' : (share * 100).toFixed(1));
const shortId = (id: string): string => id.slice(0, 8);
const csvFile = (runId: string, name: string, body: string, omitted = 0): DownloadFile => ({
  filename: `ziro-${shortId(runId)}-${name}.csv`,
  contentType: 'text/csv; charset=utf-8',
  body,
  omitted,
});

const voucherJson = (v: Voucher) => ({
  ...v,
  debits: v.debits.map((l) => ({ ledger: l.ledger, paise: l.paise.toString() })),
  credits: v.credits.map((l) => ({ ledger: l.ledger, paise: l.paise.toString() })),
});

@Injectable()
export class DownloadService {
  constructor(private readonly report: ReportService) {}

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
    const books = await this.report.vouchers(runId);
    const body = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: 'Synthetic data and Razorpay test mode. Amounts are integer paise, as strings.',
        overview,
        exceptions: items,
        vouchers: books.vouchers.map(voucherJson),
        notBooked: books.skipped,
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

    // matched + in an exception + ignored = total, for records and for money, per source.
    for (const c of o.coverage) {
      add('coverage', `${c.type}: total`, c.total, c.amountPaise.total);
      add('coverage', `${c.type}: matched`, c.matched, c.amountPaise.matched);
      add('coverage', `${c.type}: in an exception`, c.inException, c.amountPaise.inException);
      add(
        'coverage',
        `${c.type}: ignored`,
        c.ignored,
        c.amountPaise.ignored,
        `match rate ${percent(c.matchRate)}%; ${c.reconciles ? 'adds up' : 'DOES NOT ADD UP'}`,
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
    const r = o.resolution;
    add('resolved by', 'rules (groups)', r.ruleGroups, null);
    add('resolved by', 'agent match approved by a person', r.agentMatchesApprovedByPerson, null);
    add(
      'resolved by',
      'agent explanation approved by a person',
      r.agentExplanationsApprovedByPerson,
      null,
    );
    add('resolved by', 'agent auto-accepted', r.autoAccepted, null);
    add('resolved by', 'proposal rejected by a person', r.rejectedByPerson, null);
    add('resolved by', 'dismissed', r.dismissed, null);
    add('resolved by', 'waiting for a person', r.waiting, null);

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
    for (const b of o.openExceptions.byAge) {
      add('open by age', b.bucket, b.cases, b.stakePaise, `as of ${o.openExceptions.asOf}`);
    }

    for (const x of o.exceptionsByReason) {
      add(
        'exceptions',
        x.reasonCode,
        x.total,
        null,
        `open ${x.open}; proposed ${x.proposed}; resolved ${x.resolved}; dismissed ${x.dismissed}`,
      );
    }

    const l = o.leakage;
    add(
      'fee leakage',
      'fees charged above contract (GST included)',
      l.overchargedCount,
      l.excessPaise,
      `${l.assessed} payments assessed, ${l.notAssessable} not assessable; contract ${l.contract.source}`,
    );
    add('fee leakage', '  of which base fee', null, l.excessBasePaise);
    add('fee leakage', '  of which GST on the excess', null, l.excessGstPaise);
    add(
      'fee leakage',
      'fees charged below contract (not netted)',
      l.undercharged.count,
      l.undercharged.shortfallPaise,
    );
    for (const m of l.byMethod) {
      add(
        'fee leakage',
        `method ${m.method}`,
        m.overchargedCount,
        m.excessPaise,
        `${m.assessed} assessed`,
      );
    }

    add('delayed settlements', 'delayed', o.delays.delayedCount, o.delays.delayedPaise);
    add(
      'delayed settlements',
      'overdue: no bank credit yet',
      o.delays.overdueCount,
      o.delays.overduePaise,
      `as of ${o.run.asOf}`,
    );

    add(
      'books',
      'settlements booked',
      o.journal.settlementsBooked,
      null,
      `${o.journal.vouchers} vouchers incl. ${o.journal.adjustmentsBooked} approved adjustments`,
    );
    add(
      'books',
      'settlements not yet bookable',
      o.journal.settlementsNotBooked.count,
      o.journal.settlementsNotBooked.paise,
      'no matched bank credit, or lines do not add up',
    );
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

    return csvFile(
      runId,
      'report',
      toCsv(['section', 'item', 'count', 'amount_inr', 'note'], rows),
    );
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
      e.ageDays,
      e.asOf,
      e.candidates,
      e.suggestedAction,
      e.nextStep,
      e.proposal?.verdict,
      e.proposal?.reasonCode,
      e.proposal?.confidence,
      e.proposal?.author,
      e.proposal?.degradedLabel,
      e.proposal?.verifier,
      e.review?.decision,
      e.review?.reviewer,
      e.note,
    ]);
    return csvFile(
      runId,
      'exceptions',
      toCsv(
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
          'age_days',
          'as_of',
          'candidates',
          'suggested_action',
          'next_step',
          'proposal_verdict',
          'proposal_reason_code',
          'proposal_confidence',
          'proposed_by',
          'agent_stopped_because',
          'verifier',
          'review_decision',
          'reviewed_by',
          'rule_note',
        ],
        rows,
      ),
      omitted,
    );
  }

  // --- the vouchers ---------------------------------------------------------------------------------------

  /** One row per debit/credit pair. */
  async journalCsv(runId: string): Promise<DownloadFile> {
    const { vouchers } = await this.report.vouchers(runId);
    return csvFile(runId, 'journal-entries', toCsv(PAIR_HEADER, vouchers.flatMap(pairRows)));
  }

  /** One row per ledger line: the layout TallyPrime's Excel import maps column by column. */
  async journalLinesCsv(runId: string): Promise<DownloadFile> {
    const { vouchers } = await this.report.vouchers(runId);
    return csvFile(
      runId,
      'journal-lines-for-tally',
      toCsv(LINE_HEADER, vouchers.flatMap(lineRows)),
    );
  }
}
