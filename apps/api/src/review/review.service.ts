// What happens to a proposal after the agent has made it:
//
//   verify  (deterministic, re-derived from the records)  ──REJECTED──▶ stays an exception, counted
//      │
//      └─VERIFIED──▶ policy ──auto_accept──▶ group written by the same code the rules use
//                      └─────human─────────▶ the review queue ──approve / reject──▶ ...
//
// Every state change is one transaction with its audit steps. Approval re-verifies against the data
// as it is NOW, so a proposal that went stale (a record was matched elsewhere since) is refused and
// the refusal is recorded, never papered over.
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, RecordRef } from '@ziro/core/domain';
import { paise } from '@ziro/core/money';
import {
  decideRoute,
  type RoutePolicy,
  type VerifiedGroup,
  verifyProposal,
  type VerifyOutcome,
} from '@ziro/core/verify';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { auditStep } from '../audit/audit.js';
import { verifierConfigOf } from '../common/verifier-config.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import type { Executor } from '../db/executor.js';
import { agentProposals, reconExceptions, reconRuns, reviews } from '../db/schema.js';
import { isUniqueViolation, writeGroup } from '../recon/group-writer.js';
import { linksOf, loadSnapshot } from '../verify/snapshot.js';
import type { ProposalPipeline } from './pipeline.js';
import type { ApproveInput, QueueQuery, RejectInput } from './requests.js';

export type ReviewSettings = Pick<
  Env,
  | 'AGENT_KILL_SWITCH'
  | 'AUTO_ACCEPT_ENABLED'
  | 'AUTO_ACCEPT_MAX_PAISE'
  | 'AUTO_ACCEPT_MIN_CONFIDENCE'
  | 'DEMO_MODE'
>;

type ProposalRow = typeof agentProposals.$inferSelect;
type ExceptionRow = typeof reconExceptions.$inferSelect;

interface Decider {
  readonly kind: 'human' | 'auto_accept';
  readonly name: string;
  readonly note: string | null;
  readonly actor: Actor;
}

const subjectOf = (e: ExceptionRow): RecordRef => ({
  recordType: e.subjectType,
  recordId: e.subjectId,
});

/** "CODE: message" per finding. The code before the colon is what the summary groups on. */
const findingsOf = (outcome: VerifyOutcome): string[] =>
  outcome.status === 'REJECTED'
    ? outcome.findings.slice(0, 50).map((f) => `${f.code}: ${f.message}`.slice(0, 500))
    : outcome.notes.slice(0, 50).map((n) => n.slice(0, 500));

const rejection = (message: string): VerifyOutcome => ({
  status: 'REJECTED',
  findings: [{ code: 'UNSUPPORTED_SHAPE', message, records: [] }],
});

/** Re-derives, from the records as they are now, whether the proposed match is a match. */
async function evaluate(tx: Executor, proposal: ProposalRow): Promise<VerifyOutcome> {
  const links = linksOf(proposal.links);
  if (links === null) return rejection('the stored links are not record references');
  const [run] = await tx
    .select({ config: reconRuns.config })
    .from(reconRuns)
    .where(eq(reconRuns.id, proposal.runId));
  const snapshot = await loadSnapshot(tx, proposal.runId, links);
  return verifyProposal(
    { verdict: proposal.verdict, reasonCode: proposal.reasonCode, links },
    snapshot,
    verifierConfigOf(run?.config ?? null).config,
  );
}

