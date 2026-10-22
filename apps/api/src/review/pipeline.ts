// What happens to a proposal after the agent stores it. A token and an interface, so the agent module
// can call it without importing the review module (the dependency runs one way: review never needs the
// agent, and the agent only needs "verify these and route them").
export const PROPOSAL_PIPELINE = Symbol('PROPOSAL_PIPELINE');

export interface ProposalPipeline {
  /** Verifies each pending proposal that proposes a match, then auto-accepts it or leaves it for a person. */
  verifyAndRoute(proposalIds: readonly string[]): Promise<void>;
  /** The ids of proposals of these exceptions that have not been verified yet. */
  pendingFor(exceptionIds: readonly string[]): Promise<string[]>;
}
