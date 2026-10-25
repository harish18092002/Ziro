// The router: which model answers, and what happens when one cannot. It owns every wait, retry and
// fallback (the providers make exactly one attempt each, provider.ts), so it is also the one place that
// counts a request against the quota.
//
// An investigation runs inside `route(fn)`. `fn` is handed a SESSION bound to one model and must do the
// whole investigation with it, from its first message. If that model fails in a way the next model might not
// (quota, billing, a bad key, a timeout, a server error, a rate limit longer than we are willing to wait),
// the router discards the attempt and calls `fn` again with a session on the next model: a fresh history,
// never the half-finished one. A conversation therefore never mixes providers or models, which the Gemini
// thought signatures and the Anthropic thinking blocks both require (they are bound to the turn that made
// them).
//
// Not a reason to fall back, because another model would meet the same request: BAD_REQUEST, MALFORMED
// (the harness gets its one repair) and SAFETY_BLOCKED. Those propagate to the harness.
import { LlmError, type LlmResult } from '@ziro/core/llm';
import type { Breakers, SlotState } from './breakers.js';
import { type LlmCache, CacheMissError } from './cache.js';
import type { ChainEntry, ModelLimits, Rates } from './config.js';
import type { RequestLimiter } from './limiter.js';
import { type LlmProvider, type LlmRequest, LlmAbortedError } from './provider.js';
import { estimateCostMicroUsd } from './pricing.js';

/** Failures after which the next model in the chain is tried. */
export const FALLBACK_KINDS: ReadonlySet<LlmError['kind']> = new Set([
  'QUOTA_EXHAUSTED',
  'BILLING',
  'AUTH',
  'TIMEOUT',
  'SERVER',
  'RATE_LIMITED',
]);

/** Kinds that mean "out of quota or money", as opposed to "the service is struggling". */
const QUOTA_KINDS: ReadonlySet<LlmError['kind']> = new Set([
  'QUOTA_EXHAUSTED',
  'BILLING',
  'AUTH',
  'RATE_LIMITED',
]);

export interface ChainSlot {
  readonly entry: ChainEntry;
  readonly provider: LlmProvider;
}

/** One request, as the harness describes it. The model is the session's, not the harness's. */
export type SessionRequest = Omit<LlmRequest, 'model'>;

/** What the harness knows about a request that the router does not. */
export interface CallMeta {
  readonly harness: string;
  /** The exception it was for, or null when one conversation covered a cluster. */
  readonly exceptionId: string | null;
  /** sha-256 of system prompt, tool set and opening message. */
  readonly promptHash: string;
}

export type AttemptOutcome = 'ok' | 'fell_back' | LlmError['kind'];

/** Everything about one attempt, success or failure, ready to become an llm_calls row. */
export interface Attempt {
  readonly provider: string;
  readonly model: string;
  readonly meta: CallMeta;
  readonly outcome: AttemptOutcome;
  /** The error kind of a failed attempt, also when the outcome is `fell_back`. */
  readonly errorKind: LlmError['kind'] | null;
  readonly cached: boolean;
  readonly result: LlmResult | null;
  readonly latencyMs: number;
  /** What the call cost for real, in micro-USD: nothing on the Gemini free tier. */
  readonly costMicroUsd: bigint;
  /** What it would cost at the paid list price, or null when no price was given. */
  readonly estCostMicroUsd: bigint | null;
}

export interface SessionAnswer {
  readonly result: LlmResult;
  readonly cached: boolean;
  /** The id `record` returned for the attempt. */
  readonly callId: string | null;
}

export interface LlmSession {
  readonly provider: string;
  readonly model: string;
  complete(request: SessionRequest, meta: CallMeta): Promise<SessionAnswer>;
}

/** Why the chain gave no answer. */
export class ChainExhausted extends Error {
  constructor(
    /** What failed, per model, in the order tried. */
    readonly failures: readonly {
      readonly model: string;
      readonly kind: LlmError['kind'] | 'skipped';
      readonly detail: string;
    }[],
  ) {
    super(
      failures.length === 0
        ? 'no model is configured'
        : `no model could answer: ${failures.map((f) => `${f.model} (${f.kind})`).join(', ')}`,
    );
    this.name = 'ChainExhausted';
  }

  /** Out of quota or money, rather than a service that is down. */
  get quota(): boolean {
    return this.failures.some((f) =>
      f.kind === 'skipped'
        ? f.detail.startsWith('quota') || f.detail.startsWith('disabled')
        : QUOTA_KINDS.has(f.kind),
    );
  }
}