/** Stores the verdict on the proposal; a rejected proposal's exception goes back to the open list. */
async function recordVerdict(
  tx: Executor,
  proposal: ProposalRow,
  exception: ExceptionRow,
  outcome: VerifyOutcome,
): Promise<boolean> {
  const status = outcome.status === 'VERIFIED' ? 'passed' : 'rejected';
  // Confirming a verdict that already stands changes nothing, so it writes nothing.
  if (status === 'passed' && proposal.verifierStatus === 'passed') return false;
  const findings = findingsOf(outcome);
  const [updated] = await tx
    .update(agentProposals)
    .set({ verifierStatus: status, verifierFindings: findings })
    .where(
      and(
        eq(agentProposals.id, proposal.id),
        inArray(agentProposals.verifierStatus, ['pending', 'passed']),
      ),
    )
    .returning({ id: agentProposals.id });
  if (updated === undefined) return false; // already decided by someone else

  let exceptionAfter = exception.status;
  if (status === 'rejected' && exception.status === 'proposed') {
    await tx
      .update(reconExceptions)
      .set({ status: 'open' })
      .where(and(eq(reconExceptions.id, exception.id), eq(reconExceptions.status, 'proposed')));
    exceptionAfter = 'open';
  }
  await auditStep(tx, {
    runId: proposal.runId,
    actor: 'verifier',
    action: status === 'passed' ? 'verifier.verified' : 'verifier.rejected',
    entity: { type: 'agent_proposal', id: proposal.id },
    before: { verifierStatus: proposal.verifierStatus, exceptionStatus: exception.status },
    after: {
      verifierStatus: status,
      exceptionStatus: exceptionAfter,
      findings: findings.slice(0, 10),
    },
    reason: status === 'passed' ? 'every check passed' : (findings[0] ?? 'rejected'),
    records: [...(linksOf(proposal.links) ?? []), subjectOf(exception)],
  });
  return true;
}

/**
 * Turns a verified proposal into an accepted group, through the same writer the rules use, records
 * the decision, and resolves every open exception about a record in the group.
 */
async function accept(
  tx: Executor,
  proposal: ProposalRow,
  exception: ExceptionRow,
  group: VerifiedGroup,
  who: Decider,
): Promise<string> {
  const { groupId } = await writeGroup(tx, {
    runId: proposal.runId,
    kind: group.kind,
    status: 'accepted',
    basis: 'agent',
    reasonCode: proposal.reasonCode,
    residual: group.residual,
    links: group.links,
    actor: who.actor,
    reason: who.kind === 'human' ? `approved by ${who.name}` : 'auto-accepted by policy',
  });
  await tx.insert(reviews).values({
    runId: proposal.runId,
    proposalId: proposal.id,
    decision: 'approved',
    reviewerKind: who.kind,
    reviewer: who.name,
    note: who.note,
  });

  const touched = [
    ...group.links.map((l) =>
      and(eq(reconExceptions.subjectType, l.recordType), eq(reconExceptions.subjectId, l.recordId)),
    ),
    eq(reconExceptions.id, exception.id),
  ];
  const open = await tx
    .select()
    .from(reconExceptions)
    .where(
      and(
        eq(reconExceptions.runId, proposal.runId),
        inArray(reconExceptions.status, ['open', 'proposed']),
        or(...touched),
      ),
    );
  for (const e of open) {
    await tx
      .update(reconExceptions)
      .set({ status: 'resolved' })
      .where(eq(reconExceptions.id, e.id));
    await auditStep(tx, {
      runId: proposal.runId,
      actor: who.actor,
      action: 'exception.resolve',
      entity: { type: 'recon_exception', id: e.id },
      before: { status: e.status },
      after: { status: 'resolved', groupId },
      reason: `matched in group ${groupId}`,
      records: [subjectOf(e)],
    });
  }
  await auditStep(tx, {
    runId: proposal.runId,
    actor: who.actor,
    action: 'review.approve',
    entity: { type: 'agent_proposal', id: proposal.id },
    before: { review: null },
    after: { decision: 'approved', by: who.kind, groupId },
    reason: who.note ?? (who.kind === 'human' ? 'approved' : 'auto-accepted by policy'),
    records: [...group.links, subjectOf(exception)],
  });
  return groupId;
}

export interface QueueItem {
  readonly proposalId: string;
  readonly exceptionId: string;
  readonly attempt: number;
  readonly verdict: string;
  readonly reasonCode: string;
  readonly confidence: number;
  readonly suggestedAction: string;
  /** Written by the model from record text: UNTRUSTED. A UI must escape it. */
  readonly explanation: string;
  readonly links: unknown;
  readonly verifier: { readonly status: string; readonly findings: unknown };
  readonly amountAtStakePaise: string;
  readonly ruleReasonCode: string;
  readonly ruleCause: string | null;
  readonly model: string | null;
  readonly createdAt: string;
}

export interface Decision {
  readonly proposalId: string;
  readonly decision: 'approved' | 'rejected';
  readonly exceptionStatus: string;
  readonly groupId: string | null;
}

@Injectable()
export class ReviewService implements ProposalPipeline {
  constructor(
    @Inject(DB) private readonly db: Executor,
    @Inject(ENV) private readonly settings: ReviewSettings,
  ) {}

