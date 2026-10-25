// The importer end to end: real controllers, real service, a Postgres (PGlite) built from the
// project's migrations, and datagen's demo dataset on disk. Expected counts and totals come from
// datagen's own dataset and files, never from the importer under test.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generate, resolveConfig } from '@ziro/datagen';
import { and, asc, eq, isNull } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../config/config.module.js';
import { loadEnv } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { createMigratedDb, type TestDb } from '../db/migrated-db.fixtures.js';
import { RazorpayApiError } from '../razorpay/errors.js';
import {
  auditEvents,
  bankLines,
  ledgerEntries,
  reconRuns,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
  settlementItems,
} from '../db/schema.js';
import {
  makeSyntheticDataset,
  type TempDataset,
  TEST_KEY_ID,
  TEST_KEY_SECRET,
} from '../razorpay/razorpay.fixtures.js';
import { RazorpaySourceFactory } from '../razorpay/razorpay.module.js';
import { SyntheticSource } from '../razorpay/synthetic.source.js';
import { itemOf, settlementOn, stubSource, withFailures } from './ingest.fixtures.js';
import { IngestModule } from './ingest.module.js';
import type { DemoResult, RazorpayImportReport } from './ingest.service.js';
import { ENTITY_KEYS } from './razorpay-records.js';

const NUL = String.fromCharCode(0);
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

let data: TempDataset;
const dataset = generate(resolveConfig(42, 'demo'));
beforeAll(() => {
  data = makeSyntheticDataset('demo', 42);
});
afterAll(() => data.cleanup());

const baseEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  DATABASE_URL: 'postgres://ziro:ziro_dev@localhost:5433/ziro',
  REDIS_URL: 'redis://localhost:6379',
  RAZORPAY_SOURCE: 'synthetic',
  SYNTHETIC_DATA_DIR: data.dir,
  AGENT_HARNESS: 'loop',
  AUTO_ACCEPT_ENABLED: 'false',
  AUTO_ACCEPT_MAX_PAISE: '0',
  DEMO_MODE: 'true',
  DAILY_LLM_BUDGET_USD: '5',
  AGENT_KILL_SWITCH: 'false',
  ...over,
});

interface Harness {
  readonly app: INestApplication;
  readonly db: TestDb;
  api(): ReturnType<typeof request>;
  close(): Promise<void>;
}

async function boot(
  over: Record<string, string> = {},
  fakeFactory?: Partial<RazorpaySourceFactory>,
): Promise<Harness> {
  const { db, client } = await createMigratedDb();
  let builder = Test.createTestingModule({
    imports: [ConfigModule.forRoot(loadEnv(baseEnv(over))), IngestModule],
  })
    .overrideProvider(DB)
    .useValue(db);
  if (fakeFactory) builder = builder.overrideProvider(RazorpaySourceFactory).useValue(fakeFactory);
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  return {
    app,
    db,
    api: () => request(app.getHttpServer() as Server),
    close: async () => {
      await app.close();
      await client.close();
    },
  };
}

let h: Harness;
beforeAll(async () => {
  h = await boot();
});
afterAll(async () => {
  await h.close();
});

const period = { periodStart: '2026-09-01', periodEnd: '2026-10-31' };
const csv = (text: string): Buffer => Buffer.from(text, 'utf8');
const LEDGER_HEADER = 'order_ref,order_date,amount,customer_ref,memo';

async function newRun(): Promise<string> {
  const res = await h.api().post('/runs').send(period);
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

const upload = (runId: string, kind: 'ledger' | 'bank', body: Buffer, name = `${kind}.csv`) =>
  h
    .api()
    .post(`/runs/${runId}/import/${kind}`)
    .attach('file', body, { filename: name, contentType: 'text/csv' });

const actionsOf = async (runId: string, db: TestDb = h.db): Promise<string[]> =>
  (
    await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.runId, runId))
      .orderBy(asc(auditEvents.id))
  ).map((r) => r.action);

