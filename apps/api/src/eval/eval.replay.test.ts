// The acceptance check for the record/replay cache, at full size: two FRESH runs of the real eval dataset
// (500 orders, seed 42, 58 investigations), the second served from the first's record. Every answer must be
// found and no request sent. Row ids are random in each fresh database, so this fails if a prompt depends on
// them anywhere: in an id itself (canonicalised away) or in the ORDER things are listed (which is how it once
// failed: a brief listed its candidates in row-id order).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexTruth, parseTruth } from '@ziro/evals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replyWith, result, scriptedRouter } from '../agent/scripted-llm.fixtures.js';
import { SingleShotRunner } from '../agent/single-shot.js';
import { LlmCache, MemoryCacheStore } from '../llm/cache.js';
import { makeSyntheticDataset, type TempDataset } from '../razorpay/razorpay.fixtures.js';
import { CostGuard } from './cost-guard.js';
import { runOnce } from './pipeline.js';

let data: TempDataset;
beforeAll(() => {
  data = makeSyntheticDataset('eval', 42);
}, 120_000);
afterAll(() => data.cleanup());

const EXCEPTION_IDS = /exception_id="([0-9a-f-]{36})"/g;

/** A model that answers any exception NEEDS_HUMAN, from the ids in the prompt. */
const answering = Array.from(
  { length: 400 },
  () => (request: { messages: readonly { role: string; content?: string }[] }) =>
    replyWith(
      [...(request.messages[0]?.content ?? '').matchAll(EXCEPTION_IDS)].map((m) =>
        result(m[1] as string, {
          verdict: 'NEEDS_HUMAN',
          reasonCode: 'UNKNOWN',
          suggestedAction: 'NONE',
          confidence: 0.4,
          explanation: 'Not enough to decide.',
        }),
      ),
    ),
);

describe('replaying a record of the eval dataset', () => {
  it('finds every answer in a brand-new database and sends nothing', async () => {
    const truth = indexTruth(
      parseTruth(JSON.parse(readFileSync(join(data.dir, 'truth.json'), 'utf8'))),
    );
    const store = new MemoryCacheStore();
    const run = (cache: 'record' | 'replay', steps: readonly unknown[]) =>
      runOnce({
        dataDir: data.dir,
        preset: 'eval',
        seed: 42,
        truth,
        config: 'lite-single',
        leg: 'plain',
        repeat: 1,
        cluster: false,
        concurrency: 4,
        guard: new CostGuard(null),
        llmEnv: {},
        sample: null,
        cache,
        overlay: [],
        entry: { provider: 'gemini', model: 'lite-model', id: 'gemini:lite-model' },
        makeRunner: () =>
          new SingleShotRunner({
            router: scriptedRouter([['gemini:lite-model', steps as never]], {
              cache: new LlmCache(cache, store),
            }).router,
            escalation: false,
          }),
      });

    const recorded = await run('record', answering);
    expect(recorded.incomplete).toBe(false);
    expect(recorded.cost.requests).toBe(recorded.exceptions.handled);
    expect(store.entries.size).toBe(recorded.exceptions.handled);

    // The second model is a stub with no answers: reaching it would throw.
    const replayed = await run('replay', []);
    expect(replayed.incompleteReason).toBeNull();
    expect(replayed.cost.requests).toBe(0);
    expect(replayed.cost.replayed).toBe(recorded.cost.requests);
    expect(replayed.cache).toBe('replay');
  }, 600_000);
});
