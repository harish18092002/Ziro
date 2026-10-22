import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedDb,
  insertBankLine,
  insertLedger,
  insertPayment,
  insertSettlement,
  pgErrorOf,
  PG,
  seedRun,
  type TestDb,
} from '../db/migrated-db.fixtures.js';
import { auditEventRecords, auditEvents, matchGroups, matchLinks } from '../db/schema.js';
import { isUniqueViolation, writeGroup } from './group-writer.js';

let ctx: Awaited<ReturnType<typeof createMigratedDb>>;
let db: TestDb;
let runId: string;

beforeAll(async () => {
  ctx = await createMigratedDb();
  db = ctx.db;
  runId = await seedRun(db);
});
afterAll(async () => {
  await ctx.client.close();
});

const order = async () => {
  const ledger = await insertLedger(db, runId);
  const payment = await insertPayment(db, runId);
  return {
    ledger,
    payment,
    links: [
      { recordType: 'ledger_entry', recordId: ledger },
      { recordType: 'rzp_payment', recordId: payment },
    ] as const,
  };
};

const spec = (
  links: readonly { recordType: never; recordId: string }[] | readonly unknown[],
  over = {},
) => ({
  runId,
  kind: 'order' as const,
  status: 'accepted' as const,
  basis: 'agent' as const,
  reasonCode: null,
  residual: 0n,
  links: links as never,
  actor: 'human' as const,
  reason: 'test',
  ...over,
});

describe('writeGroup', () => {
  it('writes the group, one link per record, and an audit step that names each record', async () => {
    const o = await order();
    const { groupId } = await writeGroup(db, spec(o.links, { reasonCode: 'UNKNOWN' }));

    const [group] = await db.select().from(matchGroups).where(eq(matchGroups.id, groupId));
    expect(group).toMatchObject({
      runId,
      kind: 'order',
      status: 'accepted',
      basis: 'agent',
      reasonCode: 'UNKNOWN',
      residualPaise: 0n,
    });

    const links = await db.select().from(matchLinks).where(eq(matchLinks.groupId, groupId));
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.groupStatus === 'accepted')).toBe(true);
    expect(links.map((l) => l.ledgerEntryId ?? l.paymentId).sort()).toEqual(
      [o.ledger, o.payment].sort(),
    );

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'group.create'), eq(auditEvents.entityId, groupId)));
    expect(event).toMatchObject({ actor: 'human', entityType: 'match_group', runId });
    expect(event?.detail).toMatchObject({
      before: null,
      reason: 'test',
      after: { kind: 'order', status: 'accepted', links: 2, residualPaise: '0' },
    });
    const indexed = await db
      .select()
      .from(auditEventRecords)
      .where(eq(auditEventRecords.auditEventId, event?.id ?? 0n));
    expect(indexed.map((r) => r.recordId).sort()).toEqual([o.ledger, o.payment].sort());
  });

  it('writes a payout group with its settlement and bank line', async () => {
    const settlement = await insertSettlement(db, runId);
    const bank = await insertBankLine(db, runId);
    const { groupId } = await writeGroup(
      db,
      spec(
        [
          { recordType: 'rzp_settlement', recordId: settlement },
          { recordType: 'bank_line', recordId: bank },
        ],
        { kind: 'payout' },
      ),
    );
    const links = await db.select().from(matchLinks).where(eq(matchLinks.groupId, groupId));
    expect(links.map((l) => l.settlementId ?? l.bankLineId).sort()).toEqual(
      [settlement, bank].sort(),
    );
  });

  it('is the path a rule group takes too: it needs its tier and rule', async () => {
    const o = await order();
    const { groupId } = await writeGroup(
      db,
      spec(o.links, { basis: 'rule', tier: 'T1', ruleId: 'T1.receipt-amount.v1', actor: 'rule' }),
    );
    const [group] = await db.select().from(matchGroups).where(eq(matchGroups.id, groupId));
    expect(group).toMatchObject({ basis: 'rule', tier: 'T1', ruleId: 'T1.receipt-amount.v1' });

    const o2 = await order();
    const error = await pgErrorOf(writeGroup(db, spec(o2.links, { basis: 'rule', actor: 'rule' })));
    expect(error.code).toBe(PG.check);
  });

  it('refuses an accepted group with a residual, and leaves nothing behind', async () => {
    const o = await order();
    const before = (await db.select().from(matchGroups)).length;
    const error = await pgErrorOf(writeGroup(db, spec(o.links, { residual: 1n })));
    expect(error.code).toBe(PG.check);
    expect((await db.select().from(matchGroups)).length).toBe(before);
  });

  it('lets a record sit in at most one accepted group', async () => {
    const o = await order();
    await writeGroup(db, spec(o.links));
    const error = await pgErrorOf(writeGroup(db, spec(o.links)));
    expect(error.code).toBe(PG.unique);
    await expect(writeGroup(db, spec(o.links))).rejects.toSatisfy(isUniqueViolation);
  });

  it('does not restrict proposed groups: several may name one record', async () => {
    const o = await order();
    await writeGroup(db, spec(o.links, { status: 'proposed' }));
    await writeGroup(db, spec(o.links, { status: 'proposed' }));
    const accepted = await writeGroup(db, spec(o.links));
    expect(accepted.groupId).toBeDefined();
  });

  it('writes nothing if the transaction is rolled back', async () => {
    const o = await order();
    const before = (await db.select().from(matchGroups)).length;
    await expect(
      db.transaction(async (tx) => {
        await writeGroup(tx, spec(o.links));
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect((await db.select().from(matchGroups)).length).toBe(before);
  });
});

describe('isUniqueViolation', () => {
  it('finds code 23505 at any depth, and nothing else', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
    expect(isUniqueViolation({ cause: { cause: { code: '23505' } } })).toBe(true);
    expect(isUniqueViolation({ code: '23514' })).toBe(false);
    expect(isUniqueViolation(new Error('x'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