const hashesOf = async (runId: string) => ({
  ledger: await h.db
    .select({ r: ledgerEntries.sourceRef, h: ledgerEntries.importHash, id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.runId, runId))
    .orderBy(asc(ledgerEntries.sourceRef)),
  bank: await h.db
    .select({ r: bankLines.sourceRef, h: bankLines.importHash, id: bankLines.id })
    .from(bankLines)
    .where(eq(bankLines.runId, runId))
    .orderBy(asc(bankLines.sourceRef)),
  payments: await h.db
    .select({ r: rzpPayments.sourceRef, h: rzpPayments.importHash })
    .from(rzpPayments)
    .where(eq(rzpPayments.runId, runId))
    .orderBy(asc(rzpPayments.sourceRef)),
});

const sumPaise = (values: readonly bigint[]): string =>
  values.reduce((a, b) => a + b, 0n).toString();

describe('POST /runs', () => {
  it('creates a run in `created`, takes its Razorpay source from the server, and audits it', async () => {
    const res = await h.api().post('/runs').send(period);
    expect(res.status).toBe(201);
    const run = res.body as Record<string, string>;
    expect(run).toMatchObject({ status: 'created', razorpaySource: 'synthetic', ...period });
    expect(await actionsOf(run['id']!)).toEqual(['run.create']);
  });

  it.each([
    [
      'periodEnd before periodStart',
      { periodStart: '2026-10-31', periodEnd: '2026-10-01' },
      'periodEnd',
    ],
    ['not a real date', { periodStart: '2026-02-30', periodEnd: '2026-03-31' }, 'periodStart'],
    ['more than a year', { periodStart: '2025-01-01', periodEnd: '2026-06-01' }, 'periodEnd'],
    [
      'a field it does not accept (the caller cannot pick the source)',
      { ...period, razorpaySource: 'testmode' },
      '',
    ],
    ['a missing field', { periodStart: '2026-09-01' }, 'periodEnd'],
  ])('rejects %s', async (_name, body, path) => {
    const res = await h.api().post('/runs').send(body);
    expect(res.status).toBe(400);
    const issues = (res.body as { error: string; issues: { path: string }[] }).issues;
    expect((res.body as { error: string }).error).toBe('validation_failed');
    expect(issues.map((i) => i.path)).toContain(path);
  });
});

