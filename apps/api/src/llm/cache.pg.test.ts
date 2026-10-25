import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, type TestDb } from '../db/migrated-db.fixtures.js';
import { type CacheEntry, JsonlCacheStore, LlmCache } from './cache.js';
import { copyCache, PgCacheStore } from './cache.pg.js';
import { fakeResult } from './fake.provider.js';
import type { LlmRequest } from './provider.js';

const U1 = '0b9b2f4e-6c1a-4c6e-9d0a-1f2e3d4c5b6a';
const V1 = 'aaaaaaaa-1111-4222-8333-444444444444';
const identity = { provider: 'gemini', model: 'm', harness: 'single-shot' };
const request = (id: string): LlmRequest => ({
  model: 'm',
  system: 's',
  messages: [{ role: 'user', content: `exception_id="${id}"` }],
  tools: [],
  maxOutputTokens: 10,
  signal: new AbortController().signal,
});

describe('PgCacheStore', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = (await createMigratedDb()).db;
  });

  it('records in Postgres and replays in a later run with different ids', async () => {
    const store = new PgCacheStore(db);
    await new LlmCache('record', store).remember(
      identity,
      request(U1),
      fakeResult({ text: `about ${U1}` }),
    );
    const hit = await new LlmCache('replay', store).lookup(identity, request(V1));
    expect(hit?.result.text).toBe(`about ${V1}`);
  });

  it('keeps the first answer when the same key is recorded twice', async () => {
    const store = new PgCacheStore(db);
    const entry: CacheEntry = { key: 'k'.repeat(64), ...identity, response: { n: 1 } };
    await store.put(entry);
    await store.put({ ...entry, response: { n: 2 } });
    expect((await store.get(entry.key))?.response).toEqual({ n: 1 });
  });
});

describe('copyCache', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ziro-copy-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('moves a file’s answers into Postgres once, so an eval recording can serve a deployed demo', async () => {
    const file = new JsonlCacheStore(join(dir, 'c.jsonl'));
    await new LlmCache('record', file).remember(identity, request(U1), fakeResult({ text: 'x' }));
    const { db } = await createMigratedDb();
    const pg = new PgCacheStore(db);
    expect(await copyCache(file, pg)).toBe(1);
    expect(await copyCache(file, pg)).toBe(0);
    const hit = await new LlmCache('replay', pg).lookup(identity, request(V1));
    expect(hit?.result.text).toBe('x');
  });
});
