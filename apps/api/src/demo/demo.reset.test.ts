// "Reset demo", the read-only featured runs, and the deploy job's seeding, from the visitor's side. No model,
// no key; the agent is the scripted baseline and everything after it is the real code.
import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
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
import { reconRuns } from '../db/schema.js';
import { ReportModule } from '../report/report.module.js';
import { DemoModule } from './demo.module.js';
import { DemoService, FEATURED_VERSION } from './demo.service.js';

const env = (demoMode: boolean) =>
  loadEnv({
    DATABASE_URL: 'postgres://u:p@localhost:5433/d',
    REDIS_URL: 'redis://localhost:6379',
    RAZORPAY_SOURCE: 'synthetic',
    SYNTHETIC_DATA_DIR: 'data/demo',
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
  readonly demo: DemoService;
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
    demo: moduleRef.get(DemoService),
    server: app.getHttpServer() as Parameters<typeof request>[0],
    close: async () => {
      await app.close();
      await client.close();
    },
  };
}

async function untilReady(site: Site, runId: string, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = (await request(site.server).get(`/runs/${runId}/progress`)).body as {
      stage: string;
    };
    if (body.stage === 'ready') return;
    if (body.stage === 'failed') throw new Error('the run failed');
    if (Date.now() > deadline) throw new Error(`still ${body.stage} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const startRun = async (site: Site): Promise<string> => {
  const res = await request(site.server).post('/demo/runs').send({});
  const runId = (res.body as { runId: string }).runId;
  await untilReady(site, runId);
  return runId;
};

interface Queue {
  items: { proposalId: string; verdict: string }[];
}
const waitingProposal = async (site: Site, runId: string): Promise<string> => {
  const queue = (await request(site.server).get(`/runs/${runId}/review/queue?limit=100`))
    .body as Queue;
  const match = queue.items.find((i) => i.verdict === 'MATCH_PROPOSED');
  if (match === undefined) throw new Error('no proposal is waiting');
  return match.proposalId;
};

const overviewOf = async (site: Site, runId: string) =>
  (await request(site.server).get(`/runs/${runId}/overview`)).body as {
    run: { featured: string | null; archived: boolean };
  };

let site: Site;
beforeAll(async () => {
  Logger.overrideLogger(false);
  site = await boot(true);
}, 120_000);
afterAll(async () => {
  await site.close();
});

describe('Reset demo', () => {
  let oldRun: string;
  let fresh: string;

  it('archives the run you were in and starts a fresh one', async () => {
    oldRun = await startRun(site);
    const res = await request(site.server).post('/demo/reset').send({ runId: oldRun });
    expect(res.status).toBe(202);
    const body = res.body as { archived: string; runId: string };
    expect(body.archived).toBe(oldRun);
    expect(body.runId).not.toBe(oldRun);
    fresh = body.runId;
    await untilReady(site, fresh);

    expect((await overviewOf(site, oldRun)).run.archived).toBe(true);
    expect((await overviewOf(site, fresh)).run.archived).toBe(false);
  }, 120_000);

  it('keeps the archived run readable, and refuses to change it', async () => {
    const proposalId = await waitingProposal(site, oldRun);
    expect((await request(site.server).get(`/proposals/${proposalId}`)).status).toBe(200);
    const approve = await request(site.server)
      .post(`/proposals/${proposalId}/approve`)
      .send({ reviewer: 'a visitor' });
    expect(approve.status).toBe(409);
    expect(approve.body).toMatchObject({ error: 'archived' });
    const reject = await request(site.server)
      .post(`/proposals/${proposalId}/reject`)
      .send({ reviewer: 'a visitor', note: 'no' });
    expect(reject.status).toBe(409);
  });

  it('leaves the fresh run fully reviewable', async () => {
    const proposalId = await waitingProposal(site, fresh);
    const approve = await request(site.server)
      .post(`/proposals/${proposalId}/approve`)
      .send({ reviewer: 'a visitor' });
    expect(approve.status).toBe(200);
  });

  it('archives once: resetting an archived run again starts another run but does not re-stamp it', async () => {
    const before = (
      (await site.db.select().from(reconRuns).where(eq(reconRuns.id, oldRun)))[0]?.config as {
        archivedAt: string;
      }
    ).archivedAt;
    const again = await request(site.server).post('/demo/reset').send({ runId: oldRun });
    expect(again.status).toBe(202);
    const after = (
      (await site.db.select().from(reconRuns).where(eq(reconRuns.id, oldRun)))[0]?.config as {
        archivedAt: string;
      }
    ).archivedAt;
    expect(after).toBe(before);
    await untilReady(site, (again.body as { runId: string }).runId);
  }, 120_000);

  it('says 404 for a run that does not exist, and 400 for something that is not an id', async () => {
    expect(
      (
        await request(site.server)
          .post('/demo/reset')
          .send({ runId: '00000000-0000-4000-8000-0000000000ab' })
      ).status,
    ).toBe(404);
    expect((await request(site.server).post('/demo/reset').send({ runId: 'nope' })).status).toBe(
      400,
    );
  });

  it('will not reset a run that did not come from the demo', async () => {
    const created = await request(site.server)
      .post('/runs')
      .send({ periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    const runId = (created.body as { id: string }).id;
    const res = await request(site.server).post('/demo/reset').send({ runId });
    expect(res.status).toBe(403);
    expect(
      (await site.db.select().from(reconRuns).where(eq(reconRuns.id, runId)))[0]?.config,
    ).not.toHaveProperty('archivedAt');
  });

  it('is off outside DEMO_MODE', async () => {
    const quiet = await boot(false);
    try {
      const res = await request(quiet.server)
        .post('/demo/reset')
        .send({ runId: '00000000-0000-4000-8000-0000000000ab' });
      expect(res.status).toBe(403);
    } finally {
      await quiet.close();
    }
  });
});

describe('the featured runs are read-only replays, and seeding builds them once', () => {
  let featured: { demo: string; eval: string };

  it('builds both, waiting until they are ready, and builds nothing the second time', async () => {
    const first = await site.demo.seedFeatured();
    expect(first).toEqual({ built: ['demo', 'eval'], existing: [] });
    const offer = (await request(site.server).get('/demo')).body as {
      featured: { demo: string | null; eval: string | null };
    };
    expect(offer.featured.demo).toBeTruthy();
    expect(offer.featured.eval).toBeTruthy();
    featured = offer.featured as { demo: string; eval: string };

    const second = await site.demo.seedFeatured();
    expect(second).toEqual({ built: [], existing: ['demo', 'eval'] });
    expect(
      ((await request(site.server).get('/demo')).body as { featured: unknown }).featured,
    ).toEqual(featured);
  }, 240_000);

  it('does not count a run left half-built as present: it builds a ready one', async () => {
    await site.db
      .update(reconRuns)
      .set({ config: reconRunsConfigWithoutReady() })
      .where(eq(reconRuns.id, featured.demo));
    const result = await site.demo.seedFeatured();
    expect(result.built).toEqual(['demo']);
    expect(result.existing).toEqual(['eval']);
  }, 120_000);

  it('refuses to approve or reject in them, and says why', async () => {
    const offer = (await request(site.server).get('/demo')).body as { featured: { eval: string } };
    expect((await overviewOf(site, offer.featured.eval)).run.featured).toBe('eval');
    const proposalId = await waitingProposal(site, offer.featured.eval);
    const approve = await request(site.server)
      .post(`/proposals/${proposalId}/approve`)
      .send({ reviewer: 'a stranger' });
    expect(approve.status).toBe(403);
    expect(approve.body).toMatchObject({ error: 'read_only' });
    const reject = await request(site.server)
      .post(`/proposals/${proposalId}/reject`)
      .send({ reviewer: 'a stranger', note: 'no' });
    expect(reject.status).toBe(403);
  }, 60_000);

  it('cannot reset one', async () => {
    const offer = (await request(site.server).get('/demo')).body as { featured: { demo: string } };
    const res = await request(site.server).post('/demo/reset').send({ runId: offer.featured.demo });
    expect(res.status).toBe(403);
    expect((res.body as { message: string }).message).toContain('read-only');
  });
});

/** A featured run's config with its pipeline put back to "investigating": not ready. */
function reconRunsConfigWithoutReady() {
  return {
    featured: 'demo',
    featuredVersion: FEATURED_VERSION,
    demo: { preset: 'demo', seed: 42 },
    pipeline: { stage: 'investigating' },
  };
}
