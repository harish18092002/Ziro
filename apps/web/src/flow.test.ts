import { describe, expect, it } from 'vitest';
import { DOTS, dotPlan, dotProgress, ROUND_MS, schedule, TRAVEL_MS } from './flow';

describe('the flow diagram dots', () => {
  it('follow the run: 95% proved by code puts 19 of 20 dots on the fast lane', () => {
    expect(dotPlan(0.95, 0, 104)).toEqual({ fast: 19, investigate: 1, refused: 0 });
  });

  it('keep one refusal and one investigation when the run has both', () => {
    const p = dotPlan(0.95, 2, 104);
    expect(p.refused).toBe(1);
    expect(p.investigate).toBeGreaterThanOrEqual(1);
    expect(p.fast + p.investigate + p.refused).toBe(DOTS);
  });

  it('send nothing down the investigation lane when there are no exceptions', () => {
    expect(dotPlan(1, 0, 0)).toEqual({ fast: DOTS, investigate: 0, refused: 0 });
  });

  it('a lower match rate widens the investigation lane', () => {
    expect(dotPlan(0.5, 0, 50).investigate).toBe(10);
  });

  it('every dot arrives within the round', () => {
    for (const d of schedule(dotPlan(0.9, 2, 20))) {
      expect(d.at + TRAVEL_MS[d.route]).toBeLessThanOrEqual(ROUND_MS);
      expect(dotProgress(d, d.at)).toBe(0);
      expect(dotProgress(d, d.at - 1)).toBeNull();
    }
  });
});
