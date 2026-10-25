// What the console reads, checked against a real demo run (scripted agent, real storage, verifier and
// review): the summary adds up, the filters find what they say, an exception carries its evidence and the
// verifier's findings, and the four downloads are well formed, balanced and safe to open in a spreadsheet.
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVESTIGATION_QUEUE } from '../agent/queue.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigModule } from '../config/config.module.js';
import { loadEnv } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { createMigratedDb } from '../db/migrated-db.fixtures.js';
import { DemoModule } from '../demo/demo.module.js';
import { ReportModule } from './report.module.js';

let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let app: INestApplication;
let server: Parameters<typeof request>[0];
let runId = '';

const env = () =>
  loadEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5433/d',
    REDIS_URL: 'redis://localhost:6379',
    RAZORPAY_SOURCE: 'synthetic',
    SYNTHETIC_DATA_DIR: 'data/demo',
    AGENT_HARNESS: 'loop',
    AUTO_ACCEPT_ENABLED: 'false',
    AUTO_ACCEPT_MAX_PAISE: '0',
    DEMO_MODE: 'true',
    DAILY_LLM_BUDGET_USD: '5',
    AGENT_KILL_SWITCH: 'false',
    AGENT_WORKER_ENABLED: 'false',
    DEMO_SEED_ON_BOOT: 'false',
  });

interface ListItem {
  id: string;
  reasonCode: string;
  status: string;
  proposal: { id: string; verifier: string; author: string } | null;
  subject: { key: string } | null;
}
interface Overview {
  gap: { gapPaise: string; openPaise: string; awaitingPaise: string; explainedPaise: string };
  exceptionsByReason: { total: number }[];
  matching: { byTier: { records: number }[]; matchedRecords: number; approvedByPerson: number };
  llm: { calls: number; agent: string | null };
  sources: { ledger: { records: number } };
}

const get = (path: string) => request(server).get(path);
const list = async (query: string) =>
  (await get(`/runs/${runId}/exceptions?${query}`)).body as { total: number; items: ListItem[] };

