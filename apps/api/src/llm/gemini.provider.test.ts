import { LlmError, type LlmErrorKind } from '@ziro/core/llm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { modelOutputSchema } from '../agent/output.js';
import { GeminiProvider } from './gemini.provider.js';
import { LlmAbortedError, type LlmRequest, NativeMismatchError } from './provider.js';
import { type StubServer, startStub } from './stub-server.fixtures.js';

const MODEL = 'gemini-test-flash';

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: MODEL,
  system: 'SYSTEM',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [
    {
      name: 'lookup',
      description: 'finds a thing',
      input: z.strictObject({ id: z.string().min(1) }),
    },
  ],
  maxOutputTokens: 1234,
  output: z.strictObject({ answer: z.string() }),
  effort: 'low',
  signal: new AbortController().signal,
  ...over,
});

const interaction = (over: Record<string, unknown> = {}) => ({
  id: 'int_1',
  status: 'completed',
  model: MODEL,
  steps: [
    { type: 'thought', signature: 'SIG-1', summary: [] },
    { type: 'model_output', content: [{ type: 'text', text: '{"answer":"x"}' }] },
  ],
  usage: {
    total_input_tokens: 10,
    total_output_tokens: 5,
    total_thought_tokens: 3,
    total_cached_tokens: 2,
    total_tokens: 18,
  },
  ...over,
});

const apiError = (code: string, text: string) => ({ error: { code, message: text } });

let stub: StubServer;
let provider: GeminiProvider;

beforeAll(async () => {
  stub = await startStub();
  provider = GeminiProvider.fromApiKey('test-key', { baseUrl: stub.url });
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.requests.length = 0;
  stub.reply({ json: interaction() });
});

const sent = (): Record<string, unknown> => stub.requests[0]?.body as Record<string, unknown>;

describe('GeminiProvider request', () => {
  it('sends a stateless interaction: the whole input, function tools, the JSON output format', async () => {
    await provider.complete(request());
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.method).toBe('POST');
    expect(stub.requests[0]?.url).toBe('/v1beta/interactions');
    expect(stub.requests[0]?.headers['x-goog-api-key']).toBe('test-key');
    expect(sent()).toEqual({
      model: MODEL,
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'hello' }] }],
      system_instruction: 'SYSTEM',
      store: false,
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'finds a thing',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
        },
      ],
      generation_config: { max_output_tokens: 1234, thinking_level: 'low' },
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
      },
    });
    expect(sent()).not.toHaveProperty('previous_interaction_id');
  });

  it('leaves out tools, output format and thinking level when not asked for', async () => {
    await provider.complete(request({ tools: [], output: undefined, effort: undefined }));
    const body = sent();
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('response_format');
    expect(body['generation_config']).toEqual({ max_output_tokens: 1234 });
  });

  it('sends the reply schema with no union, even for the real agent output', async () => {
    await provider.complete(request({ output: modelOutputSchema }));
    const schema = JSON.stringify((sent()['response_format'] as { schema: unknown }).schema);
    expect(schema).not.toContain('anyOf');
    expect(schema).not.toContain('"pattern"');
    expect(schema).toContain('"type":["object","null"]'); // draftJournalEntry is nullable
  });

  it('sends earlier thought and function-call steps back exactly as received, then our results', async () => {
    const received = [
      { type: 'thought', signature: 'SIG-A', summary: [{ type: 'text', text: 'thinking' }] },
      { type: 'function_call', id: 'call_1', name: 'lookup', arguments: { id: 'a' } },
      { type: 'function_call', id: 'call_2', name: 'lookup', arguments: { id: 'b' } },
    ];
    await provider.complete(
      request({
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [
              { id: 'call_1', name: 'lookup', args: { id: 'a' } },
              { id: 'call_2', name: 'lookup', args: { id: 'b' } },
            ],
            native: { provider: 'gemini', model: MODEL, payload: received },
          },
          {
            role: 'tool',
            results: [
              { callId: 'call_1', name: 'lookup', content: 'call 1: found' },
              { callId: 'call_2', name: 'lookup', content: 'call 2 failed', isError: true },
            ],
            notice: 'no more tools',
          },
        ],
      }),
    );
    expect(sent()['input']).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'hello' }] },
      ...received, // same steps, same order, signature untouched
      {
        type: 'function_result',
        call_id: 'call_1',
        name: 'lookup',
        result: [{ type: 'text', text: 'call 1: found' }],
      },
      {
        type: 'function_result',
        call_id: 'call_2',
        name: 'lookup',
        result: [{ type: 'text', text: 'call 2 failed' }],
        is_error: true,
      },
      { type: 'user_input', content: [{ type: 'text', text: 'no more tools' }] },
    ]);
  });

  it('builds an assistant turn that has no native payload', async () => {
    await provider.complete(
      request({
        messages: [
          { role: 'user', content: 'a' },
          {
            role: 'assistant',
            text: 'let me look',
            toolCalls: [{ id: 't1', name: 'lookup', args: {} }],
          },
        ],
      }),
    );
    expect(sent()['input']).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'a' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'let me look' }] },
      { type: 'function_call', id: 't1', name: 'lookup', arguments: {} },
    ]);
  });

  it('refuses a turn that another provider or model produced, before sending anything', async () => {
    const foreign = (provider_: string, model: string) =>
      request({
        messages: [
          { role: 'user', content: 'a' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [],
            native: { provider: provider_, model, payload: [] },
          },
        ],
      });
    await expect(provider.complete(foreign('anthropic', MODEL))).rejects.toBeInstanceOf(
      NativeMismatchError,
    );
    await expect(provider.complete(foreign('gemini', 'gemini-other'))).rejects.toBeInstanceOf(
      NativeMismatchError,
    );
    expect(stub.requests).toHaveLength(0);
  });
});