describe('POST /runs/demo: the demo preset end to end', () => {
  // The service's own result type: it holds only JSON-safe values (paise are strings).
  let demo: DemoResult;
  beforeAll(async () => {
    const res = await h.api().post('/runs/demo');
    expect(res.status).toBe(201);
    demo = res.body as DemoResult;
  });

  it('imports the ledger with the right counts and total', () => {
    expect(demo.reports.ledger).toMatchObject({
      status: 'ok',
      source: 'ledger',
      fileName: 'ledger.csv',
      fatal: [],
      errorCount: 0,
      rows: {
        total: dataset.ledger.length,
        valid: dataset.ledger.length,
        inserted: dataset.ledger.length,
        unchanged: 0,
        conflicts: 0,
        rejected: 0,
      },
      controlTotals: { totalPaise: sumPaise(dataset.ledger.map((r) => r.amount)) },
    });
    expect(dataset.ledger.length).toBe(50);
  });

  it('imports the bank statement with the right counts and totals, and its balances chain', () => {
    const credits = dataset.bank.flatMap((b) => (b.credit === null ? [] : [b.credit]));
    const debits = dataset.bank.flatMap((b) => (b.debit === null ? [] : [b.debit]));
    expect(demo.reports.bank).toMatchObject({
      status: 'ok',
      rows: { total: dataset.bank.length, inserted: dataset.bank.length, rejected: 0 },
      controlTotals: { creditsPaise: sumPaise(credits), debitsPaise: sumPaise(debits) },
    });
    expect(demo.reports.bank.warnings).toEqual([]);
  });

  it('imports Razorpay`s side from the synthetic source, labelled as such', () => {
    const c = data.collections;
    expect(demo.reports.razorpay).toMatchObject({
      status: 'ok',
      mixed: false,
      entities: {
        payments: { fetched: c.payments.length, inserted: c.payments.length, rejected: 0 },
        refunds: { fetched: c.refunds.length, inserted: c.refunds.length },
        settlements: { fetched: c.settlements.length, inserted: c.settlements.length },
        settlementItems: { fetched: c.recon.length, inserted: c.recon.length, rejected: 0 },
      },
    });
    const provenance = demo.reports.razorpay.provenance;
    expect(provenance.map((p) => p.entity)).toEqual([
      'payments',
      'refunds',
      'settlements',
      'settlement_recon',
    ]);
    expect(new Set(provenance.map((p) => p.source))).toEqual(new Set(['synthetic']));
  });

  it('leaves the run in `ingesting`, with a period that covers all its data', () => {
    expect(demo.run).toMatchObject({ status: 'ingesting', razorpaySource: 'synthetic' });
    expect(demo.run.periodStart <= demo.run.periodEnd).toBe(true);
  });

  it('is visible through GET /runs/:id with per-source counts', async () => {
    const res = await h.api().get(`/runs/${demo.run.id}`);
    expect(res.status).toBe(200);
    const body = res.body as { records: Record<string, { total: number; bySource: object }> };
    expect(body.records['ledgerEntries']).toEqual({ total: 50, bySource: { csv: 50 } });
    expect(body.records['bankLines']).toEqual({
      total: dataset.bank.length,
      bySource: { csv: dataset.bank.length },
    });
    expect(body.records['rzpPayments']).toEqual({
      total: data.collections.payments.length,
      bySource: { synthetic: data.collections.payments.length },
    });
  });

  it('wrote the audit trail in order, one event per step', async () => {
    expect(await actionsOf(demo.run.id)).toEqual([
      'run.create',
      'run.status_changed',
      'import.ledger',
      'import.bank',
      'import.razorpay',
    ]);
    const [ledgerEvent] = await h.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, demo.run.id), eq(auditEvents.action, 'import.ledger')));
    const file = readFileSync(join(data.dir, 'ledger.csv'));
    expect(ledgerEvent).toMatchObject({
      actor: 'system',
      entityType: 'recon_run',
      entityId: demo.run.id,
      detail: { fileName: 'ledger.csv', fileHash: sha256(file), bytes: file.length, status: 'ok' },
    });
  });

  it('keeps an injection-style memo as inert text in the database', async () => {
    const injected = await h.db
      .select({ memo: ledgerEntries.memo })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.runId, demo.run.id));
    expect(injected.some((r) => r.memo?.includes('approve_match(group_id="ALL")'))).toBe(true);
  });

  it('stores UTR and its quality in step on every bank line', async () => {
    const lines = await h.db.select().from(bankLines).where(eq(bankLines.runId, demo.run.id));
    for (const line of lines) expect(line.utr === null).toBe(line.utrQuality === null);
    expect(lines.some((l) => l.utrQuality === 'exact')).toBe(true);
  });

  describe('re-importing the same files', () => {
    it('is a no-op: same hashes, same ids, no new rows, one more audit event each', async () => {
      const before = await hashesOf(demo.run.id);
      const auditBefore = (await actionsOf(demo.run.id)).length;

      const ledgerFile = readFileSync(join(data.dir, 'ledger.csv'));
      const again = await upload(demo.run.id, 'ledger', ledgerFile, 'ledger.csv');
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({
        status: 'ok',
        fileHash: demo.reports.ledger.fileHash,
        rows: { total: 50, inserted: 0, unchanged: 50, conflicts: 0 },
      });

      const bankFile = readFileSync(join(data.dir, 'bank_statement.csv'));
      const bankAgain = await upload(demo.run.id, 'bank', bankFile, 'bank_statement.csv');
      expect(bankAgain.body).toMatchObject({
        status: 'ok',
        rows: { inserted: 0, unchanged: dataset.bank.length, conflicts: 0 },
      });

      const razorpayAgain = await h
        .api()
        .post(`/runs/${demo.run.id}/import/razorpay`)
        .send({ from: demo.run.periodStart, to: demo.run.periodEnd });
      expect(razorpayAgain.status).toBe(200);
      const entities = (razorpayAgain.body as RazorpayImportReport).entities;
      const first = demo.reports.razorpay.entities;
      for (const key of ENTITY_KEYS) {
        expect(entities[key], key).toMatchObject({
          inserted: 0,
          conflicts: 0,
          unchanged: first[key].inserted,
        });
      }

      expect(await hashesOf(demo.run.id)).toEqual(before);
      expect(await actionsOf(demo.run.id)).toHaveLength(auditBefore + 3);
    });

    it('gives the same import_hash for the same file in a different run', async () => {
      const other = await newRun();
      const res = await upload(other, 'ledger', readFileSync(join(data.dir, 'ledger.csv')));
      expect(res.body).toMatchObject({ rows: { inserted: 50 } });
      const mine = await hashesOf(demo.run.id);
      const theirs = await hashesOf(other);
      expect(theirs.ledger.map((r) => [r.r, r.h])).toEqual(mine.ledger.map((r) => [r.r, r.h]));
      // Row ids are per run: the same order in two runs is two different records.
      expect(theirs.ledger[0]!.id).not.toBe(mine.ledger[0]!.id);
    });
  });
});