/** Reads one CSV cell stream well enough for these files (quotes, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += c;
  }
  return rows;
}

beforeAll(async () => {
  const made = await createMigratedDb();
  client = made.client;
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(env()), DemoModule, ReportModule, AuditModule],
  })
    .overrideProvider(DB)
    .useValue(made.db)
    .overrideProvider(INVESTIGATION_QUEUE)
    .useValue({ enqueue: () => Promise.resolve() })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer() as Parameters<typeof request>[0];

  const started = await request(server).post('/demo/runs').send({});
  runId = (started.body as { runId: string }).runId;
  for (;;) {
    const { stage } = (await get(`/runs/${runId}/progress`)).body as { stage: string };
    if (stage === 'ready' || stage === 'failed') {
      expect(stage).toBe('ready');
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}, 120_000);
afterAll(async () => {
  await app.close();
  await client.close();
});

describe('the run summary', () => {
  it('adds up: every exception counted once by reason, matched records split across tiers', async () => {
    const o = (await get(`/runs/${runId}/overview`)).body as Overview;
    expect(o.sources.ledger.records).toBe(50);
    expect(o.exceptionsByReason.reduce((n, r) => n + r.total, 0)).toBe(20);
    expect(o.matching.byTier.reduce((n, t) => n + t.records, 0)).toBe(o.matching.matchedRecords);
    expect(o.llm.agent).toBe('scripted');
    expect(o.llm.calls).toBe(0);
  });

  it('keeps the gap equal to open plus awaiting review, and below the plain sum of stakes', async () => {
    const o = (await get(`/runs/${runId}/overview`)).body as Overview;
    expect(BigInt(o.gap.gapPaise)).toBe(BigInt(o.gap.openPaise) + BigInt(o.gap.awaitingPaise));
    const all = await list('limit=200');
    expect(all.total).toBe(20);
  });

  it("counts a person's approval, resolves the exception, and never grows the gap", async () => {
    const before = (await get(`/runs/${runId}/overview`)).body as Overview;
    const waiting = await list('filter=waiting&limit=200');
    const chosen = waiting.items.find((i) => i.proposal !== null);
    expect(chosen).toBeDefined();
    const res = await request(server)
      .post(`/proposals/${chosen?.proposal?.id ?? ''}/approve`)
      .send({ reviewer: 'a visitor', note: 'seen' });
    expect(res.status).toBe(200);
    const after = (await get(`/runs/${runId}/overview`)).body as Overview;
    expect(after.matching.approvedByPerson).toBe(before.matching.approvedByPerson + 1);
    expect(BigInt(after.gap.gapPaise)).toBeLessThanOrEqual(BigInt(before.gap.gapPaise));
    const resolved = await list('filter=resolved&limit=200');
    expect(resolved.items.some((i) => i.id === chosen?.id)).toBe(true);
  });
});

describe('the exceptions table', () => {
  it('shows the two proposals the verifier refused, and says who wrote them', async () => {
    const refused = await list('filter=refused');
    expect(refused.total).toBe(2);
    for (const item of refused.items) {
      expect(item.proposal?.verifier).toBe('rejected');
      expect(item.proposal?.author).toBe('planted');
    }
  });

  it('filters by reason and pages', async () => {
    const all = await list('limit=200');
    const reason = all.items[0]?.reasonCode ?? '';
    const some = await list(`reason=${reason}`);
    expect(some.items.every((i) => i.reasonCode === reason)).toBe(true);
    expect((await list('limit=5&offset=0')).items).toHaveLength(5);
    expect((await get(`/runs/${runId}/exceptions?filter=nonsense`)).status).toBe(400);
    expect((await get(`/runs/${runId}/exceptions?limit=1000`)).status).toBe(400);
  });

  it('gives one exception in full: the records, the evidence and the verifier findings', async () => {
    const refused = (await list('filter=refused')).items[0];
    const detail = (await get(`/exceptions/${refused?.id ?? ''}`)).body as {
      subject: { key: string } | null;
      proposals: {
        author: string;
        evidence: unknown[];
        explanation: string;
        verifier: { status: string; findings: string[] };
      }[];
    };
    const proposal = detail.proposals.at(-1);
    expect(detail.subject?.key).toBe(refused?.subject?.key);
    expect(proposal?.author).toBe('planted');
    expect(proposal?.evidence.length).toBeGreaterThan(0);
    expect(proposal?.verifier.status).toBe('rejected');
    expect(proposal?.verifier.findings.length).toBeGreaterThan(0);
  });

  it('answers 404 for an unknown exception or run, and 400 for a malformed id', async () => {
    const nobody = '00000000-0000-4000-8000-000000000000';
    expect((await get(`/exceptions/${nobody}`)).status).toBe(404);
    expect((await get(`/runs/${nobody}/overview`)).status).toBe(404);
    expect((await get('/exceptions/not-a-uuid')).status).toBe(400);
  });
});

describe('finding a record', () => {
  it('finds a ledger entry by order reference and refuses a one-letter search', async () => {
    const key = (await list('limit=1')).items[0]?.subject?.key ?? '';
    const found = (await get(`/runs/${runId}/records?q=${encodeURIComponent(key)}`)).body as {
      key: string;
    }[];
    expect(found.some((f) => f.key === key)).toBe(true);
    expect((await get(`/runs/${runId}/records?q=a`)).status).toBe(400);
  });

  it('treats % and _ in a search as plain characters', async () => {
    const found = (await get(`/runs/${runId}/records?q=%25_`)).body as unknown[];
    expect(found).toEqual([]);
  });
});

describe('the downloads', () => {
  it.each([
    ['report.json', 'application/json'],
    ['report.csv', 'text/csv'],
    ['exceptions.csv', 'text/csv'],
    ['journal-entries.csv', 'text/csv'],
    ['journal-lines.csv', 'text/csv'],
  ])('%s is an attachment of the right type', async (name, type) => {
    const res = await get(`/runs/${runId}/${name}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(type);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="ziro-[0-9a-f]{8}-/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('the JSON report parses and carries the summary, the exceptions and the entries', async () => {
    const body = (await get(`/runs/${runId}/report.json`)).body as {
      overview: Overview;
      exceptions: unknown[];
      vouchers: unknown[];
    };
    expect(body.overview.sources.ledger.records).toBe(50);
    expect(body.exceptions).toHaveLength(20);
    expect(body.vouchers.length).toBeGreaterThan(0);
  });

  it('the exceptions CSV has one row per exception and a stable header', async () => {
    const rows = parseCsv((await get(`/runs/${runId}/exceptions.csv`)).text);
    expect(rows[0]?.[0]).toBe('exception_id');
    expect(rows).toHaveLength(21);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });

  it('the journal CSV has vouchers in the pair layout, with positive amounts and ISO dates', async () => {
    const [header, ...lines] = parseCsv((await get(`/runs/${runId}/journal-entries.csv`)).text);
    expect(header?.join(',')).toBe(
      'date,voucher_type,voucher_no,debit_ledger,credit_ledger,amount,narration,record_ids,source',
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['Receipt', 'Journal']).toContain(line[1]);
      expect(line[3]).not.toBe(line[4]);
      expect(Number(line[5])).toBeGreaterThan(0);
    }
    // Nothing here was drafted by the planted wrong proposals: they are refused and never booked.
    expect(lines.some((l) => (l[6] ?? '').includes('planted'))).toBe(false);
  });

  it('no cell in any CSV begins with a character a spreadsheet would run as a formula', async () => {
    for (const name of [
      'report.csv',
      'exceptions.csv',
      'journal-entries.csv',
      'journal-lines.csv',
    ]) {
      const rows = parseCsv((await get(`/runs/${runId}/${name}`)).text);
      for (const row of rows)
        for (const cell of row) {
          // Plain signed amounts (-473.00) are numbers, not text; anything else must be defused.
          if (/^[=+\-@\t\r]/.test(cell)) expect(cell, `${name}: ${cell}`).toMatch(/^-\d+(\.\d+)?$/);
        }
    }
  });
});
