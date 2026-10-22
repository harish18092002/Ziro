import type { RecordRef } from '@ziro/core/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cluster, skipReason, triage, type TriageInput } from './triage.js';

const rec = (type: RecordRef['recordType'], n: number): RecordRef => ({
  recordType: type,
  recordId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
});
const ex = (
  id: number,
  subject: RecordRef,
  candidates: RecordRef[] = [],
  cause: string | null = null,
): TriageInput => ({
  id: `10000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  cause,
  subject,
  candidates,
});

describe('triage', () => {
  it('lists an unexplained bank credit with no candidates for a person, and investigates the rest', () => {
    const a = ex(1, rec('bank_line', 1), [], 'bank_credit_unexplained');
    const b = ex(2, rec('bank_line', 2), [rec('rzp_settlement', 1)], 'bank_credit_unexplained');
    const c = ex(3, rec('ledger_entry', 3), [], 'ledger_has_no_payment');
    const out = triage([a, b, c]);
    expect(out.investigate).toEqual([b, c]);
    expect(out.skipped).toEqual([
      { exceptionId: a.id, why: expect.stringContaining('listed for a person') as string },
    ]);
  });

  it('skips nothing whose cause is anything else, however empty its candidates', () => {
    for (const cause of [
      null,
      'ledger_has_no_payment',
      'payment_has_no_ledger',
      'no_bank_credit',
      'window_ambiguous',
    ]) {
      expect(skipReason(ex(1, rec('rzp_payment', 1), [], cause))).toBeNull();
    }
  });
});

describe('cluster', () => {
  it('puts exceptions that share a candidate together', () => {
    const shared = rec('rzp_payment', 9);
    const a = ex(1, rec('ledger_entry', 1), [shared]);
    const b = ex(2, rec('ledger_entry', 2), [shared, rec('rzp_payment', 8)]);
    const c = ex(3, rec('ledger_entry', 3), [rec('rzp_payment', 7)]);
    expect(cluster([c, b, a])).toEqual([[a, b], [c]]);
  });

  it("joins an exception whose candidate is another's subject", () => {
    const a = ex(1, rec('rzp_settlement', 1), [rec('bank_line', 1)]);
    const b = ex(2, rec('bank_line', 1), [rec('rzp_settlement', 1)]);
    expect(cluster([a, b])).toEqual([[a, b]]);
  });

  it('follows a chain: a shares with b, b shares with c', () => {
    const a = ex(1, rec('ledger_entry', 1), [rec('rzp_payment', 1)]);
    const b = ex(2, rec('ledger_entry', 2), [rec('rzp_payment', 1), rec('rzp_payment', 2)]);
    const c = ex(3, rec('ledger_entry', 3), [rec('rzp_payment', 2)]);
    expect(cluster([a, b, c])).toEqual([[a, b, c]]);
  });

  it('does not join exceptions that merely have equal-looking records of different types', () => {
    const a = ex(1, rec('ledger_entry', 1), [rec('rzp_payment', 5)]);
    const b = ex(2, rec('ledger_entry', 2), [rec('bank_line', 5)]);
    expect(cluster([a, b])).toHaveLength(2);
  });

  it('cuts a large connected group into runs of at most six, in a stable order', () => {
    const hub = rec('rzp_settlement', 1);
    const all = Array.from({ length: 14 }, (_, i) => ex(i + 1, rec('bank_line', i + 1), [hub]));
    const groups = cluster(all);
    expect(groups.map((g) => g.length)).toEqual([6, 6, 2]);
    expect(groups.flat().map((e) => e.id)).toEqual(all.map((e) => e.id));
  });

  it('honours a smaller maximum, and a maximum of one means no clustering', () => {
    const hub = rec('rzp_settlement', 1);
    const all = Array.from({ length: 5 }, (_, i) => ex(i + 1, rec('bank_line', i + 1), [hub]));
    expect(cluster(all, 2).map((g) => g.length)).toEqual([2, 2, 1]);
    expect(cluster(all, 1).map((g) => g.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it('handles nothing', () => {
    expect(cluster([])).toEqual([]);
  });

  const arbitrary = fc
    .array(
      fc.record({
        id: fc.integer({ min: 1, max: 40 }),
        subject: fc.integer({ min: 1, max: 40 }),
        candidates: fc.array(
          fc.tuple(
            fc.constantFrom('rzp_payment', 'bank_line', 'ledger_entry'),
            fc.integer({ min: 1, max: 15 }),
          ),
          { maxLength: 4 },
        ),
      }),
      { maxLength: 30 },
    )
    .map((rows) => {
      const seen = new Set<number>();
      return rows
        .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
        .map((r) =>
          ex(
            r.id,
            rec('ledger_entry', 100 + r.subject),
            r.candidates.map(([t, n]) => rec(t as RecordRef['recordType'], n)),
          ),
        );
    });

  it('puts every exception in exactly one group of at most the maximum', () => {
    fc.assert(
      fc.property(arbitrary, fc.integer({ min: 1, max: 8 }), (items, max) => {
        const groups = cluster(items, max);
        const ids = groups
          .flat()
          .map((e) => e.id)
          .sort();
        expect(ids).toEqual(items.map((e) => e.id).sort());
        for (const g of groups) {
          expect(g.length).toBeGreaterThan(0);
          expect(g.length).toBeLessThanOrEqual(max);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('does not depend on the order the exceptions arrive in', () => {
    fc.assert(
      fc.property(arbitrary, fc.integer(), (items, seed) => {
        const shuffled = [...items].sort(
          (a, b) => ((a.id.charCodeAt(30) * seed) % 7) - ((b.id.charCodeAt(30) * seed) % 7),
        );
        expect(cluster(shuffled).map((g) => g.map((e) => e.id))).toEqual(
          cluster(items).map((g) => g.map((e) => e.id)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('never separates two exceptions that share a record while their group fits', () => {
    fc.assert(
      fc.property(arbitrary, (items) => {
        const groups = cluster(items, 1_000);
        const groupOf = new Map<string, number>();
        groups.forEach((g, i) => g.forEach((e) => groupOf.set(e.id, i)));
        const byRecord = new Map<string, string>();
        for (const e of items) {
          for (const r of [e.subject, ...e.candidates]) {
            const key = `${r.recordType}:${r.recordId}`;
            const other = byRecord.get(key);
            if (other !== undefined) expect(groupOf.get(e.id)).toBe(groupOf.get(other));
            else byRecord.set(key, e.id);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('is fast enough for the stress preset: 30,000 exceptions in one hub', () => {
    const hub = rec('rzp_settlement', 1);
    const all = Array.from({ length: 30_000 }, (_, i) => ex(i + 1, rec('bank_line', i + 1), [hub]));
    const started = performance.now();
    const groups = cluster(all);
    expect(groups).toHaveLength(5_000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
