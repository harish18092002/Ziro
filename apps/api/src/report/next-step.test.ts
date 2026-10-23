import { describe, expect, it } from 'vitest';
import { nextStepOf, type StepInput } from './next-step.js';

const input = (over: Partial<StepInput>): StepInput => ({
  status: 'open',
  listedForAPerson: false,
  proposal: null,
  review: null,
  ...over,
});
const proposal = (
  suggestedAction: string,
  verdict = 'EXPLAINED_NO_MATCH',
  verifier = 'not_applicable',
) => ({
  verdict,
  suggestedAction,
  verifier,
});

describe('nextStepOf', () => {
  it('gives an action for every kind of suggestion', () => {
    for (const [action, text] of [
      ['ACCEPT_MATCH', 'Approve the proposed match'],
      ['RAISE_RAZORPAY_TICKET', 'Raise a ticket with Razorpay'],
      ['REFUND_CUSTOMER', 'Refund the customer'],
      ['ADJUST_LEDGER', 'Adjust the ledger'],
      ['CHASE_SETTLEMENT', 'Chase the settlement with Razorpay'],
    ] as const) {
      const step = nextStepOf(input({ proposal: proposal(action) }));
      expect(step.suggestedAction).toBe(action);
      expect(step.nextStep).toContain(text);
    }
  });

  it('says a waiting proposal is waiting for a person', () => {
    const step = nextStepOf(input({ status: 'proposed', proposal: proposal('ADJUST_LEDGER') }));
    expect(step.nextStep).toContain('waiting for a person to approve');
  });

  it("never passes on a refused proposal's suggestion", () => {
    const step = nextStepOf(
      input({ proposal: proposal('ACCEPT_MATCH', 'MATCH_PROPOSED', 'rejected') }),
    );
    expect(step.suggestedAction).toBeNull();
    expect(step.nextStep).toContain('Investigate by hand');
    expect(step.nextStep).not.toContain('Approve');
  });

  it('distinguishes an agent that could not conclude from one that explained', () => {
    expect(nextStepOf(input({ proposal: proposal('NONE', 'NEEDS_HUMAN') })).nextStep).toContain(
      'Decide by hand',
    );
    expect(nextStepOf(input({ proposal: proposal('NONE') })).nextStep).toContain(
      'Confirm the explanation',
    );
  });

  it('handles an exception nobody has looked at, with or without candidates for an agent', () => {
    expect(nextStepOf(input({})).nextStep).toContain('run the agent');
    expect(nextStepOf(input({ listedForAPerson: true })).nextStep).toContain('Review by hand');
  });

  it('has nothing left to do once settled', () => {
    expect(
      nextStepOf(input({ status: 'resolved', review: { decision: 'approved' } })).nextStep,
    ).toBe('None: resolved (approved)');
    expect(nextStepOf(input({ status: 'dismissed' })).nextStep).toBe('None: dismissed');
    expect(nextStepOf(input({ status: 'resolved' })).suggestedAction).toBeNull();
  });

  it('always answers with a non-empty sentence', () => {
    for (const status of ['open', 'proposed', 'resolved', 'dismissed'] as const)
      for (const p of [
        null,
        proposal('NONE'),
        proposal('ADJUST_LEDGER', 'EXPLAINED_NO_MATCH', 'rejected'),
      ])
        expect(nextStepOf(input({ status, proposal: p })).nextStep.length).toBeGreaterThan(5);
  });
});

describe('an investigation the system could not finish', () => {
  const degraded = (label: string | null) => ({
    verdict: 'NEEDS_HUMAN',
    suggestedAction: 'NONE',
    verifier: 'not_applicable',
    degradedLabel: label,
  });

  it('says why, and gives no advice to follow', () => {
    const step = nextStepOf(
      input({ status: 'proposed', proposal: degraded('the model API did not answer') }),
    );
    expect(step.suggestedAction).toBeNull();
    expect(step.nextStep).toBe(
      'Investigate by hand: the agent could not reach a conclusion (the model API did not answer) (the proposal is waiting for a person to approve it)',
    );
  });

  it('is not confused with a model that looked and could not tell', () => {
    const modelSaidCannotTell = nextStepOf(input({ proposal: degraded(null) }));
    expect(modelSaidCannotTell.nextStep).toBe('Decide by hand: the agent could not conclude');
  });

  it('leaves a resolved exception resolved, whatever happened on the way', () => {
    const step = nextStepOf(
      input({
        status: 'resolved',
        proposal: degraded('ran out of time'),
        review: { decision: 'approved' },
      }),
    );
    expect(step.nextStep).toBe('None: resolved (approved)');
  });
});
