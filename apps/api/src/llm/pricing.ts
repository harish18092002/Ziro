// What a model call costs, in integer arithmetic: rates are micro-USD per million tokens (so $0.10 per
// million is 100_000) and the total is rounded UP to a whole micro-USD, so a daily budget can only overstate
// spend, never understate it. llm_calls.cost_usd is numeric(12,6), i.e. micro-USD precision.
//
// The rates come from LLM_PRICES, which the author fills from the providers' price pages. Nothing here
// knows a price. Two simplifications, both of which can only overstate:
//   - thinking tokens are priced as output tokens (Gemini and Claude both bill reasoning as output);
//   - a cache read or write with no rate of its own is priced as input.
// A provider that charges a higher rate above some prompt size is not modelled: if LLM_PRICES holds the
// base rate, a very long prompt is under-estimated, which is why the loop caps prompts well below that.
import type { LlmUsage } from '@ziro/core/llm';
import type { Rates } from './config.js';

export class PricingError extends Error {}

const MICRO = 1_000_000n;

export function estimateCostMicroUsd(rates: Rates, usage: LlmUsage): bigint {
  const scaled =
    BigInt(usage.inputTokens) * rates.input +
    BigInt(usage.outputTokens + usage.thoughtTokens) * rates.output +
    BigInt(usage.cacheWriteTokens) * (rates.cacheWrite ?? rates.input) +
    BigInt(usage.cacheReadTokens) * (rates.cacheRead ?? rates.input);
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
