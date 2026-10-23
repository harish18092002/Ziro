// What the console shows about a run, read from the tables as they are: nothing here is stored
// separately, so a page can never disagree with the data. Money is integer paise throughout and travels
// as strings (a JSON number is a float). Free text (explanations, memos, narrations) is returned as the
// text it is: the page renders it as text and never as markup.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RecordType } from '@ziro/core/domain';
import { and, asc, count, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { DEGRADED_LABEL, DEGRADED_REASONS, type DegradedReason } from '../agent/degraded.js';
import { skipReason } from '../agent/triage.js';
import { DB } from '../db/db.module.js';
import type { Executor } from '../db/executor.js';
import {
  agentProposals,
  bankLines,
  ledgerEntries,
  llmCalls,
  reconExceptions,
  reconRuns,
  reviews,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
  settlementItems,
} from '../db/schema.js';
import { PLANTED_MODEL, SCRIPTED_MODEL } from '../demo/scripted-runner.js';
import { gapsOf } from '../ingest/gaps.js';
import { ReviewService } from '../review/review.service.js';
import { composeLines, isChargebackLine } from '@ziro/core/matcher';
import { paise } from '@ziro/core/money';
import { istBusinessDate } from '@ziro/core/time';
import { feeContractOf } from '../common/fee-contract.js';
import { verifierConfigOf } from '../common/verifier-config.js';
import { itemOf, paymentOf, refundOf } from '../recon/records.js';
import { type DelayReport, daysBetween, findDelays, type SettlementFacts } from './delays.js';
import { type Gap, type GapItem, casesOf, gapOf } from './gap.js';
import { auditFees } from './leakage.js';
import { nextStepOf } from './next-step.js';
import {
  type ApprovedDraft,
  adjustmentVoucher,
  ledgerNamesOf,
  type SettlementBooking,
  settlementVouchers,
  storedEntrySchema,
  type Voucher,
} from './tally.js';

/** `harness` is nobody's conclusion: the system handed the exception to a person (see agent/degraded.ts). */
export type Author = 'scripted' | 'planted' | 'model' | 'harness';
export const authorOf = (model: string | null, degraded: string | null = null): Author =>
  degraded !== null
    ? 'harness'
    : model === SCRIPTED_MODEL
      ? 'scripted'
      : model === PLANTED_MODEL
        ? 'planted'
        : 'model';

/** The words for a stored degraded code; null for none (or a code from a newer version than this one). */
const degradedLabelOf = (code: string | null): string | null =>
  code === null ? null : (DEGRADED_LABEL[code as DegradedReason] ?? code);

export interface Described {
  readonly type: RecordType;
  readonly id: string;
  /** The record's own key: order reference, Razorpay id, or statement row. */
  readonly key: string;
  readonly amountPaise: string;
  readonly date: string | null;
  /** One line of context: method and status, direction and UTR, and so on. */
  readonly detail: string;
}

export type ExceptionFilter =
  'all' | 'waiting' | 'refused' | 'unexamined' | 'resolved' | 'degraded';
export interface ExceptionQuery {
  readonly filter: ExceptionFilter;
  readonly reason?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;
const TIER_LABEL: Record<string, string> = {
  T1: 'Ledger entry to payment: same order reference, same amount',
  T3: 'Settlement to bank credit: same UTR, same amount',
  T4: 'Settlement to bank credit: same amount, inside the window, only one candidate',
};

const AGE_BUCKETS = [
  { bucket: '0-7 days', from: 0, to: 7 },
  { bucket: '8-30 days', from: 8, to: 30 },
  { bucket: '31+ days', from: 31, to: Number.POSITIVE_INFINITY },
] as const;
const UNKNOWN_AGE = 'age unknown';

/** Unsettled cases (open or awaiting a person) by the age of their oldest exception. */
function ageBuckets(items: readonly GapItem[]) {
  const sums = new Map<string, { cases: number; stakePaise: bigint }>();
  let oldestDays: number | null = null;
  for (const c of casesOf(items)) {
    if (c.status === 'explained') continue;
    const label =
      c.ageDays === null
        ? UNKNOWN_AGE
        : (AGE_BUCKETS.find((b) => c.ageDays !== null && c.ageDays <= b.to)?.bucket ?? UNKNOWN_AGE);
    if (c.ageDays !== null) oldestDays = Math.max(oldestDays ?? 0, c.ageDays);
    const sum = sums.get(label) ?? { cases: 0, stakePaise: 0n };
    sums.set(label, { cases: sum.cases + 1, stakePaise: sum.stakePaise + c.stakePaise });
  }
  const buckets = [...AGE_BUCKETS.map((b) => b.bucket), UNKNOWN_AGE]
    .map((bucket) => ({ bucket, ...(sums.get(bucket) ?? { cases: 0, stakePaise: 0n }) }))
    .filter((b) => b.cases > 0);
  return { buckets, oldestDays };
}

function delayView(d: DelayReport) {
  const sum = (rows: readonly { amountPaise: bigint }[]) =>
    rows.reduce((n, r) => n + r.amountPaise, 0n).toString();
  return {
    delayedCount: d.delayed.length,
    delayedPaise: sum(d.delayed),
    delayed: d.delayed.map((s) => ({ ...s, amountPaise: s.amountPaise.toString() })),
    overdueCount: d.overdue.length,
    overduePaise: sum(d.overdue),
    overdue: d.overdue.map((s) => ({ ...s, amountPaise: s.amountPaise.toString() })),
  };
}

const ageOf = (date: string | null | undefined, asOf: string): number | null =>
  date === null || date === undefined ? null : Math.max(0, daysBetween(date, asOf));

interface PartitionRow {
  total_n: number;
  total_p: string;
  matched_n: number;
  matched_p: string;
  excepted_n: number;
  excepted_p: string;
  ignored_n: number;
  ignored_p: string;
}
const NO_ROWS: PartitionRow = {
  total_n: 0,
  total_p: '0',
  matched_n: 0,
  matched_p: '0',
  excepted_n: 0,
  excepted_p: '0',
  ignored_n: 0,
  ignored_p: '0',
};

/** jsonb arrives parsed from some drivers and as text from others. */
const parsedJson = (value: unknown): unknown =>
  typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

/** Accepted payout groups: which settlement was paid by which bank credit. */
const payoutCte = (runId: string): SQL => sql`payout as (
  select ml_s.settlement_id sid, ml_b.bank_line_id bid
  from match_links ml_s
  join match_groups g on g.id = ml_s.group_id
  join match_links ml_b on ml_b.group_id = ml_s.group_id and ml_b.bank_line_id is not null
  where ml_s.settlement_id is not null and g.run_id = ${runId}
    and g.status = 'accepted' and g.kind::text = 'payout')`;

const IN_CHUNK = 1_000;
async function loadIn<T>(ids: readonly string[], load: (chunk: string[]) => Promise<T[]>) {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK)
    out.push(...(await load(ids.slice(i, i + IN_CHUNK))));
  return out;
}

@Injectable()
export class ReportService {
  constructor(
    @Inject(DB) private readonly db: Executor,
    private readonly review: ReviewService,
  ) {}

  async run(runId: string) {
    const [run] = await this.db.select().from(reconRuns).where(eq(reconRuns.id, runId));
    if (run === undefined) throw new NotFoundException('no such run');
    return run;
  }

  // --- describing records ------------------------------------------------------------------------------------

  /** Keys, amounts and dates for any mix of records, in as few queries as there are types. */
  async describe(ids: Map<RecordType, string[]>): Promise<Map<string, Described>> {
    const out = new Map<string, Described>();
    const ask = async <T extends { id: string }>(
      type: RecordType,
      load: (list: string[]) => Promise<T[]>,
      view: (row: T) => Omit<Described, 'type' | 'id'>,
    ) => {
      const list = [...new Set(ids.get(type) ?? [])];
      if (list.length === 0) return;
      for (const row of await load(list)) out.set(row.id, { type, id: row.id, ...view(row) });
    };
    await Promise.all([
      ask(
        'ledger_entry',
        (l) => this.db.select().from(ledgerEntries).where(inArray(ledgerEntries.id, l)),
        (r) => ({
          key: r.orderRef,
          amountPaise: r.amountPaise.toString(),
          date: r.businessDate,
          detail: r.customerRef ?? '',
        }),
      ),
      ask(
        'rzp_payment',
        (l) => this.db.select().from(rzpPayments).where(inArray(rzpPayments.id, l)),
        (r) => ({
          key: r.rzpId,
          amountPaise: r.amountPaise.toString(),
          date: r.businessDate,
          detail: `${r.method}, ${r.status}${r.receipt ? `, receipt ${r.receipt}` : ''}`,
        }),
      ),
      ask(
        'rzp_refund',
        (l) => this.db.select().from(rzpRefunds).where(inArray(rzpRefunds.id, l)),
        (r) => ({
          key: r.rzpId,
          amountPaise: r.amountPaise.toString(),
          date: r.businessDate,
          detail: `refund of ${r.rzpPaymentId}, ${r.status}`,
        }),
      ),
      ask(
        'rzp_settlement',
        (l) => this.db.select().from(rzpSettlements).where(inArray(rzpSettlements.id, l)),
        (r) => ({
          key: r.rzpId,
          amountPaise: r.amountPaise.toString(),
          date: r.businessDate,
          detail: `UTR ${r.utr ?? 'none'}`,
        }),
      ),
      ask(
        'bank_line',
        (l) => this.db.select().from(bankLines).where(inArray(bankLines.id, l)),
        (r) => ({
          key: r.sourceRef,
          amountPaise: r.amountPaise.toString(),
          date: r.valueDate,
          detail: `${r.direction}, UTR ${r.utr ?? 'none'}${r.utrQuality ? ` (${r.utrQuality})` : ''}`,
        }),
      ),
    ]);
    return out;
  }

  private async describeRefs(refs: readonly { recordType: RecordType; recordId: string }[]) {
    const ids = new Map<RecordType, string[]>();
    for (const ref of refs)
      ids.set(ref.recordType, [...(ids.get(ref.recordType) ?? []), ref.recordId]);
    return this.describe(ids);
  }

  // --- the run summary ---------------------------------------------------------------------------------------------

  async overview(runId: string) {
    const run = await this.run(runId);
    const pipeline =
      (run.config as { pipeline?: Record<string, unknown>; demo?: Record<string, unknown> }) ?? {};

    const [ledger] = rowsOf<{ n: number; amount: string }>(
      await this.db.execute(
        sql`select count(*)::int n, coalesce(sum(amount_paise),0)::text amount from ledger_entries where run_id = ${runId}`,
      ),
    );
    const [payments] = rowsOf<{ n: number; captured: number; amount: string; fees: string }>(
      await this.db
        .execute(sql`select count(*)::int n, count(*) filter (where captured)::int captured,
        coalesce(sum(amount_paise) filter (where captured),0)::text amount,
        coalesce(sum(fee_paise) filter (where captured),0)::text fees from rzp_payments where run_id = ${runId}`),
    );
    const [refunds] = rowsOf<{ n: number; amount: string }>(
      await this.db.execute(
        sql`select count(*)::int n, coalesce(sum(amount_paise),0)::text amount from rzp_refunds where run_id = ${runId}`,
      ),
    );
    const [settlements] = rowsOf<{ n: number; amount: string }>(
      await this.db.execute(
        sql`select count(*)::int n, coalesce(sum(amount_paise),0)::text amount from rzp_settlements where run_id = ${runId}`,
      ),
    );
    const bank = rowsOf<{ direction: string; n: number; amount: string }>(
      await this.db.execute(
        sql`select direction::text, count(*)::int n, coalesce(sum(amount_paise),0)::text amount from bank_lines where run_id = ${runId} group by direction`,
      ),
    );
    const credit = bank.find((b) => b.direction === 'credit');
    const debit = bank.find((b) => b.direction === 'debit');

    // Every record ends in exactly one place: a proven group, an exception, or ignored (a failed payment,
    // a bank debit, a credit that is not a Razorpay payout). Counted and summed independently, so the
    // identity matched + exception + ignored = total is a check, not a definition.
    const coverage = await this.partition(runId);

    const tiers = rowsOf<{
      basis: string;
      tier: string | null;
      kind: string;
      groups: number;
      records: number;
    }>(
      await this.db.execute(sql`select g.basis::text basis, g.tier::text tier, g.kind::text kind,
        count(distinct g.id)::int groups, count(ml.id)::int records
        from match_groups g join match_links ml on ml.group_id = g.id
        where g.run_id = ${runId} and g.status = 'accepted' group by 1,2,3 order by 1,2,3`),
    );
    const matchedRecords = tiers.reduce((sum, t) => sum + t.records, 0);
    const approvals = rowsOf<{ kind: string; n: number }>(
      await this.db.execute(sql`select reviewer_kind::text kind, count(*)::int n from reviews
        where run_id = ${runId} and decision = 'approved' group by 1`),
    );

    const byReason = await this.db
      .select({ reason: reconExceptions.reasonCode, status: reconExceptions.status, n: count() })
      .from(reconExceptions)
      .where(eq(reconExceptions.runId, runId))
      .groupBy(reconExceptions.reasonCode, reconExceptions.status);
    const reasons = new Map<
      string,
      {
        reasonCode: string;
        total: number;
        open: number;
        proposed: number;
        resolved: number;
        dismissed: number;
      }
    >();
    for (const row of byReason) {
      const entry = reasons.get(row.reason) ?? {
        reasonCode: row.reason,
        total: 0,
        open: 0,
        proposed: 0,
        resolved: 0,
        dismissed: 0,
      };
      entry[row.status] += row.n;
      entry.total += row.n;
      reasons.set(row.reason, entry);
    }

    const asOf = run.periodEnd;
    const items = await this.exceptionFacts(runId, asOf);
    const gap = gapOf(items);
    const openByAge = ageBuckets(items);
    const dismissed = [...reasons.values()].reduce((n, r) => n + r.dismissed, 0);
    const waiting = [...reasons.values()].reduce((n, r) => n + r.proposed, 0);

    const [llm] = await this.db
      .select({
        calls: count(),
        cost: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text`,
        latency: sql<number>`coalesce(sum(${llmCalls.latencyMs}), 0)::int`,
        tokensIn: sql<number>`coalesce(sum(${llmCalls.tokensIn} + ${llmCalls.cacheReadTokens} + ${llmCalls.cacheWriteTokens}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${llmCalls.tokensOut}), 0)::int`,
      })
      .from(llmCalls)
      .where(eq(llmCalls.runId, runId));

    const started =
      (pipeline.pipeline?.['startedAt'] as string | undefined) ?? run.createdAt.toISOString();
    const finishedText = pipeline.pipeline?.['finishedAt'] as string | undefined;
    const agent = (pipeline.pipeline?.['agent'] as string | undefined) ?? null;
    const review = await this.review.summary(runId);

    const resolved = await this.resolution(runId);
    const ruleGroups = tiers.filter((t) => t.basis === 'rule').reduce((n, t) => n + t.groups, 0);
    const facts = await this.settlementFacts(runId);
    const delays = findDelays(facts, verifierConfigOf(run.config).config, asOf);
    const books = await this.vouchers(runId);
    const bookedIds = new Set(books.booked);
    const notBooked = facts.filter((f) => !bookedIds.has(f.rzpId));
    const leakage = await this.leakage(run);
    const failures = await this.failures(runId, pipeline.pipeline);

    return {
      run: {
        id: run.id,
        status: run.status,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        asOf,
        createdAt: run.createdAt.toISOString(),
        source: run.razorpaySource,
        preset: (pipeline.demo?.['preset'] as string | undefined) ?? null,
        featured: (run.config as { featured?: string }).featured ?? null,
        stage: (pipeline.pipeline?.['stage'] as string | undefined) ?? null,
        // True when the last Razorpay import could not get everything: the exceptions that follow from
        // what is missing (a ledger entry with "no payment") may be artefacts of the gap.
        partial: gapsOf(run.config).length > 0,
        gaps: gapsOf(run.config),
      },
      failures,
      sources: {
        ledger: { records: ledger?.n ?? 0, amountPaise: ledger?.amount ?? '0' },
        payments: {
          records: payments?.n ?? 0,
          captured: payments?.captured ?? 0,
          capturedPaise: payments?.amount ?? '0',
          feesPaise: payments?.fees ?? '0',
        },
        refunds: { records: refunds?.n ?? 0, amountPaise: refunds?.amount ?? '0' },
        settlements: { records: settlements?.n ?? 0, amountPaise: settlements?.amount ?? '0' },
        bank: {
          credits: { records: credit?.n ?? 0, amountPaise: credit?.amount ?? '0' },
          debits: { records: debit?.n ?? 0, amountPaise: debit?.amount ?? '0' },
        },
      },
      coverage,
      reconciles: coverage.every((c) => c.reconciles),
      matching: {
        matchedRecords,
        byTier: tiers.map((t) => ({
          basis: t.basis,
          tier: t.tier,
          kind: t.kind,
          label:
            t.basis === 'rule' && t.tier
              ? (TIER_LABEL[t.tier] ?? t.tier)
              : t.basis === 'agent'
                ? 'Agent proposal, approved'
                : 'Approved by a person',
          groups: t.groups,
          records: t.records,
          share: matchedRecords === 0 ? 0 : t.records / matchedRecords,
        })),
        approvedByPerson: approvals.find((a) => a.kind === 'human')?.n ?? 0,
        autoAccepted: approvals.find((a) => a.kind === 'auto_accept')?.n ?? 0,
      },
      gap: {
        gapPaise: gap.gapPaise.toString(),
        openPaise: gap.openPaise.toString(),
        awaitingPaise: gap.awaitingPaise.toString(),
        explainedPaise: gap.explainedPaise.toString(),
        cases: gap.cases,
      } satisfies Record<keyof Omit<Gap, never>, unknown>,
      exceptionsByReason: [...reasons.values()].sort(
        (a, b) => b.total - a.total || a.reasonCode.localeCompare(b.reasonCode),
      ),
      resolution: { ruleGroups, ...resolved, dismissed, waiting },
      openExceptions: {
        asOf,
        count: items.filter((i) => i.status === 'open' || i.status === 'proposed').length,
        oldestDays: openByAge.oldestDays,
        byAge: openByAge.buckets.map((b) => ({ ...b, stakePaise: b.stakePaise.toString() })),
      },
      leakage,
      delays: delayView(delays),
      journal: {
        vouchers: books.vouchers.length,
        settlementsBooked: books.booked.length,
        adjustmentsBooked: books.vouchers.filter((v) => v.source === 'agent adjustment').length,
        settlementsNotBooked: {
          count: notBooked.length,
          paise: notBooked.reduce((sum, f) => sum + f.amountPaise, 0n).toString(),
        },
        skipped: books.skipped,
      },
      review,
      llm: {
        agent,
        calls: llm?.calls ?? 0,
        costUsd: llm?.cost ?? '0',
        latencyMs: llm?.latency ?? 0,
        tokensIn: llm?.tokensIn ?? 0,
        tokensOut: llm?.tokensOut ?? 0,
      },
      time: {
        startedAt: started,
        finishedAt: finishedText ?? null,
        seconds: finishedText
          ? Math.round((Date.parse(finishedText) - Date.parse(started)) / 100) / 10
          : null,
      },
    };
  }

  /**
   * What went wrong on the way and was handled: investigations handed to a person without a conclusion
   * (by reason), why the agent stopped early or a job failed, and whether the demo broke things on
   * purpose. Counted from the proposals, so it cannot disagree with the exceptions table.
   */
  private async failures(runId: string, pipeline: Record<string, unknown> | undefined) {
    const rows = await this.db
      .select({ reason: agentProposals.degraded, n: count() })
      .from(agentProposals)
      .where(and(eq(agentProposals.runId, runId), isNotNull(agentProposals.degraded)))
      .groupBy(agentProposals.degraded);
    const byReason = DEGRADED_REASONS.flatMap((reason) => {
      const n = rows.find((r) => r.reason === reason)?.n ?? 0;
      return n === 0 ? [] : [{ reason, label: DEGRADED_LABEL[reason], count: n }];
    });
    const chaos = pipeline?.['chaos'] as
      { timeoutFor: string | null; malformedFor: string | null } | undefined;
    return {
      handedToAPerson: byReason.reduce((sum, r) => sum + r.count, 0),
      byReason,
      // The demo toggle broke these on purpose (null for an ordinary run).
      injected: chaos ?? null,
      // "the agent stopped early: ..." or "1 investigation job failed ...", in the pipeline's own words.
      note: (pipeline?.['note'] as string | undefined) ?? null,
    };
  }

  // --- the exceptions table --------------------------------------------------------------------------------------------

  private condition(runId: string, q: ExceptionQuery): SQL {
    const parts: SQL[] = [eq(reconExceptions.runId, runId)];
    if (q.reason) parts.push(sql`${reconExceptions.reasonCode}::text = ${q.reason}`);
    switch (q.filter) {
      case 'waiting':
        parts.push(eq(reconExceptions.status, 'proposed'));
        break;
      case 'resolved':
        parts.push(eq(reconExceptions.status, 'resolved'));
        break;
      case 'refused':
        parts.push(
          sql`exists (select 1 from agent_proposals p where p.exception_id = ${reconExceptions.id} and p.verifier_status = 'rejected')`,
        );
        break;
      case 'unexamined':
        parts.push(eq(reconExceptions.status, 'open'));
        parts.push(
          sql`not exists (select 1 from agent_proposals p where p.exception_id = ${reconExceptions.id})`,
        );
        break;
      case 'degraded':
        parts.push(
          sql`exists (select 1 from agent_proposals p where p.exception_id = ${reconExceptions.id} and p.degraded is not null)`,
        );
        break;
      case 'all':
        break;
    }
    return and(...parts) as SQL;
  }

  async exceptions(runId: string, q: ExceptionQuery) {
    const run = await this.run(runId);
    const where = this.condition(runId, q);
    const [{ n: total } = { n: 0 }] = await this.db
      .select({ n: count() })
      .from(reconExceptions)
      .where(where);
    const rows = await this.db
      .select()
      .from(reconExceptions)
      .where(where)
      .orderBy(desc(sql`abs(${reconExceptions.amountAtStakePaise})`), asc(reconExceptions.id))
      .limit(q.limit)
      .offset(q.offset);
    const items = await this.rowsToItems(rows, run.periodEnd);
    return { total, items };
  }

  private async rowsToItems(rows: (typeof reconExceptions.$inferSelect)[], asOf: string) {
    if (rows.length === 0) return [];
    const subjects = await this.describeRefs(
      rows.map((r) => ({ recordType: r.subjectType, recordId: r.subjectId })),
    );
    const proposals = await this.db
      .select()
      .from(agentProposals)
      .where(
        inArray(
          agentProposals.exceptionId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(agentProposals.attempt));
    const decisions = proposals.length
      ? await this.db
          .select()
          .from(reviews)
          .where(
            inArray(
              reviews.proposalId,
              proposals.map((p) => p.id),
            ),
          )
      : [];
    const latest = new Map(proposals.map((p) => [p.exceptionId, p]));
    const built = rows.map((e) => {
      const p = latest.get(e.id);
      const d = p && decisions.find((x) => x.proposalId === p.id);
      const candidates = Array.isArray(e.candidates) ? e.candidates.length : 0;
      return {
        id: e.id,
        reasonCode: e.reasonCode,
        status: e.status,
        cause: e.cause,
        note: e.note,
        amountAtStakePaise: e.amountAtStakePaise.toString(),
        subject: subjects.get(e.subjectId) ?? null,
        candidates,
        // The rules left nothing for an agent to look at (a bank credit that nothing explains).
        listedForAPerson:
          skipReason({
            id: e.id,
            cause: e.cause,
            subject: { recordType: e.subjectType, recordId: e.subjectId },
            candidates: [],
          }) !== null && candidates === 0,
        proposal: p
          ? {
              id: p.id,
              verdict: p.verdict,
              reasonCode: p.reasonCode,
              confidence: p.confidencePermille / 1000,
              suggestedAction: p.suggestedAction,
              verifier: p.verifierStatus,
              author: authorOf(p.model, p.degraded),
              degraded: p.degraded,
              degradedLabel: degradedLabelOf(p.degraded),
            }
          : null,
        review: d ? { decision: d.decision, reviewer: d.reviewer } : null,
      };
    });
    // Age runs from the subject record's business date to the run's as-of date, never to the wall clock:
    // a re-run next month must not make last month's data look a month older.
    return built.map((item) => ({
      ...item,
      ageDays: ageOf(item.subject?.date, asOf),
      asOf,
      ...nextStepOf(item),
    }));
  }

  /** One exception in full: the records, every proposal made about it with its evidence, and the decisions. */
  async exception(exceptionId: string) {
    const [e] = await this.db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.id, exceptionId));
    if (e === undefined) throw new NotFoundException('no such exception');
    const refs = [
      { recordType: e.subjectType, recordId: e.subjectId },
      ...((Array.isArray(e.candidates) ? e.candidates : []) as {
        recordType: RecordType;
        recordId: string;
      }[]),
    ];
    const proposals = await this.db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.exceptionId, e.id))
      .orderBy(asc(agentProposals.attempt));
    const linked = proposals.flatMap((p) =>
      Array.isArray(p.links) ? (p.links as { recordType: RecordType; recordId: string }[]) : [],
    );
    const described = await this.describeRefs([...refs, ...linked]);
    const decisions = proposals.length
      ? await this.db
          .select()
          .from(reviews)
          .where(
            inArray(
              reviews.proposalId,
              proposals.map((p) => p.id),
            ),
          )
      : [];
    const pick = (list: { recordId: string }[]) =>
      list.map((r) => described.get(r.recordId)).filter((d): d is Described => d !== undefined);
    const run = await this.run(e.runId);
    const [first] = await this.rowsToItems([e], run.periodEnd);
    return {
      exception: first,
      subject: described.get(e.subjectId) ?? null,
      candidates: pick(refs.slice(1)),
      proposals: proposals.map((p) => {
        const d = decisions.find((x) => x.proposalId === p.id);
        return {
          id: p.id,
          attempt: p.attempt,
          author: authorOf(p.model, p.degraded),
          model: p.model,
          degraded: p.degraded,
          degradedLabel: degradedLabelOf(p.degraded),
          verdict: p.verdict,
          reasonCode: p.reasonCode,
          confidence: p.confidencePermille / 1000,
          suggestedAction: p.suggestedAction,
          // Text a model or a script wrote from record text. The page renders it as text only.
          explanation: p.explanation,
          evidence: p.evidence,
          links: pick(Array.isArray(p.links) ? (p.links as { recordId: string }[]) : []),
          verifier: { status: p.verifierStatus, findings: p.verifierFindings },
          harnessFindings: p.harnessFindings,
          draftJournalEntry: p.draftJournalEntry,
          createdAt: p.createdAt.toISOString(),
          review: d
            ? {
                decision: d.decision,
                reviewer: d.reviewer,
                note: d.note,
                at: d.createdAt.toISOString(),
              }
            : null,
        };
      }),
    };
  }

  // --- finding a record for its audit timeline ---------------------------------------------------------------------------

  async searchRecords(runId: string, text: string) {
    await this.run(runId);
    const like = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
    const found = rowsOf<{ type: RecordType; id: string }>(
      await this.db.execute(sql`
        (select 'ledger_entry' type, id from ledger_entries where run_id = ${runId} and order_ref ilike ${like} limit 15)
        union all (select 'rzp_payment', id from rzp_payments where run_id = ${runId} and (rzp_id ilike ${like} or receipt ilike ${like}) limit 15)
        union all (select 'rzp_refund', id from rzp_refunds where run_id = ${runId} and rzp_id ilike ${like} limit 15)
        union all (select 'rzp_settlement', id from rzp_settlements where run_id = ${runId} and (rzp_id ilike ${like} or utr ilike ${like}) limit 15)
        union all (select 'bank_line', id from bank_lines where run_id = ${runId} and (source_ref ilike ${like} or utr ilike ${like}) limit 15)`),
    );
    const ids = new Map<RecordType, string[]>();
    for (const f of found) ids.set(f.type, [...(ids.get(f.type) ?? []), f.id]);
    const described = await this.describe(ids);
    return [...described.values()].sort((a, b) => a.key.localeCompare(b.key)).slice(0, 30);
  }

  // --- the figures behind the run report -----------------------------------------------------------------------------------

  /** Per source: records and paise matched, in an exception, and ignored, each counted on its own. */
  private async partition(runId: string) {
    const sources = [
      ['ledger_entry', 'ledger_entries', 'ledger_entry_id'],
      ['rzp_payment', 'rzp_payments', 'payment_id'],
      ['rzp_refund', 'rzp_refunds', 'refund_id'],
      ['rzp_settlement', 'rzp_settlements', 'settlement_id'],
      ['bank_line', 'bank_lines', 'bank_line_id'],
    ] as const;
    return Promise.all(
      sources.map(async ([type, table, linkColumn]) => {
        // Identifiers come from the constant list above, never from input.
        const [row] = rowsOf<PartitionRow>(
          await this.db.execute(sql`
            with acc as (
              select distinct ml.${sql.raw(linkColumn)} id from match_links ml
              join match_groups g on g.id = ml.group_id
              where g.run_id = ${runId} and g.status = 'accepted' and ml.${sql.raw(linkColumn)} is not null),
            ex as (select distinct subject_id id from recon_exceptions
              where run_id = ${runId} and subject_type::text = ${type})
            select count(*)::int total_n, coalesce(sum(t.amount_paise), 0)::text total_p,
              count(*) filter (where a.id is not null)::int matched_n,
              coalesce(sum(t.amount_paise) filter (where a.id is not null), 0)::text matched_p,
              count(*) filter (where a.id is null and x.id is not null)::int excepted_n,
              coalesce(sum(t.amount_paise) filter (where a.id is null and x.id is not null), 0)::text excepted_p,
              count(*) filter (where a.id is null and x.id is null)::int ignored_n,
              coalesce(sum(t.amount_paise) filter (where a.id is null and x.id is null), 0)::text ignored_p
            from ${sql.raw(table)} t
            left join acc a on a.id = t.id
            left join ex x on x.id = t.id
            where t.run_id = ${runId}`),
        );
        const r = row ?? NO_ROWS;
        return {
          type,
          total: r.total_n,
          matched: r.matched_n,
          inException: r.excepted_n,
          ignored: r.ignored_n,
          // Of the records the matcher tried to place, how many it placed.
          matchRate:
            r.matched_n + r.excepted_n === 0 ? null : r.matched_n / (r.matched_n + r.excepted_n),
          amountPaise: {
            total: r.total_p,
            matched: r.matched_p,
            inException: r.excepted_p,
            ignored: r.ignored_p,
          },
          reconciles:
            r.matched_n + r.excepted_n + r.ignored_n === r.total_n &&
            BigInt(r.matched_p) + BigInt(r.excepted_p) + BigInt(r.ignored_p) === BigInt(r.total_p),
        };
      }),
    );
  }

  /** Every exception with its stake, the records it touches and the age of its subject. */
  private async exceptionFacts(runId: string, asOf: string): Promise<GapItem[]> {
    const rows = rowsOf<{
      status: GapItem['status'];
      stake: string;
      subject_id: string;
      candidates: unknown;
      subject_date: string | null;
    }>(
      await this.db.execute(sql`
        select e.status::text status, e.amount_at_stake_paise::text stake, e.subject_id::text subject_id,
          e.candidates,
          coalesce(l.business_date, p.business_date, r.business_date, s.business_date, b.value_date)::text subject_date
        from recon_exceptions e
        left join ledger_entries l on l.id = e.subject_id and e.subject_type::text = 'ledger_entry'
        left join rzp_payments p on p.id = e.subject_id and e.subject_type::text = 'rzp_payment'
        left join rzp_refunds r on r.id = e.subject_id and e.subject_type::text = 'rzp_refund'
        left join rzp_settlements s on s.id = e.subject_id and e.subject_type::text = 'rzp_settlement'
        left join bank_lines b on b.id = e.subject_id and e.subject_type::text = 'bank_line'
        where e.run_id = ${runId}`),
    );
    return rows.map((r) => {
      const candidates = parsedJson(r.candidates);
      return {
        status: r.status,
        stakePaise: BigInt(r.stake),
        records: [
          r.subject_id,
          ...(Array.isArray(candidates)
            ? (candidates as { recordId?: string }[]).map((c) => c.recordId ?? '')
            : []),
        ],
        ageDays: ageOf(r.subject_date, asOf),
      };
    });
  }

  /** How exceptions were settled by someone: agent matches and explanations a person approved, auto-accepts. */
  private async resolution(runId: string) {
    const rows = rowsOf<{ verdict: string; kind: string; decision: string; n: number }>(
      await this.db.execute(sql`
        select p.verdict::text verdict, r.reviewer_kind::text kind, r.decision::text decision, count(*)::int n
        from reviews r join agent_proposals p on p.id = r.proposal_id
        where r.run_id = ${runId} group by 1, 2, 3`),
    );
    const n = (keep: (r: (typeof rows)[number]) => boolean) =>
      rows.filter(keep).reduce((sum, r) => sum + r.n, 0);
    const approvedByPerson = (r: (typeof rows)[number]) =>
      r.decision === 'approved' && r.kind === 'human';
    return {
      agentMatchesApprovedByPerson: n((r) => approvedByPerson(r) && r.verdict === 'MATCH_PROPOSED'),
      agentExplanationsApprovedByPerson: n(
        (r) => approvedByPerson(r) && r.verdict === 'EXPLAINED_NO_MATCH',
      ),
      autoAccepted: n((r) => r.decision === 'approved' && r.kind === 'auto_accept'),
      rejectedByPerson: n((r) => r.decision === 'rejected'),
    };
  }

  /** Fees charged above the run's contract. Deterministic; see leakage.ts. */
  private async leakage(run: typeof reconRuns.$inferSelect) {
    const rows = await this.db
      .select({
        rzpId: rzpPayments.rzpId,
        method: rzpPayments.method,
        currency: rzpPayments.currency,
        amountPaise: rzpPayments.amountPaise,
        feePaise: rzpPayments.feePaise,
        taxPaise: rzpPayments.taxPaise,
      })
      .from(rzpPayments)
      .where(and(eq(rzpPayments.runId, run.id), eq(rzpPayments.captured, true)));
    const { contract, source } = feeContractOf(run.config);
    const audit = auditFees(
      rows.map((r) => ({
        rzpId: r.rzpId,
        method: r.method,
        currency: r.currency,
        amount: r.amountPaise,
        fee: r.feePaise,
        tax: r.taxPaise,
      })),
      contract,
    );
    return {
      contract: {
        source,
        gstBps: contract.gstBps,
        feeBps: Object.fromEntries(
          Object.entries(contract.methods).map(([method, terms]) => [method, terms.feeBps]),
        ),
      },
      assessed: audit.assessed,
      notAssessable: audit.notAssessable,
      overchargedCount: audit.overcharged.count,
      excessPaise: audit.overcharged.excessPaise.toString(),
      excessBasePaise: audit.overcharged.basePaise.toString(),
      excessGstPaise: audit.overcharged.gstPaise.toString(),
      undercharged: {
        count: audit.undercharged.count,
        shortfallPaise: audit.undercharged.shortfallPaise.toString(),
      },
      gstOnlyDifferences: audit.gstOnlyDifferences,
      byMethod: audit.byMethod.map((m) => ({ ...m, excessPaise: m.excessPaise.toString() })),
      worst: audit.worst.map((w) => ({
        rzpId: w.rzpId,
        method: w.method,
        amountPaise: w.amountPaise.toString(),
        expectedFeePaise: w.expectedFeePaise.toString(),
        actualFeePaise: w.actualFeePaise.toString(),
        excessPaise: w.excessPaise.toString(),
      })),
    };
  }

  /** Each settlement with the dates of its payments and the value date of its matched bank credit. */
  private async settlementFacts(runId: string): Promise<SettlementFacts[]> {
    const rows = rowsOf<{
      id: string;
      rzp_id: string;
      business_date: string;
      amount: string;
      payment_dates: string | null;
      credit_date: string | null;
    }>(
      await this.db.execute(sql`
        with ${payoutCte(runId)}
        select s.id::text id, s.rzp_id, s.business_date::text business_date, s.amount_paise::text amount,
          (select string_agg(distinct p.business_date::text, ',') from settlement_items i
             join rzp_payments p on p.run_id = i.run_id and p.rzp_id = i.rzp_entity_id
             where i.settlement_id = s.id and i.item_type::text = 'payment') payment_dates,
          b.value_date::text credit_date
        from rzp_settlements s
        left join payout po on po.sid = s.id
        left join bank_lines b on b.id = po.bid
        where s.run_id = ${runId}
        order by s.rzp_id`),
    );
    return rows.map((r) => ({
      id: r.id,
      rzpId: r.rzp_id,
      businessDate: r.business_date,
      amountPaise: BigInt(r.amount),
      paymentDates: r.payment_dates === null ? [] : r.payment_dates.split(','),
      creditDate: r.credit_date,
    }));
  }

  /**
   * The vouchers for the books. A settlement is booked only once a bank credit is matched to it and its
   * lines add up to the paise (the same composition the matcher uses); anything else is listed as skipped
   * with the reason. Agent adjustments are included only after a person has approved them.
   */
  async vouchers(runId: string): Promise<{
    vouchers: Voucher[];
    booked: string[];
    skipped: { rzpId: string; reason: string }[];
  }> {
    const run = await this.run(runId);
    const names = ledgerNamesOf(run.config);
    const links = rowsOf<{ sid: string; bid: string }>(
      await this.db.execute(
        sql`with ${payoutCte(runId)} select sid::text sid, bid::text bid from payout`,
      ),
    );
    const settlementIds = [...new Set(links.map((l) => l.sid))];
    const settlements = new Map(
      (
        await loadIn(settlementIds, (c) =>
          this.db.select().from(rzpSettlements).where(inArray(rzpSettlements.id, c)),
        )
      ).map((s) => [s.id, s]),
    );
    const banks = new Map(
      (
        await loadIn([...new Set(links.map((l) => l.bid))], (c) =>
          this.db.select().from(bankLines).where(inArray(bankLines.id, c)),
        )
      ).map((b) => [b.id, b]),
    );
    const items = await loadIn(settlementIds, (c) =>
      this.db.select().from(settlementItems).where(inArray(settlementItems.settlementId, c)),
    );
    const itemsOf = new Map<string, typeof items>();
    for (const i of items) itemsOf.set(i.settlementId, [...(itemsOf.get(i.settlementId) ?? []), i]);

    const payments = new Map(
      (
        await loadIn(
          [...new Set(items.filter((i) => i.itemType === 'payment').map((i) => i.rzpEntityId))],
          (c) =>
            this.db
              .select()
              .from(rzpPayments)
              .where(and(eq(rzpPayments.runId, runId), inArray(rzpPayments.rzpId, c))),
        )
      ).map((p) => [p.rzpId, paymentOf(p)]),
    );
    const refunds = new Map(
      (
        await loadIn(
          [...new Set(items.filter((i) => i.itemType === 'refund').map((i) => i.rzpEntityId))],
          (c) =>
            this.db
              .select()
              .from(rzpRefunds)
              .where(and(eq(rzpRefunds.runId, runId), inArray(rzpRefunds.rzpId, c))),
        )
      ).map((r) => [r.rzpId, refundOf(r)]),
    );

    const vouchers: Voucher[] = [];
    const booked: string[] = [];
    const skipped: { rzpId: string; reason: string }[] = [];
    const ordered = links
      .map((l) => ({ s: settlements.get(l.sid), b: banks.get(l.bid) }))
      .filter(
        (x): x is { s: NonNullable<typeof x.s>; b: NonNullable<typeof x.b> } => !!x.s && !!x.b,
      )
      .sort(
        (x, y) => x.b.valueDate.localeCompare(y.b.valueDate) || x.s.rzpId.localeCompare(y.s.rzpId),
      );
    for (const { s, b } of ordered) {
      const lines = (itemsOf.get(s.id) ?? []).map((i) => itemOf(i, s.rzpId));
      const comp = composeLines(lines, {
        payment: (id) => payments.get(id),
        refund: (id) => refunds.get(id),
      });
      const blocking = comp.issues.find((i) => i.severity === 'blocking');
      const skip = (reason: string) => skipped.push({ rzpId: s.rzpId, reason });
      if (blocking) skip(blocking.message);
      else if (comp.computed !== paise(s.amountPaise))
        skip('its lines do not add up to the settlement amount');
      else if (b.direction !== 'credit' || b.amountPaise !== s.amountPaise)
        skip('the matched bank line is not a credit of the settlement amount');
      else {
        const adjustments = lines.filter(
          (i) => i.itemType === 'adjustment' || i.itemType === 'transfer',
        );
        const chargeback = adjustments.filter(isChargebackLine).reduce((n, i) => n + i.debit, 0n);
        const booking: SettlementBooking = {
          rzpId: s.rzpId,
          utr: s.utr,
          bankRef: b.sourceRef,
          bankDate: b.valueDate,
          netPaise: s.amountPaise,
          feesPaise: comp.fees,
          gstPaise: comp.tax,
          refundsPaise: comp.refunds,
          chargebackPaise: chargeback,
          otherDebitPaise: comp.adjustmentsDebit - chargeback,
          creditAdjustmentsPaise: comp.adjustmentsCredit,
          paymentIds: [...comp.paymentIds].sort(),
          refundIds: lines
            .filter((i) => i.itemType === 'refund')
            .map((i) => i.entityId)
            .sort(),
          adjustmentIds: adjustments.map((i) => i.entityId).sort(),
        };
        vouchers.push(...settlementVouchers(booking, names));
        booked.push(s.rzpId);
      }
    }

    // Adjustments the agent drafted and a person approved.
    const drafts = rowsOf<{
      proposal_id: string;
      exception_id: string;
      subject_id: string;
      subject_type: RecordType;
      reviewer: string;
      epoch: string;
      entry: unknown;
    }>(
      await this.db.execute(sql`
        select r.proposal_id::text proposal_id, e.id::text exception_id, e.subject_id::text subject_id,
          e.subject_type::text subject_type, r.reviewer, extract(epoch from r.created_at)::bigint::text epoch,
          p.draft_journal_entry entry
        from reviews r
        join agent_proposals p on p.id = r.proposal_id
        join recon_exceptions e on e.id = p.exception_id
        where r.run_id = ${runId} and r.decision = 'approved' and p.draft_journal_entry is not null
        order by r.created_at, r.proposal_id`),
    );
    const subjects = new Map<RecordType, string[]>();
    for (const d of drafts)
      subjects.set(d.subject_type, [...(subjects.get(d.subject_type) ?? []), d.subject_id]);
    const described = await this.describe(subjects);
    const approved: ApprovedDraft[] = drafts.map((d) => ({
      proposalId: d.proposal_id,
      exceptionId: d.exception_id,
      about: described.get(d.subject_id)?.key ?? d.subject_id,
      reviewer: d.reviewer,
      date: istBusinessDate(Number(d.epoch)),
      entry: storedEntrySchema.parse(parsedJson(d.entry)),
    }));
    vouchers.push(
      ...approved
        .map((d) => adjustmentVoucher(d, names))
        .sort((a, b) => a.date.localeCompare(b.date) || a.no.localeCompare(b.no)),
    );
    return { vouchers, booked, skipped };
  }
}
