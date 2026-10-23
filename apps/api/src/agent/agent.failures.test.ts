// Every way the agent can fail, driven end to end: a scripted model API -> the real loop -> the resilient
// wrapper -> AgentService -> the database. What each test checks is what a person would see afterwards:
// the proposal that was stored (or none), the audit row, the exception's status, and the agent's status.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Queue, type Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RetryDeps, RetryPolicy } from '../common/retry.js';
import {
  insertException,
  insertLedger,
  insertLlmCall,
  insertProposal,
  PG,
  pgErrorOf,
  seedRun,
} from '../db/migrated-db.fixtures.js';
import { agentProposals, auditEvents, llmCalls, reconExceptions } from '../db/schema.js';
import { createMigratedDb, openExceptionInOwnRun, type TestDb } from './agent.fixtures.js';
import { AgentService, type AgentSettings } from './agent.service.js';
import { DEGRADED_LABEL, DEGRADED_REASONS, type DegradedReason } from './degraded.js';
import { AgentHealth } from './health.js';
import type { InvestigationJob } from './jobs.js';
import { classifyLlmFailure, LlmError } from './llm.js';
import { DEFAULT_LIMITS } from './budget.js';
import { LoopRunner } from './loop-runner.js';
import { BullInvestigationQueue, redisConnection, startInvestigationWorker } from './queue.js';
import { LOCAL_REDIS_URL, localRedisAnswers, until } from './redis.fixtures.js';
import { ResilientRunner } from './resilient-runner.js';
import {
  asksFor,
  replyWith,
  result,
  says,
  ScriptedLlm,
  toolUse,
  type Step,
} from './scripted-llm.fixtures.js';
import { AgentHalted, type AgentRunner } from './types.js';

let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];

beforeAll(async () => {
  Logger.overrideLogger(false);
  ({ db, client } = await createMigratedDb());
}, 60_000);
afterAll(async () => {
  await client.close();
});

const SMALL = 'claude-haiku-5-5';
const LARGE = 'claude-sonnet-5-5';

const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  AGENT_KILL_SWITCH: false,
  DAILY_LLM_BUDGET_USD: 5,
  CLUSTER_EXCEPTIONS: false,
  ...over,
});

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 400,
  deadlineMs: 5_000,
};

/** The error the Anthropic client raises for a response with this status, classified the same way. */
function apiError(status: number | null, retryAfterMs: number | null = null) {
  const kind = classifyLlmFailure(status, retryAfterMs);
  return new LlmError(
    `Anthropic API error${status === null ? '' : ` ${status}`}: failed`,
    kind === 'transient',
    status,
    'req_test',
    retryAfterMs,
    kind,
  );
}

interface Rig {
  readonly llm: ScriptedLlm;
  readonly health: AgentHealth;
  readonly service: AgentService;
  readonly waits: number[];
}

/** A service wired like production (loop harness inside the resilient wrapper), minus real waiting. */
function rig(
  steps: Step[],
  options: {
    settings?: Partial<AgentSettings>;
    threshold?: number;
    limits?: typeof DEFAULT_LIMITS;
    now?: () => number;
  } = {},
): Rig {
  const llm = new ScriptedLlm(steps);
  const health = new AgentHealth({ threshold: options.threshold ?? 5 });
  const waits: number[] = [];
  const deps: RetryDeps = {
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    now: () => 0,
  };
  const loop = new LoopRunner({
    client: llm,
    smallModel: SMALL,
    largeModel: LARGE,
    escalation: false,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const runner = new ResilientRunner(loop, { health, policy: POLICY, deps });
  return {
    llm,
    health,
    waits,
    service: new AgentService(db, settings(options.settings), runner, null, health),
  };
}

const job = (runId: string, ...exceptionIds: string[]): InvestigationJob => ({
  runId,
  clusterId: null,
  items: exceptionIds.map((exceptionId) => ({ exceptionId, attempt: 1 })),
});

/** One more open exception in a run, for tests where a second investigation must carry on. */
async function addException(runId: string, ref: string): Promise<string> {
  const ledger = await insertLedger(db, runId, { orderRef: ref, amountPaise: 500n });
  return insertException(db, runId, {
    reasonCode: 'LEDGER_WITHOUT_PAYMENT',
    subjectType: 'ledger_entry',
    subjectId: ledger,
    candidates: [],
    cause: 'no_receipt',
  });
}

const proposalsOf = (exceptionId: string) =>
  db.select().from(agentProposals).where(eq(agentProposals.exceptionId, exceptionId));
const statusOf = async (id: string) =>
  (await db.select().from(reconExceptions).where(eq(reconExceptions.id, id)))[0]?.status;
const proposeAudits = (runId: string) =>
  db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.runId, runId), eq(auditEvents.action, 'agent.propose')));

