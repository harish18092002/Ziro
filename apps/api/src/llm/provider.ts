// The one thing the agent needs from a model API: send a conversation, get one turn back. A small port,
// so everything above it is tested against a scripted fake and only the adapters touch an SDK.
//
// An adapter makes exactly ONE attempt per call and never waits or retries (SDK retries are switched
// off): the router owns retry, waiting and fallback, because it is the only place that knows the quota.
// A failure is thrown as an LlmError of one kind (core/llm/errors.ts), except the caller's own abort.
import type { LlmEffort, LlmMessage, LlmResult, LlmToolDef } from '@ziro/core/llm';
import type { z } from 'zod';

export interface LlmRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolDef[];
  readonly maxOutputTokens: number;
  /** The shape the final reply must take. Written once as zod; each adapter converts it. */
  readonly output?: z.ZodType;
  readonly effort?: LlmEffort;
  /** Aborts the request when the investigation's time budget is spent. */
  readonly signal: AbortSignal;
}

export interface LlmProvider {
  /** `gemini`, `anthropic`, ... the left half of an LLM_CHAIN entry. */
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResult>;
}

/** The request was cut off because its signal fired (the time budget). Not a failure of the provider. */
export class LlmAbortedError extends Error {
  constructor() {
    super('the model request was aborted');
    this.name = 'LlmAbortedError';
  }
}

/**
 * A provider-native payload (thinking blocks, signed thought steps) is bound to the conversation and model
 * that produced it. Handing one to another provider or model means two models were mixed inside one
 * investigation. That is a bug in the caller, never a provider failure, so it is not an LlmError.
 */
export class NativeMismatchError extends Error {
  constructor(expected: string, actual: { provider: string; model: string }) {
    super(
      `a ${actual.provider}/${actual.model} turn was handed to ${expected}; one investigation never mixes models`,
    );
    this.name = 'NativeMismatchError';
  }
}

/** The native payload of an assistant turn, after checking it belongs to this provider and model. */
export function nativePayload(
  native: { provider: string; model: string; payload: unknown },
  provider: string,
  model: string,
): unknown {
  if (native.provider !== provider || native.model !== model) {
    throw new NativeMismatchError(`${provider}/${model}`, native);
  }
  return native.payload;
}
