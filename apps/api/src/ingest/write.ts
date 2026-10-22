// The one place that decides what happens when a row arrives: new rows are inserted, a row that is
// already there with identical content is left alone (a re-import is a no-op), and a row that is
// already there with DIFFERENT content is reported and never overwritten. The database's unique
// (run_id, source_ref) index is the backstop if two imports race.

export interface ExistingRef {
  readonly sourceRef: string;
  readonly importHash: string;
}

export interface WriteOutcome {
  readonly inserted: number;
  readonly unchanged: number;
  /** source_refs that already exist with different content. */
  readonly conflicts: readonly string[];
}

export interface WriteArgs<R extends ExistingRef> {
  readonly rows: readonly R[];
  /** The stored (source_ref, import_hash) for any of these refs that exist. */
  readonly lookup: (refs: string[]) => Promise<readonly ExistingRef[]>;
  /** Inserts with ON CONFLICT DO NOTHING and returns the source_refs it actually inserted. */
  readonly insert: (rows: R[]) => Promise<readonly string[]>;
}

const LOOKUP_CHUNK = 5000;
// 1000 rows x ~20 columns stays well under Postgres' 65,535 bind-parameter limit.
const INSERT_CHUNK = 1000;

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function writeSourceRows<R extends ExistingRef>(
  args: WriteArgs<R>,
): Promise<WriteOutcome> {
  const seen = new Set<string>();
  for (const row of args.rows) {
    if (seen.has(row.sourceRef))
      throw new Error(`duplicate source_ref in one write: ${row.sourceRef}`);
    seen.add(row.sourceRef);
  }

  const stored = new Map<string, string>();
  for (const refs of chunks([...seen], LOOKUP_CHUNK)) {
    for (const found of await args.lookup(refs)) stored.set(found.sourceRef, found.importHash);
  }

  let unchanged = 0;
  const conflicts: string[] = [];
  const fresh: R[] = [];
  const classify = (row: R, storedHash: string | undefined): void => {
    if (storedHash === undefined) fresh.push(row);
    else if (storedHash === row.importHash) unchanged += 1;
    else conflicts.push(row.sourceRef);
  };
  for (const row of args.rows) classify(row, stored.get(row.sourceRef));

  let inserted = 0;
  for (const batch of chunks(fresh, INSERT_CHUNK)) {
    const landed = new Set(await args.insert(batch));
    inserted += landed.size;

    // A row we expected to insert but did not: a concurrent import got there first. Classify it
    // against what that import stored, exactly as if it had been there all along.
    const raced = batch.filter((row) => !landed.has(row.sourceRef));
    if (raced.length === 0) continue;
    const now = new Map(
      (await args.lookup(raced.map((row) => row.sourceRef))).map((f) => [
        f.sourceRef,
        f.importHash,
      ]),
    );
    for (const row of raced) {
      const storedHash = now.get(row.sourceRef);
      if (storedHash === undefined)
        throw new Error(`row ${row.sourceRef} was neither inserted nor found`);
      if (storedHash === row.importHash) unchanged += 1;
      else conflicts.push(row.sourceRef);
    }
  }
  return { inserted, unchanged, conflicts };
}
