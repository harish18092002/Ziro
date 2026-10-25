import { z } from 'zod';
import { MIN_TOKEN_LENGTH } from '../auth/session.js';
import { type Parsed, parseChain, parseLimits, parsePrices } from '../llm/config.js';

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

// The largest CSV upload accepted. 25 MiB holds the ~100k-row stress preset with room to spare.
const DEFAULT_IMPORT_MAX_BYTES = '26214400';
const importMaxBytes = z.preprocess(
  (value) => blankToUndefined(value) ?? DEFAULT_IMPORT_MAX_BYTES,
  z
    .string()
    .trim()
    .regex(/^\d{1,9}$/, 'must be a whole number of bytes')
    .transform(Number)
    .refine((value) => value >= 1024 && value <= 104_857_600, 'must be between 1 KiB and 100 MiB'),
);

/** A true/false setting that may be left out, with the value it then takes. */
const optionalFlag = (fallback: 'true' | 'false') =>
  z.preprocess((value) => blankToUndefined(value) ?? fallback, flag);

/** A whole number in [min, max] that may be left out. */
const boundedInt = (fallback: string, min: number, max: number) =>
  z.preprocess(
    (value) => blankToUndefined(value) ?? fallback,
    z
      .string()
      .trim()
      .regex(/^\d{1,6}$/, 'must be a whole number')
      .transform(Number)
      .refine((n) => n >= min && n <= max, `must be between ${min} and ${max}`),
  );

/** A number from 0 to 1 (a confidence) that may be left out, with the value it then takes. */
const unitInterval = (fallback: string) =>
  z.preprocess(
    (value) => blankToUndefined(value) ?? fallback,
    z
      .string()
      .trim()
      .regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, 'must be a number from 0 to 1, such as 0.85')
      .transform(Number),
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

