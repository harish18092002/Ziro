import { describe, expect, it } from 'vitest';
import { LLM_ERROR_KINDS, LlmError } from './index.js';

describe('LlmError', () => {
  it('carries its kind and where it came from', () => {
    const error = new LlmError('RATE_LIMITED', 'slow down', {
      provider: 'gemini',
      model: 'm1',
      status: 429,
      requestId: 'req_1',
      retryAfterMs: 7000,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('LlmError');
    expect(error.message).toBe('slow down');
    expect(error).toMatchObject({
      kind: 'RATE_LIMITED',
      provider: 'gemini',
      model: 'm1',
      status: 429,
      requestId: 'req_1',
      retryAfterMs: 7000,
    });
  });

  it('defaults what the provider did not say to null, not undefined', () => {
    const error = new LlmError('TIMEOUT', 'no answer', { provider: 'anthropic', model: 'm2' });
    expect(error.status).toBeNull();
    expect(error.requestId).toBeNull();
    expect(error.retryAfterMs).toBeNull();
  });

  it('has exactly the nine kinds the router decides on', () => {
    expect([...LLM_ERROR_KINDS]).toEqual([
      'RATE_LIMITED',
      'QUOTA_EXHAUSTED',
      'BILLING',
      'AUTH',
      'TIMEOUT',
      'SERVER',
      'BAD_REQUEST',
      'SAFETY_BLOCKED',
      'MALFORMED',
    ]);
  });
});
