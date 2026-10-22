// What goes through the queue. A job names the exceptions to investigate and which attempt of each it
// is; it carries no record data, so nothing sensitive sits in Redis. The same job always gets the
// same key, so enqueueing twice is one job.
import { z } from 'zod';
import { MAX_CLUSTER_MEMBERS } from './output.js';

export const investigationJobSchema = z.strictObject({
  runId: z.uuid(),
  /** Set when one conversation covers several exceptions. */
  clusterId: z.uuid().nullable(),
  items: z
    .array(z.strictObject({ exceptionId: z.uuid(), attempt: z.number().int().min(1).max(1_000) }))
    .min(1)
    .max(MAX_CLUSTER_MEMBERS),
});
export type InvestigationJob = z.output<typeof investigationJobSchema>;

/**
 * BullMQ rejects custom ids containing ":". A single exception's key is (exception id, attempt), the
 * idempotency key from the brief; a cluster's is its cluster id, itself derived from its members.
 */
export function jobKey(job: InvestigationJob): string {
  const [only] = job.items;
  if (job.clusterId === null && job.items.length === 1 && only !== undefined) {
    return `${only.exceptionId}-${only.attempt}`;
  }
  return `cluster-${job.clusterId ?? job.items.map((i) => `${i.exceptionId}-${i.attempt}`).join('_')}`;
}