describe('a changed re-import is reported, never applied', () => {
  it('keeps the original row and reports a conflict', async () => {
    const runId = await newRun();
    const first = await upload(
      runId,
      'ledger',
      csv(`${LEDGER_HEADER}\nORD-1,01-09-2026,100.00,C1,\n`),
    );
    expect(first.body).toMatchObject({ status: 'ok', rows: { inserted: 1 } });

    const second = await upload(
      runId,
      'ledger',
      csv(`${LEDGER_HEADER}\nORD-1,01-09-2026,200.00,C1,\nORD-2,02-09-2026,50.00,C1,\n`),
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      status: 'partial',
      rows: { total: 2, valid: 2, inserted: 1, unchanged: 0, conflicts: 1, rejected: 0 },
      errors: [{ row: 1, code: 'conflict' }],
    });

    const rows = await h.db
      .select({ ref: ledgerEntries.orderRef, amount: ledgerEntries.amountPaise })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.runId, runId))
      .orderBy(asc(ledgerEntries.orderRef));
    expect(rows).toEqual([
      { ref: 'ORD-1', amount: 10_000n },
      { ref: 'ORD-2', amount: 5_000n },
    ]);
  });

  it('finds the same orders when a ledger is re-exported in another order', async () => {
    const runId = await newRun();
    const a = `ORD-1,01-09-2026,100.00,C1,\nORD-2,02-09-2026,200.00,C1,\n`;
    const b = `ORD-2,02-09-2026,200.00,C1,\nORD-1,01-09-2026,100.00,C1,\nORD-3,03-09-2026,300.00,C1,\n`;
    await upload(runId, 'ledger', csv(LEDGER_HEADER + '\n' + a));
    const res = await upload(runId, 'ledger', csv(LEDGER_HEADER + '\n' + b));
    expect(res.body).toMatchObject({
      status: 'ok',
      rows: { inserted: 1, unchanged: 2, conflicts: 0 },
    });
  });
});

describe('malformed rows are reported, not crashed on', () => {
  it('imports the good rows of a messy file and explains every bad one', async () => {
    const runId = await newRun();
    const messy = [
      LEDGER_HEADER,
      'ORD-1,01-09-2026,100.00,C1,fine',
      'ORD-2,31-02-2026,100.00,C1,',
      'ORD-3,01-09-2026,"1,234,567.00",C1,',
      'ORD-4,01-09-2026,100.00,C1',
      `ORD-5,01-09-2026,100.00,C1,bad${NUL}memo`,
      'ab"c,01-09-2026,100.00,C1,',
      'ORD-7,notadate,abc,C1,',
      'ord-1,05-09-2026,5.00,C1,',
      'ORD-9,06-09-2026,600.00,C1,fine',
      '',
    ].join('\n');
    const res = await upload(runId, 'ledger', csv(messy));

    expect(res.status).toBe(200);
    const report = res.body as {
      status: string;
      rows: Record<string, number>;
      errors: { row: number; field: string | null; reason: string; code: string }[];
    };
    expect(report.status).toBe('partial');
    expect(report.rows).toMatchObject({ total: 9, valid: 2, inserted: 2, rejected: 7 });
    expect(report.errors.map((e) => [e.row, e.field])).toEqual([
      [2, 'order_date'],
      [3, 'amount'],
      [4, null],
      [5, 'memo'],
      [6, null],
      [7, 'order_date'],
      [7, 'amount'],
      [8, 'order_ref'],
    ]);
    for (const error of report.errors) expect(error.reason.length).toBeGreaterThan(0);

    const stored = await h.db
      .select({ ref: ledgerEntries.orderRef })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.runId, runId))
      .orderBy(asc(ledgerEntries.orderRef));
    expect(stored.map((r) => r.ref)).toEqual(['ORD-1', 'ORD-9']);

    const [event] = await h.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.runId, runId), eq(auditEvents.action, 'import.ledger')));
    expect(event?.detail).toMatchObject({ status: 'partial', errorCount: 8 });
  });

  it('does not let a stray quote swallow the rows after it', async () => {
    const runId = await newRun();
    const res = await upload(
      runId,
      'ledger',
      csv(
        `${LEDGER_HEADER}\nORD-1,01-09-2026,1.00,C1,"never closed\nORD-2,02-09-2026,2.00,C1,\nORD-3,03-09-2026,3.00,C1,\n`,
      ),
    );
    expect(res.body).toMatchObject({
      status: 'partial',
      rows: { total: 3, inserted: 2, rejected: 1 },
    });
  });
});

