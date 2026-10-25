import { LlmError, type LlmErrorKind, type LlmResult } from '@ziro/core/llm';
import { describe, expect, it } from 'vitest';
import { Breakers } from './breakers.js';
import { CacheMissError, LlmCache, MemoryCacheStore } from './cache.js';
import { type ChainEntry, type ModelLimits, parsePrices } from './config.js';
import { FakeProvider, type FakeStep, fakeResult } from './fake.provider.js';
import { MemoryLimiter, type RequestLimiter } from './limiter.js';
import { LlmAbortedError } from './provider.js';
import {
  type Attempt,
  type CallMeta,
  ChainExhausted,
  type LlmSession,
  type Routed,
  LlmRouter,
  type SessionRequest,
} from './router.js';

const META: CallMeta = { harness: 'single-shot', exceptionId: null, promptHash: 'h'.repeat(64) };
const entry = (provider: 'gemini' | 'anthropic', model: string): ChainEntry => ({
  provider,
  model,
  id: `${provider}:${model}`,
});
const G1 = entry('gemini', 'g1');
const G2 = entry('gemini', 'g2');
const C1 = entry('anthropic', 'c1');

const err = (kind: LlmErrorKind, over: { retryAfterMs?: number } = {}): LlmError =>
  new LlmError(kind, `${kind} from the provider`, { provider: 'x', model: 'y', ...over });

const request = (signal: AbortSignal = new AbortController().signal): SessionRequest => ({
  system: 'sys',
  messages: [{ role: 'user', content: 'go' }],
  tools: [],
  maxOutputTokens: 100,
  signal,
});

interface Rig {
  readonly router: LlmRouter;
  readonly route: <T>(
    fn: (session: LlmSession) => Promise<T>,
    options?: { from?: number },
  ) => Promise<Routed<T>>;
  readonly attempts: Attempt[];
  readonly sleeps: number[];
  readonly breakers: Breakers;
  readonly clock: { now: number };
  readonly providers: Record<string, FakeProvider>;
}

