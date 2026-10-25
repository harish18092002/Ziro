// The Postgres side of the answer cache (llm_cache). The file side (JsonlCacheStore) is for the evals,
// whose database is rebuilt for every run; this one is for the running app, which keeps recorded answers
// across restarts. `copyCache` moves entries between the two, so an answer recorded in an eval can be
// replayed by a deployed demo.
import { eq } from 'drizzle-orm';
import type { Executor } from '../db/executor.js';
import { llmCache } from '../db/schema.js';
import type { CacheEntry, LlmCacheStore } from './cache.js';

export class PgCacheStore implements LlmCacheStore {
  constructor(private readonly db: Executor) {}

  async get(key: string): Promise<CacheEntry | undefined> {
    const [row] = await this.db.select().from(llmCache).where(eq(llmCache.key, key));
    return row === undefined
      ? undefined
      : {
          key: row.key,
          provider: row.provider,
          model: row.model,
          harness: row.harness,
          response: row.response,
        };
  }

  async put(entry: CacheEntry): Promise<void> {
    await this.db
      .insert(llmCache)
      .values({
        key: entry.key,
        provider: entry.provider,
        model: entry.model,
        harness: entry.harness,
        response: entry.response as never,
      })
      .onConflictDoNothing({ target: llmCache.key });
  }

  async all(): Promise<CacheEntry[]> {
    const rows = await this.db.select().from(llmCache);
    return rows.map((r) => ({
      key: r.key,
      provider: r.provider,
      model: r.model,
      harness: r.harness,
      response: r.response,
    }));
  }
}

/** Copies every entry of `from` that `to` does not have yet. Returns how many were added. */
export async function copyCache(
  from: { all(): Promise<CacheEntry[]> },
  to: LlmCacheStore,
): Promise<number> {
  let added = 0;
  for (const entry of await from.all()) {
    if ((await to.get(entry.key)) !== undefined) continue;
    await to.put(entry);
    added += 1;
  }
  return added;
}
