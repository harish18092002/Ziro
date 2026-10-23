import { Logger } from '@nestjs/common';
import { agentProposalContentSchema } from '@ziro/core/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RetryDeps, RetryPolicy } from '../common/retry.js';
import { buildWorld, createMigratedDb, type TestDb, type World } from './agent.fixtures.js';
import { AgentHealth } from './health.js';
import { classifyLlmFailure, LlmError } from './llm.js';
import { ResilientRunner } from './resilient-runner.js';
import { testContext } from './scripted-llm.fixtures.js';
import { Toolbox } from './tools/toolbox.js';
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
let box: Toolbox;

beforeAll(async () => {
  Logger.overrideLogger(false); // the runner warns on every retry; the tests assert on behaviour instead
  ({ db, client } = await createMigratedDb());
  world = await buildWorld(db);
  box = await Toolbox.create(db, world.runId);
}, 60_000);
afterAll(async () => {
  await client.close();
});

const dup = (): ExceptionToInvestigate => ({
  id: world.exceptions.duplicate,
  ruleReasonCode: 'DUPLICATE_PAYMENT',
});
const other = (): ExceptionToInvestigate => ({
  id: world.exceptions.other,
  ruleReasonCode: 'LEDGER_WITHOUT_PAYMENT',
});

/** The error the Anthropic client would raise for a response with this status, classified the same way. */
function apiError(status: number | null, retryAfterMs: number | null = null, requestId = 'req_1') {
  const kind = classifyLlmFailure(status, retryAfterMs);
  return new LlmError(
    `Anthropic API error${status === null ? '' : ` ${status}`}: failed`,
    kind === 'transient',
    status,
    requestId,
    retryAfterMs,
    kind,
  );
}

const answer = (member: ExceptionToInvestigate): ProposalDraft => ({
  content: agentProposalContentSchema.parse({
    exceptionId: member.id,
    verdict: 'EXPLAINED_NO_MATCH',
    reasonCode: member.ruleReasonCode,
    links: [],
    explanation: 'One order paid twice.',
    evidence: [
      { tool: 'get_exception', args: { exception_id: member.id }, keyFinding: 'two candidates' },
    ],
    confidence: 0.9,
    suggestedAction: 'REFUND_CUSTOMER',
    draftJournalEntry: null,
  }),
  model: 'claude-haiku-5-5',
  harnessFindings: ['kept'],
  llmCallId: 'call-1',
  degraded: null,
});

type Step = Error | 'answers';

/** A harness that does what it is told, one step per try, and counts the tries. */
class Scripted implements AgentRunner {
  readonly harness = 'loop' as const;
  tries = 0;
  closed = false;
  constructor(private readonly steps: readonly Step[]) {}
  investigate(members: readonly ExceptionToInvestigate[], _ctx: InvestigationContext) {
    const step = this.steps[Math.min(this.tries, this.steps.length - 1)];
    this.tries += 1;
    if (step === undefined || step === 'answers') return Promise.resolve(members.map(answer));
    return Promise.reject(step);
  }
  close() {
    this.closed = true;
  }
}

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
  deadlineMs: 30_000,
};

/** Waiting that takes no time, and is written down. */
function fakeTime(random = 0.5) {
  let t = 0;
  const waits: number[] = [];
  const deps: RetryDeps = {
    sleep: (ms) => {
      waits.push(ms);
      t += ms;
      return Promise.resolve();
    },
    random: () => random,
    now: () => t,
  };
  return { deps, waits };
}

function setup(steps: readonly Step[], options: { threshold?: number; random?: number } = {}) {
  const inner = new Scripted(steps);
  const health = new AgentHealth({ threshold: options.threshold ?? 5 });
  const time = fakeTime(options.random);
  const runner = new ResilientRunner(inner, { health, policy: POLICY, deps: time.deps });
  const ctx = testContext(box, world.runId);
  return { inner, health, runner, ctx, waits: time.waits };
}

describe('a model that answers', () => {
  it('is passed through untouched, with nothing waited for', async () => {
    const { runner, ctx, inner, waits } = setup(['answers']);
    const drafts = await runner.investigate([dup()], ctx);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.harnessFindings).toEqual(['kept']);
    expect(drafts[0]?.degraded).toBeNull();
    expect(inner.tries).toBe(1);
    expect(waits).toEqual([]);
  });

  it('reports the wrapped harness and releases it when closed', () => {
    const { runner, inner } = setup(['answers']);
    expect(runner.harness).toBe('loop');
    runner.close();
    expect(inner.closed).toBe(true);
  });
});