function rig(
  chain: readonly [ChainEntry, FakeStep[]][],
  over: {
    maxWaitMs?: number;
    limits?: Record<string, ModelLimits>;
    limiter?: RequestLimiter;
    cache?: LlmCache;
    tier?: 'free' | 'paid';
    prices?: string;
  } = {},
): Rig {
  const clock = { now: Date.parse('2026-07-01T12:00:00Z') };
  const attempts: Attempt[] = [];
  const sleeps: number[] = [];
  const breakers = new Breakers({ now: () => clock.now });
  const providers: Record<string, FakeProvider> = {};
  const slots = chain.map(([e, script]) => {
    const provider = new FakeProvider(e.provider, script);
    providers[e.id] = provider;
    return { entry: e, provider: provider };
  });
  const prices = parsePrices(over.prices);
  if (!prices.ok) throw new Error('bad prices in the test');
  const router = new LlmRouter({
    slots,
    breakers,
    limiter: over.limiter ?? new MemoryLimiter(() => clock.now),
    cache: over.cache ?? LlmCache.off(),
    limits: over.limits ?? {},
    prices: prices.value,
    geminiTier: over.tier ?? 'free',
    maxWaitMs: over.maxWaitMs ?? 30_000,
    now: () => clock.now,
    sleep: (ms, signal) => {
      if (signal.aborted) return Promise.reject(new LlmAbortedError());
      sleeps.push(ms);
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const record = (a: Attempt): Promise<string | null> => {
    attempts.push(a);
    return Promise.resolve(`call-${attempts.length}`);
  };
  return {
    router,
    route: (fn, options) => router.route(fn, { record, ...options }),
    attempts,
    sleeps,
    breakers,
    clock,
    providers,
  };
}

const once = (s: LlmSession) => s.complete(request(), META);

describe('LlmRouter: one model', () => {
  it('answers from the first model and records the attempt', async () => {
    const r = rig([[G1, [fakeResult({ text: 'hi' })]]]);
    const routed = await r.route(async (s) => (await once(s)).result.text);
    expect(routed).toMatchObject({ value: 'hi', index: 0, fellBackFrom: [] });
    expect(routed.entry.id).toBe('gemini:g1');
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({
      provider: 'gemini',
      model: 'g1',
      outcome: 'ok',
      errorKind: null,
      cached: false,
    });
  });

  it('waits out a 429 that carries a retry hint, then retries the same model', async () => {
    const r = rig([
      [G1, [err('RATE_LIMITED', { retryAfterMs: 2000 }), fakeResult({ text: 'ok' })]],
    ]);
    const out = await r.route(async (s) => (await once(s)).result.text);
    expect(out.value).toBe('ok');
    expect(r.sleeps).toEqual([2000]);
    expect(r.providers['gemini:g1']?.requests).toHaveLength(2);
    expect(r.attempts.map((a) => a.outcome)).toEqual(['RATE_LIMITED', 'ok']);
    expect(out.fellBackFrom).toEqual([]);
  });

  it('gives a 429 with no hint a short growing wait, and stops after three retries', async () => {
    const r = rig([
      [G1, [err('RATE_LIMITED'), err('RATE_LIMITED'), err('RATE_LIMITED'), err('RATE_LIMITED')]],
      [G2, [fakeResult({ text: 'second' })]],
    ]);
    const out = await r.route(async (s) => (await once(s)).result.text);
    expect(out.value).toBe('second');
    expect(r.sleeps).toEqual([5000, 10000, 15000]);
    expect(r.providers['gemini:g1']?.requests).toHaveLength(4);
  });

  it('does not wait past the maximum: it moves to the next model and cools the first', async () => {
    const r = rig(
      [
        [G1, [err('RATE_LIMITED', { retryAfterMs: 120_000 })]],
        [G2, [fakeResult({ text: 'second' }), fakeResult({ text: 'third' })]],
      ],
      { maxWaitMs: 30_000 },
    );
    const out = await r.route(async (s) => (await once(s)).result.text);
    expect(out.value).toBe('second');
    expect(r.sleeps).toEqual([]);
    expect(out.fellBackFrom).toEqual([{ model: 'gemini:g1', kind: 'RATE_LIMITED' }]);
    expect(r.attempts.map((a) => a.outcome)).toEqual(['fell_back', 'ok']);
    expect(r.attempts[0]?.errorKind).toBe('RATE_LIMITED');
    // the next investigation does not retry g1 while it is cooling
    await r.route(async (s) => (await once(s)).result.text);
    expect(r.providers['gemini:g1']?.requests).toHaveLength(1);
  });

  it('counts every attempt a failed request made, also the ones that did not fall back', async () => {
    const r = rig([[G1, [err('BAD_REQUEST')]]]);
    await expect(r.route(once)).rejects.toMatchObject({ kind: 'BAD_REQUEST' });
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0]).toMatchObject({ outcome: 'BAD_REQUEST', errorKind: 'BAD_REQUEST' });
  });
});

describe('LlmRouter: fallback', () => {
  it('QUOTA_EXHAUSTED goes to the next model and the exhausted one is skipped afterwards', async () => {
    const r = rig([
      [G1, [err('QUOTA_EXHAUSTED')]],
      [G2, [fakeResult({ text: 'a' }), fakeResult({ text: 'b' })]],
    ]);
    expect((await r.route(async (s) => (await once(s)).result.text)).value).toBe('a');
    expect((await r.route(async (s) => (await once(s)).result.text)).value).toBe('b');
    expect(r.providers['gemini:g1']?.requests).toHaveLength(1);
    expect(r.breakers.state(G1).state).toBe('quota_exhausted');
  });

  it('a skipped model comes back at Pacific midnight', async () => {
    const r = rig([
      [G1, [err('QUOTA_EXHAUSTED'), fakeResult({ text: 'back' })]],
      [G2, [fakeResult({ text: 'other' })]],
    ]);
    await r.route(async (s) => (await once(s)).result.text);
    r.clock.now = Date.parse('2026-07-02T07:00:01Z');
    expect((await r.route(async (s) => (await once(s)).result.text)).value).toBe('back');
  });

  it('BILLING disables the provider: its other models are skipped without a request', async () => {
    const r = rig([
      [G1, [err('BILLING')]],
      [G2, []],
      [C1, [fakeResult({ text: 'claude' })]],
    ]);
    const out = await r.route(async (s) => (await once(s)).result.text);
    expect(out).toMatchObject({ value: 'claude', index: 2 });
    expect(r.providers['gemini:g2']?.requests).toHaveLength(0);
    expect(r.breakers.state(G2).state).toBe('disabled');
    // for the life of the process
    r.clock.now += 365 * 86_400_000;
    expect(r.breakers.state(G1).state).toBe('disabled');
  });

  it.each(['TIMEOUT', 'SERVER', 'AUTH'] as const)('%s falls back too', async (kind) => {
    const r = rig([
      [G1, [err(kind)]],
      [C1, [fakeResult({ text: 'claude' })]],
    ]);
    expect((await r.route(async (s) => (await once(s)).result.text)).value).toBe('claude');
  });

  it.each(['BAD_REQUEST', 'MALFORMED', 'SAFETY_BLOCKED'] as const)(
    '%s does NOT fall back: another model would meet the same request',
    async (kind) => {
      const r = rig([
        [G1, [err(kind)]],
        [C1, [fakeResult({ text: 'never asked' })]],
      ]);
      await expect(r.route(once)).rejects.toMatchObject({ kind });
      expect(r.providers['anthropic:c1']?.requests).toHaveLength(0);
      expect(r.breakers.state(G1).state).toBe('ok');
    },
  );

  it('does not hide a bug: an error that is not an LlmError propagates untouched', async () => {
    const r = rig([
      [G1, [new TypeError('a bug')]],
      [G2, [fakeResult()]],
    ]);
    await expect(r.route(once)).rejects.toThrow('a bug');
    expect(r.providers['gemini:g2']?.requests).toHaveLength(0);
  });

  it('starts further down the chain when asked (an escalation)', async () => {
    const r = rig([
      [G1, []],
      [G2, [fakeResult({ text: 'second' })]],
    ]);
    const out = await r.route(async (s) => (await once(s)).result.text, { from: 1 });
    expect(out).toMatchObject({ value: 'second', index: 1 });
    expect(r.providers['gemini:g1']?.requests).toHaveLength(0);
  });
});

describe('LlmRouter: a failure in the middle of an investigation', () => {
  it('restarts on the next model with a fresh history: nothing from the first model is carried over', async () => {
    const tool = fakeResult({
      toolCalls: [{ id: 'call-1', name: 'get_thing', args: {} }],
      finishReason: 'tool_calls',
      native: { provider: 'gemini', model: 'g1', payload: ['signed thought'] },
    });
    const r = rig([
      [G1, [tool, err('SERVER')]],
      [C1, [fakeResult({ text: 'done' })]],
    ]);

    const histories: number[] = [];
    const routed = await r.route(async (s) => {
      const messages: SessionRequest['messages'][number][] = [{ role: 'user', content: 'go' }];
      for (;;) {
        histories.push(messages.length);
        const { result } = await s.complete({ ...request(), messages }, META);
        if (result.toolCalls.length === 0) return result.text;
        messages.push({
          role: 'assistant',
          text: result.text,
          toolCalls: result.toolCalls,
          ...(result.native === undefined ? {} : { native: result.native }),
        });
        messages.push({
          role: 'tool',
          results: result.toolCalls.map((c) => ({ callId: c.id, name: c.name, content: '{}' })),
        });
      }
    });

    expect(routed.value).toBe('done');
    expect(histories).toEqual([1, 3, 1]); // the restart began again at one message
    const claude = r.providers['anthropic:c1']?.requests ?? [];
    expect(claude).toHaveLength(1);
    expect(claude[0]?.messages).toEqual([{ role: 'user', content: 'go' }]);
    // the first model's spend is on record, and marked as the one that fell back
    expect(r.attempts.map((a) => [a.model, a.outcome])).toEqual([
      ['g1', 'ok'],
      ['g1', 'fell_back'],
      ['c1', 'ok'],
    ]);
  });
});

describe('LlmRouter: when nothing can answer', () => {
  it('throws ChainExhausted, flagged as a quota problem, after trying every model', async () => {
    const r = rig([
      [G1, [err('QUOTA_EXHAUSTED')]],
      [C1, [err('BILLING')]],
    ]);
    const error = await r.route(once).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainExhausted);
    expect((error as ChainExhausted).quota).toBe(true);
    expect((error as ChainExhausted).failures.map((f) => f.kind)).toEqual([
      'QUOTA_EXHAUSTED',
      'BILLING',
    ]);
  });

  it('answers at once, with no request and no wait, once every model is known to be out', async () => {
    const r = rig([
      [G1, [err('QUOTA_EXHAUSTED')]],
      [C1, [err('BILLING')]],
    ]);
    await r.route(once).catch(() => undefined);
    const before = r.attempts.length;
    const error = await r.route(once).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChainExhausted);
    expect((error as ChainExhausted).quota).toBe(true);
    expect(r.attempts).toHaveLength(before);
    expect(r.sleeps).toEqual([]);
  });

  it.each(['QUOTA_EXHAUSTED', 'BILLING', 'AUTH', 'RATE_LIMITED'] as const)(
    'counts %s alone as a quota problem, not an outage',
    async (kind) => {
      const r = rig([[G1, [err(kind, kind === 'RATE_LIMITED' ? { retryAfterMs: 999_999 } : {})]]]);
      const error = await r.route(once).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChainExhausted);
      expect((error as ChainExhausted).quota).toBe(true);
    },
  );

  it('still counts a provider switched off earlier as a quota problem when it is skipped', async () => {
    const r = rig([[G1, [err('BILLING')]]]);
    await r.route(once).catch(() => undefined);
    const again = await r.route(once).catch((e: unknown) => e);
    expect((again as ChainExhausted).failures.map((f) => f.kind)).toEqual(['skipped']);
    expect((again as ChainExhausted).quota).toBe(true);
  });

  it('is not a quota problem when the service is merely down', async () => {
    const r = rig([[G1, [err('SERVER')]]]);
    const error = await r.route(once).catch((e: unknown) => e);
    expect((error as ChainExhausted).quota).toBe(false);
  });

  it('an empty chain is exhausted from the start', async () => {
    const r = rig([]);
    await expect(r.route(once)).rejects.toBeInstanceOf(ChainExhausted);
    expect(r.router.usable).toBe(false);
  });
});

