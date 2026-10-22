// The recon service on the generated demo dataset, end to end through the real importer: the rows go
// into the database, come back out as domain records, and the matcher's answer must be the answer it
// gives when run directly on the same data. Nothing may be lost or changed by the round trip.
import { runMatcher } from '@ziro/core/matcher';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, count, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../config/config.module.js';
import { loadEnv } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { createMigratedDb, type TestDb } from '../db/migrated-db.fixtures.js';
import {
  auditEventRecords,
  auditEvents,
  bankLines,
  ledgerEntries,
  matchGroups,
  matchLinks,
  reconExceptions,
  reconRuns,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
} from '../db/schema.js';
import { windowsFor } from '../demo/windows.js';
import { IngestModule } from '../ingest/ingest.module.js';
import { IngestService } from '../ingest/ingest.service.js';
import { loadDomainDataset, matcherConfigFor } from '../matcher-eval/dataset.js';
import { makeSyntheticDataset, type TempDataset } from '../razorpay/razorpay.fixtures.js';
import { ReconModule } from './recon.module.js';
import { ReconService } from './recon.service.js';

let data: TempDataset;
let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let app: INestApplication;
let ingest: IngestService;
let recon: ReconService;

const env = () =>
  loadEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5433/d',
    REDIS_URL: 'redis://localhost:6379',
    RAZORPAY_SOURCE: 'synthetic',
    SYNTHETIC_DATA_DIR: data.dir,
    AGENT_MODEL_SMALL: 'small',
    AGENT_MODEL_LARGE: 'large',
    AGENT_HARNESS: 'loop',
    AUTO_ACCEPT_ENABLED: 'false',
    AUTO_ACCEPT_MAX_PAISE: '0',
    DEMO_MODE: 'true',
    DAILY_LLM_BUDGET_USD: '5',
    AGENT_KILL_SWITCH: 'false',
  });

beforeAll(async () => {
  data = makeSyntheticDataset('demo', 42);
  ({ db, client } = await createMigratedDb());
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(env()), IngestModule, ReconModule],
  })
    .overrideProvider(DB)
    .useValue(db)
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  ingest = moduleRef.get(IngestService);
  recon = moduleRef.get(ReconService);
}, 120_000);
afterAll(async () => {
  await app.close();
  await client.close();
  data.cleanup();
});

/** A freshly imported demo run, with the date windows the dataset was generated with. */
async function importedRun(): Promise<string> {
  const { run } = await ingest.createDemo(data.dir);
  await db
    .update(reconRuns)
    .set({ config: { windows: windowsFor('demo', 42) } })
    .where(eq(reconRuns.id, run.id));
  return run.id;
}

const countIn = async (table: typeof matchGroups | typeof reconExceptions, runId: string) =>
  (await db.select({ n: count() }).from(table).where(eq(table.runId, runId)))[0]?.n ?? 0;

