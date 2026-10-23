// The seam between the service (queue, persistence, audit) and a harness (how the investigation is
// actually carried out). Harness A, the hand-rolled loop, implements `AgentRunner`; Harness B, the
// Claude Agent SDK, will implement the same interface in P11 and be swapped in by AGENT_HARNESS.
import type { AgentProposalContent, ReasonCode } from '@ziro/core/domain';
import type { Usage } from './pricing.js';
import type { Toolbox } from './tools/toolbox.js';

export type HarnessName = 'loop' | 'agent-sdk';

/** An exception to investigate, as the service loaded it. */
export interface ExceptionToInvestigate {
  readonly id: string;
  /** What the matching rules concluded; the fallback reason code if the agent cannot conclude. */
  readonly ruleReasonCode: ReasonCode;
}

/** One model request, ready to be written to llm_calls. */
export interface LlmCallRecord {
  /** The exception it was for, or null when one conversation covered a cluster. */
  readonly exceptionId: string | null;
  readonly model: string;
  readonly harness: HarnessName;
  readonly usage: Usage;
  readonly costMicroUsd: bigint;
  readonly latencyMs: number;
  /** sha-256 of system prompt, tool set and opening message. */
  readonly promptHash: string;
  readonly stopReason: string | null;
  readonly requestId: string | null;
}

/** What a harness may use. Everything outside the model call itself is the service's business. */
export interface InvestigationContext {
  readonly runId: string;
  /** Read-only tools, scoped to the run. */
  readonly toolbox: Toolbox;
  /** Throws if the kill switch is on or the daily LLM budget is spent. Awaited before every request. */
  gate(): Promise<void>;
  /** Persists the call at once (spend is recorded even if the investigation later fails); returns its id. */
  recordLlmCall(call: LlmCallRecord): Promise<string>;
}

/** An investigation's answer for one exception, before the service stores it. */
export interface ProposalDraft {
  readonly content: AgentProposalContent;
  /** The model that produced the conclusion; null when none did. */
  readonly model: string | null;
  /** Why the harness changed or limited what the model said. */
  readonly harnessFindings: string[];
  /** The request that produced the conclusion. */
  readonly llmCallId: string | null;
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
  /** The model asked for a tool that does not exist (harness B never reaches the toolbox with one). */
  unknownTool(exceptionIds: readonly string[], name: string): void;
  /** The cost the harness's own library estimated, in micro-USD, for comparison with ours. */
  reportedCost(exceptionIds: readonly string[], microUsd: number): void;
}

/** Thrown by `gate` when no more LLM calls may be made. The job stops; the exception stays open. */
export class AgentHalted extends Error {
  constructor(readonly reason: 'kill_switch' | 'daily_budget') {
    super(
      reason === 'kill_switch' ? 'the agent kill switch is on' : 'the daily LLM budget is spent',
    );
  }
}
