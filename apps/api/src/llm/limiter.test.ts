import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_REDIS_URL, localRedisAnswers } from '../agent/redis.fixtures.js';
import type { ModelLimits } from './config.js';
import { type RequestLimiter, MemoryLimiter, RedisLimiter, WINDOW_MS } from './limiter.js';
import { nextPacificMidnightMs } from './pacific.js';

const at = (iso: string): number => Date.parse(iso);

/** The rules every limiter must keep, run against the in-memory twin and against Redis. */
function contract(make: (clock: { now: number }) => Promise<RequestLimiter>): void {
  const clock = { now: at('2026-07-01T12:00:00Z') };
  let limiter: RequestLimiter;
  beforeAll(async () => {
    limiter = await make(clock);
  });

  it('allows requests up to the per-minute limit, then says how long to wait', async () => {
    const limits: ModelLimits = { rpm: 3, rpd: 1000 };
    clock.now = at('2026-07-01T12:00:00Z');
    for (let i = 0; i < 3; i += 1) {
      expect(await limiter.acquire('m-rpm', limits)).toEqual({ ok: true });
      clock.now += 1000;
    }
    // 3 sent at +0, +1 s, +2 s; now +3 s. The oldest leaves the window at +60 s.
    expect(await limiter.acquire('m-rpm', limits)).toEqual({
      ok: false,
      reason: 'rpm',
      waitMs: WINDOW_MS - 3000,
    });
    clock.now += WINDOW_MS - 3000;
    expect(await limiter.acquire('m-rpm', limits)).toEqual({ ok: true });
  });

  it('never allows more than the limit inside any 60 seconds (no double burst at a minute boundary)', async () => {
    const limits: ModelLimits = { rpm: 2, rpd: 1000 };
    clock.now = at('2026-07-01T12:10:00Z');
    expect((await limiter.acquire('m-burst', limits)).ok).toBe(true);
    expect((await limiter.acquire('m-burst', limits)).ok).toBe(true);
    clock.now += WINDOW_MS - 1; // one millisecond before the first two leave the window
    expect((await limiter.acquire('m-burst', limits)).ok).toBe(false);
    clock.now += 1;
    expect((await limiter.acquire('m-burst', limits)).ok).toBe(true);
  });

  it('refuses past the per-day limit and reports the Pacific reset', async () => {
    const limits: ModelLimits = { rpm: 1000, rpd: 2 };
    clock.now = at('2026-07-01T12:00:00Z');
    expect((await limiter.acquire('m-rpd', limits)).ok).toBe(true);
    expect((await limiter.acquire('m-rpd', limits)).ok).toBe(true);
    expect(await limiter.acquire('m-rpd', limits)).toEqual({
      ok: false,
      reason: 'rpd',
      resetsAtMs: at('2026-07-02T07:00:00Z'),
    });
    expect(await limiter.usedToday('m-rpd')).toBe(2);
  });

  it('starts a fresh day at Pacific midnight, not at UTC midnight', async () => {
    const limits: ModelLimits = { rpm: 1000, rpd: 1 };
    clock.now = at('2026-07-10T06:59:00Z'); // 23:59 PDT on the 9th
    expect((await limiter.acquire('m-roll', limits)).ok).toBe(true);
    expect((await limiter.acquire('m-roll', limits)).ok).toBe(false);
    clock.now = at('2026-07-10T07:00:01Z'); // 00:00:01 PDT on the 10th
    expect(await limiter.usedToday('m-roll')).toBe(0);
    expect((await limiter.acquire('m-roll', limits)).ok).toBe(true);
    // UTC midnight earlier in the evening did not reset it: the next reset is Pacific's.
    expect(nextPacificMidnightMs(clock.now)).toBe(at('2026-07-11T07:00:00Z'));
  });

  it('rolls over at 08:00 UTC in winter', async () => {
    const limits: ModelLimits = { rpm: 1000, rpd: 1 };
    clock.now = at('2026-12-10T07:59:00Z');
    expect((await limiter.acquire('m-winter', limits)).ok).toBe(true);
    clock.now = at('2026-12-10T08:00:01Z');
    expect((await limiter.acquire('m-winter', limits)).ok).toBe(true);
  });

  it('keeps each model apart', async () => {
    const limits: ModelLimits = { rpm: 1, rpd: 1 };
    clock.now = at('2026-07-20T12:00:00Z');
    expect((await limiter.acquire('m-a', limits)).ok).toBe(true);
    expect((await limiter.acquire('m-b', limits)).ok).toBe(true);
    expect((await limiter.acquire('m-a', limits)).ok).toBe(false);
  });

  it('counts but never refuses a model with no known limits', async () => {
    clock.now = at('2026-07-21T12:00:00Z');
    for (let i = 0; i < 50; i += 1)
      expect(await limiter.acquire('m-free', undefined)).toEqual({ ok: true });
    expect(await limiter.usedToday('m-free')).toBe(50);
  });
}

describe('MemoryLimiter', () => {
  contract((clock) => Promise.resolve(new MemoryLimiter(() => clock.now)));
});

const redisUp = await localRedisAnswers();

describe.skipIf(!redisUp)('RedisLimiter (needs the compose Redis)', () => {
  const prefix = `ziro-test:${process.pid}:${Date.now()}`;
  let redis: Redis;
  contract((clock) => {
    redis = new Redis(LOCAL_REDIS_URL);
    return Promise.resolve(new RedisLimiter(redis, () => clock.now, prefix));
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });
});
