// The time budget has to reach the network call, not just be checked between calls: a request that
// hangs must be cut off. This waits on a real timer, so it lives apart from the fast scripted tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, createMigratedDb, type TestDb, type World } from './agent.fixtures.js';
import { DEFAULT_LIMITS } from './budget.js';
import { LlmAbortedError } from '../llm/provider.js';
import { LoopRunner } from './loop-runner.js';
import { type FakeStep, scriptedRouter, testContext } from './scripted-llm.fixtures.js';
import { Toolbox } from './tools/toolbox.js';

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

describe('the time budget reaches the request', () => {
  it('aborts a request that outlives it, and ends in NEEDS_HUMAN long before the default budget', async () => {
    // A fake whose request never answers on its own; only the abort signal ends it.
    const hang = ((request: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new LlmAbortedError()));
      })) as unknown as FakeStep;
    const runner = new LoopRunner({
      router: scriptedRouter([['gemini:small', [hang]]]).router,
      escalation: false,
      limits: { ...DEFAULT_LIMITS, timeoutMs: 80 },
    });
    const ctx = testContext(await Toolbox.create(db, world.runId), world.runId);
    const started = Date.now();
    const [draft] = await runner.investigate(
      [{ id: world.exceptions.duplicate, ruleReasonCode: 'DUPLICATE_PAYMENT' }],
      ctx,
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.harnessFindings[0]).toContain('time budget');
  }, 10_000);
});
