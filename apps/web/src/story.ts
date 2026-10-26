import { easeOutCubic } from './chart-math';

// The home page hero, as a timeline: ₹ packets leave the three sources and reach the ring; then each kind of
// mismatch is explained in turn (a chip pops in), the ring's figure counts DOWN from a real gap to ₹0.00, and the
// check mark pops last. Pure: given a time in the loop it says what is on screen, so it can be tested and so the
// reduced-motion picture is simply the timeline's final frame.

export const STORY = {
  loopMs: 10_000,
  packetMs: 1_400,
  /** When each packet leaves, and from which source (0 ledger, 1 Razorpay, 2 bank). */
  packets: [
    { source: 0, at: 300 },
    { source: 1, at: 500 },
    { source: 2, at: 700 },
    { source: 0, at: 1_900 },
    { source: 1, at: 2_100 },
    { source: 2, at: 2_300 },
  ],
  /** Each kind of mismatch explained, in order, and the share of the gap it accounts for (sums to 100). */
  steps: [
    { label: 'fee + GST', at: 2_400, weight: 35 },
    { label: 'T+2 batch', at: 3_800, weight: 40 },
    { label: 'UTR', at: 5_200, weight: 25 },
  ],
  stepMs: 900,
  checkAt: 6_300,
  /** Everything fades from here, and the loop starts again. */
  fadeAt: 9_300,
} as const;

/** A time where the whole story is told and nothing is fading: the reduced-motion picture. */
export const FINAL_T = 8_000;

/** How far a packet has travelled (0 to 1), or null when it is not on its way. */
export function packetProgress(t: number, at: number): number | null {
  const p = (t - at) / STORY.packetMs;
  return p >= 0 && p <= 1 ? p : null;
}

/** The paise each step explains: integer shares of the gap, the last one taking the remainder so they sum exactly. */
export function stepChunks(gap: bigint): bigint[] {
  const size = gap < 0n ? -gap : gap;
  const chunks = STORY.steps.map((s) => (size * BigInt(s.weight)) / 100n);
  const rest = size - chunks.reduce((a, b) => a + b, 0n);
  chunks[chunks.length - 1] = (chunks[chunks.length - 1] ?? 0n) + rest;
  return chunks;
}

/** Paise still unexplained at time t: the gap, falling step by step, exactly 0 once the last step is done. */
export function remainingPaise(gap: bigint, t: number): bigint {
  const size = gap < 0n ? -gap : gap;
  const chunks = stepChunks(gap);
  let explained = 0n;
  STORY.steps.forEach((s, i) => {
    const chunk = chunks[i] ?? 0n;
    const p = Math.min(1, Math.max(0, (t - s.at) / STORY.stepMs));
    if (p >= 1) explained += chunk;
    else if (p > 0) explained += (chunk * BigInt(Math.floor(easeOutCubic(p) * 1000))) / 1000n;
  });
  return size - explained;
}

/** The share of the gap explained at time t, for the ring's arc (0 to 1). */
export function explainedShare(gap: bigint, t: number): number {
  const size = gap < 0n ? -gap : gap;
  if (size === 0n) return 1;
  return Number(((size - remainingPaise(gap, t)) * 10_000n) / size) / 10_000;
}

/** How many mismatch chips are showing. */
export const stepsShown = (t: number): number => STORY.steps.filter((s) => t >= s.at).length;

export const checkShown = (t: number): boolean => t >= STORY.checkAt;

/** Everything fades out at the end of the loop, before it starts again. */
export const fading = (t: number): boolean => t >= STORY.fadeAt;
