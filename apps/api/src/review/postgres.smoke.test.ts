// The same machinery on a REAL Postgres server instead of PGlite, in a scratch database that is created
// and dropped here. PGlite runs one transaction at a time, so it can never show a race; this can.
//
//   RUN_PG_SMOKE=1 npm test -w @ziro/api -- src/review/postgres.smoke.test.ts
//
// It uses DATABASE_URL (from the environment or .env) for its credentials, REFUSES any host that is not
// this machine, and never touches the database named in the URL: it connects to it only to run
// CREATE DATABASE / DROP DATABASE for its own `ziro_smoke_<random>`.
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, type TestDb, type World } from '../agent/agent.fixtures.js';
import { AgentService } from '../agent/agent.service.js';
import { Toolbox } from '../agent/tools/toolbox.js';
import type { AgentRunner, ProposalDraft } from '../agent/types.js';
import { loadDotEnv } from '../config/dotenv.js';
import { insertException, MIGRATIONS_FOLDER, pgErrorOf, PG } from '../db/migrated-db.fixtures.js';
import * as schema from '../db/schema.js';
import { agentProposals, auditEvents, ledgerEntries, matchGroups } from '../db/schema.js';
import { ledgerOf } from '../recon/records.js';
import { seedOrder, seedProposal, seedRun } from './review.fixtures.js';
import { ReviewService, type ReviewSettings } from './review.service.js';

const ENABLED = process.env['RUN_PG_SMOKE'] === '1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

