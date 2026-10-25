// Test support: models that say exactly what a test scripts, behind the real router, so harness tests
// exercise the same path production does (limits, fallback, recording) with nothing real on the other end.
import { randomUUID } from 'node:crypto';
import type { LlmResult, LlmToolCall, LlmUsage } from '@ziro/core/llm';
import { Breakers } from '../llm/breakers.js';
import { LlmCache } from '../llm/cache.js';
import { type ChainEntry, parseChain, parsePrices } from '../llm/config.js';
import { FakeProvider, type FakeStep, fakeResult } from '../llm/fake.provider.js';
import { MemoryLimiter } from '../llm/limiter.js';
import { type Attempt, LlmRouter } from '../llm/router.js';
import type { ModelResult } from './output.js';
import type { Toolbox } from './tools/toolbox.js';
import type { InvestigationContext } from './types.js';

export { FakeProvider, type FakeStep };

export const USAGE: LlmUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  thoughtTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export const toolCall = (id: string, name: string, args: unknown): LlmToolCall => ({
  id,
  name,
  args,
});

/** A turn that asks for tools. */
export function asksFor(calls: LlmToolCall[], over: Partial<LlmResult> = {}): LlmResult {
  return fakeResult({
    toolCalls: calls,
    finishReason: 'tool_calls',
    stopReason: 'tool_use',
    usage: USAGE,
    requestId: `req_${randomUUID().slice(0, 8)}`,
    ...over,
  });
}

/** A turn that ends with this text. */
export function says(text: string, over: Partial<LlmResult> = {}): LlmResult {
  return fakeResult({
    text,
    usage: USAGE,
    stopReason: 'end_turn',
    requestId: `req_${randomUUID().slice(0, 8)}`,
    ...over,
  });
}

export const replyWith = (
  results: readonly Partial<ModelResult>[],
  over: Partial<LlmResult> = {},
): LlmResult => says(JSON.stringify({ results }), over);

/** A well-formed result that cites call 0; tests override what they care about. */
export function result(exceptionId: string, over: Partial<ModelResult> = {}): ModelResult {
  return {
    exceptionId,
    verdict: 'EXPLAINED_NO_MATCH',
    reasonCode: 'DUPLICATE_PAYMENT',
    links: [],
    explanation: 'Two captured payments share one order.',
    evidence: [{ call: 0, keyFinding: 'The rules found two candidate payments.' }],
    confidence: 0.9,
    suggestedAction: 'REFUND_CUSTOMER',
    draftJournalEntry: null,
    ...over,
  };
}

export interface ScriptedRouter {
  readonly router: LlmRouter;
  readonly breakers: Breakers;
  /** The fake provider behind each chain entry, by `provider:model`. */
  readonly providers: Record<string, FakeProvider>;
  /** The provider behind the first entry, for the common one-model test. */
  readonly first: FakeProvider;
  /** Requests received by the first entry. */
  readonly calls: () => number;
}

/**
 * A router over scripted models. `chain` is `[['gemini:a', steps], ['anthropic:b', steps]]`, tried in
 * order. Limits and prices are off and no wait is real, so a test never sleeps.
 */
export function scriptedRouter(
  chain: readonly (readonly [string, readonly FakeStep[]])[],
  options: {
    now?: () => number;
    cache?: LlmCache;
    /** LLM_PRICES as text. */
    prices?: string;
    tier?: 'free' | 'paid';
  } = {},
): ScriptedRouter {
  const providers: Record<string, FakeProvider> = {};
  const slots = chain.map(([id, script]) => {
    const parsed = parseChain(id);
    const entry: ChainEntry | undefined = parsed.ok ? parsed.value[0] : undefined;
    if (entry === undefined) throw new Error(`bad chain id in a test: ${id}`);
    const provider = new FakeProvider(entry.provider, script);
    providers[entry.id] = provider;
    return { entry, provider };
  });
  const parsedPrices = parsePrices(options.prices);
  if (!parsedPrices.ok) throw new Error('bad prices in a test');
  const prices = parsedPrices.value;
  const breakers = new Breakers(options.now === undefined ? {} : { now: options.now });
  const router = new LlmRouter({
    slots,
    breakers,
    limiter: new MemoryLimiter(options.now),
    cache: options.cache ?? LlmCache.off(),
    limits: {},
    prices,
    geminiTier: options.tier ?? 'free',
    maxWaitMs: 30_000,
    ...(options.now === undefined ? {} : { now: options.now }),
    sleep: () => Promise.resolve(),
  });
  const first = Object.values(providers)[0];
  if (first === undefined) throw new Error('a test router needs at least one model');
  return { router, breakers, providers, first, calls: () => first.requests.length };
}

export interface TestContext extends InvestigationContext {
  readonly recorded: Attempt[];
  gateCalls: number;
}

/** An investigation context that keeps llm calls in memory instead of the database. */
export function testContext(
  toolbox: Toolbox,
  runId: string,
  gate: () => Promise<void> = () => Promise.resolve(),
): TestContext {
  const recorded: Attempt[] = [];
  const ctx: TestContext = {
    runId,
    toolbox,
    recorded,
    gateCalls: 0,
    gate() {
      ctx.gateCalls += 1;
      return gate();
    },
    recordLlmCall(attempt) {
      recorded.push(attempt);
      return Promise.resolve(`call-${recorded.length}`);
    },
  };
  return ctx;
}
