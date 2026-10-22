// The review and audit endpoints end to end: real controllers and services, a PGlite database built from
// the migrations, and the agent's own service feeding the pipeline, so the timeline test follows one
// record from import to an approved match.
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentService } from '../agent/agent.service.js';
import type { AgentRunner, ProposalDraft } from '../agent/types.js';
import { RecordsController } from '../audit/audit.module.js';
import { TimelineService } from '../audit/timeline.service.js';
import { ENV } from '../config/config.module.js';
import { DB } from '../db/db.module.js';
import { insertException } from '../db/migrated-db.fixtures.js';
import { writeGroup } from '../recon/group-writer.js';
import {
  createMigratedDb,
  seedOrder,
  seedProposal,
  seedRun,
  type TestDb,
} from './review.fixtures.js';
import { ReviewController } from './review.controller.js';
import { ReviewService, type ReviewSettings } from './review.service.js';

let ctx: Awaited<ReturnType<typeof createMigratedDb>>;
let db: TestDb;
let app: INestApplication;
let server: Parameters<typeof request>[0];

const settings: ReviewSettings = {
  AGENT_KILL_SWITCH: false,
  AUTO_ACCEPT_ENABLED: false,
  AUTO_ACCEPT_MAX_PAISE: 500_000n,
  AUTO_ACCEPT_MIN_CONFIDENCE: 0.85,
  DEMO_MODE: false,
};