describe('a model API that fails and then recovers', () => {
  it.each([
    ['a timeout (no response)', null],
    ['overloaded (529)', 529],
    ['a server error (500)', 500],
    ['a gateway timeout (504)', 504],
  ])('tries again after %s and says so on the proposal', async (_name, status) => {
    const { runner, ctx, inner, waits } = setup([apiError(status), 'answers']);
    const drafts = await runner.investigate([dup()], ctx);
    expect(inner.tries).toBe(2);
    expect(waits).toHaveLength(1);
    expect(drafts[0]?.degraded).toBeNull();
    expect(drafts[0]?.harnessFindings).toEqual([
      'the model API failed 1 time first and then answered',
      'kept',
    ]);
  });

  it('counts two failures as two', async () => {
    const { runner, ctx, inner } = setup([apiError(529), apiError(529), 'answers']);
    const drafts = await runner.investigate([dup()], ctx);
    expect(inner.tries).toBe(3);
    expect(drafts[0]?.harnessFindings[0]).toBe(
      'the model API failed 2 times first and then answered',
    );
  });

  it('waits what a 429 with retry-after asks for, not its own guess', async () => {
    const { runner, ctx, waits } = setup([apiError(429, 7_000), 'answers']);
    await runner.investigate([dup()], ctx);
    expect(waits).toEqual([7_000]);
  });

  it('never waits longer than the policy ceiling when it chooses the wait itself', async () => {
    const { runner, ctx, waits } = setup([apiError(529), apiError(529), 'answers'], {
      random: 0.999,
    });
    await runner.investigate([dup()], ctx);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeLessThanOrEqual(1_000);
    expect(waits[1]).toBeLessThanOrEqual(2_000);
  });

  it('forgets earlier failures once the model answers', async () => {
    const { runner, ctx, health } = setup([apiError(529), 'answers'], { threshold: 2 });
    for (let i = 0; i < 3; i += 1) await runner.investigate([dup()], ctx);
    expect(health.state()).toBeNull();
  });
});

