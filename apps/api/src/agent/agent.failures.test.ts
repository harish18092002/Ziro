// Every way the agent can fail, driven end to end: scripted models -> the real router -> a real harness ->
// AgentService -> the database. What each test checks is what a person would see afterwards: the proposal
// that was stored (or none), the audit row, the exception's status, and the agent's status.
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { LlmError, type LlmErrorKind } from '@ziro/core/llm';
import { Queue, type Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import type { BuiltRouter } from '../llm/factory.js';
import { createMigratedDb, openExceptionInOwnRun, type TestDb } from './agent.fixtures.js';
import { AgentService, type AgentSettings } from './agent.service.js';
import { DEFAULT_LIMITS, type Limits } from './budget.js';
import { DEGRADED_LABEL, DEGRADED_REASONS, type DegradedReason } from './degraded.js';
import type { InvestigationJob } from './jobs.js';
import { LoopRunner } from './loop-runner.js';
import { BullInvestigationQueue, redisConnection, startInvestigationWorker } from './queue.js';
import { LOCAL_REDIS_URL, localRedisAnswers, until } from './redis.fixtures.js';
import {
  asksFor,
  type FakeStep,
  replyWith,
  result,
  says,
  scriptedRouter,
  toolCall,
} from './scripted-llm.fixtures.js';
import { SingleShotRunner } from './single-shot.js';
import type { AgentRunner } from './types.js';

let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];

