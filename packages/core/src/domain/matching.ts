import { z } from 'zod';
import { instantSchema, paiseSchema, uuidSchema } from './primitives.js';
import { reasonCodeSchema } from './reason-code.js';

export const RECORD_TYPES = [
  'ledger_entry',
  'rzp_payment',
  'rzp_refund',
  'rzp_settlement',
  'bank_line',
] as const;
export const recordTypeSchema = z.enum(RECORD_TYPES);
export type RecordType = z.output<typeof recordTypeSchema>;

/** Points at one source record. The database stores this as one typed foreign key per record type. */
export const recordRefSchema = z.strictObject({
  recordType: recordTypeSchema,
  recordId: uuidSchema,
});
export type RecordRef = z.output<typeof recordRefSchema>;

/**
 * `order` groups tie ledger entries to the payments and refunds that settle them. `payout` groups
 * tie a Razorpay settlement to the bank line it landed as. Which payments a settlement contains
 * comes from its settlement items, not from a match, so a record sits in at most one group.
 */
export const MATCH_GROUP_KINDS = ['order', 'payout'] as const;
export const MATCH_GROUP_STATUSES = ['proposed', 'accepted', 'rejected', 'reversed'] as const;
export const MATCH_BASES = ['rule', 'agent', 'human'] as const;
export const MATCH_TIERS = ['T1', 'T2', 'T3', 'T4'] as const;

/**
 * A set of records that reconcile exactly to the paise. `residual` is the verifier-computed
 * difference and must be zero for an accepted group; the database enforces the same rule.
 */
export const matchGroupSchema = z
  .strictObject({
    id: uuidSchema,
    runId: uuidSchema,
    kind: z.enum(MATCH_GROUP_KINDS),
    status: z.enum(MATCH_GROUP_STATUSES),
    basis: z.enum(MATCH_BASES),
    tier: z.enum(MATCH_TIERS).nullable(),
    /** The rule that made a rule-basis match, e.g. `T1.receipt-amount.v1`; null for agent and human groups. */
    ruleId: z.string().min(1).max(100).nullable(),
    /** What explains a known, accounted-for difference (e.g. FEE_GST_DEDUCTION), if anything. */
    reasonCode: reasonCodeSchema.nullable(),
    residual: paiseSchema,
    createdAt: instantSchema,
  })
  .refine((g) => g.status !== 'accepted' || g.residual === 0n, {
    error: 'an accepted match group must reconcile exactly: residual must be 0',
    path: ['residual'],
  })
  .refine((g) => g.basis !== 'rule' || g.tier !== null, {
    error: 'a rule-made match records its tier',
    path: ['tier'],
  })
  .refine((g) => g.basis !== 'rule' || g.ruleId !== null, {
    error: 'a rule-made match records its rule id',
    path: ['ruleId'],
  });
export type MatchGroup = z.output<typeof matchGroupSchema>;

/** `groupStatus` mirrors the group's status so the database can enforce one accepted group per record. */
export const matchLinkSchema = z.strictObject({
  id: uuidSchema,
  groupId: uuidSchema,
  groupStatus: z.enum(MATCH_GROUP_STATUSES),
  ...recordRefSchema.shape,
});
export type MatchLink = z.output<typeof matchLinkSchema>;

export const EXCEPTION_STATUSES = ['open', 'proposed', 'resolved', 'dismissed'] as const;

/** A record the rules could not match safely. Carries a reason code and the candidates found. */
export const reconExceptionSchema = z.strictObject({
  id: uuidSchema,
  runId: uuidSchema,
  reasonCode: reasonCodeSchema,
  status: z.enum(EXCEPTION_STATUSES),
  subject: recordRefSchema,
  candidates: z.array(recordRefSchema).max(50),
  /** The unexplained difference in paise (signed: shortfall or excess). */
  amountAtStake: paiseSchema,
  createdAt: instantSchema,
});
export type ReconException = z.output<typeof reconExceptionSchema>;
