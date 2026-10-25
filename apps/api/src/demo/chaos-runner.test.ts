import { Logger } from '@nestjs/common';
import { agentProposalContentSchema } from '@ziro/core/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, createMigratedDb, type TestDb, type World } from '../agent/agent.fixtures.js';
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
  CHAOS_QUOTA_NOTE,
  CHAOS_TIMEOUT_NOTE,
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
const third = (): ExceptionToInvestigate => ({
  id: world.exceptions.unexplainedCredit,
  ruleReasonCode: 'UNKNOWN',
});

/** A harness that concludes, and counts how often it was asked. */
class Honest implements AgentRunner {
  readonly harness = 'single-shot' as const;
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

const NONE: ChaosPlan = { timeoutFor: null, malformedFor: null, quotaFor: null };
const rigged = (plan: ChaosPlan) => {
  const inner = new Honest();
  const ctx = testContext(box, world.runId);
  return { inner, runner: new ChaosRunner(inner, plan), ctx };
};

describe('planChaos', () => {
  it('breaks the first three exceptions in id order, whatever order they come in', () => {
    const want = { timeoutFor: 'a', malformedFor: 'b', quotaFor: 'c' };
    expect(planChaos(['c', 'a', 'b', 'd'])).toEqual(want);
    expect(planChaos(['b', 'd', 'c', 'a'])).toEqual(want);
  });

  it('copes with a run that has fewer than three', () => {
    expect(planChaos(['x'])).toEqual({ timeoutFor: 'x', malformedFor: null, quotaFor: null });
    expect(planChaos(['y', 'x'])).toEqual({ timeoutFor: 'x', malformedFor: 'y', quotaFor: null });
    expect(planChaos([])).toEqual(NONE);
  });
});

describe('the exception whose models all time out', () => {
  it('goes through the real router, finds no model to answer, and is handed to a person', async () => {
    const { runner, ctx, inner } = rigged({ ...NONE, timeoutFor: dup().id });
    const [draft] = await runner.investigate([dup()], ctx);

    expect(draft?.degraded).toBe('model_unavailable');
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.explanation).toContain('did not answer');
    expect(draft?.content.explanation).toContain('TIMEOUT');
    expect(draft?.harnessFindings[0]).toBe(CHAOS_TIMEOUT_NOTE);
    expect(draft?.model).toBeNull();
    expect(inner.asked).toBe(0); // the scripted agent never saw it
    expect(ctx.recorded).toEqual([]); // nothing was called, so nothing is on record as spend
  });
});

describe('the exception whose models are all out of quota', () => {
  it('is handed to a person as "AI quota exhausted", by the same path a real exhausted chain takes', async () => {
    const { runner, ctx, inner } = rigged({ ...NONE, quotaFor: third().id });
    const [draft] = await runner.investigate([third()], ctx);

    expect(draft?.degraded).toBe('quota_exhausted');
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.explanation).toContain('AI quota exhausted');
    expect(draft?.harnessFindings[0]).toBe(CHAOS_QUOTA_NOTE);
    expect(inner.asked).toBe(0);
    expect(ctx.recorded).toEqual([]);
  });
});

describe('the exception whose reply is cut off', () => {
  it('goes through the real parser to an invalid_reply, with no model', async () => {
    const { runner, ctx, inner } = rigged({ ...NONE, malformedFor: other().id });
    const [draft] = await runner.investigate([other()], ctx);

    expect(draft?.degraded).toBe('invalid_reply');
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.explanation).toContain('not valid even after one repair attempt');
    expect(draft?.harnessFindings[0]).toBe(CHAOS_MALFORMED_NOTE);
    expect(draft?.model).toBeNull();
    expect(draft?.llmCallId).toBeNull();
    expect(inner.asked).toBe(0);
  });
});

describe('everything else', () => {
  it('is passed to the wrapped agent untouched', async () => {
    const { runner, ctx, inner } = rigged({
      timeoutFor: 'nobody',
      malformedFor: 'nobody-else',
      quotaFor: 'no-one',
    });
    const drafts = await runner.investigate([dup(), other()], ctx);
    expect(inner.asked).toBe(1);
    expect(drafts.map((d) => d.degraded)).toEqual([null, null]);
  });

  it('is passed through when there are no victims at all', async () => {
    const { runner, ctx, inner } = rigged(NONE);
    await runner.investigate([dup()], ctx);
    expect(inner.asked).toBe(1);
  });

  it('reports the wrapped harness', () => {
    expect(new ChaosRunner(new Honest(), NONE).harness).toBe('single-shot');
  });
});
