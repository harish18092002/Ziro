// A hard ceiling on what one eval invocation may spend, shared by every run in it. There are two kinds of
// spend, and a free-tier run has only the second:
//
//   money     USD, for a provider that charges (Claude). Capped by --max-cost-usd.
//   requests  attempts that reached a provider, failed ones included, answers served from the cache not.
//             On the Gemini free tier these are the scarce resource, so they have their own cap:
//             --max-requests.
//
// Checked before each investigation and before each model request, so a run stops promptly once a cap is
// reached. It can overshoot by at most the requests already in flight (one per concurrent investigation):
// the cap is a ceiling on what is STARTED, and the report says so.
import { AgentHalted } from '../agent/types.js';

export class CostGuard {
  private spent = 0n;
  private sent = 0;

  /** `null` means no cap, which only a free run (rules, replay, or fakes in tests) may use. */
  constructor(
    private readonly capMicroUsd: bigint | null,
    private readonly maxRequests: number | null = null,
  ) {}

  /** Records one attempt: what it cost, and whether it used a request (a cached answer does not). */
  add(microUsd: bigint, request = true): void {
    this.spent += microUsd;
    if (request) this.sent += 1;
  }

  get spentMicroUsd(): bigint {
    return this.spent;
  }

  get requests(): number {
    return this.sent;
  }

  get cap(): bigint | null {
    return this.capMicroUsd;
  }

  get requestCap(): number | null {
    return this.maxRequests;
  }

  get exceeded(): boolean {
    return (
      (this.capMicroUsd !== null && this.spent >= this.capMicroUsd) ||
      (this.maxRequests !== null && this.sent >= this.maxRequests)
    );
  }

  /** Which cap stopped the run, for the report. */
  get why(): string | null {
    if (this.capMicroUsd !== null && this.spent >= this.capMicroUsd)
      return 'the cost cap was reached';
    if (this.maxRequests !== null && this.sent >= this.maxRequests) {
      return 'the request cap was reached';
    }
    return null;
  }

  /** Throws the same halt the daily budget uses, which stops the worker pool without losing results. */
  assertWithin(): void {
    if (this.exceeded) throw new AgentHalted('daily_budget');
  }
}
