// What the console shows about a run, read from the tables as they are: nothing here is stored
// separately, so a page can never disagree with the data. Money is integer paise throughout and travels
// as strings (a JSON number is a float). Free text (explanations, memos, narrations) is returned as the
// text it is: the page renders it as text and never as markup.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RecordType } from '@ziro/core/domain';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
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
} from '../db/schema.js';
import { PLANTED_MODEL, SCRIPTED_MODEL } from '../demo/scripted-runner.js';
import { ReviewService } from '../review/review.service.js';
import { type Gap, gapOf } from './gap.js';

export type Author = 'scripted' | 'planted' | 'model';
export const authorOf = (model: string | null): Author =>
  model === SCRIPTED_MODEL ? 'scripted' : model === PLANTED_MODEL ? 'planted' : 'model';

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

export type ExceptionFilter = 'all' | 'waiting' | 'refused' | 'unexamined' | 'resolved';
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
    // a bank debit, a credit that is not a Razorpay payout). A record in a group that later resolved an
    // exception is counted as matched, not as an exception.
    const coverage = rowsOf<{ type: string; total: number; matched: number; excepted: number }>(
      await this.db.execute(sql`
        with accepted as (
          select ml.ledger_entry_id l, ml.payment_id p, ml.refund_id r, ml.settlement_id s, ml.bank_line_id b
          from match_links ml join match_groups g on g.id = ml.group_id
          where g.run_id = ${runId} and g.status = 'accepted'),
        ex as (select subject_type::text t, subject_id i from recon_exceptions where run_id = ${runId})
        select 'ledger_entry' type, (select count(*) from ledger_entries where run_id=${runId})::int total,
               (select count(distinct l) from accepted where l is not null)::int matched,
               (select count(*) from ex where t='ledger_entry' and i not in (select l from accepted where l is not null))::int excepted
        union all select 'rzp_payment', (select count(*) from rzp_payments where run_id=${runId})::int,
               (select count(distinct p) from accepted where p is not null)::int,
               (select count(*) from ex where t='rzp_payment' and i not in (select p from accepted where p is not null))::int
        union all select 'rzp_refund', (select count(*) from rzp_refunds where run_id=${runId})::int,
               (select count(distinct r) from accepted where r is not null)::int,
               (select count(*) from ex where t='rzp_refund' and i not in (select r from accepted where r is not null))::int
        union all select 'rzp_settlement', (select count(*) from rzp_settlements where run_id=${runId})::int,
               (select count(distinct s) from accepted where s is not null)::int,
               (select count(*) from ex where t='rzp_settlement' and i not in (select s from accepted where s is not null))::int
        union all select 'bank_line', (select count(*) from bank_lines where run_id=${runId})::int,
               (select count(distinct b) from accepted where b is not null)::int,
               (select count(*) from ex where t='bank_line' and i not in (select b from accepted where b is not null))::int`),
    ).map((c) => ({
      type: c.type,
      total: c.total,
      matched: c.matched,
      inException: c.excepted,
      ignored: Math.max(0, c.total - c.matched - c.excepted),
      // Of the records the matcher tried to place, how many it placed.
      matchRate: c.matched + c.excepted === 0 ? null : c.matched / (c.matched + c.excepted),
    }));

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

    const all = await this.db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.runId, runId));
    const gap = gapOf(
      all.map((e) => ({
        status: e.status,
        stakePaise: e.amountAtStakePaise,
        records: [
          e.subjectId,
          ...(Array.isArray(e.candidates)
            ? (e.candidates as { recordId?: string }[]).map((c) => c.recordId ?? '')
            : []),
        ],
      })),
    );

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

    return {
      run: {
        id: run.id,
        status: run.status,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        createdAt: run.createdAt.toISOString(),
        source: run.razorpaySource,
        preset: (pipeline.demo?.['preset'] as string | undefined) ?? null,
        featured: (run.config as { featured?: string }).featured ?? null,
        stage: (pipeline.pipeline?.['stage'] as string | undefined) ?? null,
      },
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
      case 'all':
        break;
    }
    return and(...parts) as SQL;
  }

  async exceptions(runId: string, q: ExceptionQuery) {
    await this.run(runId);
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
    const items = await this.rowsToItems(rows);
    return { total, items };
  }

  private async rowsToItems(rows: (typeof reconExceptions.$inferSelect)[]) {
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
    return rows.map((e) => {
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
              author: authorOf(p.model),
            }
          : null,
        review: d ? { decision: d.decision, reviewer: d.reviewer } : null,
      };
    });
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
    const [first] = await this.rowsToItems([e]);
    return {
      exception: first,
      subject: described.get(e.subjectId) ?? null,
      candidates: pick(refs.slice(1)),
      proposals: proposals.map((p) => {
        const d = decisions.find((x) => x.proposalId === p.id);
        return {
          id: p.id,
          attempt: p.attempt,
          author: authorOf(p.model),
          model: p.model,
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
}
