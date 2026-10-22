import {
  type Actor,
  bigintJsonReplacer,
  RECORD_TYPES,
  type RecordRef,
  type RecordType,
} from '@ziro/core/domain';
import type { Executor } from '../db/executor.js';
import { auditEventRecords, auditEvents } from '../db/schema.js';

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

const jsonSafe = <T>(value: T): T => JSON.parse(JSON.stringify(value, bigintJsonReplacer)) as T;

/**
 * Appends one row to the audit trail (CLAUDE.md §4.7). Call it with the same transaction as the
 * change it describes, so the trail and the data can never disagree. The table is append-only at
 * the database level; there is deliberately no update or delete here.
 *
 * `detail` is stored as JSON: bigint (paise) becomes an integer string, anything JSON cannot hold
 * is dropped, so a caller cannot make the insert fail by passing a rich object.
 */
export async function appendAudit(db: Executor, event: AuditInput): Promise<void> {
  const detail = jsonSafe<Record<string, unknown>>(event.detail ?? {});
  await db.insert(auditEvents).values({
    runId: event.runId,
    actor: event.actor,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    detail,
  });
}

/** One step of the story of a record: who did what to which entity, what it was and what it became, and why. */
export interface AuditStep {
  readonly runId: string | null;
  readonly actor: Actor;
  readonly action: string;
  readonly entity: { readonly type: string; readonly id: string };
  /** The state before the step, as the fields that changed (null for a creation). */
  readonly before?: unknown;
  /** The state after the step (null for a removal). */
  readonly after?: unknown;
  readonly reason?: string | null;
  /**
   * The source records this step is about. Every one of them gets this event in its timeline
   * (GET /records/:id/audit). The entity itself is added when it is a source record.
   */
  readonly records?: readonly RecordRef[];
}

const isRecordType = (type: string): type is RecordType =>
  (RECORD_TYPES as readonly string[]).includes(type);

/** The row to insert for a step, and the records it is about (the entity included when it is one). */
function prepare(step: AuditStep) {
  const about = new Map<string, RecordRef>();
  const add = (ref: RecordRef) => about.set(`${ref.recordType}:${ref.recordId}`, ref);
  for (const ref of step.records ?? []) add(ref);
  if (isRecordType(step.entity.type)) {
    add({ recordType: step.entity.type, recordId: step.entity.id });
  }
  return {
    about: [...about.values()],
    values: {
      runId: step.runId,
      actor: step.actor,
      action: step.action,
      entityType: step.entity.type,
      entityId: step.entity.id,
      detail: jsonSafe({
        before: step.before ?? null,
        after: step.after ?? null,
        reason: step.reason ?? null,
        records: [...about.values()],
      }),
    },
  };
}

/**
 * Appends a step in the standard envelope `{ before, after, reason, records }` and indexes the records it
 * concerns, in the caller's transaction. Returns the event id.
 */
export async function auditStep(db: Executor, step: AuditStep): Promise<bigint> {
  const [id] = await insertSteps(db, [step]);
  if (id === undefined) throw new Error('audit insert returned nothing');
  return id;
}

/** Many steps at once, in order. Same result as calling `auditStep` for each, in far fewer statements. */
export async function auditSteps(db: Executor, steps: readonly AuditStep[]): Promise<void> {
  for (let start = 0; start < steps.length; start += STEPS_PER_STATEMENT) {
    await insertSteps(db, steps.slice(start, start + STEPS_PER_STATEMENT));
  }
}

const STEPS_PER_STATEMENT = 400;
const RECORD_ROWS_PER_STATEMENT = 3_000;

async function insertSteps(db: Executor, steps: readonly AuditStep[]): Promise<bigint[]> {
  if (steps.length === 0) return [];
  const prepared = steps.map(prepare);
  const events = await db
    .insert(auditEvents)
    .values(prepared.map((p) => p.values))
    .returning({ id: auditEvents.id });
  // The ids come back in insertion order and ascend; the records below are matched to events by position.
  if (
    events.length !== prepared.length ||
    events.some((e, k) => k > 0 && e.id <= (events[k - 1]?.id ?? 0n))
  ) {
    throw new Error('audit insert did not return its events in order');
  }
  const rows = events.flatMap((event, k) =>
    (prepared[k]?.about ?? []).map((ref) => ({
      auditEventId: event.id,
      recordType: ref.recordType,
      recordId: ref.recordId,
    })),
  );
  for (let start = 0; start < rows.length; start += RECORD_ROWS_PER_STATEMENT) {
    await db.insert(auditEventRecords).values(rows.slice(start, start + RECORD_ROWS_PER_STATEMENT));
  }
  return events.map((e) => e.id);
}