describe('a file that cannot be read at all is refused with a report', () => {
  it.each([
    [
      'a missing required column',
      csv('order_ref,order_date\nORD-1,01-09-2026\n'),
      /required column "amount" is missing/,
    ],
    ['an empty file', Buffer.alloc(0), /the file is empty/],
    [
      'bytes that are not UTF-8',
      Buffer.from([0x6f, 0x72, 0x64, 0x0a, 0xff, 0xfe, 0x41]),
      /not valid UTF-8/,
    ],
  ])('422 for %s, writes nothing, still audits the attempt', async (_name, body, reason) => {
    const runId = await newRun();
    const res = await upload(runId, 'ledger', body);
    expect(res.status).toBe(422);
    const report = res.body as { status: string; fatal: string[]; rows: { inserted: number } };
    expect(report.status).toBe('rejected');
    expect(report.fatal.join(' ')).toMatch(reason);
    expect(report.rows.inserted).toBe(0);

    expect(await h.db.select().from(ledgerEntries).where(eq(ledgerEntries.runId, runId))).toEqual(
      [],
    );
    expect(await actionsOf(runId)).toEqual(['run.create', 'import.ledger']);
    const [run] = await h.db.select().from(reconRuns).where(eq(reconRuns.id, runId));
    expect(run?.status).toBe('created');
  });

  it('400 when no file is sent', async () => {
    const runId = await newRun();
    const res = await h.api().post(`/runs/${runId}/import/ledger`).field('note', 'no file here');
    expect(res.status).toBe(400);
  });
});

describe('which runs accept imports', () => {
  const body = csv(`${LEDGER_HEADER}\nORD-1,01-09-2026,1.00,C1,\n`);

  it('404 for a run that does not exist', async () => {
    const res = await upload('00000000-0000-4000-8000-000000000999', 'ledger', body);
    expect(res.status).toBe(404);
    expect((await h.api().get('/runs/00000000-0000-4000-8000-000000000999')).status).toBe(404);
  });

  it('400 for an id that is not a uuid', async () => {
    expect((await upload('not-a-uuid', 'ledger', body)).status).toBe(400);
    expect((await h.api().get('/runs/not-a-uuid')).status).toBe(400);
  });

  it('409 once matching has started, and nothing is written', async () => {
    const runId = await newRun();
    await h.db.update(reconRuns).set({ status: 'matching' }).where(eq(reconRuns.id, runId));
    const res = await upload(runId, 'ledger', body);
    expect(res.status).toBe(409);
    expect(await h.db.select().from(ledgerEntries).where(eq(ledgerEntries.runId, runId))).toEqual(
      [],
    );
    const razorpay = await h
      .api()
      .post(`/runs/${runId}/import/razorpay`)
      .send({ from: '2026-09-01', to: '2026-09-30' });
    expect(razorpay.status).toBe(409);
  });
});

