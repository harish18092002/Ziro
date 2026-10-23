// What finance should do about an exception, in a sentence. The agent's suggested action is shown only
// when its proposal stands: a proposal the verifier refused is not advice, so it is blanked and the next
// step says to investigate by hand.
import type { ExceptionStatus } from './gap.js';

export interface StepInput {
  readonly status: ExceptionStatus;
  readonly listedForAPerson: boolean;
  readonly proposal: {
    readonly verdict: string;
    readonly suggestedAction: string;
    readonly verifier: string;
  } | null;
  readonly review: { readonly decision: string } | null;
}

const ACTION_TEXT: Record<string, string> = {
  ACCEPT_MATCH: 'Approve the proposed match in the review queue',
  RAISE_RAZORPAY_TICKET: 'Raise a ticket with Razorpay',
  REFUND_CUSTOMER: 'Refund the customer',
  ADJUST_LEDGER: 'Adjust the ledger',
  CHASE_SETTLEMENT: 'Chase the settlement with Razorpay',
};

export interface Step {
  /** The agent's suggested action, or null when there is none worth following. */
  readonly suggestedAction: string | null;
  readonly nextStep: string;
}

export function nextStepOf(e: StepInput): Step {
  if (e.status === 'resolved') {
    return {
      suggestedAction: null,
      nextStep: `None: resolved${e.review ? ` (${e.review.decision})` : ''}`,
    };
  }
  if (e.status === 'dismissed') return { suggestedAction: null, nextStep: 'None: dismissed' };

  const p = e.proposal;
  if (p === null) {
    return {
      suggestedAction: null,
      nextStep: e.listedForAPerson
        ? 'Review by hand: the rules left no candidate records for an agent to examine'
        : 'Not yet investigated: run the agent on this exception',
    };
  }
  if (p.verifier === 'rejected') {
    return {
      suggestedAction: null,
      nextStep: "Investigate by hand: the checker refused the agent's proposal",
    };
  }
  const waiting =
    e.status === 'proposed' ? ' (the proposal is waiting for a person to approve it)' : '';
  const text = ACTION_TEXT[p.suggestedAction];
  if (text !== undefined)
    return { suggestedAction: p.suggestedAction, nextStep: `${text}${waiting}` };
  return {
    suggestedAction: p.suggestedAction,
    nextStep:
      p.verdict === 'NEEDS_HUMAN'
        ? `Decide by hand: the agent could not conclude${waiting}`
        : `Confirm the explanation; no further action suggested${waiting}`,
  };
}
