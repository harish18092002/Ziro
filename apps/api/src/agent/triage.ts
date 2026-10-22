// Which exceptions are worth a model's time, and which of them go in one conversation.
// Pure: no database, no clock. Deterministic: the same exceptions always give the same jobs.
import type { RecordRef } from '@ziro/core/domain';
import { MAX_CLUSTER_MEMBERS } from './output.js';

export interface TriageInput {
  readonly id: string;
  readonly cause: string | null;
  readonly subject: RecordRef;
  readonly candidates: readonly RecordRef[];
}

export interface Skipped {
  readonly exceptionId: string;
  readonly why: string;
}

/**
 * A bank credit that no settlement explains and that has no candidate record at all gives the agent
 * nothing to look at: it would search blindly. At stress scale this is most exceptions (generator
 * noise), and a person triages them as a list. Everything else is investigated.
 */
export function skipReason(e: TriageInput): string | null {
  if (e.cause === 'bank_credit_unexplained' && e.candidates.length === 0) {
    return 'a bank credit that nothing explains and with no candidate records: listed for a person';
  }
  return null;
}

export function triage<T extends TriageInput>(
  items: readonly T[],
): { investigate: T[]; skipped: Skipped[] } {
  const investigate: T[] = [];
  const skipped: Skipped[] = [];
  for (const item of items) {
    const why = skipReason(item);
    if (why === null) investigate.push(item);
    else skipped.push({ exceptionId: item.id, why });
  }
  return { investigate, skipped };
}

const keyOf = (r: RecordRef): string => `${r.recordType}:${r.recordId}`;

/**
 * Groups exceptions that share a record: the same candidate, or one's candidate being another's
 * subject. These are the exceptions a person would look at together (two payments for one order, a
 * settlement and the bank credit beside it). A group is at most `max` members; a larger connected
 * group is cut into consecutive runs in a stable order, so neighbours tend to stay together.
 * Nothing is merged across groups, and every exception lands in exactly one group.
 */
export function cluster<T extends TriageInput>(
  unsorted: readonly T[],
  max = MAX_CLUSTER_MEMBERS,
): T[][] {
  // Sorted first, so the result does not depend on the order the database happened to return rows in.
  const items = [...unsorted].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root] ?? root;
    for (let node = i; parent[node] !== root;) {
      const next = parent[node] ?? root;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Every record an exception touches, and the first exception seen touching it.
  const owner = new Map<string, number>();
  items.forEach((item, i) => {
    for (const record of [item.subject, ...item.candidates]) {
      const key = keyOf(record);
      const seen = owner.get(key);
      if (seen === undefined) owner.set(key, i);
      else union(seen, i);
    }
  });

  const groups = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    const members = groups.get(root);
    if (members === undefined) groups.set(root, [item]);
    else members.push(item);
  });

  const out: T[][] = [];
  for (const members of [...groups.entries()].sort(([a], [b]) => a - b).map(([, m]) => m)) {
    for (let i = 0; i < members.length; i += max) out.push(members.slice(i, i + max));
  }
  return out;
}