describe.skipIf(!ENABLED)('on a real Postgres server (scratch database)', () => {
  let admin: Pool;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let scratch = '';
  let world: World;

  const settings: ReviewSettings = {
    AGENT_KILL_SWITCH: false,
    AUTO_ACCEPT_ENABLED: false,
    AUTO_ACCEPT_MAX_PAISE: 500_000n,
    AUTO_ACCEPT_MIN_CONFIDENCE: 0.85,
    DEMO_MODE: false,
  };
  const asTestDb = () => db as unknown as TestDb;

  beforeAll(async () => {
    loadDotEnv();
    const raw = process.env['DATABASE_URL'];
    if (!raw) throw new Error('DATABASE_URL is not set');
    const url = new URL(raw);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(
        `refusing to run against ${url.hostname}: this test only uses a local server`,
      );
    }
    scratch = `ziro_smoke_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    admin = new Pool({ connectionString: raw, max: 1 });
    await admin.query(`CREATE DATABASE ${scratch}`);
    url.pathname = `/${scratch}`;
    pool = new Pool({ connectionString: url.toString(), max: 8 });
    db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    world = await buildWorld(asTestDb());
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (scratch) await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin?.end();
  }, 60_000);

  it('applies every migration, and the audit trail refuses to be edited', async () => {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.reconRuns);
    expect(row?.n).toBeGreaterThan(0);
    const [event] = await db
      .insert(auditEvents)
      .values({ actor: 'system', action: 'smoke', entityType: 't', entityId: '1' })
      .returning({ id: auditEvents.id });
    const update = await pgErrorOf(
      db
        .update(auditEvents)
        .set({ action: 'tampered' })
        .where(eq(auditEvents.id, event?.id ?? 0n)),
    );
    expect(update.code).toBe(PG.restrict);
    const truncate = await pgErrorOf(pool.query('TRUNCATE audit_events CASCADE'));
    expect(truncate.code).toBe(PG.restrict);
  });

  it('round-trips an amount beyond 2^53 as an exact bigint', async () => {
    const runId = await seedRun(asTestDb());
    const big = 9_007_199_254_740_993n;
    const [row] = await db
      .insert(ledgerEntries)
      .values({
        runId,
        source: 'synthetic',
        sourceRef: 'big',
        importHash: 'a'.repeat(64),
        orderRef: 'BIG',
        amountPaise: big,
        businessDate: '2026-10-21',
      })
      .returning();
    expect(row && ledgerOf(row).amount).toBe(big);
  });

  describe('the agent tools', () => {
    it('answer from a READ ONLY transaction: a write is refused by the server itself', async () => {
      const box = await Toolbox.create(db, world.runId);
      const read = await box.run('get_payment', { id: 'pay_P1' });
      expect(read.ok).toBe(true);
      const sum = await box.run('compute_expected_settlement', {
        payment_ids: ['pay_P1', 'pay_P2'],
        refund_ids: ['rfnd_R1'],
        adjustment_ids: [],
        settlement_id: 'setl_S1',
      });
      expect(sum.ok && JSON.parse(sum.content)).toMatchObject({
        expectedNetPaise: '923450',
        againstSettlement: { residualPaise: '0' },
      });

      const evil = {
        name: 'get_exception' as const,
        description: 'tries to write',
        args: (await import('zod')).z.strictObject({}),
        execute: async (_args: unknown, ctx: { tx: NodePgDatabase<typeof schema> }) => {
          await ctx.tx.execute(sql`delete from recon_runs`);
          return { data: {}, summary: 'wrote', seen: [] };
        },
      };
      const writer = await Toolbox.create(db, world.runId, [evil as never]);
      const failure = await pgErrorOf(writer.run('get_exception', {}));
      expect(failure.code).toBe('25006');
    });

    it('turn a statement that outlives its timeout into an error the model can read', async () => {
      const slow = {
        name: 'get_exception' as const,
        description: 'sleeps',
        args: (await import('zod')).z.strictObject({}),
        execute: async (_args: unknown, ctx: { tx: NodePgDatabase<typeof schema> }) => {
          await ctx.tx.execute(sql`select set_config('statement_timeout', '150', true)`);
          await ctx.tx.execute(sql`select pg_sleep(2)`);
          return { data: {}, summary: 'woke', seen: [] };
        },
      };
      const run = await (
        await Toolbox.create(db, world.runId, [slow as never])
      ).run('get_exception', {});
      expect(run).toEqual({ ok: false, error: 'the search took too long; narrow the filters' });
    });
  });

  describe('verification and approval under real concurrency', () => {
    it('lets exactly one of two proposals that claim the same payment become a match', async () => {
      const runId = await seedRun(asTestDb());
      const first = await seedOrder(asTestDb(), runId);
      const second = await seedOrder(asTestDb(), runId);
      const a = await seedProposal(asTestDb(), runId, first.links);
      const b = await seedProposal(asTestDb(), runId, [
        { recordType: 'ledger_entry', recordId: second.ledger },
        { recordType: 'rzp_payment', recordId: first.payment },
      ]);
      const review = new ReviewService(db, settings);
      await review.verifyAndRoute([a.proposalId, b.proposalId]);

      const results = await Promise.allSettled([
        review.approve(a.proposalId, { reviewer: 'asha' }),
        review.approve(b.proposalId, { reviewer: 'ben' }),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const reason: unknown = lost[0]?.status === 'rejected' ? lost[0].reason : null;
      expect(reason).toBeInstanceOf(ConflictException);
      const body = (reason as ConflictException).getResponse() as { error: string };
      expect(['stale_proposal', 'record_taken']).toContain(body.error);
      const accepted = (
        await db.select().from(matchGroups).where(eq(matchGroups.runId, runId))
      ).filter((g) => g.status === 'accepted');
      expect(accepted).toHaveLength(1);
    });

    it('verifies many proposals at once without double-writing any audit step', async () => {
      const runId = await seedRun(asTestDb());
      const ids: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const order = await seedOrder(asTestDb(), runId);
        ids.push((await seedProposal(asTestDb(), runId, order.links)).proposalId);
      }
      const review = new ReviewService(db, settings);
      await Promise.all([
        review.verifyAndRoute(ids),
        review.verifyAndRoute(ids),
        review.verifyAndRoute(ids),
      ]);
      const verified = (
        await db.select().from(auditEvents).where(eq(auditEvents.runId, runId))
      ).filter((e) => e.action === 'verifier.verified');
      expect(verified).toHaveLength(6);
      const rows = await db.select().from(agentProposals).where(eq(agentProposals.runId, runId));
      expect(rows.every((r) => r.verifierStatus === 'passed')).toBe(true);
    });
  });

  describe('the agent service', () => {
    it('stores one proposal when two workers race on the same job', async () => {
      const runId = await seedRun(asTestDb());
      const order = await seedOrder(asTestDb(), runId);
      const exceptionId = await insertException(asTestDb(), runId, {
        reasonCode: 'UNKNOWN',
        subjectType: 'ledger_entry',
        subjectId: order.ledger,
        candidates: [{ recordType: 'rzp_payment', recordId: order.payment }],
        status: 'open',
        amountAtStakePaise: 250_000n,
      });
      const draft: ProposalDraft = {
        content: {
          exceptionId,
          verdict: 'MATCH_PROPOSED',
          reasonCode: 'UNKNOWN',
          links: order.links,
          explanation: 'One ledger entry, one captured payment.',
          evidence: [
            { tool: 'get_exception', args: { exception_id: exceptionId }, keyFinding: 'x' },
          ],
          confidence: 0.9,
          suggestedAction: 'ACCEPT_MATCH',
          draftJournalEntry: null,
        },
        model: 'claude-haiku-5-5',
        harnessFindings: [],
        llmCallId: null,
      };
      const slow: AgentRunner = {
        harness: 'loop',
        investigate: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return [draft];
        },
      };
      const agent = new AgentService(
        db,
        { AGENT_KILL_SWITCH: false, DAILY_LLM_BUDGET_USD: 5, CLUSTER_EXCEPTIONS: false },
        slow,
        new ReviewService(db, settings),
      );
      const job = { runId, clusterId: null, items: [{ exceptionId, attempt: 1 }] };
      const [x, y] = await Promise.all([agent.process(job), agent.process(job)]);
      expect(x.stored + y.stored).toBe(1);
      const stored = await db
        .select()
        .from(agentProposals)
        .where(eq(agentProposals.exceptionId, exceptionId));
      expect(stored).toHaveLength(1);
    });
  });
});
