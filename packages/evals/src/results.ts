// What one eval run writes down. One JSON file per (preset, seed, config, leg), holding every repeat,
// so EVALS.md can be rebuilt from the files alone, for free, and a single config can be re-run without
// touching the others. Money is whole micro-USD (1 USD = 1,000,000), never a float of dollars; rupees
// are integer paise as strings.
import { z } from 'zod';

export const CONFIGS = ['rules', 'small', 'large', 'harnessB'] as const;
export type ConfigName = (typeof CONFIGS)[number];
export const LEGS = ['plain', 'attacked'] as const;
export type LegName = (typeof LEGS)[number];

export const CONFIG_LABEL: Record<ConfigName, string> = {
  rules: 'rules only',
  small: 'rules + agent, small model (harness A)',
  large: 'rules + agent, large model (harness A)',
  harnessB: 'rules + agent, Claude Agent SDK (harness B)',
};

const rate = z.number().nullable();

const groupScoreSchema = z.object({
  truthGroups: z.number(),
  exact: z.number(),
  partial: z.number(),
  matchRate: rate,
  matchRateWithPartial: rate,
  byKind: z.object({
    order: z.object({ truth: z.number(), exact: z.number(), partial: z.number() }),
    payout: z.object({ truth: z.number(), exact: z.number(), partial: z.number() }),
  }),
  accepted: z.object({ total: z.number(), rule: z.number(), agent: z.number() }),
  incomplete: z.number(),
  falseMatches: z.number(),
  falseMatchExamples: z.array(
    z.object({
      groupId: z.string(),
      origin: z.enum(['rule', 'agent']),
      keys: z.array(z.string()),
      homes: z.array(z.string()),
    }),
  ),
  precision: rate,
  exactShare: rate,
  agentAdded: z.object({ accepted: z.number(), exact: z.number(), falseMatches: z.number() }),
});

const reasonScoreSchema = z.object({
  handled: z.number(),
  concluded: z.number(),
  abstained: z.number(),
  correct: z.number(),
  accuracy: rate,
  accuracyConcluded: rate,
  byExpected: z.record(z.string(), z.object({ n: z.number(), correct: z.number() })),
  wrong: z.array(
    z.object({
      exceptionId: z.string(),
      subjectKey: z.string(),
      expected: z.array(z.string()),
      got: z.string(),
    }),
  ),
});

const injectionCaseSchema = z.object({
  key: z.string(),
  style: z.string(),
  /** The payload text actually appeared in a tool result during the investigation. */
  exposed: z.boolean(),
  followed: z.boolean(),
  reasons: z.array(z.string()),
  quoted: z.boolean(),
  flagged: z.boolean(),
});

const runSchema = z.object({
  config: z.enum(CONFIGS),
  leg: z.enum(LEGS),
  repeat: z.number().int().min(1),
  clusterExceptions: z.boolean(),
  harness: z.enum(['loop', 'agent-sdk']).nullable(),
  model: z.string().nullable(),
  /** The cost cap was hit, or the run stopped early; its numbers are partial. */
  incomplete: z.boolean(),
  incompleteReason: z.string().nullable(),
  startedAt: z.string(),
  durationMs: z.number(),
  orders: z.number(),
  exceptions: z.object({ total: z.number(), handled: z.number(), skipped: z.number() }),
  groups: groupScoreSchema,
  reasonCodes: reasonScoreSchema.nullable(),
  verifier: z.object({
    proposals: z.number(),
    passed: z.number(),
    rejected: z.number(),
    notApplicable: z.number(),
    rejectedExamples: z.array(
      z.object({
        subjectKey: z.string(),
        reasonCode: z.string(),
        findings: z.array(z.string()),
      }),
    ),
  }),
  /** Verified agent matches a simulated reviewer approved. */
  simulatedApprovals: z.number(),
  gap: z.object({
    /** Only the rules and verified, approved agent matches settle. */
    strictPaise: z.string(),
    /** Also counts every unrefused explanation as agreed to by a person: an upper bound. */
    optimisticPaise: z.string(),
  }),
  injection: z
    .object({
      planted: z.number(),
      exposed: z.number(),
      followed: z.number(),
      flaggedByAgent: z.number(),
      cases: z.array(injectionCaseSchema),
    })
    .nullable(),
  cost: z.object({
    totalMicroUsd: z.number(),
    per1kOrdersMicroUsd: z.number(),
    llmCalls: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
    /** What the Agent SDK itself estimated, for comparison; null for harness A. */
    sdkReportedMicroUsd: z.number().nullable(),
  }),
  latency: z.object({
    investigations: z.number(),
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    meanMs: z.number().nullable(),
  }),
});
export type RunRecord = z.output<typeof runSchema>;

export const resultFileSchema = z.object({
  schemaVersion: z.literal(1),
  preset: z.string(),
  seed: z.number().int(),
  config: z.enum(CONFIGS),
  leg: z.enum(LEGS),
  /** The CLUSTER_EXCEPTIONS variant (related exceptions in one conversation). */
  clusterExceptions: z.boolean(),
  generatedAt: z.string(),
  versions: z.object({
    node: z.string(),
    agentSdk: z.string().nullable(),
    models: z.object({ small: z.string(), large: z.string() }),
  }),
  runs: z.array(runSchema).min(1),
});
export type ResultFile = z.output<typeof resultFileSchema>;

export const stressFileSchema = z.object({
  schemaVersion: z.literal(1),
  preset: z.literal('stress'),
  seed: z.number().int(),
  generatedAt: z.string(),
  inputRows: z.number(),
  /** One entry per timed run. */
  milliseconds: z.array(z.number()),
  rowsPerSecond: z.array(z.number()),
  exceptions: z.number(),
  groups: z.number(),
});
export type StressFile = z.output<typeof stressFileSchema>;
