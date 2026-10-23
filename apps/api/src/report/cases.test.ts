import { describe, expect, it } from 'vitest';
import { casesOf, type GapItem, gapOf } from './gap.js';

const item = (
  status: GapItem['status'],
  stake: bigint,
  ageDays: number | null,
  ...records: string[]
): GapItem => ({ status, stakePaise: stake, records, ageDays });

describe('casesOf', () => {
  it('takes the oldest age in a case, so one old exception makes the whole case old', () => {
    const cases = casesOf([item('open', 10n, 3, 'A', 'B'), item('open', 30n, 40, 'B', 'C')]);
    expect(cases).toEqual([{ status: 'open', stakePaise: 30n, ageDays: 40, members: 2 }]);
  });

  it('has no age when no member has one, and ignores unknown ages next to known ones', () => {
    expect(casesOf([item('open', 5n, null, 'A')])[0]?.ageDays).toBeNull();
    expect(casesOf([item('open', 5n, null, 'A', 'B'), item('open', 6n, 9, 'B')])[0]?.ageDays).toBe(
      9,
    );
  });

  it('judges a case by its unsettled members only: a resolved old member adds no age', () => {
    const [c] = casesOf([item('open', 5n, 2, 'A', 'B'), item('resolved', 9n, 90, 'B')]);
    expect(c).toMatchObject({ status: 'open', ageDays: 2, stakePaise: 5n });
  });

  it('leaves dismissed exceptions out entirely', () => {
    expect(casesOf([item('dismissed', 9n, 1, 'A')])).toEqual([]);
  });

  it('adds up to the same gap as gapOf', () => {
    const items = [
      item('open', 100n, 1, 'A'),
      item('proposed', 40n, 2, 'B'),
      item('resolved', 7n, 3, 'C'),
    ];
    const unsettled = casesOf(items)
      .filter((c) => c.status !== 'explained')
      .reduce((n, c) => n + c.stakePaise, 0n);
    expect(unsettled).toBe(gapOf(items).gapPaise);
  });
});