describe('POST /runs/:id/import/razorpay', () => {
  it('imports the window through the selected source and resolves the foreign keys', async () => {
    const demo = (await h.api().post('/runs/demo')).body as {
      run: { periodStart: string; periodEnd: string };
    };
    const runId = await newRun();
    const res = await h
      .api()
      .post(`/runs/${runId}/import/razorpay`)
      .send({ from: demo.run.periodStart, to: demo.run.periodEnd });
    expect(res.status).toBe(200);
    const c = data.collections;
    expect(res.body).toMatchObject({
      status: 'ok',
      source: 'razorpay',
      mixed: false,
      entities: {
        payments: { inserted: c.payments.length },
        refunds: { inserted: c.refunds.length },
        settlements: { inserted: c.settlements.length },
        settlementItems: { inserted: c.recon.length, rejected: 0 },
      },
    });

    // Every refund and payment item points at its payment row; every item at its settlement.
    expect(
      await h.db
        .select()
        .from(rzpRefunds)
        .where(and(eq(rzpRefunds.runId, runId), isNull(rzpRefunds.paymentId))),
    ).toEqual([]);
    const paymentItems = await h.db
      .select({ paymentId: settlementItems.paymentId })
      .from(settlementItems)
      .where(and(eq(settlementItems.runId, runId), eq(settlementItems.itemType, 'payment')));
    expect(paymentItems.length).toBeGreaterThan(0);
    expect(paymentItems.every((i) => i.paymentId !== null)).toBe(true);
    const settlements = await h.db
      .select()
      .from(rzpSettlements)
      .where(eq(rzpSettlements.runId, runId));
    expect(settlements).toHaveLength(c.settlements.length);
    expect(await actionsOf(runId)).toEqual(['run.create', 'run.status_changed', 'import.razorpay']);
  });

  it('imports nothing, cleanly, for a window with no data', async () => {
    const runId = await newRun();
    const res = await h
      .api()
      .post(`/runs/${runId}/import/razorpay`)
      .send({ from: '2030-01-01', to: '2030-01-10' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      entities: { payments: { fetched: 0, inserted: 0 }, settlementItems: { fetched: 0 } },
    });
  });

  it.each([
    ['to before from', { from: '2026-09-10', to: '2026-09-01' }],
    ['more than 93 days', { from: '2026-01-01', to: '2026-06-01' }],
    ['not a date', { from: 'yesterday', to: '2026-09-01' }],
    ['an unknown field', { from: '2026-09-01', to: '2026-09-02', source: 'testmode' }],
  ])('400 for %s', async (_name, body) => {
    const runId = await newRun();
    const res = await h.api().post(`/runs/${runId}/import/razorpay`).send(body);
    expect(res.status).toBe(400);
  });
});

describe('what a source says about itself', () => {
  const window = { from: '2026-09-01', to: '2026-09-10' };

  it('flags a run that mixes real and synthetic data, and passes the source`s notes on', async () => {
    const mixed = await boot(
      {},
      {
        forRun: (runId) =>
          stubSource({
            settlements: [settlementOn('setl_1', '2026-09-02', runId)],
            labels: { payments: 'razorpay_testmode' },
            warnings: { payments: ['order order_123 could not be found'] },
          }).source,
      },
    );
    try {
      const run = (await mixed.api().post('/runs').send(period)).body as { id: string };
      const res = await mixed.api().post(`/runs/${run.id}/import/razorpay`).send(window);
      expect(res.status).toBe(200);
      const report = res.body as RazorpayImportReport;
      expect(report.mixed).toBe(true);
      expect(report.provenance.map((p) => [p.entity, p.source])).toEqual([
        ['payments', 'razorpay_testmode'],
        ['refunds', 'synthetic'],
        ['settlements', 'synthetic'],
        ['settlement_recon', 'synthetic'],
      ]);
      expect(report.warnings).toEqual([
        { code: 'source_note', row: null, reason: 'order order_123 could not be found' },
      ]);
      const [event] = await mixed.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.runId, run.id), eq(auditEvents.action, 'import.razorpay')));
      expect(event?.detail).toMatchObject({ mixed: true, window: { from: window.from } });
    } finally {
      await mixed.close();
    }
  });

  it('rejects an item whose settlement is unknown, keeps the others, and says which', async () => {
    const orphan = await boot(
      {},
      {
        forRun: (runId) =>
          stubSource({
            settlements: [settlementOn('setl_1', '2026-09-02', runId)],
            items: [
              itemOf(1, 'setl_1', '2026-09-02', runId),
              itemOf(2, 'setl_missing', '2026-09-02', runId),
            ],
          }).source,
      },
    );
    try {
      const run = (await orphan.api().post('/runs').send(period)).body as { id: string };
      const res = await orphan.api().post(`/runs/${run.id}/import/razorpay`).send(window);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'partial',
        entities: { settlementItems: { fetched: 2, inserted: 1, rejected: 1 } },
        errors: [{ row: 2, field: 'settlementId', code: 'unknown_settlement' }],
      });
      const stored = await orphan.db.select().from(settlementItems);
      expect(stored.map((i) => i.sourceRef)).toEqual(['recon-1']);
      // A payment line is linked by its own entity id even when its payment is not in the run.
      expect(stored[0]).toMatchObject({ rzpPaymentId: 'pay_item1', paymentId: null });
    } finally {
      await orphan.close();
    }
  });
});

