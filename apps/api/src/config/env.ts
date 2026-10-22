import { z } from 'zod';

/** Thrown at boot when the environment is unusable. Messages never contain variable values. */
export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'EnvValidationError';
  }
}

const requiredError = (expected: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? 'is required' : expected;

/** A blank value in .env (`RAZORPAY_KEY_ID=`) means "not set". */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const text = z
  .string({ error: requiredError('must be a string') })
  .trim()
  .min(1, 'must not be empty');

const flag = z
  .enum(['true', 'false'], { error: requiredError('must be "true" or "false"') })
  .transform((value) => value === 'true');

const optionalSecret = z.preprocess(blankToUndefined, z.string().trim().optional());

const port = z.preprocess(
  (value) => blankToUndefined(value) ?? '3000',
  z
    .string()
    .trim()
    .regex(/^\d{1,5}$/, 'must be a port number')
    .transform(Number)
    .refine((value) => value >= 1 && value <= 65535, 'must be between 1 and 65535'),
);

// Paise are integers end to end (CLAUDE.md §4.1): a decimal here is a bug, not a rounding case.
const paise = z
  .string({ error: requiredError('must be a non-negative integer number of paise') })
  .trim()
  .regex(/^\d+$/, 'must be a non-negative integer number of paise (no decimals)')
  .transform((value) => BigInt(value));

// A USD spend cap for LLM calls, not merchant money, so a 2dp decimal number is fine.
const usd = z
  .string({ error: requiredError('must be a USD amount such as 5 or 5.00') })
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'must be a USD amount such as 5 or 5.00')
  .transform(Number);

// Field-level on purpose: the live-key guard must fire even when other variables are also invalid.
const razorpayKeyId = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine((value) => !/^rzp_live_/i.test(value), {
      error: 'live keys (rzp_live_*) are forbidden: Ziro is Razorpay test mode only',
    })
    .optional(),
);

export const envSchema = z
  .object({
    PORT: port,
    DATABASE_URL: z
      .string({ error: requiredError('must be a postgres:// or postgresql:// URL') })
      .trim()
      .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL'),
    REDIS_URL: z
      .string({ error: requiredError('must be a redis:// or rediss:// URL') })
      .trim()
      .regex(/^rediss?:\/\/\S+$/, 'must be a redis:// or rediss:// URL'),
    RAZORPAY_SOURCE: z.enum(['synthetic', 'testmode'], {
      error: requiredError('must be "synthetic" or "testmode"'),
    }),
    RAZORPAY_KEY_ID: razorpayKeyId,
    RAZORPAY_KEY_SECRET: optionalSecret,
    // Optional at boot: the free demo replay must work with no key. Checked when a run starts.
    ANTHROPIC_API_KEY: optionalSecret,
    AGENT_MODEL_SMALL: text,
    AGENT_MODEL_LARGE: text,
    AGENT_HARNESS: z.enum(['loop', 'agent-sdk'], {
      error: requiredError('must be "loop" or "agent-sdk"'),
    }),
    AUTO_ACCEPT_ENABLED: flag,
    AUTO_ACCEPT_MAX_PAISE: paise,
    DEMO_MODE: flag,
    DAILY_LLM_BUDGET_USD: usd,
    AGENT_KILL_SWITCH: flag,
  })
  .superRefine((env, ctx) => {
    if (env.RAZORPAY_SOURCE !== 'testmode') return;
    if (!env.RAZORPAY_KEY_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['RAZORPAY_KEY_ID'],
        message: 'is required when RAZORPAY_SOURCE=testmode',
      });
    } else if (!env.RAZORPAY_KEY_ID.startsWith('rzp_test_')) {
      ctx.addIssue({
        code: 'custom',
        path: ['RAZORPAY_KEY_ID'],
        message: 'must start with rzp_test_ (test mode only)',
      });
    }
    if (!env.RAZORPAY_KEY_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['RAZORPAY_KEY_SECRET'],
        message: 'is required when RAZORPAY_SOURCE=testmode',
      });
    }
  });

export type Env = z.output<typeof envSchema>;

/** Validates the environment once, at boot. Throws EnvValidationError listing every problem. */
export function loadEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = envSchema.safeParse({ ...source });
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