describe('ReconService.match', () => {
  it('keeps exactly what the matcher finds on the same data', async () => {
    const runId = await importedRun();
    const result = await recon.match(runId);

    // The same data through the pure matcher, with the same windows, without the database in between.
    const direct = await loadDomainDataset(data.dir);
    const expected = runMatcher(direct.input, matcherConfigFor(42, 'demo'));
    expect(result).toMatchObject({
      groups: expected.groups.length,
      exceptions: expected.exceptions.length,
      ignored: expected.ignored.length,
      alreadyMatched: false,
    });
    expect(await countIn(matchGroups, runId)).toBe(expected.groups.length);
    expect(await countIn(reconExceptions, runId)).toBe(expected.exceptions.length);

    // Exception by exception, by business key (record ids differ between runs; keys do not).
    const keyOf = new Map<string, string>();
    for (const l of await db.select().from(ledgerEntries).where(eq(ledgerEntries.runId, runId)))
      keyOf.set(l.id, `ledger_entry:${l.orderRef}`);
    for (const p of await db.select().from(rzpPayments).where(eq(rzpPayments.runId, runId)))
      keyOf.set(p.id, `rzp_payment:${p.rzpId}`);
    for (const r of await db.select().from(rzpRefunds).where(eq(rzpRefunds.runId, runId)))
      keyOf.set(r.id, `rzp_refund:${r.rzpId}`);
    for (const s of await db.select().from(rzpSettlements).where(eq(rzpSettlements.runId, runId)))
      keyOf.set(s.id, `rzp_settlement:${s.rzpId}`);
    for (const b of await db.select().from(bankLines).where(eq(bankLines.runId, runId)))
      keyOf.set(b.id, `bank_line:${b.sourceRef}`);

    const stored = (await db.select().from(reconExceptions).where(eq(reconExceptions.runId, runId)))
      .map((e) => `${e.reasonCode} ${e.cause} ${keyOf.get(e.subjectId)} ${e.amountAtStakePaise}`)
      .sort();
    const wanted = expected.exceptions
      .map(
        (e) =>
          `${e.reasonCode} ${e.cause} ${direct.truthKey.get(e.subject.recordId)} ${e.amountAtStake}`,
      )
      .sort();
    expect(stored).toEqual(wanted);
  });

  it('writes every rule group accepted, with its tier and rule, and every exception open with its candidates', async () => {
    const runId = await importedRun();
    await recon.match(runId);
    const groups = await db.select().from(matchGroups).where(eq(matchGroups.runId, runId));
    expect(groups.length).toBeGreaterThan(0);
    expect(
      groups.every(
        (g) =>
          g.status === 'accepted' &&
          g.basis === 'rule' &&
          g.tier !== null &&
          g.ruleId !== null &&
          g.residualPaise === 0n,
      ),
    ).toBe(true);
    const links = await db.select().from(matchLinks).where(eq(matchLinks.groupStatus, 'accepted'));
    expect(links.length).toBeGreaterThanOrEqual(groups.length * 2);

    const exceptions = await db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.runId, runId));
    expect(
      exceptions.every((e) => e.status === 'open' && e.cause !== null && e.note !== null),
    ).toBe(true);
    expect(exceptions.some((e) => Array.isArray(e.candidates) && e.candidates.length > 0)).toBe(
      true,
    );
  });

  it('audits every group and exception, and indexes the records for their timelines', async () => {
    const runId = await importedRun();
    const result = await recon.match(runId);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.runId, runId));
    const named = (action: string) => events.filter((e) => e.action === action);
    expect(named('group.create')).toHaveLength(result.groups);
    expect(named('exception.create')).toHaveLength(result.exceptions);
    expect(named('run.match')).toHaveLength(1);
    expect(named('group.create').every((e) => e.actor === 'rule')).toBe(true);
    const indexed = await db.select({ n: count() }).from(auditEventRecords);
    expect(indexed[0]?.n).toBeGreaterThan(result.groups);
  });

  it('moves the run to matching and records what it found', async () => {
    const runId = await importedRun();
    const result = await recon.match(runId);
    const [run] = await db.select().from(reconRuns).where(eq(reconRuns.id, runId));
    expect(run?.status).toBe('matching');
    expect(run?.config).toMatchObject({
      match: { groups: result.groups, exceptions: result.exceptions },
      windows: { orderDateWindowDays: 3 },
    });
  });

  it('is idempotent: matching again changes nothing and says so', async () => {
    const runId = await importedRun();
    const first = await recon.match(runId);
    const groupsBefore = await countIn(matchGroups, runId);
    const eventsBefore = (await db.select().from(auditEvents).where(eq(auditEvents.runId, runId)))
      .length;
    const again = await recon.match(runId);
    expect(again).toMatchObject({
      groups: first.groups,
      exceptions: first.exceptions,
      alreadyMatched: true,
    });
    expect(await countIn(matchGroups, runId)).toBe(groupsBefore);
    expect((await db.select().from(auditEvents).where(eq(auditEvents.runId, runId))).length).toBe(
      eventsBefore,
    );
  });

  it('lets exactly one of two simultaneous calls do the work', async () => {
    const runId = await importedRun();
    const results = await Promise.allSettled([recon.match(runId), recon.match(runId)]);
    const done = results.filter((r) => r.status === 'fulfilled' && !r.value.alreadyMatched);
    expect(done).toHaveLength(1);
    // The other either saw the finished result or was told the run is mid-match; it never matched twice.
    const groups = await db.select().from(matchGroups).where(eq(matchGroups.runId, runId));
    const keys = new Set(groups.map((g) => g.id));
    expect(keys.size).toBe(groups.length);
    expect(
      (
        await db
          .select()
          .from(auditEvents)
          .where(and(eq(auditEvents.runId, runId), eq(auditEvents.action, 'run.match')))
      ).length,
    ).toBe(1);
  });

  it('writes nothing, and hands the run back, if anything fails', async () => {
    const runId = await importedRun();
    // A leftover exception for a record the matcher will also raise one for: the write must fail whole.
    const direct = await loadDomainDataset(data.dir);
    const expected = runMatcher(direct.input, matcherConfigFor(42, 'demo'));
    const first = expected.exceptions[0];
    if (first === undefined) throw new Error('the demo data should leave exceptions');
    const key = direct.truthKey.get(first.subject.recordId) ?? '';
    const [type, ...rest] = key.split(':');
    const ref = rest.join(':');
    const subjectId =
      type === 'ledger_entry'
        ? (
            await db
              .select()
              .from(ledgerEntries)
              .where(and(eq(ledgerEntries.runId, runId), eq(ledgerEntries.orderRef, ref)))
          )[0]?.id
        : type === 'rzp_payment'
          ? (
              await db
                .select()
                .from(rzpPayments)
                .where(and(eq(rzpPayments.runId, runId), eq(rzpPayments.rzpId, ref)))
            )[0]?.id
          : type === 'rzp_settlement'
            ? (
                await db
                  .select()
                  .from(rzpSettlements)
                  .where(and(eq(rzpSettlements.runId, runId), eq(rzpSettlements.rzpId, ref)))
              )[0]?.id
            : (
                await db
                  .select()
                  .from(bankLines)
                  .where(and(eq(bankLines.runId, runId), eq(bankLines.sourceRef, ref)))
              )[0]?.id;
    expect(subjectId).toBeDefined();
    await db.insert(reconExceptions).values({
      runId,
      reasonCode: 'UNKNOWN',
      subjectType: first.subject.recordType,
      subjectId: subjectId ?? '',
    });
    await expect(recon.match(runId)).rejects.toThrow();
    expect(await countIn(matchGroups, runId)).toBe(0);
    expect((await db.select().from(reconRuns).where(eq(reconRuns.id, runId)))[0]?.status).not.toBe(
      'matching',
    );
  });

  it('answers 404 for an unknown run and refuses a failed one', async () => {
    await expect(recon.match('00000000-0000-4000-8000-0000000000aa')).rejects.toMatchObject({
      status: 404,
    });
    const runId = await importedRun();
    await db.update(reconRuns).set({ status: 'failed' }).where(eq(reconRuns.id, runId));
    await expect(recon.match(runId)).rejects.toMatchObject({ status: 409 });
  });
});

describe('POST /runs/:id/match', () => {
  it('matches, then reports the run as already matched', async () => {
    const runId = await importedRun();
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    const first = await request(server).post(`/runs/${runId}/match`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ alreadyMatched: false });
    const second = await request(server).post(`/runs/${runId}/match`);
    expect(second.body).toMatchObject({
      alreadyMatched: true,
      groups: (first.body as { groups: number }).groups,
    });
    expect((await request(server).post('/runs/not-a-uuid/match')).status).toBe(400);
  });
});
