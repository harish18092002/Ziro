// What both harnesses do around the model call: ask the router for a model, and turn every way it can go
// wrong into a draft for a person, never a failed job. This is where the availability story (fall back to
// the next model) meets the quality story (escalate to a stronger one).
//
// Fallback is the router's: a model that is out of quota, down or rate-limited is replaced by the next, and
// the investigation restarts there. Escalation is ours and opt-in (AGENT_ESCALATION): a model that
// answered "I am not sure" gets one second look from the NEXT model in the chain. They are different
// things and use different words in the findings.
import { LlmError } from '@ziro/core/llm';
import { type LlmSession, type Routed, ChainExhausted, LlmRouter } from '../llm/router.js';
import { type Answerer, type LoopOutcome, draftsFrom } from './outcome.js';
import { type CallRecord, digestOf, wantsEscalation } from './output.js';
import type { ExceptionToInvestigate, InvestigationContext, ProposalDraft } from './types.js';

export interface RoutedRun {
  readonly router: LlmRouter;
  readonly ctx: InvestigationContext;
  readonly members: readonly ExceptionToInvestigate[];
  /** Call 0, kept when no model could be asked. */
  readonly briefCalls: readonly CallRecord[];
  readonly escalation: boolean;
  /** Runs the whole investigation on one session. `digest` is what an earlier pass found, if any. */
  readonly attempt: (session: LlmSession, digest: string | undefined) => Promise<LoopOutcome>;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function answerer(routed: Routed<unknown>): Answerer {
  return { provider: routed.entry.provider, model: routed.entry.model };
}

/** Why the chain could not answer, in words for the person who opens the exception. */
function unanswered(error: ChainExhausted): LoopOutcome['end'] {
  return error.quota
    ? { kind: 'quota_exhausted', reason: `AI quota exhausted: ${error.message}` }
    : { kind: 'unavailable', reason: `the model API did not answer: ${error.message}` };
}

export async function runRouted(run: RoutedRun): Promise<ProposalDraft[]> {
  const { router, ctx, members } = run;
  const route = (from: number, digest: string | undefined) =>
    router.route((session) => run.attempt(session, digest), {
      from,
      record: (attempt) => ctx.recordLlmCall(attempt),
    });

  let first: Routed<LoopOutcome>;
  try {
    first = await route(0, undefined);
  } catch (error) {
    // A routed model failure that no other model could fix is handled inside the harness (it becomes an
    // outcome); what reaches here is the chain running out, or a bug, which is not hidden.
    if (!(error instanceof ChainExhausted)) throw error;
    return draftsFrom(
      { end: unanswered(error), calls: run.briefCalls, lastLlmCallId: null },
      null,
      members,
    );
  }

  const fellBack =
    first.fellBackFrom.length === 0
      ? []
      : [
          `${plural(first.fellBackFrom.length, 'model')} failed first (${first.fellBackFrom
            .map((f) => `${f.model}: ${f.kind}`)
            .join(', ')}); answered by ${first.entry.id}`,
        ];
  const drafts = draftsFrom(first.value, answerer(first), members).map((d) => ({
    ...d,
    harnessFindings: [...fellBack, ...d.harnessFindings],
  }));

  const worthASecondLook =
    run.escalation &&
    first.value.end.kind === 'answered' &&
    first.index + 1 < router.chain.length &&
    drafts.some((d) => wantsEscalation(d.content));
  if (!worthASecondLook) return drafts;

  let second: Routed<LoopOutcome>;
  try {
    second = await route(first.index + 1, digestOf(first.value.calls));
  } catch (error) {
    if (!(error instanceof ChainExhausted || error instanceof LlmError)) throw error;
    return withFinding(drafts, 'a second look by the next model could not be made');
  }
  if (second.value.end.kind !== 'answered') {
    return withFinding(
      drafts,
      `a second look by ${second.entry.id} did not finish (${second.value.end.kind})`,
    );
  }
  return draftsFrom(second.value, answerer(second), members).map((d) => ({
    ...d,
    harnessFindings: [
      `escalated from ${first.entry.id} after an unsure or unresolved first pass`,
      ...d.harnessFindings,
    ],
  }));
}

function withFinding(drafts: readonly ProposalDraft[], finding: string): ProposalDraft[] {
  return drafts.map((d) =>
    wantsEscalation(d.content) ? { ...d, harnessFindings: [...d.harnessFindings, finding] } : d,
  );
}