describe('records that do not belong to the run', () => {
  it('refuses them and writes nothing, instead of relabelling them into this run', async () => {
    // The stub's records carry a run id that is not the run being imported into.
    const wrong = await boot(
      {},
      { forRun: () => stubSource({ settlements: [settlementOn('setl_1', '2026-09-02')] }).source },
    );
    try {
      const run = (await wrong.api().post('/runs').send(period)).body as { id: string };
      const res = await wrong
        .api()
        .post(`/runs/${run.id}/import/razorpay`)
        .send({ from: '2026-09-01', to: '2026-09-10' });
      expect(res.status).toBe(500);
      expect(await wrong.db.select().from(rzpSettlements)).toEqual([]);
      expect(await actionsOf(run.id, wrong.db)).toEqual(['run.create']);
    } finally {
      await wrong.close();
    }
  });
});

describe('limits and configuration', () => {
  it('413 for a file over IMPORT_MAX_BYTES, and nothing is written', async () => {
    const small = await boot({ IMPORT_MAX_BYTES: '1024' });
    try {
      const run = (await small.api().post('/runs').send(period)).body as { id: string };
      const big = csv(`${LEDGER_HEADER}\n${'ORD-1,01-09-2026,1.00,C1,x\n'.repeat(100)}`);
      const res = await small
        .api()
        .post(`/runs/${run.id}/import/ledger`)
        .attach('file', big, { filename: 'big.csv', contentType: 'text/csv' });
      expect(res.status).toBe(413);
      expect(await small.db.select().from(ledgerEntries)).toEqual([]);
    } finally {
      await small.close();
    }
  });

  it('503 from /runs/demo, saying how to generate it, when the demo data is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ziro-empty-'));
    const missing = await boot({ SYNTHETIC_DATA_DIR: empty });
    try {
      const res = await missing.api().post('/runs/demo');
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).toContain('npm run datagen');
      expect(await missing.db.select().from(reconRuns)).toEqual([]);
    } finally {
      await missing.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('never contacts Razorpay for the demo, even when the server is set to test mode', async () => {
    const calls: string[] = [];
    const testmode = await boot(
      {
        RAZORPAY_SOURCE: 'testmode',
        RAZORPAY_KEY_ID: TEST_KEY_ID,
        RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
      },
      {
        forRun: () => {
          calls.push('forRun');
          throw new Error('the demo must not build the configured source');
        },
        synthetic: (runId: string) => new SyntheticSource({ runId, dir: data.dir }),
      },
    );
    try {
      const demo = await testmode.api().post('/runs/demo');
      expect(demo.status).toBe(201);
      expect((demo.body as { run: { razorpaySource: string } }).run.razorpaySource).toBe(
        'synthetic',
      );
      expect(calls).toEqual([]);

      // A normal run on the same server is stamped from the server's configuration.
      const run = await testmode.api().post('/runs').send(period);
      expect((run.body as { razorpaySource: string }).razorpaySource).toBe('testmode');
    } finally {
      await testmode.close();
    }
  });
});