const feeCall = (n: number) => asksFor([toolUse(`t${n}`, 'get_fee_contract', { method: 'card' })]);

describe('every way an investigation ends without a conclusion is stored, labelled and audited', () => {
  // Each scenario is a real path through the loop, not a hand-built draft.
  const scenarios: Record<DegradedReason, () => Rig> = {
    model_unavailable: () => rig([apiError(529), apiError(529), apiError(529)]),
    model_rejected: () => rig([apiError(400)]),
    invalid_reply: () => rig([says('{"results": ['), says('still not json')]),
    tool_budget: () =>
      rig([feeCall(1), feeCall(2)], { limits: { ...DEFAULT_LIMITS, maxToolCalls: 1 } }),
    token_budget: () => rig([says('{"results":[{"exceptionId":"', { stopReason: 'max_tokens' })]),
    time_budget: () => {
      let t = 0;
      return rig(
        [
          () => {
            t += 10_000;
            return feeCall(1);
          },
        ],
        { limits: { ...DEFAULT_LIMITS, timeoutMs: 1_000 }, now: () => t },
      );
    },
    context: () => rig([says('', { stopReason: 'model_context_window_exceeded' })]),
    refused: () => rig([says('', { stopReason: 'refusal' })]),
  };

  it('has a scenario for every reason the database allows', () => {
    expect(Object.keys(scenarios).sort()).toEqual([...DEGRADED_REASONS].sort());
  });

  it.each(DEGRADED_REASONS)('%s', async (reason) => {
    const run = await openExceptionInOwnRun(db);
    const { service } = scenarios[reason]();
    expect(await service.process(job(run.runId, run.exception))).toEqual({
      stored: 1,
      alreadyDone: 0,
      notOpen: 0,
    });

    const [proposal] = await proposalsOf(run.exception);
    expect(proposal?.degraded).toBe(reason);
    expect(proposal?.verdict).toBe('NEEDS_HUMAN');
    expect(proposal?.suggestedAction).toBe('NONE');
    expect(proposal?.confidencePermille).toBe(0);
    expect(proposal?.links).toEqual([]);
    // The exception goes to a person, who is told why.
    expect(await statusOf(run.exception)).toBe('proposed');
    expect(proposal?.explanation).toContain(
      'The investigation stopped before reaching a conclusion',
    );
    expect(proposal?.harnessFindings.length).toBeGreaterThan(0);

    const [audit] = await proposeAudits(run.runId);
    const detail = audit?.detail as { reason: string; after: { degraded: string | null } };
    expect(audit?.actor).toBe('agent');
    expect(detail.reason).toBe(
      `handed to a person without a conclusion: ${DEGRADED_LABEL[reason]}`,
    );
    expect(detail.after.degraded).toBe(reason);
  });

  it('records the spend of a degraded investigation that did reach the model', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service } = scenarios.refused();
    await service.process(job(run.runId, run.exception));
    expect(await db.select().from(llmCalls).where(eq(llmCalls.runId, run.runId))).toHaveLength(1);
  });

  it('leaves an investigation that concluded un-degraded', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service } = rig([
      replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]),
    ]);
    await service.process(job(run.runId, run.exception));
    const [proposal] = await proposalsOf(run.exception);
    expect(proposal?.degraded).toBeNull();
    expect(((await proposeAudits(run.runId))[0]?.detail as { reason: string }).reason).toMatch(
      /^proposed /,
    );
  });
});

