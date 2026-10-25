// What an investigation ended in, and how that becomes the drafts the service stores. Shared by both
// harnesses: whichever one ran, a conclusion, a budget that ran out, a refusal, a reply that stayed invalid
// and a chain that could not answer all end up as the same kinds of draft.
import type { Exhausted } from './budget.js';
import type { DegradedReason } from './degraded.js';
import {
  type CallRecord,
  finalizeResult,
  type Finalized,
  type ModelOutput,
  needsHuman,
  type Subject,
} from './output.js';
import type { Brief } from './prompt.js';
import type { ExceptionToInvestigate, InvestigationContext, ProposalDraft } from './types.js';

export type LoopEnd =
  | { readonly kind: 'answered'; readonly output: ModelOutput }
  | { readonly kind: 'exhausted'; readonly by: Exhausted }
  | { readonly kind: 'refused' }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] }
  /** No model in the chain could answer, because the service was down or unreachable. */
  | { readonly kind: 'unavailable'; readonly reason: string }
  /** No model in the chain could answer, because each was out of quota or money. */
  | { readonly kind: 'quota_exhausted'; readonly reason: string }
  /** The provider refused the request itself (a 400-class error). */
  | { readonly kind: 'rejected'; readonly reason: string };

export interface LoopOutcome {
  readonly end: LoopEnd;
  /** Call 0 (the briefs) and every call after it, in order. */
  readonly calls: readonly CallRecord[];
  /** The last request made; the one the conclusion (or the failure to conclude) came from. */
  readonly lastLlmCallId: string | null;
}

const WHY_EXHAUSTED: Record<Exhausted, string> = {
  tool_calls: 'the tool-call budget ran out',
  tokens: 'the output-token budget ran out',
  time: 'the time budget ran out',
  context: 'the conversation grew too long',
};

function finalizeFor(outcome: LoopOutcome, subject: Subject): Finalized {
  const end = outcome.end;
  switch (end.kind) {
    case 'answered': {
      const result = end.output.results.find((r) => r.exceptionId === subject.exceptionId);
      return result === undefined
        ? needsHuman(subject, 'the model gave no result for this exception', outcome.calls)
        : finalizeResult(result, subject, outcome.calls);
    }
    case 'exhausted':
      return needsHuman(subject, WHY_EXHAUSTED[end.by], outcome.calls);
    case 'refused':
      return needsHuman(subject, 'the model declined to answer', outcome.calls);
    case 'invalid':
      return needsHuman(
        subject,
        'the reply was not valid even after one repair attempt',
        outcome.calls,
      );
    case 'unavailable':
    case 'quota_exhausted':
    case 'rejected':
      return needsHuman(subject, end.reason, outcome.calls);
  }
}

const DEGRADED_BY_EXHAUSTION: Record<Exhausted, DegradedReason> = {
  tool_calls: 'tool_budget',
  tokens: 'token_budget',
  time: 'time_budget',
  context: 'context',
};

/** Why a person has to look, when the harness did not get a conclusion; null when the model concluded. */
function degradedFor(outcome: LoopOutcome, exceptionId: string): DegradedReason | null {
  const end = outcome.end;
  switch (end.kind) {
    case 'answered':
      return end.output.results.some((r) => r.exceptionId === exceptionId) ? null : 'invalid_reply';
    case 'exhausted':
      return DEGRADED_BY_EXHAUSTION[end.by];
    case 'refused':
      return 'refused';
    case 'invalid':
      return 'invalid_reply';
    case 'unavailable':
      return 'model_unavailable';
    case 'quota_exhausted':
      return 'quota_exhausted';
    case 'rejected':
      return 'model_rejected';
  }
}

/** The model that gave the answer; null when none did. */
export interface Answerer {
  readonly provider: string;
  readonly model: string;
}

export function draftsFrom(
  outcome: LoopOutcome,
  answerer: Answerer | null,
  members: readonly ExceptionToInvestigate[],
): ProposalDraft[] {
  return members.map((member) => {
    const done = finalizeFor(outcome, {
      exceptionId: member.id,
      ruleReasonCode: member.ruleReasonCode,
    });
    return {
      content: done.content,
      model: answerer?.model ?? null,
      provider: answerer?.provider ?? null,
      harnessFindings: done.findings,
      llmCallId: outcome.lastLlmCallId,
      degraded: degradedFor(outcome, member.id),
    };
  });
}

/** Call 0, shared by every harness: each exception's brief, fetched before the model is asked anything. */
export async function fetchBriefs(
  members: readonly ExceptionToInvestigate[],
  ctx: Pick<InvestigationContext, 'toolbox'>,
): Promise<{ briefCalls: CallRecord[]; briefs: Brief[] }> {
  const briefCalls: CallRecord[] = [];
  const briefs: Brief[] = [];
  for (const member of members) {
    const args = { exception_id: member.id };
    const result = await ctx.toolbox.run('get_exception', args);
    if (!result.ok) throw new Error(`cannot load exception ${member.id}: ${result.error}`);
    briefCalls.push({
      n: 0,
      tool: 'get_exception',
      args,
      ok: true,
      summary: result.summary,
      seen: result.seen,
    });
    briefs.push({ exceptionId: member.id, json: result.content });
  }
  return { briefCalls, briefs };
}
