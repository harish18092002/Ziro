// Retry with "full jitter" exponential backoff, the one implementation. Razorpay calls and model
// investigations both use it, so the waiting rules are written, and tested, once.
//
// Everything time- and chance-related is injected, so a test needs no real waiting and no luck.

export interface RetryPolicy {
  /** Total tries, the first included. */
  readonly maxAttempts: number;
  /** The backoff ceiling before the first retry; it doubles each time. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Give up once waiting again would push the total past this. */
  readonly deadlineMs: number;
}

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
 * Wait a uniformly random time between 0 and min(maxDelay, base * 2^(attempt-1)). The randomness is what
 * stops a crowd of retrying clients hitting an API in lockstep.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * (ceiling + 1));
}

export interface RetryOptions {
  readonly policy: RetryPolicy;
  readonly deps?: RetryDeps;
  /** Is this failure worth another try? Anything else is thrown at once, untouched. */
  readonly isRetryable: (error: unknown) => boolean;
  /** A wait the server asked for; it replaces the computed one. */
  readonly retryAfterMs?: (error: unknown) => number | null | undefined;
  /** What to throw when it gives up, given the last error and the number of attempts made. */
  readonly giveUp?: (error: unknown, attempts: number) => unknown;
  /** Called before each wait, for logs and for "recovered after N retries" notes. */
  readonly onRetry?: (error: unknown, attempt: number, waitMs: number) => void;
}

/**
 * Runs `fn`, retrying a retryable failure up to `policy.maxAttempts` times in all, within the policy's
 * deadline. When it gives up it throws `giveUp(lastError, attempts)`, or the last error itself.
 */
export async function retrying<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { policy, isRetryable } = options;
  const deps = options.deps ?? REAL_DEPS;
  const started = deps.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      const stop = () => options.giveUp?.(error, attempt) ?? error;
      if (attempt >= policy.maxAttempts) throw stop();

      const wait = options.retryAfterMs?.(error) ?? backoffDelay(attempt, policy, deps.random);
      if (deps.now() - started + wait > policy.deadlineMs) throw stop();
      options.onRetry?.(error, attempt, wait);
      await deps.sleep(wait);
    }
  }
}
