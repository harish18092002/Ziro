import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RazorpayApiError } from './errors.js';
import {
  backoffDelay,
  DEFAULT_RETRY,
  type RetryDeps,
  type RetryPolicy,
  withRetry,
} from './retry.js';

const POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  deadlineMs: 60_000,
};

/** A virtual clock: sleeping advances time, nothing really waits. */
function clock(random: () => number = () => 0.999999) {
  let time = 0;
  const waits: number[] = [];
  const deps: RetryDeps = {
    sleep: (ms) => {
      waits.push(ms);
      time += ms;
      return Promise.resolve();
    },
    random,
    now: () => time,
  };
  return { deps, waits };
}

const failing = (statuses: number[], then: string, extra?: { retryAfterMs?: number }) => {
  let calls = 0;
  const fn = (): Promise<string> => {
    const status = statuses[calls];
    calls += 1;
    if (status === undefined) return Promise.resolve(then);
    return Promise.reject(
      new RazorpayApiError(status, 'E', `failure ${status}`, extra?.retryAfterMs ?? null),
    );
  };
  return { fn, calls: () => calls };
};

describe('withRetry', () => {
  it('returns at once when the first attempt succeeds, without sleeping', async () => {
    const { deps, waits } = clock();
    const job = failing([], 'ok');
    await expect(withRetry(job.fn, POLICY, deps)).resolves.toBe('ok');
    expect(job.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it.each([0, 408, 429, 500, 502, 503, 504])(
    'retries status %i and then succeeds',
    async (status) => {
      const { deps, waits } = clock();
      const job = failing([status, status], 'ok');
      await expect(withRetry(job.fn, POLICY, deps)).resolves.toBe('ok');
      expect(job.calls()).toBe(3);
      expect(waits).toHaveLength(2);
    },
  );

  it.each([400, 401, 403, 404, 422])(
    'does not retry status %i: it would fail identically',
    async (status) => {
      const { deps, waits } = clock();
      const job = failing([status], 'never');
      await expect(withRetry(job.fn, POLICY, deps)).rejects.toMatchObject({
        statusCode: status,
        attempts: 1,
      });
      expect(job.calls()).toBe(1);
      expect(waits).toEqual([]);
    },
  );

  it('does not retry a programming error', async () => {
    const { deps } = clock();
    let calls = 0;
    const bug = (): Promise<never> => {
      calls += 1;
      return Promise.reject(new TypeError('boom'));
    };
    await expect(withRetry(bug, POLICY, deps)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts and reports how many it made', async () => {
    const { deps, waits } = clock();
    const job = failing([429, 429, 429, 429, 429, 429, 429], 'never');
    await expect(withRetry(job.fn, POLICY, deps)).rejects.toMatchObject({
      statusCode: 429,
      attempts: 5,
    });
    expect(job.calls()).toBe(5);
    expect(waits).toHaveLength(4); // no sleep after the final attempt
  });

  it('waits up to a doubling ceiling: 500, 1000, 2000, 4000 ms at worst', async () => {
    const { deps, waits } = clock(() => 0.999999);
    await withRetry(failing([503, 503, 503, 503], 'ok').fn, POLICY, deps);
    expect(waits).toEqual([500, 1000, 2000, 4000]);
  });

  it('jitters: the same failures wait different times for different random draws', async () => {
    const a = clock(() => 0);
    const b = clock(() => 0.5);
    await withRetry(failing([503, 503, 503], 'ok').fn, POLICY, a.deps);
    await withRetry(failing([503, 503, 503], 'ok').fn, POLICY, b.deps);
    expect(a.waits).toEqual([0, 0, 0]);
    expect(b.waits).toEqual([250, 500, 1000]);
  });

  it('never waits longer than maxDelayMs', async () => {
    const { deps, waits } = clock(() => 0.999999);
    const policy: RetryPolicy = { ...POLICY, maxAttempts: 12, deadlineMs: 10_000_000 };
    await withRetry(failing(Array<number>(11).fill(503), 'ok').fn, policy, deps);
    expect(Math.max(...waits)).toBeLessThanOrEqual(policy.maxDelayMs);
    expect(waits.at(-1)).toBe(policy.maxDelayMs);
  });

  it("honours the server's Retry-After instead of its own backoff", async () => {
    const { deps, waits } = clock(() => 0);
    await withRetry(failing([429], 'ok', { retryAfterMs: 7000 }).fn, POLICY, deps);
    expect(waits).toEqual([7000]);
  });

  it('stops rather than wait past the deadline', async () => {
    const { deps, waits } = clock();
    const policy: RetryPolicy = { ...POLICY, deadlineMs: 5_000 };
    const job = failing([429, 429], 'never', { retryAfterMs: 4000 });
    await expect(withRetry(job.fn, policy, deps)).rejects.toMatchObject({
      statusCode: 429,
      attempts: 2,
    });
    expect(waits).toEqual([4000]); // the second 4000 ms wait would pass 5000 ms in total
  });
});

describe('backoffDelay', () => {
  it('is always between 0 and the ceiling, whatever the random draw', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.double({ min: 0, max: 0.9999999, noNaN: true }),
        (attempt, r) => {
          const delay = backoffDelay(attempt, DEFAULT_RETRY, () => r);
          const ceiling = Math.min(
            DEFAULT_RETRY.maxDelayMs,
            DEFAULT_RETRY.baseDelayMs * 2 ** (attempt - 1),
          );
          expect(Number.isInteger(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(ceiling);
        },
      ),
      { numRuns: 500 },
    );
  });
});
