import { describe, expect, it } from 'vitest';
import {
  checkShown,
  explainedShare,
  FINAL_T,
  fading,
  packetProgress,
  remainingPaise,
  STORY,
  stepChunks,
  stepsShown,
} from './story';

const GAP = 20_419_089n; // the replay run's gap after rules, ₹2,04,190.89

describe('the hero story', () => {
  it('starts from the whole gap and ends exactly at ₹0.00', () => {
    expect(remainingPaise(GAP, 0)).toBe(GAP);
    expect(remainingPaise(GAP, FINAL_T)).toBe(0n);
    expect(remainingPaise(GAP, STORY.fadeAt - 1)).toBe(0n);
  });

  it('only ever counts down, in whole paise', () => {
    let last = GAP;
    for (let t = 0; t < STORY.loopMs; t += 17) {
      const now = remainingPaise(GAP, t);
      expect(typeof now).toBe('bigint');
      expect(now <= last).toBe(true);
      expect(now >= 0n).toBe(true);
      last = now;
    }
  });

  it('splits the gap into step chunks that add up exactly, whatever the gap', () => {
    for (const gap of [GAP, 1n, 2n, 99n, 100n, 101n, 4_419_852n, -47_300n, 0n]) {
      const size = gap < 0n ? -gap : gap;
      expect(stepChunks(gap).reduce((a, b) => a + b, 0n)).toBe(size);
      expect(remainingPaise(gap, FINAL_T)).toBe(0n);
    }
  });

  it('pops a chip as each step starts, the check mark last', () => {
    expect(stepsShown(0)).toBe(0);
    expect(stepsShown(STORY.steps[0].at)).toBe(1);
    expect(stepsShown(STORY.steps[2].at)).toBe(3);
    expect(checkShown(STORY.steps[2].at + STORY.stepMs - 1)).toBe(false);
    expect(checkShown(STORY.checkAt)).toBe(true);
    expect(STORY.checkAt).toBeGreaterThanOrEqual(STORY.steps[2].at + STORY.stepMs);
  });

  it('sends every packet before the first explanation and has them all home before the last', () => {
    for (const p of STORY.packets) {
      expect(packetProgress(p.at - 1, p.at)).toBeNull();
      expect(packetProgress(p.at, p.at)).toBe(0);
      expect(packetProgress(p.at + STORY.packetMs, p.at)).toBe(1);
      expect(p.at + STORY.packetMs).toBeLessThan(STORY.steps[2].at);
    }
  });

  it('draws the ring as the share explained, and the final frame is complete and not fading', () => {
    expect(explainedShare(GAP, 0)).toBe(0);
    expect(explainedShare(GAP, FINAL_T)).toBe(1);
    expect(explainedShare(0n, 0)).toBe(1);
    expect(fading(FINAL_T)).toBe(false);
    expect(fading(STORY.fadeAt)).toBe(true);
    expect(STORY.steps.reduce((n, s) => n + s.weight, 0)).toBe(100);
  });
});
