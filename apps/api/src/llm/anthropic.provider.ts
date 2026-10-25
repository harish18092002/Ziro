// The Anthropic adapter: the only file besides gemini.provider.ts that talks to an SDK. It sends strict
// tools plus a JSON-schema output format, caches the static prefix (tools + system prompt), and turns
// every SDK failure into one LlmError kind.
//
// Deliberately absent: temperature, top_p and top_k (rejected by the current models), a forced
// tool_choice (rejected by the larger ones), a thinking budget (adaptive thinking is the default and a
// budget is rejected). SDK retries are OFF (maxRetries 0): the router owns waiting, retrying and fallback.
import Anthropic from '@anthropic-ai/sdk';
import {
  LlmError,
  type LlmEffort,
  type LlmFinishReason,
  type LlmMessage,
  type LlmResult,
} from '@ziro/core/llm';
import { toAnthropicJsonSchema } from './json-schema.js';
import { type LlmProvider, type LlmRequest, LlmAbortedError, nativePayload } from './provider.js';
import { retryAfterMsOf } from './retry-after.js';

export const ANTHROPIC = 'anthropic';

/** The slice of the SDK used here, so a test can stand in for it. */
export interface AnthropicSdkLike {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): PromiseLike<Anthropic.Message>;
  };
}

const EFFORT: Record<LlmEffort, 'low' | 'medium' | 'high'> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

const FINISH: Record<string, LlmFinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  refusal: 'refusal',
  pause_turn: 'pause',
  model_context_window_exceeded: 'context',
};

function toMessage(message: LlmMessage, model: string): Anthropic.MessageParam {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant': {
      if (message.native !== undefined) {
        // The turn exactly as the model produced it, thinking blocks included.
        const blocks = nativePayload(message.native, ANTHROPIC, model);
        return { role: 'assistant', content: blocks as Anthropic.ContentBlockParam[] };
      }
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.text !== '') content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args });
      }
      // The API refuses an empty assistant turn.
      return {
        role: 'assistant',
        content: content.length > 0 ? content : [{ type: 'text', text: '(empty reply)' }],
      };
    }
    case 'tool': {
      const content: Anthropic.ContentBlockParam[] = message.results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.callId,
        content: result.content,
        ...(result.isError === true ? { is_error: true } : {}),
      }));
      if (message.notice !== undefined) content.push({ type: 'text', text: message.notice });
      return { role: 'user', content };
    }
  }
}

/**
 * Anthropic reports a used-up spend allowance as a 400 whose message says so (docs: "the API also returns
 * a 400 when usage reaches an organization or workspace spend limit"), and an empty balance as a 402.
 * The wording of the 400 is not documented, so this is a pattern, checked against the message only.
 */
const SPEND_LIMIT_MESSAGE = /credit balance|spend(?:ing)? limit|usage limit/i;

function kindOf(status: number, message: string, retryAfterMs: number | null) {
  if (status === 401 || status === 403) return 'AUTH' as const;
  if (status === 402) return 'BILLING' as const;
  if (status === 400 && SPEND_LIMIT_MESSAGE.test(message)) return 'BILLING' as const;
  // A tier spend-cap 429 has no retry-after and keeps failing (docs: platform.claude.com/docs/en/api/errors).
  if (status === 429)
    return retryAfterMs === null ? ('QUOTA_EXHAUSTED' as const) : ('RATE_LIMITED' as const);
  if (status === 408 || status === 504) return 'TIMEOUT' as const;
  if (status === 409 || status >= 500) return 'SERVER' as const;
  return 'BAD_REQUEST' as const;
}

function toError(error: unknown, model: string, signal: AbortSignal): unknown {
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError) return new LlmAbortedError();
  const base = { provider: ANTHROPIC, model };
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('TIMEOUT', 'Anthropic API request timed out', base);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError('SERVER', 'Anthropic API unreachable', base);
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : null;
    if (status === null) return new LlmError('SERVER', 'Anthropic API gave no status', base);
    const retryAfterMs = retryAfterMsOf(
      error.headers as { get(name: string): string | null } | undefined,
    );
    return new LlmError(
      kindOf(status, error.message, retryAfterMs),
      `Anthropic API error ${status}: ${error.message}`.slice(0, 300),
      { ...base, status, requestId: error.requestID ?? null, retryAfterMs },
    );
  }
  return error; // a bug of ours, not the provider's: let it surface
}

export class AnthropicProvider implements LlmProvider {
  readonly name = ANTHROPIC;

  constructor(private readonly sdk: AnthropicSdkLike) {}

  static fromApiKey(apiKey: string, options: { baseURL?: string } = {}): AnthropicProvider {
    return new AnthropicProvider(
      new Anthropic({
        apiKey,
        maxRetries: 0,
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      }),
    );
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const output = request.output === undefined ? undefined : toAnthropicJsonSchema(request.output);
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: request.messages.map((m) => toMessage(m, request.model)),
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: toAnthropicJsonSchema(tool.input) as Anthropic.Tool['input_schema'],
              strict: true,
            })),
          }),
      ...(request.effort === undefined && output === undefined
        ? {}
        : {
            output_config: {
              ...(request.effort === undefined ? {} : { effort: EFFORT[request.effort] }),
              ...(output === undefined
                ? {}
                : { format: { type: 'json_schema' as const, schema: output } }),
            },
          }),
    };

    let message: Anthropic.Message;
    try {
      message = await this.sdk.messages.create(body, { signal: request.signal });
    } catch (error) {
      throw toError(error, request.model, request.signal);
    }

    const stopReason = message.stop_reason ?? 'end_turn';
    const finishReason = FINISH[stopReason] ?? 'stop';
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    // A reply cut off by max_tokens may still be complete JSON, but a half-written tool call must never
    // be executed: it is dropped here, so no caller has to remember to.
    const toolCalls =
      finishReason === 'length'
        ? []
        : message.content
            .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
            .map((b) => ({ id: b.id, name: b.name, args: b.input }));
    const usage = message.usage;
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        thoughtTokens: 0, // Anthropic counts thinking inside output_tokens
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
      finishReason,
      stopReason,
      native: { provider: ANTHROPIC, model: request.model, payload: message.content },
      requestId: (message as { _request_id?: string | null })._request_id ?? null,
    };
  }
}
