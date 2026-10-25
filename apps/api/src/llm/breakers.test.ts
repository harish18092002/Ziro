import { LlmError, type LlmErrorKind } from '@ziro/core/llm';
import { describe, expect, it } from 'vitest';
import { Breakers } from './breakers.js';
import type { ChainEntry } from './config.js';

const entry = (provider: 'gemini' | 'anthropic', model: string): ChainEntry => ({
  provider,
  model,
  id: `${provider}:${model}`,
});
const A = entry('gemini', 'a');
const B = entry('gemini', 'b');
const C = entry('anthropic', 'c');

const fail = (kind: LlmErrorKind, retryAfterMs?: number): LlmError =>
  new LlmError(kind, `${kind} happened`, {
    provider: 'x',
    model: 'y',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

const clock = (start: string) => {
  const t = { now: Date.parse(start) };
  return { t, now: () => t.now };
};

describe('Breakers', () => {
  it('starts with everything usable', () => {
    const b = new Breakers();
    expect([A, B, C].map((e) => b.state(e).state)).toEqual(['ok', 'ok', 'ok']);
  });

  it.each(['BILLING', 'AUTH'] as const)(
    '%s switches the whole provider off for the process',
    (kind) => {
      const c = clock('2026-07-01T12:00:00Z');
      const b = new Breakers({ now: c.now });
      b.recordFailure(A, fail(kind));
      expect(b.state(A).state).toBe('disabled');
      expect(b.state(B).state).toBe('disabled'); // same provider, other model
      expect(b.state(C).state).toBe('ok'); // another provider is untouched
      c.t.now += 30 * 86_400_000;
      expect(b.state(A).state).toBe('disabled'); // no time limit
    },
  );

  it('QUOTA_EXHAUSTED on Gemini skips that model until Pacific midnight, then lets it back in', () => {
    const c = clock('2026-07-01T20:00:00Z'); // 13:00 PDT
    const b = new Breakers({ now: c.now });
    b.recordFailure(A, fail('QUOTA_EXHAUSTED'));
    expect(b.state(A)).toEqual({
      state: 'quota_exhausted',
      until: Date.parse('2026-07-02T07:00:00Z'),
    });
    expect(b.state(B).state).toBe('ok'); // another model of the same provider has its own quota
    c.t.now = Date.parse('2026-07-02T06:59:59Z');
    expect(b.state(A).state).toBe('quota_exhausted');
    c.t.now = Date.parse('2026-07-02T07:00:00Z');
    expect(b.state(A).state).toBe('ok');
  });

  it('treats a spent Anthropic tier like billing: it has no daily reset to wait for', () => {
    const b = new Breakers();
    b.recordFailure(C, fail('QUOTA_EXHAUSTED'));
    expect(b.state(C).state).toBe('disabled');
  });

  it('cools a model down for as long as the server asked after a long rate limit', () => {
    const c = clock('2026-07-01T12:00:00Z');
    const b = new Breakers({ now: c.now });
    b.recordFailure(A, fail('RATE_LIMITED', 90_000));
    expect(b.state(A).state).toBe('cooling');
    c.t.now += 89_999;
    expect(b.state(A).state).toBe('cooling');
    c.t.now += 1;
    expect(b.state(A).state).toBe('ok');
  });

  it('takes a model out after a run of timeouts or server errors, and lets one probe through later', () => {
    const c = clock('2026-07-01T12:00:00Z');
    const b = new Breakers({ now: c.now, outageThreshold: 3, cooldownMs: 600_000 });
    b.recordFailure(A, fail('TIMEOUT'));
    b.recordFailure(A, fail('SERVER'));
    expect(b.state(A).state).toBe('ok');
    b.recordFailure(A, fail('SERVER'));
    expect(b.state(A).state).toBe('cooling');
    c.t.now += 600_000;
    expect(b.state(A).state).toBe('ok'); // the probe
    b.recordFailure(A, fail('SERVER')); // fails again: straight back out
    expect(b.state(A).state).toBe('cooling');
  });

  it('a success resets the run of failures', () => {
    const b = new Breakers({ outageThreshold: 2 });
    b.recordFailure(A, fail('SERVER'));
    b.recordSuccess(A);
    b.recordFailure(A, fail('SERVER'));
    expect(b.state(A).state).toBe('ok');
  });

  it('does not react to failures that no other model could fix', () => {
    const b = new Breakers({ outageThreshold: 1 });
    for (const kind of ['BAD_REQUEST', 'MALFORMED', 'SAFETY_BLOCKED'] as const) {
      b.recordFailure(A, fail(kind));
    }
    expect(b.state(A).state).toBe('ok');
  });

  it('can be switched off at start-up for a missing key', () => {
    const b = new Breakers();
    b.disable('anthropic', 'no ANTHROPIC_API_KEY');
    expect(b.state(C)).toEqual({ state: 'disabled', why: 'no ANTHROPIC_API_KEY' });
  });
});
