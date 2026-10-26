// The run report on the 500-order eval run, measured against the generator's ground truth and against
// sums taken straight from the tables: the totals reconcile to the paise, fee leakage and delayed
// settlements match what the generator planted, and the vouchers for the books balance, tie to the bank
// credit and return the gross to the clearing ledger. Scripted agent; real storage, verifier and review.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVESTIGATION_QUEUE } from '../agent/queue.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigModule } from '../config/config.module.js';
import { loadEnv } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { createMigratedDb, type TestDb } from '../db/migrated-db.fixtures.js';
import { datasetDir } from '../demo/dataset.js';
import { DemoModule } from '../demo/demo.module.js';
import { DemoService } from '../demo/demo.service.js';
import { parseCsvObjects } from './csv-read.fixtures.js';
import { ReportModule } from './report.module.js';
import { ReportService } from './report.service.js';
import { DEFAULT_LEDGER_NAMES as N, LINE_HEADER, PAIR_HEADER, type Voucher } from './tally.js';

let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let app: INestApplication;
let server: Parameters<typeof request>[0];
let report: ReportService;
let runId = '';

interface Truth {
  anomalies: { reasonCode: string; detail: Record<string, string> }[];
}
let truth: Truth;

const env = () =>
  loadEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5433/d',
    REDIS_URL: 'redis://localhost:6379',
    RAZORPAY_SOURCE: 'synthetic',
    SYNTHETIC_DATA_DIR: 'data/eval',
    AGENT_HARNESS: 'loop',
    AUTO_ACCEPT_ENABLED: 'false',
    AUTO_ACCEPT_MAX_PAISE: '0',
    DEMO_MODE: 'true',
    DAILY_LLM_BUDGET_USD: '5',
    AGENT_KILL_SWITCH: 'false',
    AGENT_WORKER_ENABLED: 'false',
    DEMO_SEED_ON_BOOT: 'false',
  });

interface Overview {
  run: { asOf: string; periodEnd: string };
  sources: { ledger: { records: number }; settlements: { records: number } };
  reconciles: boolean;
  coverage: {
    type: string;
    total: number;
    matched: number;
    inException: number;
    ignored: number;
    amountPaise: { total: string; matched: string; inException: string; ignored: string };
    reconciles: boolean;
  }[];
  gap: { gapPaise: string };
  openExceptions: { asOf: string; byAge: { bucket: string; cases: number; stakePaise: string }[] };
  exceptionsByReason: { total: number }[];
  leakage: {
    overchargedCount: number;
    excessPaise: string;
    contract: { source: string };
    worst: { rzpId: string; excessPaise: string }[];
    byMethod: { method: string; overchargedCount: number }[];
  };
  delays: {
    delayed: { rzpId: string; createdLate: boolean; businessDaysLate: number }[];
    overdue: { rzpId: string }[];
  };
  journal: {
    settlementsBooked: number;
    settlementsNotBooked: { count: number };
    skipped: unknown[];
  };
  resolution: { ruleGroups: number };
}
const overview = async () =>
  (await request(server).get(`/runs/${runId}/overview`)).body as Overview;

const rows = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;
const one = async <T>(query: ReturnType<typeof sql>): Promise<T> => {
  const [first] = rows<T>(await db.execute(query));
  if (first === undefined) throw new Error('query returned no row');
  return first;
};
const inList = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

beforeAll(async () => {
  ({ db, client } = await createMigratedDb());
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(env()), DemoModule, ReportModule, AuditModule],
  })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(INVESTIGATION_QUEUE)
    .useValue({ enqueue: () => Promise.resolve() })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer() as Parameters<typeof request>[0];
  report = moduleRef.get(ReportService);

  runId = await moduleRef.get(DemoService).start({ preset: 'eval', agent: 'scripted' });
  for (;;) {
    const { stage } = (await request(server).get(`/runs/${runId}/progress`)).body as {
      stage: string;
    };
    if (stage === 'ready' || stage === 'failed') {
      expect(stage).toBe('ready');
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  truth = JSON.parse(
    readFileSync(join(await datasetDir('eval', 42), 'truth.json'), 'utf8'),
  ) as Truth;
}, 280_000);
afterAll(async () => {
  await app.close();
  await client.close();
});

