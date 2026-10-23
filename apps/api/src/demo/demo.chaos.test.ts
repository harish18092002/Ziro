// The demo's chaos toggle, from the visitor's side: one POST with {"chaos": true}, then what the run
// shows. No model and no key; the failures are injected into the scripted agent and handled by the real
// resilient wrapper, the real parser, the real storage and the real audit trail.
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentService } from '../agent/agent.service.js';
import { INVESTIGATION_QUEUE } from '../agent/queue.js';
import { AuditModule } from '../audit/audit.module.js';
import { ConfigModule } from '../config/config.module.js';
import { loadEnv } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { createMigratedDb, type TestDb } from '../db/migrated-db.fixtures.js';
import { agentProposals, auditEvents, reconExceptions, reconRuns } from '../db/schema.js';
import { ReportModule } from '../report/report.module.js';
import { CHAOS_MALFORMED_NOTE, CHAOS_TIMEOUT_MESSAGE } from './chaos-runner.js';
import { DemoModule } from './demo.module.js';

const env = (demoMode: boolean) =>
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
    DEMO_MODE: demoMode ? 'true' : 'false',
    DAILY_LLM_BUDGET_USD: '5',
    AGENT_KILL_SWITCH: 'false',
    AGENT_WORKER_ENABLED: 'false',
    DEMO_SEED_ON_BOOT: 'false',
  });

interface Site {
  readonly app: INestApplication;
  readonly db: TestDb;
  readonly server: Parameters<typeof request>[0];
  close(): Promise<void>;
}

async function boot(demoMode: boolean): Promise<Site> {
  const { db, client } = await createMigratedDb();
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(env(demoMode)), DemoModule, AuditModule, ReportModule],
  })
    .overrideProvider(DB)
    .useValue(db)
    .overrideProvider(INVESTIGATION_QUEUE)
    .useValue({ enqueue: () => Promise.resolve() })
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    db,
    server: app.getHttpServer() as Parameters<typeof request>[0],
    close: async () => {
      await app.close();
      await client.close();
    },
  };
}

interface Progress {
  stage: string;
  error: string | null;
  note: string | null;
  expected: number | null;
  chaos: { timeoutFor: string | null; malformedFor: string | null } | null;
  counts: { proposals: number; exceptions: number };
}