describe('when Razorpay fails for part of the window', () => {
  const window = { from: '2026-09-01', to: '2026-09-10' };
  const down = () => new RazorpayApiError(503, 'SERVER_ERROR', 'upstream is unavailable', null, 5);
  const settled = (runId: string) =>
    stubSource({
      settlements: [settlementOn('setl_1', '2026-09-02', runId)],
      items: [itemOf(1, 'setl_1', '2026-09-02', runId)],
    }).source;

  it('imports what arrived, flags the run PARTIAL, and says what is missing', async () => {
    const partial = await boot(
      {},
      { forRun: (runId) => withFailures(settled(runId), { payments: down() }) },
    );
    try {
      const run = (await partial.api().post('/runs').send(period)).body as { id: string };
      const res = await partial.api().post(`/runs/${run.id}/import/razorpay`).send(window);

      expect(res.status).toBe(200);
      const report = res.body as RazorpayImportReport;
      expect(report.partial).toBe(true);
      expect(report.status).toBe('partial');
      expect(report.gaps.map((g) => g.entity)).toEqual(['payments', 'refunds']);
      expect(report.warnings.map((w) => w.code)).toEqual(['partial_import', 'partial_import']);
      expect(report.warnings[0]?.reason).toContain('payments were not fetched');
      expect(report.entities).toMatchObject({
        settlements: { inserted: 1 },
        settlementItems: { inserted: 1 },
      });
      expect((await partial.db.select().from(rzpSettlements)).map((s) => s.rzpId)).toEqual([
        'setl_1',
      ]);

      // The run itself carries the flag, wherever it is read.
      const view = (await partial.api().get(`/runs/${run.id}`)).body as {
        run: { partial: boolean; gaps: { entity: string }[] };
      };
      expect(view.run.partial).toBe(true);
      expect(view.run.gaps.map((g) => g.entity)).toEqual(['payments', 'refunds']);

      const [event] = await partial.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.runId, run.id), eq(auditEvents.action, 'import.razorpay')));
      expect(event?.detail).toMatchObject({
        partial: true,
        gaps: [{ entity: 'payments' }, { entity: 'refunds' }],
      });
    } finally {
      await partial.close();
    }
  });

  it('is cleared by a later import that gets everything, and fills only what was absent', async () => {
    let razorpayIsDown = true;
    const recovering = await boot(
      {},
      {
        forRun: (runId) =>
          razorpayIsDown ? withFailures(settled(runId), { payments: down() }) : settled(runId),
      },
    );
    try {
      const run = (await recovering.api().post('/runs').send(period)).body as { id: string };
      await recovering.api().post(`/runs/${run.id}/import/razorpay`).send(window);
      const before = (await recovering.api().get(`/runs/${run.id}`)).body as {
        run: { partial: boolean };
      };
      expect(before.run.partial).toBe(true);

      razorpayIsDown = false;
      const res = await recovering.api().post(`/runs/${run.id}/import/razorpay`).send(window);
      const report = res.body as RazorpayImportReport;
      expect(report.partial).toBe(false);
      expect(report.gaps).toEqual([]);
      expect(report.status).toBe('ok');
      // The settlement was already there: a re-import changes nothing it already holds.
      expect(report.entities.settlements).toMatchObject({ inserted: 0, unchanged: 1 });

      const after = (await recovering.api().get(`/runs/${run.id}`)).body as {
        run: { partial: boolean; gaps: unknown[] };
      };
      expect(after.run).toMatchObject({ partial: false, gaps: [] });
    } finally {
      await recovering.close();
    }
  });

  it('is 502, writes nothing, and leaves the run open when Razorpay gave nothing at all', async () => {
    const outage = await boot(
      {},
      {
        forRun: (runId) => withFailures(settled(runId), { payments: down(), settlements: down() }),
      },
    );
    try {
      const run = (await outage.api().post('/runs').send(period)).body as { id: string };
      const res = await outage.api().post(`/runs/${run.id}/import/razorpay`).send(window);

      expect(res.status).toBe(502);
      expect((res.body as { message: string }).message).toContain('payments were not fetched');
      expect(await outage.db.select().from(rzpSettlements)).toEqual([]);
      expect(await actionsOf(run.id, outage.db)).toEqual(['run.create']);
      const view = (await outage.api().get(`/runs/${run.id}`)).body as {
        run: { status: string; partial: boolean };
      };
      expect(view.run).toMatchObject({ status: 'created', partial: false });
    } finally {
      await outage.close();
    }
  });

  it('does not call a complete import partial', async () => {
    const whole = await boot({}, { forRun: (runId) => settled(runId) });
    try {
      const run = (await whole.api().post('/runs').send(period)).body as { id: string };
      const report = (await whole.api().post(`/runs/${run.id}/import/razorpay`).send(window))
        .body as RazorpayImportReport;
      expect(report).toMatchObject({ partial: false, gaps: [], status: 'ok' });
    } finally {
      await whole.close();
    }
  });
});