// The home page shows this run's numbers (the featured replay is built exactly like this) next to figures from the
// stored eval result. They must be the same run: same orders, groups, exceptions and gap (apps/web metrics.test.ts
// then checks the page shows exactly these). It runs first: later tests approve a proposal, which moves the gap.
describe('the numbers the home page shows', () => {
  it('equal the stored eval result for this preset and seed', async () => {
    const stored = JSON.parse(
      readFileSync(
        new URL('../../../../packages/evals/results/eval-42/rules-plain.json', import.meta.url),
        'utf8',
      ),
    ) as {
      seed: number;
      preset: string;
      runs: {
        orders: number;
        exceptions: { total: number; handled: number };
        groups: { accepted: { rule: number } };
        gap: { strictPaise: string };
      }[];
    };
    expect([stored.preset, stored.seed]).toEqual(['eval', 42]);
    const o = await overview();
    const progress = (await request(server).get(`/runs/${runId}/progress`)).body as {
      expected: number;
    };
    for (const run of stored.runs) {
      expect(o.sources.ledger.records).toBe(run.orders);
      expect(o.resolution.ruleGroups).toBe(run.groups.accepted.rule);
      expect(o.exceptionsByReason.reduce((n, r) => n + r.total, 0)).toBe(run.exceptions.total);
      expect(progress.expected).toBe(run.exceptions.handled);
      expect(o.gap.gapPaise).toBe(run.gap.strictPaise);
    }
  });
});

describe('the totals reconcile to the paise', () => {
  it('matched + in an exception + ignored = total for every source, in records and in money', async () => {
    const o = await overview();
    expect(o.coverage.map((c) => c.type)).toEqual([
      'ledger_entry',
      'rzp_payment',
      'rzp_refund',
      'rzp_settlement',
      'bank_line',
    ]);
    for (const c of o.coverage) {
      expect(c.matched + c.inException + c.ignored, `${c.type} records`).toBe(c.total);
      expect(
        BigInt(c.amountPaise.matched) +
          BigInt(c.amountPaise.inException) +
          BigInt(c.amountPaise.ignored),
        `${c.type} paise`,
      ).toBe(BigInt(c.amountPaise.total));
      expect(c.reconciles).toBe(true);
    }
    expect(o.reconciles).toBe(true);
  });

  it('and the total itself is the sum straight from the table, not from the report', async () => {
    const o = await overview();
    const tables: Record<string, string> = {
      ledger_entry: 'ledger_entries',
      rzp_payment: 'rzp_payments',
      rzp_refund: 'rzp_refunds',
      rzp_settlement: 'rzp_settlements',
      bank_line: 'bank_lines',
    };
    for (const c of o.coverage) {
      const direct = await one<{ n: number; p: string }>(
        sql`select count(*)::int n, coalesce(sum(amount_paise), 0)::text p from ${sql.raw(tables[c.type] ?? '')} where run_id = ${runId}`,
      );
      expect(c.total, c.type).toBe(direct.n);
      expect(c.amountPaise.total, c.type).toBe(direct.p);
    }
  });

  it('every exception is counted once by reason, and the unsettled money is the sum of the age buckets', async () => {
    const o = await overview();
    const inTable = await one<{ n: number }>(
      sql`select count(*)::int n from recon_exceptions where run_id = ${runId}`,
    );
    expect(o.exceptionsByReason.reduce((n, r) => n + r.total, 0)).toBe(inTable.n);
    expect(o.openExceptions.byAge.reduce((n, b) => n + BigInt(b.stakePaise), 0n)).toBe(
      BigInt(o.gap.gapPaise),
    );
    expect(o.run.asOf).toBe(o.run.periodEnd);
  });
});

