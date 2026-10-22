import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicLlmClient, type AnthropicLike } from './anthropic-client.js';
import { LlmAbortedError, LlmError, type LlmRequest } from './llm.js';
import { OUTPUT_JSON_SCHEMA } from './output.js';

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: 'claude-haiku-5-5',
  system: 'SYSTEM',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [
    {
      name: 'get_fee_contract',
      description: 'fees',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      strict: true,
    },
  ],
  maxTokens: 1234,
  outputSchema: OUTPUT_JSON_SCHEMA,
  signal: new AbortController().signal,
  ...over,
});

const message = (over: Record<string, unknown> = {}) =>
  ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: '{"results":[]}' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 11,
      output_tokens: 22,
      cache_read_input_tokens: 33,
      cache_creation_input_tokens: 44,
    },
    ...over,
  }) as unknown as Anthropic.Message;

function fake(respond: () => Anthropic.Message | Error) {
  const seen: {
    body: Anthropic.MessageCreateParamsNonStreaming;
    options: { signal?: AbortSignal } | undefined;
  }[] = [];
  const sdk: AnthropicLike = {
    messages: {
      create(body, options) {
        seen.push({ body, options });
        const out = respond();
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
      },
    },
  };
  return { sdk, seen };
}

describe('AnthropicLlmClient: the request', () => {
  it('sends strict tools, a JSON-schema output format and a cached system prompt', async () => {
    const { sdk, seen } = fake(() => message());
    const signal = new AbortController().signal;
    await new AnthropicLlmClient(sdk).complete(request({ signal }));

    const { body, options } = seen[0]!;
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(1234);
    expect(body.system).toEqual([
      { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.tools).toEqual([
      {
        name: 'get_fee_contract',
        description: 'fees',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        strict: true,
      },
    ]);
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA },
    });
    expect(options?.signal).toBe(signal);
  });

  it('never sends a sampling parameter, a forced tool choice or a thinking budget', async () => {
    const { sdk, seen } = fake(() => message());
    await new AnthropicLlmClient(sdk).complete(request({ effort: 'high' }));
    const keys = Object.keys(seen[0]!.body);
    for (const forbidden of [
      'temperature',
      'top_p',
      'top_k',
      'tool_choice',
      'thinking',
      'stop_sequences',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('sends an effort only when one was asked for', async () => {
    const without = fake(() => message());
    await new AnthropicLlmClient(without.sdk).complete(request());
    expect(without.seen[0]!.body.output_config).not.toHaveProperty('effort');

    const withEffort = fake(() => message());
    await new AnthropicLlmClient(withEffort.sdk).complete(request({ effort: 'high' }));
    expect(withEffort.seen[0]!.body.output_config).toMatchObject({ effort: 'high' });
  });

  it('passes earlier assistant content back untouched', async () => {
    const thinking = { type: 'thinking', thinking: 'hmm', signature: 'sig' };
    const assistant = {
      role: 'assistant' as const,
      content: [
        thinking,
        { type: 'tool_use', id: 't1', name: 'get_fee_contract', input: { method: 'card' } },
      ],
    };
    const { sdk, seen } = fake(() => message());
    await new AnthropicLlmClient(sdk).complete(
      request({ messages: [{ role: 'user', content: 'x' }, assistant] }),
    );
    expect((seen[0]!.body.messages[1] as { content: unknown }).content).toBe(assistant.content);
  });
});

describe('AnthropicLlmClient: the response', () => {
  it('maps usage, stop reason, content and request id', async () => {
    const reply = message({
      _request_id: 'req_77',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }],
    });
    const out = await new AnthropicLlmClient(fake(() => reply).sdk).complete(request());
    expect(out.usage).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheWriteTokens: 44,
    });
    expect(out.stopReason).toBe('tool_use');
    expect(out.requestId).toBe('req_77');
    expect(out.content).toBe(reply.content);
  });

  it('treats absent cache counts as zero and an absent request id as null', async () => {
    const reply = message({
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
    });
    const out = await new AnthropicLlmClient(fake(() => reply).sdk).complete(request());
    expect(out.usage.cacheReadTokens).toBe(0);
    expect(out.usage.cacheWriteTokens).toBe(0);
    expect(out.requestId).toBeNull();
  });
});

describe('AnthropicLlmClient: errors', () => {
  const api = (status: number) =>
    Anthropic.APIError.generate(
      status,
      { type: 'error', error: { type: 'x', message: 'boom' } },
      'boom',
      new Headers({ 'request-id': 'req_9' }),
    );
  const run = (error: Error, req = request()) =>
    new AnthropicLlmClient(fake(() => error).sdk).complete(req);

  it.each([
    [429, true],
    [500, true],
    [529, true],
    [408, true],
    [400, false],
    [401, false],
    [403, false],
    [404, false],
  ])('status %i is retryable=%s', async (status, retryable) => {
    const error = await run(api(status)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ retryable, status, requestId: 'req_9' });
  });

  it('treats a connection failure as retryable', async () => {
    const error = await run(new Anthropic.APIConnectionError({ message: 'socket hang up' })).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ retryable: true, status: null });
  });

  it('maps an abort, by the SDK or by our signal, to LlmAbortedError', async () => {
    await expect(run(new Anthropic.APIUserAbortError())).rejects.toBeInstanceOf(LlmAbortedError);
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(new Error('whatever'), request({ signal: controller.signal })),
    ).rejects.toBeInstanceOf(LlmAbortedError);
  });

  it('passes an error that is not the API s through', async () => {
    await expect(run(new TypeError('bug'))).rejects.toBeInstanceOf(TypeError);
  });

  it('keeps the message short', async () => {
    const error = (await run(
      Anthropic.APIError.generate(500, undefined, 'x'.repeat(2_000), new Headers()),
    ).catch((e: unknown) => e)) as Error;
    expect(error.message.length).toBeLessThanOrEqual(300);
  });
});
