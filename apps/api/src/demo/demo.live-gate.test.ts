// Whether the public demo offers a LIVE run is decided by what the free tier has left today, not only by
// money: it costs nothing and still runs out. These drive DemoService.liveStatus with a stand-in agent.
import { describe, expect, it } from 'vitest';
import type { AgentService, AgentStatus } from '../agent/agent.service.js';
import type { Env } from '../config/env.js';
import type { SlotStatus as ModelStatus } from '../llm/router.js';
import { DemoService } from './demo.service.js';

const model = (over: Partial<ModelStatus> = {}): ModelStatus => ({
  id: 'gemini:lite',
  provider: 'gemini',
  model: 'lite',
  state: 'ok',
  until: null,
  why: null,
  usedToday: 0,
  limitPerDay: 100,
  ...over,
});

function service(models: ModelStatus[], over: Partial<Env> = {}, configured = true): DemoService {
  const agent = {
    configured,
    spentToday: () => Promise.resolve(0n),
    status: () => Promise.resolve({ models } as unknown as AgentStatus),
  } as unknown as AgentService;
  const env = { AGENT_KILL_SWITCH: false, DAILY_LLM_BUDGET_USD: 5, ...over } as unknown as Env;
  return new DemoService({} as never, env, {} as never, {} as never, {} as never, agent);
}

describe('liveStatus', () => {
  it('is offered when a model is working and the day has plenty of requests left', async () => {
    expect(await service([model({ usedToday: 10 })]).liveStatus()).toEqual({
      available: true,
      reason: null,
    });
  });

  it('is offered when no limit is known: the server’s own answers are the only guard', async () => {
    const s = service([model({ limitPerDay: null, usedToday: 9_999 })]);
    expect((await s.liveStatus()).available).toBe(true);
  });

  it('is withheld when the free-tier day has too few requests left for a run, saying how many', async () => {
    const live = await service([model({ limitPerDay: 100, usedToday: 90 })]).liveStatus();
    expect(live.available).toBe(false);
    expect(live.reason).toContain('only 10 free-tier requests are left today');
    expect(live.reason).toContain('about 20');
  });

  it('is offered if ANOTHER usable model still has the requests', async () => {
    const s = service([
      model({ limitPerDay: 100, usedToday: 100 }),
      model({ id: 'gemini:flash', model: 'flash', limitPerDay: 50, usedToday: 0 }),
    ]);
    expect((await s.liveStatus()).available).toBe(true);
  });

  it('is withheld with "AI quota exhausted" when no model can answer at all', async () => {
    const live = await service([
      model({ state: 'quota_exhausted', until: '2026-10-26T07:00:00.000Z' }),
      model({ id: 'anthropic:c', provider: 'anthropic', model: 'c', state: 'disabled' }),
    ]).liveStatus();
    expect(live).toEqual({
      available: false,
      reason: 'AI quota exhausted: no model can answer until it resets',
    });
  });

  it('is withheld, with the reason, when no model is configured', async () => {
    const live = await service([], {}, false).liveStatus();
    expect(live.available).toBe(false);
    expect(live.reason).toContain('GEMINI_API_KEY');
  });

  it('is withheld by the kill switch and by a spent money budget, as before', async () => {
    expect((await service([model()], { AGENT_KILL_SWITCH: true }).liveStatus()).reason).toBe(
      'the kill switch is on',
    );
    const spent = {
      configured: true,
      spentToday: () => Promise.resolve(9_000_000n),
      status: () => Promise.resolve({ models: [model()] } as unknown as AgentStatus),
    } as unknown as AgentService;
    const env = { AGENT_KILL_SWITCH: false, DAILY_LLM_BUDGET_USD: 5 } as unknown as Env;
    const s = new DemoService({} as never, env, {} as never, {} as never, {} as never, spent);
    expect((await s.liveStatus()).reason).toBe('the daily model budget is spent');
  });
});
