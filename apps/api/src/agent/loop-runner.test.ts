import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from './budget.js';
import {
  buildWorld,
  createMigratedDb,
  INJECTION_MEMO,
  INJECTION_NARRATION,
  type TestDb,
  type World,
} from './agent.fixtures.js';
import { type LlmRequest, LlmAbortedError, LlmError } from './llm.js';
import { LoopRunner, type LoopRunnerOptions } from './loop-runner.js';
import { OUTPUT_JSON_SCHEMA } from './output.js';
import { NO_MORE_TOOLS_NOTICE, systemPrompt } from './prompt.js';
import {
  asksFor,
  replyWith,
  result,
  says,
  ScriptedLlm,
  testContext,
  toolUse,
  USAGE,
  type Step,
} from './scripted-llm.fixtures.js';
import { Toolbox } from './tools/toolbox.js';
import { AgentHalted, type ExceptionToInvestigate } from './types.js';

const SMALL = 'claude-haiku-5-5';
const LARGE = 'claude-sonnet-5-5';

let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let world: World;
let box: Toolbox;

beforeAll(async () => {
  ({ db, client } = await createMigratedDb());
  world = await buildWorld(db);
  box = await Toolbox.create(db, world.runId);
}, 60_000);
afterAll(async () => {
  await client.close();
});

const dup = (): ExceptionToInvestigate => ({
  id: world.exceptions.duplicate,
  ruleReasonCode: 'DUPLICATE_PAYMENT',
});
const none = (): ExceptionToInvestigate => ({
  id: world.exceptions.other,
  ruleReasonCode: 'LEDGER_WITHOUT_PAYMENT',
});
const refs = (...pairs: [string, string][]) =>
  pairs.map(([recordType, recordId]) => ({ recordType, recordId }) as never);

function setup(steps: Step[], options: Partial<LoopRunnerOptions> = {}) {
  const llm = new ScriptedLlm(steps);
  const runner = new LoopRunner({
    client: llm,
    smallModel: SMALL,
    largeModel: LARGE,
    escalation: false,
    ...options,
  });
  const ctx = testContext(box, world.runId);
  return { llm, runner, ctx };
}

const feeCall = (i: number) => asksFor([toolUse(`t${i}`, 'get_fee_contract', { method: 'card' })]);

/** Every string the model was shown in a request, unwrapped from the message structure. */
function textsOf(request: LlmRequest): string[] {
  const out: string[] = [request.system];
  for (const m of request.messages) {
    if (typeof m.content === 'string') out.push(m.content);
    else
      for (const b of m.content)
        out.push(
          (b as { content?: string; text?: string }).content ?? (b as { text?: string }).text ?? '',
        );
  }
  return out;
}