describe('LlmRouter: client-side limits', () => {
  it('stops at a configured daily limit without asking the provider, and falls back', async () => {
    const r = rig(
      [
        [G1, [fakeResult({ text: 'one' })]],
        [G2, [fakeResult({ text: 'two' })]],
      ],
      { limits: { g1: { rpm: 100, rpd: 1 } } },
    );
    expect((await r.route(async (s) => (await once(s)).result.text)).value).toBe('one');
    expect((await r.route(async (s) => (await once(s)).result.text)).value).toBe('two');
    expect(r.providers['gemini:g1']?.requests).toHaveLength(1);
    expect(r.breakers.state(G1).state).toBe('quota_exhausted');
  });

  it('waits for the per-minute window when the wait is short enough', async () => {
    const r = rig([[G1, [fakeResult({ text: 'a' }), fakeResult({ text: 'b' })]]], {
      limits: { g1: { rpm: 1, rpd: 100 } },
      maxWaitMs: 120_000,
    });
    const out = await r.route(async (s) => {
      await once(s);
      return (await once(s)).result.text;
    });
    expect(out.value).toBe('b');
    expect(r.sleeps).toEqual([60_000]);
  });

  it('falls back instead of waiting when the window would take longer than the maximum', async () => {
    const r = rig(
      [
        [G1, [fakeResult({ text: 'a' })]],
        // the investigation restarts on g2, so it asks twice there too
        [G2, [fakeResult({ text: 'first on g2' }), fakeResult({ text: 'from g2' })]],
      ],
      { limits: { g1: { rpm: 1, rpd: 100 } }, maxWaitMs: 30_000 },
    );
    const out = await r.route(async (s) => {
      await once(s);
      return (await once(s)).result.text;
    });
    expect(out.value).toBe('from g2');
    expect(r.sleeps).toEqual([]);
  });

  it('applies the free-tier limits to Gemini only', async () => {
    const r = rig([[C1, [fakeResult({ text: 'a' }), fakeResult({ text: 'b' })]]], {
      limits: { c1: { rpm: 1, rpd: 1 } },
    });
    const out = await r.route(async (s) => {
      await once(s);
      return (await once(s)).result.text;
    });
    expect(out.value).toBe('b');
  });

  it('carries on when the limiter itself is broken: the server’s own 429 still protects the key', async () => {
    const broken: RequestLimiter = {
      acquire: () => Promise.reject(new Error('redis is down')),
      usedToday: () => Promise.reject(new Error('redis is down')),
    };
    const r = rig([[G1, [fakeResult({ text: 'fine' })]]], { limiter: broken });
    expect((await r.route(async (s) => (await once(s)).result.text)).value).toBe('fine');
    expect((await r.router.status())[0]?.usedToday).toBe(0);
  });

  it('shows each model’s state and use for the status page', async () => {
    const r = rig(
      [
        [G1, [err('QUOTA_EXHAUSTED')]],
        [G2, [fakeResult()]],
      ],
      { limits: { g1: { rpm: 10, rpd: 50 }, g2: { rpm: 10, rpd: 25 } } },
    );
    await r.route(once);
    const status = await r.router.status();
    expect(status.map((s) => [s.id, s.state, s.usedToday, s.limitPerDay])).toEqual([
      ['gemini:g1', 'quota_exhausted', 1, 50],
      ['gemini:g2', 'ok', 1, 25],
    ]);
    expect(status[0]?.until).toBe('2026-07-02T07:00:00.000Z');
  });
});

