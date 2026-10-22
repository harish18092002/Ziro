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

  /** Counts the call if it is allowed. A refused call is not counted. */
  check(key: string): Verdict {
    const at = this.now();
    const longest = Math.max(...this.rules.map((r) => r.windowMs));
    const recent = (this.hits.get(key) ?? []).filter((t) => at - t < longest);

    let wait = 0;
    for (const rule of this.rules) {
      const inWindow = recent.filter((t) => at - t < rule.windowMs);
      if (inWindow.length >= rule.max) {
        const oldest = inWindow[inWindow.length - rule.max] ?? at;
        wait = Math.max(wait, oldest + rule.windowMs - at);
      }
    }
    if (wait > 0) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
    }

    recent.push(at);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(at, longest);
    return { ok: true };
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