describe('the database refuses a degraded reason nobody defined', () => {
  it('rejects an unknown code and accepts every defined one', async () => {
    const run = await openExceptionInOwnRun(db);
    const bad = await pgErrorOf(
      insertProposal(db, run.runId, run.exception, { degraded: 'bogus' }),
    );
    expect(bad.code).toBe(PG.check);
    expect(bad.constraint).toBe('agent_proposals_degraded_known');

    for (const [i, reason] of DEGRADED_REASONS.entries()) {
      const id = await addException(run.runId, `ORD-D${i}`);
      await insertProposal(db, run.runId, id, { degraded: reason });
    }
  });
});

describe('a model API that times out, is overloaded or rate-limits', () => {
  it('tries again and the proposal says it needed to', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, llm, waits } = rig([
      apiError(529),
      replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]),
    ]);
    await service.process(job(run.runId, run.exception));
    const [proposal] = await proposalsOf(run.exception);
    expect(llm.calls).toBe(2);
    expect(waits).toHaveLength(1);
    expect(proposal?.degraded).toBeNull();
    expect(proposal?.verdict).toBe('EXPLAINED_NO_MATCH');
    expect(proposal?.harnessFindings).toContain(
      'the model API failed 1 time first and then answered',
    );
  });

  it('gives up after its tries and carries on with the next exception in the run', async () => {
    const run = await openExceptionInOwnRun(db);
    const second = await addException(run.runId, 'ORD-NEXT');
    const { service, llm } = rig([
      apiError(null), // a timeout, three times
      apiError(null),
      apiError(null),
      replyWith([
        result(second, {
          verdict: 'EXPLAINED_NO_MATCH',
          links: [],
          reasonCode: 'LEDGER_WITHOUT_PAYMENT',
        }),
      ]),
    ]);

    await service.process(job(run.runId, run.exception)); // does not throw
    await service.process(job(run.runId, second));

    expect((await proposalsOf(run.exception))[0]?.degraded).toBe('model_unavailable');
    expect((await proposalsOf(second))[0]?.degraded).toBeNull();
    expect((await proposalsOf(second))[0]?.verdict).toBe('EXPLAINED_NO_MATCH');
    expect(llm.calls).toBe(4);
  });

  it('honours the wait a 429 asks for', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, waits } = rig([
      apiError(429, 300),
      replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]),
    ]);
    await service.process(job(run.runId, run.exception));
    expect(waits).toEqual([300]);
  });

  it('does not stop the agent for one bad request', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, health } = rig([apiError(400)]);
    await service.process(job(run.runId, run.exception));
    expect((await proposalsOf(run.exception))[0]?.degraded).toBe('model_rejected');
    expect(health.state()).toBeNull();
    expect((await service.status()).paused).toBeNull();
  });
});

