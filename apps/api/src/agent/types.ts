// The seam between the service (queue, persistence, audit) and a harness (how the investigation is
// actually carried out). Two harnesses implement `AgentRunner` (ADR-018): the tool-use loop and the
// single-shot harness, chosen by AGENT_HARNESS. The scripted demo agent implements it too.
import type { AgentProposalContent, ReasonCode } from '@ziro/core/domain';
import type { Attempt } from '../llm/router.js';
import type { DegradedReason } from './degraded.js';
import type { Toolbox } from './tools/toolbox.js';

export type HarnessName = 'loop' | 'single-shot';

/** An exception to investigate, as the service loaded it. */
export interface ExceptionToInvestigate {
  readonly id: string;
  /** What the matching rules concluded; the fallback reason code if the agent cannot conclude. */
  readonly ruleReasonCode: ReasonCode;
}

/** What a harness may use. Everything outside the model call itself is the service's business. */
export interface InvestigationContext {
  readonly runId: string;
  /** Read-only tools, scoped to the run. */
  readonly toolbox: Toolbox;
  /** Throws if the kill switch is on or the daily LLM budget is spent. Awaited before every request. */
  gate(): Promise<void>;
  /**
   * Persists one model attempt at once (spend is recorded even if the investigation later fails, and so is
   * a failed attempt that the router fell back from); returns the stored call's id.
   */
  recordLlmCall(attempt: Attempt): Promise<string | null>;
}

/** An investigation's answer for one exception, before the service stores it. */
export interface ProposalDraft {
  readonly content: AgentProposalContent;
  /** The model that produced the conclusion; null when none did. */
  readonly model: string | null;
  /** Its provider (gemini, anthropic); null when no model concluded. */
  readonly provider?: string | null;
  /** Why the harness changed or limited what the model said. */
  readonly harnessFindings: string[];
  /** The request that produced the conclusion. */
  readonly llmCallId: string | null;
  /**
   * Set when the harness could not get a conclusion and handed the exception to a person (NEEDS_HUMAN):
   * the structured reason, so it can be counted and shown. Null or absent for a conclusion, including a
   * model's own "I cannot tell".
   */
  readonly degraded?: DegradedReason | null;
}

export interface AgentRunner {
  readonly harness: HarnessName;
  /**
   * Investigates one exception, or a small cluster of related ones in a single conversation. Returns
   * exactly one draft per exception given, in the same order. Never throws for a model's failure to
   * conclude (that is a NEEDS_HUMAN draft); throws only for infrastructure failures and halts.
   */
  investigate(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
  ): Promise<ProposalDraft[]>;
}

/** What a harness may tell a measurement beyond what the toolbox shows. Optional; production passes none. */
export interface RunnerTelemetry {
  /** The model asked for a tool that does not exist. */
  unknownTool(exceptionIds: readonly string[], name: string): void;
}

/** Why no more model calls will be made for now. The exception stays open for a later run. */
export type HaltReason = 'kill_switch' | 'daily_budget';

export const HALT_MESSAGE: Record<HaltReason, string> = {
  kill_switch: 'the agent kill switch is on',
  daily_budget: 'the daily LLM budget is spent',
};

/** Thrown by `gate` when no more LLM calls may be made. The job stops; the exception stays open. */
export class AgentHalted extends Error {
  constructor(readonly reason: HaltReason) {
    super(HALT_MESSAGE[reason]);
  }
}
