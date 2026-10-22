import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  createMigratedDb,
  insertLedger,
  seedRun,
  type TestDb,
} from '../db/migrated-db.fixtures.js';
import { auditStep } from './audit.js';
import { MAX_TIMELINE_EVENTS, TimelineService } from './timeline.service.js';

let ctx: Awaited<ReturnType<typeof createMigratedDb>>;
let db: TestDb;
beforeAll(async () => {
  ctx = await createMigratedDb();
  db = ctx.db;
});
afterAll(async () => {
  await ctx.client.close();
});

async function touch(recordId: string, runId: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    await auditStep(db, {
      runId,
      actor: 'rule',
      action: `touch.${String(i).padStart(4, '0')}`,
      entity: { type: 'test', id: 'x' },
      records: [{ recordType: 'ledger_entry', recordId }],
    });
  }
}

describe('TimelineService', () => {
  it('lists the import first and every step after it, oldest first', async () => {
    const runId = await seedRun(db);
    const id = await insertLedger(db, runId);
    await touch(id, runId, 3);
    const { timeline, truncated, record } = await new TimelineService(db).timeline(id);
    expect(record).toMatchObject({ type: 'ledger_entry', id, runId });
    expect(truncated).toBe(false);
    expect(timeline.map((e) => e.action)).toEqual([
      'record.imported',
      'touch.0000',
      'touch.0001',
      'touch.0002',
    ]);
  });

  it('never mixes in the steps of another record', async () => {
    const runId = await seedRun(db);
    const a = await insertLedger(db, runId);
    const b = await insertLedger(db, runId);
    await touch(a, runId, 2);
    await touch(b, runId, 1);
    const result = await new TimelineService(db).timeline(b);
    expect(result.timeline.map((e) => e.action)).toEqual(['record.imported', 'touch.0000']);
  });

  it('cuts a very long history and says so', async () => {
    const runId = await seedRun(db);
    const id = await insertLedger(db, runId);
    await touch(id, runId, MAX_TIMELINE_EVENTS + 5);
    const { timeline, truncated } = await new TimelineService(db).timeline(id);
    expect(truncated).toBe(true);
    expect(timeline).toHaveLength(MAX_TIMELINE_EVENTS + 1); // the import and the first 500 steps
    expect(timeline.at(-1)?.action).toBe(
      `touch.${String(MAX_TIMELINE_EVENTS - 1).padStart(4, '0')}`,
    );
  });

  it('does not call a history of exactly the maximum truncated', async () => {
    const runId = await seedRun(db);
    const id = await insertLedger(db, runId);
    await touch(id, runId, MAX_TIMELINE_EVENTS);
    const { truncated, timeline } = await new TimelineService(db).timeline(id);
    expect(truncated).toBe(false);
    expect(timeline).toHaveLength(MAX_TIMELINE_EVENTS + 1);
  });

  it('refuses an id that is no record', async () => {
    await expect(
      new TimelineService(db).timeline('00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
