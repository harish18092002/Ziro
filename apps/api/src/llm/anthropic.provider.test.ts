import { LlmError, type LlmErrorKind } from '@ziro/core/llm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from './anthropic.provider.js';
import { LlmAbortedError, type LlmRequest, NativeMismatchError } from './provider.js';
import { type StubServer, startStub } from './stub-server.fixtures.js';

const MODEL = 'claude-haiku-5-5';

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
  signal: new AbortController().signal,
  ...over,
});

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [{ type: 'text', text: '{"answer":"x"}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 2,
  },
  ...over,
});

const apiError = (type: string, text: string) => ({
  type: 'error',
  error: { type, message: text },
});

let stub: StubServer;
let provider: AnthropicProvider;

beforeAll(async () => {
  stub = await startStub();
  provider = AnthropicProvider.fromApiKey('test-key', { baseURL: stub.url });
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.requests.length = 0;
  stub.reply({ json: message() });
});

const sent = (): Record<string, unknown> => stub.requests[0]?.body as Record<string, unknown>;

describe('AnthropicProvider request', () => {
  it('sends a cached system prompt, strict tools and the JSON-schema output format', async () => {
    await provider.complete(request());
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.url).toBe('/v1/messages');
    expect(stub.requests[0]?.headers['authorization']).toBe('Bearer test-key');
    expect(sent()).toMatchObject({
      model: MODEL,
      max_tokens: 1234,
      system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hello' }],
      tools: [
        {
          name: 'lookup',
          description: 'finds a thing',
          strict: true,
          input_schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'object', required: ['answer'], additionalProperties: false },
        },
      },
    });
  });

  it('maps the effort and leaves out what it was not given', async () => {
    await provider.complete(request({ effort: 'minimal', tools: [], output: undefined }));
    const body = sent();
    expect(body['output_config']).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('tools');
    stub.requests.length = 0;
    await provider.complete(request({ effort: 'high', tools: [], output: undefined }));
    expect(sent()['output_config']).toEqual({ effort: 'high' });
    stub.requests.length = 0;
    await provider.complete(request({ tools: [], output: undefined }));
    expect(sent()).not.toHaveProperty('output_config');
  });

  it('gives an earlier assistant turn back exactly as received, thinking block included', async () => {
    const payload = [
      { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 'a' } },
    ];
    await provider.complete(
      request({
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            text: '',
            toolCalls: [{ id: 'toolu_1', name: 'lookup', args: { id: 'a' } }],
            native: { provider: 'anthropic', model: MODEL, payload },
          },
          {
            role: 'tool',
            results: [
              { callId: 'toolu_1', name: 'lookup', content: 'call 1: found' },
              { callId: 'toolu_2', name: 'lookup', content: 'call 2 failed', isError: true },
            ],
            notice: 'no more tools',
          },
        ],
      }),
    );
    expect(sent()['messages']).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: payload },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'call 1: found' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'call 2 failed', is_error: true },
          { type: 'text', text: 'no more tools' },
        ],
      },
    ]);
  });

  it('builds an assistant turn that has no native payload, and never sends an empty one', async () => {
    await provider.complete(
      request({
        messages: [
          { role: 'user', content: 'a' },
          {
            role: 'assistant',
            text: 'let me look',
            toolCalls: [{ id: 't1', name: 'lookup', args: {} }],
          },
          { role: 'user', content: 'b' },
          { role: 'assistant', text: '', toolCalls: [] },
          { role: 'user', content: 'c' },
        ],
      }),
    );
    expect((sent()['messages'] as unknown[]).slice(1, 4)).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me look' },
          { type: 'tool_use', id: 't1', name: 'lookup', input: {} },
        ],
      },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: [{ type: 'text', text: '(empty reply)' }] },
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
    await expect(provider.complete(foreign('gemini', MODEL))).rejects.toBeInstanceOf(
      NativeMismatchError,
    );
    await expect(
      provider.complete(foreign('anthropic', 'claude-sonnet-5-5')),
    ).rejects.toBeInstanceOf(NativeMismatchError);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('AnthropicProvider response', () => {
  it('reads text, usage, the request id and the native payload', async () => {
    stub.reply({ headers: { 'request-id': 'req_42' }, json: message() });
    const result = await provider.complete(request());
    expect(result).toEqual({
      text: '{"answer":"x"}',
      toolCalls: [],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        thoughtTokens: 0,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
      },
      finishReason: 'stop',
      stopReason: 'end_turn',
      native: {
        provider: 'anthropic',
        model: MODEL,
        payload: [{ type: 'text', text: '{"answer":"x"}' }],
      },
      requestId: 'req_42',
    });
  });

  it('reads tool calls', async () => {
    stub.reply({
      json: message({
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'x', signature: 's' },
          { type: 'tool_use', id: 'toolu_9', name: 'lookup', input: { id: 'z' } },
        ],
      }),
    });
    const result = await provider.complete(request());
    expect(result.finishReason).toBe('tool_calls');
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([{ id: 'toolu_9', name: 'lookup', args: { id: 'z' } }]);
    expect((result.native?.payload as unknown[]).length).toBe(2);
  });

  it('never returns the tool calls of a reply that was cut off', async () => {
    stub.reply({
      json: message({
        stop_reason: 'max_tokens',
        content: [
          { type: 'text', text: '{"answer":' },
          { type: 'tool_use', id: 'toolu_9', name: 'lookup', input: {} },
        ],
      }),
    });
    const result = await provider.complete(request());
    expect(result.finishReason).toBe('length');
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe('{"answer":');
  });

  it.each([
    ['refusal', 'refusal'],
    ['pause_turn', 'pause'],
    ['model_context_window_exceeded', 'context'],
    ['stop_sequence', 'stop'],
  ])('maps the stop reason %s to %s and keeps the original word', async (stop, finish) => {
    stub.reply({ json: message({ stop_reason: stop }) });
    const result = await provider.complete(request());
    expect(result.finishReason).toBe(finish);
    expect(result.stopReason).toBe(stop);
  });
});

