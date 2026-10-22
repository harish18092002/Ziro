// What a model call costs. Integer arithmetic: rates are micro-USD per million tokens (so $0.10 per
// million tokens is 100_000), the total is rounded UP to a whole micro-USD, and it is stored in
// llm_calls.cost_usd (numeric(12,6), i.e. micro-USD precision). Rounding up means the daily budget
// guard can only overstate spend, never understate it.
//
// Rates are from Anthropic's published pricing page (checked 2026-10-22), for prompts up to 100K
// tokens. A larger prompt is billed at a higher tier whose rates are not in this table, so pricing
// one throws: the loop keeps every call far below that line, and an unexpected one must be loud.
export interface Rates {
  readonly input: bigint;
  readonly output: bigint;
  /** Writing a prompt prefix to the 5-minute cache. */
  readonly cacheWrite: bigint;
  readonly cacheRead: bigint;
}

export const PRICED_PROMPT_LIMIT = 100_000;

const RATES: ReadonlyArray<readonly [string, Rates]> = [
  [
    'claude-haiku-5-5',
    { input: 100_000n, output: 500_000n, cacheWrite: 125_000n, cacheRead: 10_000n },
  ],
  [
    'claude-sonnet-5-5',
    { input: 2_000_000n, output: 10_000_000n, cacheWrite: 2_500_000n, cacheRead: 100_000n },
  ],
];

export interface Usage {
  /** Input tokens that were not served from, or written to, the cache. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export class PricingError extends Error {}

/** Rates for a model id; dated snapshots (`claude-haiku-5-5-20261001`) price like the model. */
export function ratesFor(model: string): Rates | undefined {
  return RATES.find(([id]) => model === id || model.startsWith(`${id}-`))?.[1];
}

export const totalPromptTokens = (u: Usage): number =>
  u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

const MICRO = 1_000_000n;

/** The cost of one call in micro-USD, rounded up. */
export function costMicroUsd(model: string, usage: Usage): bigint {
  const rates = ratesFor(model);
  if (rates === undefined) {
    throw new PricingError(`no price is known for model "${model}"; add it to agent/pricing.ts`);
  }
  if (totalPromptTokens(usage) > PRICED_PROMPT_LIMIT) {
    throw new PricingError(
      `a ${totalPromptTokens(usage)}-token prompt is above the ${PRICED_PROMPT_LIMIT}-token tier this table prices`,
    );
  }
  const scaled =
    BigInt(usage.inputTokens) * rates.input +
    BigInt(usage.outputTokens) * rates.output +
    BigInt(usage.cacheWriteTokens) * rates.cacheWrite +
    BigInt(usage.cacheReadTokens) * rates.cacheRead;
  return (scaled + MICRO - 1n) / MICRO;
}

/** micro-USD as the decimal string numeric(12,6) stores: 2825 -> "0.002825". */
export function formatMicroUsd(micro: bigint): string {
  if (micro < 0n) throw new PricingError('a cost cannot be negative');
  const whole = micro / MICRO;
  const fraction = (micro % MICRO).toString().padStart(6, '0');
  return `${whole}.${fraction}`;
}

/** Parses what formatMicroUsd wrote (or Postgres returns for numeric(12,6)) back to micro-USD. */
export function parseMicroUsd(text: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (match === null) throw new PricingError(`not a USD amount: "${text}"`);
  return BigInt(match[1] ?? '0') * MICRO + BigInt((match[2] ?? '').padEnd(6, '0'));
}
