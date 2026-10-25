// The whole Razorpay TEST-mode path, end to end, with only Razorpay's network replaced by an emulator that
// answers in Razorpay's documented shapes: import what the test account holds, copy its paid orders into a
// starter ledger, import that, match, and read the result. No generated data anywhere, and no bank statement
// unless the account has settlements (a real test account usually has none).
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigModule } from '../config/config.module.js';
import { loadEnv } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { createMigratedDb, type TestDb } from '../db/migrated-db.fixtures.js';
import {
  bankLines,
  ledgerEntries,
  matchGroups,
  reconExceptions,
  rzpPayments,
  rzpRefunds,
  rzpSettlements,
  settlementItems,
} from '../db/schema.js';
import {
  type Collections,
  createEmulator,
  docsDerivedCollections,
  TEST_KEY_ID,
  TEST_KEY_SECRET,
} from '../razorpay/razorpay.fixtures.js';
import { RazorpaySourceFactory } from '../razorpay/razorpay.module.js';
import { createSdkClient } from '../razorpay/sdk-client.js';
import { TestModeSource } from '../razorpay/testmode.source.js';
import { IngestModule } from './ingest.module.js';
import type { RazorpayImportReport } from './ingest.service.js';
import { ReconModule } from '../recon/recon.module.js';

const EMPTY: Collections = { payments: [], orders: [], refunds: [], settlements: [], recon: [] };
const WINDOW = { from: '2026-10-01', to: '2026-10-31' };
const PERIOD = { periodStart: '2026-10-01', periodEnd: '2026-10-31' };

interface Harness {
  readonly app: INestApplication;
  readonly db: TestDb;
  api(): ReturnType<typeof request>;
  close(): Promise<void>;
}

/** The real app and database; Razorpay's network is the emulator. Test mode is on and manual imports are open. */
async function boot(collections: Collections): Promise<Harness> {
  const { db, client } = await createMigratedDb();
  const emulator = createEmulator(collections);
  const factory: Partial<RazorpaySourceFactory> = {
    forRun: (runId) =>
      new TestModeSource({
        runId,
        client: createSdkClient({
          keyId: TEST_KEY_ID,
          keySecret: TEST_KEY_SECRET,
          adapter: emulator.adapter,
          deps: { sleep: () => Promise.resolve(), random: () => 0 },
        }),
      }),
  };
  const env = loadEnv({
    DATABASE_URL: 'postgres://ziro:ziro_dev@localhost:5433/ziro',
    REDIS_URL: 'redis://localhost:6379',
    RAZORPAY_SOURCE: 'testmode',
    RAZORPAY_KEY_ID: TEST_KEY_ID,
    RAZORPAY_KEY_SECRET: TEST_KEY_SECRET,
    SYNTHETIC_DATA_DIR: '/nowhere-on-purpose',
    AGENT_HARNESS: 'loop',
    AUTO_ACCEPT_ENABLED: 'false',
    AUTO_ACCEPT_MAX_PAISE: '0',
    DEMO_MODE: 'false',
    DAILY_LLM_BUDGET_USD: '5',
    AGENT_KILL_SWITCH: 'false',
  });
  const app = (
    await Test.createTestingModule({
      imports: [ConfigModule.forRoot(env), IngestModule, ReconModule],
    })
      .overrideProvider(DB)
      .useValue(db)
      .overrideProvider(RazorpaySourceFactory)
      .useValue(factory)
      .compile()
  ).createNestApplication();
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

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function newRun(harness: Harness): Promise<string> {
  const res = await harness.api().post('/runs').send(PERIOD);
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

describe('a Razorpay test account that has payments, refunds and a settlement', () => {
  it('imports exactly what it holds, builds a ledger from the paid orders, and reconciles them', async () => {
    h = await boot(docsDerivedCollections());
    const runId = await newRun(h);

    // 1. Razorpay: what the account holds, labelled as test mode, never anything else.
    const imported = await h.api().post(`/runs/${runId}/import/razorpay`).send(WINDOW);
    expect(imported.status).toBe(200);
    const report = imported.body as RazorpayImportReport;
    expect(report.status).toBe('ok');
    expect(report.entities).toMatchObject({
      payments: { fetched: 5, inserted: 5 },
      refunds: { fetched: 1, inserted: 1 },
      settlements: { fetched: 1, inserted: 1 },
    });
    expect(new Set(report.provenance.map((p) => p.source))).toEqual(new Set(['razorpay_testmode']));
    expect(report.partial).toBe(false);

    // 2. What could be built from it.
    const summary = (await h.api().get(`/runs/${runId}/starter`)).body as {
      ledger: { rows: number; skipped: { notCaptured: number } };
      bank: { rows: number };
    };
    expect(summary.ledger.rows).toBe(4); // ORD-5001 to ORD-5004
    expect(summary.ledger.skipped.notCaptured).toBe(1); // the authorized-only payment
    expect(summary.bank.rows).toBe(1);

    // 3. The ledger file, and importing it through the ordinary ledger path.
    const file = await h.api().get(`/runs/${runId}/starter-ledger.csv`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['content-disposition']).toContain('starter-ledger-from-razorpay.csv');
    expect(file.text.split('\r\n')[0]).toBe('order_ref,order_date,amount,customer_ref,memo');

    const ledger = await h.api().post(`/runs/${runId}/import/starter-ledger`);
    expect(ledger.status).toBe(200);
    expect(ledger.body).toMatchObject({
      status: 'ok',
      fileName: 'starter-ledger-from-razorpay.csv',
      rows: { valid: 4, inserted: 4, rejected: 0 },
    });
    expect(
      await h.db.select().from(ledgerEntries).where(eq(ledgerEntries.runId, runId)),
    ).toHaveLength(4);

    // Importing it again changes nothing: the same orders, the same amounts.
    const again = await h.api().post(`/runs/${runId}/import/starter-ledger`);
    expect(again.body).toMatchObject({ rows: { inserted: 0, unchanged: 4 } });

    // 4. The simulated bank statement, named as simulated in the report and the audit trail.
    const bank = await h.api().post(`/runs/${runId}/import/simulated-bank`);
    expect(bank.status).toBe(200);
    expect(bank.body).toMatchObject({
      fileName: 'SIMULATED-bank-from-razorpay-settlements.csv',
      rows: { inserted: 1 },
    });
    expect(await h.db.select().from(bankLines).where(eq(bankLines.runId, runId))).toHaveLength(1);

    // 5. Match: the four paid orders reconcile with their payments, to the paisa.
    const matched = await h.api().post(`/runs/${runId}/match`);
    expect(matched.status).toBe(200);
    const groups = await h.db.select().from(matchGroups).where(eq(matchGroups.runId, runId));
    const orderGroups = groups.filter((g) => g.kind === 'order');
    expect(orderGroups.length).toBeGreaterThanOrEqual(4);
    // What the matcher says it did is what is stored.
    const exceptions = await h.db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.runId, runId));
    expect(matched.body).toMatchObject({ groups: groups.length, exceptions: exceptions.length });
  });
});

