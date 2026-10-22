// The whole loop, server side, from an empty database: one POST, then poll until the run is ready, then
// read what a visitor would see and approve one proposal as a visitor would. No model, no key, no
// network: the agent is the scripted baseline, and storage, verification, routing, review and the audit
// trail are the real ones. The expected outcomes are checked against the generator's ground truth.
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVESTIGATION_QUEUE } from '../agent/queue.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigModule } from '../config/config.module.js';
import { loadEnv } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { createMigratedDb, type TestDb } from '../db/migrated-db.fixtures.js';
import {
  agentProposals,
  bankLines,
  ledgerEntries,
  reconExceptions,
  reconRuns,
  rzpPayments,
  rzpSettlements,
} from '../db/schema.js';
import { DemoModule } from './demo.module.js';
import { DemoService } from './demo.service.js';
import { PLANTED_MODEL, SCRIPTED_MODEL } from './scripted-runner.js';

let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let app: INestApplication;
let server: Parameters<typeof request>[0];
let demo: DemoService;

const env = () =>
  loadEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5433/d',
    REDIS_URL: 'redis://localhost:6379',
    RAZORPAY_SOURCE: 'synthetic',
    SYNTHETIC_DATA_DIR: 'data/demo',
    AGENT_MODEL_SMALL: 'claude-haiku-5-5',
    AGENT_MODEL_LARGE: 'claude-sonnet-5-5',
    AGENT_HARNESS: 'loop',
    AUTO_ACCEPT_ENABLED: 'false',
    AUTO_ACCEPT_MAX_PAISE: '0',
    DEMO_MODE: 'true',
    DAILY_LLM_BUDGET_USD: '5',
    AGENT_KILL_SWITCH: 'false',
    AGENT_WORKER_ENABLED: 'false',
    DEMO_SEED_ON_BOOT: 'false',
  });

beforeAll(async () => {
  ({ db, client } = await createMigratedDb());
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(env()), DemoModule, AuditModule],
  })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(INVESTIGATION_QUEUE)
    .useValue({ enqueue: () => Promise.resolve() })
    .compile();
  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer() as Parameters<typeof request>[0];
  demo = moduleRef.get(DemoService);
}, 120_000);
afterAll(async () => {
  await app.close();
  await client.close();
});

interface Progress {
  stage: string;
  agent: string | null;
  expected: number | null;
  error: string | null;
  counts: {
    groups: number;
    exceptions: number;
    proposals: number;
    verified: number;
    refused: number;
    waiting: number;
  };
}

