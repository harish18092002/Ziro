// Builds the router from the environment. Nothing here can stop the app from starting: a model that cannot
// be used (no key, no price where one is needed) is DROPPED with a reason, and the agent runs on what is
// left. With nothing left there is no router, and the agent is off while the rules, the review console and
// the replay keep working.
//
// A model is dropped, not tried and failed, because trying costs a request and a wait to learn what the
// configuration already says:
//   - no key for its provider (GEMINI_API_KEY, ANTHROPIC_API_KEY), unless LLM_CACHE=replay, where no
//     request is ever made and no key is needed;
//   - no price in LLM_PRICES where spend would otherwise be uncounted: any Anthropic model, and Gemini
//     when GEMINI_TIER=paid. On the free tier a missing price only means the estimate column says n/a.
import type { Env } from '../config/env.js';
import { Breakers } from './breakers.js';
import { LlmCache, type LlmCacheStore, MemoryCacheStore } from './cache.js';
import type { ChainEntry, ProviderName } from './config.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { type RequestLimiter, MemoryLimiter } from './limiter.js';
import type { LlmProvider } from './provider.js';
import { type ChainSlot, LlmRouter } from './router.js';

export type LlmSettings = Pick<
  Env,
  | 'GEMINI_API_KEY'
  | 'ANTHROPIC_API_KEY'
  | 'GEMINI_TIER'
  | 'LLM_CHAIN'
  | 'GEMINI_LIMITS'
  | 'LLM_PRICES'
  | 'LLM_CACHE'
  | 'LLM_MAX_WAIT_SECONDS'
>;

export interface BuildDeps {
  /** Shared across processes in production (Redis); in memory for evals and tests. */
  readonly limiter?: RequestLimiter;
  readonly cacheStore?: LlmCacheStore;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly warn?: (message: string) => void;
  /** Replaces the real clients; for tests. */
  readonly providers?: Partial<Record<ProviderName, LlmProvider>>;
}

export interface Dropped {
  readonly id: string;
  readonly why: string;
}

export interface BuiltRouter {
  /** Null when no model in the chain can be used. */
  readonly router: LlmRouter | null;
  readonly dropped: readonly Dropped[];
  /** Everything worth telling the operator at boot, dropped models included. */
  readonly warnings: readonly string[];
}

const KEY_NAME: Record<ProviderName, string> = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** A provider that is never called: with LLM_CACHE=replay every answer comes from the record. */
function replayOnly(name: ProviderName): LlmProvider {
  return {
    name,
    complete: () =>
      Promise.reject(
        new Error(`LLM_CACHE=replay reached the ${name} provider; it must never be called`),
      ),
  };
}

export function buildRouter(env: LlmSettings, deps: BuildDeps = {}): BuiltRouter {
  const warnings: string[] = [];
  const dropped: Dropped[] = [];
  const drop = (entry: ChainEntry, why: string): void => {
    dropped.push({ id: entry.id, why });
    warnings.push(`${entry.id} is not used: ${why}`);
  };

  if (env.LLM_CHAIN.length === 0) {
    warnings.push('LLM_CHAIN is empty: the agent is off (rules, review and replay still work)');
    return { router: null, dropped, warnings };
  }

  const replay = env.LLM_CACHE === 'replay';
  const keys: Record<ProviderName, string | undefined> = {
    gemini: env.GEMINI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
  };
  const made = new Map<ProviderName, LlmProvider>();
  const providerFor = (name: ProviderName): LlmProvider => {
    const existing = made.get(name);
    if (existing !== undefined) return existing;
    const injected = deps.providers?.[name];
    const key = keys[name];
    const provider =
      injected ??
      (key === undefined || key === ''
        ? replayOnly(name)
        : name === 'gemini'
          ? GeminiProvider.fromApiKey(key)
          : AnthropicProvider.fromApiKey(key));
    made.set(name, provider);
    return provider;
  };

  const slots: ChainSlot[] = [];
  for (const entry of env.LLM_CHAIN) {
    const hasKey =
      (keys[entry.provider] ?? '') !== '' || deps.providers?.[entry.provider] !== undefined;
    if (!hasKey && !replay) {
      drop(entry, `${KEY_NAME[entry.provider]} is not set`);
      continue;
    }
    const mustBePriced = entry.provider === 'anthropic' || env.GEMINI_TIER === 'paid';
    if (mustBePriced && env.LLM_PRICES[entry.id] === undefined && !replay) {
      drop(
        entry,
        `it costs money and LLM_PRICES has no price for ${entry.id}, so its spend could not be counted`,
      );
      continue;
    }
    if (
      entry.provider === 'gemini' &&
      env.GEMINI_TIER === 'free' &&
      env.GEMINI_LIMITS[entry.model] === undefined
    ) {
      warnings.push(
        `no request limits for ${entry.id} in GEMINI_LIMITS: relying on the server's own 429 and quota answers`,
      );
    }
    slots.push({ entry, provider: providerFor(entry.provider) });
  }

  if (slots.length === 0) {
    warnings.push(
      'no model in LLM_CHAIN can be used: the agent is off (rules, review and replay still work)',
    );
    return { router: null, dropped, warnings };
  }

  const router = new LlmRouter({
    slots,
    breakers: new Breakers(deps.now === undefined ? {} : { now: deps.now }),
    limiter: deps.limiter ?? new MemoryLimiter(deps.now),
    cache: new LlmCache(env.LLM_CACHE, deps.cacheStore ?? new MemoryCacheStore()),
    limits: env.GEMINI_LIMITS,
    prices: env.LLM_PRICES,
    geminiTier: env.GEMINI_TIER,
    maxWaitMs: env.LLM_MAX_WAIT_SECONDS * 1000,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.warn === undefined ? {} : { warn: deps.warn }),
  });
  return { router, dropped, warnings };
}
