// What the system has learned about each model in the chain, so the next investigation does not rediscover
// it at the cost of a request and a wait. Everything is per process and in memory (the same stance as the
// older AgentHealth): with several instances each learns on its own, which costs a few failed requests,
// and sharing it would mean a Redis key for a banner.
//
//   disabled          BILLING or AUTH (and a spent Anthropic tier, which has no daily reset): the provider
//                     stays off for the life of the process. Another request would fail the same way.
//   quota_exhausted   a Gemini model's daily quota: skipped until the Pacific date changes.
//   cooling           a rate limit longer than the router would wait, or repeated timeouts and 5xx: skipped
//                     for a while, then one request is let through as a probe.
//   ok                everything else.
import type { LlmError } from '@ziro/core/llm';
import type { ChainEntry, ProviderName } from './config.js';
import { nextPacificMidnightMs } from './pacific.js';

export type SlotState =
  | { readonly state: 'ok' }
  | { readonly state: 'cooling'; readonly until: number; readonly why: string }
  | { readonly state: 'quota_exhausted'; readonly until: number }
  | { readonly state: 'disabled'; readonly why: string };

export const DEFAULT_OUTAGE_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_RATE_COOLDOWN_MS = 60_000;

export interface BreakerOptions {
  /** Consecutive timeouts or 5xx from one model that take it out for the cooldown. */
  readonly outageThreshold?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export class Breakers {
  private readonly disabled = new Map<ProviderName, string>();
  private readonly skips = new Map<
    string,
    Exclude<SlotState, { state: 'ok' } | { state: 'disabled' }>
  >();
  private readonly failures = new Map<string, number>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: BreakerOptions = {}) {
    this.threshold = options.outageThreshold ?? DEFAULT_OUTAGE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /** Turns a provider off for the life of the process (a missing key, or no price for a paid provider). */
  disable(provider: ProviderName, why: string): void {
    if (!this.disabled.has(provider)) this.disabled.set(provider, why);
  }

  state(entry: ChainEntry): SlotState {
    const off = this.disabled.get(entry.provider);
    if (off !== undefined) return { state: 'disabled', why: off };
    const skip = this.skips.get(entry.id);
    if (skip === undefined) return { state: 'ok' };
    if (this.now() >= skip.until) {
      this.skips.delete(entry.id);
      // A cooldown ends with one probe: a model that is still down trips straight back.
      if (skip.state === 'cooling') this.failures.set(entry.id, Math.max(0, this.threshold - 1));
      return { state: 'ok' };
    }
    return skip;
  }

  usable(entry: ChainEntry): boolean {
    return this.state(entry).state === 'ok';
  }

  /** A request to this model was answered usably. */
  recordSuccess(entry: ChainEntry): void {
    this.failures.delete(entry.id);
  }

  /** Learns from a failure the router is about to fall back on. */
  recordFailure(entry: ChainEntry, error: LlmError): void {
    const now = this.now();
    switch (error.kind) {
      case 'BILLING':
      case 'AUTH':
        this.disable(entry.provider, `${error.kind}: ${error.message}`);
        return;
      case 'QUOTA_EXHAUSTED':
        if (entry.provider === 'anthropic') {
          // A spend cap has no daily reset to wait for, so it is treated like billing.
          this.disable(entry.provider, `QUOTA_EXHAUSTED: ${error.message}`);
        } else {
          this.skips.set(entry.id, { state: 'quota_exhausted', until: nextPacificMidnightMs(now) });
        }
        return;
      case 'RATE_LIMITED':
        this.skips.set(entry.id, {
          state: 'cooling',
          until: now + (error.retryAfterMs ?? DEFAULT_RATE_COOLDOWN_MS),
          why: 'rate limited for longer than the router waits',
        });
        return;
      case 'TIMEOUT':
      case 'SERVER': {
        const count = (this.failures.get(entry.id) ?? 0) + 1;
        this.failures.set(entry.id, count);
        if (count >= this.threshold) {
          this.skips.set(entry.id, {
            state: 'cooling',
            until: now + this.cooldownMs,
            why: `${count} timeouts or server errors in a row`,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Puts a model back in service by hand (a test, or an operator who fixed the key). */
  reset(): void {
    this.disabled.clear();
    this.skips.clear();
    this.failures.clear();
  }
}
