// Whether the agent should be asking the model anything right now, beyond the two switches the operator
// controls (the kill switch and the daily budget, which AgentService reads). This is what the SYSTEM
// learns: a rejected key, a provider spend limit, or a model API that has stopped answering.
//
// It is per process and in memory. On several instances each learns on its own, which costs a few failed
// investigations on each and is stated in the docs; sharing it would mean a table or Redis key for a
// banner. A pause lasts a cooldown and then lets one investigation through to see whether things are
// better: if that fails the same way the pause comes straight back.
import { AgentHalted, HALT_MESSAGE, type HaltReason } from './types.js';

export const DEFAULT_BREAKER_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export interface PausedState {
  readonly reason: HaltReason;
  readonly message: string;
  /** ISO time the pause began. */
  readonly since: string;
  /** ISO time the next investigation will be allowed through as a probe. */
  readonly until: string;
}

export interface HealthOptions {
  /** Consecutive "the model API did not answer" outcomes that trip the breaker. */
  readonly threshold?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export class AgentHealth {
  private paused: { reason: HaltReason; since: number; until: number } | null = null;
  private consecutiveUnavailable = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: HealthOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /** The current pause, or null. A pause that has run its cooldown ends here, leaving one probe to fail. */
  state(): PausedState | null {
    if (this.paused === null) return null;
    if (this.now() >= this.paused.until) {
      this.paused = null;
      this.consecutiveUnavailable = Math.max(0, this.threshold - 1);
      return null;
    }
    return {
      reason: this.paused.reason,
      message: HALT_MESSAGE[this.paused.reason],
      since: new Date(this.paused.since).toISOString(),
      until: new Date(this.paused.until).toISOString(),
    };
  }

  /** Throws the halt for the current pause, if there is one. */
  assertRunning(): void {
    const paused = this.state();
    if (paused !== null) throw new AgentHalted(paused.reason);
  }

  pause(reason: HaltReason): void {
    const since = this.now();
    this.paused = { reason, since, until: since + this.cooldownMs };
  }

  /** The model API answered (even if the answer was unusable). */
  recordAnswered(): void {
    this.consecutiveUnavailable = 0;
  }

  /** An investigation found the model API unavailable. True when this one trips the breaker. */
  recordUnavailable(): boolean {
    this.consecutiveUnavailable += 1;
    if (this.consecutiveUnavailable < this.threshold) return false;
    this.pause('model_unavailable');
    return true;
  }

  /** An operator resumed the agent by hand. */
  resume(): void {
    this.paused = null;
    this.consecutiveUnavailable = 0;
  }
}
