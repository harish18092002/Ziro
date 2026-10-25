import { describe, expect, it } from 'vitest';
import { Budget, DEFAULT_LIMITS, type Limits } from './budget.js';
import { PRICED_PROMPT_LIMIT } from './pricing.js';
import { MAX_RESULT_CHARS } from './tools/toolbox.js';
import { AGENT_TOOLS } from './tools/definitions.js';
import { systemPrompt } from './prompt.js';
import { toAnthropicJsonSchema } from '../llm/json-schema.js';

const limits: Limits = {
  maxToolCalls: 3,
  maxOutputTokens: 1_000,
  maxTokensPerRequest: 400,
  maxPromptTokensPerRequest: 5_000,
  timeoutMs: 10_000,
};

describe('Budget', () => {
  it('counts tool calls and reports what is left', () => {
    const b = new Budget(limits);
    expect(b.toolCallsLeft).toBe(3);
    b.useToolCall();
    b.useToolCall();
    expect([b.toolCallsUsed, b.toolCallsLeft]).toEqual([2, 1]);
    b.useToolCall();
    b.useToolCall(); // never below zero
    expect(b.toolCallsLeft).toBe(0);
  });

  it('is exhausted by time exactly when the deadline is reached', () => {
    let t = 1_000;
    const b = new Budget(limits, () => t);
    expect(b.exhausted()).toBeNull();
    t += 9_999;
    expect(b.msLeft).toBe(1);
    expect(b.exhausted()).toBeNull();
    t += 1;
    expect(b.msLeft).toBe(0);
    expect(b.exhausted()).toBe('time');
  });

  it('is exhausted by the output total when it is reached, not only when exceeded', () => {
    const b = new Budget(limits);
    b.addUsage(999, 100);
    expect(b.exhausted()).toBeNull();
    b.addUsage(1, 100);
    expect(b.exhausted()).toBe('tokens');
  });

  it('is exhausted by the prompt size only when it is over the limit', () => {
    const b = new Budget(limits);
    b.addUsage(10, 5_000);
    expect(b.exhausted()).toBeNull();
    b.addUsage(10, 5_001);
    expect(b.exhausted()).toBe('context');
  });

  it('judges the prompt by the latest request, not a running total', () => {
    const b = new Budget(limits);
    b.addUsage(10, 4_000);
    b.addUsage(10, 4_500);
    expect(b.exhausted()).toBeNull();
  });

  it('reports time before tokens before context', () => {
    let t = 0;
    const b = new Budget(limits, () => t);
    b.addUsage(2_000, 9_000);
    expect(b.exhausted()).toBe('tokens');
    t = 20_000;
    expect(b.exhausted()).toBe('time');
  });

  it('caps max_tokens at the per-request limit, then at what is left, never below 1', () => {
    const b = new Budget(limits);
    expect(b.nextMaxTokens()).toBe(400);
    b.addUsage(700, 0);
    expect(b.nextMaxTokens()).toBe(300);
    b.addUsage(299, 0);
    expect(b.nextMaxTokens()).toBe(1);
    b.addUsage(500, 0);
    expect(b.nextMaxTokens()).toBe(1);
  });
});

describe('the default limits', () => {
  it('are the ones in the brief: 8 tool calls and 60 seconds', () => {
    expect(DEFAULT_LIMITS.maxToolCalls).toBe(8);
    expect(DEFAULT_LIMITS.timeoutMs).toBe(60_000);
  });

  it('are consistent with each other', () => {
    expect(DEFAULT_LIMITS.maxTokensPerRequest).toBeLessThanOrEqual(DEFAULT_LIMITS.maxOutputTokens);
    expect(DEFAULT_LIMITS.maxPromptTokensPerRequest).toBeLessThan(PRICED_PROMPT_LIMIT);
  });

  // A prompt above 100K tokens is billed at a tier this code cannot price, so a full conversation must
  // not be able to reach it: every output token and every tool result is read again on later requests.
  // UUIDs tokenise at about two characters per token, so characters are divided by two to be safe.
  it('cannot add up to a prompt above the tier the pricing table covers', () => {
    const fixed =
      systemPrompt(DEFAULT_LIMITS).length +
      JSON.stringify(AGENT_TOOLS.map((t) => toAnthropicJsonSchema(t.args))).length +
      20_000;
    const worst =
      DEFAULT_LIMITS.maxOutputTokens +
      Math.ceil((DEFAULT_LIMITS.maxToolCalls * MAX_RESULT_CHARS + fixed) / 2);
    expect(worst).toBeLessThan(PRICED_PROMPT_LIMIT);
  });
});
