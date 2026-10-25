// The Gemini adapter, on the Interactions API (ai.google.dev/gemini-api/docs/interactions: generally
// available and recommended for new projects) in STATELESS mode (`store: false`): we send the whole
// conversation each time and the server keeps nothing.
//
// Thought signatures (docs/thinking, "stateless mode"): "You MUST always resend all thought blocks exactly
// as they were received from the model." A signature lives only on `thought` steps, never on a
// function_call or model_output. So the steps a response returns are kept whole, in order, as the
// assistant message's `native` payload, and sent back untouched on the next request, followed by our
// `function_result` steps. History is append-only: nothing is trimmed, reordered or summarised.
//
// SDK retries are OFF (`retries: {strategy: 'none'}`; the SDK's default is up to 4 retries on 408, 409,
// 429 and 5xx): the router owns waiting, retrying and fallback, and a hidden retry would spend requests
// the quota limiter never saw.
import { GoogleGenAI } from '@google/genai';
import {
  LlmError,
  type LlmErrorKind,
  type LlmFinishReason,
  type LlmMessage,
  type LlmResult,
} from '@ziro/core/llm';
import { toGeminiJsonSchema } from './json-schema.js';
import { type LlmProvider, type LlmRequest, LlmAbortedError, nativePayload } from './provider.js';
import { retryAfterMsOf } from './retry-after.js';

export const GEMINI = 'gemini';

// --- the slice of the Interactions API used here --------------------------------------------------

/** A step is opaque except for the few kinds and fields this adapter reads. */
export interface GeminiStep {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface GeminiCreateBody {
  readonly model: string;
  readonly input: readonly GeminiStep[];
  readonly system_instruction: string;
  readonly store: false;
  readonly tools?: readonly {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];
  readonly generation_config: { max_output_tokens: number; thinking_level?: string };
  readonly response_format?: {
    type: 'text';
    mime_type: 'application/json';
    schema: Record<string, unknown>;
  };
}

export interface GeminiInteraction {
  readonly id?: string;
  readonly status: string;
  readonly steps?: readonly GeminiStep[];
  readonly errors?: readonly { code?: string; message?: string }[];
  readonly usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    total_cached_tokens?: number;
  };
}

export interface GeminiRequestOptions {
  readonly signal: AbortSignal;
  readonly retries: { readonly strategy: 'none' };
}

export interface GeminiSdkLike {
  interactions: {
    create(body: GeminiCreateBody, options: GeminiRequestOptions): PromiseLike<GeminiInteraction>;
  };
}

// --- request ----------------------------------------------------------------------------------------

const textPart = (text: string) => [{ type: 'text', text }];

function toSteps(message: LlmMessage, model: string): GeminiStep[] {
  switch (message.role) {
    case 'user':
      return [{ type: 'user_input', content: textPart(message.content) }];
    case 'assistant': {
      // The steps exactly as the model produced them, thought signatures included.
      if (message.native !== undefined) {
        return [...(nativePayload(message.native, GEMINI, model) as GeminiStep[])];
      }
      const steps: GeminiStep[] = [];
      if (message.text !== '')
        steps.push({ type: 'model_output', content: textPart(message.text) });
      for (const call of message.toolCalls) {
        steps.push({ type: 'function_call', id: call.id, name: call.name, arguments: call.args });
      }
      return steps;
    }
    case 'tool': {
      const steps: GeminiStep[] = message.results.map((result) => ({
        type: 'function_result',
        call_id: result.callId,
        name: result.name,
        result: textPart(result.content),
        ...(result.isError === true ? { is_error: true } : {}),
      }));
      if (message.notice !== undefined) {
        steps.push({ type: 'user_input', content: textPart(message.notice) });
      }
      return steps;
    }
  }
}

// --- errors -----------------------------------------------------------------------------------------