/** A setting written as text that one of the llm/config.ts parsers turns into a value; blank means "not set". */
const parsedText = <T>(parse: (raw: string | undefined) => Parsed<T>) =>
  z.preprocess(blankToUndefined, z.string().optional()).transform((raw, ctx) => {
    const result = parse(raw);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.error });
      return z.NEVER;
    }
    return result.value;
  });

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
    IMPORT_MAX_BYTES: importMaxBytes,
    DATABASE_URL: z
      .string({ error: requiredError('must be a postgres:// or postgresql:// URL') })
      .trim()
      .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// URL'),
    REDIS_URL: z
      .string({ error: requiredError('must be a redis:// or rediss:// URL') })
      .trim()
      .regex(/^rediss?:\/\/\S+$/, 'must be a redis:// or rediss:// URL'),
    // A directory written by `npm run datagen`: what RAZORPAY_SOURCE=synthetic reads. Test mode never
    // reads it (ADR-019: it does not top itself up with generated data).
    SYNTHETIC_DATA_DIR: text,
    RAZORPAY_SOURCE: z.enum(['synthetic', 'testmode'], {
      error: requiredError('must be "synthetic" or "testmode"'),
    }),
    RAZORPAY_KEY_ID: razorpayKeyId,
    RAZORPAY_KEY_SECRET: optionalSecret,
    // Optional, like the Gemini key: Claude is a fallback, and an Anthropic account with no credit must not
    // stop the app. A chain entry without its key is dropped with a warning at boot.
    ANTHROPIC_API_KEY: optionalSecret,
    // single-shot = the harness gathers the evidence and makes one structured call; loop = the model drives
    // read-only tools (LLM_MAX_TOOL_CALLS). Same tools, verifier and checks either way (ADR-018).
    AGENT_HARNESS: z.preprocess(
      (value) => blankToUndefined(value) ?? 'single-shot',
      z.enum(['loop', 'single-shot'], { error: 'must be "loop" or "single-shot"' }),
    ),
    // --- the model layer (ADR-018) -------------------------------------------------------------------
    // The Gemini key is optional at boot like the Anthropic one: with no usable provider the agent is off,
    // and the rules, the review console and the replay keep working.
    GEMINI_API_KEY: optionalSecret,
    // free = Google may use what is sent and the key has daily request limits; the actual cost is $0.
    GEMINI_TIER: z.preprocess(
      (value) => blankToUndefined(value) ?? 'free',
      z.enum(['free', 'paid'], { error: 'must be "free" or "paid"' }),
    ),
    // Models in the order they are tried: gemini:<id>,gemini:<id>,anthropic:<id>. No ids in code.
    LLM_CHAIN: parsedText(parseChain),
    // Free-tier request limits per model, copied from aistudio.google.com/rate-limit. Never guessed.
    GEMINI_LIMITS: parsedText(parseLimits),
    // Paid list prices per provider:model, for the "estimated cost at paid prices" column.
    LLM_PRICES: parsedText(parsePrices),
    // off = every call goes to the provider; record = also keep the answers; replay = answers from the
    // cache only, and a call that is not in it fails loudly.
    LLM_CACHE: z.preprocess(
      (value) => blankToUndefined(value) ?? 'off',
      z.enum(['off', 'record', 'replay'], { error: 'must be off, record or replay' }),
    ),
    // Tool calls one investigation may make in the loop harness (the single-shot harness makes none).
    LLM_MAX_TOOL_CALLS: boundedInt('4', 1, 16),
    // The longest the router waits on a rate limit before it moves to the next model.
    LLM_MAX_WAIT_SECONDS: boundedInt('30', 0, 600),
    AUTO_ACCEPT_ENABLED: flag,
    AUTO_ACCEPT_MAX_PAISE: paise,
    // Auto-accept needs at least this much confidence from the agent, on top of every other condition.
    AUTO_ACCEPT_MIN_CONFIDENCE: unitInterval('0.85'),
    DEMO_MODE: flag,
    DAILY_LLM_BUDGET_USD: usd,
    AGENT_KILL_SWITCH: flag,
    // Investigate related exceptions (same candidates) in one conversation instead of one each.
    CLUSTER_EXCEPTIONS: optionalFlag('false'),
    // Give an unsure answer one second look from the NEXT model in LLM_CHAIN. Off by default: on the free tier
    // every extra look spends the scarce daily requests, and fallback (availability) is a separate thing.
    AGENT_ESCALATION: optionalFlag('false'),
    // Build the featured demo and eval runs in the background at boot if they are missing.
    DEMO_SEED_ON_BOOT: optionalFlag('true'),
    // Run the investigation worker inside this process. Turn off to only enqueue.
    AGENT_WORKER_ENABLED: optionalFlag('true'),
    // Investigations running at once. Each holds one model request open at a time.
    AGENT_CONCURRENCY: boundedInt('4', 1, 32),
    // Public demo limits (DEMO_MODE). Per client address, per rolling hour; 0 refuses all. The limiter keeps
    // its counts in this process, so they are exact only with one instance (docs/DEPLOY.md: max-instances 1).
    DEMO_LIVE_RUNS_PER_IP_HOUR: boundedInt('5', 0, 1000),
    DEMO_LIVE_RUNS_PER_HOUR: boundedInt('30', 0, 10_000),
    DEMO_RUNS_PER_IP_HOUR: boundedInt('20', 0, 1000),
    DEMO_RUNS_PER_HOUR: boundedInt('200', 0, 10_000),
    // json = pino's default fields; gcp = Cloud Logging's (severity, message, trace).
    LOG_FORMAT: z.preprocess(
      (value) => blankToUndefined(value) ?? 'json',
      z.enum(['json', 'gcp'], { error: 'must be "json" or "gcp"' }),
    ),
    LOG_LEVEL: z.preprocess(
      (value) => blankToUndefined(value) ?? 'info',
      z.enum(['debug', 'info', 'warn', 'error'], { error: 'must be debug, info, warn or error' }),
    ),
    // Used only to build the trace field of a gcp log line.
    GCP_PROJECT_ID: optionalSecret,
    // Optional. When set (and this is not the public demo), every API call needs it: a private deployment's
    // single shared password. Unset, a laptop stays open. See auth/admin.guard.ts.
    ADMIN_TOKEN: optionalSecret,
  })
  .superRefine((env, ctx) => {
    if (env.ADMIN_TOKEN !== undefined) {
      if (env.ADMIN_TOKEN.length < MIN_TOKEN_LENGTH) {
        ctx.addIssue({
          code: 'custom',
          path: ['ADMIN_TOKEN'],
          message: `must be at least ${MIN_TOKEN_LENGTH} characters, or left empty`,
        });
      }
      if (env.DEMO_MODE) {
        ctx.addIssue({
          code: 'custom',
          path: ['ADMIN_TOKEN'],
          message:
            'has no effect while DEMO_MODE=true (the public demo is open by design): unset one of them',
        });
      }
    }
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
