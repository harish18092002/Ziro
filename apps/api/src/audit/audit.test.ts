import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, one, seedRun, type TestDb } from '../db/migrated-db.fixtures.js';
import { auditEventRecords, auditEvents } from '../db/schema.js';
import { appendAudit, auditStep } from './audit.js';

let ctx: Awaited<ReturnType<typeof createMigratedDb>>;
let db: TestDb;

beforeAll(async () => {
  ctx = await createMigratedDb();
  db = ctx.db;
});
afterAll(async () => {
  await ctx.client.close();
});

describe('appendAudit', () => {
  it('writes one row with the actor, action, entity and detail', async () => {
    const runId = await seedRun(db);
    await appendAudit(db, {
      runId,
      actor: 'system',
      action: 'import.ledger',
      entityType: 'recon_run',
      entityId: runId,
      detail: { rows: { inserted: 3 }, fileName: 'ledger.csv' },
    });
    const row = one(await db.select().from(auditEvents).where(eq(auditEvents.runId, runId)));
    expect(row).toMatchObject({
      actor: 'system',
      action: 'import.ledger',
      entityType: 'recon_run',
      entityId: runId,
      detail: { rows: { inserted: 3 }, fileName: 'ledger.csv' },
    });
    expect(row.at).toBeInstanceOf(Date);
  });

  it('stores bigint paise as integer strings instead of failing on JSON', async () => {
    const runId = await seedRun(db);
    await appendAudit(db, {
      runId,
      actor: 'system',
      action: 'import.bank',
      entityType: 'recon_run',
      entityId: runId,
      detail: { creditsPaise: 12_345_650n, nested: { list: [1n, 2n] } },
    });
    const row = one(await db.select().from(auditEvents).where(eq(auditEvents.runId, runId)));
    expect(row.detail).toEqual({ creditsPaise: '12345650', nested: { list: ['1', '2'] } });
  });

  it('drops values JSON cannot hold, and defaults to an empty detail', async () => {
    const runId = await seedRun(db);
    await appendAudit(db, {
      runId,
      actor: 'system',
      action: 'a',
      entityType: 't',
      entityId: '1',
      detail: { kept: 1, dropped: undefined },
    });
    await appendAudit(db, { runId, actor: 'system', action: 'b', entityType: 't', entityId: '2' });
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.runId, runId));
    expect(rows.map((r) => r.detail)).toEqual([{ kept: 1 }, {}]);
  });

  it('allows an event that belongs to no run, and numbers events in order', async () => {
    await appendAudit(db, {
      runId: null,
      actor: 'human',
      action: 'x',
      entityType: 't',
      entityId: '1',
    });
    await appendAudit(db, {
      runId: null,
      actor: 'human',
      action: 'y',
      entityType: 't',
      entityId: '2',
    });
    const rows = await db.select().from(auditEvents).where(eq(auditEvents.actor, 'human'));
    expect(rows.map((r) => r.action)).toEqual(['x', 'y']);
    expect(rows[1]!.id).toBeGreaterThan(rows[0]!.id);
  });
});

describe('auditStep', () => {
  const ref = (recordType: 'rzp_payment' | 'bank_line' | 'ledger_entry') => ({
    recordType,
    recordId: crypto.randomUUID(),
  });

  it('writes the standard envelope and indexes every record it is about', async () => {
    const runId = await seedRun(db);
    const payment = ref('rzp_payment');
    const bank = ref('bank_line');
    const id = await auditStep(db, {
      runId,
      actor: 'human',
      action: 'review.approve',
      entity: { type: 'agent_proposal', id: 'prop-1' },
      before: { status: 'proposed' },
      after: { status: 'accepted', amount: 250_000n },
      reason: 'looks right',
      records: [payment, bank],
    });
    const event = one(await db.select().from(auditEvents).where(eq(auditEvents.id, id)));
    expect(event).toMatchObject({
      actor: 'human',
      action: 'review.approve',
      entityType: 'agent_proposal',
      entityId: 'prop-1',
    });
    expect(event.detail).toEqual({
      before: { status: 'proposed' },
      after: { status: 'accepted', amount: '250000' },
      reason: 'looks right',
      records: [payment, bank],
    });
    const rows = await db
      .select()
      .from(auditEventRecords)
      .where(eq(auditEventRecords.auditEventId, id));
    expect(rows.map((r) => r.recordId).sort()).toEqual([payment.recordId, bank.recordId].sort());
  });

  it('defaults before, after and reason to null, and indexes nothing when there are no records', async () => {
    const id = await auditStep(db, {
      runId: null,
      actor: 'system',
      action: 'noop',
      entity: { type: 'recon_run', id: 'r' },
    });
    const event = one(await db.select().from(auditEvents).where(eq(auditEvents.id, id)));
    expect(event.detail).toEqual({ before: null, after: null, reason: null, records: [] });
    expect(
      await db.select().from(auditEventRecords).where(eq(auditEventRecords.auditEventId, id)),
    ).toHaveLength(0);
  });

  it('adds the entity itself when it is a source record, even if no record is named', async () => {
    const payment = ref('rzp_payment');
    const id = await auditStep(db, {
      runId: null,
      actor: 'rule',
      action: 'record.touch',
      entity: { type: 'rzp_payment', id: payment.recordId },
    });
    const rows = await db
      .select()
      .from(auditEventRecords)
      .where(eq(auditEventRecords.auditEventId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recordType: 'rzp_payment', recordId: payment.recordId });
  });

  it('lists a record once however often it is named, the entity included', async () => {
    const payment = ref('rzp_payment');
    const id = await auditStep(db, {
      runId: null,
      actor: 'rule',
      action: 'record.touch',
      entity: { type: 'rzp_payment', id: payment.recordId },
      records: [payment, payment],
    });
    const rows = await db
      .select()
      .from(auditEventRecords)
      .where(eq(auditEventRecords.auditEventId, id));
    expect(rows).toHaveLength(1);
  });

  it('does not index an entity that is not a source record', async () => {
    const id = await auditStep(db, {
      runId: null,
      actor: 'agent',
      action: 'x',
      entity: { type: 'agent_proposal', id: crypto.randomUUID() },
    });
    expect(
      await db.select().from(auditEventRecords).where(eq(auditEventRecords.auditEventId, id)),
    ).toHaveLength(0);
  });
});
