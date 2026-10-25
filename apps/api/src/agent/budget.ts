// The limits on one investigation: how many tool calls, how many tokens, how long. They exist to
// bound cost and latency, not to be tuned per run; a person re-runs an exception that hit one.
export interface Limits {
  readonly maxToolCalls: number;
  /** Output tokens (thinking included) summed over every request of the investigation. */
  readonly maxOutputTokens: number;
  /** The `max_tokens` of a single request. */
  readonly maxTokensPerRequest: number;
  /** Prompt tokens of a single request; above this the conversation is too long to carry on. */
  readonly maxPromptTokensPerRequest: number;
  readonly timeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxToolCalls: 4,
  maxOutputTokens: 24_000,
  maxTokensPerRequest: 8_000,
  maxPromptTokensPerRequest: 80_000,
  timeoutMs: 60_000,
};

export type Exhausted = 'tool_calls' | 'tokens' | 'time' | 'context';

export class Budget {
  private readonly startedAt: number;
  private calls = 0;
  private outputTokens = 0;
  private lastPromptTokens = 0;

  constructor(
    readonly limits: Limits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  get toolCallsUsed(): number {
    return this.calls;
  }

  get toolCallsLeft(): number {
    return Math.max(0, this.limits.maxToolCalls - this.calls);
  }

  get msLeft(): number {
    return Math.max(0, this.limits.timeoutMs - (this.now() - this.startedAt));
  }

  /** Counts a tool call (a failed one too: it cost a round trip). */
  useToolCall(): void {
    this.calls += 1;
  }

  /** Adds one response's usage. `promptTokens` is everything the model read, cached or not. */
  addUsage(outputTokens: number, promptTokens: number): void {
    this.outputTokens += outputTokens;
    this.lastPromptTokens = promptTokens;
  }

  /** Which limit has been reached, if any. Checked before every request. */
  exhausted(): Exhausted | null {
    if (this.msLeft <= 0) return 'time';
    if (this.outputTokens >= this.limits.maxOutputTokens) return 'tokens';
    if (this.lastPromptTokens > this.limits.maxPromptTokensPerRequest) return 'context';
    return null;
  }

  /** `max_tokens` for the next request: the per-request cap, or what is left of the total. */
  nextMaxTokens(): number {
    return Math.max(
      1,
      Math.min(this.limits.maxTokensPerRequest, this.limits.maxOutputTokens - this.outputTokens),
    );
  }
}
