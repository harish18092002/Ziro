import { describe, expect, it } from 'vitest';
import type { AgentStatus } from './api';
import { agentBanner, failureSentence, inr, linkTo, parseHash, percent, words } from './format';

const RUN = '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b';
const ITEM = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('inr', () => {
  it.each([
    ['0', '₹0.00'],
    ['5', '₹0.05'],
    ['12345650', '₹1,23,456.50'],
    ['-47300', '-₹473.00'],
  ])('%s paise is %s', (paise, shown) => {
    expect(inr(paise)).toBe(shown);
  });

  it('shows a dash for anything that is not integer paise, never a guess', () => {
    for (const bad of [null, undefined, '', '12.5', 'abc', '1e3']) expect(inr(bad)).toBe('–');
  });
});

describe('parseHash', () => {
  it('is the home page for anything that is not a run', () => {
    for (const hash of ['', '#', '#/', '#/runs', '#/runs/not-a-uuid/summary', '#/other'])
      expect(parseHash(hash)).toEqual({ page: 'home' });
  });

  it('reads a run, its tab and an optional item', () => {
    expect(parseHash(`#/runs/${RUN}`)).toEqual({
      page: 'run',
      runId: RUN,
      tab: 'summary',
      itemId: null,
    });
    expect(parseHash(`#/runs/${RUN}/exceptions/${ITEM}`)).toEqual({
      page: 'run',
      runId: RUN,
      tab: 'exceptions',
      itemId: ITEM,
    });
  });

  it('falls back to the summary for an unknown tab and drops a malformed item id', () => {
    expect(parseHash(`#/runs/${RUN}/nonsense/x`)).toEqual({
      page: 'run',
      runId: RUN,
      tab: 'summary',
      itemId: null,
    });
  });

  it('round-trips through linkTo', () => {
    expect(parseHash(linkTo(RUN, 'audit', ITEM))).toEqual({
      page: 'run',
      runId: RUN,
      tab: 'audit',
      itemId: ITEM,
    });
  });
});

describe('small formatters', () => {
  it('formats shares and reason codes', () => {
    expect(percent(0.9732)).toBe('97.3%');
    expect(percent(null)).toBe('–');
    expect(words('FEE_GST_DEDUCTION')).toBe('fee gst deduction');
  });
});

const status = (paused: AgentStatus['paused']): AgentStatus => ({
  configured: true,
  paused,
  spentTodayUsd: '0.000000',
  dailyBudgetUsd: '5.000000',
});

describe('agentBanner', () => {
  it('is nothing while the agent works, or before the status is known', () => {
    expect(agentBanner(null)).toBeNull();
    expect(agentBanner(status(null))).toBeNull();
  });

  it('says why it is paused, that matching still runs, and that nothing is lost', () => {
    const text = agentBanner(
      status({
        reason: 'daily_budget',
        message: 'the daily LLM budget is spent',
        since: null,
        until: null,
      }),
    );
    expect(text).toContain('The agent is paused: the daily LLM budget is spent.');
    expect(text).toContain('Matching still runs');
    expect(text).toContain('nothing is lost');
    expect(text).not.toContain('try again');
  });

  it('says when it will try again, in UTC, when the pause has an end', () => {
    const text = agentBanner(
      status({
        reason: 'model_unavailable',
        message: 'the model API has not been answering, so the agent is paused',
        since: '2026-10-23T10:00:00.000Z',
        until: '2026-10-23T10:15:00.000Z',
      }),
    );
    expect(text).toContain('It will try again after 10:15 UTC.');
  });
});

describe('failureSentence', () => {
  const failures = (byReason: { reason: string; label: string; count: number }[]) => ({
    handedToAPerson: byReason.reduce((n, r) => n + r.count, 0),
    byReason,
    injected: null,
    note: null,
  });

  it('is nothing when nothing went wrong', () => {
    expect(failureSentence(failures([]))).toBeNull();
  });

  it('counts and names each reason, singular and plural', () => {
    expect(
      failureSentence(
        failures([{ reason: 'refused', label: 'the model declined to answer', count: 1 }]),
      ),
    ).toBe(
      '1 investigation was handed to a person without a conclusion (1 × the model declined to answer).',
    );
    expect(
      failureSentence(
        failures([
          { reason: 'model_unavailable', label: 'the model API did not answer', count: 1 },
          { reason: 'invalid_reply', label: 'the model’s reply was not valid', count: 3 },
        ]),
      ),
    ).toBe(
      '4 investigations were handed to a person without a conclusion (1 × the model API did not answer, 3 × the model’s reply was not valid).',
    );
  });
});
