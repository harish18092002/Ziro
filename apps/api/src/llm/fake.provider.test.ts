import { LlmError } from '@ziro/core/llm';
import { describe, expect, it } from 'vitest';
import { FakeProvider, fakeResult } from './fake.provider.js';
import { LlmAbortedError, type LlmRequest } from './provider.js';

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  model: 'm',
  system: 's',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  maxOutputTokens: 10,
  signal: new AbortController().signal,
  ...over,
});

describe('FakeProvider', () => {
  it('answers from its script in order and records every request', async () => {
    const fake = new FakeProvider('fake', [
      fakeResult({ text: 'one' }),
      fakeResult({ text: 'two' }),
    ]);
    expect((await fake.complete(request())).text).toBe('one');
    expect((await fake.complete(request({ model: 'm2' }))).text).toBe('two');
    expect(fake.requests.map((r) => r.model)).toEqual(['m', 'm2']);
  });

  it('throws a scripted failure', async () => {
    const failure = new LlmError('SERVER', 'down', { provider: 'fake', model: 'm' });
    const fake = new FakeProvider('fake', [failure]);
    await expect(fake.complete(request())).rejects.toBe(failure);
  });

  it('lets a step decide from the request and the call number', async () => {
    const fake = new FakeProvider('fake', [
      (req, call) => fakeResult({ text: `${req.model}#${call}` }),
    ]);
    expect((await fake.complete(request({ model: 'x' }))).text).toBe('x#1');
  });

  it('fails loudly when the script runs out, rather than inventing an answer', async () => {
    const fake = new FakeProvider('fake', []);
    await expect(fake.complete(request())).rejects.toThrow(/no scripted answer for call 1/);
  });

  it('honours an already-aborted signal like a real provider', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeProvider('fake', [fakeResult()]);
    await expect(fake.complete(request({ signal: controller.signal }))).rejects.toBeInstanceOf(
      LlmAbortedError,
    );
  });

  it('builds a plain finished reply by default', () => {
    expect(fakeResult()).toMatchObject({ text: '', toolCalls: [], finishReason: 'stop' });
  });
});
