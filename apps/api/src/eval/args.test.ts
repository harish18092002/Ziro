import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AgentHalted } from '../agent/types.js';
import { type EvalPlan, isPaid, parseEvalArgs, refusal, SMOKE_MAX_COST_USD } from './args.js';
import { CostGuard } from './cost-guard.js';

const DEFAULTS = { out: '/results', stressDir: '/data/stress' };
const plan = (...argv: string[]): EvalPlan => {
  const parsed = parseEvalArgs(argv, DEFAULTS);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.plan;
};
const error = (...argv: string[]): string => {
  const parsed = parseEvalArgs(argv, DEFAULTS);
  if (!('error' in parsed)) throw new Error('expected an error');
  return parsed.error;
};

describe('parseEvalArgs: the command from the brief', () => {
  it('reads --seed 42 --preset eval --configs rules,small,large,harnessB --repeats 3', () => {
    const p = plan(
      '--seed',
      '42',
      '--preset',
      'eval',
      '--configs',
      'rules,small,large,harnessB',
      '--repeats',
      '3',
    );
    expect(p).toMatchObject({
      command: 'run',
      seed: 42,
      preset: 'eval',
      configs: ['rules', 'small', 'large', 'harnessB'],
      repeats: 3,
      legs: ['plain', 'attacked'],
      clusterConfigs: ['small'],
      injections: 16,
      concurrency: 4,
      confirm: false,
      stress: true,
      out: DEFAULTS.out,
    });
  });

  it('has the same defaults with nothing said, and accepts --flag=value', () => {
    expect(plan().configs).toEqual(['rules', 'small', 'large', 'harnessB']);
    expect(plan('--seed=7', '--repeats=2')).toMatchObject({ seed: 7, repeats: 2 });
    expect(plan('run', '--seed', '9').seed).toBe(9);
  });
});

describe('what may spend money', () => {
  it('a run with model configs and no ceiling is refused, with the flag to add', () => {
    const p = plan('--configs', 'rules,small');
    expect(isPaid(p)).toBe(true);
    expect(refusal(p)).toMatch(/--max-cost-usd/);
  });

  it('is allowed once there is a ceiling (and still needs --confirm, which the CLI checks)', () => {
    const p = plan('--configs', 'small', '--max-cost-usd', '5');
    expect(refusal(p)).toBeNull();
    expect(p.confirm).toBe(false);
    expect(plan('--configs', 'small', '--max-cost-usd', '5', '--confirm').confirm).toBe(true);
  });

  it('a rules-only run is free: no ceiling, no confirmation, even though clustering defaults to small', () => {
    const p = plan('--configs', 'rules');
    expect(p.clusterConfigs).toEqual([]);
    expect(isPaid(p)).toBe(false);
    expect(refusal(p)).toBeNull();
  });

  it('the clustering variant is paid when its config is run, and not otherwise', () => {
    expect(plan('--configs', 'rules,small').clusterConfigs).toEqual(['small']);
    expect(plan('--configs', 'rules,large').clusterConfigs).toEqual([]);
    expect(plan('--configs', 'rules,small', '--cluster', 'none').clusterConfigs).toEqual([]);
    expect(error('--configs', 'rules,small', '--cluster', 'large')).toMatch(
      /needs large in --configs/,
    );
  });

  it('the stress command measures the rules only and never spends', () => {
    const p = plan('stress');
    expect(p.command).toBe('stress');
    expect(isPaid(p)).toBe(false);
  });

  it('refuses a ceiling that is not a positive number of dollars', () => {
    for (const bad of ['0', '-1', 'abc', 'Infinity']) {
      expect(error('--max-cost-usd', bad)).toMatch(/positive number/);
    }
  });
});

describe('smoke', () => {
  it('is the demo preset, one repeat, the small model, a hard cap, and nothing written to the results', () => {
    const p = plan('smoke');
    expect(p).toMatchObject({
      command: 'smoke',
      preset: 'demo',
      repeats: 1,
      configs: ['rules', 'small'],
      legs: ['plain'],
      clusterConfigs: [],
      maxCostUsd: SMOKE_MAX_COST_USD,
      out: null,
    });
    expect(refusal(p)).toBeNull();
    expect(SMOKE_MAX_COST_USD).toBeLessThanOrEqual(0.5);
  });

  it('keeps the demo preset even if another is asked for', () => {
    expect(plan('smoke', '--preset', 'eval').preset).toBe('demo');
  });
});

describe('what it rejects', () => {
  it.each([
    [['--nope', '1'], /unknown flag --nope/],
    [['--preset', 'stress'], /demo or eval/],
    [['--configs', 'rules,huge'], /unknown config "huge"/],
    [['--legs', 'plain,sideways'], /unknown leg "sideways"/],
    [['--repeats', '0'], /1 to 10/],
    [['--repeats', '11'], /1 to 10/],
    [['--repeats', '2.5'], /1 to 10/],
    [['--concurrency', '0'], /1 to 16/],
    [['--injections', '-1'], /0 to 100/],
    [['--seed', '-3'], /unsigned/],
    [['--seed', '4294967296'], /unsigned/],
    [['stray'], /unexpected argument "stray"/],
  ])('%j', (argv, message) => {
    expect(error(...argv)).toMatch(message);
  });

  it('drops the attacked leg when no injections are asked for', () => {
    expect(plan('--injections', '0').legs).toEqual(['plain']);
  });

  it('never throws on any arguments: it returns a plan or an error (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 8 }), (argv) => {
        const parsed = parseEvalArgs(argv, DEFAULTS);
        expect('plan' in parsed || 'error' in parsed).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('CostGuard', () => {
  it('stops at the cap, counting what has been spent, and not before', () => {
    const guard = new CostGuard(1_000_000n);
    guard.add(999_999n);
    expect(guard.exceeded).toBe(false);
    expect(() => guard.assertWithin()).not.toThrow();
    guard.add(1n);
    expect(guard.exceeded).toBe(true);
    expect(guard.spentMicroUsd).toBe(1_000_000n);
    expect(() => guard.assertWithin()).toThrow(AgentHalted);
  });

  it('with no cap never stops (only free runs may have none)', () => {
    const guard = new CostGuard(null);
    guard.add(10n ** 12n);
    expect(guard.exceeded).toBe(false);
    expect(guard.cap).toBeNull();
  });
});