export interface RouterOptions {
  readonly slots: readonly ChainSlot[];
  readonly breakers: Breakers;
  readonly limiter: RequestLimiter;
  readonly cache: LlmCache;
  readonly limits: Readonly<Record<string, ModelLimits>>;
  readonly prices: Readonly<Record<string, Rates>>;
  /** `free`: Gemini calls cost nothing for real, and are still given an estimated paid price. */
  readonly geminiTier: 'free' | 'paid';
  /** The longest a rate limit is waited out before the next model is tried. */
  readonly maxWaitMs: number;
  readonly now?: () => number;
  /** Injected in tests so nothing really waits. Rejects with LlmAbortedError when the signal fires. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly warn?: (message: string) => void;
}

const MAX_RATE_RETRIES = 3;
const NO_HINT_WAIT_MS = 5_000;

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new LlmAbortedError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LlmAbortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RouteOptions {
  /** Called for every attempt of this investigation, failed ones too; returns the stored call's id. */
  readonly record: (attempt: Attempt) => Promise<string | null>;
  /** Start at this position in the chain (an escalation starts after the model that just answered). */
  readonly from?: number;
}

export interface Routed<T> {
  readonly value: T;
  readonly entry: ChainEntry;
  /** Position of `entry` in the chain. */
  readonly index: number;
  /** Models that failed before this one answered, and why. */
  readonly fellBackFrom: readonly { readonly model: string; readonly kind: LlmError['kind'] }[];
}

export interface SlotStatus {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly state: SlotState['state'];
  readonly until: string | null;
  readonly why: string | null;
  readonly usedToday: number;
  readonly limitPerDay: number | null;
}