async function untilReady(runId: string, ms = 90_000): Promise<Progress> {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = (await request(server).get(`/runs/${runId}/progress`)).body as Progress;
    if (body.stage === 'ready' || body.stage === 'failed') return body;
    if (Date.now() > deadline) throw new Error(`still ${body.stage} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Business key of every record in a run, so expectations can be written as a person reads them. */
async function keysOf(runId: string): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (const l of await db.select().from(ledgerEntries).where(eq(ledgerEntries.runId, runId)))
    keys.set(l.id, `ledger_entry:${l.orderRef}`);
  for (const p of await db.select().from(rzpPayments).where(eq(rzpPayments.runId, runId)))
    keys.set(p.id, `rzp_payment:${p.rzpId}`);
  for (const s of await db.select().from(rzpSettlements).where(eq(rzpSettlements.runId, runId)))
    keys.set(s.id, `rzp_settlement:${s.rzpId}`);
  for (const b of await db.select().from(bankLines).where(eq(bankLines.runId, runId)))
    keys.set(b.id, `bank_line:${b.sourceRef}`);
  return keys;
}

let runId = '';
let finished: Progress;
beforeAll(async () => {
  const started = await request(server).post('/demo/runs').send({});
  expect(started.status).toBe(202);
  runId = (started.body as { runId: string }).runId;
  finished = await untilReady(runId);
}, 120_000);

describe('one click, the whole loop', () => {
  it('goes from an empty database to a reviewable run on its own', () => {
    expect(finished.stage).toBe('ready');
    expect(finished.error).toBeNull();
    expect(finished.agent).toBe('scripted');
    // 68 groups the rules proved; 20 records they could not settle, of which 14 are worth the agent's time
    // (the other six are bank credits with nothing to look at, listed for a person).
    expect(finished.counts).toEqual({
      groups: 68,
      exceptions: 20,
      proposals: 14,
      verified: 2,
      refused: 2,
      waiting: 12,
    });
    expect(finished.expected).toBe(14);
  });

  it('marks the run complete, with when it started and finished', async () => {
    const [run] = await db.select().from(reconRuns).where(eq(reconRuns.id, runId));
    expect(run?.status).toBe('complete');
    expect(run?.finishedAt).toBeInstanceOf(Date);
  });

  it('says who made every proposal: a scripted baseline or a planted example, never a model', async () => {
    const proposals = await db.select().from(agentProposals).where(eq(agentProposals.runId, runId));
    const models = proposals.map((p) => p.model).sort();
    expect(new Set(models)).toEqual(new Set([SCRIPTED_MODEL, PLANTED_MODEL]));
    expect(models.filter((m) => m === PLANTED_MODEL)).toHaveLength(2);
    for (const planted of proposals.filter((p) => p.model === PLANTED_MODEL)) {
      expect(planted.harnessFindings.join(' ')).toContain('this is not model output');
    }
  });

  it('shows the verifier refusing the planted proposals, for stated reasons, and reopens their exceptions', async () => {
    const keys = await keysOf(runId);
    const proposals = await db.select().from(agentProposals).where(eq(agentProposals.runId, runId));
    const exceptions = await db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.runId, runId));
    const refused = proposals.filter((p) => p.verifierStatus === 'rejected');
    expect(refused.map((p) => p.model)).toEqual([PLANTED_MODEL, PLANTED_MODEL]);

    const byLedger: Record<string, string> = Object.fromEntries(
      refused.map((p): [string, string] => {
        const subject = exceptions.find((e) => e.id === p.exceptionId)?.subjectId ?? '';
        return [keys.get(subject) ?? '', p.verifierFindings.join(' | ')];
      }),
    );
    expect(byLedger['ledger_entry:ORD-100023']).toContain('ALREADY_MATCHED');
    expect(byLedger['ledger_entry:ORD-100030']).toMatch(
      /AMOUNT_MISMATCH: the ledger totals 373900 paise but payments less refunds total 61200/,
    );
    for (const p of refused) {
      expect(exceptions.find((e) => e.id === p.exceptionId)?.status).toBe('open');
    }
  });

  it('never has the baseline propose a match the verifier refuses', async () => {
    const scripted = (
      await db.select().from(agentProposals).where(eq(agentProposals.runId, runId))
    ).filter((p) => p.model === SCRIPTED_MODEL);
    expect(scripted).toHaveLength(12);
    expect(scripted.some((p) => p.verifierStatus === 'rejected')).toBe(false);
  });

  it('agrees with the ground truth on what each exception is', async () => {
    const keys = await keysOf(runId);
    const proposals = await db.select().from(agentProposals).where(eq(agentProposals.runId, runId));
    const exceptions = await db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.runId, runId));
    const answer = new Map(
      proposals
        .filter((p) => p.model === SCRIPTED_MODEL)
        .map(
          (p) =>
            [keys.get(exceptions.find((e) => e.id === p.exceptionId)?.subjectId ?? ''), p] as const,
        ),
    );
    const reason = (key: string) => answer.get(key)?.reasonCode;
    // truth.json: these are the injected anomalies behind the exceptions.
    expect(reason('ledger_entry:ORD-100040')).toBe('LEDGER_AMOUNT_EDITED');
    expect(reason('ledger_entry:ORD-100045')).toBe('LEDGER_AMOUNT_EDITED');
    expect(reason('ledger_entry:ORD-100034')).toBe('LEDGER_WITHOUT_PAYMENT');
    expect(reason('rzp_payment:pay_PPEeXqz12hXiSk')).toBe('PAYMENT_WITHOUT_LEDGER');
    expect(reason('rzp_payment:pay_IznYSVY6dTemQY')).toBe('PAYMENT_WITHOUT_LEDGER');
    expect(reason('rzp_payment:pay_YVXkra8Oo5ZJCO')).toBe('DUPLICATE_PAYMENT');
    expect(answer.get('rzp_payment:pay_YVXkra8Oo5ZJCO')?.suggestedAction).toBe('REFUND_CUSTOMER'); // paid twice, never refunded
    expect(answer.get('rzp_payment:pay_3OU27Lz7uj1ktj')?.suggestedAction).toBe('NONE'); // paid twice, refunded in full
  });

  it('picks the right one of two look-alike bank credits (row 11 per the truth, row 12 is a decoy)', async () => {
    const keys = await keysOf(runId);
    const proposals = await db.select().from(agentProposals).where(eq(agentProposals.runId, runId));
    const exceptions = await db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.runId, runId));
    const forSubject = (key: string) =>
      proposals.find(
        (p) => keys.get(exceptions.find((e) => e.id === p.exceptionId)?.subjectId ?? '') === key,
      );
    const linked = (key: string) =>
      (forSubject(key)?.links as { recordId: string }[]).map((l) => keys.get(l.recordId));

    expect(forSubject('rzp_settlement:setl_Yp4e2sndCoKIv6')).toMatchObject({
      verdict: 'MATCH_PROPOSED',
      verifierStatus: 'passed',
    });
    expect(linked('rzp_settlement:setl_Yp4e2sndCoKIv6')).toEqual([
      'rzp_settlement:setl_Yp4e2sndCoKIv6',
      'bank_line:row-11',
    ]);
    expect(forSubject('bank_line:row-11')).toMatchObject({
      verdict: 'MATCH_PROPOSED',
      verifierStatus: 'passed',
    });
    expect(forSubject('bank_line:row-12')).toMatchObject({ verdict: 'EXPLAINED_NO_MATCH' });
  });

  it('lets a visitor approve a verified match, which resolves both exceptions about it and writes the story', async () => {
    const queue = (await request(server).get(`/runs/${runId}/review/queue?limit=100`)).body as {
      total: number;
      items: {
        proposalId: string;
        verdict: string;
        links: { recordType: string; recordId: string }[];
      }[];
    };
    expect(queue.total).toBe(12);
    const match = queue.items.find((i) => i.verdict === 'MATCH_PROPOSED');
    expect(match).toBeDefined();

    const approved = await request(server)
      .post(`/proposals/${match?.proposalId ?? ''}/approve`)
      .send({ reviewer: 'a visitor', note: 'row 11 is the credit' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ decision: 'approved', exceptionStatus: 'resolved' });

    // The settlement and the credit it names both had an exception; the group resolves both.
    const after = (await request(server).get(`/runs/${runId}/review/queue?limit=100`)).body as {
      total: number;
    };
    expect(after.total).toBe(10);

    const settlementId =
      match?.links.find((l) => l.recordType === 'rzp_settlement')?.recordId ?? '';
    const story = await request(server).get(`/records/${settlementId}/audit`);
    expect(story.status).toBe(200);
    const actions = (story.body as { timeline: { action: string }[] }).timeline.map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'record.imported',
        'exception.create',
        'agent.propose',
        'verifier.verified',
        'policy.human_review',
        'group.create',
        'exception.resolve',
        'review.approve',
      ]),
    );
    expect(actions[0]).toBe('record.imported');
    expect(actions.indexOf('exception.create')).toBeLessThan(actions.indexOf('agent.propose'));
    expect(actions.indexOf('agent.propose')).toBeLessThan(actions.indexOf('review.approve'));
  });

  it('counts the planted refusals in the summary a visitor reads', async () => {
    const summary = (await request(server).get(`/runs/${runId}/review/summary`)).body as {
      caughtByVerifier: number;
      rejectionReasons: Record<string, number>;
    };
    expect(summary.caughtByVerifier).toBe(2);
    expect(summary.rejectionReasons['ALREADY_MATCHED']).toBe(1);
    expect(summary.rejectionReasons['AMOUNT_MISMATCH']).toBeGreaterThanOrEqual(1);
  });
});

describe('what the home page may offer', () => {
  it('has no featured run yet and no live agent without a key', async () => {
    const res = await request(server).get('/demo');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      featured: { demo: null, eval: null },
      scripted: true,
      live: { available: false, reason: 'the server has no ANTHROPIC_API_KEY' },
    });
  });

  it('refuses a live run it cannot do, before importing anything', async () => {
    const before = await db.select().from(reconRuns);
    const res = await request(server).post('/demo/runs').send({ agent: 'live' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).toContain('ANTHROPIC_API_KEY');
    expect((await db.select().from(reconRuns)).length).toBe(before.length);
  });

  it('refuses a body it does not understand', async () => {
    expect(
      (await request(server).post('/demo/runs').send({ agent: 'scripted', preset: 'eval' })).status,
    ).toBe(400);
    expect((await request(server).post('/demo/runs').send({ agent: 'oracle' })).status).toBe(400);
  });

  it('offers a featured run once one is built, and only when it is ready', async () => {
    const id = await demo.start({ preset: 'demo', agent: 'scripted', featured: true });
    await untilReady(id);
    expect((await request(server).get('/demo')).body).toMatchObject({
      featured: { demo: id, eval: null },
    });
  }, 60_000);

  it('answers 404 for the progress of a run that does not exist and 400 for a bad id', async () => {
    expect(
      (await request(server).get('/runs/00000000-0000-4000-8000-0000000000ab/progress')).status,
    ).toBe(404);
    expect((await request(server).get('/runs/nope/progress')).status).toBe(400);
  });
});