describe('GeminiProvider response', () => {
  it('reads text, usage and the native steps, signature included', async () => {
    const result = await provider.complete(request());
    expect(result).toEqual({
      text: '{"answer":"x"}',
      toolCalls: [],
      usage: {
        inputTokens: 8,
        outputTokens: 5,
        thoughtTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
      },
      finishReason: 'stop',
      stopReason: 'completed',
      native: { provider: 'gemini', model: MODEL, payload: interaction().steps },
      requestId: 'int_1',
    });
  });

  it('reads function calls', async () => {
    stub.reply({
      json: interaction({
        status: 'requires_action',
        steps: [
          { type: 'thought', signature: 'SIG-2' },
          { type: 'function_call', id: 'call_9', name: 'lookup', arguments: { id: 'z' } },
        ],
      }),
    });
    const result = await provider.complete(request());
    expect(result.finishReason).toBe('tool_calls');
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([{ id: 'call_9', name: 'lookup', args: { id: 'z' } }]);
    expect(result.native?.payload).toHaveLength(2);
  });

  it('never returns the tool calls of a reply that was cut off', async () => {
    stub.reply({
      json: interaction({
        status: 'incomplete',
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: '{"answer":' }] },
          { type: 'function_call', id: 'call_9', name: 'lookup', arguments: {} },
        ],
      }),
    });
    const result = await provider.complete(request());
    expect(result.finishReason).toBe('length');
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe('{"answer":');
  });

  it('copes with usage the server leaves out', async () => {
    stub.reply({ json: interaction({ usage: undefined }) });
    const result = await provider.complete(request());
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it.each<[string, LlmErrorKind]>([
    ['safety', 'SAFETY_BLOCKED'],
    ['prohibited_content', 'SAFETY_BLOCKED'],
    ['malformed_function_call', 'MALFORMED'],
    ['unexpected_tool_call', 'MALFORMED'],
    ['missing_thought_signature', 'BAD_REQUEST'],
    ['quota_exceeded', 'QUOTA_EXHAUSTED'],
    ['something_new', 'SERVER'],
  ])('turns a failed interaction with code %s into %s', async (code, kind) => {
    stub.reply({
      json: interaction({ status: 'failed', steps: [], errors: [{ code, message: 'nope' }] }),
    });
    await expect(provider.complete(request())).rejects.toMatchObject({
      name: 'LlmError',
      kind,
      provider: 'gemini',
      model: MODEL,
      requestId: 'int_1',
    });
  });

  it('does not treat a step that reports an error as an answer', async () => {
    stub.reply({
      json: interaction({
        steps: [{ type: 'model_output', content: [], error: { code: 13, message: 'internal' } }],
      }),
    });
    await expect(provider.complete(request())).rejects.toMatchObject({ kind: 'MALFORMED' });
  });

  it('does not accept an interaction that is still running', async () => {
    stub.reply({ json: interaction({ status: 'in_progress' }) });
    await expect(provider.complete(request())).rejects.toMatchObject({ kind: 'SERVER' });
  });
});

