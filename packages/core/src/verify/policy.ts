// Who decides: the policy that routes a proposal to auto-accept or to a person. Auto-accept is the
// exception and needs EVERY condition; anything else, however small, goes to the human queue.
import type { AGENT_VERDICTS, SUGGESTED_ACTIONS } from '../domain/index.js';
import type { Paise } from '../money/index.js';
import type { VerifyOutcome } from './types.js';

export interface RoutePolicy {
  /** AUTO_ACCEPT_ENABLED. */
  readonly autoAcceptEnabled: boolean;
  /** DEMO_MODE: reviewers must always see the human gate, whatever else is set. */
  readonly demoMode: boolean;
  /** AGENT_KILL_SWITCH: stops the agent and auto-accept at once. People keep reviewing. */
  readonly killSwitch: boolean;
  /** AUTO_ACCEPT_MAX_PAISE: the largest group that may be accepted without a person. */
  readonly maxPaise: Paise;
  /** AUTO_ACCEPT_MIN_CONFIDENCE, 0 to 1. */
  readonly minConfidence: number;
}

export interface RouteInput {
  readonly outcome: VerifyOutcome;
  readonly verdict: (typeof AGENT_VERDICTS)[number];
  readonly suggestedAction: (typeof SUGGESTED_ACTIONS)[number];
  readonly confidence: number;
}

export type Route =
  | { readonly route: 'auto_accept' }
  /** Every reason a person is needed, so the queue can say why. */
  | { readonly route: 'human'; readonly why: readonly string[] };

export function decideRoute(input: RouteInput, policy: RoutePolicy): Route {
  const why: string[] = [];
  if (policy.killSwitch) why.push('the kill switch is on');
  if (policy.demoMode) why.push('demo mode always shows the human gate');
  if (!policy.autoAcceptEnabled) why.push('auto-accept is switched off');
  if (input.verdict !== 'MATCH_PROPOSED') why.push('the agent did not propose a match');
  if (input.suggestedAction !== 'ACCEPT_MATCH') why.push('the agent did not suggest accepting it');
  if (input.outcome.status !== 'VERIFIED') {
    why.push('the verifier did not verify it');
  } else if (input.outcome.group.gross > policy.maxPaise) {
    why.push('the amount is above the auto-accept limit');
  }
  if (!(input.confidence >= policy.minConfidence)) {
    why.push('the confidence is below the auto-accept threshold');
  }
  return why.length === 0 ? { route: 'auto_accept' } : { route: 'human', why };
}
