import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../config/env.js';
import { parseChain, parseLimits, parsePrices } from './config.js';

describe('parseChain', () => {
  it('reads provider:model entries in order', () => {
    const r = parseChain(' gemini:model-a , gemini:model-b,anthropic:model-c ');
    expect(r).toEqual({
      ok: true,
      value: [
        { provider: 'gemini', model: 'model-a', id: 'gemini:model-a' },
        { provider: 'gemini', model: 'model-b', id: 'gemini:model-b' },
        { provider: 'anthropic', model: 'model-c', id: 'anthropic:model-c' },
      ],
    });
  });

  it('treats blank as an empty chain', () => {
    expect(parseChain(undefined)).toEqual({ ok: true, value: [] });
    expect(parseChain('  ')).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['openai:gpt', 'provider'],
    ['gemini', 'provider:model'],
    ['gemini:', 'provider:model'],
    [':model', 'provider:model'],
    ['gemini:a,,gemini:b', 'empty'],
    ['gemini:a,', 'empty'],
    ['gemini:a,gemini:a', 'repeats'],
    ['gemini:bad id', 'characters'],
  ])('refuses %j', (raw, why) => {
    const r = parseChain(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(why);
      // a message never repeats what it was given
      expect(r.error).not.toContain('bad id');
    }
  });

  it('keeps a model id that itself contains a colon-free path or dots', () => {
    const r = parseChain('gemini:models/some-model.1');
    expect(r).toMatchObject({ ok: true, value: [{ model: 'models/some-model.1' }] });
  });
});