/** Error codes the API documents (ai.google.dev/gemini-api/docs/api-errors), by what to do about them. */
const KIND_BY_CODE: Readonly<Record<string, LlmErrorKind>> = {
  rate_limit_exceeded: 'RATE_LIMITED',
  too_many_requests: 'RATE_LIMITED',
  quota_exceeded: 'QUOTA_EXHAUSTED',
  payment_required: 'BILLING',
  authentication: 'AUTH',
  permission_denied: 'AUTH',
  deadline_exceeded: 'TIMEOUT',
  api_error: 'SERVER',
  service_unavailable: 'SERVER',
  aborted: 'SERVER',
  cancelled: 'SERVER',
  invalid_request: 'BAD_REQUEST',
  parameter_unknown: 'BAD_REQUEST',
  out_of_range: 'BAD_REQUEST',
  not_found: 'BAD_REQUEST',
  model_not_found: 'BAD_REQUEST',
  unimplemented: 'BAD_REQUEST',
  // Generation blocked by a content policy.
  safety: 'SAFETY_BLOCKED',
  recitation: 'SAFETY_BLOCKED',
  language: 'SAFETY_BLOCKED',
  prohibited_content: 'SAFETY_BLOCKED',
  spii: 'SAFETY_BLOCKED',
  blocklist: 'SAFETY_BLOCKED',
  content_blocked: 'SAFETY_BLOCKED',
  image_safety: 'SAFETY_BLOCKED',
  image_prohibited_content: 'SAFETY_BLOCKED',
  image_recitation: 'SAFETY_BLOCKED',
  image_other: 'SAFETY_BLOCKED',
  // The model's output was structurally unusable.
  malformed_function_call: 'MALFORMED',
  malformed_tool_call: 'MALFORMED',
  unexpected_tool_call: 'MALFORMED',
  too_many_tool_calls: 'MALFORMED',
  // We lost a signature we were told to keep: our bug, and no other model fixes it.
  missing_thought_signature: 'BAD_REQUEST',
};

function kindOfStatus(status: number): LlmErrorKind {
  if (status === 401 || status === 402 || status === 403) {
    return status === 402 ? 'BILLING' : 'AUTH';
  }
  if (status === 429) return 'RATE_LIMITED';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 409 || status >= 500) return 'SERVER';
  return 'BAD_REQUEST';
}

/** `failed_precondition` is documented with one example, billing being disabled; anything else is ours. */
function kindOf(code: string | undefined, status: number | null, message: string): LlmErrorKind {
  if (code === 'failed_precondition') return /billing/i.test(message) ? 'BILLING' : 'BAD_REQUEST';
  const byCode = code === undefined ? undefined : KIND_BY_CODE[code];
  if (byCode !== undefined) return byCode;
  return status === null ? 'SERVER' : kindOfStatus(status);
}

interface ErrorLike {
  status?: unknown;
  statusCode?: unknown;
  body?: unknown;
  message?: unknown;
  headers?: { get(name: string): string | null };
  error?: unknown;
  name?: unknown;
}

/** The documented `{"error": {"code", "message"}}` body, from the raw text or the SDK's parsed copy. */
function bodyOf(error: ErrorLike): { code?: string; message?: string } {
  const read = (value: unknown): { code?: string; message?: string } => {
    const inner = (value as { error?: unknown } | null | undefined)?.error;
    if (typeof inner !== 'object' || inner === null) return {};
    const { code, message } = inner as { code?: unknown; message?: unknown };
    return {
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    };
  };
  if (typeof error.body === 'string') {
    try {
      const parsed = read(JSON.parse(error.body));
      if (parsed.code !== undefined || parsed.message !== undefined) return parsed;
    } catch {
      // not JSON: fall through to the SDK's copy
    }
  }
  return read(error.error);
}

function toError(error: unknown, model: string, signal: AbortSignal): unknown {
  if (signal.aborted) return new LlmAbortedError();
  if (typeof error !== 'object' || error === null) return error;
  const e = error as ErrorLike;
  const base = { provider: GEMINI, model };
  if (e.name === 'APIUserAbortError') return new LlmAbortedError();
  if (e.name === 'APIConnectionTimeoutError') {
    return new LlmError('TIMEOUT', 'Gemini API request timed out', base);
  }
  if (e.name === 'APIConnectionError') {
    return new LlmError('SERVER', 'Gemini API unreachable', base);
  }
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : null;
  if (status === null) return error; // not an API failure: a bug of ours, let it surface
  const { code, message } = bodyOf(e);
  const text = message ?? (typeof e.message === 'string' ? e.message : 'no message');
  return new LlmError(
    kindOf(code, status, text),
    `Gemini API error ${status}${code === undefined ? '' : ` ${code}`}: ${text}`.slice(0, 300),
    { ...base, status, retryAfterMs: retryAfterMsOf(e.headers) },
  );
}

// --- response ---------------------------------------------------------------------------------------

function failed(interaction: GeminiInteraction, model: string): LlmError {
  const first = interaction.errors?.[0];
  const text = first?.message ?? `the interaction ended with status "${interaction.status}"`;
  return new LlmError(
    kindOf(first?.code, null, text),
    `Gemini interaction ${interaction.status}${first?.code === undefined ? '' : ` ${first.code}`}: ${text}`.slice(
      0,
      300,
    ),
    { provider: GEMINI, model, requestId: interaction.id ?? null },
  );
}

