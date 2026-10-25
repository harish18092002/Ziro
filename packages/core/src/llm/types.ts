// What a conversation with a language model looks like, with no provider in it. Adapters in
// apps/api/src/llm translate these to and from each SDK; nothing in here knows an SDK exists.
//
// Tools and the reply shape are zod schemas written once. Each adapter turns them into the JSON Schema
// subset its own API accepts, so a provider switch never touches a tool.
import type { z } from 'zod';

/**
 * What a provider hands back that must go back to it unchanged on the next turn: Anthropic's thinking
 * blocks, Gemini's signed thought steps. Opaque to everything except the adapter that produced it, which
 * refuses one from another provider or model. Editing, dropping or reordering it invalidates the turn.
 */
export interface LlmNative {
  readonly provider: string;
  readonly model: string;
  readonly payload: unknown;
}

export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface LlmToolResult {
  /** The id of the call this answers. */
  readonly callId: string;
  readonly name: string;
  readonly content: string;
  readonly isError?: boolean;
}

export type LlmMessage =
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly text: string;
      readonly toolCalls: readonly LlmToolCall[];
      readonly native?: LlmNative;
    }
  /** The results of the previous assistant turn's tool calls, plus an optional note to the model. */
  | { readonly role: 'tool'; readonly results: readonly LlmToolResult[]; readonly notice?: string };

export interface LlmToolDef {
  readonly name: string;
  readonly description: string;
  /** The arguments the tool takes. */
  readonly input: z.ZodType;
}

/** How hard the model should think. Adapters map it to what their API calls it, or ignore it. */
export type LlmEffort = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Why the model stopped, in words that mean the same everywhere. The provider's own word is kept
 * beside it in `LlmResult.stopReason`.
 */
export type LlmFinishReason =
  | 'stop'
  | 'tool_calls'
  /** Cut off by the output-token limit. */
  | 'length'
  /** The conversation no longer fits the model's context window. */
  | 'context'
  | 'refusal'
  /** The provider asks to be called again with the same conversation. */
  | 'pause';

export interface LlmUsage {
  /** Prompt tokens that were neither read from nor written to a cache. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens spent thinking, when the provider reports them apart from the output. Billed as output. */
  readonly thoughtTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface LlmResult {
  /** The model's text: for a final reply, the JSON. Empty when it only asked for tools. */
  readonly text: string;
  readonly toolCalls: readonly LlmToolCall[];
  readonly usage: LlmUsage;
  readonly finishReason: LlmFinishReason;
  /** The provider's own stop word (`end_turn`, `completed`, ...), for the log. */
  readonly stopReason: string;
  /** Present when the provider needs this turn echoed back; keep it on the assistant message. */
  readonly native?: LlmNative;
  readonly requestId: string | null;
}