describe('a failure every exception would share pauses the agent', () => {
  it.each([
    ['a rejected key (401)', 401, 'model_auth'],
    ['a missing permission (403)', 403, 'model_auth'],
    ['a billing problem (402)', 402, 'provider_limit'],
    ['a spend cap (429 with no retry-after)', 429, 'provider_limit'],
  ] as const)('%s', async (_name, status, reason) => {
    const run = await openExceptionInOwnRun(db);
    const second = await addException(run.runId, 'ORD-LATER');
    const { service, llm } = rig([apiError(status), apiError(status)]);

    await expect(service.process(job(run.runId, run.exception))).rejects.toMatchObject({ reason });
    // Nothing was written: the exception is still open for a later run.
    expect(await proposalsOf(run.exception)).toHaveLength(0);
    expect(await statusOf(run.exception)).toBe('open');
    expect(llm.calls).toBe(1);

    // The next job is turned away at once, without asking the model.
    await expect(service.process(job(run.runId, second))).rejects.toMatchObject({ reason });
    expect(llm.calls).toBe(1);

    const status_ = await service.status();
    expect(status_.paused?.reason).toBe(reason);
    expect(status_.paused?.message).toBeTruthy();
  });

  it('stops an investigation already under way when another worker learns the key is rejected', async () => {
    const run = await openExceptionInOwnRun(db);
    const health = new AgentHealth();
    // A harness whose first request is fine and whose second finds the agent paused by someone else.
    const inner: AgentRunner = {
      harness: 'loop',
      investigate: async (_members, ctx) => {
        await ctx.gate();
        health.pause('model_auth');
        await ctx.gate();
        return [];
      },
    };
    const service = new AgentService(db, settings(), inner, null, health);
    await expect(service.process(job(run.runId, run.exception))).rejects.toMatchObject({
      reason: 'model_auth',
    });
    expect(await statusOf(run.exception)).toBe('open');
  });

  it('trips the circuit breaker after several unavailable investigations in a row', async () => {
    const run = await openExceptionInOwnRun(db);
    const second = await addException(run.runId, 'ORD-B2');
    const third = await addException(run.runId, 'ORD-B3');
    // Two investigations of three tries each; the scripted model has no step beyond its list.
    const { service, llm } = rig(
      Array.from({ length: 6 }, () => apiError(503)),
      { threshold: 2 },
    );

    await service.process(job(run.runId, run.exception));
    await service.process(job(run.runId, second));
    expect((await proposalsOf(run.exception))[0]?.degraded).toBe('model_unavailable');
    expect((await proposalsOf(second))[0]?.degraded).toBe('model_unavailable');
    expect((await service.status()).paused?.reason).toBe('model_unavailable');

    await expect(service.process(job(run.runId, third))).rejects.toMatchObject({
      reason: 'model_unavailable',
    });
    expect(llm.calls).toBe(6);
    expect(await statusOf(third)).toBe('open');
  });

  it('lets a probe through after the cooldown and resumes when the model answers', async () => {
    const run = await openExceptionInOwnRun(db);
    let t = Date.parse('2026-10-23T10:00:00Z');
    const health = new AgentHealth({ threshold: 1, cooldownMs: 60_000, now: () => t });
    const llm = new ScriptedLlm([
      apiError(503),
      apiError(503),
      apiError(503),
      replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]),
    ]);
    const runner = new ResilientRunner(
      new LoopRunner({ client: llm, smallModel: SMALL, largeModel: LARGE, escalation: false }),
      {
        health,
        policy: POLICY,
        deps: { sleep: () => Promise.resolve(), random: () => 0.5, now: () => 0 },
      },
    );
    const service = new AgentService(db, settings(), runner, null, health);
    const other = await addException(run.runId, 'ORD-PROBE');

    await service.process(job(run.runId, other)); // fails, trips the breaker
    expect((await service.status()).paused?.reason).toBe('model_unavailable');
    await expect(service.process(job(run.runId, run.exception))).rejects.toBeInstanceOf(
      AgentHalted,
    );

    t += 60_000; // the cooldown has run
    expect((await service.status()).paused).toBeNull();
    await service.process(job(run.runId, run.exception));
    expect((await proposalsOf(run.exception))[0]?.degraded).toBeNull();
    expect((await service.status()).paused).toBeNull();
  });
});

describe('the daily budget and the kill switch', () => {
  it('reports a budget that is spent, with the figures', async () => {
    const runId = await seedRun(db);
    // Spend is global for the UTC day, so this test lives on a day of its own.
    await insertLlmCall(db, runId, {
      costUsd: '9.000000',
      createdAt: new Date('2032-01-10T10:00:00Z'),
    });
    const s = new AgentService(db, settings({ DAILY_LLM_BUDGET_USD: 5 }), null);
    s.clock = () => new Date('2032-01-10T12:00:00Z');
    const status = await s.status();
    expect(status.paused?.reason).toBe('daily_budget');
    expect(status.paused?.message).toBeTruthy();
    expect(status.spentTodayUsd).toBe('9.000000');
    expect(status.dailyBudgetUsd).toBe('5.000000');
  });

  it('reports the kill switch before anything else', async () => {
    const health = new AgentHealth();
    health.pause('model_auth');
    const s = new AgentService(db, settings({ AGENT_KILL_SWITCH: true }), null, null, health);
    expect((await s.status()).paused?.reason).toBe('kill_switch');
  });

  it('reports nothing when all is well, and says whether a harness is configured', async () => {
    const s = new AgentService(db, settings({ DAILY_LLM_BUDGET_USD: 1_000_000 }), null);
    const status = await s.status();
    expect(status.paused).toBeNull();
    expect(status.configured).toBe(false);
  });

  it('turns an investigation away at the gate while the budget is spent, leaving the exception open', async () => {
    const run = await openExceptionInOwnRun(db);
    await insertLlmCall(db, run.runId, {
      costUsd: '50.000000',
      createdAt: new Date('2033-02-03T10:00:00Z'),
    });
    const { service, llm } = rig([replyWith([result(run.exception)])], {
      settings: { DAILY_LLM_BUDGET_USD: 5 },
    });
    service.clock = () => new Date('2033-02-03T12:00:00Z');
    await expect(service.process(job(run.runId, run.exception))).rejects.toMatchObject({
      reason: 'daily_budget',
    });
    expect(llm.calls).toBe(0);
    expect(await statusOf(run.exception)).toBe('open');
  });

  it('still plans: the list of what to investigate is the same while the agent is paused', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, health } = rig([]);
    health.pause('model_auth');
    const plan = await service.plan(run.runId);
    expect(plan.exceptions).toBe(1);
    expect(plan.jobs).toHaveLength(1);
  });
});

