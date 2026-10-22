import { addDaysToBusinessDate, isBusinessDate } from '@ziro/core/time';
import { z } from 'zod';
import { MAX_WINDOW_DAYS } from './razorpay-bundle.js';

const MAX_PERIOD_DAYS = 366;

const date = z.string().refine(isBusinessDate, {
  error: 'must be a real calendar date written YYYY-MM-DD (1970 or later)',
});

/** POST /runs. The Razorpay source is not a request field: the server's configuration decides it. */
export const createRunSchema = z
  .strictObject({ periodStart: date, periodEnd: date })
  .refine((run) => run.periodStart <= run.periodEnd, {
    error: 'periodStart must not be after periodEnd',
    path: ['periodEnd'],
  })
  .refine(
    (run) =>
      !isBusinessDate(run.periodStart) ||
      run.periodEnd <= addDaysToBusinessDate(run.periodStart, MAX_PERIOD_DAYS - 1),
    { error: `a run covers at most ${MAX_PERIOD_DAYS} days`, path: ['periodEnd'] },
  );
export type CreateRunInput = z.output<typeof createRunSchema>;

/** POST /runs/:id/import/razorpay. */
export const razorpayImportSchema = z
  .strictObject({ from: date, to: date })
  .refine((window) => window.from <= window.to, {
    error: 'from must not be after to',
    path: ['to'],
  })
  .refine(
    (window) =>
      !isBusinessDate(window.from) ||
      window.to <= addDaysToBusinessDate(window.from, MAX_WINDOW_DAYS - 1),
    { error: `a window covers at most ${MAX_WINDOW_DAYS} days`, path: ['to'] },
  );
export type RazorpayImportInput = z.output<typeof razorpayImportSchema>;
