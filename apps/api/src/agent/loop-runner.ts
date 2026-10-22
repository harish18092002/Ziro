// Harness A as an AgentRunner. It fetches the exception briefs (call 0), runs the loop with the small
// model, checks what came back, and, if the answer was NEEDS_HUMAN or unsure, looks once more with the
// large model in a fresh conversation seeded with a digest of the first pass's calls.
//
// Escalation is only for a model that tried and could not decide. A budget that ran out, a refusal or
// an unusable reply are not reasons to spend more: those go to a person as they are.
import { type Limits, DEFAULT_LIMITS, type Exhausted } from './budget.js';
import type { Effort, LlmClient } from './llm.js';
import { runLoop, type LoopOutcome } from './loop.js';
import {
  type CallRecord,
  digestOf,
  type Finalized,
  finalizeResult,
  needsHuman,
  type Subject,
  wantsEscalation,
} from './output.js';
import { type Brief, firstMessage, systemPrompt } from './prompt.js';
import type {
  AgentRunner,
  ExceptionToInvestigate,
  InvestigationContext,
  ProposalDraft,
} from './types.js';

export interface LoopRunnerOptions {
  readonly client: LlmClient;
  readonly smallModel: string;
  readonly largeModel: string;
  /** Allow the one escalation from the small to the large model. */
  readonly escalation: boolean;
  readonly limits?: Limits;
  readonly now?: () => number;
}

const LARGE_EFFORT: Effort = 'high';

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
  }
}

function draftsFrom(
  outcome: LoopOutcome,
  model: string,
  members: readonly ExceptionToInvestigate[],
): ProposalDraft[] {
  return members.map((member) => {
    const done = finalizeFor(outcome, {
      exceptionId: member.id,
      ruleReasonCode: member.ruleReasonCode,
    });
    return {
      content: done.content,
      model,
      harnessFindings: done.findings,
      llmCallId: outcome.lastLlmCallId,
    };
  });
}

export class LoopRunner implements AgentRunner {
  readonly harness = 'loop' as const;
  private readonly limits: Limits;

  constructor(private readonly options: LoopRunnerOptions) {
    this.limits = options.limits ?? DEFAULT_LIMITS;
  }

  async investigate(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
  ): Promise<ProposalDraft[]> {
    const { briefCalls, briefs } = await this.fetchBriefs(members, ctx);
    const run = (model: string, effort: Effort | undefined, digest?: string) =>
      runLoop({
        client: this.options.client,
        ctx,
        model,
        ...(effort === undefined ? {} : { effort }),
        limits: this.limits,
        system: systemPrompt(this.limits),
        opening: firstMessage(briefs, digest),
        memberIds: members.map((m) => m.id),
        briefCalls,
        attributedTo: members.length === 1 ? (members[0]?.id ?? null) : null,
        ...(this.options.now === undefined ? {} : { now: this.options.now }),
      });

    const { smallModel, largeModel } = this.options;
    const first = await run(smallModel, undefined);
    const drafts = draftsFrom(first, smallModel, members);

    const worthASecondLook =
      this.options.escalation &&
      largeModel !== smallModel &&
      first.end.kind === 'answered' &&
      drafts.some((d) => wantsEscalation(d.content));
    if (!worthASecondLook) return drafts;

    const second = await run(largeModel, LARGE_EFFORT, digestOf(first.calls));
    if (second.end.kind !== 'answered') {
      return drafts.map((d) =>
        wantsEscalation(d.content)
          ? {
              ...d,
              harnessFindings: [
                ...d.harnessFindings,
                `a second look by ${largeModel} did not finish (${second.end.kind})`,
              ],
            }
          : d,
      );
    }
    return draftsFrom(second, largeModel, members).map((d) => ({
      ...d,
      harnessFindings: [
        `escalated from ${smallModel} after an unsure or unresolved first pass`,
        ...d.harnessFindings,
      ],
    }));
  }

  /** Call 0: the harness fetches each exception's brief, saving the model a round trip. */
  private async fetchBriefs(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
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
}
