import type { AGENT_TOOL_NAMES, RecordRef } from '@ziro/core/domain';
import type { z } from 'zod';
import type { FeeContract } from '../../common/fee-contract.js';
import type { Executor } from '../../db/executor.js';

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/** Everything a tool may touch. `tx` is a READ ONLY transaction: Postgres itself refuses a write. */
export interface ToolContext {
  readonly tx: Executor;
  /** From the investigation, never from the model: a tool cannot be pointed at another run. */
  readonly runId: string;
  readonly fees: { readonly contract: FeeContract; readonly source: 'run' | 'default' };
}

export interface ToolOutput {
  /** What the model is shown, as JSON. Amounts are integer paise as strings. */
  readonly data: Record<string, unknown>;
  /** One deterministic line saying what the call found. Used as evidence if the budget runs out. */
  readonly summary: string;
  /** Every record this result mentioned: the only records the model is allowed to cite. */
  readonly seen: readonly RecordRef[];
}

export interface AgentTool<A = unknown> {
  readonly name: AgentToolName;
  readonly description: string;
  /** Strict: unknown keys are rejected. Also the source of the JSON Schema sent to the API. */
  readonly args: z.ZodType<A>;
  execute(args: A, ctx: ToolContext): Promise<ToolOutput>;
}

export type ToolRun =
  | {
      readonly ok: true;
      readonly content: string;
      readonly summary: string;
      readonly seen: readonly RecordRef[];
    }
  | { readonly ok: false; readonly error: string };

/** A tool the model rejected or that could not run: the model is told, and can try something else. */
export class ToolError extends Error {}