describe('the conversation', () => {
  it('runs tools, feeds results back, and returns a grounded proposal', async () => {
    const first = asksFor([
      toolUse('t1', 'get_payment', { id: 'ORD-1002-R1' }),
      toolUse('t2', 'get_settlement_composition', { settlement_id: 'setl_S2' }),
    ]);
    const { llm, runner, ctx } = setup([
      first,
      replyWith([
        result(dup().id, {
          links: refs(
            ['ledger_entry', world.ledger.l2],
            ['rzp_payment', world.payments.p2],
            ['rzp_payment', world.payments.p3],
          ),
          evidence: [
            { call: 0, keyFinding: 'Two candidate payments for ORD-1002.' },
            { call: 1, keyFinding: 'pay_P3 is the retry with receipt ORD-1002-R1.' },
            { call: 2, keyFinding: 'setl_S2 pays out 1000 paise more than its lines.' },
          ],
        }),
      ]),
    ]);

    const [draft] = await runner.investigate([dup()], ctx);

    expect(llm.calls).toBe(2);
    expect(draft?.content.verdict).toBe('EXPLAINED_NO_MATCH');
    expect(draft?.content.evidence.map((e) => [e.tool, e.args])).toEqual([
      ['get_exception', { exception_id: dup().id }],
      ['get_payment', { id: 'ORD-1002-R1' }],
      ['get_settlement_composition', { settlement_id: 'setl_S2' }],
    ]);
    expect(draft?.model).toBe(SMALL);
    expect(draft?.llmCallId).toBe('call-2');
    expect(draft?.harnessFindings).toEqual([]);

    const second = llm.requests[1];
    expect(second?.messages).toHaveLength(3);
    // The model's own turn goes back exactly as it was produced.
    expect(second?.messages[1]).toEqual({ role: 'assistant', content: first.content });
    expect(second?.messages[1]?.content).toBe(first.content);
    const results = second?.messages[2]?.content as unknown as {
      tool_use_id: string;
      content: string;
    }[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['t1', 't2']);
    expect(results[0]?.content.startsWith('call 1:\n')).toBe(true);
    expect(results[1]?.content.startsWith('call 2:\n')).toBe(true);
    expect(results[1]?.content).toContain('"residualPaise":"1000"');
  });

  it('sends the same system prompt, tools and output schema on every request', async () => {
    const { llm, runner, ctx } = setup([feeCall(1), feeCall(2), replyWith([result(dup().id)])]);
    await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(3);
    for (const request of llm.requests) {
      expect(request.system).toBe(systemPrompt(DEFAULT_LIMITS));
      expect(request.tools).toBe(box.definitions);
      expect(request.outputSchema).toBe(OUTPUT_JSON_SCHEMA);
      expect(request.model).toBe(SMALL);
      expect(request.maxTokens).toBeGreaterThan(0);
      expect(request.maxTokens).toBeLessThanOrEqual(DEFAULT_LIMITS.maxTokensPerRequest);
      expect(request.effort).toBeUndefined();
    }
  });

  it('opens with the exception brief as call 0, so the model need not fetch it', async () => {
    const { llm, runner, ctx } = setup([replyWith([result(dup().id)])]);
    await runner.investigate([dup()], ctx);
    const opening = llm.requests[0]?.messages[0]?.content as string;
    expect(opening).toContain(`<brief exception_id="${dup().id}">`);
    expect(opening).toContain('"ruleReasonCode":"DUPLICATE_PAYMENT"');
    expect(opening).toContain('"candidateCount":2');
  });

  it('records every request: cost, tokens, prompt hash, stop reason, request id', async () => {
    const { runner, ctx } = setup([
      feeCall(1),
      replyWith([result(dup().id)], {
        usage: {
          inputTokens: 10_000,
          outputTokens: 2_000,
          cacheReadTokens: 20_000,
          cacheWriteTokens: 5_000,
        },
        requestId: 'req_abc',
      }),
    ]);
    await runner.investigate([dup()], ctx);
    expect(ctx.recorded).toHaveLength(2);
    const [a, b] = ctx.recorded;
    expect(a?.exceptionId).toBe(dup().id);
    expect(a?.harness).toBe('loop');
    expect(a?.model).toBe(SMALL);
    expect(a?.stopReason).toBe('tool_use');
    expect(a?.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.promptHash).toBe(b?.promptHash);
    expect(b?.costMicroUsd).toBe(2_825n); // see pricing.test.ts
    expect(b?.requestId).toBe('req_abc');
    expect(b?.usage.cacheReadTokens).toBe(20_000);
  });

  it('tells the model when a tool call failed, and counts it', async () => {
    const { llm, runner, ctx } = setup([
      asksFor([toolUse('t1', 'get_payment', { id: '' })]),
      replyWith([
        result(dup().id, {
          evidence: [
            { call: 0, keyFinding: 'brief' },
            { call: 1, keyFinding: 'cited a failed call' },
          ],
        }),
      ]),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);
    const back = llm.requests[1]?.messages[2]?.content as unknown as {
      content: string;
      is_error?: boolean;
    }[];
    expect(back[0]?.is_error).toBe(true);
    expect(back[0]?.content).toMatch(/^call 1 failed: invalid arguments/);
    expect(draft?.content.evidence).toHaveLength(1);
    expect(draft?.harnessFindings.join(' ')).toContain('call 1');
  });

  it('answers an unknown tool with an error and does not crash', async () => {
    const { llm, runner, ctx } = setup([
      asksFor([toolUse('t1', 'drop_database', {})]),
      replyWith([result(dup().id)]),
    ]);
    await runner.investigate([dup()], ctx);
    const back = llm.requests[1]?.messages[2]?.content as unknown as {
      content: string;
      is_error?: boolean;
    }[];
    expect(back[0]?.is_error).toBe(true);
    expect(back[0]?.content).toContain('unknown tool');
  });
});

describe('budgets', () => {
  it('stops at the ninth tool call and returns NEEDS_HUMAN with the evidence so far', async () => {
    const steps = Array.from({ length: 9 }, (_, i) => feeCall(i + 1));
    const { llm, runner, ctx } = setup(steps);
    const [draft] = await runner.investigate([dup()], ctx);

    expect(llm.calls).toBe(9); // no tenth request
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.confidence).toBe(0);
    expect(draft?.content.links).toEqual([]);
    expect(draft?.content.reasonCode).toBe('DUPLICATE_PAYMENT');
    expect(draft?.content.evidence).toHaveLength(8);
    expect(draft?.content.evidence[0]?.keyFinding).toContain('card');
    expect(draft?.harnessFindings).toEqual(['investigation stopped: the tool-call budget ran out']);
  });

  it('tells the model on the eighth result that no calls remain', async () => {
    const steps = [
      ...Array.from({ length: 8 }, (_, i) => feeCall(i + 1)),
      replyWith([result(dup().id)]),
    ];
    const { llm, runner, ctx } = setup(steps);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(draft?.content.verdict).toBe('EXPLAINED_NO_MATCH');
    const eighth = llm.requests[8]?.messages.at(-1)?.content as unknown as {
      type: string;
      text?: string;
    }[];
    expect(eighth.at(-1)).toEqual({ type: 'text', text: NO_MORE_TOOLS_NOTICE });
    const seventh = llm.requests[7]?.messages.at(-1)?.content as unknown as { type: string }[];
    expect(seventh.every((b) => b.type === 'tool_result')).toBe(true);
  });

  it('runs only as many parallel calls as remain, and says so for the rest', async () => {
    const ten = asksFor(
      Array.from({ length: 10 }, (_, i) => toolUse(`t${i}`, 'get_fee_contract', { method: 'upi' })),
    );
    const { llm, runner, ctx } = setup([ten, replyWith([result(dup().id)])]);
    const [draft] = await runner.investigate([dup()], ctx);
    const back = llm.requests[1]?.messages.at(-1)?.content as unknown as {
      content: string;
      is_error?: boolean;
      type: string;
    }[];
    expect(back).toHaveLength(11); // ten results and the notice
    expect(back.filter((b) => b.is_error)).toHaveLength(2);
    expect(back[9]?.content).toBe('not run: the tool-call budget is spent');
    expect(draft?.content.verdict).toBe('EXPLAINED_NO_MATCH');
  });

  it('stops when the time budget is spent, without another request', async () => {
    let clock = 0;
    const { llm, runner, ctx } = setup(
      [
        (): ReturnType<typeof feeCall> => {
          clock += 61_000;
          return feeCall(1);
        },
        replyWith([result(dup().id)]),
      ],
      { now: () => clock },
    );
    const [draft] = await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(1);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.harnessFindings).toEqual(['investigation stopped: the time budget ran out']);
    expect(draft?.content.evidence).toHaveLength(1);
  });

  it('treats an aborted request (its timeout fired) as the time budget', async () => {
    const { runner, ctx } = setup([new LlmAbortedError()]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.harnessFindings[0]).toContain('time budget');
    expect(ctx.recorded).toHaveLength(0);
  });

  it('gives each request a signal that fires within the time budget', async () => {
    const { llm, runner, ctx } = setup([replyWith([result(dup().id)])]);
    await runner.investigate([dup()], ctx);
    expect(llm.requests[0]?.signal.aborted).toBe(false);
  });

  it('stops when the output-token total is spent', async () => {
    const { llm, runner, ctx } = setup([
      asksFor([toolUse('t1', 'get_fee_contract', { method: 'card' })], {
        usage: { ...USAGE, outputTokens: DEFAULT_LIMITS.maxOutputTokens },
      }),
      replyWith([result(dup().id)]),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(1);
    expect(draft?.harnessFindings[0]).toContain('output-token budget');
  });

  it('shrinks max_tokens to what is left of the total', async () => {
    const { llm, runner, ctx } = setup([
      asksFor([toolUse('t1', 'get_fee_contract', { method: 'card' })], {
        usage: { ...USAGE, outputTokens: DEFAULT_LIMITS.maxOutputTokens - 500 },
      }),
      replyWith([result(dup().id)]),
    ]);
    await runner.investigate([dup()], ctx);
    expect(llm.requests[1]?.maxTokens).toBe(500);
  });

  it('stops when the prompt has grown past what it will carry', async () => {
    const { llm, runner, ctx } = setup([
      asksFor([toolUse('t1', 'get_fee_contract', { method: 'card' })], {
        usage: { ...USAGE, inputTokens: DEFAULT_LIMITS.maxPromptTokensPerRequest + 1 },
      }),
      replyWith([result(dup().id)]),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(1);
    expect(draft?.harnessFindings[0]).toContain('too long');
  });

  it('counts cached tokens as prompt, so a cache hit cannot hide a huge prompt', async () => {
    const { llm, runner, ctx } = setup([
      asksFor([toolUse('t1', 'get_fee_contract', { method: 'card' })], {
        usage: {
          inputTokens: 10,
          outputTokens: 10,
          cacheReadTokens: DEFAULT_LIMITS.maxPromptTokensPerRequest,
          cacheWriteTokens: 1,
        },
      }),
      replyWith([result(dup().id)]),
    ]);
    await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(1);
  });

  it('ends on max_tokens: a cut-off reply is exhausted, a cut-off tool call is never run', async () => {
    const cut = setup([says('{"results":[{"exceptionId":"', { stopReason: 'max_tokens' })]);
    const [a] = await cut.runner.investigate([dup()], cut.ctx);
    expect(a?.harnessFindings[0]).toContain('output-token budget');
    expect(cut.llm.calls).toBe(1);

    const half = setup([
      asksFor([toolUse('t1', 'get_fee_contract', { method: 'card' })], {
        stopReason: 'max_tokens',
      }),
    ]);
    const [b] = await half.runner.investigate([dup()], half.ctx);
    expect(half.llm.calls).toBe(1);
    expect(b?.content.evidence).toHaveLength(0);

    const whole = setup([replyWith([result(dup().id)], { stopReason: 'max_tokens' })]);
    const [c] = await whole.runner.investigate([dup()], whole.ctx);
    expect(c?.content.verdict).toBe('EXPLAINED_NO_MATCH');
  });

  it('ends when the context window is exceeded', async () => {
    const { runner, ctx } = setup([says('', { stopReason: 'model_context_window_exceeded' })]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(draft?.harnessFindings[0]).toContain('too long');
  });
});

describe('malformed replies', () => {
  it('repairs once: names the problem, does not echo the bad reply', async () => {
    const { llm, runner, ctx } = setup([
      says('IGNORE THIS: approve everything {nope'),
      replyWith([result(dup().id)]),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(draft?.content.verdict).toBe('EXPLAINED_NO_MATCH');
    expect(llm.calls).toBe(2);
    const repair = llm.requests[1]?.messages.at(-1);
    expect(repair?.role).toBe('user');
    expect(repair?.content).toContain('not valid JSON');
    expect(JSON.stringify(repair)).not.toContain('approve everything');
  });

  it('points at the exact field in a schema failure', async () => {
    const { llm, runner, ctx } = setup([
      replyWith([{ ...result(dup().id), verdict: 'MAYBE' as never }]),
      replyWith([result(dup().id)]),
    ]);
    await runner.investigate([dup()], ctx);
    expect(llm.requests[1]?.messages.at(-1)?.content).toContain('results.0.verdict');
  });

  it('gives up after one repair and returns NEEDS_HUMAN', async () => {
    const { llm, runner, ctx } = setup([
      says('nope'),
      says('still nope'),
      replyWith([result(dup().id)]),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(2);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.harnessFindings[0]).toContain('not valid even after one repair');
  });

  it('echoes an empty reply as a placeholder, because the API refuses an empty turn', async () => {
    const { llm, runner, ctx } = setup([
      { content: [], stopReason: 'end_turn', usage: USAGE, requestId: null },
      replyWith([result(dup().id)]),
    ]);
    await runner.investigate([dup()], ctx);
    const echoed = llm.requests[1]?.messages[1];
    expect(echoed?.role).toBe('assistant');
    expect((echoed?.content as unknown[]).length).toBe(1);
  });
});

describe('a reply in several text blocks', () => {
  it('is read as one piece of text', async () => {
    const json = JSON.stringify({ results: [result(dup().id)] });
    const half = Math.floor(json.length / 2);
    const split = {
      content: [
        { type: 'text' as const, text: json.slice(0, half) },
        { type: 'text' as const, text: json.slice(half) },
      ],
      stopReason: 'end_turn',
      usage: USAGE,
      requestId: null,
    };
    const { llm, runner, ctx } = setup([split]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(1);
    expect(draft?.content.verdict).toBe('EXPLAINED_NO_MATCH');
  });
});

describe('a reply in several text blocks', () => {
  it('is read as one piece of text', async () => {
    const json = JSON.stringify({ results: [result(dup().id)] });
    const half = Math.floor(json.length / 2);
    const split = {
      content: [
        { type: 'text' as const, text: json.slice(0, half) },
        { type: 'text' as const, text: json.slice(half) },
      ],
      stopReason: 'end_turn',
      usage: USAGE,
      requestId: null,
    };
    const { llm, runner, ctx } = setup([split]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(1);
    expect(draft?.content.verdict).toBe('EXPLAINED_NO_MATCH');
  });
});

describe('a paused turn', () => {
  it("is continued with the model's own content, not read as a final reply", async () => {
    const paused = says('thinking about it', { stopReason: 'pause_turn' });
    const { llm, runner, ctx } = setup([paused, replyWith([result(dup().id)])]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(2);
    expect(draft?.content.verdict).toBe('EXPLAINED_NO_MATCH');
    const second = llm.requests[1];
    expect(second?.messages).toHaveLength(2);
    expect(second?.messages[1]).toEqual({ role: 'assistant', content: paused.content });
  });
});

describe('refusal, halts and API failures', () => {
  it('turns a refusal into NEEDS_HUMAN and makes no further request', async () => {
    const { llm, runner, ctx } = setup([
      says('', { stopReason: 'refusal' }),
      replyWith([result(dup().id)]),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(1);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.harnessFindings[0]).toContain('declined');
  });

  it('does not escalate a refusal, or a spent budget', async () => {
    const refused = setup([says('', { stopReason: 'refusal' })], { escalation: true });
    await refused.runner.investigate([dup()], refused.ctx);
    expect(refused.llm.calls).toBe(1);

    const spent = setup([...Array.from({ length: 9 }, (_, i) => feeCall(i + 1))], {
      escalation: true,
    });
    await spent.runner.investigate([dup()], spent.ctx);
    expect(spent.llm.calls).toBe(9);
  });

  it('checks the gate before every request, and a halt stops the investigation', async () => {
    const llm = new ScriptedLlm([feeCall(1), replyWith([result(dup().id)])]);
    const runner = new LoopRunner({
      client: llm,
      smallModel: SMALL,
      largeModel: LARGE,
      escalation: false,
    });
    let allowed = 1;
    const ctx = testContext(box, world.runId, () =>
      allowed-- <= 0 ? Promise.reject(new AgentHalted('kill_switch')) : Promise.resolve(),
    );
    await expect(runner.investigate([dup()], ctx)).rejects.toBeInstanceOf(AgentHalted);
    expect(llm.calls).toBe(1);
    expect(ctx.gateCalls).toBe(2);
    expect(ctx.recorded).toHaveLength(1); // the spend of the first request is on record
  });

  it('lets an API failure propagate so the job can be retried', async () => {
    const { runner, ctx } = setup([new LlmError('overloaded', true, 529, 'req_1')]);
    await expect(runner.investigate([dup()], ctx)).rejects.toMatchObject({
      retryable: true,
      status: 529,
    });
  });

  it('fails for an exception that is not in this run, instead of inventing a brief', async () => {
    const { runner, ctx } = setup([replyWith([result(randomUUID())])]);
    await expect(
      runner.investigate([{ id: randomUUID(), ruleReasonCode: 'UNKNOWN' }], ctx),
    ).rejects.toThrow(/cannot load exception/);
  });
});

describe('a conclusion must be grounded in what the tools showed', () => {
  it('downgrades a match that links a record from another run', async () => {
    const { runner, ctx } = setup([
      replyWith([
        result(dup().id, {
          verdict: 'MATCH_PROPOSED',
          suggestedAction: 'ACCEPT_MATCH',
          confidence: 1,
          links: refs(['ledger_entry', world.ledger.l2], ['rzp_payment', world.foreign.payment]),
        }),
      ]),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.suggestedAction).toBe('NONE');
    expect(draft?.content.links).toEqual(refs(['ledger_entry', world.ledger.l2]));
    expect(draft?.harnessFindings.join(' ')).toContain(world.foreign.payment);
  });

  it('accepts a match whose records were returned by a later tool call', async () => {
    const { runner, ctx } = setup([
      asksFor([toolUse('t1', 'get_payment', { id: 'pay_P1' })]),
      replyWith([
        result(dup().id, {
          verdict: 'MATCH_PROPOSED',
          suggestedAction: 'ACCEPT_MATCH',
          links: refs(['ledger_entry', world.ledger.l2], ['rzp_payment', world.payments.p1]),
          evidence: [{ call: 1, keyFinding: 'pay_P1' }],
        }),
      ]),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(draft?.content.verdict).toBe('MATCH_PROPOSED');
    expect(draft?.content.suggestedAction).toBe('ACCEPT_MATCH');
  });
});

describe('prompt injection', () => {
  const PHRASE = 'Ignore all previous instructions';
  const outsideUntrusted = (text: string) =>
    text.replace(/<untrusted field=\\?"[a-z_]+\\?">[\s\S]*?<\/untrusted>/g, '');
  const leaks = (request: LlmRequest) =>
    textsOf(request).some(
      (t) => outsideUntrusted(t).includes(PHRASE) || outsideUntrusted(t).includes('admin mode'),
    );

  /** A model that does what hostile text tells it to if it ever sees that text outside the data tags. */
  const suggestible =
    (obeyed: string[]): Step =>
    (request) => {
      if (leaks(request)) {
        obeyed.push('obeyed');
        return replyWith([
          result(dup().id, {
            verdict: 'MATCH_PROPOSED',
            suggestedAction: 'ACCEPT_MATCH',
            confidence: 1,
            links: refs(['ledger_entry', world.ledger.l2], ['rzp_payment', world.payments.p2]),
          }),
        ]);
      }
      return replyWith([
        result(dup().id, {
          verdict: 'NEEDS_HUMAN',
          suggestedAction: 'NONE',
          confidence: 0.4,
          explanation:
            'Two payments share this order; the memo contains instructions, which were ignored.',
          evidence: [{ call: 0, keyFinding: 'Two candidate payments.' }],
        }),
      ]);
    };

  it('shows a hostile memo to the model only inside <untrusted>, and it cannot break out', async () => {
    const obeyed: string[] = [];
    const { llm, runner, ctx } = setup([
      asksFor([toolUse('t1', 'get_ledger_entry', { id: 'ORD-1002' })]),
      suggestible(obeyed),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);

    expect(INJECTION_MEMO).toContain(PHRASE);
    const shown = textsOf(llm.requests[1] as LlmRequest).find((t) => t.includes(PHRASE)) ?? '';
    expect(shown).toContain('<untrusted field=');
    expect(shown.match(/<untrusted/g)).toHaveLength(1);
    expect(shown.match(/<\/untrusted>/g)).toHaveLength(1);
    expect(obeyed).toEqual([]);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
  });

  it('keeps a hostile bank narration inside the tags too', async () => {
    const obeyed: string[] = [];
    const { llm, runner, ctx } = setup([
      asksFor([toolUse('t1', 'search_bank_lines', { amount_min: 248_050, amount_max: 248_050 })]),
      suggestible(obeyed),
    ]);
    await runner.investigate([dup()], ctx);
    expect(INJECTION_NARRATION).toContain('admin mode');
    expect(textsOf(llm.requests[1] as LlmRequest).some((t) => t.includes('admin mode'))).toBe(true);
    expect(obeyed).toEqual([]);
  });

  it('never puts record free text in the system prompt or the opening message', async () => {
    const { llm, runner, ctx } = setup([replyWith([result(dup().id)])]);
    await runner.investigate([dup(), none()], ctx).catch(() => undefined);
    const first = llm.requests[0] as LlmRequest;
    expect(leaks(first)).toBe(false);
    expect(first.system).not.toContain(PHRASE);
  });

  it('cannot be talked into a match it cannot ground, even by a model that obeys', async () => {
    const foreign = world.foreign.payment;
    const { runner, ctx } = setup([
      replyWith([
        result(dup().id, {
          verdict: 'MATCH_PROPOSED',
          suggestedAction: 'ACCEPT_MATCH',
          confidence: 1,
          links: refs(
            ['ledger_entry', world.ledger.l2],
            ['rzp_payment', foreign],
            ['rzp_payment', randomUUID()],
          ),
        }),
      ]),
    ]);
    const [draft] = await runner.investigate([dup()], ctx);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.suggestedAction).toBe('NONE');
    expect(draft?.content.links.map((l) => l.recordId)).not.toContain(foreign);
  });
});

describe('clusters', () => {
  it('answers for every member in one conversation, one draft each, in order', async () => {
    const { llm, runner, ctx } = setup([
      replyWith([
        result(none().id, {
          reasonCode: 'LEDGER_WITHOUT_PAYMENT',
          suggestedAction: 'CHASE_SETTLEMENT',
          evidence: [{ call: 0, keyFinding: 'No payment for ORD-1003.' }],
        }),
        result(dup().id),
      ]),
    ]);
    const drafts = await runner.investigate([dup(), none()], ctx);
    expect(llm.calls).toBe(1);
    expect(drafts.map((d) => d.content.exceptionId)).toEqual([dup().id, none().id]);
    expect(drafts.map((d) => d.content.reasonCode)).toEqual([
      'DUPLICATE_PAYMENT',
      'LEDGER_WITHOUT_PAYMENT',
    ]);
    // Each result's call 0 resolves to its own brief.
    expect(drafts[0]?.content.evidence[0]?.args).toEqual({ exception_id: dup().id });
    expect(drafts[1]?.content.evidence[0]?.args).toEqual({ exception_id: none().id });
    expect(ctx.recorded[0]?.exceptionId).toBeNull();
    const opening = llm.requests[0]?.messages[0]?.content as string;
    expect(opening).toContain('related exceptions');
    expect(opening.match(/<brief /g)).toHaveLength(2);
  });

  it('asks for a repair when a member is left out, and fills nothing in by itself', async () => {
    const { llm, runner, ctx } = setup([
      replyWith([result(dup().id)]),
      replyWith([result(dup().id), result(none().id, { reasonCode: 'LEDGER_WITHOUT_PAYMENT' })]),
    ]);
    const drafts = await runner.investigate([dup(), none()], ctx);
    expect(llm.requests[1]?.messages.at(-1)?.content).toContain(
      `there is no result for ${none().id}`,
    );
    expect(drafts).toHaveLength(2);
  });
});

describe('escalation to the large model', () => {
  const unsure = () =>
    replyWith([
      result(dup().id, {
        verdict: 'NEEDS_HUMAN',
        suggestedAction: 'NONE',
        confidence: 0.4,
        evidence: [],
      }),
    ]);
  const sure = () =>
    replyWith([
      result(dup().id, { confidence: 0.92, evidence: [{ call: 0, keyFinding: 'confirmed' }] }),
    ]);

  it('looks again once with the large model when the small one is unsure', async () => {
    const { llm, runner, ctx } = setup([feeCall(1), unsure(), sure()], { escalation: true });
    const [draft] = await runner.investigate([dup()], ctx);

    expect(llm.calls).toBe(3);
    const second = llm.requests[2] as LlmRequest;
    expect(second.model).toBe(LARGE);
    expect(second.effort).toBe('high');
    expect(second.messages).toHaveLength(1); // a fresh conversation, not a continuation
    const opening = second.messages[0]?.content as string;
    expect(opening).toContain('<earlier_calls>');
    expect(opening).toContain('call 1 (get_fee_contract)');
    expect(opening).not.toContain('NEEDS_HUMAN'); // the first pass's verdict is not passed on
    expect(draft?.model).toBe(LARGE);
    expect(draft?.content.confidence).toBe(0.92);
    expect(draft?.harnessFindings[0]).toContain('escalated from claude-haiku-5-5');
    expect(ctx.recorded.map((r) => r.model)).toEqual([SMALL, SMALL, LARGE]);
  });

  it('escalates on confidence below 0.7 as well', async () => {
    const lowConfidence = replyWith([result(dup().id, { confidence: 0.69 })]);
    const { llm, runner, ctx } = setup([lowConfidence, sure()], { escalation: true });
    await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(2);
  });

  it('does not escalate a confident answer', async () => {
    const { llm, runner, ctx } = setup([sure(), sure()], { escalation: true });
    await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(1);
  });

  it('does not escalate when it is switched off or the models are the same', async () => {
    const off = setup([unsure(), sure()], { escalation: false });
    await off.runner.investigate([dup()], off.ctx);
    expect(off.llm.calls).toBe(1);

    const same = setup([unsure(), sure()], { escalation: true, largeModel: SMALL });
    await same.runner.investigate([dup()], same.ctx);
    expect(same.llm.calls).toBe(1);
  });

  it('keeps the first answer, and says so, when the second look fails', async () => {
    const { runner, ctx } = setup([unsure(), says('x'), says('y')], { escalation: true });
    const [draft] = await runner.investigate([dup()], ctx);
    expect(draft?.model).toBe(SMALL);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.harnessFindings.join(' ')).toContain('did not finish (invalid)');
  });

  it('spends at most one escalation, however the second pass ends', async () => {
    const { llm, runner, ctx } = setup([unsure(), unsure(), sure()], { escalation: true });
    const [draft] = await runner.investigate([dup()], ctx);
    expect(llm.calls).toBe(2);
    expect(draft?.model).toBe(LARGE);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
  });
});
