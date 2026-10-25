// Builders for result records, for the tests of everything that reads them.
import type { ResultFile, RunRecord } from './results.js';
import type { GroupScore } from './score.js';

export const emptyGroups = (over: Partial<GroupScore> = {}): GroupScore => ({
  truthGroups: 100,
  exact: 90,
  partial: 2,
  matchRate: 0.9,
  matchRateWithPartial: 0.92,
  byKind: {
    order: { truth: 80, exact: 72, partial: 2 },
    payout: { truth: 20, exact: 18, partial: 0 },
  },
  accepted: { total: 92, rule: 90, agent: 2 },
  incomplete: 2,
  falseMatches: 0,
  falseMatchExamples: [],
  precision: 1,
  exactShare: 0.978,
  agentAdded: { accepted: 2, exact: 2, falseMatches: 0 },
  ...over,
});

export function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    config: 'lite-single',
    leg: 'plain',
    repeat: 1,
    clusterExceptions: false,
    harness: 'single-shot',
    provider: 'gemini',
    model: 'lite-model',
    cache: 'off',
    sample: null,
    incomplete: false,
    incompleteReason: null,
    startedAt: '2026-10-23T10:00:00.000Z',
    durationMs: 60_000,
    orders: 500,
    exceptions: { total: 104, handled: 58, skipped: 46 },
    groups: emptyGroups(),
    reasonCodes: {
      handled: 58,
      concluded: 50,
      abstained: 8,
      correct: 40,
      accuracy: 40 / 58,
      accuracyConcluded: 0.8,
      byExpected: {
        LEDGER_AMOUNT_EDITED: { n: 10, correct: 9 },
        UNKNOWN: { n: 48, correct: 31 },
      },
      wrong: [],
    },
    verifier: {
      proposals: 58,
      passed: 5,
      rejected: 2,
      notApplicable: 51,
      rejectedExamples: [
        {
          subjectKey: 'ledger_entry:ORD-100001',
          reasonCode: 'UNKNOWN',
          findings: ['AMOUNT_MISMATCH: the ledger totals 100 paise but payments total 99'],
        },
      ],
    },
    simulatedApprovals: 3,
    gap: { strictPaise: '2041908900', optimisticPaise: '1500000000' },
    injection: null,
    cost: {
      totalMicroUsd: 250_000,
      per1kOrdersMicroUsd: 500_000,
      llmCalls: 300,
      tokens: { input: 900_000, output: 90_000, cacheRead: 400_000, cacheWrite: 50_000 },
      estPaidMicroUsd: 250_000,
      requests: 58,
      requestsPer1kOrders: 116,
      replayed: 0,
      fallbacks: 0,
      quotaUsedOfDay: 0.058,
    },
    latency: { investigations: 58, p50Ms: 12_000, p95Ms: 30_000, meanMs: 14_000 },
    ...over,
  };
}

export function makeFile(
  over: Partial<ResultFile> = {},
  runs: RunRecord[] = [makeRun()],
): ResultFile {
  return {
    schemaVersion: 2,
    preset: 'eval',
    seed: 42,
    config: 'lite-single',
    leg: 'plain',
    clusterExceptions: false,
    generatedAt: '2026-10-23T10:00:00.000Z',
    versions: {
      node: 'v24.21.0',
      models: { lite: 'lite-model', flash: 'flash-model', claude: null },
    },
    runs,
    ...over,
  };
}
