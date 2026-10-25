import { z } from 'zod';
import { recordRefSchema } from './matching.js';
import { instantSchema, nonNegativePaiseSchema, uuidSchema } from './primitives.js';
import { reasonCodeSchema } from './reason-code.js';

export const AGENT_VERDICTS = ['MATCH_PROPOSED', 'EXPLAINED_NO_MATCH', 'NEEDS_HUMAN'] as const;
export const SUGGESTED_ACTIONS = [
  'ACCEPT_MATCH',
  'RAISE_RAZORPAY_TICKET',
  'REFUND_CUSTOMER',
  'ADJUST_LEDGER',
  'CHASE_SETTLEMENT',
  'NONE',
] as const;

/** The read-only tools an investigation may call. The evidence of a proposal can only name these. */
export const AGENT_TOOL_NAMES = [
  'get_exception',
  'get_ledger_entry',
  'search_ledger',
  'get_payment',
  'list_refunds',
  'get_settlement_composition',
  'search_bank_lines',
  'compute_expected_settlement',
  'get_fee_contract',
] as const;

/** Generic accounts a draft journal entry may use; a merchant maps them to its own chart later. */
export const JOURNAL_ACCOUNTS = [
  'RAZORPAY_CLEARING',
  'BANK',
  'SALES',
  'REFUNDS',
  'PAYMENT_GATEWAY_FEES',
  'GST_INPUT_CREDIT',
  'CHARGEBACK_LOSS',
  'SUSPENSE',
] as const;

/** A fact the agent relies on: which tool call it came from, and what it showed. Harness-verified. */
export const evidenceSchema = z.strictObject({
  tool: z.enum(AGENT_TOOL_NAMES),
  args: z.record(z.string(), z.unknown()),
  keyFinding: z.string().min(1).max(300),
});
export type Evidence = z.output<typeof evidenceSchema>;

const journalLineSchema = z
  .strictObject({
    account: z.enum(JOURNAL_ACCOUNTS),
    debit: nonNegativePaiseSchema,
    credit: nonNegativePaiseSchema,
  })
  .refine((line) => line.debit > 0n !== line.credit > 0n, {
    error: 'a journal line is either a debit or a credit, in a positive amount',
  });

/** A suggested entry for the books. It must balance to the paise, and a person still posts it. */
export const draftJournalEntrySchema = z
  .strictObject({
    memo: z.string().min(1).max(200),
    lines: z.array(journalLineSchema).min(2).max(10),
  })
  .refine(
    (entry) =>
      entry.lines.reduce((sum, l) => sum + l.debit, 0n) ===
      entry.lines.reduce((sum, l) => sum + l.credit, 0n),
    { error: 'debits and credits must be equal', path: ['lines'] },
  );
export type DraftJournalEntry = z.output<typeof draftJournalEntrySchema>;

/** At most three sentences. A full stop between digits (1,234.50) or inside an id does not end one. */
const sentenceCount = (text: string): number =>
  text.split(/[.!?]+(?=\s|$)/).filter((part) => part.trim() !== '').length;

export const explanationSchema = z
  .string()
  .min(1)
  .max(600)
  .refine((text) => sentenceCount(text) <= 3, { error: 'explain in at most three sentences' });

const contentShape = {
  exceptionId: uuidSchema,
  verdict: z.enum(AGENT_VERDICTS),
  reasonCode: reasonCodeSchema,
  /** For MATCH_PROPOSED exactly the records that would form the group; otherwise related records. */
  links: z.array(recordRefSchema).max(50),
  explanation: explanationSchema,
  evidence: z.array(evidenceSchema).max(20),
  confidence: z.number().min(0).max(1),
  suggestedAction: z.enum(SUGGESTED_ACTIONS),
  draftJournalEntry: draftJournalEntrySchema.nullable(),
};

type Proposable = {
  verdict: (typeof AGENT_VERDICTS)[number];
  links: readonly unknown[];
  evidence: readonly unknown[];
  suggestedAction: (typeof SUGGESTED_ACTIONS)[number];
  confidence: number;
};

/** Rules that make an incoherent proposal unrepresentable. */
function withProposalRules<T extends z.ZodType<Proposable>>(schema: T): T {
  return schema
    .refine((p) => p.verdict !== 'MATCH_PROPOSED' || p.links.length > 0, {
      error: 'a proposed match names the records it links',
      path: ['links'],
    })
    .refine((p) => p.verdict === 'NEEDS_HUMAN' || p.evidence.length > 0, {
      error: 'a conclusion rests on at least one piece of evidence',
      path: ['evidence'],
    })
    .refine((p) => p.suggestedAction !== 'ACCEPT_MATCH' || p.verdict === 'MATCH_PROPOSED', {
      error: 'only a proposed match can be accepted',
      path: ['suggestedAction'],
    })
    .refine((p) => p.suggestedAction !== 'ACCEPT_MATCH' || p.confidence >= 0.5, {
      error: 'a match is not suggested for acceptance below 0.5 confidence',
      path: ['confidence'],
    });
}

/**
 * What an investigation produces. The model's own output is turned into this by the harness after
 * its checks; it is strict (unknown keys such as `approve` are rejected, not ignored) and capped.
 * There is no residual claim: the verifier computes it, and the agent never states one.
 */
export const agentProposalContentSchema = withProposalRules(z.strictObject(contentShape));
export type AgentProposalContent = z.output<typeof agentProposalContentSchema>;

/**
 * `pending`: not yet verified. `passed` / `rejected`: a proposed match the verifier checked.
 * `not_applicable`: an explanation or a NEEDS_HUMAN, which proposes no match, so there is nothing to verify.
 */
export const VERIFIER_STATUSES = ['pending', 'passed', 'rejected', 'not_applicable'] as const;

/** A stored proposal: the content, how it was produced, and the verifier's verdict. */
export const agentProposalSchema = withProposalRules(
  z.strictObject({
    id: uuidSchema,
    runId: uuidSchema,
    llmCallId: uuidSchema.nullable(),
    /** Which investigation of the exception this is; a re-run by a person is attempt 2. */
    attempt: z.number().int().min(1),
    /** Shared by the proposals that came out of one clustered investigation. */
    clusterId: uuidSchema.nullable(),
    model: z.string().min(1).max(100).nullable(),
    ...contentShape,
    /** Why the harness changed or limited what the model said (a record it never saw, a budget). */
    harnessFindings: z.array(z.string().min(1).max(300)).max(20),
    verifierStatus: z.enum(VERIFIER_STATUSES),
    verifierFindings: z.array(z.string().min(1).max(500)).max(50),
    createdAt: instantSchema,
  }),
);
export type AgentProposal = z.output<typeof agentProposalSchema>;

/**
 * When the agent could not reach a conclusion and handed an exception to a person (a NEEDS_HUMAN the harness
 * wrote, as opposed to a model's own "I cannot tell"), why. The prose is in the proposal; this code is what
 * is counted and shown.
 */
export const DEGRADED_REASONS = [
  'model_unavailable',
  'model_rejected',
  'invalid_reply',
  'tool_budget',
  'token_budget',
  'time_budget',
  'context',
  'refused',
  'quota_exhausted',
] as const;
export const degradedReasonSchema = z.enum(DEGRADED_REASONS);
export type DegradedReason = z.output<typeof degradedReasonSchema>;

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