beforeAll(async () => {
  Logger.overrideLogger(false);
  ({ db, client } = await createMigratedDb());
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

/** What a provider adapter throws for a failure of this kind (the adapters' own tests prove the mapping). */
const failure = (kind: LlmErrorKind, retryAfterMs?: number): LlmError =>
  new LlmError(kind, `${kind} from the provider`, {
    provider: 'gemini',
    model: 'small',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

type HarnessKind = 'loop' | 'single-shot';

interface Rig {
  readonly service: AgentService;
  readonly sr: ReturnType<typeof scriptedRouter>;
  readonly calls: () => number;
}

/** A service wired like production: a harness over the router, with scripted models behind it. */
function rig(
  chain: readonly (readonly [string, readonly FakeStep[]])[],
  options: {
    harness?: HarnessKind;
    settings?: Partial<AgentSettings>;
    limits?: Limits;
    now?: () => number;
  } = {},
): Rig {
  const sr = scriptedRouter(chain, options.now === undefined ? {} : { now: options.now });
  const base = {
    router: sr.router,
    escalation: false,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const runner: AgentRunner =
    options.harness === 'single-shot' ? new SingleShotRunner(base) : new LoopRunner(base);
  const built: BuiltRouter = { router: sr.router, dropped: [], warnings: [] };
  return {
    sr,
    calls: sr.calls,
    service: new AgentService(db, settings(options.settings), runner, null, built),
  };
}

const one = (steps: readonly FakeStep[]) => [['gemini:small', steps]] as const;

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

const feeCall = (n: number) =>
  asksFor([toolCall(`t${n}`, 'get_fee_contract', { method: 'card', amount_paise: 1000 })]);

describe.each<HarnessKind>(['loop', 'single-shot'])(
  'every way an investigation ends without a conclusion is stored, labelled and audited (%s)',
  (harness) => {
    // Each scenario is a real path through the harness, not a hand-built draft.
    const scenarios: Record<DegradedReason, (() => Rig) | null> = {
      model_unavailable: () => rig(one([failure('SERVER')]), { harness }),
      quota_exhausted: () => rig(one([failure('QUOTA_EXHAUSTED')]), { harness }),
      model_rejected: () => rig(one([failure('BAD_REQUEST')]), { harness }),
      invalid_reply: () => rig(one([says('{"results": ['), says('still not json')]), { harness }),
      // The single-shot harness makes no tool calls, so it has no tool budget to run out.
      tool_budget:
        harness === 'single-shot'
          ? null
          : () =>
              rig(one([feeCall(1), feeCall(2)]), {
                harness,
                limits: { ...DEFAULT_LIMITS, maxToolCalls: 1 },
              }),
      token_budget: () =>
        rig(one([says('{"results":[{"exceptionId":"', { finishReason: 'length' })]), { harness }),
      time_budget: () => {
        let t = 0;
        return rig(
          one([
            () => {
              t += 10_000;
              return harness === 'loop' ? feeCall(1) : says('{"results": [');
            },
          ]),
          { harness, limits: { ...DEFAULT_LIMITS, timeoutMs: 1_000 }, now: () => t },
        );
      },
      context: () => rig(one([says('', { finishReason: 'context' })]), { harness }),
      refused: () => rig(one([says('', { finishReason: 'refusal' })]), { harness }),
    };

    it('has a scenario for every reason the database allows', () => {
      expect(Object.keys(scenarios).sort()).toEqual([...DEGRADED_REASONS].sort());
    });

    it.each(DEGRADED_REASONS.filter((r) => scenarios[r] !== null))('%s', async (reason) => {
      const run = await openExceptionInOwnRun(db);
      const { service } = (scenarios[reason] as () => Rig)();
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
      // No model concluded when the chain could not answer; in every other case a model did the work
      // that ended in a hand-over, and the proposal says which.
      const chainFailed = reason === 'model_unavailable' || reason === 'quota_exhausted';
      expect(proposal?.model).toBe(chainFailed ? null : 'small');
      expect(proposal?.provider).toBe(chainFailed ? null : 'gemini');
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

    it('words a quota problem as "AI quota exhausted" for the person who opens it', async () => {
      const run = await openExceptionInOwnRun(db);
      await rig(one([failure('QUOTA_EXHAUSTED')]), { harness }).service.process(
        job(run.runId, run.exception),
      );
      const [proposal] = await proposalsOf(run.exception);
      expect(proposal?.explanation).toContain('AI quota exhausted');
    });

    it('records the failed attempt as spend on record, with its outcome', async () => {
      const run = await openExceptionInOwnRun(db);
      await rig(one([failure('SERVER')]), { harness }).service.process(
        job(run.runId, run.exception),
      );
      const rows = await db.select().from(llmCalls).where(eq(llmCalls.runId, run.runId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider: 'gemini',
        outcome: 'fell_back',
        errorKind: 'SERVER',
        cached: false,
        tokensIn: 0,
        costUsd: '0.000000',
      });
    });

    it('leaves an investigation that concluded un-degraded, and records who answered', async () => {
      const run = await openExceptionInOwnRun(db);
      const { service } = rig(
        one([replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })])]),
        { harness },
      );
      await service.process(job(run.runId, run.exception));
      const [proposal] = await proposalsOf(run.exception);
      expect(proposal?.degraded).toBeNull();
      expect(proposal?.provider).toBe('gemini');
      expect(proposal?.model).toBe('small');
      expect(((await proposeAudits(run.runId))[0]?.detail as { reason: string }).reason).toMatch(
        /^proposed /,
      );
    });
  },
);

describe('a safety block is handed to a person, and no other model is asked', () => {
  it('is a refusal, with the second model never called', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, sr } = rig([
      ['gemini:small', [failure('SAFETY_BLOCKED')]],
      ['anthropic:big', [replyWith([result(run.exception)])]],
    ]);
    await service.process(job(run.runId, run.exception));
    expect((await proposalsOf(run.exception))[0]?.degraded).toBe('refused');
    expect(sr.providers['anthropic:big']?.requests).toHaveLength(0);
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

describe('a model that is down, out of quota or rate limited falls back, and the proposal says so', () => {
  const reply = (exceptionId: string) =>
    replyWith([result(exceptionId, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]);

  it('answers from the next model when the first is out of quota, and names both', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, sr } = rig([
      ['gemini:small', [failure('QUOTA_EXHAUSTED')]],
      ['anthropic:big', [reply(run.exception)]],
    ]);
    await service.process(job(run.runId, run.exception));

    const [proposal] = await proposalsOf(run.exception);
    expect(proposal?.degraded).toBeNull();
    expect([proposal?.provider, proposal?.model]).toEqual(['anthropic', 'big']);
    expect(proposal?.harnessFindings.join(' ')).toContain('gemini:small: QUOTA_EXHAUSTED');
    expect(proposal?.harnessFindings.join(' ')).toContain('answered by anthropic:big');
    expect(sr.providers['anthropic:big']?.requests).toHaveLength(1);

    const calls = await db.select().from(llmCalls).where(eq(llmCalls.runId, run.runId));
    expect(calls.map((c) => [c.provider, c.outcome]).sort()).toEqual([
      ['anthropic', 'ok'],
      ['gemini', 'fell_back'],
    ]);
  });

  it('restarts a half-finished investigation on the next model, with none of the first model’s history', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, sr } = rig(
      [
        ['gemini:small', [feeCall(1), failure('SERVER')]],
        ['anthropic:big', [reply(run.exception)]],
      ],
      { harness: 'loop' },
    );
    await service.process(job(run.runId, run.exception));
    const requests = sr.providers['anthropic:big']?.requests ?? [];
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toHaveLength(1); // only the opening message
    expect((await proposalsOf(run.exception))[0]?.provider).toBe('anthropic');
  });

  it('gives up after every model has failed, hands over, and carries on with the next exception', async () => {
    const run = await openExceptionInOwnRun(db);
    const second = await addException(run.runId, 'ORD-NEXT');
    const { service, sr } = rig([
      ['gemini:small', [failure('SERVER'), failure('SERVER')]],
      ['anthropic:big', [failure('TIMEOUT'), failure('TIMEOUT')]],
    ]);
    await service.process(job(run.runId, run.exception));
    await service.process(job(run.runId, second));

    expect((await proposalsOf(run.exception))[0]?.degraded).toBe('model_unavailable');
    expect((await proposalsOf(second))[0]?.degraded).toBe('model_unavailable');
    expect(await statusOf(second)).toBe('proposed');
    expect(sr.calls()).toBeGreaterThan(0);
  });

  it('answers an exhausted chain at once: after BILLING no request is made for the next exception', async () => {
    const run = await openExceptionInOwnRun(db);
    const second = await addException(run.runId, 'ORD-QUICK');
    const { service, sr } = rig([
      ['gemini:small', [failure('BILLING')]],
      ['anthropic:big', [failure('QUOTA_EXHAUSTED')]],
    ]);
    await service.process(job(run.runId, run.exception));
    const sent = sr.first.requests.length + (sr.providers['anthropic:big']?.requests.length ?? 0);
    await service.process(job(run.runId, second));

    expect(sr.first.requests.length + (sr.providers['anthropic:big']?.requests.length ?? 0)).toBe(
      sent,
    );
    const [proposal] = await proposalsOf(second);
    expect(proposal?.degraded).toBe('quota_exhausted');
    expect(proposal?.explanation).toContain('AI quota exhausted');
  });

  it('does not stop the agent for one bad request, and does not try another model for it', async () => {
    const run = await openExceptionInOwnRun(db);
    const second = await addException(run.runId, 'ORD-AFTER');
    const { service, sr } = rig([
      ['gemini:small', [failure('BAD_REQUEST'), reply(second)]],
      ['anthropic:big', []],
    ]);
    await service.process(job(run.runId, run.exception));
    expect((await proposalsOf(run.exception))[0]?.degraded).toBe('model_rejected');
    await service.process(job(run.runId, second));
    expect((await proposalsOf(second))[0]?.degraded).toBeNull();
    expect(sr.providers['anthropic:big']?.requests).toHaveLength(0);
  });
});

describe('the daily budget, the kill switch, and what the status page shows', () => {
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
    const s = new AgentService(db, settings({ AGENT_KILL_SWITCH: true }), null);
    expect((await s.status()).paused?.reason).toBe('kill_switch');
  });

  it('reports nothing when all is well, and says whether a harness is configured', async () => {
    const s = new AgentService(db, settings({ DAILY_LLM_BUDGET_USD: 1_000_000 }), null);
    const status = await s.status();
    expect(status.paused).toBeNull();
    expect(status.configured).toBe(false);
    expect(status.exhausted).toBe(false);
    expect(status.models).toEqual([]);
  });

  it('shows each model’s state, and "exhausted" only when none can answer', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, sr } = rig([
      ['gemini:small', [failure('QUOTA_EXHAUSTED')]],
      ['anthropic:big', [failure('BILLING')]],
    ]);
    expect((await service.status()).exhausted).toBe(false);
    await service.process(job(run.runId, run.exception));

    const status = await service.status();
    expect(status.exhausted).toBe(true);
    expect(status.models.map((m) => [m.id, m.state])).toEqual([
      ['gemini:small', 'quota_exhausted'],
      ['anthropic:big', 'disabled'],
    ]);
    // the free-tier model's quota comes back at Pacific midnight
    expect(status.models[0]?.until).toMatch(/T0[78]:00:00\.000Z$/);
    // and the rules never depended on any of this
    expect(status.paused).toBeNull();
    sr.breakers.reset();
    expect((await service.status()).exhausted).toBe(false);
  });

  it('turns an investigation away at the gate while the budget is spent, leaving the exception open', async () => {
    const run = await openExceptionInOwnRun(db);
    await insertLlmCall(db, run.runId, {
      costUsd: '50.000000',
      createdAt: new Date('2033-02-03T10:00:00Z'),
    });
    const { service, calls } = rig(one([replyWith([result(run.exception)])]), {
      settings: { DAILY_LLM_BUDGET_USD: 5 },
    });
    service.clock = () => new Date('2033-02-03T12:00:00Z');
    await expect(service.process(job(run.runId, run.exception))).rejects.toMatchObject({
      reason: 'daily_budget',
    });
    expect(calls()).toBe(0);
    expect(await statusOf(run.exception)).toBe('open');
  });

  it('still plans: the list of what to investigate is the same while no model can answer', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service } = rig(one([failure('BILLING')]));
    await service.process(job(run.runId, run.exception));
    const plan = await service.plan(run.runId);
    expect(plan.jobs).toHaveLength(0); // the one exception already has its (handed-over) proposal
    const fresh = await openExceptionInOwnRun(db);
    expect((await service.plan(fresh.runId)).exceptions).toBe(1);
  });
});