describe('AnthropicProvider errors', () => {
  const cases: [string, number, Record<string, string>, unknown, LlmErrorKind, number | null][] = [
    ['a bad key', 401, {}, apiError('authentication_error', 'invalid x-api-key'), 'AUTH', null],
    ['a forbidden key', 403, {}, apiError('permission_error', 'no access'), 'AUTH', null],
    ['an empty balance', 402, {}, apiError('billing_error', 'billing problem'), 'BILLING', null],
    [
      'a spent credit balance reported as a 400',
      400,
      {},
      apiError(
        'invalid_request_error',
        'Your credit balance is too low to access the Anthropic API.',
      ),
      'BILLING',
      null,
    ],
    [
      'a workspace spend limit reported as a 400',
      400,
      {},
      apiError(
        'invalid_request_error',
        'You have reached your specified workspace API usage limits.',
      ),
      'BILLING',
      null,
    ],
    [
      'any other refused request',
      400,
      {},
      apiError('invalid_request_error', 'messages: bad'),
      'BAD_REQUEST',
      null,
    ],
    ['an unknown model', 404, {}, apiError('not_found_error', 'model: nope'), 'BAD_REQUEST', null],
    [
      'a 429 that says when to come back',
      429,
      { 'retry-after': '7' },
      apiError('rate_limit_error', 'slow down'),
      'RATE_LIMITED',
      7000,
    ],
    [
      'a 429 that does not (a spend cap)',
      429,
      {},
      apiError('rate_limit_error', 'cap'),
      'QUOTA_EXHAUSTED',
      null,
    ],
    ['a server error', 500, {}, apiError('api_error', 'oops'), 'SERVER', null],
    ['overload', 529, {}, apiError('overloaded_error', 'busy'), 'SERVER', null],
    ['a gateway timeout', 504, {}, apiError('timeout_error', 'slow'), 'TIMEOUT', null],
  ];

  it.each(cases)(
    'sees %s as one request and one %s',
    async (_label, status, headers, json, kind, wait) => {
      stub.reply({ status, headers: { 'request-id': 'req_err', ...headers }, json });
      const error = await provider.complete(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LlmError);
      expect(error).toMatchObject({
        kind,
        provider: 'anthropic',
        model: MODEL,
        status,
        requestId: 'req_err',
        retryAfterMs: wait,
      });
      expect((error as Error).message).toMatch(new RegExp(`^Anthropic API error ${status}: `));
      // the SDK's own retries are off: the router decides whether to ask again
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
    const lonely = AnthropicProvider.fromApiKey('k', { baseURL: 'http://127.0.0.1:1' });
    await expect(lonely.complete(request())).rejects.toMatchObject({ kind: 'SERVER' });
  });
});
