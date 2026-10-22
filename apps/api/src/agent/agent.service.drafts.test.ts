// A harness must answer for every exception it was given; the service refuses anything else.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentProposals, reconExceptions } from '../db/schema.js';
import { buildWorld, createMigratedDb, type TestDb, type World } from './agent.fixtures.js';
import { AgentService } from './agent.service.js';
import type { AgentRunner } from './types.js';

let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let world: World;

beforeAll(async () => {
  ({ db, client } = await createMigratedDb());
  world = await buildWorld(db);
}, 60_000);
afterAll(async () => {
  await client.close();
});

const settings = { AGENT_KILL_SWITCH: false, DAILY_LLM_BUDGET_USD: 5, CLUSTER_EXCEPTIONS: false };
const job = () => ({
  runId: world.runId,
  clusterId: null,
  items: [{ exceptionId: world.exceptions.other, attempt: 1 }],
});

describe('a harness that answers for fewer exceptions than it was given', () => {
  it('is refused, and nothing is stored', async () => {
    const runner: AgentRunner = { harness: 'loop', investigate: () => Promise.resolve([]) };
    await expect(new AgentService(db, settings, runner).process(job())).rejects.toThrow(
      /do not match/,
    );
    expect(
      await db
        .select()
        .from(agentProposals)
        .where(eq(agentProposals.exceptionId, world.exceptions.other)),
    ).toHaveLength(0);
    const [row] = await db
      .select()
      .from(reconExceptions)
      .where(eq(reconExceptions.id, world.exceptions.other));
    expect(row?.status).toBe('open');
  });
});
