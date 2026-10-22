import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertException,
  insertLedger,
  insertLlmCall,
  insertPayment,
  seedRun,
} from '../db/migrated-db.fixtures.js';
import {
  agentProposals,
  auditEventRecords,
  auditEvents,
  llmCalls,
  reconExceptions,
} from '../db/schema.js';
import { buildWorld, createMigratedDb, type TestDb, type World } from './agent.fixtures.js';
import { AgentService, type AgentSettings } from './agent.service.js';
import type { InvestigationJob } from './jobs.js';
import { formatMicroUsd } from './pricing.js';
import { LoopRunner } from './loop-runner.js';
import { asksFor, replyWith, result, ScriptedLlm, toolUse } from './scripted-llm.fixtures.js';
import {
  AgentHalted,
  type AgentRunner,
  type ExceptionToInvestigate,
  type InvestigationContext,
  type ProposalDraft,
} from './types.js';

let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let world: World;

beforeAll(async () => {
  ({ db, client } = await createMigratedDb());
  world = await buildWorld(db);
}, 60_000);
afterAll(async () => {
  await client.close();
});

const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  AGENT_KILL_SWITCH: false,
  DAILY_LLM_BUDGET_USD: 5,
  CLUSTER_EXCEPTIONS: false,
  ...over,
});

/** A harness that returns what it is told, and remembers what it was asked. */
class StubRunner implements AgentRunner {
  readonly harness = 'loop' as const;
  readonly asked: ExceptionToInvestigate[][] = [];
  constructor(
    private readonly make: (
      members: readonly ExceptionToInvestigate[],
      ctx: InvestigationContext,
    ) => Promise<ProposalDraft[]> | ProposalDraft[],
  ) {}
  async investigate(members: readonly ExceptionToInvestigate[], ctx: InvestigationContext) {
    this.asked.push([...members]);
    return this.make(members, ctx);
  }
}

const draftFor = (
  exceptionId: string,
  over: Partial<ProposalDraft['content']> = {},
  extra: Partial<ProposalDraft> = {},
): ProposalDraft => ({
  content: {
    exceptionId,
    verdict: 'EXPLAINED_NO_MATCH',
    reasonCode: 'DUPLICATE_PAYMENT',
    links: [{ recordType: 'rzp_payment', recordId: world.payments.p2 }],
    explanation: 'pay_P2 and pay_P3 are one order paid twice.',
    evidence: [
      { tool: 'get_exception', args: { exception_id: exceptionId }, keyFinding: 'two candidates' },
    ],
    confidence: 0.92,
    suggestedAction: 'REFUND_CUSTOMER',
    draftJournalEntry: null,
    ...over,
  },
  model: 'claude-haiku-5-5',
  harnessFindings: [],
  llmCallId: null,
  ...extra,
});

const job = (runId: string, ...items: [string, number][]): InvestigationJob => ({
  runId,
  clusterId: null,
  items: items.map(([exceptionId, attempt]) => ({ exceptionId, attempt })),
});

const proposalsOf = (exceptionId: string) =>
  db.select().from(agentProposals).where(eq(agentProposals.exceptionId, exceptionId));
const statusOf = async (id: string) =>
  (await db.select().from(reconExceptions).where(eq(reconExceptions.id, id)))[0]?.status;
const reopen = (id: string) =>
  db.update(reconExceptions).set({ status: 'open' }).where(eq(reconExceptions.id, id));
const auditOf = (action: string) =>
  db.select().from(auditEvents).where(eq(auditEvents.action, action));

/** A run of its own, so a test's exceptions and proposals do not disturb the shared world. */
async function freshRun() {
  const runId = await seedRun(db);
  const ledger = await insertLedger(db, runId, { orderRef: 'ORD-F1', amountPaise: 500n });
  const payment = await insertPayment(db, runId, {
    rzpId: 'pay_F1',
    receipt: 'ORD-F1',
    amountPaise: 500n,
    feePaise: 0n,
    taxPaise: 0n,
  });
  const exception = await insertException(db, runId, {
    reasonCode: 'DUPLICATE_PAYMENT',
    subjectType: 'ledger_entry',
    subjectId: ledger,
    candidates: [{ recordType: 'rzp_payment', recordId: payment }],
    cause: 'receipt_ambiguous',
  });
  return { runId, ledger, payment, exception };
}