describe('a model API that never answers', () => {
  it('hands the exception to a person with the reason, after the tries are spent', async () => {
    const { runner, ctx, inner, waits } = setup([apiError(529, null, 'req_529')]);
    const [draft] = await runner.investigate([dup()], ctx);

    expect(inner.tries).toBe(3);
    expect(waits).toHaveLength(2);
    expect(draft?.degraded).toBe('model_unavailable');
    expect(draft?.model).toBeNull();
    expect(draft?.llmCallId).toBeNull();
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.reasonCode).toBe('DUPLICATE_PAYMENT');
    expect(draft?.content.links).toEqual([]);
    expect(draft?.content.confidence).toBe(0);
    expect(draft?.content.suggestedAction).toBe('NONE');
    expect(draft?.content.explanation).toContain('the model API did not answer after 3 tries');
    expect(draft?.content.explanation).toContain('req_529');
    expect(draft?.harnessFindings[0]).toContain('investigation stopped');
  });

  it('says plainly that nothing was investigated, instead of promising evidence it has none of', async () => {
    const { runner, ctx } = setup([apiError(null)]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(draft?.content.evidence).toEqual([]);
    expect(draft?.content.explanation).toContain('No tool had been run yet');
    expect(draft?.content.explanation).not.toContain('evidence gathered so far is attached');
  });

  it('degrades every member of a cluster, in order', async () => {
    const { runner, ctx } = setup([apiError(503)]);
    const drafts = await runner.investigate([dup(), other()], ctx);
    expect(drafts.map((d) => d.content.exceptionId)).toEqual([
      world.exceptions.duplicate,
      world.exceptions.other,
    ]);
    expect(drafts.map((d) => d.degraded)).toEqual(['model_unavailable', 'model_unavailable']);
    expect(drafts.map((d) => d.content.reasonCode)).toEqual([
      'DUPLICATE_PAYMENT',
      'LEDGER_WITHOUT_PAYMENT',
    ]);
  });

  it('gives up at once when the server asks for a wait longer than the deadline', async () => {
    const { runner, ctx, inner, waits } = setup([apiError(429, 120_000)]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(inner.tries).toBe(1);
    expect(waits).toEqual([]);
    expect(draft?.degraded).toBe('model_unavailable');
  });
});

describe('a request the API refuses', () => {
  it.each([400, 404, 413])('is not retried (%i): a person is told why', async (status) => {
    const { runner, ctx, inner, waits, health } = setup([apiError(status, null, 'req_bad')]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(inner.tries).toBe(1);
    expect(waits).toEqual([]);
    expect(draft?.degraded).toBe('model_rejected');
    expect(draft?.content.explanation).toContain('the model API refused the request');
    expect(draft?.content.explanation).toContain('req_bad');
    expect(health.state()).toBeNull();
  });

  it('does not count towards the breaker: the API answered', async () => {
    const { runner, ctx, health } = setup([apiError(400)], { threshold: 2 });
    for (let i = 0; i < 4; i += 1) await runner.investigate([dup()], ctx);
    expect(health.state()).toBeNull();
  });
});

describe('a failure that every exception will share', () => {
  it.each([
    ['401', 401, 'model_auth'],
    ['403', 403, 'model_auth'],
    ['402', 402, 'provider_limit'],
    ['a 429 with no retry-after (a spend cap)', 429, 'provider_limit'],
  ] as const)(
    '%s halts the agent instead of degrading each exception',
    async (_name, status, reason) => {
      const { runner, ctx, inner, waits, health } = setup([apiError(status)]);
      await expect(runner.investigate([dup()], ctx)).rejects.toMatchObject({ reason });
      expect(inner.tries).toBe(1);
      expect(waits).toEqual([]);
      expect(health.state()?.reason).toBe(reason);
    },
  );

  it('then refuses the next investigation without asking the model at all', async () => {
    const { runner, ctx, inner } = setup([apiError(401)]);
    await expect(runner.investigate([dup()], ctx)).rejects.toBeInstanceOf(AgentHalted);
    await expect(runner.investigate([other()], ctx)).rejects.toMatchObject({
      reason: 'model_auth',
    });
    expect(inner.tries).toBe(1);
  });
});

describe('the circuit breaker', () => {
  it('pauses the agent after the threshold of unavailable outcomes in a row', async () => {
    const { runner, ctx, inner, health } = setup([apiError(529)], { threshold: 2 });
    const first = await runner.investigate([dup()], ctx);
    expect(first[0]?.degraded).toBe('model_unavailable');
    expect(health.state()).toBeNull();
    const second = await runner.investigate([dup()], ctx);
    expect(second[0]?.degraded).toBe('model_unavailable');
    expect(health.state()?.reason).toBe('model_unavailable');

    const triesBefore = inner.tries;
    await expect(runner.investigate([other()], ctx)).rejects.toMatchObject({
      reason: 'model_unavailable',
    });
    expect(inner.tries).toBe(triesBefore);
  });

  it('is shared by everything that holds the same health', async () => {
    const health = new AgentHealth({ threshold: 1 });
    const time = fakeTime();
    const failing = new ResilientRunner(new Scripted([apiError(529)]), {
      health,
      policy: POLICY,
      deps: time.deps,
    });
    const healthy = new Scripted(['answers']);
    const other2 = new ResilientRunner(healthy, { health, policy: POLICY, deps: time.deps });
    const ctx = testContext(box, world.runId);
    await failing.investigate([dup()], ctx);
    await expect(other2.investigate([dup()], ctx)).rejects.toBeInstanceOf(AgentHalted);
    expect(healthy.tries).toBe(0);
  });
});

describe('what is not the model API’s fault', () => {
  it('lets a halt from the gate through untouched, and does not pause anything', async () => {
    const { runner, ctx, health, inner } = setup([new AgentHalted('daily_budget')]);
    await expect(runner.investigate([dup()], ctx)).rejects.toMatchObject({
      reason: 'daily_budget',
    });
    expect(inner.tries).toBe(1);
    expect(health.state()).toBeNull();
  });

  it('rethrows a bug as it is, without retrying or hiding it', async () => {
    const { runner, ctx, inner, waits } = setup([new Error('database is down')]);
    await expect(runner.investigate([dup()], ctx)).rejects.toThrow('database is down');
    expect(inner.tries).toBe(1);
    expect(waits).toEqual([]);
  });
});
