// A hard ceiling on what one eval invocation may spend, shared by every run in it. It is checked before
// each investigation and before each model request, so a run stops promptly once the cap is reached.
// It can overshoot by at most the requests already in flight (one per concurrent investigation): the
// cap is a ceiling on what is STARTED, and the report says so.
import { AgentHalted } from '../agent/types.js';

export class CostGuard {
  private spent = 0n;

  /** `null` means no cap, which only a free run (rules, or fakes in tests) may use. */
  constructor(private readonly capMicroUsd: bigint | null) {}

  add(microUsd: bigint): void {
    this.spent += microUsd;
  }

  get spentMicroUsd(): bigint {
    return this.spent;
  }

  get cap(): bigint | null {
    return this.capMicroUsd;
  }

  get exceeded(): boolean {
    return this.capMicroUsd !== null && this.spent >= this.capMicroUsd;
  }

  /** Throws the same halt the daily budget uses, which stops the worker pool without losing results. */
  assertWithin(): void {
    if (this.exceeded) throw new AgentHalted('daily_budget');
  }
}
