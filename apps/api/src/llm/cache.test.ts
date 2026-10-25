import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmResult } from '@ziro/core/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CacheMissError,
  JsonlCacheStore,
  LlmCache,
  MemoryCacheStore,
  canonicalise,
} from './cache.js';
import { fakeResult } from './fake.provider.js';
import type { LlmRequest } from './provider.js';

const U1 = '0b9b2f4e-6c1a-4c6e-9d0a-1f2e3d4c5b6a';
const U2 = '7a1d3c5e-2b4f-4a8d-8e6c-9f0a1b2c3d4e';
const V1 = 'aaaaaaaa-1111-4222-8333-444444444444';
const V2 = 'bbbbbbbb-5555-4666-8777-888888888888';

const tool = {
  name: 'get_thing',
  description: 'gets a thing',
  input: z.object({ id: z.string() }),
};
const identity = { provider: 'gemini', model: 'm1', harness: 'single-shot' };

function request(a: string, b: string, over: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'm1',
    system: 'you are careful',
    messages: [
      { role: 'user', content: `look at exception_id="${a}" and ledger ${b}; again ${a}` },
      {
        role: 'assistant',
        text: '',
        toolCalls: [{ id: 'c1', name: 'get_thing', args: { id: a } }],
      },
    ],
    tools: [tool],
    maxOutputTokens: 1000,
    signal: new AbortController().signal,
    ...over,
  };
}

const answer = (a: string, b: string): LlmResult =>
  fakeResult({
    text: JSON.stringify({ about: a, other: b, none: 'plain' }),
    toolCalls: [{ id: 'c2', name: 'get_thing', args: { id: b } }],
    native: {
      provider: 'gemini',
      model: 'm1',
      payload: [{ type: 'thought', signature: 'opaque==' }],
    },
  });

describe('canonicalise', () => {
  it('gives two requests that differ only in their random ids the same key', () => {
    expect(canonicalise(identity, request(U1, U2)).key).toBe(
      canonicalise(identity, request(V1, V2)).key,
    );
  });

  it('numbers ids by first appearance, one number per distinct id, case-insensitively', () => {
    const c = canonicalise(identity, request(U1.toUpperCase(), U2));
    expect(c.ids).toEqual([U1, U2]);
  });

  it('changes the key when anything that decides the answer changes', () => {
    const base = canonicalise(identity, request(U1, U2)).key;
    const keys = [
      canonicalise({ ...identity, model: 'm2' }, request(U1, U2)),
      canonicalise({ ...identity, provider: 'anthropic' }, request(U1, U2)),
      canonicalise({ ...identity, harness: 'loop' }, request(U1, U2)),
      canonicalise(identity, request(U1, U2, { system: 'you are reckless' })),
      canonicalise(identity, request(U1, U2, { maxOutputTokens: 999 })),
      canonicalise(identity, request(U1, U2, { effort: 'high' })),
      canonicalise(identity, request(U1, U2, { tools: [] })),
      canonicalise(identity, request(U1, U2, { output: z.object({ ok: z.boolean() }) })),
      canonicalise(
        identity,
        request(U1, U2, { tools: [{ ...tool, description: 'gets two things' }] }),
      ),
      // the ids' relationship matters: the same id twice is not two different ids
      canonicalise(identity, request(U1, U1)),
    ].map((c) => c.key);
    expect(new Set([base, ...keys]).size).toBe(keys.length + 1);
  });

  it('ignores the abort signal and the order object keys were written in', () => {
    const a = canonicalise(identity, request(U1, U2));
    const b = canonicalise(identity, { ...request(U1, U2), signal: AbortSignal.timeout(1000) });
    expect(a.key).toBe(b.key);
  });
});

describe('LlmCache', () => {
  it('serves what it recorded, with the asking request’s own ids', async () => {
    const cache = new LlmCache('record', new MemoryCacheStore());
    const first = request(U1, U2);
    expect(await cache.lookup(identity, first)).toBeUndefined();
    await cache.remember(identity, first, answer(U1, U2));

    // a second run: new database, new random ids
    const hit = await cache.lookup(identity, request(V1, V2));
    expect(hit?.result).toEqual(answer(V1, V2));
    // and the first run's own request gets its own ids back
    expect((await cache.lookup(identity, first))?.result).toEqual(answer(U1, U2));
  });

  it('keeps an opaque provider payload byte for byte', async () => {
    const cache = new LlmCache('record', new MemoryCacheStore());
    await cache.remember(identity, request(U1, U2), answer(U1, U2));
    const hit = await cache.lookup(identity, request(V1, V2));
    expect(hit?.result.native).toEqual({
      provider: 'gemini',
      model: 'm1',
      payload: [{ type: 'thought', signature: 'opaque==' }],
    });
  });

  it('fails loudly on a miss in replay mode, naming what is missing', async () => {
    const cache = new LlmCache('replay', new MemoryCacheStore());
    const error = await cache.lookup(identity, request(U1, U2)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CacheMissError);
    expect((error as Error).message).toContain('gemini:m1');
    expect((error as Error).message).toContain('single-shot');
    expect((error as Error).message).toContain('LLM_CACHE=record');
  });

  it('replays what a record run kept, and does not record anything itself', async () => {
    const store = new MemoryCacheStore();
    await new LlmCache('record', store).remember(identity, request(U1, U2), answer(U1, U2));
    const replay = new LlmCache('replay', store);
    expect((await replay.lookup(identity, request(V1, V2)))?.result).toEqual(answer(V1, V2));
    await replay.remember(identity, request(V1, V1), answer(V1, V1));
    expect(store.entries.size).toBe(1);
  });

  it('does nothing when off', async () => {
    const store = new MemoryCacheStore();
    const off = new LlmCache('off', store);
    await off.remember(identity, request(U1, U2), answer(U1, U2));
    expect(store.entries.size).toBe(0);
    expect(await off.lookup(identity, request(U1, U2))).toBeUndefined();
  });

  it('does not let a recorded answer for one model answer for another', async () => {
    const store = new MemoryCacheStore();
    await new LlmCache('record', store).remember(identity, request(U1, U2), answer(U1, U2));
    const replay = new LlmCache('replay', store);
    await expect(
      replay.lookup({ ...identity, model: 'm2' }, request(U1, U2)),
    ).rejects.toBeInstanceOf(CacheMissError);
  });
});

describe('JsonlCacheStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ziro-cache-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('survives a restart: a new store reading the file sees the same answers', async () => {
    const path = join(dir, 'nested', 'cache.jsonl');
    await new LlmCache('record', new JsonlCacheStore(path)).remember(
      identity,
      request(U1, U2),
      answer(U1, U2),
    );
    const replay = new LlmCache('replay', new JsonlCacheStore(path));
    expect((await replay.lookup(identity, request(V1, V2)))?.result).toEqual(answer(V1, V2));
  });

  it('writes one line per distinct request and never twice for the same one', async () => {
    const path = join(dir, 'cache.jsonl');
    const cache = new LlmCache('record', new JsonlCacheStore(path));
    await cache.remember(identity, request(U1, U2), answer(U1, U2));
    await cache.remember(identity, request(V1, V2), answer(V1, V2));
    await cache.remember(identity, request(U1, U1), answer(U1, U1));
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('starts empty when the file does not exist', async () => {
    const replay = new LlmCache('replay', new JsonlCacheStore(join(dir, 'missing.jsonl')));
    await expect(replay.lookup(identity, request(U1, U2))).rejects.toBeInstanceOf(CacheMissError);
  });
});
