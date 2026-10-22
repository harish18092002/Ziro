import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, one, seedRun, type TestDb } from '../db/migrated-db.fixtures.js';
import { auditEvents } from '../db/schema.js';
import { appendAudit } from './audit.js';

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
