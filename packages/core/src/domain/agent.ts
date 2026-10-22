import { z } from 'zod';
import { recordRefSchema } from './matching.js';
import { instantSchema, paiseSchema, uuidSchema } from './primitives.js';
import { reasonCodeSchema } from './reason-code.js';

/** A fact the agent quotes from a record to back its proposal. The verifier re-checks each one. */
export const evidenceSchema = z.strictObject({
  ref: recordRefSchema,
  field: z.string().min(1).max(60),
  value: z.string().min(1).max(200),
});
export type Evidence = z.output<typeof evidenceSchema>;

/**
 * What the agent may return. This is LLM output, so it is untrusted: strict (unknown keys such as
 * `approve` are rejected, not ignored) and size-capped. `claimedResidual` is only a claim: the
 * verifier recomputes the residual from the linked records and never takes this number on trust.
 */
export const agentProposalContentSchema = z.strictObject({
  exceptionId: uuidSchema,
  reasonCode: reasonCodeSchema,
  links: z.array(recordRefSchema).max(50),
  claimedResidual: paiseSchema,
  explanation: z.string().min(1).max(2000),
  evidence: z.array(evidenceSchema).min(1).max(20),
});
export type AgentProposalContent = z.output<typeof agentProposalContentSchema>;

export const VERIFIER_STATUSES = ['pending', 'passed', 'rejected'] as const;

/** A stored proposal: the agent's content plus the verifier's verdict. */
export const agentProposalSchema = z.strictObject({
  id: uuidSchema,
  runId: uuidSchema,
  llmCallId: uuidSchema.nullable(),
  ...agentProposalContentSchema.shape,
  verifierStatus: z.enum(VERIFIER_STATUSES),
  verifierFindings: z.array(z.string().min(1).max(500)).max(50),
  createdAt: instantSchema,
});
export type AgentProposal = z.output<typeof agentProposalSchema>;

export const REVIEW_DECISIONS = ['approved', 'rejected'] as const;
export const REVIEWER_KINDS = ['human', 'auto_accept'] as const;

/** A decision on a proposal: by a person, or by the strict auto-accept policy. */
export const reviewSchema = z.strictObject({
  id: uuidSchema,
  runId: uuidSchema,
  proposalId: uuidSchema,
  decision: z.enum(REVIEW_DECISIONS),
  reviewerKind: z.enum(REVIEWER_KINDS),
  reviewer: z.string().min(1).max(100),
  note: z.string().max(1000).nullable(),
  createdAt: instantSchema,
});
export type Review = z.output<typeof reviewSchema>;
