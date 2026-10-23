// Razorpay's use of the shared retry: only a retryable RazorpayApiError is tried again; anything else
// (a 400, a bug) is thrown at once. When it gives up, the last error is rethrown carrying the number of
// attempts made. A server's Retry-After, when present, replaces the computed wait.
import {
  backoffDelay,
  REAL_DEPS,
  type RetryDeps,
  type RetryPolicy,
  retrying,
} from '../common/retry.js';
import { RazorpayApiError } from './errors.js';

export { backoffDelay, REAL_DEPS, type RetryDeps, type RetryPolicy };

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  deadlineMs: 60_000,
};

export function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  deps: RetryDeps = REAL_DEPS,
): Promise<T> {
  return retrying(() => fn(), {
    policy,
    deps,
    isRetryable: (error) => error instanceof RazorpayApiError && error.retryable,
    retryAfterMs: (error) => (error instanceof RazorpayApiError ? error.retryAfterMs : null),
    giveUp: (error, attempts) =>
      error instanceof RazorpayApiError ? error.withAttempts(attempts) : error,
  });
}
