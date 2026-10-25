// Harness A as an AgentRunner. It fetches the exception briefs (call 0), then lets the router run the tool
// loop on the first model that will take it (falling back down the chain, restarting from the first
// message each time), checks what came back, and, if AGENT_ESCALATION is on and the answer was unsure,
// looks once more on the next model in a fresh conversation seeded with a digest of the first pass.
//
// Escalation is only for a model that tried and could not decide. A budget that ran out, a refusal or
// an unusable reply are not reasons to spend more: those go to a person as they are.
import type { LlmRouter } from '../llm/router.js';
import { type Limits, DEFAULT_LIMITS } from './budget.js';
import { runLoop } from './loop.js';
import { fetchBriefs } from './outcome.js';
import { firstMessage, systemPrompt } from './prompt.js';
import { runRouted } from './routed.js';
import type {
  AgentRunner,
  ExceptionToInvestigate,
  InvestigationContext,
  ProposalDraft,
} from './types.js';

export interface LoopRunnerOptions {
  readonly router: LlmRouter;
  /** Allow one second look by the next model in the chain when the first is unsure. */
  readonly escalation: boolean;
  readonly limits?: Limits;
  readonly now?: () => number;
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
    const { briefCalls, briefs } = await fetchBriefs(members, ctx);
    return runRouted({
      router: this.options.router,
      ctx,
      members,
      briefCalls,
      escalation: this.options.escalation,
      attempt: (session, digest) =>
        runLoop({
          session,
          ctx,
          limits: this.limits,
          system: systemPrompt(this.limits, 'loop'),
          opening: firstMessage(briefs, digest),
          memberIds: members.map((m) => m.id),
          briefCalls,
          attributedTo: members.length === 1 ? (members[0]?.id ?? null) : null,
          ...(this.options.now === undefined ? {} : { now: this.options.now }),
        }),
    });
  }
}