beforeAll(async () => {
  ctx = await createMigratedDb();
  db = ctx.db;
  const moduleRef = await Test.createTestingModule({
    controllers: [ReviewController, RecordsController],
    providers: [
      { provide: DB, useValue: db },
      { provide: ENV, useValue: settings },
      ReviewService,
      TimelineService,
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  server = app.getHttpServer() as Parameters<typeof request>[0];
}, 60_000);
afterAll(async () => {
  await app.close();
  await ctx.client.close();
});

const review = () => new ReviewService(db, settings);
const MISSING = '00000000-0000-4000-8000-0000000000ee';

async function waiting(options: { amount?: bigint; paymentAmount?: bigint } = {}) {
  const runId = await seedRun(db);
  const order = await seedOrder(db, runId, { paymentAmount: options.paymentAmount });
  const p = await seedProposal(db, runId, order.links, { amountAtStake: options.amount });
  await review().verifyAndRoute([p.proposalId]);
  return { runId, order, ...p };
}

describe('GET /runs/:id/review/queue', () => {
  it('lists what is waiting, with the reviewer-facing fields', async () => {
    const { runId, proposalId } = await waiting();
    const res = await request(server).get(`/runs/${runId}/review/queue`);
    expect(res.status).toBe(200);
    const body = res.body as {
      total: number;
      items: { proposalId: string; verifier: { status: string } }[];
    };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ proposalId, verifier: { status: 'passed' } });
  });

  it('pages, and refuses a bad page or an unknown parameter', async () => {
    const { runId } = await waiting();
    expect((await request(server).get(`/runs/${runId}/review/queue?limit=1&offset=0`)).status).toBe(
      200,
    );
    for (const bad of ['limit=0', 'limit=101', 'offset=-1', 'limit=abc', 'sort=amount']) {
      expect((await request(server).get(`/runs/${runId}/review/queue?${bad}`)).status, bad).toBe(
        400,
      );
    }
  });

  it('answers 404 for an unknown run and 400 for a malformed id', async () => {
    expect((await request(server).get(`/runs/${randomUUID()}/review/queue`)).status).toBe(404);
    expect((await request(server).get('/runs/nope/review/queue')).status).toBe(400);
  });
});

describe('GET /runs/:id/review/summary and POST /runs/:id/verify', () => {
  it('reports the headline numbers', async () => {
    const runId = await seedRun(db);
    const bad = await seedProposal(
      db,
      runId,
      (await seedOrder(db, runId, { paymentAmount: 9n })).links,
    );
    await review().verifyAndRoute([bad.proposalId]);
    const res = await request(server).get(`/runs/${runId}/review/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      caughtByVerifier: 1,
      rejectionReasons: { AMOUNT_MISMATCH: 1 },
    });
    expect((await request(server).get(`/runs/${randomUUID()}/review/summary`)).status).toBe(404);
  });

  it('verifies what was stored but not verified', async () => {
    const runId = await seedRun(db);
    await seedProposal(db, runId, (await seedOrder(db, runId)).links);
    const res = await request(server).post(`/runs/${runId}/verify`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: 1 });
    expect((await request(server).post(`/runs/${randomUUID()}/verify`)).status).toBe(404);
  });
});

describe('POST /proposals/:id/approve and /reject', () => {
  it('approves, then refuses a second decision with 409', async () => {
    const { proposalId } = await waiting();
    const first = await request(server)
      .post(`/proposals/${proposalId}/approve`)
      .send({ reviewer: 'asha', note: 'ok' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ decision: 'approved', exceptionStatus: 'resolved' });
    expect((first.body as { groupId: string }).groupId).toMatch(/^[0-9a-f-]{36}$/);
    const second = await request(server)
      .post(`/proposals/${proposalId}/approve`)
      .send({ reviewer: 'ben' });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'already_decided' });
  });

  it('refuses a malformed body, an unknown key, an unknown proposal and a malformed id', async () => {
    const { proposalId } = await waiting();
    const url = `/proposals/${proposalId}/approve`;
    expect((await request(server).post(url).send({})).status).toBe(400);
    expect((await request(server).post(url).send({ reviewer: '  ' })).status).toBe(400);
    expect(
      (await request(server).post(url).send({ reviewer: 'asha', approved: true })).status,
    ).toBe(400);
    expect(
      (
        await request(server)
          .post(url)
          .send({ reviewer: 'x'.repeat(101) })
      ).status,
    ).toBe(400);
    expect(
      (await request(server).post(`/proposals/${MISSING}/approve`).send({ reviewer: 'asha' }))
        .status,
    ).toBe(404);
    expect(
      (await request(server).post('/proposals/nope/approve').send({ reviewer: 'asha' })).status,
    ).toBe(400);
  });

  it('rejects with a reason, and requires one', async () => {
    const { proposalId } = await waiting();
    const url = `/proposals/${proposalId}/reject`;
    expect((await request(server).post(url).send({ reviewer: 'asha' })).status).toBe(400);
    const res = await request(server).post(url).send({ reviewer: 'asha', note: 'wrong customer' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: 'rejected', exceptionStatus: 'open' });
  });

  it('answers 409 with the findings when the records have moved on', async () => {
    const { runId, proposalId, order } = await waiting();
    // Meanwhile a competing group takes the payment.
    const rival = await seedOrder(db, runId);
    await writeGroup(db, {
      runId,
      kind: 'order',
      status: 'accepted',
      basis: 'human',
      reasonCode: null,
      residual: 0n,
      links: [
        { recordType: 'ledger_entry', recordId: rival.ledger },
        { recordType: 'rzp_payment', recordId: order.payment },
      ],
      actor: 'human',
      reason: 'manual',
    });
    const res = await request(server)
      .post(`/proposals/${proposalId}/approve`)
      .send({ reviewer: 'asha' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'stale_proposal' });
    expect((res.body as { findings: string[] }).findings.join(' ')).toContain('ALREADY_MATCHED');
  });
});

describe('GET /proposals/:id', () => {
  it('gives the proposal, its exception and its decision', async () => {
    const { proposalId, exceptionId } = await waiting();
    const res = await request(server).get(`/proposals/${proposalId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      proposal: { id: proposalId, verdict: 'MATCH_PROPOSED', verifier: { status: 'passed' } },
      exception: { id: exceptionId, status: 'proposed' },
      review: null,
    });
    expect((await request(server).get(`/proposals/${MISSING}`)).status).toBe(404);
  });
});

describe('the story of one record, from import to an approved match', () => {
  it('is the timeline of a ledger entry and of a payment, in order', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const exceptionId = await insertException(db, runId, {
      reasonCode: 'UNKNOWN',
      subjectType: 'ledger_entry',
      subjectId: order.ledger,
      candidates: [{ recordType: 'rzp_payment', recordId: order.payment }],
      status: 'open',
      amountAtStakePaise: 250_000n,
    });

    // The agent proposes a match; the pipeline verifies it and routes it to a person.
    const draft: ProposalDraft = {
      content: {
        exceptionId,
        verdict: 'MATCH_PROPOSED',
        reasonCode: 'UNKNOWN',
        links: order.links,
        explanation: 'One ledger entry, one captured payment, same amount.',
        evidence: [
          { tool: 'get_exception', args: { exception_id: exceptionId }, keyFinding: 'candidate' },
        ],
        confidence: 0.95,
        suggestedAction: 'ACCEPT_MATCH',
        draftJournalEntry: null,
      },
      model: 'claude-haiku-5-5',
      harnessFindings: [],
      llmCallId: null,
    };
    const runner: AgentRunner = { harness: 'loop', investigate: () => Promise.resolve([draft]) };
    const reviewService = review();
    const agent = new AgentService(
      db,
      { AGENT_KILL_SWITCH: false, DAILY_LLM_BUDGET_USD: 5, CLUSTER_EXCEPTIONS: false },
      runner,
      reviewService,
    );
    await agent.process({ runId, clusterId: null, items: [{ exceptionId, attempt: 1 }] });

    const [queued] = (await reviewService.queue(runId, { limit: 5, offset: 0 })).items;
    expect(queued?.verifier.status).toBe('passed');
    await reviewService.approve(queued?.proposalId ?? '', { reviewer: 'asha', note: 'confirmed' });

    const ledger = await request(server).get(`/records/${order.ledger}/audit`);
    expect(ledger.status).toBe(200);
    const body = ledger.body as {
      record: { type: string; key: string; amountPaise: string };
      timeline: {
        action: string;
        actor: string;
        before: unknown;
        after: unknown;
        reason: string | null;
      }[];
      truncated: boolean;
    };
    expect(body.record).toMatchObject({ type: 'ledger_entry', amountPaise: '250000' });
    expect(body.truncated).toBe(false);
    expect(body.timeline.map((e) => e.action)).toEqual([
      'record.imported',
      'agent.propose',
      'verifier.verified',
      'policy.human_review',
      'group.create',
      'exception.resolve',
      'review.approve',
    ]);
    expect(body.timeline.map((e) => e.actor)).toEqual([
      'system',
      'agent',
      'verifier',
      'system',
      'human',
      'human',
      'human',
    ]);
    const propose = body.timeline[1];
    expect(propose?.before).toEqual({ exceptionStatus: 'open' });
    expect(propose?.after).toMatchObject({
      exceptionStatus: 'proposed',
      verdict: 'MATCH_PROPOSED',
    });
    expect(body.timeline[5]?.before).toEqual({ status: 'proposed' });
    expect(body.timeline[5]?.after).toMatchObject({ status: 'resolved' });
    expect(body.timeline[6]?.reason).toBe('confirmed');

    // The payment was in every step but the resolution of the ledger entry's exception.
    const payment = await request(server).get(`/records/${order.payment}/audit`);
    const paymentActions = (payment.body as { timeline: { action: string }[] }).timeline.map(
      (e) => e.action,
    );
    expect(paymentActions).toEqual([
      'record.imported',
      'agent.propose',
      'verifier.verified',
      'policy.human_review',
      'group.create',
      'review.approve',
    ]);
  });

  it('answers 404 for an id that is no record, and 400 for one that is no id', async () => {
    expect((await request(server).get(`/records/${MISSING}/audit`)).status).toBe(404);
    expect((await request(server).get('/records/nope/audit')).status).toBe(400);
  });

  it('shows a record nobody has touched as just its import', async () => {
    const runId = await seedRun(db);
    const order = await seedOrder(db, runId);
    const res = await request(server).get(`/records/${order.payment}/audit`);
    expect((res.body as { timeline: { action: string }[] }).timeline.map((e) => e.action)).toEqual([
      'record.imported',
    ]);
  });
});
