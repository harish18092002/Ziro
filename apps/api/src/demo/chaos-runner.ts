// The demo's fault injection, so a visitor can SEE the system survive a model that misbehaves instead of
// taking our word for it. Two exceptions of the run are the victims, chosen deterministically:
//
//   the first  its model request times out on every try. The resilient wrapper (the same one production
//              uses) retries with backoff, runs out of tries, and hands the exception to a person as
//              "the model API did not answer".
//   the second the model's reply is cut off mid-JSON. It goes through the real parser and the real
//              mapping to a NEEDS_HUMAN proposal, exactly as a reply that is still invalid after the one
//              repair attempt does: "the model's reply was not valid".
//
// Nothing here calls a model or spends anything, and every proposal it causes says it was injected. It
// wraps the scripted baseline only: it is never put in front of the paid live agent, whose state (the
// budget, the circuit breaker) is shared by everyone using the site.
import type { RetryPolicy } from '../common/retry.js';
import { LlmError } from '../agent/llm.js';
import { draftsFrom, fetchBriefs } from '../agent/loop-runner.js';
import { parseModelOutput } from '../agent/output.js';
import type {
  AgentRunner,
  ExceptionToInvestigate,
  HarnessName,
  InvestigationContext,
  ProposalDraft,
} from '../agent/types.js';

export interface ChaosPlan {
  /** The exception whose model request will time out on every try; null when the run has none. */
  readonly timeoutFor: string | null;
  /** The exception whose reply will be cut off; null when the run has fewer than two. */
  readonly malformedFor: string | null;
}

/** Quick enough for a demo: three tries, a fraction of a second between them. */
export const CHAOS_RESILIENCE: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 150,
  maxDelayMs: 600,
  deadlineMs: 5_000,
};

export const CHAOS_TIMEOUT_MESSAGE = 'Simulated model timeout (injected by the demo chaos toggle)';
export const CHAOS_MALFORMED_NOTE =
  'injected by the demo chaos toggle: the model reply was cut off mid-JSON';
/** A real model reply, stopped part-way through its first result. */
export const CUT_OFF_REPLY = '{"results": [{"exceptionId": "';

/** The same victims every time for the same run: the first two exceptions in id order. */
export function planChaos(exceptionIds: readonly string[]): ChaosPlan {
  const sorted = [...exceptionIds].sort();
  return { timeoutFor: sorted[0] ?? null, malformedFor: sorted[1] ?? null };
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
      // No status, as for a request that never got an answer: transient, so the wrapper retries it.
      throw new LlmError(CHAOS_TIMEOUT_MESSAGE, true, null, null);
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
}
