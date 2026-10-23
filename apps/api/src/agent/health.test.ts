import { describe, expect, it } from 'vitest';
import { AgentHealth, DEFAULT_BREAKER_THRESHOLD, DEFAULT_COOLDOWN_MS } from './health.js';
import { AgentHalted, HALT_MESSAGE } from './types.js';

function clocked(options: { threshold?: number; cooldownMs?: number } = {}) {
  let t = Date.parse('2026-10-23T10:00:00Z');
  const health = new AgentHealth({ ...options, now: () => t });
  return {
    health,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('AgentHealth', () => {
  it('is running until something pauses it', () => {
    const { health } = clocked();
    expect(health.state()).toBeNull();
    expect(() => health.assertRunning()).not.toThrow();
  });

  it('reports a pause with its reason, its words and when it began and ends', () => {
    const { health } = clocked({ cooldownMs: 60_000 });
    health.pause('model_auth');
    expect(health.state()).toEqual({
      reason: 'model_auth',
      message: HALT_MESSAGE.model_auth,
      since: '2026-10-23T10:00:00.000Z',
      until: '2026-10-23T10:01:00.000Z',
    });
  });

  it('throws the matching halt while paused', () => {
    const { health } = clocked();
    health.pause('provider_limit');
    expect(() => health.assertRunning()).toThrow(AgentHalted);
    try {
      health.assertRunning();
    } catch (error) {
      expect((error as AgentHalted).reason).toBe('provider_limit');
    }
  });

  it('lets one probe through once the cooldown has run, and re-pauses at once if it fails', () => {
    const { health, advance } = clocked({ cooldownMs: 60_000, threshold: 3 });
    health.pause('model_unavailable');
    advance(59_999);
    expect(health.state()).not.toBeNull();
    advance(1);
    expect(health.state()).toBeNull();
    // The probe fails: one unavailable outcome is enough, not three more.
    expect(health.recordUnavailable()).toBe(true);
    expect(health.state()?.reason).toBe('model_unavailable');
  });

  it('keeps running after a probe that was answered', () => {
    const { health, advance } = clocked({ cooldownMs: 60_000, threshold: 3 });
    health.pause('model_unavailable');
    advance(60_000);
    expect(health.state()).toBeNull();
    health.recordAnswered();
    expect(health.recordUnavailable()).toBe(false);
    expect(health.state()).toBeNull();
  });

  it('trips the breaker after the threshold of consecutive unavailable outcomes', () => {
    const { health } = clocked({ threshold: 3 });
    expect(health.recordUnavailable()).toBe(false);
    expect(health.recordUnavailable()).toBe(false);
    expect(health.state()).toBeNull();
    expect(health.recordUnavailable()).toBe(true);
    expect(health.state()?.reason).toBe('model_unavailable');
  });

  it('counts only consecutive ones: an answer resets the run', () => {
    const { health } = clocked({ threshold: 3 });
    health.recordUnavailable();
    health.recordUnavailable();
    health.recordAnswered();
    health.recordUnavailable();
    health.recordUnavailable();
    expect(health.state()).toBeNull();
    expect(health.recordUnavailable()).toBe(true);
  });

  it('is resumed by an operator, and the count starts again', () => {
    const { health } = clocked({ threshold: 2 });
    health.recordUnavailable();
    health.recordUnavailable();
    expect(health.state()).not.toBeNull();
    health.resume();
    expect(health.state()).toBeNull();
    expect(health.recordUnavailable()).toBe(false);
  });

  it('uses five failures and fifteen minutes unless told otherwise', () => {
    expect(DEFAULT_BREAKER_THRESHOLD).toBe(5);
    expect(DEFAULT_COOLDOWN_MS).toBe(15 * 60_000);
    const { health } = clocked();
    for (let i = 0; i < 4; i += 1) expect(health.recordUnavailable()).toBe(false);
    expect(health.recordUnavailable()).toBe(true);
    expect(health.state()?.until).toBe('2026-10-23T10:15:00.000Z');
  });
});
