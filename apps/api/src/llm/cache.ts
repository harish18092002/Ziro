// A record/replay cache for model answers, so a paid or scarce call is made once and every later run, eval
// and demo replay can use the recorded answer for free.
//
//   off     every call goes to the provider.
//   record  an answer already on record is served; otherwise the provider is called and the answer is kept.
//   replay  answers come from the record only. A call that is not in it fails LOUDLY (CacheMissError): a
//           replay that quietly spent a request, or quietly made something up, would not be a replay.
//
// The key is a hash of (provider, model, harness, the whole request). The request carries row ids, and row
// ids are random UUIDs that differ in every fresh database, so a hash of the raw request would never match
// a second run. Each distinct UUID is therefore replaced by `<id:n>`, n being the order it first appears in
// the request, before hashing; the stored answer is canonicalised with the same map and mapped back to the
// asking request's own ids when it is served. Two runs that differ only in their random ids share a key.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LlmResult } from '@ziro/core/llm';
import { z } from 'zod';
import type { LlmRequest } from './provider.js';

export const CACHE_MODES = ['off', 'record', 'replay'] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

/** What a replay needed and did not find. Never an LlmError: no fallback would make this better. */
export class CacheMissError extends Error {
  constructor(
    readonly key: string,
    readonly provider: string,
    readonly model: string,
    readonly harness: string,
  ) {
    super(
      `LLM_CACHE=replay: no recorded answer for ${provider}:${model} (${harness}), key ${key.slice(0, 12)}. ` +
        'Record one first (LLM_CACHE=record) or run without replay.',
    );
    this.name = 'CacheMissError';
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PLACEHOLDER = /<id:(\d+)>/g;

/** JSON with object keys sorted, so the same request always serialises to the same text. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export interface CacheIdentity {
  readonly provider: string;
  readonly model: string;
  readonly harness: string;
}

export interface CanonicalRequest {
  readonly key: string;
  /** The request's UUIDs by their `<id:n>` number. */
  readonly ids: readonly string[];
}

/** The parts of a request that decide the answer. The abort signal is not one of them. */
function requestBody(request: LlmRequest): unknown {
  return {
    system: request.system,
    messages: request.messages,
    tools: request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input: z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }),
    })),
    maxOutputTokens: request.maxOutputTokens,
    output:
      request.output === undefined
        ? null
        : z.toJSONSchema(request.output, { io: 'input', unrepresentable: 'any' }),
    effort: request.effort ?? null,
  };
}

export function canonicalise(identity: CacheIdentity, request: LlmRequest): CanonicalRequest {
  const ids: string[] = [];
  const numbers = new Map<string, number>();
  const body = stable(requestBody(request)).replace(UUID, (id) => {
    const lower = id.toLowerCase();
    let n = numbers.get(lower);
    if (n === undefined) {
      n = ids.length;
      numbers.set(lower, n);
      ids.push(lower);
    }
    return `<id:${n}>`;
  });
  const key = createHash('sha256')
    .update(stable([identity.provider, identity.model, identity.harness, body]))
    .digest('hex');
  return { key, ids };
}

/** An answer with the asking request's ids swapped for placeholders. */
function toCanonicalResult(result: LlmResult, ids: readonly string[]): unknown {
  const numbers = new Map(ids.map((id, n) => [id, n]));
  return JSON.parse(
    JSON.stringify(result).replace(UUID, (id) => {
      const n = numbers.get(id.toLowerCase());
      return n === undefined ? id : `<id:${n}>`;
    }),
  );
}

/** A stored answer with placeholders mapped back to the asking request's ids. */
function fromCanonicalResult(stored: unknown, ids: readonly string[]): LlmResult {
  return JSON.parse(
    JSON.stringify(stored).replace(PLACEHOLDER, (whole, n: string) => ids[Number(n)] ?? whole),
  ) as LlmResult;
}

export interface CacheEntry extends CacheIdentity {
  readonly key: string;
  /** The canonical answer, as JSON. */
  readonly response: unknown;
}

export interface LlmCacheStore {
  get(key: string): Promise<CacheEntry | undefined>;
  put(entry: CacheEntry): Promise<void>;
}

export class MemoryCacheStore implements LlmCacheStore {
  readonly entries = new Map<string, CacheEntry>();

  get(key: string): Promise<CacheEntry | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  put(entry: CacheEntry): Promise<void> {
    if (!this.entries.has(entry.key)) this.entries.set(entry.key, entry);
    return Promise.resolve();
  }
}

/**
 * A file with one JSON object per line. The evals build a fresh in-memory database for every run, so the
 * record has to live somewhere that survives one: this file, which can also be imported into Postgres.
 */
export class JsonlCacheStore implements LlmCacheStore {
  private loaded: Map<string, CacheEntry> | null = null;

  constructor(private readonly path: string) {}

  private async load(): Promise<Map<string, CacheEntry>> {
    if (this.loaded !== null) return this.loaded;
    const map = new Map<string, CacheEntry>();
    let text = '';
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const entry = JSON.parse(line) as CacheEntry;
      if (!map.has(entry.key)) map.set(entry.key, entry);
    }
    this.loaded = map;
    return map;
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    return (await this.load()).get(key);
  }

  async put(entry: CacheEntry): Promise<void> {
    const map = await this.load();
    if (map.has(entry.key)) return;
    map.set(entry.key, entry);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Every entry, for importing into another store. */
  async all(): Promise<CacheEntry[]> {
    return [...(await this.load()).values()];
  }
}

export interface CacheHit {
  readonly result: LlmResult;
}

/** The cache as the session uses it: one object that knows the mode, the store and the id mapping. */
export class LlmCache {
  constructor(
    readonly mode: CacheMode,
    private readonly store: LlmCacheStore,
  ) {}

  /** A recorded answer for this request, or undefined; in replay mode a miss throws instead. */
  async lookup(identity: CacheIdentity, request: LlmRequest): Promise<CacheHit | undefined> {
    if (this.mode === 'off') return undefined;
    const { key, ids } = canonicalise(identity, request);
    const entry = await this.store.get(key);
    if (entry !== undefined) return { result: fromCanonicalResult(entry.response, ids) };
    if (this.mode === 'replay') {
      throw new CacheMissError(key, identity.provider, identity.model, identity.harness);
    }
    return undefined;
  }

  /** Keeps an answer, when recording. */
  async remember(identity: CacheIdentity, request: LlmRequest, result: LlmResult): Promise<void> {
    if (this.mode !== 'record') return;
    const { key, ids } = canonicalise(identity, request);
    await this.store.put({ key, ...identity, response: toCanonicalResult(result, ids) });
  }

  static off(): LlmCache {
    return new LlmCache('off', new MemoryCacheStore());
  }
}