describe('a job delivered more than once', () => {
  it('after a degraded outcome is not investigated again, even if the model has recovered', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, llm } = rig([
      apiError(529),
      apiError(529),
      apiError(529),
      replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]),
    ]);
    const j = job(run.runId, run.exception);
    expect((await service.process(j)).stored).toBe(1);
    expect(await service.process(j)).toEqual({ stored: 0, alreadyDone: 1, notOpen: 0 });
    expect(llm.calls).toBe(3);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect(await proposeAudits(run.runId)).toHaveLength(1);
  });

  it('after a crash before anything was stored is investigated once more, and stored once', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service } = rig([
      new Error('worker killed'), // not an LlmError: the job fails, as it should
      replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]),
    ]);
    const j = job(run.runId, run.exception);
    await expect(service.process(j)).rejects.toThrow('worker killed');
    expect(await proposalsOf(run.exception)).toHaveLength(0);
    expect(await statusOf(run.exception)).toBe('open');

    expect((await service.process(j)).stored).toBe(1);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect(await proposeAudits(run.runId)).toHaveLength(1);
  });

  it('twice at the same moment writes one proposal and one audit row, and neither throws', async () => {
    const run = await openExceptionInOwnRun(db);
    const reply = () =>
      replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]);
    const { service } = rig([
      async () => {
        await new Promise((r) => setTimeout(r, 15));
        return reply();
      },
      async () => {
        await new Promise((r) => setTimeout(r, 15));
        return reply();
      },
    ]);
    const j = job(run.runId, run.exception);
    const [a, b] = await Promise.all([service.process(j), service.process(j)]);
    expect(a.stored + b.stored).toBe(1);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect(await proposeAudits(run.runId)).toHaveLength(1);
  });

  it('twice at the same moment, both degraded, still writes one of each', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service } = rig(Array.from({ length: 6 }, () => apiError(529)));
    const j = job(run.runId, run.exception);
    const [a, b] = await Promise.all([service.process(j), service.process(j)]);
    expect(a.stored + b.stored).toBe(1);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect(await proposeAudits(run.runId)).toHaveLength(1);
  });
});

const redisAvailable = await localRedisAnswers();
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