describe('GeminiProvider errors', () => {
  const cases: [string, number, Record<string, string>, unknown, LlmErrorKind, number | null][] = [
    [
      'the daily quota',
      429,
      {},
      apiError('quota_exceeded', 'daily quota used'),
      'QUOTA_EXHAUSTED',
      null,
    ],
    [
      'a per-minute limit that says when to come back',
      429,
      { 'retry-after': '7' },
      apiError('rate_limit_exceeded', 'slow'),
      'RATE_LIMITED',
      7000,
    ],
    [
      'a per-minute limit that does not',
      429,
      {},
      apiError('rate_limit_exceeded', 'slow'),
      'RATE_LIMITED',
      null,
    ],
    ['too many requests', 429, {}, apiError('too_many_requests', 'slow'), 'RATE_LIMITED', null],
    [
      'a 429 with a code it does not know',
      429,
      {},
      apiError('brand_new', 'slow'),
      'RATE_LIMITED',
      null,
    ],
    [
      'an empty prepaid balance',
      402,
      {},
      apiError('payment_required', 'add credits'),
      'BILLING',
      null,
    ],
    [
      'billing being off',
      400,
      {},
      apiError('failed_precondition', 'Billing is disabled for this project'),
      'BILLING',
      null,
    ],
    [
      'another unmet precondition',
      400,
      {},
      apiError('failed_precondition', 'not ready'),
      'BAD_REQUEST',
      null,
    ],
    ['a malformed request', 400, {}, apiError('invalid_request', 'bad'), 'BAD_REQUEST', null],
    [
      'a lost thought signature',
      400,
      {},
      apiError('missing_thought_signature', 'resend it'),
      'BAD_REQUEST',
      null,
    ],
    ['an unknown model', 404, {}, apiError('model_not_found', 'nope'), 'BAD_REQUEST', null],
    ['a bad key', 401, {}, apiError('authentication', 'bad key'), 'AUTH', null],
    ['a forbidden key', 403, {}, apiError('permission_denied', 'no'), 'AUTH', null],
    ['a server error', 500, {}, apiError('api_error', 'oops'), 'SERVER', null],
    ['an overloaded service', 503, {}, apiError('service_unavailable', 'busy'), 'SERVER', null],
    ['a missed deadline', 504, {}, apiError('deadline_exceeded', 'slow'), 'TIMEOUT', null],
    ['an error with no JSON body', 500, {}, 'oops', 'SERVER', null],
    ['a 403 with no JSON body', 403, {}, 'denied', 'AUTH', null],
  ];

  it.each(cases)(
    'sees %s as one request and one %s',
    async (_label, status, headers, json, kind, wait) => {
      stub.reply({ status, headers, json });
      const error = await provider.complete(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({
        kind,
        provider: 'gemini',
        model: MODEL,
        status,
        retryAfterMs: wait,
      });
      expect((error as Error).message).toMatch(new RegExp(`^Gemini API error ${status}`));
      // the SDK retries 408, 409, 429 and 5xx by default; ours must not: the router decides
      expect(stub.requests).toHaveLength(1);
    },
  );

  it('turns the caller aborting into LlmAbortedError, not a provider failure', async () => {
    stub.hang();
    const controller = new AbortController();
    const pending = provider.complete(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toBeInstanceOf(LlmAbortedError);
  });

  it('sees an unreachable server as SERVER', async () => {
    const lonely = GeminiProvider.fromApiKey('k', { baseUrl: 'http://127.0.0.1:1' });
    await expect(lonely.complete(request())).rejects.toMatchObject({ kind: 'SERVER' });
  });
});
