import { type Actor, bigintJsonReplacer } from '@ziro/core/domain';
import type { Executor } from '../db/executor.js';
import { auditEvents } from '../db/schema.js';

export interface AuditInput {
  /** The run this concerns, or null for an event that belongs to no run. */
  readonly runId: string | null;
  readonly actor: Actor;
  /** Dotted verb, e.g. `run.create`, `import.ledger`. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Appends one row to the audit trail (CLAUDE.md §4.7). Call it with the same transaction as the
 * change it describes, so the trail and the data can never disagree. The table is append-only at
 * the database level; there is deliberately no update or delete here.
 *
 * `detail` is stored as JSON: bigint (paise) becomes an integer string, anything JSON cannot hold
 * is dropped, so a caller cannot make the insert fail by passing a rich object.
 */
export async function appendAudit(db: Executor, event: AuditInput): Promise<void> {
  const detail = JSON.parse(JSON.stringify(event.detail ?? {}, bigintJsonReplacer)) as Record<
    string,
    unknown
  >;
  await db.insert(auditEvents).values({
    runId: event.runId,
    actor: event.actor,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    detail,
  });
}