describe('a job delivered more than once', () => {
  it('after a degraded outcome is not investigated again, even if the model has recovered', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service, calls } = rig(
      one([
        failure('SERVER'),
        replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]),
      ]),
    );
    const j = job(run.runId, run.exception);
    expect((await service.process(j)).stored).toBe(1);
    expect(await service.process(j)).toEqual({ stored: 0, alreadyDone: 1, notOpen: 0 });
    expect(calls()).toBe(1);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect(await proposeAudits(run.runId)).toHaveLength(1);
  });

  it('after a crash before anything was stored is investigated once more, and stored once', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service } = rig(
      one([
        new Error('worker killed'), // not an LlmError: the job fails, as it should
        replyWith([result(run.exception, { verdict: 'EXPLAINED_NO_MATCH', links: [] })]),
      ]),
    );
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
    const { service } = rig(
      one([
        async () => {
          await new Promise((r) => setTimeout(r, 15));
          return reply();
        },
        async () => {
          await new Promise((r) => setTimeout(r, 15));
          return reply();
        },
      ] as unknown as FakeStep[]),
    );
    const j = job(run.runId, run.exception);
    const [a, b] = await Promise.all([service.process(j), service.process(j)]);
    expect(a.stored + b.stored).toBe(1);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect(await proposeAudits(run.runId)).toHaveLength(1);
  });

  it('twice at the same moment, both degraded, still writes one of each', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service } = rig(one(Array.from({ length: 6 }, () => failure('SERVER'))));
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
    const { service, calls } = rig(one([reply(), reply()]));
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
    expect(calls()).toBe(1);
    expect(await proposalsOf(run.exception)).toHaveLength(1);
    expect(await proposeAudits(run.runId)).toHaveLength(1);
  });

  it('every model being out degrades the exception and the job is done: no retry storm', async () => {
    const run = await openExceptionInOwnRun(db);
    const { service } = rig(one([failure('QUOTA_EXHAUSTED')]));
    const { state, ready } = work(service);
    await ready;
    await queue.enqueue([job(run.runId, run.exception)]);
    await until(() => state.deliveries === 1);
    await settle();

    expect(state.deliveries).toBe(1);
    expect((await proposalsOf(run.exception))[0]?.degraded).toBe('quota_exhausted');
    expect(await nothingLeft()).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });
  });

  it('a spent daily budget halts: one delivery, no retry, the exception stays open, and asking again later is allowed', async () => {
    const run = await openExceptionInOwnRun(db);
    await insertLlmCall(db, run.runId, {
      costUsd: '50.000000',
      createdAt: new Date('2034-03-04T10:00:00Z'),
    });
    const { service, calls } = rig(one([replyWith([result(run.exception)])]), {
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
    expect(calls()).toBe(0);
    expect(await statusOf(run.exception)).toBe('open');
    // The job is gone, so the same one can be enqueued again once there is budget.
    await queue.enqueue([job(run.runId, run.exception)]);
    await until(() => deliveries === 2);
  });
});