  private policy(): RoutePolicy {
    return {
      autoAcceptEnabled: this.settings.AUTO_ACCEPT_ENABLED,
      demoMode: this.settings.DEMO_MODE,
      killSwitch: this.settings.AGENT_KILL_SWITCH,
      maxPaise: paise(this.settings.AUTO_ACCEPT_MAX_PAISE),
      minConfidence: this.settings.AUTO_ACCEPT_MIN_CONFIDENCE,
    };
  }

  // --- verification and routing -----------------------------------------------------------------------

  async pendingFor(exceptionIds: readonly string[]): Promise<string[]> {
    if (exceptionIds.length === 0) return [];
    const rows = await this.db
      .select({ id: agentProposals.id })
      .from(agentProposals)
      .where(
        and(
          inArray(agentProposals.exceptionId, [...exceptionIds]),
          eq(agentProposals.verifierStatus, 'pending'),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** Verifies the pending proposals of a run (a retry hook for any that were stored but not verified). */
  async verifyPending(runId: string): Promise<{ verified: number }> {
    const rows = await this.db
      .select({ id: agentProposals.id })
      .from(agentProposals)
      .where(and(eq(agentProposals.runId, runId), eq(agentProposals.verifierStatus, 'pending')));
    await this.verifyAndRoute(rows.map((r) => r.id));
    return { verified: rows.length };
  }

  async verifyAndRoute(proposalIds: readonly string[]): Promise<void> {
    for (const id of proposalIds) await this.verifyOne(id, true);
  }

  private async verifyOne(proposalId: string, mayRetry: boolean): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const [proposal] = await tx
          .select()
          .from(agentProposals)
          .where(eq(agentProposals.id, proposalId))
          .for('update');
        if (proposal === undefined || proposal.verifierStatus !== 'pending') return;
        const [exception] = await tx
          .select()
          .from(reconExceptions)
          .where(eq(reconExceptions.id, proposal.exceptionId));
        if (exception === undefined) return;

        if (proposal.verdict !== 'MATCH_PROPOSED') {
          await tx
            .update(agentProposals)
            .set({ verifierStatus: 'not_applicable' })
            .where(eq(agentProposals.id, proposal.id));
          await auditStep(tx, {
            runId: proposal.runId,
            actor: 'verifier',
            action: 'verifier.not_applicable',
            entity: { type: 'agent_proposal', id: proposal.id },
            before: { verifierStatus: 'pending' },
            after: { verifierStatus: 'not_applicable' },
            reason: `no match was proposed (${proposal.verdict}), so there is nothing to verify`,
            records: [...(linksOf(proposal.links) ?? []), subjectOf(exception)],
          });
          return;
        }

        const outcome = await evaluate(tx, proposal);
        const changed = await recordVerdict(tx, proposal, exception, outcome);
        if (!changed || outcome.status !== 'VERIFIED' || exception.status !== 'proposed') return;

        const route = decideRoute(
          {
            outcome,
            verdict: proposal.verdict,
            suggestedAction: proposal.suggestedAction,
            confidence: proposal.confidencePermille / 1000,
          },
          this.policy(),
        );
        if (route.route === 'auto_accept') {
          const groupId = await accept(tx, proposal, exception, outcome.group, {
            kind: 'auto_accept',
            name: 'auto-accept policy',
            note: null,
            actor: 'system',
          });
          await auditStep(tx, {
            runId: proposal.runId,
            actor: 'system',
            action: 'policy.auto_accept',
            entity: { type: 'agent_proposal', id: proposal.id },
            after: { groupId },
            reason: 'verified, within the amount limit, and confident enough',
            records: [...outcome.group.links],
          });
        } else {
          await auditStep(tx, {
            runId: proposal.runId,
            actor: 'system',
            action: 'policy.human_review',
            entity: { type: 'agent_proposal', id: proposal.id },
            after: { route: 'human' },
            reason: route.why.join('; '),
            records: [...outcome.group.links],
          });
        }
      });
    } catch (error) {
      // Another writer accepted one of these records between our read and our write: verify again,
      // and this time the verifier will find it taken and reject the proposal.
      if (mayRetry && isUniqueViolation(error)) return this.verifyOne(proposalId, false);
      throw error;
    }
  }

  // --- the human decision ---------------------------------------------------------------------------------

  private async lock(tx: Executor, proposalId: string) {
    const [proposal] = await tx
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.id, proposalId))
      .for('update');
    if (proposal === undefined) throw new NotFoundException('no such proposal');
    const [exception] = await tx
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.id, proposal.exceptionId));
    if (exception === undefined) throw new NotFoundException('the proposal has no exception');
    const [decided] = await tx.select().from(reviews).where(eq(reviews.proposalId, proposal.id));
    if (decided !== undefined) {
      throw new ConflictException({
        error: 'already_decided',
        message: `this proposal was already ${decided.decision} by ${decided.reviewer}`,
      });
    }
    return { proposal, exception };
  }

  async approve(proposalId: string, input: ApproveInput): Promise<Decision> {
    const who: Decider = {
      kind: 'human',
      name: input.reviewer,
      note: input.note ?? null,
      actor: 'human',
    };
    type Stale = { stale: string[] };
    let outcome: Decision | Stale;
    try {
      outcome = await this.db.transaction(async (tx): Promise<Decision | Stale> => {
        const { proposal, exception } = await this.lock(tx, proposalId);
        if (exception.status !== 'proposed') {
          throw new ConflictException({
            error: 'not_awaiting_review',
            message: `the exception is ${exception.status}, not awaiting review`,
          });
        }
        if (proposal.verifierStatus === 'rejected') {
          throw new ConflictException({
            error: 'verifier_rejected',
            message: 'the verifier rejected this proposal; it cannot be approved',
            findings: proposal.verifierFindings,
          });
        }
        if (proposal.verdict === 'NEEDS_HUMAN') {
          throw new ConflictException({
            error: 'nothing_to_approve',
            message:
              'the agent could not reach a conclusion, so there is nothing to approve; reject it to send the exception back to the open list',
          });
        }

        if (proposal.verdict === 'EXPLAINED_NO_MATCH') {
          await tx.insert(reviews).values({
            runId: proposal.runId,
            proposalId: proposal.id,
            decision: 'approved',
            reviewerKind: 'human',
            reviewer: who.name,
            note: who.note,
          });
          await tx
            .update(reconExceptions)
            .set({ status: 'resolved', reasonCode: proposal.reasonCode })
            .where(eq(reconExceptions.id, exception.id));
          await auditStep(tx, {
            runId: proposal.runId,
            actor: 'human',
            action: 'exception.resolve',
            entity: { type: 'recon_exception', id: exception.id },
            before: { status: exception.status, reasonCode: exception.reasonCode },
            after: { status: 'resolved', reasonCode: proposal.reasonCode },
            reason: who.note ?? 'the explanation was accepted',
            records: [subjectOf(exception), ...(linksOf(proposal.links) ?? [])],
          });
          await auditStep(tx, {
            runId: proposal.runId,
            actor: 'human',
            action: 'review.approve',
            entity: { type: 'agent_proposal', id: proposal.id },
            before: { review: null },
            after: { decision: 'approved', by: 'human' },
            reason: who.note ?? 'approved',
            records: [subjectOf(exception), ...(linksOf(proposal.links) ?? [])],
          });
          return {
            proposalId: proposal.id,
            decision: 'approved',
            exceptionStatus: 'resolved',
            groupId: null,
          };
        }

        // A proposed match: verify again against the data as it is now.
        const fresh = await evaluate(tx, proposal);
        if (fresh.status === 'REJECTED') {
          await recordVerdict(tx, proposal, exception, fresh);
          return { stale: findingsOf(fresh) };
        }
        await recordVerdict(tx, proposal, exception, fresh);
        const groupId = await accept(tx, proposal, exception, fresh.group, who);
        return {
          proposalId: proposal.id,
          decision: 'approved',
          exceptionStatus: 'resolved',
          groupId,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          error: 'record_taken',
          message:
            'a record in this match was accepted into another group a moment ago; nothing was changed, so look at it again',
        });
      }
      throw error;
    }
    if ('stale' in outcome) {
      throw new ConflictException({
        error: 'stale_proposal',
        message: 'the records no longer support this match, so it was refused and sent back',
        findings: outcome.stale,
      });
    }
    return outcome;
  }

  async reject(proposalId: string, input: RejectInput): Promise<Decision> {
    return this.db.transaction(async (tx) => {
      const { proposal, exception } = await this.lock(tx, proposalId);
      if (exception.status !== 'proposed') {
        throw new ConflictException({
          error: 'not_awaiting_review',
          message: `the exception is ${exception.status}, not awaiting review`,
        });
      }
      await tx.insert(reviews).values({
        runId: proposal.runId,
        proposalId: proposal.id,
        decision: 'rejected',
        reviewerKind: 'human',
        reviewer: input.reviewer,
        note: input.note,
      });
      await tx
        .update(reconExceptions)
        .set({ status: 'open' })
        .where(eq(reconExceptions.id, exception.id));
      await auditStep(tx, {
        runId: proposal.runId,
        actor: 'human',
        action: 'review.reject',
        entity: { type: 'agent_proposal', id: proposal.id },
        before: { review: null, exceptionStatus: exception.status },
        after: { decision: 'rejected', exceptionStatus: 'open' },
        reason: input.note,
        records: [subjectOf(exception), ...(linksOf(proposal.links) ?? [])],
      });
      return {
        proposalId: proposal.id,
        decision: 'rejected',
        exceptionStatus: 'open',
        groupId: null,
      };
    });
  }

  // --- reading ---------------------------------------------------------------------------------------

  private awaitingReview(runId: string) {
    return and(
      eq(agentProposals.runId, runId),
      isNull(reviews.id),
      inArray(agentProposals.verifierStatus, ['passed', 'not_applicable']),
      eq(reconExceptions.status, 'proposed'),
    );
  }

  /** Proposals waiting for a person, largest amount at stake first. */
  async queue(runId: string, query: QueueQuery): Promise<{ total: number; items: QueueItem[] }> {
    await this.assertRun(runId);
    const base = this.db
      .select({ proposal: agentProposals, exception: reconExceptions })
      .from(agentProposals)
      .innerJoin(reconExceptions, eq(reconExceptions.id, agentProposals.exceptionId))
      .leftJoin(reviews, eq(reviews.proposalId, agentProposals.id))
      .where(this.awaitingReview(runId));
    const rows = await base
      .orderBy(
        desc(sql`abs(${reconExceptions.amountAtStakePaise})`),
        asc(agentProposals.createdAt),
        asc(agentProposals.id),
      )
      .limit(query.limit)
      .offset(query.offset);
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentProposals)
      .innerJoin(reconExceptions, eq(reconExceptions.id, agentProposals.exceptionId))
      .leftJoin(reviews, eq(reviews.proposalId, agentProposals.id))
      .where(this.awaitingReview(runId));
    return {
      total: count?.n ?? 0,
      items: rows.map(({ proposal: p, exception: e }) => ({
        proposalId: p.id,
        exceptionId: e.id,
        attempt: p.attempt,
        verdict: p.verdict,
        reasonCode: p.reasonCode,
        confidence: p.confidencePermille / 1000,
        suggestedAction: p.suggestedAction,
        explanation: p.explanation,
        links: p.links,
        verifier: { status: p.verifierStatus, findings: p.verifierFindings },
        amountAtStakePaise: e.amountAtStakePaise.toString(),
        ruleReasonCode: e.reasonCode,
        ruleCause: e.cause,
        model: p.model,
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  /** One proposal with everything a reviewer needs: evidence, findings, the exception, any decision. */
  async detail(proposalId: string) {
    const [proposal] = await this.db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.id, proposalId));
    if (proposal === undefined) throw new NotFoundException('no such proposal');
    const [exception] = await this.db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.id, proposal.exceptionId));
    const [review] = await this.db
      .select()
      .from(reviews)
      .where(eq(reviews.proposalId, proposal.id));
    return {
      proposal: {
        id: proposal.id,
        runId: proposal.runId,
        exceptionId: proposal.exceptionId,
        attempt: proposal.attempt,
        clusterId: proposal.clusterId,
        model: proposal.model,
        verdict: proposal.verdict,
        reasonCode: proposal.reasonCode,
        links: proposal.links,
        // UNTRUSTED text, written by the model from record text: a UI must escape it.
        explanation: proposal.explanation,
        evidence: proposal.evidence,
        confidence: proposal.confidencePermille / 1000,
        suggestedAction: proposal.suggestedAction,
        draftJournalEntry: proposal.draftJournalEntry,
        harnessFindings: proposal.harnessFindings,
        verifier: { status: proposal.verifierStatus, findings: proposal.verifierFindings },
        createdAt: proposal.createdAt.toISOString(),
      },
      exception:
        exception === undefined
          ? null
          : {
              id: exception.id,
              status: exception.status,
              reasonCode: exception.reasonCode,
              cause: exception.cause,
              note: exception.note,
              subject: subjectOf(exception),
              amountAtStakePaise: exception.amountAtStakePaise.toString(),
            },
      review:
        review === undefined
          ? null
          : {
              decision: review.decision,
              reviewerKind: review.reviewerKind,
              reviewer: review.reviewer,
              note: review.note,
              at: review.createdAt.toISOString(),
            },
    };
  }

  private async assertRun(runId: string): Promise<void> {
    const [run] = await this.db
      .select({ id: reconRuns.id })
      .from(reconRuns)
      .where(eq(reconRuns.id, runId));
    if (run === undefined) throw new NotFoundException('no such run');
  }

  /** The headline numbers for a run. `caughtByVerifier` is the count of agent proposals the verifier refused. */
  async summary(runId: string) {
    await this.assertRun(runId);
    const proposals = await this.db
      .select({
        verdict: agentProposals.verdict,
        verifier: agentProposals.verifierStatus,
        n: sql<number>`count(*)::int`,
      })
      .from(agentProposals)
      .where(eq(agentProposals.runId, runId))
      .groupBy(agentProposals.verdict, agentProposals.verifierStatus);
    const decisions = await this.db
      .select({
        decision: reviews.decision,
        kind: reviews.reviewerKind,
        n: sql<number>`count(*)::int`,
      })
      .from(reviews)
      .where(eq(reviews.runId, runId))
      .groupBy(reviews.decision, reviews.reviewerKind);
    const exceptions = await this.db
      .select({ status: reconExceptions.status, n: sql<number>`count(*)::int` })
      .from(reconExceptions)
      .where(eq(reconExceptions.runId, runId))
      .groupBy(reconExceptions.status);
    const rejected = await this.db
      .select({ findings: agentProposals.verifierFindings })
      .from(agentProposals)
      .where(and(eq(agentProposals.runId, runId), eq(agentProposals.verifierStatus, 'rejected')));
    const [waiting] = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        stake: sql<string>`coalesce(sum(abs(${reconExceptions.amountAtStakePaise})), 0)::text`,
      })
      .from(agentProposals)
      .innerJoin(reconExceptions, eq(reconExceptions.id, agentProposals.exceptionId))
      .leftJoin(reviews, eq(reviews.proposalId, agentProposals.id))
      .where(this.awaitingReview(runId));

    const count = (pick: (p: (typeof proposals)[number]) => boolean) =>
      proposals.filter(pick).reduce((sum, p) => sum + p.n, 0);
    const byVerdict: Record<string, number> = {};
    for (const p of proposals) byVerdict[p.verdict] = (byVerdict[p.verdict] ?? 0) + p.n;
    const reasons: Record<string, number> = {};
    for (const row of rejected) {
      const first = Array.isArray(row.findings) ? row.findings : [];
      for (const text of first) {
        const code = String(text).split(':')[0] ?? 'UNKNOWN';
        reasons[code] = (reasons[code] ?? 0) + 1;
      }
    }
    const decided = (decision: string, kind?: string) =>
      decisions
        .filter((d) => d.decision === decision && (kind === undefined || d.kind === kind))
        .reduce((sum, d) => sum + d.n, 0);
    return {
      runId,
      proposals: { total: count(() => true), byVerdict },
      matchesProposed: byVerdict['MATCH_PROPOSED'] ?? 0,
      verifier: {
        passed: count((p) => p.verifier === 'passed'),
        rejected: count((p) => p.verifier === 'rejected'),
        notApplicable: count((p) => p.verifier === 'not_applicable'),
        pending: count((p) => p.verifier === 'pending'),
      },
      caughtByVerifier: count((p) => p.verifier === 'rejected'),
      rejectionReasons: reasons,
      queue: { waiting: waiting?.n ?? 0, amountAtStakePaise: waiting?.stake ?? '0' },
      reviews: {
        approved: decided('approved', 'human'),
        rejected: decided('rejected', 'human'),
        autoAccepted: decided('approved', 'auto_accept'),
      },
      exceptions: Object.fromEntries(exceptions.map((e) => [e.status, e.n])),
    };
  }
}
