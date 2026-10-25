// The one thing the loop needs from a model API: send a conversation, get a response. A small port,
// so the loop is tested against a scripted fake and only AnthropicLlmClient touches the SDK.
import type { JsonSchema } from '../llm/json-schema.js';
import type { Usage } from './pricing.js';
import type { ToolDefinition } from './tools/toolbox.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * A block the model produced. Anything that is not text or tool_use (thinking, redacted thinking) is
 * opaque to the loop and passed back exactly as received: such blocks are bound to the conversation
 * that produced them, and editing or dropping one invalidates the turn.
 */
export type AssistantBlock =
  TextBlock | ToolUseBlock | { readonly type: string; readonly [key: string]: unknown };

export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: true;
}

export type LlmMessage =
  | { readonly role: 'user'; readonly content: string | readonly (ToolResultBlock | TextBlock)[] }
  | { readonly role: 'assistant'; readonly content: readonly AssistantBlock[] };

export interface LlmRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly maxTokens: number;
  /** The JSON Schema the final reply must follow. */
  readonly outputSchema: JsonSchema;
  readonly effort?: Effort;
  /** Aborts the request, retries included, when the investigation's time budget is spent. */
  readonly signal: AbortSignal;
}

export interface LlmResponse {
  readonly content: readonly AssistantBlock[];
  readonly stopReason: string;
  readonly usage: Usage;
  readonly requestId: string | null;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** The request was cut off because its signal fired (the time budget). Not a failure of the API. */
export class LlmAbortedError extends Error {
  constructor() {
    super('the model request was aborted');
  }
}

/**
 * What kind of failure it was, which decides what to do about it (docs: platform.claude.com/docs/en/api/errors):
 *   transient  a timeout, 408/409, 5xx incl. 504 and 529, or a 429 WITH retry-after: wait and try again
 *   sustained  a 429 WITHOUT retry-after (the docs say a spend-cap 429 has none and keeps failing) or 402
 *              billing: trying again will not help, and neither will the next exception
 *   auth       401 or 403: the key is wrong or lacks permission, for every exception alike
 *   rejected   400, 404, 413 and the rest: this request was refused; retrying the same request is pointless
 */
export type LlmFailureKind = 'transient' | 'sustained' | 'auth' | 'rejected';

export function classifyLlmFailure(
  status: number | null,
  retryAfterMs: number | null,
): LlmFailureKind {
  if (status === null) return 'transient'; // no response at all: a dropped connection or a timeout
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'sustained';
  if (status === 429) return retryAfterMs === null ? 'sustained' : 'transient';
  if (status === 408 || status === 409 || status >= 500) return 'transient';
  return 'rejected';
}

/** The API failed. `retryable` says whether trying the same job again later could succeed. */
export class LlmError extends Error {
  readonly kind: LlmFailureKind;

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null,
    readonly requestId: string | null,
    /** How long the server asked us to wait (a retry-after header), if it said. */
    readonly retryAfterMs: number | null = null,
    kind?: LlmFailureKind,
  ) {
    super(message);
    this.kind = kind ?? (retryable ? 'transient' : 'rejected');
  }
}

export const isText = (block: AssistantBlock): block is TextBlock =>
  block.type === 'text' && typeof (block as { text?: unknown }).text === 'string';

export const isToolUse = (block: AssistantBlock): block is ToolUseBlock =>
  block.type === 'tool_use';