describe('a Razorpay test account that, like most, has payments but no settlements', () => {
  it('reconciles the orders with no bank statement, and says why a bank cannot be simulated', async () => {
    h = await boot({ ...docsDerivedCollections(), settlements: [], recon: [] });
    const runId = await newRun(h);
    const imported = (await h.api().post(`/runs/${runId}/import/razorpay`).send(WINDOW))
      .body as RazorpayImportReport;
    expect(imported.entities).toMatchObject({
      payments: { inserted: 5 },
      settlements: { fetched: 0, inserted: 0 },
      settlementItems: { fetched: 0, inserted: 0 },
    });
    expect(new Set(imported.provenance.map((p) => p.source))).toEqual(
      new Set(['razorpay_testmode']),
    );

    expect((await h.api().post(`/runs/${runId}/import/starter-ledger`)).status).toBe(200);

    const bank = await h.api().post(`/runs/${runId}/import/simulated-bank`);
    expect(bank.status).toBe(422);
    expect(JSON.stringify(bank.body)).toMatch(/test mode does not settle/);

    // No bank file at all: matching still works for what exists.
    const matched = await h.api().post(`/runs/${runId}/match`);
    expect(matched.status).toBe(200);
    const orderGroups = (
      await h.db.select().from(matchGroups).where(eq(matchGroups.runId, runId))
    ).filter((g) => g.kind === 'order');
    expect(orderGroups.length).toBeGreaterThanOrEqual(4);
    expect(await h.db.select().from(bankLines).where(eq(bankLines.runId, runId))).toHaveLength(0);
  });
});

describe('a Razorpay test account with nothing in it (a fresh one)', () => {
  it('imports an honest empty answer: no generated data, and a clear message when a ledger is asked for', async () => {
    h = await boot(EMPTY);
    const runId = await newRun(h);
    const res = await h.api().post(`/runs/${runId}/import/razorpay`).send(WINDOW);
    expect(res.status).toBe(200);
    const report = res.body as RazorpayImportReport;
    expect(report.status).toBe('ok');
    expect(report.partial).toBe(false);
    expect(report.entities).toMatchObject({
      payments: { fetched: 0, inserted: 0 },
      refunds: { fetched: 0, inserted: 0 },
      settlements: { fetched: 0, inserted: 0 },
    });
    expect(new Set(report.provenance.map((p) => p.source))).toEqual(new Set(['razorpay_testmode']));

    const starter = (await h.api().get(`/runs/${runId}/starter`)).body as {
      ledger: { rows: number };
    };
    expect(starter.ledger.rows).toBe(0);
    const ledger = await h.api().post(`/runs/${runId}/import/starter-ledger`);
    expect(ledger.status).toBe(422);
    expect(JSON.stringify(ledger.body)).toMatch(/no paid order/);
  });

  it('stores nothing at all: no payment, refund, settlement or recon line appears from anywhere', async () => {
    h = await boot(EMPTY);
    const runId = await newRun(h);
    await h.api().post(`/runs/${runId}/import/razorpay`).send(WINDOW);
    const counts = [
      (await h.db.select().from(rzpPayments).where(eq(rzpPayments.runId, runId))).length,
      (await h.db.select().from(rzpRefunds).where(eq(rzpRefunds.runId, runId))).length,
      (await h.db.select().from(rzpSettlements).where(eq(rzpSettlements.runId, runId))).length,
      (await h.db.select().from(settlementItems).where(eq(settlementItems.runId, runId))).length,
    ];
    expect(counts).toEqual([0, 0, 0, 0]);
  });
});

describe('the starter endpoints on a run that does not exist', () => {
  it('say 404, not 500', async () => {
    h = await boot(EMPTY);
    const missing = '00000000-0000-4000-8000-000000000000';
    for (const path of [
      `/runs/${missing}/starter`,
      `/runs/${missing}/starter-ledger.csv`,
      `/runs/${missing}/simulated-bank.csv`,
    ]) {
      expect((await h.api().get(path)).status).toBe(404);
    }
    expect((await h.api().post(`/runs/${missing}/import/starter-ledger`)).status).toBe(404);
  });
});
