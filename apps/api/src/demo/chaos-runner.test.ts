import { Logger } from '@nestjs/common';
import { agentProposalContentSchema } from '@ziro/core/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, createMigratedDb, type TestDb, type World } from '../agent/agent.fixtures.js';
import { AgentHealth } from '../agent/health.js';
import { ResilientRunner } from '../agent/resilient-runner.js';
import { testContext } from '../agent/scripted-llm.fixtures.js';
import { Toolbox } from '../agent/tools/toolbox.js';
import type {
  AgentRunner,
  ExceptionToInvestigate,
  InvestigationContext,
  ProposalDraft,
} from '../agent/types.js';
import {
  CHAOS_MALFORMED_NOTE,
  CHAOS_RESILIENCE,
  CHAOS_TIMEOUT_MESSAGE,
  type ChaosPlan,
  ChaosRunner,
  planChaos,
} from './chaos-runner.js';

let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let world: World;
let box: Toolbox;

beforeAll(async () => {
  Logger.overrideLogger(false);
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

/** A harness that concludes, and counts how often it was asked. */
class Honest implements AgentRunner {
  readonly harness = 'loop' as const;
  asked = 0;
  investigate(members: readonly ExceptionToInvestigate[], _ctx: InvestigationContext) {
    this.asked += 1;
    return Promise.resolve(
      members.map((m): ProposalDraft => ({
        content: agentProposalContentSchema.parse({
          exceptionId: m.id,
          verdict: 'EXPLAINED_NO_MATCH',
          reasonCode: m.ruleReasonCode,
          links: [],
          explanation: 'Fine.',
          evidence: [{ tool: 'get_exception', args: { exception_id: m.id }, keyFinding: 'fine' }],
          confidence: 0.9,
          suggestedAction: 'NONE',
          draftJournalEntry: null,
        }),
        model: 'scripted',
        harnessFindings: [],
        llmCallId: null,
        degraded: null,
      })),
    );
  }
}

const waits: number[] = [];
const rigged = (plan: ChaosPlan) => {
  const inner = new Honest();
  const runner = new ResilientRunner(new ChaosRunner(inner, plan), {
    health: new AgentHealth(),
    policy: CHAOS_RESILIENCE,
    deps: {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
      now: () => 0,
    },
  });
  return { inner, runner, ctx: testContext(box, world.runId) };
};

describe('planChaos', () => {
  it('breaks the first two exceptions in id order, whatever order they come in', () => {
    expect(planChaos(['c', 'a', 'b'])).toEqual({ timeoutFor: 'a', malformedFor: 'b' });
    expect(planChaos(['b', 'c', 'a'])).toEqual({ timeoutFor: 'a', malformedFor: 'b' });
  });

  it('copes with a run that has fewer than two', () => {
    expect(planChaos(['x'])).toEqual({ timeoutFor: 'x', malformedFor: null });
    expect(planChaos([])).toEqual({ timeoutFor: null, malformedFor: null });
  });
});

describe('the exception whose model request times out', () => {
  it('is retried by the real wrapper and then handed to a person, saying it was injected', async () => {
    waits.length = 0;
    const { runner, ctx, inner } = rigged({ timeoutFor: dup().id, malformedFor: null });
    const [draft] = await runner.investigate([dup()], ctx);

    expect(draft?.degraded).toBe('model_unavailable');
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.explanation).toContain('did not answer after 3 tries');
    expect(draft?.content.explanation).toContain(CHAOS_TIMEOUT_MESSAGE);
    expect(waits).toHaveLength(2); // it really waited between the tries
    expect(Math.max(...waits)).toBeLessThanOrEqual(CHAOS_RESILIENCE.maxDelayMs);
    expect(inner.asked).toBe(0); // the scripted agent never saw it
  });
});

describe('the exception whose reply is cut off', () => {
  it('goes through the real parser to an invalid_reply, with no retry and no model', async () => {
    waits.length = 0;
    const { runner, ctx, inner } = rigged({ timeoutFor: null, malformedFor: other().id });
    const [draft] = await runner.investigate([other()], ctx);

    expect(draft?.degraded).toBe('invalid_reply');
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.explanation).toContain('not valid even after one repair attempt');
    expect(draft?.harnessFindings[0]).toBe(CHAOS_MALFORMED_NOTE);
    expect(draft?.model).toBeNull();
    expect(draft?.llmCallId).toBeNull();
    expect(waits).toEqual([]);
    expect(inner.asked).toBe(0);
  });
});

describe('everything else', () => {
  it('is passed to the wrapped agent untouched', async () => {
    const { runner, ctx, inner } = rigged({ timeoutFor: 'nobody', malformedFor: 'nobody-else' });
    const drafts = await runner.investigate([dup(), other()], ctx);
    expect(inner.asked).toBe(1);
    expect(drafts.map((d) => d.degraded)).toEqual([null, null]);
  });

  it('is passed through when there are no victims at all', async () => {
    const { runner, ctx, inner } = rigged({ timeoutFor: null, malformedFor: null });
    await runner.investigate([dup()], ctx);
    expect(inner.asked).toBe(1);
  });

  it('reports the wrapped harness', () => {
    expect(new ChaosRunner(new Honest(), { timeoutFor: null, malformedFor: null }).harness).toBe(
      'loop',
    );
  });
});
