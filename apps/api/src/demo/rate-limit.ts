// A small in-memory limiter for the one public endpoint that creates work: starting a demo run. It
// has no dependency and keeps no state outside this process, which is the right size for a demo: a
// restart forgets it, and several instances each count separately. It is a speed bump against a
// careless loop, not a defence against a determined attacker.
export interface Rule {
  readonly windowMs: number;
  readonly max: number;
}

export type Verdict =
  { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number };

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly rules: readonly Rule[],
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /**
   * Whether a call would be allowed, without counting it. Several limiters can then be asked first, and
   * counted only when every one of them agrees: a call refused by one must not use up another's allowance.
   */
  peek(key: string): Verdict {
    const at = this.now();
    return this.verdict(key, at, this.recent(key, at));
  }

  /** Counts the call if it is allowed. A refused call is not counted. */
  check(key: string): Verdict {
    const at = this.now();
    const longest = Math.max(...this.rules.map((r) => r.windowMs));
    const recent = this.recent(key, at);
    const verdict = this.verdict(key, at, recent);
    if (!verdict.ok) {
      this.hits.set(key, recent);
      return verdict;
    }

    recent.push(at);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(at, longest);
    return { ok: true };
  }

  private recent(key: string, at: number): number[] {
    const longest = Math.max(...this.rules.map((r) => r.windowMs));
    return (this.hits.get(key) ?? []).filter((t) => at - t < longest);
  }

  private verdict(_key: string, at: number, recent: readonly number[]): Verdict {
    let wait = 0;
    for (const rule of this.rules) {
      const inWindow = recent.filter((t) => at - t < rule.windowMs);
      if (inWindow.length >= rule.max) {
        const oldest = inWindow[inWindow.length - rule.max] ?? at;
        wait = Math.max(wait, oldest + rule.windowMs - at);
      }
    }
    return wait > 0
      ? { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) }
      : { ok: true };
  }

  private prune(at: number, longest: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => at - t >= longest)) this.hits.delete(key);
    }
    // Still too many distinct callers: forget the oldest ones rather than grow without bound.
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}
