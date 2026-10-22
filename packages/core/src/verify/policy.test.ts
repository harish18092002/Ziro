import { describe, expect, it } from 'vitest';
import { paise } from '../money/index.js';
import { decideRoute, type RouteInput, type RoutePolicy } from './policy.js';
import type { VerifyOutcome } from './types.js';

const verified = (gross: bigint): VerifyOutcome => ({
  status: 'VERIFIED',
  group: { kind: 'order', links: [], gross: paise(gross), residual: paise(0n) },
  notes: [],
});
const rejected: VerifyOutcome = {
  status: 'REJECTED',
  findings: [{ code: 'AMOUNT_MISMATCH', message: 'x', records: [] }],
};

const open: RoutePolicy = {
  autoAcceptEnabled: true,
  demoMode: false,
  killSwitch: false,
  maxPaise: paise(100_000n),
  minConfidence: 0.85,
};
const good: RouteInput = {
  outcome: verified(100_000n),
  verdict: 'MATCH_PROPOSED',
  suggestedAction: 'ACCEPT_MATCH',
  confidence: 0.85,
};

const humanBecause = (input: RouteInput, policy: RoutePolicy) => {
  const route = decideRoute(input, policy);
  return route.route === 'human' ? route.why : [];
};

describe('decideRoute', () => {
  it('auto-accepts only when every condition holds, with the limits inclusive', () => {
    expect(decideRoute(good, open)).toEqual({ route: 'auto_accept' });
  });

  it.each([
    ['the kill switch is on', { killSwitch: true }, {}],
    ['demo mode is on', { demoMode: true }, {}],
    ['auto-accept is switched off', { autoAcceptEnabled: false }, {}],
    ['the verifier rejected it', {}, { outcome: rejected }],
    ['the amount is one paisa over the limit', {}, { outcome: verified(100_001n) }],
    ['the confidence is just under the threshold', {}, { confidence: 0.8499 }],
    ['the agent did not suggest accepting', {}, { suggestedAction: 'NONE' as const }],
    ['the agent did not propose a match', {}, { verdict: 'EXPLAINED_NO_MATCH' as const }],
    ['the confidence is not a number', {}, { confidence: Number.NaN }],
  ])('goes to a person when %s', (_name, policyOver, inputOver) => {
    const route = decideRoute({ ...good, ...inputOver }, { ...open, ...policyOver });
    expect(route.route).toBe('human');
  });

  it('lists every reason, not only the first', () => {
    const why = humanBecause(
      { ...good, outcome: rejected, confidence: 0.1, suggestedAction: 'NONE' },
      { ...open, killSwitch: true, demoMode: true, autoAcceptEnabled: false },
    );
    expect(why).toHaveLength(6);
    expect(why.join(' | ')).toMatch(/kill switch.*demo mode.*switched off/);
  });

  it('lets a person decide even with the kill switch on: the policy only ever routes', () => {
    const why = humanBecause(good, { ...open, killSwitch: true });
    expect(why).toEqual(['the kill switch is on']);
  });

  it('does not let a verified, high-confidence, small match through in demo mode', () => {
    expect(decideRoute(good, { ...open, demoMode: true }).route).toBe('human');
  });

  it('accepts a zero-paise limit only for a zero-paise group', () => {
    expect(
      decideRoute({ ...good, outcome: verified(0n) }, { ...open, maxPaise: paise(0n) }).route,
    ).toBe('auto_accept');
    expect(
      decideRoute({ ...good, outcome: verified(1n) }, { ...open, maxPaise: paise(0n) }).route,
    ).toBe('human');
  });
});