async function untilReady(site: Site, runId: string, ms = 90_000): Promise<Progress> {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = (await request(site.server).get(`/runs/${runId}/progress`)).body as Progress;
    if (body.stage === 'ready' || body.stage === 'failed') return body;
    if (Date.now() > deadline) throw new Error(`still ${body.stage} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const startRun = async (site: Site, body: unknown) =>
  request(site.server)
    .post('/demo/runs')
    .send(body as object);

let site: Site;
let plainRun: string;
let chaosRun: string;
let plain: Progress;
let chaotic: Progress;

beforeAll(async () => {
  Logger.overrideLogger(false);
  site = await boot(true);
  // One run with the toggle off and one with it on, in the same site, to compare.
  plainRun = ((await startRun(site, {})).body as { runId: string }).runId;
  plain = await untilReady(site, plainRun);
  chaosRun = ((await startRun(site, { chaos: true })).body as { runId: string }).runId;
  chaotic = await untilReady(site, chaosRun);
}, 180_000);
afterAll(async () => {
  await site.close();
});

const degradedIn = (runId: string) =>
  site.db
    .select()
    .from(agentProposals)
    .where(and(eq(agentProposals.runId, runId), isNotNull(agentProposals.degraded)));

describe('with the toggle off', () => {
  it('breaks nothing: no degraded proposal, and the progress says no chaos', async () => {
    expect(plain.stage).toBe('ready');
    expect(plain.chaos).toBeNull();
    expect(await degradedIn(plainRun)).toEqual([]);
  });
});

describe('with the toggle on', () => {
  it('still finishes the run, and says which two exceptions it broke', () => {
    expect(chaotic.stage).toBe('ready');
    expect(chaotic.error).toBeNull();
    expect(chaotic.chaos?.timeoutFor).toBeTruthy();
    expect(chaotic.chaos?.malformedFor).toBeTruthy();
    expect(chaotic.chaos?.timeoutFor).not.toBe(chaotic.chaos?.malformedFor);
  });

  it('degrades exactly those two, each for the right reason, and nothing else', async () => {
    const degraded = await degradedIn(chaosRun);
    const byException = new Map(degraded.map((p) => [p.exceptionId, p]));
    expect(degraded).toHaveLength(2);

    const timeout = byException.get(chaotic.chaos?.timeoutFor ?? '');
    expect(timeout?.degraded).toBe('model_unavailable');
    expect(timeout?.verdict).toBe('NEEDS_HUMAN');
    expect(timeout?.explanation).toContain('did not answer after 3 tries');
    expect(timeout?.explanation).toContain(CHAOS_TIMEOUT_MESSAGE);

    const malformed = byException.get(chaotic.chaos?.malformedFor ?? '');
    expect(malformed?.degraded).toBe('invalid_reply');
    expect(malformed?.verdict).toBe('NEEDS_HUMAN');
    expect(malformed?.harnessFindings[0]).toBe(CHAOS_MALFORMED_NOTE);
  });

  it('carries on: every other exception still gets its proposal, as in the run without chaos', async () => {
    expect(chaotic.counts.proposals).toBe(plain.counts.proposals);
    expect(chaotic.expected).toBe(plain.expected);
    const open = await site.db
      .select()
      .from(reconExceptions)
      .where(and(eq(reconExceptions.runId, chaosRun), eq(reconExceptions.status, 'open')));
    // Triage leaves the same unexplained credits for a person in both runs; nothing extra stays open.
    const openPlain = await site.db
      .select()
      .from(reconExceptions)
      .where(and(eq(reconExceptions.runId, plainRun), eq(reconExceptions.status, 'open')));
    expect(open).toHaveLength(openPlain.length);
  });

  it('audits both as handed to a person, with the reason in words', async () => {
    const events = (
      await site.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.runId, chaosRun), eq(auditEvents.action, 'agent.propose')))
    ).filter((e) => (e.detail as { after: { degraded: string | null } }).after.degraded !== null);
    expect(events.map((e) => (e.detail as { reason: string }).reason).sort()).toEqual([
      'handed to a person without a conclusion: the model API did not answer',
      'handed to a person without a conclusion: the model’s reply was not valid',
    ]);
  });
});

describe('who may use it', () => {
  it('is offered on the home page in DEMO_MODE', async () => {
    const body = (await request(site.server).get('/demo')).body as {
      chaos: { available: boolean; reason: string | null };
    };
    expect(body.chaos).toEqual({ available: true, reason: null });
  });

  it('is refused for the live agent: that one is paid for and shared', async () => {
    const res = await startRun(site, { agent: 'live', chaos: true });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toContain('scripted agent only');
  });

  it('is refused, and not offered, outside DEMO_MODE', async () => {
    const quiet = await boot(false);
    try {
      const offer = (await request(quiet.server).get('/demo')).body as {
        chaos: { available: boolean; reason: string | null };
      };
      expect(offer.chaos).toEqual({ available: false, reason: 'the server is not in DEMO_MODE' });
      const res = await startRun(quiet, { chaos: true });
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain('DEMO_MODE');
      // Nothing was imported on the way to refusing.
      expect(await quiet.db.select().from(reconExceptions)).toEqual([]);
    } finally {
      await quiet.close();
    }
  });

  it('refuses a toggle that is not a boolean', async () => {
    expect((await startRun(site, { chaos: 'yes' })).status).toBe(400);
  });
});

describe('a job that fails for a reason of its own', () => {
  it('leaves its exception open, says so in the run, and lets the rest finish', async () => {
    const spy = vi
      .spyOn(AgentService.prototype, 'process')
      .mockImplementationOnce(() => Promise.reject(new Error('disk full')));
    try {
      const runId = ((await startRun(site, {})).body as { runId: string }).runId;
      const progress = await untilReady(site, runId);

      expect(progress.stage).toBe('ready');
      expect(progress.note).toContain('1 investigation job failed');
      expect(progress.note).toContain('disk full');
      // One job's exceptions were not investigated; the others were.
      expect(progress.counts.proposals).toBe((progress.expected ?? 0) - 1);
    } finally {
      spy.mockRestore();
    }
  });
});

interface Overview {
  run: {
    partial: boolean;
    gaps: { entity: string; kind: string; detail: string; days: string[] }[];
  };
  failures: {
    handedToAPerson: number;
    byReason: { reason: string; label: string; count: number }[];
    injected: { timeoutFor: string | null; malformedFor: string | null } | null;
    note: string | null;
  };
}
interface ListedException {
  id: string;
  nextStep: string;
  suggestedAction: string | null;
  proposal: { author: string; degraded: string | null; degradedLabel: string | null } | null;
}

describe('what the report says about it', () => {
  const overview = async (runId: string) =>
    (await request(site.server).get(`/runs/${runId}/overview`)).body as Overview;

  it('counts the investigations handed to a person, by reason, and names the injected ones', async () => {
    const o = await overview(chaosRun);
    expect(o.failures.handedToAPerson).toBe(2);
    expect(o.failures.byReason).toEqual([
      { reason: 'model_unavailable', label: 'the model API did not answer', count: 1 },
      { reason: 'invalid_reply', label: 'the model’s reply was not valid', count: 1 },
    ]);
    expect(o.failures.injected).toEqual(chaotic.chaos);
  });

  it('shows nothing for a run where nothing went wrong', async () => {
    const o = await overview(plainRun);
    expect(o.failures).toEqual({ handedToAPerson: 0, byReason: [], injected: null, note: null });
  });

  it('lists the degraded exceptions on their own, authored by the system, not by a model', async () => {
    const res = await request(site.server).get(`/runs/${chaosRun}/exceptions?filter=degraded`);
    const body = res.body as { total: number; items: ListedException[] };
    expect(body.total).toBe(2);
    for (const item of body.items) {
      expect(item.proposal?.author).toBe('harness');
      expect(item.proposal?.degraded).not.toBeNull();
      expect(item.proposal?.degradedLabel).toBeTruthy();
      expect(item.suggestedAction).toBeNull();
      expect(item.nextStep).toContain(
        'Investigate by hand: the agent could not reach a conclusion',
      );
    }
    const none = await request(site.server).get(`/runs/${plainRun}/exceptions?filter=degraded`);
    expect((none.body as { total: number }).total).toBe(0);
  });

  it('shows the reason and the author on the exception itself', async () => {
    const id = chaotic.chaos?.timeoutFor ?? '';
    const body = (await request(site.server).get(`/exceptions/${id}`)).body as {
      proposals: { author: string; degraded: string; degradedLabel: string }[];
    };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({
      author: 'harness',
      degraded: 'model_unavailable',
      degradedLabel: 'the model API did not answer',
    });
  });

  it('puts the reason in the exceptions download', async () => {
    const res = await request(site.server).get(`/runs/${chaosRun}/exceptions.csv`).buffer(true);
    const text = res.text;
    const [header, ...rows] = text
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter((line) => line !== '');
    expect(header).toContain('agent_stopped_because');
    expect(rows.filter((r) => r.includes('the model API did not answer'))).toHaveLength(1);
    expect(rows.filter((r) => r.includes('the model’s reply was not valid'))).toHaveLength(1);
  });
});

describe('a run whose Razorpay import was partial', () => {
  it('says so in the overview, with what is missing', async () => {
    const gaps = [
      {
        entity: 'payments',
        kind: 'cut_short',
        detail: 'payments stopped after 300 records: Razorpay API error 503 (after 5 tries)',
        days: [],
      },
    ];
    await site.db
      .update(reconRuns)
      .set({
        config: sql`${reconRuns.config} || ${JSON.stringify({ razorpay: { partial: true, gaps } })}::jsonb`,
      })
      .where(eq(reconRuns.id, plainRun));
    const o = (await request(site.server).get(`/runs/${plainRun}/overview`)).body as Overview;
    expect(o.run.partial).toBe(true);
    expect(o.run.gaps).toEqual(gaps);
    // A run that never imported from Razorpay is not partial.
    expect(
      ((await request(site.server).get(`/runs/${chaosRun}/overview`)).body as Overview).run,
    ).toMatchObject({
      partial: false,
      gaps: [],
    });
  });
});

describe('whether the agent will take work', () => {
  it('is reported for the banner: not paused, no key here, and what has been spent', async () => {
    const res = await request(site.server).get('/agent/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      paused: null,
      dailyBudgetUsd: '5.000000',
    });
  });
});
