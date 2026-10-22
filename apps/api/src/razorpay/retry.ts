import { RazorpayApiError } from './errors.js';

export interface RetryPolicy {
  /** Total tries, the first included. */
  readonly maxAttempts: number;
  /** The backoff ceiling before the first retry; it doubles each time. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Give up once waiting again would push the total past this. */
  readonly deadlineMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  deadlineMs: 60_000,
};

/** Everything time- and chance-related is injected, so tests need no real waiting or luck. */
export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  /** A float in [0, 1). */
  random: () => number;
  /** Milliseconds since an arbitrary start. */
  now: () => number;
}

export const REAL_DEPS: RetryDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
  now: () => Date.now(),
};

/**
 * "Full jitter" exponential backoff: wait a uniformly random time between 0 and
 * min(maxDelay, base * 2^(attempt-1)). The randomness is what stops a crowd of retrying clients
 * hitting the API in lockstep, which Razorpay's own docs call out for 429s.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * (ceiling + 1));
}

/**
 * Runs `fn`, retrying only a retryable RazorpayApiError. Anything else (a 400, a bug) is thrown at
 * once. When it gives up, the last error is rethrown with the number of attempts made. A server's
 * Retry-After, when present, replaces the computed wait.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  deps: RetryDeps = REAL_DEPS,
): Promise<T> {
  const started = deps.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof RazorpayApiError) || !error.retryable) throw error;
      if (attempt >= policy.maxAttempts) throw error.withAttempts(attempt);

      const wait = error.retryAfterMs ?? backoffDelay(attempt, policy, deps.random);
      if (deps.now() - started + wait > policy.deadlineMs) throw error.withAttempts(attempt);
      await deps.sleep(wait);
    }
  }
}