describe('parseLimits', () => {
  it('reads per-model limits and an optional tpm', () => {
    const r = parseLimits('{"m1":{"rpm":5,"rpd":20},"m2":{"rpm":10,"rpd":100,"tpm":250000}}');
    expect(r).toEqual({
      ok: true,
      value: { m1: { rpm: 5, rpd: 20 }, m2: { rpm: 10, rpd: 100, tpm: 250000 } },
    });
  });

  it('treats blank as no limits', () => {
    expect(parseLimits(undefined)).toEqual({ ok: true, value: {} });
  });

  it.each([
    ['{"m":{"rpm":5}}'],
    ['{"m":{"rpm":0,"rpd":5}}'],
    ['{"m":{"rpm":1.5,"rpd":5}}'],
    ['{"m":{"rpm":"5","rpd":5}}'],
    ['{"m":{"rpm":5,"rpd":5,"extra":1}}'],
    ['[1]'],
    ['not json'],
  ])('refuses %s without echoing it', (raw) => {
    const r = parseLimits(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain('extra');
  });
});

describe('parsePrices', () => {
  it('turns USD per million tokens into integer micro-USD', () => {
    const r = parsePrices(
      '{"gemini:m":{"input":"0.30","output":2.5},"anthropic:c":{"input":"1","output":"5","cacheRead":"0.1","cacheWrite":"1.25"}}',
    );
    expect(r).toEqual({
      ok: true,
      value: {
        'gemini:m': { input: 300_000n, output: 2_500_000n },
        'anthropic:c': {
          input: 1_000_000n,
          output: 5_000_000n,
          cacheRead: 100_000n,
          cacheWrite: 1_250_000n,
        },
      },
    });
  });

  it('accepts a price of zero and six decimals', () => {
    expect(parsePrices('{"gemini:m":{"input":"0","output":"0.000001"}}')).toMatchObject({
      ok: true,
      value: { 'gemini:m': { input: 0n, output: 1n } },
    });
  });

  it.each([
    ['{"gemini:m":{"input":"1e-7","output":"1"}}'],
    ['{"gemini:m":{"input":"-1","output":"1"}}'],
    ['{"gemini:m":{"input":"0.1234567","output":"1"}}'],
    ['{"gemini:m":{"input":"1"}}'],
    ['{"nonsense":{"input":"1","output":"1"}}'],
    ['{"openai:m":{"input":"1","output":"1"}}'],
    ['{"gemini:m":{"input":"1","output":"1","thinking":"2"}}'],
  ])('refuses %s', (raw) => {
    expect(parsePrices(raw).ok).toBe(false);
  });
});

describe('the model-layer settings in the environment', () => {
  const base = (): Record<string, string> => ({
    PORT: '3000',
    DATABASE_URL: 'postgres://ziro:ziro_dev@localhost:5432/ziro',
    REDIS_URL: 'redis://localhost:6379',
    RAZORPAY_SOURCE: 'synthetic',
    SYNTHETIC_DATA_DIR: 'data/demo',
    AGENT_HARNESS: 'loop',
    AUTO_ACCEPT_ENABLED: 'false',
    AUTO_ACCEPT_MAX_PAISE: '100000',
    DEMO_MODE: 'true',
    DAILY_LLM_BUDGET_USD: '5',
    AGENT_KILL_SWITCH: 'false',
  });

  it('boots with none of them set', () => {
    expect(loadEnv(base())).toMatchObject({
      GEMINI_TIER: 'free',
      LLM_CHAIN: [],
      GEMINI_LIMITS: {},
      LLM_PRICES: {},
      LLM_CACHE: 'off',
      LLM_MAX_TOOL_CALLS: 4,
      LLM_MAX_WAIT_SECONDS: 30,
    });
  });

  it('parses a full set', () => {
    const env = loadEnv({
      ...base(),
      GEMINI_API_KEY: 'k',
      GEMINI_TIER: 'paid',
      LLM_CHAIN: 'gemini:a,anthropic:b',
      GEMINI_LIMITS: '{"a":{"rpm":5,"rpd":20}}',
      LLM_PRICES: '{"gemini:a":{"input":"0.1","output":"0.4"}}',
      LLM_CACHE: 'replay',
      LLM_MAX_TOOL_CALLS: '6',
      LLM_MAX_WAIT_SECONDS: '0',
    });
    expect(env.LLM_CHAIN.map((e) => e.id)).toEqual(['gemini:a', 'anthropic:b']);
    expect(env.GEMINI_LIMITS['a']).toEqual({ rpm: 5, rpd: 20 });
    expect(env.LLM_PRICES['gemini:a']?.input).toBe(100_000n);
    expect(env).toMatchObject({
      GEMINI_API_KEY: 'k',
      GEMINI_TIER: 'paid',
      LLM_CACHE: 'replay',
      LLM_MAX_TOOL_CALLS: 6,
      LLM_MAX_WAIT_SECONDS: 0,
    });
  });

  it('lists every problem by variable name and never prints a value', () => {
    let issues: readonly string[] = [];
    try {
      loadEnv({
        ...base(),
        LLM_CHAIN: 'openai:secret-model',
        GEMINI_LIMITS: '{"a":{"rpm":0,"rpd":1}}',
        LLM_PRICES: 'not json',
        LLM_CACHE: 'sometimes',
        LLM_MAX_TOOL_CALLS: '99',
        GEMINI_TIER: 'gold',
      });
    } catch (err) {
      if (!(err instanceof EnvValidationError)) throw err;
      issues = err.issues;
    }
    for (const name of [
      'LLM_CHAIN',
      'GEMINI_LIMITS',
      'LLM_PRICES',
      'LLM_CACHE',
      'LLM_MAX_TOOL_CALLS',
      'GEMINI_TIER',
    ]) {
      expect(
        issues.filter((i) => i.startsWith(name)),
        name,
      ).toHaveLength(1);
    }
    expect(issues.join('\n')).not.toContain('secret-model');
  });

  it('does not fail the boot when the chain names a provider that has no key', () => {
    expect(() => loadEnv({ ...base(), LLM_CHAIN: 'gemini:a,anthropic:b' })).not.toThrow();
  });
});
