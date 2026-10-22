import { ConflictException, NotFoundException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertException, insertPayment } from '../db/migrated-db.fixtures.js';
import {
  agentProposals,
  auditEvents,
  matchGroups,
  matchLinks,
  reconExceptions,
  reviews,
  rzpPayments,
} from '../db/schema.js';
import { writeGroup } from '../recon/group-writer.js';
import {
  createMigratedDb,
  seedOrder,
  seedPayout,
  seedProposal,
  seedRun,
  type TestDb,
} from './review.fixtures.js';
import { ReviewService, type ReviewSettings } from './review.service.js';

let ctx: Awaited<ReturnType<typeof createMigratedDb>>;
let db: TestDb;

beforeAll(async () => {
  ctx = await createMigratedDb();
  db = ctx.db;
}, 60_000);
afterAll(async () => {
  await ctx.client.close();
});

const settings = (over: Partial<ReviewSettings> = {}): ReviewSettings => ({
  AGENT_KILL_SWITCH: false,
  AUTO_ACCEPT_ENABLED: false,
  AUTO_ACCEPT_MAX_PAISE: 500_000n,
  AUTO_ACCEPT_MIN_CONFIDENCE: 0.85,
  DEMO_MODE: false,
  ...over,
});
const service = (over: Partial<ReviewSettings> = {}) => new ReviewService(db, settings(over));
const autoAccept = { AUTO_ACCEPT_ENABLED: true } as const;

const exceptionStatus = async (id: string) =>
  (await db.select().from(reconExceptions).where(eq(reconExceptions.id, id)))[0]?.status;
const proposalOf = async (id: string) =>
  (await db.select().from(agentProposals).where(eq(agentProposals.id, id)))[0];
const reviewOf = async (proposalId: string) =>
  (await db.select().from(reviews).where(eq(reviews.proposalId, proposalId)))[0];
const groupsOf = (runId: string) =>
  db.select().from(matchGroups).where(eq(matchGroups.runId, runId));
const actionsOf = async (runId: string) =>
  (
    await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.runId, runId))
      .orderBy(asc(auditEvents.id))
  ).map((e) => e.action);
const auditNamed = async (runId: string, action: string) =>
  (await db.select().from(auditEvents).where(eq(auditEvents.runId, runId))).filter(
    (e) => e.action === action,
  );

async function conflictOf(work: Promise<unknown>): Promise<{ error: string; findings?: string[] }> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ConflictException)
      return error.getResponse() as { error: string; findings?: string[] };
    throw error;
  }
  throw new Error('expected a conflict');
}

