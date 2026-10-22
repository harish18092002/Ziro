import { z } from 'zod';

/**
 * Who is deciding. There is no login yet, so this is a name the caller gives, recorded in the audit
 * trail as stated: it identifies a reviewer, it does not authenticate one. Authentication is needed
 * before any public deployment.
 */
const reviewer = z.string().trim().min(1).max(100);

export const approveSchema = z.strictObject({
  reviewer,
  note: z.string().trim().min(1).max(1_000).optional(),
});
export type ApproveInput = z.output<typeof approveSchema>;

/** A rejection says why: it sends the exception back to the open list. */
export const rejectSchema = z.strictObject({
  reviewer,
  note: z.string().trim().min(1).max(1_000),
});
export type RejectInput = z.output<typeof rejectSchema>;

export const queueQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type QueueQuery = z.output<typeof queueQuerySchema>;
