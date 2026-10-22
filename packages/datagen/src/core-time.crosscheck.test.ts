// The generator and the production parser each own an IST implementation, written with different
// algorithms on purpose (closed-form civil-date formulas here, a year-by-year walk in
// @ziro/core/time). This test is what makes that separation worth having: if either has a bug the
// other does not share, they disagree here.
import {
  addDaysToBusinessDate,
  instantFromEpoch,
  istBusinessDate,
  istDayBounds,
} from '@ziro/core/time';
import { describe, expect, it } from 'vitest';
import { Rng } from './rng.js';
import { epochFromIst, formatIsoDay, istDay, istSecondOfDay, parseIsoDay } from './time.js';

describe('@ziro/core/time agrees with the generator', () => {
  const rng = Rng.fromSeed(20_261_022);
  const from = 1_420_070_400; // 2015-01-01
  const to = 2_208_988_800; // 2040-01-01

  it('gives the same IST business date for 50,000 random instants', () => {
    for (let i = 0; i < 50_000; i++) {
      const epoch = from + rng.int(0, to - from);
      expect(istBusinessDate(epoch), `epoch ${epoch}`).toBe(formatIsoDay(istDay(epoch)));
    }
  });

  it('agrees on both sides of every IST midnight it is shown', () => {
    for (let i = 0; i < 2_000; i++) {
      const day = parseIsoDay('2020-01-01') + rng.int(0, 7_000);
      const midnight = epochFromIst(day, 0);
      expect(istBusinessDate(midnight)).toBe(formatIsoDay(day));
      expect(istBusinessDate(midnight - 1)).toBe(formatIsoDay(day - 1));
      expect(istSecondOfDay(midnight)).toBe(0);
    }
  });

  it('computes the same day bounds', () => {
    for (let i = 0; i < 5_000; i++) {
      const date = formatIsoDay(parseIsoDay('2000-01-02') + rng.int(0, 36_000));
      const { fromEpoch, toEpoch } = istDayBounds(date);
      expect(fromEpoch, date).toBe(epochFromIst(parseIsoDay(date), 0));
      expect(toEpoch, date).toBe(epochFromIst(parseIsoDay(date), 86_399));
    }
  });

  it('shifts dates by the same number of days', () => {
    for (let i = 0; i < 5_000; i++) {
      const day = parseIsoDay('2001-01-01') + rng.int(0, 15_000);
      const delta = rng.int(-800, 800);
      expect(addDaysToBusinessDate(formatIsoDay(day), delta)).toBe(formatIsoDay(day + delta));
    }
  });

  it('formats instants consistently with the generator epoch', () => {
    for (let i = 0; i < 5_000; i++) {
      const epoch = from + rng.int(0, to - from);
      const instant = instantFromEpoch(epoch);
      expect(Date.parse(instant) / 1000).toBe(epoch);
    }
  });
});