describe('verification', () => {
  it('verifies a correct match and leaves it for a person when auto-accept is off', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links);
    await service().verifyAndRoute([p.proposalId]);

    const row = await proposalOf(p.proposalId);
    expect(row?.verifierStatus).toBe('passed');
    expect(await exceptionStatus(p.exceptionId)).toBe('proposed');
    expect(await groupsOf(runId)).toHaveLength(0);
    const routed = await auditNamed(runId, 'policy.human_review');
    expect(routed).toHaveLength(1);
    expect(routed[0]?.detail).toMatchObject({
      reason: expect.stringContaining('auto-accept is switched off') as string,
    });
    expect(
      (await service().queue(runId, { limit: 25, offset: 0 })).items.map((i) => i.proposalId),
    ).toEqual([p.proposalId]);
  });

  it('rejects a match that is off by one paisa; it stays an exception and is counted', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId, { paymentAmount: 250_001n });
    const p = await seedProposal(db, runId, order.links);
    const review = service();
    await review.verifyAndRoute([p.proposalId]);

    const row = await proposalOf(p.proposalId);
    expect(row?.verifierStatus).toBe('rejected');
    expect(row?.verifierFindings[0]).toMatch(/^AMOUNT_MISMATCH: /);
    expect(await exceptionStatus(p.exceptionId)).toBe('open');
    expect((await review.queue(runId, { limit: 25, offset: 0 })).total).toBe(0);
    const [event] = await auditNamed(runId, 'verifier.rejected');
    expect(event).toMatchObject({ actor: 'verifier', entityId: p.proposalId });
    expect(event?.detail).toMatchObject({
      before: { verifierStatus: 'pending', exceptionStatus: 'proposed' },
      after: { verifierStatus: 'rejected', exceptionStatus: 'open' },
    });
    const summary = await review.summary(runId);
    expect(summary.caughtByVerifier).toBe(1);
    expect(summary.rejectionReasons).toEqual({ AMOUNT_MISMATCH: 1 });
  });

  it('rejects a record from another run (a cross-run id)', async () => {
    const runA = await seedRun(db);
    const runB = await seedRun(db);
    const order = await seedOrder(db, runA);
    const p = await seedProposal(db, runB, order.links);
    await service().verifyAndRoute([p.proposalId]);
    const row = await proposalOf(p.proposalId);
    expect(row?.verifierStatus).toBe('rejected');
    expect(row?.verifierFindings.join(' ')).toContain('CROSS_RUN_RECORD');
  });

  it('rejects a payment that is already in an accepted group (a reused id)', async () => {
    const runId = await seedRun(db);
    const first = await seedOrder(db, runId);
    const second = await seedOrder(db, runId);
    const review = service(autoAccept);
    const a = await seedProposal(db, runId, first.links);
    await review.verifyAndRoute([a.proposalId]);
    expect((await groupsOf(runId)).filter((g) => g.status === 'accepted')).toHaveLength(1);

    // Same payment, a different ledger entry of the same amount.
    const reused = await seedProposal(db, runId, [
      { recordType: 'ledger_entry', recordId: second.ledger },
      { recordType: 'rzp_payment', recordId: first.payment },
    ]);
    await review.verifyAndRoute([reused.proposalId]);
    const row = await proposalOf(reused.proposalId);
    expect(row?.verifierStatus).toBe('rejected');
    expect(row?.verifierFindings.join(' ')).toContain('ALREADY_MATCHED');
    expect((await groupsOf(runId)).filter((g) => g.status === 'accepted')).toHaveLength(1);
  });

  it('rejects a link list that is not record references', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links);
    await db
      .update(agentProposals)
      .set({ links: [{ nonsense: true }] })
      .where(eq(agentProposals.id, p.proposalId));
    await service().verifyAndRoute([p.proposalId]);
    expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('rejected');
  });

  it.each(['EXPLAINED_NO_MATCH', 'NEEDS_HUMAN'] as const)(
    'has nothing to verify in a %s, which goes to a person',
    async (verdict) => {
      const runId = await seedRun(db);
      const order = await seedOrder(db, runId);
      const p = await seedProposal(db, runId, order.links, {
        verdict,
        reasonCode: 'DUPLICATE_PAYMENT',
      });
      const review = service(autoAccept);
      await review.verifyAndRoute([p.proposalId]);
      expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('not_applicable');
      expect(await groupsOf(runId)).toHaveLength(0);
      expect((await review.queue(runId, { limit: 25, offset: 0 })).items).toHaveLength(1);
      expect((await auditNamed(runId, 'verifier.not_applicable'))[0]?.actor).toBe('verifier');
    },
  );

  it('is idempotent: verifying twice writes one set of audit steps', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links);
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    const once = await actionsOf(runId);
    await review.verifyAndRoute([p.proposalId, p.proposalId]);
    expect(await actionsOf(runId)).toEqual(once);
  });

  it('does not mark a proposal that proposes no match a second time either', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links, {
      verdict: 'EXPLAINED_NO_MATCH',
      reasonCode: 'DUPLICATE_PAYMENT',
    });
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    await review.verifyAndRoute([p.proposalId]);
    expect(await auditNamed(runId, 'verifier.not_applicable')).toHaveLength(1);
  });

  it('finds the pending proposals of a run and verifies them', async () => {
    const runId = await seedRun(db);
    const a = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const b = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const review = service();
    expect(new Set(await review.pendingFor([a.exceptionId, b.exceptionId]))).toEqual(
      new Set([a.proposalId, b.proposalId]),
    );
    expect(await review.verifyPending(runId)).toEqual({ verified: 2 });
    expect(await review.pendingFor([a.exceptionId, b.exceptionId])).toEqual([]);
    expect(await review.verifyPending(runId)).toEqual({ verified: 0 });
  });
});

