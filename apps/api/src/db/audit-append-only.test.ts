import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedDb,
  insertAudit,
  one,
  pgErrorOf,
  PG,
  seedRun,
  type TestDb,
} from './migrated-db.fixtures.js';
import { auditEvents, reconRuns } from './schema.js';

let ctx: Awaited<ReturnType<typeof createMigratedDb>>;
let db: TestDb;

beforeAll(async () => {
  ctx = await createMigratedDb();
  db = ctx.db;
});
afterAll(async () => {
  await ctx.client.close();
});

// restrict_violation is the SQLSTATE the trigger raises; the message names the blocked operation.
const BLOCKED = (op: 'UPDATE' | 'DELETE' | 'TRUNCATE') => ({
  code: PG.restrict,
  message: expect.stringContaining(`audit_events is append-only: ${op} is not allowed`) as unknown,
});

describe('audit_events is append-only', () => {
  it('allows INSERT and numbers events in order', async () => {
    const first = one(await insertAudit(db, { action: 'order.first' }));
    const second = one(await insertAudit(db, { action: 'order.second' }));
    expect(typeof first.id).toBe('bigint');
    expect(second.id).toBeGreaterThan(first.id);
  });

  it('rejects UPDATE through the ORM and leaves the row untouched', async () => {
    const { id } = one(await insertAudit(db, { action: 'match.accepted', entityId: 'g-1' }));

    const error = await pgErrorOf(
      db.update(auditEvents).set({ action: 'match.tampered' }).where(eq(auditEvents.id, id)),
    );
    expect(error).toMatchObject(BLOCKED('UPDATE'));

    const row = one(await db.select().from(auditEvents).where(eq(auditEvents.id, id)));
    expect(row).toMatchObject({ action: 'match.accepted', entityId: 'g-1' });
  });

  it('rejects UPDATE of any column, including the actor and the timestamp', async () => {
    const { id } = one(await insertAudit(db));
    for (const change of [
      { actor: 'human' as const },
      { at: new Date('2000-01-01T00:00:00Z') },
      { detail: { forged: true } },
      { entityId: 'someone-else' },
    ]) {
      const error = await pgErrorOf(
        db.update(auditEvents).set(change).where(eq(auditEvents.id, id)),
      );
      expect(error, JSON.stringify(Object.keys(change))).toMatchObject(BLOCKED('UPDATE'));
    }
  });

  it('rejects DELETE of one row and of all rows', async () => {
    const { id } = one(await insertAudit(db, { action: 'to.keep' }));

    expect(await pgErrorOf(db.delete(auditEvents).where(eq(auditEvents.id, id)))).toMatchObject(
      BLOCKED('DELETE'),
    );
    expect(await pgErrorOf(db.delete(auditEvents))).toMatchObject(BLOCKED('DELETE'));

    const survivors = await db.select().from(auditEvents).where(eq(auditEvents.id, id));
    expect(survivors).toHaveLength(1);
  });

  it('rejects TRUNCATE, which a row-level trigger alone would miss', async () => {
    await insertAudit(db);
    const error = await pgErrorOf(ctx.client.query('TRUNCATE audit_events'));
    expect(error).toMatchObject(BLOCKED('TRUNCATE'));
    const { rows } = await ctx.client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_events',
    );
    expect(one(rows).n).toBeGreaterThan(0);
  });

  it('rejects UPDATE and DELETE issued as raw SQL, bypassing the ORM', async () => {
    await insertAudit(db);
    expect(await pgErrorOf(ctx.client.query(`UPDATE audit_events SET action = 'x'`))).toMatchObject(
      BLOCKED('UPDATE'),
    );
    expect(await pgErrorOf(ctx.client.query('DELETE FROM audit_events'))).toMatchObject(
      BLOCKED('DELETE'),
    );
  });

  it('keeps every row after all of the attempts above', async () => {
    const before = (await db.select().from(auditEvents)).length;
    await pgErrorOf(db.delete(auditEvents));
    await pgErrorOf(db.update(auditEvents).set({ action: 'x' }));
    const after = await db.select().from(auditEvents);
    expect(after).toHaveLength(before);
    expect(after.some((row) => row.action === 'x')).toBe(false);
  });

  it('is enforced by exactly the two triggers the migration creates', async () => {
    const { rows } = await ctx.client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid = 'audit_events'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      'audit_events_no_truncate',
      'audit_events_no_update_delete',
    ]);
  });

  it('cannot be erased by deleting its run: the foreign key restricts it', async () => {
    const runId = await seedRun(db);
    await insertAudit(db, { runId });
    const error = await pgErrorOf(db.delete(reconRuns).where(eq(reconRuns.id, runId)));
    expect(error.code).toBe(PG.restrict);
  });

  it('a rolled-back transaction leaves no trace, but a committed event is permanent', async () => {
    await pgErrorOf(
      db.transaction(async (tx) => {
        await insertAudit(tx as unknown as TestDb, { action: 'rolled.back' });
        throw new Error('abort');
      }),
    );
    const rolledBack = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'rolled.back'));
    expect(rolledBack).toHaveLength(0);

    const { id } = one(await insertAudit(db, { action: 'committed' }));
    await pgErrorOf(db.delete(auditEvents).where(eq(auditEvents.id, id)));
    expect(await db.select().from(auditEvents).where(eq(auditEvents.id, id))).toHaveLength(1);
  });
});