describe('plan', () => {
  const service = (over: Partial<AgentSettings> = {}) =>
    new AgentService(db, settings(over), new StubRunner(() => []));

  it('plans one job per open exception, skipping a bank credit nothing explains', async () => {
    const plan = await service().plan(world.runId);
    expect(plan.exceptions).toBe(2);
    expect(plan.jobs.map((j) => j.items.map((i) => [i.exceptionId, i.attempt]))).toEqual(
      expect.arrayContaining([[[world.exceptions.duplicate, 1]], [[world.exceptions.other, 1]]]),
    );
    expect(plan.jobs.every((j) => j.clusterId === null && j.runId === world.runId)).toBe(true);
    expect(plan.skipped).toEqual([
      {
        exceptionId: world.exceptions.unexplainedCredit,
        why: expect.stringContaining('listed for a person') as string,
      },
    ]);
  });

  it("never plans another run's exceptions", async () => {
    const plan = await service().plan(world.runId);
    const { rows } = await db.execute(
      `select id from recon_exceptions where run_id = '${world.otherRunId}'`,
    );
    const foreign = (rows[0] as { id: string }).id;
    expect(plan.jobs.flatMap((j) => j.items.map((i) => i.exceptionId))).not.toContain(foreign);
  });

  it('plans just the exception asked for', async () => {
    const plan = await service().plan(world.runId, world.exceptions.other);
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]?.items[0]?.exceptionId).toBe(world.exceptions.other);
  });

  it("refuses an unknown run, an unknown exception, another run's exception, and one that is not open", async () => {
    const s = service();
    await expect(s.plan(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.plan(world.runId, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    const { rows } = await db.execute(
      `select id from recon_exceptions where run_id = '${world.otherRunId}'`,
    );
    await expect(s.plan(world.runId, (rows[0] as { id: string }).id)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const run = await freshRun();
    await db
      .update(reconExceptions)
      .set({ status: 'dismissed' })
      .where(eq(reconExceptions.id, run.exception));
    await expect(s.plan(run.runId, run.exception)).rejects.toBeInstanceOf(ConflictException);
  });

  it('numbers a re-run as the next attempt', async () => {
    const run = await freshRun();
    const stub = new StubRunner((members) => members.map((m) => draftFor(m.id)));
    const s = new AgentService(db, settings(), stub);
    expect((await s.plan(run.runId)).jobs[0]?.items[0]?.attempt).toBe(1);
    await s.process(job(run.runId, [run.exception, 1]));
    expect((await s.plan(run.runId)).jobs).toHaveLength(0); // proposed, so no longer open
    await reopen(run.exception);
    // "Investigate all" leaves an exception that was already investigated alone: asking costs money.
    const all = await s.plan(run.runId);
    expect(all.jobs).toHaveLength(0);
    expect(all.skipped).toEqual([
      {
        exceptionId: run.exception,
        why: expect.stringContaining('already investigated') as string,
      },
    ]);
    // Asked for by id, it is the next attempt.
    expect((await s.plan(run.runId, run.exception)).jobs[0]?.items[0]?.attempt).toBe(2);
  });

  it('clusters exceptions that share a record when CLUSTER_EXCEPTIONS is on, with a stable cluster id', async () => {
    const run = await freshRun();
    const second = await insertLedger(db, run.runId, { orderRef: 'ORD-F2', amountPaise: 500n });
    const other = await insertException(db, run.runId, {
      reasonCode: 'DUPLICATE_PAYMENT',
      subjectType: 'ledger_entry',
      subjectId: second,
      candidates: [{ recordType: 'rzp_payment', recordId: run.payment }],
    });
    const off = await service({ CLUSTER_EXCEPTIONS: false }).plan(run.runId);
    expect(off.jobs).toHaveLength(2);

    const on = await service({ CLUSTER_EXCEPTIONS: true }).plan(run.runId);
    expect(on.jobs).toHaveLength(1);
    expect(on.jobs[0]?.items.map((i) => i.exceptionId).sort()).toEqual(
      [run.exception, other].sort(),
    );
    expect(on.jobs[0]?.clusterId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await service({ CLUSTER_EXCEPTIONS: true }).plan(run.runId)).jobs[0]?.clusterId).toBe(
      on.jobs[0]?.clusterId,
    );
  });
});

describe('gate', () => {
  const at = (iso: string) => {
    const s = new AgentService(db, settings({ DAILY_LLM_BUDGET_USD: 0.01 }), null);
    s.clock = () => new Date(iso);
    return s;
  };

  it('stops everything when the kill switch is on', async () => {
    const s = new AgentService(db, settings({ AGENT_KILL_SWITCH: true }), null);
    await expect(s.gate()).rejects.toMatchObject({ reason: 'kill_switch' });
  });

  it('allows a call under the daily budget and refuses at the budget, to the micro-dollar', async () => {
    const runId = await seedRun(db);
    const day = new Date('2031-03-05T10:00:00Z');
    await insertLlmCall(db, runId, { costUsd: '0.004200', createdAt: day });
    await insertLlmCall(db, runId, { costUsd: '0.005799', createdAt: day });
    const s = at('2031-03-05T20:00:00Z');
    expect(await s.spentToday()).toBe(9_999n);
    await expect(s.gate()).resolves.toBeUndefined();

    await insertLlmCall(db, runId, { costUsd: '0.000001', createdAt: day });
    expect(await s.spentToday()).toBe(10_000n);
    await expect(s.gate()).rejects.toMatchObject({ reason: 'daily_budget' });
  });

  it("counts only today (UTC): yesterday's spend does not block today", async () => {
    const runId = await seedRun(db);
    await insertLlmCall(db, runId, {
      costUsd: '9.000000',
      createdAt: new Date('2031-06-01T23:59:59Z'),
    });
    const s = at('2031-06-02T00:00:01Z');
    expect(await s.spentToday()).toBe(0n);
    await expect(s.gate()).resolves.toBeUndefined();
  });
});

describe('process', () => {
  it('stores the proposal, opens it for review, and audits it, in one go', async () => {
    const run = await freshRun();
    const stub = new StubRunner(async (members, ctx) => {
      const id = await ctx.recordLlmCall({
        exceptionId: members[0]?.id ?? null,
        model: 'claude-haiku-5-5',
        harness: 'loop',
        usage: {
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheReadTokens: 20_000,
          cacheWriteTokens: 5_000,
        },
        costMicroUsd: 2_825n,
        latencyMs: 1234,
        promptHash: 'a'.repeat(64),
        stopReason: 'end_turn',
        requestId: 'req_x',
      });
      return members.map((m) =>
        draftFor(
          m.id,
          {
            confidence: 0.923,
            draftJournalEntry: {
              memo: 'Refund the duplicate',
              lines: [
                { account: 'REFUNDS', debit: 50_000n as never, credit: 0n as never },
                { account: 'BANK', debit: 0n as never, credit: 50_000n as never },
              ],
            },
          },
          { llmCallId: id, harnessFindings: ['a note'] },
        ),
      );
    });
    const s = new AgentService(db, settings(), stub);
    const out = await s.process(job(run.runId, [run.exception, 1]));

    expect(out).toEqual({ stored: 1, alreadyDone: 0, notOpen: 0 });
    expect(stub.asked).toEqual([[{ id: run.exception, ruleReasonCode: 'DUPLICATE_PAYMENT' }]]);

    const [proposal] = await proposalsOf(run.exception);
    expect(proposal).toMatchObject({
      runId: run.runId,
      attempt: 1,
      clusterId: null,
      model: 'claude-haiku-5-5',
      verdict: 'EXPLAINED_NO_MATCH',
      reasonCode: 'DUPLICATE_PAYMENT',
      confidencePermille: 923,
      suggestedAction: 'REFUND_CUSTOMER',
      harnessFindings: ['a note'],
      verifierStatus: 'pending',
    });
    expect(proposal?.links).toEqual([{ recordType: 'rzp_payment', recordId: world.payments.p2 }]);
    expect(proposal?.draftJournalEntry).toEqual({
      memo: 'Refund the duplicate',
      lines: [
        { account: 'REFUNDS', debit: '50000', credit: '0' },
        { account: 'BANK', debit: '0', credit: '50000' },
      ],
    });
    expect(await statusOf(run.exception)).toBe('proposed');

    const [call] = await db.select().from(llmCalls).where(eq(llmCalls.runId, run.runId));
    expect(call).toMatchObject({
      exceptionId: run.exception,
      tokensIn: 10_000,
      tokensOut: 2_000,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 5_000,
      costUsd: '0.002825',
      latencyMs: 1234,
      harness: 'loop',
      stopReason: 'end_turn',
      requestId: 'req_x',
    });
    expect(proposal?.llmCallId).toBe(call?.id);

    const audit = (await auditOf('agent.propose')).filter((a) => a.runId === run.runId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: 'agent',
      entityType: 'agent_proposal',
      entityId: proposal?.id,
    });
    expect(audit[0]?.detail).toMatchObject({
      before: { exceptionStatus: 'open' },
      reason: 'proposed EXPLAINED_NO_MATCH (DUPLICATE_PAYMENT) at 0.923 confidence',
      after: {
        exceptionStatus: 'proposed',
        exceptionId: run.exception,
        attempt: 1,
        verdict: 'EXPLAINED_NO_MATCH',
        confidencePermille: 923,
        model: 'claude-haiku-5-5',
        harness: 'loop',
        llmCallId: call?.id,
      },
    });
    // The step is in the timeline of the exception's subject and of every record the proposal links.
    const indexed = await db
      .select()
      .from(auditEventRecords)
      .where(eq(auditEventRecords.auditEventId, audit[0]?.id ?? 0n));
    expect(indexed.map((r) => r.recordId)).toEqual(
      expect.arrayContaining([run.ledger, world.payments.p2]),
    );
  });

  it('is idempotent: the same job twice is one proposal, one audit row, and no second investigation', async () => {
    const run = await freshRun();
    const stub = new StubRunner((members) => members.map((m) => draftFor(m.id)));
    const s = new AgentService(db, settings(), stub);
    const j = job(run.runId, [run.exception, 1]);
    expect((await s.process(j)).stored).toBe(1);
    expect(await s.process(j)).toEqual({ stored: 0, alreadyDone: 1, notOpen: 0 });
    expect(stub.asked).toHaveLength(1);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect((await auditOf('agent.propose')).filter((a) => a.runId === run.runId)).toHaveLength(1);
  });

  it('stores exactly one proposal when two workers race on the same job', async () => {
    const run = await freshRun();
    const stub = new StubRunner(async (members) => {
      await new Promise((r) => setTimeout(r, 10));
      return members.map((m) => draftFor(m.id));
    });
    const s = new AgentService(db, settings(), stub);
    const j = job(run.runId, [run.exception, 1]);
    const [a, b] = await Promise.all([s.process(j), s.process(j)]);
    expect(a.stored + b.stored).toBe(1);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect((await auditOf('agent.propose')).filter((x) => x.runId === run.runId)).toHaveLength(1);
  });

  it('keeps each attempt as its own proposal', async () => {
    const run = await freshRun();
    const stub = new StubRunner((members) => members.map((m) => draftFor(m.id)));
    const s = new AgentService(db, settings(), stub);
    await s.process(job(run.runId, [run.exception, 1]));
    await reopen(run.exception);
    await s.process(job(run.runId, [run.exception, 2]));
    expect((await proposalsOf(run.exception)).map((p) => p.attempt).sort()).toEqual([1, 2]);
  });

  it('does not investigate an exception that is no longer open', async () => {
    const run = await freshRun();
    await db
      .update(reconExceptions)
      .set({ status: 'resolved' })
      .where(eq(reconExceptions.id, run.exception));
    const stub = new StubRunner((members) => members.map((m) => draftFor(m.id)));
    const out = await new AgentService(db, settings(), stub).process(
      job(run.runId, [run.exception, 1]),
    );
    expect(out).toEqual({ stored: 0, alreadyDone: 0, notOpen: 1 });
    expect(stub.asked).toHaveLength(0);
  });

  it('does not touch an exception of another run, even if a job names it', async () => {
    const run = await freshRun();
    const stub = new StubRunner((members) => members.map((m) => draftFor(m.id)));
    const out = await new AgentService(db, settings(), stub).process(
      job(world.runId, [run.exception, 1]),
    );
    expect(out.stored).toBe(0);
    expect(stub.asked).toHaveLength(0);
    expect(await statusOf(run.exception)).toBe('open');
  });

  it('stores one proposal per member of a cluster, all sharing the cluster id', async () => {
    const run = await freshRun();
    const second = await insertLedger(db, run.runId, { orderRef: 'ORD-F3', amountPaise: 500n });
    const other = await insertException(db, run.runId, {
      reasonCode: 'DUPLICATE_PAYMENT',
      subjectType: 'ledger_entry',
      subjectId: second,
      candidates: [{ recordType: 'rzp_payment', recordId: run.payment }],
    });
    const stub = new StubRunner((members) => members.map((m) => draftFor(m.id)));
    const clusterId = randomUUID();
    const out = await new AgentService(db, settings(), stub).process({
      runId: run.runId,
      clusterId,
      items: [
        { exceptionId: run.exception, attempt: 1 },
        { exceptionId: other, attempt: 1 },
      ],
    });
    expect(out.stored).toBe(2);
    expect(stub.asked).toHaveLength(1); // one conversation
    const rows = await db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.runId, run.runId))
      .orderBy(asc(agentProposals.exceptionId));
    expect(rows.map((r) => r.clusterId)).toEqual([clusterId, clusterId]);
  });

  it('writes nothing at all if any part of the write fails', async () => {
    const run = await freshRun();
    const second = await insertLedger(db, run.runId, { orderRef: 'ORD-F4', amountPaise: 500n });
    const other = await insertException(db, run.runId, {
      reasonCode: 'DUPLICATE_PAYMENT',
      subjectType: 'ledger_entry',
      subjectId: second,
      candidates: [{ recordType: 'rzp_payment', recordId: run.payment }],
    });
    // The second draft breaks a database CHECK (confidence is stored per-mille, 0 to 1000).
    const stub = new StubRunner((members) =>
      members.map((m, i) => draftFor(m.id, i === 0 ? {} : { confidence: 5 })),
    );
    const s = new AgentService(db, settings(), stub);
    await expect(
      s.process({
        runId: run.runId,
        clusterId: randomUUID(),
        items: [
          { exceptionId: run.exception, attempt: 1 },
          { exceptionId: other, attempt: 1 },
        ],
      }),
    ).rejects.toThrow();
    expect(await proposalsOf(run.exception)).toHaveLength(0);
    expect(await proposalsOf(other)).toHaveLength(0);
    expect(await statusOf(run.exception)).toBe('open');
    expect((await auditOf('agent.propose')).filter((a) => a.runId === run.runId)).toHaveLength(0);
  });

  it('refuses drafts that do not match the exceptions it asked about', async () => {
    const run = await freshRun();
    const stub = new StubRunner(() => [draftFor(randomUUID())]);
    await expect(
      new AgentService(db, settings(), stub).process(job(run.runId, [run.exception, 1])),
    ).rejects.toThrow(/do not match/);
    expect(await proposalsOf(run.exception)).toHaveLength(0);
  });

  it('lets a halt through and leaves the exception open', async () => {
    const run = await freshRun();
    const stub = new StubRunner(async (_m, ctx) => {
      await ctx.gate();
      return [];
    });
    const s = new AgentService(db, settings({ AGENT_KILL_SWITCH: true }), stub);
    await expect(s.process(job(run.runId, [run.exception, 1]))).rejects.toBeInstanceOf(AgentHalted);
    expect(await statusOf(run.exception)).toBe('open');
    expect(await proposalsOf(run.exception)).toHaveLength(0);
  });

  it('says so when no harness is configured', async () => {
    const run = await freshRun();
    const s = new AgentService(db, settings(), null);
    expect(s.configured).toBe(false);
    await expect(s.process(job(run.runId, [run.exception, 1]))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('the whole pipeline, with a scripted model', () => {
  it('investigates, records every call, stores a grounded proposal and audits it', async () => {
    const run = await freshRun();
    const llm = new ScriptedLlm([
      asksFor([toolUse('t1', 'get_payment', { id: 'pay_F1' })]),
      replyWith([
        result(run.exception, {
          reasonCode: 'DUPLICATE_PAYMENT',
          evidence: [
            { call: 0, keyFinding: 'one candidate payment' },
            { call: 1, keyFinding: 'pay_F1 is captured for 500 paise' },
          ],
          links: [
            { recordType: 'ledger_entry', recordId: run.ledger },
            { recordType: 'rzp_payment', recordId: run.payment },
          ],
          verdict: 'MATCH_PROPOSED',
          suggestedAction: 'ACCEPT_MATCH',
          confidence: 0.95,
        }),
      ]),
    ]);
    const runner = new LoopRunner({
      client: llm,
      smallModel: 'claude-haiku-5-5',
      largeModel: 'claude-sonnet-5-5',
      escalation: false,
    });
    const s = new AgentService(db, settings(), runner);
    expect(await s.process(job(run.runId, [run.exception, 1]))).toEqual({
      stored: 1,
      alreadyDone: 0,
      notOpen: 0,
    });

    const calls = await db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.runId, run.runId))
      .orderBy(asc(llmCalls.createdAt));
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (c) =>
          c.model === 'claude-haiku-5-5' && c.harness === 'loop' && c.exceptionId === run.exception,
      ),
    ).toBe(true);
    expect(calls[0]?.stopReason).toBe('tool_use');
    expect(calls[1]?.costUsd).toBe('0.000200'); // 1000 in x $0.10 + 200 out x $0.50 per million = 100 + 100 micro-USD

    const [proposal] = await proposalsOf(run.exception);
    expect(proposal?.verdict).toBe('MATCH_PROPOSED');
    expect(proposal?.suggestedAction).toBe('ACCEPT_MATCH');
    expect(proposal?.confidencePermille).toBe(950);
    expect((proposal?.evidence as { tool: string }[]).map((e) => e.tool)).toEqual([
      'get_exception',
      'get_payment',
    ]);
    expect(proposal?.llmCallId).toBe(calls[1]?.id);
    expect(await statusOf(run.exception)).toBe('proposed');
    const [audit] = (await auditOf('agent.propose')).filter((a) => a.runId === run.runId);
    expect(audit?.actor).toBe('agent');
  });

  it('records the spend of a halted investigation, and stores nothing', async () => {
    const run = await freshRun();
    const llm = new ScriptedLlm([
      asksFor([toolUse('t1', 'get_fee_contract', { method: 'upi' })]),
      replyWith([result(run.exception)]),
    ]);
    const runner = new LoopRunner({
      client: llm,
      smallModel: 'claude-haiku-5-5',
      largeModel: 'claude-sonnet-5-5',
      escalation: false,
    });
    const probe = new AgentService(db, settings(), null);
    // Room for exactly one request: it costs 200 micro-USD (1000 in, 200 out on Haiku 5.5).
    const budget = Number(formatMicroUsd((await probe.spentToday()) + 200n));
    const s = new AgentService(db, settings({ DAILY_LLM_BUDGET_USD: budget }), runner);
    await expect(s.process(job(run.runId, [run.exception, 1]))).rejects.toBeInstanceOf(AgentHalted);
    expect(llm.calls).toBe(1);
    expect(
      await db
        .select()
        .from(llmCalls)
        .where(and(eq(llmCalls.runId, run.runId))),
    ).toHaveLength(1);
    expect(await proposalsOf(run.exception)).toHaveLength(0);
    expect(await statusOf(run.exception)).toBe('open');
  });
});
