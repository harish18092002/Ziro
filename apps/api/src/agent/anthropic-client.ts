// The only file that talks to @anthropic-ai/sdk. It sends strict tools plus a JSON-schema output
// format, caches the static prefix (tools + system prompt), and maps the SDK's errors onto the two the
// loop understands.
//
// What is deliberately absent: temperature, top_p and top_k (rejected by the current models), a forced
// tool_choice (rejected by the larger ones), a thinking budget (adaptive thinking is the default, and a
// budget is rejected). Retries are the SDK's own (2, with backoff); the request's signal bounds them all.
import Anthropic from '@anthropic-ai/sdk';
import {
  type AssistantBlock,
  classifyLlmFailure,
  type LlmClient,
  LlmAbortedError,
  LlmError,
  type LlmRequest,
  type LlmResponse,
} from './llm.js';

/** The slice of the SDK used here, so a test can stand in for it. */
export interface AnthropicLike {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): PromiseLike<Anthropic.Message>;
  };
}

/**
 * How long the server asked us to wait. `retry-after-ms` (milliseconds) wins over `retry-after`
 * (seconds, or an HTTP date). Null when it said nothing usable.
 */
export function retryAfterMsOf(
  headers: { get(name: string): string | null } | undefined,
  now = Date.now(),
): number | null {
  if (headers === undefined) return null;
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') !== null && Number.isFinite(ms) && ms >= 0)
    return Math.round(ms);
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function toLlmError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError) return new LlmAbortedError();
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : null;
    // The SDK types `headers` loosely; what it holds is a Headers object (or nothing, for a dropped connection).
    const retryAfterMs = retryAfterMsOf(
      error.headers as { get(name: string): string | null } | undefined,
    );
    const kind = classifyLlmFailure(status, retryAfterMs);
    const text = `Anthropic API error${status === null ? '' : ` ${status}`}: ${error.message}`;
    return new LlmError(
      text.slice(0, 300),
      kind === 'transient',
      status,
      error.requestID ?? null,
      retryAfterMs,
      kind,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly sdk: AnthropicLike) {}

  static fromApiKey(apiKey: string): AnthropicLlmClient {
    return new AnthropicLlmClient(new Anthropic({ apiKey, maxRetries: 2 }));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: request.messages as Anthropic.MessageParam[],
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as Anthropic.Tool['input_schema'],
        strict: true,
      })),
      output_config: {
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        format: { type: 'json_schema', schema: request.outputSchema },
      },
    };

    let message: Anthropic.Message;
    try {
      message = await this.sdk.messages.create(body, { signal: request.signal });
    } catch (error) {
      throw toLlmError(error, request.signal);
    }

    const usage = message.usage;
    return {
      content: message.content as unknown as AssistantBlock[],
      stopReason: message.stop_reason ?? 'end_turn',
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
      requestId: (message as { _request_id?: string | null })._request_id ?? null,
    };
  }
}
