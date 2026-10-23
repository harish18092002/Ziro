// The only statistics the eval reports: mean and min-max over a handful of repeats, and nearest-rank
// percentiles over many investigations. Three repeats do not support confidence intervals or
// significance claims, and nothing here pretends to.

export interface Summary {
  readonly n: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Mean, minimum and maximum; null for no data (so a missing run is never shown as zero). */
export function summarize(xs: readonly number[]): Summary | null {
  if (xs.length === 0) return null;
  return { n: xs.length, mean: mean(xs), min: Math.min(...xs), max: Math.max(...xs) };
}

/** Nearest-rank percentile: the smallest value at or above p percent of the data. NaN for no data. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile must be 0 to 100, got ${p}`);
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

/** A ratio that is null, not NaN or Infinity, when there is nothing to divide by. */
export const ratio = (part: number, whole: number): number | null =>
  whole === 0 ? null : part / whole;
