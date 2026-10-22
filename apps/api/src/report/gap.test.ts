import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type GapItem, gapOf } from './gap.js';

const item = (status: GapItem['status'], stake: bigint, ...records: string[]): GapItem => ({
  status,
  stakePaise: stake,
  records,
});

describe('gapOf', () => {
  it('is zero when there is nothing', () => {
    expect(gapOf([])).toMatchObject({
      gapPaise: 0n,
      explainedPaise: 0n,
      cases: { open: 0, awaiting: 0, explained: 0 },
    });
  });

  it('counts an exception on its own at its size, whatever its sign', () => {
    expect(gapOf([item('open', -47_300n, 'L1')]).gapPaise).toBe(47_300n);
    expect(gapOf([item('open', 47_300n, 'L1')]).gapPaise).toBe(47_300n);
  });

  it('counts one difference once when it is raised from both sides', () => {
    // An edited ledger amount: the ledger entry and its payment each carry the same stake.
    const gap = gapOf([item('open', -47_300n, 'L1', 'P1'), item('open', 47_300n, 'P1', 'L1')]);
    expect(gap.gapPaise).toBe(47_300n);
    expect(gap.cases.open).toBe(1);
  });

  it('follows a chain of shared records: a shares with b, b shares with c', () => {
    const gap = gapOf([
      item('open', 10n, 'A', 'B'),
      item('open', 30n, 'B', 'C'),
      item('open', 20n, 'C', 'D'),
    ]);
    expect(gap).toMatchObject({ gapPaise: 30n, cases: { open: 1 } });
  });

  it('adds up cases that share nothing', () => {
    const gap = gapOf([item('open', 100n, 'A'), item('open', 250n, 'B'), item('open', 7n, 'C')]);
    expect(gap.gapPaise).toBe(357n);
    expect(gap.cases.open).toBe(3);
  });

  it('keeps open and awaiting-review apart, and both inside the gap', () => {
    const gap = gapOf([item('open', 100n, 'A'), item('proposed', 40n, 'B')]);
    expect(gap).toMatchObject({
      openPaise: 100n,
      awaitingPaise: 40n,
      gapPaise: 140n,
      explainedPaise: 0n,
    });
  });

  it('counts a case with any open member as open, at the largest OPEN stake', () => {
    const gap = gapOf([item('open', 10n, 'A', 'B'), item('proposed', 90n, 'B', 'A')]);
    expect(gap).toMatchObject({
      openPaise: 10n,
      awaitingPaise: 0n,
      cases: { open: 1, awaiting: 0 },
    });
  });

  it('moves a settled case out of the gap into the explained total', () => {
    const gap = gapOf([
      item('resolved', 500n, 'A', 'B'),
      item('resolved', 500n, 'B', 'A'),
      item('open', 20n, 'C'),
    ]);
    expect(gap).toMatchObject({
      gapPaise: 20n,
      explainedPaise: 500n,
      cases: { open: 1, explained: 1 },
    });
  });

  it('ignores dismissed exceptions', () => {
    expect(gapOf([item('dismissed', 999n, 'A')])).toMatchObject({
      gapPaise: 0n,
      explainedPaise: 0n,
    });
  });

  it('never exceeds the plain sum of the unsettled stakes, and is exactly open plus awaiting', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status: fc.constantFrom('open', 'proposed', 'resolved', 'dismissed'),
            stake: fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
            records: fc.array(fc.integer({ min: 0, max: 12 }).map(String), { maxLength: 3 }),
          }),
          { maxLength: 25 },
        ),
        (rows) => {
          const items = rows.map((r) => item(r.status, r.stake, ...r.records));
          const gap = gapOf(items);
          const plain = items
            .filter((i) => i.status === 'open' || i.status === 'proposed')
            .reduce((sum, i) => sum + (i.stakePaise < 0n ? -i.stakePaise : i.stakePaise), 0n);
          expect(gap.gapPaise).toBeLessThanOrEqual(plain);
          expect(gap.gapPaise).toBe(gap.openPaise + gap.awaitingPaise);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('does not depend on the order exceptions are listed in', () => {
    const items = [
      item('open', 5n, 'A', 'B'),
      item('open', 9n, 'B', 'C'),
      item('proposed', 4n, 'X'),
      item('resolved', 3n, 'Y'),
    ];
    expect(gapOf([...items].reverse())).toEqual(gapOf(items));
  });
});