export class LlmRouter {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly options: RouterOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
  }

  get chain(): readonly ChainEntry[] {
    return this.options.slots.map((s) => s.entry);
  }

  /** Whether at least one model is configured and not switched off. */
  get usable(): boolean {
    return this.options.slots.some(
      (s) => this.options.breakers.state(s.entry).state !== 'disabled',
    );
  }

  /**
   * Runs `fn` on the first model that will take it, falling back as described at the top of this file.
   * Throws ChainExhausted when no model can, without waiting if every model is already known to be out.
   */
  async route<T>(
    fn: (session: LlmSession) => Promise<T>,
    options: RouteOptions,
  ): Promise<Routed<T>> {
    const failures: { model: string; kind: LlmError['kind'] | 'skipped'; detail: string }[] = [];
    const fellBackFrom: { model: string; kind: LlmError['kind'] }[] = [];
    const slots = this.options.slots;
    for (let index = options.from ?? 0; index < slots.length; index += 1) {
      const slot = slots[index];
      if (slot === undefined) continue;
      const state = this.options.breakers.state(slot.entry);
      if (state.state !== 'ok') {
        failures.push({
          model: slot.entry.id,
          kind: 'skipped',
          detail:
            state.state === 'disabled'
              ? `disabled: ${state.why}`
              : state.state === 'quota_exhausted'
                ? 'quota exhausted for today'
                : `cooling: ${state.why}`,
        });
        continue;
      }
      try {
        const value = await fn(this.session(slot, options.record));
        this.options.breakers.recordSuccess(slot.entry);
        return { value, entry: slot.entry, index, fellBackFrom };
      } catch (error) {
        if (!(error instanceof LlmError) || !FALLBACK_KINDS.has(error.kind)) throw error;
        this.options.breakers.recordFailure(slot.entry, error);
        failures.push({ model: slot.entry.id, kind: error.kind, detail: error.message });
        fellBackFrom.push({ model: slot.entry.id, kind: error.kind });
        this.options.warn?.(`${slot.entry.id} failed (${error.kind}); trying the next model`);
      }
    }
    throw new ChainExhausted(failures);
  }

  /** The state of every model, for the status page and the banner. */
  async status(): Promise<SlotStatus[]> {
    return Promise.all(
      this.options.slots.map(async ({ entry }): Promise<SlotStatus> => {
        const s = this.options.breakers.state(entry);
        return {
          id: entry.id,
          provider: entry.provider,
          model: entry.model,
          state: s.state,
          until: 'until' in s ? new Date(s.until).toISOString() : null,
          why: 'why' in s ? s.why : null,
          usedToday: await this.options.limiter.usedToday(entry.model).catch(() => 0),
          limitPerDay:
            entry.provider === 'gemini' ? (this.options.limits[entry.model]?.rpd ?? null) : null,
        };
      }),
    );
  }

  // --- one model's session ---------------------------------------------------------------------------

  private session(slot: ChainSlot, record: RouteOptions['record']): LlmSession {
    const { entry, provider } = slot;
    const { limiter, cache, limits, breakers } = this.options;
    const identity = (meta: CallMeta) => ({
      provider: entry.provider,
      model: entry.model,
      harness: meta.harness,
    });

    return {
      provider: entry.provider,
      model: entry.model,
      complete: async (sessionRequest, meta): Promise<SessionAnswer> => {
        const request: LlmRequest = { ...sessionRequest, model: entry.model };
        const cached = await cache.lookup(identity(meta), request);
        if (cached !== undefined) {
          const callId = await this.recordAttempt(
            record,
            entry,
            meta,
            'ok',
            null,
            true,
            cached.result,
            0,
          );
          return { result: cached.result, cached: true, callId };
        }

        let rateRetries = 0;
        for (;;) {
          await this.takeSlot(entry, limits[entry.model], request.signal, limiter, breakers);

          const startedAt = this.now();
          try {
            const result = await provider.complete(request);
            await cache.remember(identity(meta), request, result);
            const callId = await this.recordAttempt(
              record,
              entry,
              meta,
              'ok',
              null,
              false,
              result,
              this.now() - startedAt,
            );
            return { result, cached: false, callId };
          } catch (error) {
            const latency = this.now() - startedAt;
            if (
              error instanceof LlmAbortedError ||
              error instanceof CacheMissError ||
              !(error instanceof LlmError)
            )
              throw error;

            if (error.kind === 'RATE_LIMITED' && rateRetries < MAX_RATE_RETRIES) {
              const wait = error.retryAfterMs ?? NO_HINT_WAIT_MS * (rateRetries + 1);
              if (wait <= this.options.maxWaitMs) {
                rateRetries += 1;
                await this.recordAttempt(
                  record,
                  entry,
                  meta,
                  'RATE_LIMITED',
                  error,
                  false,
                  null,
                  latency,
                );
                await this.sleep(wait, request.signal);
                continue;
              }
            }
            const fallsBack = FALLBACK_KINDS.has(error.kind);
            await this.recordAttempt(
              record,
              entry,
              meta,
              fallsBack ? 'fell_back' : error.kind,
              error,
              false,
              null,
              latency,
            );
            throw error;
          }
        }
      },
    };
  }

  /** Waits for the client-side limits, or throws the failure that sends the router to the next model. */
  private async takeSlot(
    entry: ChainEntry,
    limits: ModelLimits | undefined,
    signal: AbortSignal,
    limiter: RequestLimiter,
    breakers: Breakers,
  ): Promise<void> {
    for (;;) {
      let got;
      try {
        got = await limiter.acquire(entry.model, entry.provider === 'gemini' ? limits : undefined);
      } catch (error) {
        // A limiter that cannot answer must not stop the agent: the server's own 429s still protect the key.
        this.options.warn?.(
          `request limiter unavailable (${error instanceof Error ? error.message : String(error)}); continuing without it`,
        );
        return;
      }
      if (got.ok) return;
      if (got.reason === 'rpd') {
        const error = new LlmError(
          'QUOTA_EXHAUSTED',
          'the configured daily request limit for this model is spent',
          {
            provider: entry.provider,
            model: entry.model,
          },
        );
        breakers.recordFailure(entry, error);
        throw error;
      }
      if (got.waitMs > this.options.maxWaitMs) {
        throw new LlmError(
          'RATE_LIMITED',
          'the configured per-minute limit would need a longer wait than allowed',
          {
            provider: entry.provider,
            model: entry.model,
            retryAfterMs: got.waitMs,
          },
        );
      }
      await this.sleep(got.waitMs, signal);
    }
  }

  private recordAttempt(
    record: RouteOptions['record'],
    entry: ChainEntry,
    meta: CallMeta,
    outcome: AttemptOutcome,
    error: LlmError | null,
    cached: boolean,
    result: LlmResult | null,
    latencyMs: number,
  ): Promise<string | null> {
    const rates = this.options.prices[entry.id];
    const usage = result?.usage;
    const estimate =
      usage === undefined || rates === undefined ? null : estimateCostMicroUsd(rates, usage);
    // Free-tier Gemini costs nothing for real; everything else costs its list price, or cannot be counted
    // (a provider with no price is never enabled, see the factory), so a missing price counts as zero here.
    const free = entry.provider === 'gemini' && this.options.geminiTier === 'free';
    const real = cached || free ? 0n : (estimate ?? 0n);
    return record({
      provider: entry.provider,
      model: entry.model,
      meta,
      outcome,
      errorKind: error?.kind ?? null,
      cached,
      result,
      latencyMs: Math.max(0, latencyMs),
      costMicroUsd: real,
      estCostMicroUsd: cached ? null : estimate,
    });
  }
}
