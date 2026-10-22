import { describe, expect, it } from 'vitest';
import { chunks, type ExistingRef, writeSourceRows } from './write.js';

interface Row extends ExistingRef {
  readonly n: number;
}
const row = (n: number, hash = `h${n}`): Row => ({ n, sourceRef: `ref-${n}`, importHash: hash });

/** A fake table: what is "stored", and a log of every call made to it. */
function fakeStore(stored: ExistingRef[] = [], insertReturns?: (rows: Row[]) => string[]) {
  const table = new Map(stored.map((s) => [s.sourceRef, s.importHash]));
  const calls = { lookups: [] as number[], inserts: [] as number[] };
  return {
    calls,
    table,
    io: {
      lookup: (refs: string[]): Promise<ExistingRef[]> => {
        calls.lookups.push(refs.length);
        return Promise.resolve(
          refs.flatMap((r) =>
            table.has(r) ? [{ sourceRef: r, importHash: table.get(r) as string }] : [],
          ),
        );
      },
      insert: (rows: Row[]): Promise<string[]> => {
        calls.inserts.push(rows.length);
        const landed = insertReturns ? insertReturns(rows) : rows.map((r) => r.sourceRef);
        for (const r of rows)
          if (landed.includes(r.sourceRef)) table.set(r.sourceRef, r.importHash);
        return Promise.resolve(landed);
      },
    },
  };
}

describe('chunks', () => {
  it('splits into pieces of at most the size, keeping order', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 3)).toEqual([]);
  });
});

describe('writeSourceRows', () => {
  it('inserts new rows in batches of 1000 and counts them', async () => {
    const store = fakeStore();
    const rows = Array.from({ length: 2500 }, (_, i) => row(i));
    const outcome = await writeSourceRows({ rows, ...store.io });
    expect(outcome).toEqual({ inserted: 2500, unchanged: 0, conflicts: [] });
    expect(store.calls.inserts).toEqual([1000, 1000, 500]);
  });

  it('looks stored refs up in batches of at most 5000', async () => {
    const store = fakeStore();
    const rows = Array.from({ length: 12_000 }, (_, i) => row(i));
    await writeSourceRows({ rows, ...store.io });
    expect(store.calls.lookups).toEqual([5000, 5000, 2000]);
  });

  it('leaves a row alone when it is already stored with the same content (a re-import)', async () => {
    const store = fakeStore([
      { sourceRef: 'ref-1', importHash: 'h1' },
      { sourceRef: 'ref-2', importHash: 'h2' },
    ]);
    const outcome = await writeSourceRows({ rows: [row(1), row(2)], ...store.io });
    expect(outcome).toEqual({ inserted: 0, unchanged: 2, conflicts: [] });
    expect(store.calls.inserts).toEqual([]);
  });

  it('reports different content as a conflict and neither inserts nor overwrites it', async () => {
    const store = fakeStore([{ sourceRef: 'ref-1', importHash: 'OLD' }]);
    const outcome = await writeSourceRows({ rows: [row(1, 'NEW'), row(2)], ...store.io });
    expect(outcome).toEqual({ inserted: 1, unchanged: 0, conflicts: ['ref-1'] });
    expect(store.table.get('ref-1')).toBe('OLD');
    expect(store.calls.inserts).toEqual([1]);
  });

  it('treats a mix of new, unchanged and conflicting rows correctly', async () => {
    const store = fakeStore([
      { sourceRef: 'ref-2', importHash: 'h2' },
      { sourceRef: 'ref-3', importHash: 'OLD' },
    ]);
    const outcome = await writeSourceRows({ rows: [row(1), row(2), row(3, 'NEW')], ...store.io });
    expect(outcome).toEqual({ inserted: 1, unchanged: 1, conflicts: ['ref-3'] });
  });

  it('classifies a row that a concurrent import inserted first, by what that import stored', async () => {
    const racing: Row[] = [];
    const store = fakeStore([], (rows) => {
      // Another import lands ref-1 (same content) and ref-2 (different content) while we insert.
      racing.push(...rows);
      store.table.set('ref-1', 'h1');
      store.table.set('ref-2', 'OTHER');
      return rows.map((r) => r.sourceRef).filter((r) => r !== 'ref-1' && r !== 'ref-2');
    });
    const outcome = await writeSourceRows({ rows: [row(1), row(2), row(3)], ...store.io });
    expect(outcome).toEqual({ inserted: 1, unchanged: 1, conflicts: ['ref-2'] });
  });

  it('fails loudly if a row was neither inserted nor found', async () => {
    const store = fakeStore([], () => []);
    await expect(writeSourceRows({ rows: [row(1)], ...store.io })).rejects.toThrow(
      /neither inserted nor found/,
    );
  });

  it('refuses two rows with the same source_ref in one write', async () => {
    const store = fakeStore();
    await expect(writeSourceRows({ rows: [row(1), row(1, 'other')], ...store.io })).rejects.toThrow(
      /duplicate source_ref/,
    );
    expect(store.calls.inserts).toEqual([]);
  });

  it('does nothing for no rows', async () => {
    const store = fakeStore();
    expect(await writeSourceRows({ rows: [], ...store.io })).toEqual({
      inserted: 0,
      unchanged: 0,
      conflicts: [],
    });
  });
});
