// The date windows a run is judged by: the same numbers for the rule matcher and the verifier. A run
// carries a snapshot of them in its config, so a proposal is checked against the windows in force when
// the run was made, not whatever the code defaults to today (the same idea as the fee contract).
import { DEFAULT_MATCHER_CONFIG } from '@ziro/core/matcher';
import { DEFAULT_ORDER_DATE_WINDOW_DAYS, type VerifierConfig } from '@ziro/core/verify';
import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const windowsSchema = z
  .strictObject({
    /** 0 = Sunday ... 6 = Saturday. */
    weekendDays: z.array(z.number().int().min(0).max(6)).max(7),
    holidays: z.array(date).max(3_000),
    /** T4: a credit lands within this many business days after the settlement date. */
    windowBusinessDays: z.number().int().min(0).max(30),
    settlementLagBusinessDays: z.number().int().min(0).max(30),
    delayHorizonBusinessDays: z.number().int().min(0).max(60),
    /** A regular expression whose group 1 is the original order reference, or null. */
    retryReceiptPattern: z.string().max(200).nullable(),
    dateShiftWindowMinutes: z.number().int().min(0).max(1_440),
    orderDateWindowDays: z.number().int().min(0).max(30),
  })
  .refine(
    (w) => {
      if (w.retryReceiptPattern === null) return true;
      try {
        new RegExp(w.retryReceiptPattern);
        return true;
      } catch {
        return false;
      }
    },
    {
      error: 'retryReceiptPattern is not a valid regular expression',
      path: ['retryReceiptPattern'],
    },
  );
export type Windows = z.output<typeof windowsSchema>;

export const DEFAULT_WINDOWS: Windows = {
  weekendDays: [...DEFAULT_MATCHER_CONFIG.calendar.weekendDays],
  holidays: [...DEFAULT_MATCHER_CONFIG.calendar.holidays],
  windowBusinessDays: DEFAULT_MATCHER_CONFIG.windowBusinessDays,
  settlementLagBusinessDays: DEFAULT_MATCHER_CONFIG.settlementLagBusinessDays,
  delayHorizonBusinessDays: DEFAULT_MATCHER_CONFIG.delayHorizonBusinessDays,
  retryReceiptPattern: DEFAULT_MATCHER_CONFIG.retryReceiptPattern?.source ?? null,
  dateShiftWindowMinutes: DEFAULT_MATCHER_CONFIG.dateShiftWindowMinutes,
  orderDateWindowDays: DEFAULT_ORDER_DATE_WINDOW_DAYS,
};

export function toVerifierConfig(w: Windows): VerifierConfig {
  return {
    calendar: { weekendDays: w.weekendDays, holidays: new Set(w.holidays) },
    windowBusinessDays: w.windowBusinessDays,
    settlementLagBusinessDays: w.settlementLagBusinessDays,
    delayHorizonBusinessDays: w.delayHorizonBusinessDays,
    retryReceiptPattern: w.retryReceiptPattern === null ? null : new RegExp(w.retryReceiptPattern),
    dateShiftWindowMinutes: w.dateShiftWindowMinutes,
    orderDateWindowDays: w.orderDateWindowDays,
  };
}

/** The windows stored on a run, or the defaults (flagged) when the run predates the snapshot. */
export function verifierConfigOf(runConfig: unknown): {
  config: VerifierConfig;
  windows: Windows;
  source: 'run' | 'default';
} {
  const stored = (runConfig as { windows?: unknown } | null)?.windows;
  const parsed = windowsSchema.safeParse(stored);
  const windows = parsed.success ? parsed.data : DEFAULT_WINDOWS;
  return { config: toVerifierConfig(windows), windows, source: parsed.success ? 'run' : 'default' };
}