describe('the auto-accept policy', () => {
  it('accepts a verified, small, confident match: the group is written by the shared writer', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links, { confidencePermille: 850 });
    await service(autoAccept).verifyAndRoute([p.proposalId]);

    const [group] = await groupsOf(runId);
    expect(group).toMatchObject({
      kind: 'order',
      status: 'accepted',
      basis: 'agent',
      reasonCode: 'UNKNOWN',
      residualPaise: 0n,
    });
    const links = await db
      .select()
      .from(matchLinks)
      .where(eq(matchLinks.groupId, group?.id ?? ''));
    expect(links.map((l) => l.ledgerEntryId ?? l.paymentId).sort()).toEqual(
      [order.ledger, order.payment].sort(),
    );

    expect(await reviewOf(p.proposalId)).toMatchObject({
      decision: 'approved',
      reviewerKind: 'auto_accept',
    });
    expect(await exceptionStatus(p.exceptionId)).toBe('resolved');
    expect((await auditNamed(runId, 'group.create'))[0]?.actor).toBe('system');
    expect(await actionsOf(runId)).toEqual([
      'verifier.verified',
      'group.create',
      'exception.resolve',
      'review.approve',
      'policy.auto_accept',
    ]);
  });

  it('accepts a payout the same way', async () => {
    const runId = await seedRun(db);
    const payout = await seedPayout(db, runId);
    const p = await seedProposal(db, runId, payout.links, { reasonCode: 'BATCHED_SETTLEMENT' });
    await service(autoAccept).verifyAndRoute([p.proposalId]);
    const [group] = await groupsOf(runId);
    expect(group).toMatchObject({
      kind: 'payout',
      status: 'accepted',
      reasonCode: 'BATCHED_SETTLEMENT',
    });
  });

  it.each([
    ['demo mode is on', { DEMO_MODE: true }, {}, 'demo mode'],
    ['the kill switch is on', { AGENT_KILL_SWITCH: true }, {}, 'kill switch'],
    [
      'the amount is over the limit',
      { AUTO_ACCEPT_MAX_PAISE: 249_999n },
      {},
      'above the auto-accept limit',
    ],
    [
      'the confidence is just under the threshold',
      {},
      { confidencePermille: 849 },
      'confidence is below',
    ],
    [
      'the agent did not suggest accepting',
      {},
      { suggestedAction: 'NONE' as const },
      'did not suggest accepting',
    ],
  ])('leaves it for a person when %s', async (_name, settingsOver, proposalOver, because) => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links, proposalOver);
    await service({ ...autoAccept, ...settingsOver }).verifyAndRoute([p.proposalId]);
    expect(await groupsOf(runId)).toHaveLength(0);
    expect(await exceptionStatus(p.exceptionId)).toBe('proposed');
    expect((await auditNamed(runId, 'policy.human_review'))[0]?.detail).toMatchObject({
      reason: expect.stringContaining(because) as string,
    });
  });

  it('never auto-accepts something the verifier rejected, however confident the agent is', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId, { ledgerAmount: 250_001n });
    const p = await seedProposal(db, runId, order.links, { confidencePermille: 1000 });
    await service(autoAccept).verifyAndRoute([p.proposalId]);
    expect(await groupsOf(runId)).toHaveLength(0);
    expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('rejected');
  });

  it('keeps routing to people with the kill switch on: it only stops auto-accept', async () => {
    const runId = await seedRun(db);
    const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const review = service({ ...autoAccept, AGENT_KILL_SWITCH: true });
    await review.verifyAndRoute([p.proposalId]);
    expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('passed');
    expect((await review.queue(runId, { limit: 25, offset: 0 })).total).toBe(1);
    await expect(review.approve(p.proposalId, { reviewer: 'asha' })).resolves.toMatchObject({
      decision: 'approved',
    });
  });
});