const textOf = (step: GeminiStep): string => {
  const parts = step['content'];
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p: unknown) => {
      const part = p as { type?: unknown; text?: unknown };
      return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
    })
    .join('');
};

export class GeminiProvider implements LlmProvider {
  readonly name = GEMINI;

  constructor(private readonly sdk: GeminiSdkLike) {}

  static fromApiKey(apiKey: string, options: { baseUrl?: string } = {}): GeminiProvider {
    const ai = new GoogleGenAI({
      apiKey,
      ...(options.baseUrl === undefined ? {} : { httpOptions: { baseUrl: options.baseUrl } }),
    });
    return new GeminiProvider({
      interactions: {
        // The SDK types its input as mutable arrays; ours are readonly. The wire format is the same.
        create: (body, requestOptions) => ai.interactions.create(body as never, requestOptions),
      },
    });
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const body: GeminiCreateBody = {
      model: request.model,
      input: request.messages.flatMap((m) => toSteps(m, request.model)),
      system_instruction: request.system,
      store: false,
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map((tool) => ({
              type: 'function' as const,
              name: tool.name,
              description: tool.description,
              parameters: toGeminiJsonSchema(tool.input),
            })),
          }),
      generation_config: {
        max_output_tokens: request.maxOutputTokens,
        ...(request.effort === undefined ? {} : { thinking_level: request.effort }),
      },
      ...(request.output === undefined
        ? {}
        : {
            response_format: {
              type: 'text' as const,
              mime_type: 'application/json' as const,
              schema: toGeminiJsonSchema(request.output),
            },
          }),
    };

    let interaction: GeminiInteraction;
    try {
      interaction = await this.sdk.interactions.create(body, {
        signal: request.signal,
        retries: { strategy: 'none' },
      });
    } catch (error) {
      throw toError(error, request.model, request.signal);
    }

    if (interaction.status === 'failed' || interaction.status === 'cancelled') {
      throw failed(interaction, request.model);
    }
    if (interaction.errors !== undefined && interaction.errors.length > 0) {
      throw failed(interaction, request.model);
    }
    if (interaction.status === 'in_progress' || interaction.status === 'queued') {
      // A synchronous call should never come back unfinished.
      throw new LlmError('SERVER', `Gemini interaction is still "${interaction.status}"`, {
        provider: GEMINI,
        model: request.model,
        requestId: interaction.id ?? null,
      });
    }

    const steps = interaction.steps ?? [];
    for (const step of steps) {
      const stepError = step['error'] as { message?: unknown } | undefined;
      if (stepError !== undefined && stepError !== null) {
        const detail = typeof stepError.message === 'string' ? stepError.message : 'no message';
        throw new LlmError('MALFORMED', `Gemini step reported an error: ${detail}`.slice(0, 300), {
          provider: GEMINI,
          model: request.model,
          requestId: interaction.id ?? null,
        });
      }
    }

    const cut = interaction.status === 'incomplete' || interaction.status === 'budget_exceeded';
    // As with any provider: a reply cut off mid-way may still be complete JSON, but a half-written tool
    // call must never be executed.
    const toolCalls = cut
      ? []
      : steps
          .filter((s) => s.type === 'function_call')
          .map((s) => ({
            id: String(s['id']),
            name: String(s['name']),
            args: s['arguments'] ?? {},
          }));
    const finishReason: LlmFinishReason = cut
      ? 'length'
      : toolCalls.length > 0
        ? 'tool_calls'
        : 'stop';
    const usage = interaction.usage ?? {};
    const cached = usage.total_cached_tokens ?? 0;
    return {
      text: steps
        .filter((s) => s.type === 'model_output')
        .map(textOf)
        .join(''),
      toolCalls,
      usage: {
        // Assumed: cached tokens are counted inside total_input_tokens (the usual shape). If they are not,
        // this under-reports input; the live smoke test prints the raw usage to settle it.
        inputTokens: Math.max(0, (usage.total_input_tokens ?? 0) - cached),
        outputTokens: usage.total_output_tokens ?? 0,
        thoughtTokens: usage.total_thought_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
      finishReason,
      stopReason: interaction.status,
      native: { provider: GEMINI, model: request.model, payload: steps },
      requestId: interaction.id ?? null,
    };
  }
}
