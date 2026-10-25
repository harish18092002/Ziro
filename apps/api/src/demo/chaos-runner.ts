// The demo's fault injection, so a visitor can SEE the system survive a model that misbehaves instead of
// taking our word for it. Three exceptions of the run are the victims, chosen deterministically:
//
//   the first   every model in the chain times out. The real router tries each, runs out of models, and the
//               exception goes to a person as "the model API did not answer".
//   the second  the model's reply is cut off mid-JSON. It goes through the real parser and the real mapping
//               to a NEEDS_HUMAN proposal, exactly as a reply that is still invalid after the one repair
//               attempt does: "the model's reply was not valid".
//   the third   every model is out of quota. Same router, same path as a real exhausted free tier: the
//               exception goes to a person as "AI quota exhausted", and the run carries on.
//
// Nothing here calls a model or spends anything, and every proposal it causes says it was injected. It
// wraps the scripted baseline only: it is never put in front of the live agent, whose state (the budget,
// the breakers) is shared by everyone using the site. The failing models are scripted fakes behind a router
// of their own, so the breakers a visitor trips are the demo's, not production's.
import { LlmError } from '@ziro/core/llm';
import { Breakers } from '../llm/breakers.js';
import { LlmCache } from '../llm/cache.js';
import { FakeProvider } from '../llm/fake.provider.js';
import { MemoryLimiter } from '../llm/limiter.js';
import { LlmRouter } from '../llm/router.js';
import { draftsFrom, fetchBriefs } from '../agent/outcome.js';
import { parseModelOutput } from '../agent/output.js';
import { runRouted } from '../agent/routed.js';
import type {
  AgentRunner,
  ExceptionToInvestigate,
  HarnessName,
  InvestigationContext,
  ProposalDraft,
} from '../agent/types.js';

export interface ChaosPlan {
  /** The exception whose models all time out; null when the run has none. */
  readonly timeoutFor: string | null;
  /** The exception whose reply will be cut off; null when the run has fewer than two. */
  readonly malformedFor: string | null;
  /** The exception whose models are all out of quota; null when the run has fewer than three. */
  readonly quotaFor: string | null;
}

export const CHAOS_NOTE = 'injected by the demo chaos toggle: ';
export const CHAOS_TIMEOUT_NOTE = `${CHAOS_NOTE}every model in the chain timed out`;
export const CHAOS_QUOTA_NOTE = `${CHAOS_NOTE}every model in the chain was out of quota`;
export const CHAOS_MALFORMED_NOTE = `${CHAOS_NOTE}the model reply was cut off mid-JSON`;
/** A real model reply, stopped part-way through its first result. */
export const CUT_OFF_REPLY = '{"results": [{"exceptionId": "';

/** The same victims every time for the same run: the first three exceptions in id order. */
export function planChaos(exceptionIds: readonly string[]): ChaosPlan {
  const sorted = [...exceptionIds].sort();
  return {
    timeoutFor: sorted[0] ?? null,
    malformedFor: sorted[1] ?? null,
    quotaFor: sorted[2] ?? null,
  };
}

/** A two-model chain whose models fail the same way on every request. */
function failingChain(kind: 'TIMEOUT' | 'QUOTA_EXHAUSTED'): LlmRouter {
  const fails = (provider: string, model: string) =>
    new FakeProvider(provider, [
      () =>
        new LlmError(
          kind,
          `simulated: ${kind === 'TIMEOUT' ? 'the request timed out' : 'the daily quota is spent'}`,
          {
            provider,
            model,
          },
        ),
    ]);
  return new LlmRouter({
    slots: [
      {
        entry: { provider: 'gemini', model: 'demo-primary', id: 'gemini:demo-primary' },
        provider: fails('gemini', 'demo-primary'),
      },
      {
        entry: { provider: 'anthropic', model: 'demo-fallback', id: 'anthropic:demo-fallback' },
        provider: fails('anthropic', 'demo-fallback'),
      },
    ],
    breakers: new Breakers(),
    limiter: new MemoryLimiter(),
    cache: LlmCache.off(),
    limits: {},
    prices: {},
    geminiTier: 'free',
    maxWaitMs: 0,
    sleep: () => Promise.resolve(),
  });
}

export class ChaosRunner implements AgentRunner {
  constructor(
    private readonly inner: AgentRunner,
    private readonly plan: ChaosPlan,
  ) {}

  get harness(): HarnessName {
    return this.inner.harness;
  }

  async investigate(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
  ): Promise<ProposalDraft[]> {
    const ids = members.map((m) => m.id);
    const includes = (victim: string | null): boolean => victim !== null && ids.includes(victim);

    if (includes(this.plan.timeoutFor)) {
      return this.noModelAnswers(members, ctx, 'TIMEOUT', CHAOS_TIMEOUT_NOTE);
    }
    if (includes(this.plan.quotaFor)) {
      return this.noModelAnswers(members, ctx, 'QUOTA_EXHAUSTED', CHAOS_QUOTA_NOTE);
    }
    if (includes(this.plan.malformedFor)) {
      const parsed = parseModelOutput(CUT_OFF_REPLY, ids);
      if (parsed.ok) throw new Error('the injected reply unexpectedly parsed');
      const { briefCalls } = await fetchBriefs(members, ctx);
      const drafts = draftsFrom(
        {
          end: { kind: 'invalid', problems: parsed.problems },
          calls: briefCalls,
          lastLlmCallId: null,
        },
        null,
        members,
      );
      return drafts.map((d) => ({
        ...d,
        harnessFindings: [CHAOS_MALFORMED_NOTE, ...d.harnessFindings],
      }));
    }
    return this.inner.investigate(members, ctx);
  }

  /** The real routing and degrading path, over models that fail. Nothing is recorded: nothing was called. */
  private async noModelAnswers(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
    kind: 'TIMEOUT' | 'QUOTA_EXHAUSTED',
    note: string,
  ): Promise<ProposalDraft[]> {
    const { briefCalls } = await fetchBriefs(members, ctx);
    const drafts = await runRouted({
      router: failingChain(kind),
      ctx: { ...ctx, recordLlmCall: () => Promise.resolve(null) },
      members,
      briefCalls,
      escalation: false,
      attempt: async (session) => {
        await session.complete(
          {
            system: 'chaos',
            messages: [{ role: 'user', content: 'chaos' }],
            tools: [],
            maxOutputTokens: 1,
            signal: new AbortController().signal,
          },
          { harness: 'single-shot', exceptionId: null, promptHash: '0'.repeat(64) },
        );
        throw new Error('the injected failure unexpectedly succeeded');
      },
    });
    return drafts.map((d) => ({ ...d, harnessFindings: [note, ...d.harnessFindings] }));
  }
}
