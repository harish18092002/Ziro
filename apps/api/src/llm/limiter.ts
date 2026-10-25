// Client-side request limits, so the free tier is spent on purpose and a limit is met by waiting or falling
// back before Google has to say no. Two limits per model, taken from GEMINI_LIMITS (never guessed):
//
//   rpm  at most N requests in any 60 seconds. A sliding window, not a refilling bucket: a bucket that
//        starts full lets N requests go at once and N more a minute later, which is 2N inside one minute
//        of the server's clock. The window's oldest request says exactly how long until the next is free.
//   rpd  at most N requests per Pacific calendar day (pacific.ts). The counter is keyed on that date, so it
//        resets by itself at the zone's midnight, daylight saving included.
//
// A request is counted when it is allowed, before it is sent: an attempt that fails still used quota.
// Without limits for a model the limiter only counts (the status page shows it) and never refuses.
import type { Redis } from 'ioredis';
import { nextPacificMidnightMs, pacificDate } from './pacific.js';
import type { ModelLimits } from './config.js';

export const WINDOW_MS = 60_000;

export type Acquire =
  | { readonly ok: true }
  /** The minute's allowance is spent; the next request is free in `waitMs`. */
  | { readonly ok: false; readonly reason: 'rpm'; readonly waitMs: number }
  /** The day's allowance is spent; it resets at `resetsAtMs`. */
  | { readonly ok: false; readonly reason: 'rpd'; readonly resetsAtMs: number };

export interface RequestLimiter {
  /** Counts one request for `model` if the limits allow it now. */
  acquire(model: string, limits: ModelLimits | undefined): Promise<Acquire>;
  /** Requests counted for `model` on the current Pacific date. */
  usedToday(model: string): Promise<number>;
}

/** In-process twin of the Redis limiter: the same rules, for evals, tests and a run with no Redis. */
export class MemoryLimiter implements RequestLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly days = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private dayKey(model: string): string {
    return `${model}|${pacificDate(this.now())}`;
  }

  acquire(model: string, limits: ModelLimits | undefined): Promise<Acquire> {
    const now = this.now();
    const day = this.dayKey(model);
    const used = this.days.get(day) ?? 0;
    if (limits !== undefined && used >= limits.rpd) {
      return Promise.resolve({ ok: false, reason: 'rpd', resetsAtMs: nextPacificMidnightMs(now) });
    }
    const stamps = (this.windows.get(model) ?? []).filter((t) => t > now - WINDOW_MS);
    if (limits !== undefined && stamps.length >= limits.rpm) {
      this.windows.set(model, stamps);
      const oldest = stamps[0] ?? now;
      return Promise.resolve({
        ok: false,
        reason: 'rpm',
        waitMs: Math.max(1, oldest + WINDOW_MS - now),
      });
    }
    stamps.push(now);
    this.windows.set(model, stamps);
    this.days.set(day, used + 1);
    return Promise.resolve({ ok: true });
  }

  usedToday(model: string): Promise<number> {
    return Promise.resolve(this.days.get(this.dayKey(model)) ?? 0);
  }
}

// One script so the two checks and the two writes are a single atomic step across processes.
// KEYS: window (sorted set), window sequence, day counter.   ARGV: now, rpm, rpd, window ms, day ttl s.
// Returns {0} allowed, {1, waitMs} minute full, {2} day full. An rpm or rpd of 0 means "no limit".
const ACQUIRE = `
local now = tonumber(ARGV[1])
local rpm = tonumber(ARGV[2])
local rpd = tonumber(ARGV[3])
local window = tonumber(ARGV[4])
local used = tonumber(redis.call('GET', KEYS[3]) or '0')
if rpd > 0 and used >= rpd then return {2, 0} end
if rpm > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
  if redis.call('ZCARD', KEYS[1]) >= rpm then
    local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    return {1, math.max(1, tonumber(oldest[2]) + window - now)}
  end
  redis.call('ZADD', KEYS[1], now, now .. ':' .. redis.call('INCR', KEYS[2]))
  redis.call('PEXPIRE', KEYS[1], window)
  redis.call('PEXPIRE', KEYS[2], window)
end
redis.call('INCR', KEYS[3])
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[5]))
return {0, 0}
`;

const DAY_KEY_TTL_SECONDS = 2 * 86_400;

/** The limiter every process shares, so two instances cannot each spend the day's allowance. */
export class RedisLimiter implements RequestLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
    private readonly prefix: string = 'ziro:llm',
  ) {}

  private dayKey(model: string, now: number): string {
    return `${this.prefix}:rpd:${model}:${pacificDate(now)}`;
  }

  async acquire(model: string, limits: ModelLimits | undefined): Promise<Acquire> {
    const now = this.now();
    const reply = (await this.redis.eval(
      ACQUIRE,
      3,
      `${this.prefix}:rpm:${model}`,
      `${this.prefix}:rpm-seq:${model}`,
      this.dayKey(model, now),
      String(now),
      String(limits?.rpm ?? 0),
      String(limits?.rpd ?? 0),
      String(WINDOW_MS),
      String(DAY_KEY_TTL_SECONDS),
    )) as [number, number];
    if (reply[0] === 0) return { ok: true };
    if (reply[0] === 1) return { ok: false, reason: 'rpm', waitMs: Number(reply[1]) };
    return { ok: false, reason: 'rpd', resetsAtMs: nextPacificMidnightMs(now) };
  }

  async usedToday(model: string): Promise<number> {
    return Number((await this.redis.get(this.dayKey(model, this.now()))) ?? 0);
  }
}
