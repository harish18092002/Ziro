import { z } from 'zod';
import { instantSchema, uuidSchema } from './primitives.js';

export const ACTORS = ['rule', 'agent', 'verifier', 'human', 'system'] as const;
export const actorSchema = z.enum(ACTORS);
export type Actor = z.output<typeof actorSchema>;

/** The database sequence number: a bigint, accepted as a bigint, integer string or safe integer. */
export const sequenceIdSchema = z
  .union([z.bigint(), z.number().int().nonnegative(), z.string().regex(/^\d+$/)])
  .transform((value) => BigInt(value));

/**
 * One row of the append-only audit log (CLAUDE.md §4.7). Money inside `detail` is written as
 * integer strings, because JSON cannot carry a bigint.
 */
export const auditEventSchema = z.strictObject({
  id: sequenceIdSchema,
  runId: uuidSchema.nullable(),
  at: instantSchema,
  actor: actorSchema,
  /** A dotted verb such as match.accepted or proposal.rejected. */
  action: z.string().min(1).max(100),
  entityType: z.string().min(1).max(60),
  entityId: z.string().min(1).max(100),
  detail: z.record(z.string(), z.json()),
});
export type AuditEvent = z.output<typeof auditEventSchema>;