describe('fee leakage, against what the generator planted', () => {
  it('finds exactly the overcharged payments, and exactly the paise they were overcharged by', async () => {
    const o = await overview();
    const planted = truth.anomalies.filter((a) => a.reasonCode === 'FEE_OVERCHARGE');
    expect(planted.length).toBeGreaterThan(0);
    const plantedExcess = planted.reduce(
      (n, a) =>
        n + BigInt(a.detail['actualFeePaise'] ?? '0') - BigInt(a.detail['expectedFeePaise'] ?? '0'),
      0n,
    );
    expect(o.leakage.contract.source).toBe('run');
    expect(o.leakage.overchargedCount).toBe(planted.length);
    expect(BigInt(o.leakage.excessPaise)).toBe(plantedExcess);
    expect(o.leakage.byMethod.reduce((n, m) => n + m.overchargedCount, 0)).toBe(planted.length);

    const plantedIds = new Set(planted.map((a) => a.detail['paymentId']));
    for (const w of o.leakage.worst) expect(plantedIds.has(w.rzpId)).toBe(true);
  });
});

describe('delayed settlements, against what the generator planted', () => {
  it('flags the settlements created late, with the business days late the generator recorded', async () => {
    const o = await overview();
    const planted = truth.anomalies.filter((a) => a.reasonCode === 'SETTLEMENT_DELAYED');
    expect(planted.length).toBeGreaterThan(0);
    const created = o.delays.delayed.filter((d) => d.createdLate);
    expect(created.map((d) => d.rzpId).sort()).toEqual(
      planted.map((a) => a.detail['settlementId']).sort(),
    );
    for (const d of created) {
      const truthDays = planted.find((a) => a.detail['settlementId'] === d.rzpId)?.detail[
        'businessDaysLate'
      ];
      expect(d.businessDaysLate, d.rzpId).toBe(Number(truthDays));
    }
  });
});

