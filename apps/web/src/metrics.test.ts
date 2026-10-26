import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Overview, Progress } from './api';
import overviewFixture from './fixtures/overview.eval-replay.json';
import progressFixture from './fixtures/progress.eval-replay.json';
import {
  evalFacts,
  exceptionsLeft,
  falseMatches,
  groupsProved,
  ordersInRun,
  ordersMatched,
  proposalsMade,
  proposalsRefused,
  settledBy,
  truthFoundExactly,
  waitingForYou,
} from './metrics';

// The replay run's report (GET /runs/:id/overview and /progress of the featured 500-order run) as the API returns
// it. apps/api's report.books.test.ts checks that the same run, rebuilt from scratch, reports the numbers in the
// stored eval result; this file checks that the home page shows exactly those numbers.
const overview = overviewFixture as unknown as Overview;
const progress = progressFixture as unknown as Progress;
const stored = JSON.parse(
  readFileSync(
    new URL('../../../packages/evals/results/eval-42/rules-plain.json', import.meta.url),
    'utf8',
  ),
) as { seed: number; runs: { orders: number; exceptions: { total: number; handled: number } }[] };
const facts = evalFacts();

describe('the replay fixture is the run the stored eval result describes', () => {
  it('same orders, the same groups and exceptions, the same gap', () => {
    expect(overview.sources.ledger.records).toBe(facts.run.orders);
    expect(overview.resolution.ruleGroups).toBe(facts.run.groups.accepted.rule);
    expect(overview.exceptionsByReason.reduce((n, r) => n + r.total, 0)).toBe(
      facts.run.exceptions.total,
    );
    expect(overview.gap.gapPaise).toBe(facts.run.gap.strictPaise);
    expect(progress.expected).toBe(facts.run.exceptions.handled);
  });
});

describe('the home page numbers', () => {
  it('orders in the run', () => {
    expect(ordersInRun(overview).value).toBe('500');
  });

  it('orders matched names its denominator, so 95.0% and 97.4% cannot be confused', () => {
    const m = ordersMatched(overview);
    expect(m.value).toBe('95.0%');
    expect(m.of).toBe('475 of 500 orders');
    expect(m.how).toMatch(/every one of these matches was made by the rules/);
  });

  it('groups proved by code, and exceptions left', () => {
    expect(groupsProved(overview).value).toBe('523');
    expect(exceptionsLeft(overview).value).toBe('104');
  });

  it('answer-key accuracy comes from the stored eval result, with its denominator', () => {
    const m = truthFoundExactly();
    expect(m.value).toBe('97.4%');
    expect(m.of).toBe('520 of 534 groups');
    expect(m.how).toContain(`seed ${stored.seed}`);
    expect(m.how).toContain('identical over 3 runs');
  });

  it('false matches are counted against the groups accepted', () => {
    const m = falseMatches();
    expect(m.value).toBe('0');
    expect(m.of).toBe('in 523 groups accepted');
  });

  it('the agent and checker figures come from the run, not a typed number', () => {
    expect(proposalsMade(progress).value).toBe('58');
    expect(proposalsRefused(progress).value).toBe('2');
    expect(proposalsRefused(progress).how).toMatch(/plants on purpose/);
    expect(waitingForYou(overview).value).toBe('56');
  });

  it('every figure counts up to exactly what it shows, and says how it is counted', () => {
    const all = [
      ordersInRun(overview),
      ordersMatched(overview),
      groupsProved(overview),
      exceptionsLeft(overview),
      truthFoundExactly(),
      falseMatches(),
      proposalsMade(progress),
      proposalsRefused(progress),
      waitingForYou(overview),
    ];
    for (const m of all) {
      expect(m.format(m.n)).toBe(m.value);
      expect(m.how.length).toBeGreaterThan(40);
    }
  });
});

describe('evalFacts', () => {
  it('refuses a result with no runs instead of showing a made-up number', () => {
    expect(() => evalFacts({ seed: 1, preset: 'eval', runs: [] })).toThrow(/no runs/);
  });

  it('says when repeats disagree', () => {
    const [run] = stored.runs as never[];
    const other = JSON.parse(JSON.stringify(run)) as { groups: { exact: number } };
    other.groups.exact -= 1;
    const mixed = evalFacts({ seed: 42, preset: 'eval', runs: [run, other] as never[] });
    expect(mixed.identical).toBe(false);
    expect(truthFoundExactly(mixed).how).not.toContain('identical');
  });
});

describe('settledBy', () => {
  const withResolution = (r: Partial<Overview['resolution']>): Overview => ({
    ...overview,
    resolution: { ...overview.resolution, ...r },
  });

  it('is "approved by you" when people approved, or nothing was settled yet', () => {
    expect(settledBy(overview)).toEqual({ state: 'you', label: 'Approved by you' });
    expect(settledBy(withResolution({ agentMatchesApprovedByPerson: 2 })).state).toBe('you');
  });

  it('is a verified AI explanation when only the auto-accept policy settled things', () => {
    expect(settledBy(withResolution({ autoAccepted: 3 }))).toEqual({
      state: 'ai',
      label: 'Verified AI explanation',
    });
  });

  it('says both when both happened', () => {
    expect(
      settledBy(withResolution({ autoAccepted: 1, agentExplanationsApprovedByPerson: 1 })).label,
    ).toBe('Approved or auto-accepted');
  });
});
