// What a run is missing from Razorpay, as stored on the run (config.razorpay) and read back for the run
// view, the report and the console. The latest Razorpay import decides: a later import that gets
// everything clears it, because rows already imported never change (ON CONFLICT DO NOTHING) and the
// second import only fills what was absent.
import { z } from 'zod';
import type { Gap } from './razorpay-bundle.js';

export const gapSchema = z.object({
  entity: z.enum(['payments', 'refunds', 'settlements', 'settlement_recon']),
  kind: z.enum(['not_fetched', 'cut_short', 'days_missing']),
  detail: z.string(),
  days: z.array(z.string()),
}) satisfies z.ZodType<Gap>;

/** What goes into `reconRuns.config` after a Razorpay import. */
export function razorpayConfigOf(gaps: readonly Gap[]): {
  razorpay: { partial: boolean; gaps: Gap[] };
} {
  return { razorpay: { partial: gaps.length > 0, gaps: [...gaps] } };
}

/** The gaps a run records; none for a run that never imported from Razorpay, or an unreadable config. */
export function gapsOf(config: unknown): Gap[] {
  const razorpay = (config as { razorpay?: { gaps?: unknown } } | null | undefined)?.razorpay;
  const parsed = z.array(gapSchema).safeParse(razorpay?.gaps ?? []);
  return parsed.success ? parsed.data : [];
}