describe('the vouchers for the books', () => {
  let vouchers: Voucher[];
  let booked: string[];
  const settlementVouchers = () => vouchers.filter((v) => v.source === 'settlement');
  const leg = (side: 'debits' | 'credits', ledger: string) =>
    settlementVouchers().reduce(
      (n, v) => n + v[side].filter((l) => l.ledger === ledger).reduce((m, l) => m + l.paise, 0n),
      0n,
    );

  beforeAll(async () => {
    const books = await report.vouchers(runId);
    vouchers = books.vouchers;
    booked = books.booked;
    expect(books.skipped).toEqual([]);
  });

  it('books every settlement that has a matched bank credit, and accounts for the rest', async () => {
    const o = await overview();
    expect(booked.length).toBeGreaterThan(0);
    expect(o.journal.settlementsBooked).toBe(booked.length);
    expect(o.journal.settlementsBooked + o.journal.settlementsNotBooked.count).toBe(
      o.sources.settlements.records,
    );
  });

  it('every voucher balances to the paise, and the receipt is the bank credit', async () => {
    for (const v of vouchers) {
      expect(
        v.debits.reduce((n, l) => n + l.paise, 0n),
        v.no,
      ).toBe(v.credits.reduce((n, l) => n + l.paise, 0n));
    }
    const receipts = settlementVouchers().filter((v) => v.type === 'Receipt');
    expect(receipts).toHaveLength(booked.length);
    const credits = await one<{ p: string }>(sql`
      select coalesce(sum(s.amount_paise), 0)::text p from rzp_settlements s
      where s.run_id = ${runId} and s.rzp_id in (${inList(booked)})`);
    expect(receipts.reduce((n, v) => n + (v.debits[0]?.paise ?? 0n), 0n)).toBe(BigInt(credits.p));
    expect(receipts.every((v) => v.debits[0]?.ledger === N.BANK)).toBe(true);
  });

  it('the fee, GST, refund and chargeback legs equal the sums taken from the tables', async () => {
    const direct = await one<{ gross: string; base: string; gst: string }>(sql`
      select coalesce(sum(p.amount_paise), 0)::text gross,
             coalesce(sum(p.fee_paise - p.tax_paise), 0)::text base,
             coalesce(sum(p.tax_paise), 0)::text gst
      from settlement_items i
      join rzp_settlements s on s.id = i.settlement_id
      join rzp_payments p on p.run_id = i.run_id and p.rzp_id = i.rzp_entity_id
      where i.run_id = ${runId} and i.item_type::text = 'payment' and s.rzp_id in (${inList(booked)})`);
    const other = await one<{ refunds: string; chargebacks: string; chargeback_lines: number }>(sql`
      select coalesce(sum(i.amount_paise) filter (where i.item_type::text = 'refund'), 0)::text refunds,
             coalesce(sum(i.debit_paise) filter (where i.item_type::text in ('adjustment', 'transfer')
               and i.debit_paise > 0 and i.description ~* 'charge\\s*back|dispute'), 0)::text chargebacks,
             (count(*) filter (where i.item_type::text in ('adjustment', 'transfer')
               and i.debit_paise > 0 and i.description ~* 'charge\\s*back|dispute'))::int chargeback_lines
      from settlement_items i join rzp_settlements s on s.id = i.settlement_id
      where i.run_id = ${runId} and s.rzp_id in (${inList(booked)})`);

    expect(leg('debits', N.PAYMENT_GATEWAY_FEES)).toBe(BigInt(direct.base));
    expect(leg('debits', N.GST_INPUT_CREDIT)).toBe(BigInt(direct.gst));
    expect(leg('debits', N.REFUNDS)).toBe(BigInt(other.refunds));
    expect(leg('debits', N.CHARGEBACK_LOSS)).toBe(BigInt(other.chargebacks));
    // Razorpay Clearing is credited by exactly what the settled payments grossed.
    expect(leg('credits', N.RAZORPAY_CLEARING) - leg('debits', N.RAZORPAY_CLEARING)).toBe(
      BigInt(direct.gross),
    );
    // The generator planted chargebacks; those whose settlement reached the bank are booked as such.
    const plantedSettlements = truth.anomalies
      .filter((a) => a.reasonCode === 'CHARGEBACK_ADJUSTMENT')
      .map((a) => a.detail['settlementId'] ?? '');
    const bookedPlanted = plantedSettlements.filter((s) => booked.includes(s));
    expect(other.chargeback_lines).toBe(bookedPlanted.length);
  });

  it('the receipt carries the settlement, the UTR and the bank row, and is dated when the money landed', async () => {
    const [receipt] = settlementVouchers();
    expect(receipt?.type).toBe('Receipt');
    expect(receipt?.recordIds.some((id) => id.startsWith('setl_'))).toBe(true);
    expect(receipt?.recordIds.some((id) => id.startsWith('bank:'))).toBe(true);
    expect(receipt?.narration).toMatch(/^Razorpay settlement setl_/);
    const bank = await one<{ value_date: string }>(sql`
      select b.value_date::text value_date from bank_lines b
      where b.run_id = ${runId} and b.source_ref = ${receipt?.recordIds.find((id) => id.startsWith('bank:'))?.slice(5) ?? ''}`);
    expect(receipt?.date).toBe(bank.value_date);
  });

  it('writes the same vouchers in both CSV layouts', async () => {
    const pair = await request(server).get(`/runs/${runId}/journal-entries.csv`);
    const lines = await request(server).get(`/runs/${runId}/journal-lines.csv`);
    expect(pair.status).toBe(200);
    expect(lines.status).toBe(200);
    expect(pair.text.split('\r\n')[0]).toBe(PAIR_HEADER.join(','));
    expect(lines.text.split('\r\n')[0]).toBe(LINE_HEADER.join(','));

    const pairRows = parseCsvObjects(pair.text);
    const lineRows = parseCsvObjects(lines.text);
    expect(new Set(pairRows.map((r) => r['voucher_no']))).toEqual(
      new Set(lineRows.map((r) => r['voucher_no'])),
    );
    // Dr and Cr totals agree in each layout, per voucher, to the paisa.
    const paise = (text: string | undefined) => BigInt(Math.round(Number(text ?? '0') * 100));
    for (const no of new Set(lineRows.map((r) => r['voucher_no']))) {
      const mine = lineRows.filter((r) => r['voucher_no'] === no);
      const dr = mine
        .filter((r) => r['dr_cr'] === 'Dr')
        .reduce((n, r) => n + paise(r['amount']), 0n);
      const cr = mine
        .filter((r) => r['dr_cr'] === 'Cr')
        .reduce((n, r) => n + paise(r['amount']), 0n);
      expect(dr, no).toBe(cr);
      const pairTotal = pairRows
        .filter((r) => r['voucher_no'] === no)
        .reduce((n, r) => n + paise(r['amount']), 0n);
      expect(pairTotal, no).toBe(dr);
    }
    for (const r of pairRows) expect(r['date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the exceptions export and adjustments a person approves', () => {
  it('gives every exception a next step, and never passes on a refused proposal’s suggestion', async () => {
    const o = await overview();
    const csv = parseCsvObjects((await request(server).get(`/runs/${runId}/exceptions.csv`)).text);
    expect(csv).toHaveLength(o.exceptionsByReason.reduce((n, r) => n + r.total, 0));
    for (const r of csv) {
      expect(r['next_step']?.length, r['exception_id']).toBeGreaterThan(5);
      expect(r['as_of']).toBe(o.run.asOf);
      if (r['verifier'] === 'rejected') {
        expect(r['suggested_action']).toBe('');
        expect(r['next_step']).toContain('Investigate by hand');
      }
      if (r['age_days'] !== '') expect(Number.isInteger(Number(r['age_days']))).toBe(true);
    }
    expect(csv.some((r) => r['suggested_action'] !== '')).toBe(true);
    expect(csv.some((r) => r['verifier'] === 'rejected')).toBe(true);
  });

  it('books an agent’s draft entry only after a person approves it, and says who', async () => {
    expect(vouchersOf(await report.vouchers(runId)).adjustments).toHaveLength(0);

    const waiting = (
      (await request(server).get(`/runs/${runId}/exceptions?filter=waiting&limit=200`)).body as {
        items: { id: string; proposal: { id: string } | null }[];
      }
    ).items;
    let chosen: string | null = null;
    for (const item of waiting) {
      const detail = (await request(server).get(`/exceptions/${item.id}`)).body as {
        proposals: { id: string; draftJournalEntry: unknown; verifier: { status: string } }[];
      };
      const p = detail.proposals.at(-1);
      if (p?.draftJournalEntry && p.verifier.status !== 'rejected') {
        chosen = p.id;
        break;
      }
    }
    expect(chosen, 'a waiting proposal with a draft journal entry').not.toBeNull();

    const approved = await request(server)
      .post(`/proposals/${chosen ?? ''}/approve`)
      .send({ reviewer: 'the accountant', note: 'checked against the bank' });
    expect(approved.status).toBe(200);

    const { adjustments } = vouchersOf(await report.vouchers(runId));
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.narration).toContain('approved by the accountant');
    expect(adjustments[0]?.type).toBe('Journal');
    expect(adjustments[0]?.no).toBe(`ZIRO-ADJ-${(chosen ?? '').slice(0, 8)}`);
    const pair = (await request(server).get(`/runs/${runId}/journal-entries.csv`)).text;
    expect(pair).toContain('ZIRO-ADJ-');
  });
});

const vouchersOf = (books: { vouchers: Voucher[] }) => ({
  adjustments: books.vouchers.filter((v) => v.source === 'agent adjustment'),
});