describe('approve', () => {
  it('creates the group through the shared writer, records the reviewer and resolves the exception', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links);
    const review = service();
    await review.verifyAndRoute([p.proposalId]);

    const decision = await review.approve(p.proposalId, {
      reviewer: 'asha',
      note: 'checked the invoice',
    });
    expect(decision).toMatchObject({
      proposalId: p.proposalId,
      decision: 'approved',
      exceptionStatus: 'resolved',
    });
    const [group] = await groupsOf(runId);
    expect(decision.groupId).toBe(group?.id);
    expect(group).toMatchObject({ status: 'accepted', basis: 'agent', residualPaise: 0n });
    expect(await reviewOf(p.proposalId)).toMatchObject({
      reviewerKind: 'human',
      reviewer: 'asha',
      note: 'checked the invoice',
    });
    expect(await exceptionStatus(p.exceptionId)).toBe('resolved');
    expect((await auditNamed(runId, 'review.approve'))[0]).toMatchObject({ actor: 'human' });
    expect((await auditNamed(runId, 'group.create'))[0]).toMatchObject({ actor: 'human' });
  });

  it('resolves every open exception about a record in the group, not only its own', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links);
    // The payment has an exception of its own.
    const other = await seedProposal(db, runId, [order.links[1]!], {
      verdict: 'NEEDS_HUMAN',
      subject: order.links[1],
    });
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    await review.approve(p.proposalId, { reviewer: 'asha' });
    expect(await exceptionStatus(other.exceptionId)).toBe('resolved');
  });

  it('cannot be done twice', async () => {
    const runId = await seedRun(db);
    const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    await review.approve(p.proposalId, { reviewer: 'asha' });
    expect((await conflictOf(review.approve(p.proposalId, { reviewer: 'ben' }))).error).toBe(
      'already_decided',
    );
    expect(
      (await conflictOf(review.reject(p.proposalId, { reviewer: 'ben', note: 'no' }))).error,
    ).toBe('already_decided');
    expect(await groupsOf(runId)).toHaveLength(1);
  });

  it('refuses a stale proposal: a record was matched elsewhere since, and the refusal is recorded', async () => {
    const runId = await seedRun(db);
    const first = await seedOrder(db, runId);
    const second = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, first.links);
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('passed');

    // Meanwhile somebody accepts a different group that takes the same payment.
    await writeGroup(db, {
      runId,
      kind: 'order',
      status: 'accepted',
      basis: 'human',
      reasonCode: null,
      residual: 0n,
      links: [
        { recordType: 'ledger_entry', recordId: second.ledger },
        { recordType: 'rzp_payment', recordId: first.payment },
      ],
      actor: 'human',
      reason: 'manual',
    });

    const body = await conflictOf(review.approve(p.proposalId, { reviewer: 'asha' }));
    expect(body.error).toBe('stale_proposal');
    expect(body.findings?.join(' ')).toContain('ALREADY_MATCHED');
    expect((await groupsOf(runId)).filter((g) => g.status === 'accepted')).toHaveLength(1);
    expect(await reviewOf(p.proposalId)).toBeUndefined();
    expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('rejected');
    expect(await exceptionStatus(p.exceptionId)).toBe('open');
    expect(await auditNamed(runId, 'verifier.rejected')).toHaveLength(1);
  });

  it('lets exactly one of two proposals that claim the same payment win', async () => {
    const runId = await seedRun(db);
    const first = await seedOrder(db, runId);
    const second = await seedOrder(db, runId);
    const a = await seedProposal(db, runId, first.links);
    const b = await seedProposal(db, runId, [
      { recordType: 'ledger_entry', recordId: second.ledger },
      { recordType: 'rzp_payment', recordId: first.payment },
    ]);
    const review = service();
    await review.verifyAndRoute([a.proposalId, b.proposalId]);

    const results = await Promise.allSettled([
      review.approve(a.proposalId, { reviewer: 'asha' }),
      review.approve(b.proposalId, { reviewer: 'ben' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected');
    expect(lost?.status === 'rejected' && lost.reason).toBeInstanceOf(ConflictException);
    expect((await groupsOf(runId)).filter((g) => g.status === 'accepted')).toHaveLength(1);
  });

  it('refuses what the verifier rejected, an agent that gave up, an unknown proposal and a closed exception', async () => {
    const runId = await seedRun(db);
    const review = service();

    const bad = await seedProposal(
      db,
      runId,
      (await seedOrder(db, runId, { paymentAmount: 1n })).links,
    );
    await review.verifyAndRoute([bad.proposalId]);
    expect((await conflictOf(review.approve(bad.proposalId, { reviewer: 'asha' }))).error).toBe(
      'not_awaiting_review',
    );

    const gaveUp = await seedProposal(db, runId, (await seedOrder(db, runId)).links, {
      verdict: 'NEEDS_HUMAN',
    });
    await review.verifyAndRoute([gaveUp.proposalId]);
    expect((await conflictOf(review.approve(gaveUp.proposalId, { reviewer: 'asha' }))).error).toBe(
      'nothing_to_approve',
    );

    await expect(
      review.approve('00000000-0000-4000-8000-000000000999', { reviewer: 'asha' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const closed = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    await review.verifyAndRoute([closed.proposalId]);
    await db
      .update(reconExceptions)
      .set({ status: 'dismissed' })
      .where(eq(reconExceptions.id, closed.exceptionId));
    expect((await conflictOf(review.approve(closed.proposalId, { reviewer: 'asha' }))).error).toBe(
      'not_awaiting_review',
    );
  });

  it('refuses a verifier-rejected proposal even if the exception is still marked proposed', async () => {
    const runId = await seedRun(db);
    const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    await db
      .update(agentProposals)
      .set({ verifierStatus: 'rejected', verifierFindings: ['AMOUNT_MISMATCH: x'] })
      .where(eq(agentProposals.id, p.proposalId));
    expect((await conflictOf(service().approve(p.proposalId, { reviewer: 'asha' }))).error).toBe(
      'verifier_rejected',
    );
  });

  it('accepts an explanation: the exception is resolved with the explained reason code, and no group is made', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links, {
      verdict: 'EXPLAINED_NO_MATCH',
      reasonCode: 'DUPLICATE_PAYMENT',
      suggestedAction: 'REFUND_CUSTOMER',
    });
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    const decision = await review.approve(p.proposalId, { reviewer: 'asha', note: 'refund it' });
    expect(decision).toMatchObject({ exceptionStatus: 'resolved', groupId: null });
    expect(await groupsOf(runId)).toHaveLength(0);
    const [exception] = await db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.id, p.exceptionId));
    expect(exception).toMatchObject({ status: 'resolved', reasonCode: 'DUPLICATE_PAYMENT' });
    const [event] = await auditNamed(runId, 'exception.resolve');
    expect(event?.detail).toMatchObject({
      before: { status: 'proposed', reasonCode: 'UNKNOWN' },
      after: { status: 'resolved', reasonCode: 'DUPLICATE_PAYMENT' },
    });
  });
});

describe('reject', () => {
  it('records the reason and sends the exception back to the open list, keeping the proposal as history', async () => {
    const runId = await seedRun(db);
    const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    const decision = await review.reject(p.proposalId, {
      reviewer: 'asha',
      note: 'wrong customer',
    });
    expect(decision).toMatchObject({
      decision: 'rejected',
      exceptionStatus: 'open',
      groupId: null,
    });
    expect(await reviewOf(p.proposalId)).toMatchObject({
      decision: 'rejected',
      reviewer: 'asha',
      note: 'wrong customer',
    });
    expect(await exceptionStatus(p.exceptionId)).toBe('open');
    expect(await proposalOf(p.proposalId)).toBeDefined();
    expect(await groupsOf(runId)).toHaveLength(0);
    expect((await review.queue(runId, { limit: 25, offset: 0 })).total).toBe(0);
    expect((await auditNamed(runId, 'review.reject'))[0]?.detail).toMatchObject({
      reason: 'wrong customer',
      after: { decision: 'rejected', exceptionStatus: 'open' },
    });
  });

  it('works on an agent that gave up too', async () => {
    const runId = await seedRun(db);
    const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links, {
      verdict: 'NEEDS_HUMAN',
    });
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    await expect(
      review.reject(p.proposalId, { reviewer: 'asha', note: 'will chase' }),
    ).resolves.toMatchObject({ decision: 'rejected' });
  });

  it('refuses an unknown proposal', async () => {
    await expect(
      service().reject('00000000-0000-4000-8000-000000000998', { reviewer: 'a', note: 'b' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the queue, the detail and the summary', () => {
  it('lists the largest amount at stake first, and pages', async () => {
    const runId = await seedRun(db);
    const review = service();
    const ids: string[] = [];
    for (const stake of [100n, 300n, 200n, 400n]) {
      const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links, {
        amountAtStake: stake,
      });
      ids.push(p.proposalId);
    }
    await review.verifyAndRoute(ids);
    const all = await review.queue(runId, { limit: 25, offset: 0 });
    expect(all.total).toBe(4);
    expect(all.items.map((i) => i.amountAtStakePaise)).toEqual(['400', '300', '200', '100']);
    const page = await review.queue(runId, { limit: 2, offset: 1 });
    expect(page.items.map((i) => i.amountAtStakePaise)).toEqual(['300', '200']);
    expect(page.total).toBe(4);
  });

  it('shows only what is waiting: not decided, not rejected, not pending, not another run', async () => {
    const runId = await seedRun(db);
    const otherRun = await seedRun(db);
    const review = service();
    const waiting = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const decided = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const refused = await seedProposal(
      db,
      runId,
      (await seedOrder(db, runId, { paymentAmount: 7n })).links,
    );
    await seedProposal(db, runId, (await seedOrder(db, runId)).links); // never verified: pending
    const foreign = await seedProposal(db, otherRun, (await seedOrder(db, otherRun)).links);
    await review.verifyAndRoute([
      waiting.proposalId,
      decided.proposalId,
      refused.proposalId,
      foreign.proposalId,
    ]);
    await review.approve(decided.proposalId, { reviewer: 'asha' });
    expect(
      (await review.queue(runId, { limit: 25, offset: 0 })).items.map((i) => i.proposalId),
    ).toEqual([waiting.proposalId]);
  });

  it('carries what a reviewer needs on each item', async () => {
    const runId = await seedRun(db);
    const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links, {
      confidencePermille: 910,
    });
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    const [item] = (await review.queue(runId, { limit: 1, offset: 0 })).items;
    expect(item).toMatchObject({
      proposalId: p.proposalId,
      exceptionId: p.exceptionId,
      verdict: 'MATCH_PROPOSED',
      confidence: 0.91,
      suggestedAction: 'ACCEPT_MATCH',
      verifier: { status: 'passed' },
      ruleReasonCode: 'UNKNOWN',
      ruleCause: 'receipt_ambiguous',
      amountAtStakePaise: '250000',
    });
  });

  it('gives the detail of a proposal, with its decision once there is one', async () => {
    const runId = await seedRun(db);
    const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    expect((await review.detail(p.proposalId)).review).toBeNull();
    await review.approve(p.proposalId, { reviewer: 'asha', note: 'ok' });
    const detail = await review.detail(p.proposalId);
    expect(detail.review).toMatchObject({ decision: 'approved', reviewer: 'asha', note: 'ok' });
    expect(detail.exception).toMatchObject({ status: 'resolved' });
    expect(detail.proposal.evidence).toHaveLength(1);
    await expect(review.detail('00000000-0000-4000-8000-000000000997')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('counts everything in a run, with the headline "caught by the verifier"', async () => {
    const runId = await seedRun(db);
    const review = service(autoAccept);
    const good = await seedProposal(db, runId, (await seedOrder(db, runId)).links, {
      confidencePermille: 950,
    });
    const human = await seedProposal(db, runId, (await seedOrder(db, runId)).links, {
      confidencePermille: 500,
    });
    const off1 = await seedProposal(
      db,
      runId,
      (await seedOrder(db, runId, { paymentAmount: 250_001n })).links,
    );
    const off2 = await seedProposal(
      db,
      runId,
      (await seedOrder(db, runId, { paymentAmount: 250_002n })).links,
    );
    const note = await seedProposal(db, runId, (await seedOrder(db, runId)).links, {
      verdict: 'EXPLAINED_NO_MATCH',
    });
    await review.verifyAndRoute([good, human, off1, off2, note].map((p) => p.proposalId));
    await review.reject(human.proposalId, { reviewer: 'asha', note: 'no' });

    const summary = await review.summary(runId);
    expect(summary).toMatchObject({
      runId,
      proposals: { total: 5, byVerdict: { MATCH_PROPOSED: 4, EXPLAINED_NO_MATCH: 1 } },
      matchesProposed: 4,
      verifier: { passed: 2, rejected: 2, notApplicable: 1, pending: 0 },
      caughtByVerifier: 2,
      rejectionReasons: { AMOUNT_MISMATCH: 2 },
      queue: { waiting: 1, amountAtStakePaise: '250000' },
      reviews: { approved: 0, rejected: 1, autoAccepted: 1 },
      exceptions: { resolved: 1, open: 3, proposed: 1 },
    });
  });

  it('refuses an unknown run', async () => {
    await expect(service().summary('00000000-0000-4000-8000-000000000996')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service().queue('00000000-0000-4000-8000-000000000996', { limit: 1, offset: 0 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('edges of the pipeline', () => {
  it('does not route or accept a proposal whose exception was closed in the meantime', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links, { exceptionStatus: 'resolved' });
    await service(autoAccept).verifyAndRoute([p.proposalId]);
    expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('passed');
    expect(await groupsOf(runId)).toHaveLength(0);
    expect(await reviewOf(p.proposalId)).toBeUndefined();
    expect(await auditNamed(runId, 'policy.auto_accept')).toHaveLength(0);
    expect(await auditNamed(runId, 'policy.human_review')).toHaveLength(0);
  });

  it('resolves an OPEN exception about a record in the group too, not only proposed ones', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links);
    const bystander = await insertException(db, runId, {
      reasonCode: 'PAYMENT_WITHOUT_LEDGER',
      subjectType: 'rzp_payment',
      subjectId: order.payment,
      status: 'open',
    });
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    await review.approve(p.proposalId, { reviewer: 'asha' });
    expect(await exceptionStatus(bystander)).toBe('resolved');
  });

  it('leaves exceptions of other records alone, and ones already closed', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const unrelated = await seedOrder(db, runId);
    const p = await seedProposal(db, runId, order.links);
    const elsewhere = await insertException(db, runId, {
      reasonCode: 'UNKNOWN',
      subjectType: 'ledger_entry',
      subjectId: unrelated.ledger,
      status: 'open',
    });
    const dismissed = await insertException(db, runId, {
      reasonCode: 'UNKNOWN',
      subjectType: 'rzp_payment',
      subjectId: order.payment,
      status: 'dismissed',
    });
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    await review.approve(p.proposalId, { reviewer: 'asha' });
    expect(await exceptionStatus(elsewhere)).toBe('open');
    expect(await exceptionStatus(dismissed)).toBe('dismissed');
  });

  it('approves a proposal that was never verified by verifying it first', async () => {
    const runId = await seedRun(db);
    const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('pending');
    const decision = await service().approve(p.proposalId, { reviewer: 'asha' });
    expect(decision.groupId).toBeTruthy();
    expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('passed');
    expect(await auditNamed(runId, 'verifier.verified')).toHaveLength(1);
  });

  it('does not write a second verifier step when approval confirms a verdict that already stands', async () => {
    const runId = await seedRun(db);
    const p = await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const review = service();
    await review.verifyAndRoute([p.proposalId]);
    await review.approve(p.proposalId, { reviewer: 'asha' });
    expect(await auditNamed(runId, 'verifier.verified')).toHaveLength(1);
  });

  it("looks up a settlement's payments within the run, not across runs", async () => {
    const runA = await seedRun(db);
    const runB = await seedRun(db);
    const payout = await seedPayout(db, runA);
    // Run B holds payments with the SAME Razorpay ids but different amounts, created first.
    const rzpIds = (await db.select().from(rzpPayments).where(eq(rzpPayments.runId, runA))).map(
      (p) => p.rzpId,
    );
    for (const rzpId of rzpIds) {
      await insertPayment(db, runB, {
        rzpId,
        amountPaise: 100_001n,
        feePaise: 2_000n,
        taxPaise: 305n,
      });
    }
    const p = await seedProposal(db, runA, payout.links, { reasonCode: 'BATCHED_SETTLEMENT' });
    await service().verifyAndRoute([p.proposalId]);
    expect((await proposalOf(p.proposalId))?.verifierStatus).toBe('passed');
  });
});
