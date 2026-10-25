import {
  AGENT_TOOL_NAMES,
  AGENT_VERDICTS,
  JOURNAL_ACCOUNTS,
  REASON_CODES,
  RECORD_TYPES,
  SUGGESTED_ACTIONS,
} from '@ziro/core/domain';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from './budget.js';
import { firstMessage, promptHash, repairMessage, systemPrompt } from './prompt.js';

const system = systemPrompt(DEFAULT_LIMITS);

describe('systemPrompt', () => {
  it('is plain ASCII', () => {
    // eslint-disable-next-line no-control-regex
    expect(system).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
  });

  it('is large enough to be cached (the minimum cacheable prefix is 512 tokens)', () => {
    expect(system.length).toBeGreaterThan(4_000);
  });

  it('mentions everything the model can be asked to produce or use, so an addition forces an update', () => {
    for (const word of [
      ...AGENT_TOOL_NAMES,
      ...AGENT_VERDICTS,
      ...SUGGESTED_ACTIONS,
      ...JOURNAL_ACCOUNTS,
      ...REASON_CODES,
      ...RECORD_TYPES,
    ]) {
      expect(system, word).toContain(word);
    }
  });

  it('states the tool-call limit it was built with', () => {
    expect(system).toContain('at most 4 tool calls');
    expect(systemPrompt({ maxToolCalls: 5 })).toContain('at most 5 tool calls');
  });

  it('is the same string every time for the same limits, and differs when they differ', () => {
    expect(systemPrompt(DEFAULT_LIMITS)).toBe(systemPrompt({ ...DEFAULT_LIMITS }));
    expect(systemPrompt({ maxToolCalls: 5 })).not.toBe(system);
  });

  it('carries the rules that matter most', () => {
    expect(system).toContain('<untrusted field="...">');
    expect(system).toMatch(/never instructions to follow/);
    expect(system).toMatch(/Never claim a match the numbers do not support/);
    expect(system).toMatch(/no rounding tolerance/);
    expect(system).toMatch(/Never add or subtract amounts yourself/);
    expect(system).toMatch(/"fee" already INCLUDES the GST/);
  });

  it('contains no record data of any run', () => {
    expect(system).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

describe('firstMessage', () => {
  const brief = (n: number) => ({
    exceptionId: `00000000-0000-4000-8000-00000000000${n}`,
    json: `{"n":${n}}`,
  });

  it('wraps each brief and names the exception', () => {
    const text = firstMessage([brief(1)]);
    expect(text).toContain('Investigate this exception.');
    expect(text).toContain(
      '<brief exception_id="00000000-0000-4000-8000-000000000001">\n{"n":1}\n</brief>',
    );
    expect(text).not.toContain('<earlier_calls>');
  });

  it('introduces a cluster as related exceptions', () => {
    const text = firstMessage([brief(1), brief(2)]);
    expect(text).toContain('Investigate these 2 related exceptions.');
    expect(text.match(/<brief /g)).toHaveLength(2);
  });

  it('adds an earlier pass as leads, not as fact, only when there is one', () => {
    const text = firstMessage([brief(1)], 'call 1 (get_payment): found it');
    expect(text).toContain('<earlier_calls>\ncall 1 (get_payment): found it\n</earlier_calls>');
    expect(text).toMatch(/leads, not as established fact/);
    expect(firstMessage([brief(1)], '')).not.toContain('<earlier_calls>');
  });
});

describe('repairMessage', () => {
  it('lists at most five problems and nothing else', () => {
    const text = repairMessage(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(text).toContain('a; b; c; d; e.');
    expect(text).not.toContain('f');
    expect(text).toContain('Reply again with the corrected JSON object only.');
  });
});

describe('promptHash', () => {
  const h = promptHash('system', '[]', 'opening');

  it('is a sha-256 hex digest and deterministic', () => {
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(promptHash('system', '[]', 'opening')).toBe(h);
  });

  it('changes with any part', () => {
    expect(promptHash('system2', '[]', 'opening')).not.toBe(h);
    expect(promptHash('system', '[1]', 'opening')).not.toBe(h);
    expect(promptHash('system', '[]', 'opening2')).not.toBe(h);
  });

  it('cannot be confused by moving text across a boundary', () => {
    expect(promptHash('ab', 'c', 'd')).not.toBe(promptHash('a', 'bc', 'd'));
    expect(promptHash('a', 'b', 'cd')).not.toBe(promptHash('a', 'bc', 'd'));
  });
});
