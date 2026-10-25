// Pure arithmetic behind the charts and the count-up animations. No DOM, no React: tested on its own.
// Money stays integer paise (bigint) until the last step, a ratio for drawing, which is never shown as money.

/** Integer paise (or a count) from the API's digit string; anything else is zero, never a guess. */
export function toBig(text: string | null | undefined): bigint {
  return text !== null && text !== undefined && /^-?\d+$/.test(text) ? BigInt(text) : 0n;
}

/** part ÷ whole as a number in [0, 1], worked out in integers to the ten-thousandth; 0 for a non-positive whole. */
export function ratio(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const parts = (part * 10_000n) / whole;
  return Number(parts > 10_000n ? 10_000n : parts) / 10_000;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Fast start, gentle landing: the curve for every count-up and bar growth. */
export const easeOutCubic = (t: number): number => 1 - (1 - clamp01(t)) ** 3;

/** `target` scaled by progress `t` in [0, 1], in whole units: a count-up that never leaves integers. */
export function scaleBig(target: bigint, t: number): bigint {
  const k = BigInt(Math.round(clamp01(t) * 10_000));
  return (target * k) / 10_000n;
}

/** 1,284 · 12.9K · 4.2M: a count that has to fit in a small space. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(n / 1_000)}K`;
  return Math.round(n).toLocaleString('en-IN');
}
const trim = (n: number): string => n.toFixed(1).replace(/\.0$/, '');

/**
 * Relative widths for the segments of one stacked bar: whole numbers out of 10,000, so a flex row can share
 * the width in proportion. A segment with any value gets at least 1, so it never vanishes; an empty one gets 0.
 */
export function segmentWeights(values: readonly bigint[]): number[] {
  const total = values.reduce((sum, v) => (v > 0n ? sum + v : sum), 0n);
  return values.map((v) => (v <= 0n ? 0 : Math.max(1, Math.round(ratio(v, total) * 10_000))));
}

/** Does a label of `chars` characters fit inside a segment that is `share` of a bar `barPx` wide? */
export function labelFits(share: number, chars: number, barPx = 440): boolean {
  return share * barPx >= chars * 7.4 + 22;
}
