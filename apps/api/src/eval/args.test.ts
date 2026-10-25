import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AgentHalted } from '../agent/types.js';
import {
  DEFAULT_CONFIGS,
  type EvalPlan,
  isPaid,
  parseEvalArgs,
  refusal,
  SMOKE_MAX_COST_USD,
  SMOKE_MAX_REQUESTS,
} from './args.js';
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
  it('reads --seed 42 --preset eval --configs rules,lite-single,flash-single --repeats 3', () => {
    const p = plan(
      '--seed',
      '42',
      '--preset',
      'eval',
      '--configs',
      'rules,lite-single,flash-single',
      '--repeats',
      '3',
    );
    expect(p).toMatchObject({
      command: 'run',
      seed: 42,
      preset: 'eval',
      configs: ['rules', 'lite-single', 'flash-single'],
      repeats: 3,
      legs: ['plain', 'attacked'],
      clusterConfigs: ['lite-single'],
      injections: 16,
      concurrency: 4,
      confirm: false,
      stress: true,
      out: DEFAULTS.out,
    });
  });

  it('has the same defaults with nothing said, and accepts --flag=value', () => {
    expect(plan().configs).toEqual(DEFAULT_CONFIGS.split(','));
    expect(plan().configs).not.toContain('claude-loop'); // Claude is asked for by name, never by default
    expect(plan('--seed=7', '--repeats=2')).toMatchObject({ seed: 7, repeats: 2 });
    expect(plan('run', '--seed', '9').seed).toBe(9);
  });

  it('runs one repeat unless told otherwise: a repeat of a model config spends its requests again', () => {
    expect(plan().repeats).toBe(1);
  });

  it('reads --sample, --max-requests and --cache', () => {
    expect(plan('--sample', '12', '--max-requests', '60', '--cache', 'replay')).toMatchObject({
      sample: 12,
      maxRequests: 60,
      cache: 'replay',
    });
    expect(plan()).toMatchObject({ sample: null, maxRequests: null, cache: null });
  });
});

describe('what may use a model', () => {
  it('a Gemini run with no request ceiling is refused, with the flag to add', () => {
    const p = plan('--configs', 'rules,lite-single');
    expect(isPaid(p, 'off')).toBe(true);
    expect(refusal(p, 'off')).toMatch(/--max-requests/);
  });

  it('a Claude run with no money ceiling is refused, with the flag to add', () => {
    const p = plan('--configs', 'claude-single', '--max-requests', '10');
    expect(refusal(p, 'off')).toMatch(/--max-cost-usd/);
  });

  it('is allowed once there is a ceiling (and still needs --confirm, which the CLI checks)', () => {
    const p = plan('--configs', 'lite-single', '--max-requests', '40');
    expect(refusal(p, 'off')).toBeNull();
    expect(p.confirm).toBe(false);
    expect(plan('--configs', 'lite-single', '--max-requests', '40', '--confirm').confirm).toBe(
      true,
    );
    const both = plan(
      '--configs',
      'lite-single,claude-loop',
      '--max-requests',
      '40',
      '--max-cost-usd',
      '2',
    );
    expect(refusal(both, 'off')).toBeNull();
  });

  it('a replay sends nothing: no ceiling, no confirmation', () => {
    const p = plan('--configs', 'rules,lite-single,flash-single', '--cache', 'replay');
    expect(isPaid(p, 'replay')).toBe(false);
    expect(refusal(p, 'replay')).toBeNull();
  });

  it('a rules-only run is free: no ceiling, no confirmation, even though clustering defaults to lite-single', () => {
    const p = plan('--configs', 'rules');
    expect(p.clusterConfigs).toEqual([]);
    expect(isPaid(p, 'off')).toBe(false);
    expect(refusal(p, 'off')).toBeNull();
  });

  it('the clustering variant is paid when its config is run, and not otherwise', () => {
    expect(plan('--configs', 'rules,lite-single').clusterConfigs).toEqual(['lite-single']);
    expect(plan('--configs', 'rules,flash-single').clusterConfigs).toEqual([]);
    expect(plan('--configs', 'rules,lite-single', '--cluster', 'none').clusterConfigs).toEqual([]);
    expect(error('--configs', 'rules,lite-single', '--cluster', 'flash-single')).toMatch(
      /needs flash-single in --configs/,
    );
  });

  it('the stress command measures the rules only and never spends', () => {
    const p = plan('stress');
    expect(p.command).toBe('stress');
    expect(isPaid(p, 'off')).toBe(false);
  });

  it('refuses a money ceiling that is not a positive number of dollars', () => {
    for (const bad of ['0', '-1', 'abc', 'Infinity']) {
      expect(error('--max-cost-usd', bad)).toMatch(/positive number/);
    }
  });

  it.each([
    ['--max-requests', '0'],
    ['--max-requests', '1.5'],
    ['--max-requests', 'many'],
    ['--sample', '0'],
    ['--sample', '-3'],
  ])('refuses %s %s', (flag, value) => {
    expect(error(flag, value)).toMatch(/whole number/);
  });

  it('refuses an unknown cache mode', () => {
    expect(error('--cache', 'sometimes')).toMatch(/--cache must be/);
  });
});

describe('smoke', () => {
  it('is the demo preset, one repeat, the lite model, hard caps, and nothing written to the results', () => {
    const p = plan('smoke');
    expect(p).toMatchObject({
      command: 'smoke',
      preset: 'demo',
      repeats: 1,
      configs: ['rules', 'lite-single'],
      legs: ['plain'],
      clusterConfigs: [],
      maxCostUsd: SMOKE_MAX_COST_USD,
      maxRequests: SMOKE_MAX_REQUESTS,
      out: null,
    });
    expect(refusal(p, 'off')).toBeNull();
    expect(SMOKE_MAX_COST_USD).toBeLessThanOrEqual(0.5);
    expect(SMOKE_MAX_REQUESTS).toBeLessThanOrEqual(50);
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

  it('counts requests apart from money, and a cached answer is not a request', () => {
    const guard = new CostGuard(null, 3);
    guard.add(0n); // a free-tier request
    guard.add(0n, false); // served from the cache
    guard.add(0n);
    expect(guard.requests).toBe(2);
    expect(guard.exceeded).toBe(false);
    guard.add(0n);
    expect(guard.exceeded).toBe(true);
    expect(guard.why).toBe('the request cap was reached');
    expect(() => guard.assertWithin()).toThrow(AgentHalted);
  });

  it('says which cap stopped it', () => {
    const guard = new CostGuard(10n, 100);
    guard.add(10n);
    expect(guard.why).toBe('the cost cap was reached');
  });

  it('with no cap never stops (only free runs may have none)', () => {
    const guard = new CostGuard(null);
    guard.add(10n ** 12n);
    expect(guard.exceeded).toBe(false);
    expect(guard.cap).toBeNull();
  });
});