describe('LlmRouter: the cache', () => {
  it('serves a recorded answer without a request, a count against the quota, or a wait', async () => {
    const store = new MemoryCacheStore();
    const first = rig([[G1, [fakeResult({ text: 'recorded' })]]], {
      cache: new LlmCache('record', store),
    });
    await first.route(once);

    const limiter = new MemoryLimiter();
    const second = rig([[G1, []]], { cache: new LlmCache('replay', store), limiter });
    const out = await second.route(async (s) => await once(s));
    expect(out.value.result.text).toBe('recorded');
    expect(out.value.cached).toBe(true);
    expect(second.providers['gemini:g1']?.requests).toHaveLength(0);
    expect(await limiter.usedToday('g1')).toBe(0);
    expect(second.attempts[0]).toMatchObject({ outcome: 'ok', cached: true, costMicroUsd: 0n });
  });

  it('fails loudly on a replay miss, as itself, never as a reason to try another model', async () => {
    const r = rig(
      [
        [G1, [fakeResult()]],
        [G2, [fakeResult()]],
      ],
      { cache: new LlmCache('replay', new MemoryCacheStore()) },
    );
    await expect(r.route(once)).rejects.toBeInstanceOf(CacheMissError);
    expect(r.providers['gemini:g1']?.requests).toHaveLength(0);
    expect(r.providers['gemini:g2']?.requests).toHaveLength(0);
  });
});