// The same promises, but through a real BullMQ worker on the local Redis: a job comes back as the queue
// redelivers it, or ends as the worker treats the failure. Skipped when the compose Redis is not running.
describe.skipIf(!redisAvailable)('through a real queue worker', () => {
  const name = `ziro-fail-${randomUUID().slice(0, 8)}`;
  let inspect: Queue;
  let queue: BullInvestigationQueue;
  let worker: Worker | null = null;

  beforeAll(() => {
    inspect = new Queue(name, { connection: redisConnection(LOCAL_REDIS_URL) });
    queue = new BullInvestigationQueue(LOCAL_REDIS_URL, name, 10);
  });
  afterEach(async () => {
    await worker?.close();
    worker = null;
    await inspect.obliterate({ force: true });
  });
  afterAll(async () => {
    await queue.close();
    await inspect.obliterate({ force: true }).catch(() => undefined);
    await inspect.close();
  });

  /** Runs the service on every delivery; `after` lets a test misbehave once the work is done. */
  function work(service: AgentService, after?: (delivery: number) => void) {
    const state = { deliveries: 0, outcomes: [] as unknown[] };
    worker = startInvestigationWorker({
      redisUrl: LOCAL_REDIS_URL,
      name,
      concurrency: 1,
      process: async (j) => {
        state.deliveries += 1;
        const outcome = await service.process(j);
        state.outcomes.push(outcome);
        after?.(state.deliveries);
        return outcome;
      },
    });
    return { state, ready: worker.waitUntilReady() };
  }
  const nothingLeft = () =>
    inspect.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');

  it('a worker that dies after storing, before acknowledging, leaves one proposal and costs one request', async () => {
    const run = await openExceptionInOwnRun(db);
    const reply = () =>
      replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]);
    const { service, llm } = rig([reply(), reply()]);
    const { state, ready } = work(service, (delivery) => {
      if (delivery === 1) throw new Error('lost the connection before acknowledging');
    });
    await ready;
    await queue.enqueue([job(run.runId, run.exception)]);
    await until(() => state.deliveries === 2);
    await settle();

    expect(state.outcomes).toEqual([
      { stored: 1, alreadyDone: 0, notOpen: 0 },
      { stored: 0, alreadyDone: 1, notOpen: 0 },
    ]);
    expect(llm.calls).toBe(1);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect(await proposeAudits(run.runId)).toHaveLength(1);
  });

  it('a model outage degrades the exception and the job is done: no retry storm', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, llm } = rig([apiError(529), apiError(529), apiError(529)]);
    const { state, ready } = work(service);
    await ready;
    await queue.enqueue([job(run.runId, run.exception)]);
    await until(() => state.deliveries === 1);
    await settle();

    expect(state.deliveries).toBe(1);
    expect(llm.calls).toBe(3);
    expect((await proposalsOf(run.exception))[0]?.degraded).toBe('model_unavailable');
    expect(await nothingLeft()).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });
  });

  it('a rejected key halts: one delivery, no retry, the exception stays open and the agent shows paused', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, llm } = rig([apiError(401), apiError(401), apiError(401)]);
    let rejected = 0;
    worker = startInvestigationWorker({
      redisUrl: LOCAL_REDIS_URL,
      name,
      concurrency: 1,
      process: async (j) => {
        rejected += 1;
        return service.process(j);
      },
    });
    await worker.waitUntilReady();
    await queue.enqueue([job(run.runId, run.exception)]);
    await until(() => rejected === 1);
    await settle();

    expect(rejected).toBe(1);
    expect(llm.calls).toBe(1);
    expect(await statusOf(run.exception)).toBe('open');
    expect((await service.status()).paused?.reason).toBe('model_auth');
    expect(await nothingLeft()).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });
  });

  it('a spent daily budget halts the same way, and asking again later is allowed', async () => {
    const run = await openExceptionInOwnRun(db);
    await insertLlmCall(db, run.runId, {
      costUsd: '50.000000',
      createdAt: new Date('2034-03-04T10:00:00Z'),
    });
    const { service, llm } = rig([replyWith([result(run.exception)])], {
      settings: { DAILY_LLM_BUDGET_USD: 5 },
    });
    service.clock = () => new Date('2034-03-04T12:00:00Z');
    let deliveries = 0;
    worker = startInvestigationWorker({
      redisUrl: LOCAL_REDIS_URL,
      name,
      concurrency: 1,
      process: async (j) => {
        deliveries += 1;
        return service.process(j);
      },
    });
    await worker.waitUntilReady();
    await queue.enqueue([job(run.runId, run.exception)]);
    await until(() => deliveries === 1);
    await settle();

    expect(deliveries).toBe(1);
    expect(llm.calls).toBe(0);
    expect(await statusOf(run.exception)).toBe('open');
    // The job is gone, so the same one can be enqueued again once there is budget.
    await queue.enqueue([job(run.runId, run.exception)]);
    await until(() => deliveries === 2);
  });
});