describe('LlmRouter: cost on record', () => {
  const usage: LlmResult['usage'] = {
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    thoughtTokens: 500_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const prices =
    '{"gemini:g1":{"input":"0.30","output":"2.50"},"anthropic:c1":{"input":"1","output":"5"}}';

  it('Gemini on the free tier costs nothing for real, and still gets an estimate at the paid price', async () => {
    const r = rig([[G1, [fakeResult({ usage })]]], { prices });
    await r.route(once);
    // 1M in * 0.30 + (0.5M out + 0.5M thinking) * 2.50
    expect(r.attempts[0]).toMatchObject({ costMicroUsd: 0n, estCostMicroUsd: 2_800_000n });
  });

  it('Gemini on the paid tier costs its estimate', async () => {
    const r = rig([[G1, [fakeResult({ usage })]]], { prices, tier: 'paid' });
    await r.route(once);
    expect(r.attempts[0]).toMatchObject({ costMicroUsd: 2_800_000n, estCostMicroUsd: 2_800_000n });
  });

  it('Claude costs its list price', async () => {
    const r = rig([[C1, [fakeResult({ usage })]]], { prices });
    await r.route(once);
    expect(r.attempts[0]).toMatchObject({ costMicroUsd: 6_000_000n });
  });

  it('has no estimate for a model with no price, and says so with null, not zero', async () => {
    const r = rig([[G1, [fakeResult({ usage })]]]);
    await r.route(once);
    expect(r.attempts[0]).toMatchObject({ costMicroUsd: 0n, estCostMicroUsd: null });
  });
});

describe('LlmRouter: a time budget that runs out', () => {
  it('stops waiting when the signal fires, and does not treat it as a provider failure', async () => {
    const controller = new AbortController();
    const r = rig([
      [G1, [err('RATE_LIMITED', { retryAfterMs: 5000 })]],
      [G2, [fakeResult()]],
    ]);
    controller.abort();
    await expect(
      r.route((s) => s.complete(request(controller.signal), META)),
    ).rejects.toBeInstanceOf(LlmAbortedError);
    expect(r.providers['gemini:g2']?.requests).toHaveLength(0);
  });
});
