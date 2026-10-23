// Harness B against a FAKE Agent SDK: no process is spawned and no API is called. The tool handlers are the
// real ones, running the real toolbox on real records, so what is tested is everything this project owns:
// how the SDK is locked down, how calls are numbered and grounded, how budgets and failures map to
// outcomes, and how cost is priced.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorld, createMigratedDb, type TestDb, type World } from './agent.fixtures.js';
import { costMicroUsd } from './pricing.js';
import {
  loadSdk,
  microCeil,
  processEnv,
  SDK_SERVER_NAME,
  SdkRunner,
  type SdkApi,
  shapeOf,
} from './sdk-runner.js';
import { AGENT_TOOLS } from './tools/definitions.js';
import { Toolbox } from './tools/toolbox.js';
import { result as modelResult, testContext } from './scripted-llm.fixtures.js';
import { AgentHalted, type ExceptionToInvestigate } from './types.js';

const MODEL = 'claude-haiku-5-5';
let db: TestDb;
let client: Awaited<ReturnType<typeof createMigratedDb>>['client'];
let world: World;
let box: Toolbox;
const dirs: string[] = [];

beforeAll(async () => {
  ({ db, client } = await createMigratedDb());
  world = await buildWorld(db);
  box = await Toolbox.create(db, world.runId);
}, 60_000);
afterAll(async () => {
  await client.close();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const member = (): ExceptionToInvestigate => ({
  id: world.exceptions.duplicate,
  ruleReasonCode: 'DUPLICATE_PAYMENT',
});

type Handler = (
  args: unknown,
  extra: unknown,
) => Promise<{ content: { text: string }[]; isError?: boolean }>;
interface Registered {
  name: string;
  handler: Handler;
  extras: { annotations?: { readOnlyHint?: boolean }; alwaysLoad?: boolean } | undefined;
}

const usage = (over: Record<string, number> = {}) => ({
  inputTokens: 1000,
  outputTokens: 100,
  cacheReadInputTokens: 500,
  cacheCreationInputTokens: 200,
  webSearchRequests: 0,
  costUSD: 0.0005,
  contextWindow: 200000,
  maxOutputTokens: 8000,
  ...over,
});

const answered = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '',
  structured_output: { results: [modelResult(world.exceptions.duplicate)] },
  duration_ms: 1500,
  duration_api_ms: 1400,
  num_turns: 3,
  stop_reason: 'end_turn',
  total_cost_usd: 0.0007,
  usage: { input_tokens: 1000, output_tokens: 100 },
  modelUsage: { [MODEL]: usage() },
  errors: [] as string[],
  ...over,
});

interface Script {
  options: Options;
  prompt: string;
  tools: Map<string, Registered>;
  call(name: string, args: unknown): ReturnType<Handler>;
}

/** A fake SDK whose "model" is a function: it may call the registered tools, then returns messages. */
function fakeSdk(script: (s: Script) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>) {
  const seen: {
    options: Options | null;
    prompt: string | null;
    queries: number;
    tools: Registered[];
  } = {
    options: null,
    prompt: null,
    queries: 0,
    tools: [],
  };
  const api = {
    tool: (
      name: string,
      _d: string,
      _s: unknown,
      handler: Handler,
      extras?: Registered['extras'],
    ) => {
      const t = { name, handler, extras };
      seen.tools.push(t);
      return t;
    },
    createSdkMcpServer: (o: { name: string; tools: unknown[] }) => ({
      type: 'sdk',
      name: o.name,
      tools: o.tools,
    }),
    query: async function* (params: { prompt: string; options: Options }) {
      seen.queries += 1;
      seen.options = params.options;
      seen.prompt = params.prompt;
      const tools = new Map(seen.tools.map((t) => [`mcp__${SDK_SERVER_NAME}__${t.name}`, t]));
      yield* await script({
        options: params.options,
        prompt: params.prompt,
        tools,
        call: (name, args) => {
          const t = tools.get(`mcp__${SDK_SERVER_NAME}__${name}`);
          if (t === undefined) throw new Error(`no tool ${name}`);
          return t.handler(args, {});
        },
      });
    },
  };
  return { api: api as unknown as SdkApi, seen };
}

// An async iterable is what the SDK returns; a fake has nothing to await.
// eslint-disable-next-line @typescript-eslint/require-await
async function* messages(...items: unknown[]) {
  for (const item of items) yield item;
}

function runner(api: SdkApi, over: Partial<ConstructorParameters<typeof SdkRunner>[0]> = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'ziro-sdk-test-'));
  dirs.push(workDir);
  return new SdkRunner({ apiKey: 'sk-test-key', model: MODEL, api, workDir, ...over });
}

describe('an investigation that answers', () => {
  it('turns the SDK’s structured output into a proposal draft, recorded as harness agent-sdk', async () => {
    const { api } = fakeSdk(() => messages(answered()));
    const ctx = testContext(box, world.runId);
    const [draft] = await runner(api).investigate([member()], ctx);

    expect(draft?.content.verdict).toBe('EXPLAINED_NO_MATCH');
    expect(draft?.content.reasonCode).toBe('DUPLICATE_PAYMENT');
    expect(draft?.model).toBe(MODEL);
    expect(draft?.llmCallId).toBe('call-1');
    expect(ctx.recorded).toHaveLength(1);
    expect(ctx.recorded[0]).toMatchObject({
      harness: 'agent-sdk',
      model: MODEL,
      latencyMs: 1500,
      stopReason: 'end_turn',
    });
  });

  it('prices the tokens with OUR table, not the SDK’s estimate, and keeps cache tokens apart', async () => {
    const { api } = fakeSdk(() => messages(answered({ total_cost_usd: 99 })));
    const ctx = testContext(box, world.runId);
    await runner(api).investigate([member()], ctx);
    const call = ctx.recorded[0];
    expect(call?.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
    });
    expect(call?.costMicroUsd).toBe(costMicroUsd(MODEL, call!.usage));
    expect(call?.costMicroUsd).toBeLessThan(1_000_000n);
  });

  it('adds up every model the SDK used, and falls back to its own estimate for one we cannot price', async () => {
    const modelUsage = {
      [MODEL]: usage(),
      'some-other-model-1': usage({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.000123,
      }),
    };
    const { api } = fakeSdk(() => messages(answered({ modelUsage })));
    const ctx = testContext(box, world.runId);
    await runner(api).investigate([member()], ctx);
    const call = ctx.recorded[0]!;
    expect(call.usage.inputTokens).toBe(1010);
    expect(call.usage.outputTokens).toBe(105);
    expect(call.costMicroUsd).toBe(
      costMicroUsd(MODEL, {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 500,
        cacheWriteTokens: 200,
      }) + 123n,
    );
  });

  it('reports the SDK’s own cost estimate to telemetry, rounded up, without using it', async () => {
    const reported: number[] = [];
    const { api } = fakeSdk(() => messages(answered({ total_cost_usd: 0.0012345 })));
    await runner(api, {
      telemetry: {
        unknownTool: () => undefined,
        reportedCost: (_ids, micro) => void reported.push(micro),
      },
    }).investigate([member()], testContext(box, world.runId));
    expect(reported).toEqual([1235]);
  });

  it('accepts a reply in the result text when no structured output came back', async () => {
    const text = JSON.stringify({ results: [modelResult(world.exceptions.duplicate)] });
    const { api } = fakeSdk(() =>
      messages(answered({ structured_output: undefined, result: text })),
    );
    const [draft] = await runner(api).investigate([member()], testContext(box, world.runId));
    expect(draft?.content.verdict).toBe('EXPLAINED_NO_MATCH');
  });

  it('sends the same opening message as harness A: the exception brief, call 0', async () => {
    const { api, seen } = fakeSdk(() => messages(answered()));
    await runner(api).investigate([member()], testContext(box, world.runId));
    expect(seen.prompt).toContain(world.exceptions.duplicate);
    expect(seen.options?.systemPrompt).toEqual(expect.stringContaining('read'));
  });
});

describe('how the SDK is locked down', () => {
  it('removes every built-in tool, every setting source and the session file, and denies what is not approved', async () => {
    const { api, seen } = fakeSdk(() => messages(answered()));
    await runner(api).investigate([member()], testContext(box, world.runId));
    const o = seen.options!;
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.model).toBe(MODEL);
    expect(o.outputFormat).toMatchObject({ type: 'json_schema' });
    expect(o.maxBudgetUsd).toBeGreaterThan(0);
    expect(o.abortController).toBeInstanceOf(AbortController);
  });

  it('allows exactly the nine tools, by their full names, and nothing else', async () => {
    const { api, seen } = fakeSdk(() => messages(answered()));
    await runner(api).investigate([member()], testContext(box, world.runId));
    const expected = AGENT_TOOLS.map((t) => `mcp__${SDK_SERVER_NAME}__${t.name}`).sort();
    expect(AGENT_TOOLS).toHaveLength(9);
    expect([...(seen.options!.allowedTools ?? [])].sort()).toEqual(expected);
    expect(Object.keys(seen.options!.mcpServers ?? {})).toEqual([SDK_SERVER_NAME]);
  });

  it('marks every tool read-only and always loaded, so harness B is not made cheaper by hiding schemas', async () => {
    const { api, seen } = fakeSdk(() => messages(answered()));
    await runner(api).investigate([member()], testContext(box, world.runId));
    expect(seen.tools).toHaveLength(9);
    for (const t of seen.tools) {
      expect(t.extras?.annotations?.readOnlyHint).toBe(true);
      expect(t.extras?.alwaysLoad).toBe(true);
    }
  });

  it('runs in an empty directory and hands over the key but no database or cloud credentials', async () => {
    const { api, seen } = fakeSdk(() => messages(answered()));
    await runner(api).investigate([member()], testContext(box, world.runId));
    expect(readdirSync(seen.options!.cwd!)).toEqual([]);
    const env = seen.options!.env as Record<string, string>;
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-test-key');
    expect(
      Object.keys(env).some((k) => /DATABASE_URL|REDIS_URL|RAZORPAY|AWS_|SECRET|PASSWORD/.test(k)),
    ).toBe(false);
  });

  it('processEnv withholds credentials the model-facing process has no use for', () => {
    const env = processEnv(
      {
        PATH: '/bin',
        HOME: '/h',
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        RAZORPAY_KEY_SECRET: 's',
        AWS_ACCESS_KEY_ID: 'a',
        MY_TOKEN: 't',
        NODE_ENV: 'test',
      },
      'sk-1',
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', NODE_ENV: 'test', ANTHROPIC_API_KEY: 'sk-1' });
  });
});

describe('the tools the model is given', () => {
  it('runs the real toolbox, numbers calls from 1 after the brief, and grounds the evidence in them', async () => {
    const paymentId = (await box.run('get_exception', { exception_id: world.exceptions.duplicate }))
      .ok
      ? 'x'
      : 'x';
    expect(paymentId).toBe('x');
    const { api } = fakeSdk(async (s) => {
      const first = await s.call('get_exception', { exception_id: world.exceptions.duplicate });
      expect(first.isError).toBeUndefined();
      expect(first.content[0]?.text.startsWith('call 1:\n')).toBe(true);
      const second = await s.call('get_exception', { exception_id: world.exceptions.duplicate });
      expect(second.content[0]?.text.startsWith('call 2:\n')).toBe(true);
      return messages(
        answered({
          structured_output: {
            results: [
              modelResult(world.exceptions.duplicate, {
                evidence: [
                  { call: 0, keyFinding: 'The brief.' },
                  { call: 2, keyFinding: 'Looked again.' },
                  { call: 9, keyFinding: 'A call that never happened.' },
                ],
              }),
            ],
          },
        }),
      );
    });
    const [draft] = await runner(api).investigate([member()], testContext(box, world.runId));
    expect(draft?.content.evidence.map((e) => e.keyFinding)).toEqual([
      'The brief.',
      'Looked again.',
    ]);
    expect(draft?.harnessFindings.join(' ')).toMatch(/call 9, which does not exist/);
  });

  it('numbers calls made in parallel distinctly, taking the number before awaiting anything', async () => {
    let texts: string[] = [];
    const { api } = fakeSdk(async (s) => {
      const out = await Promise.all(
        [1, 2, 3].map(() => s.call('get_exception', { exception_id: world.exceptions.duplicate })),
      );
      texts = out.map((o) => o.content[0]!.text.split('\n')[0]!);
      return messages(answered());
    });
    await runner(api).investigate([member()], testContext(box, world.runId));
    expect(texts.sort()).toEqual(['call 1:', 'call 2:', 'call 3:']);
  });

  it('refuses a call past the tool-call budget without running it', async () => {
    let third: Awaited<ReturnType<Handler>> | null = null;
    const { api } = fakeSdk(async (s) => {
      await s.call('get_exception', { exception_id: world.exceptions.duplicate });
      await s.call('get_exception', { exception_id: world.exceptions.duplicate });
      third = await s.call('get_exception', { exception_id: world.exceptions.duplicate });
      return messages(answered());
    });
    await runner(api, {
      limits: {
        maxToolCalls: 2,
        maxOutputTokens: 24_000,
        maxTokensPerRequest: 8_000,
        maxPromptTokensPerRequest: 80_000,
        timeoutMs: 60_000,
      },
    }).investigate([member()], testContext(box, world.runId));
    expect(third).toMatchObject({ isError: true });
    expect(third!.content[0]?.text).toMatch(/budget is spent/);
  });

  it('tells the model plainly when a tool call is invalid, and marks it as an error', async () => {
    let bad: Awaited<ReturnType<Handler>> | null = null;
    const { api } = fakeSdk(async (s) => {
      bad = await s.call('get_exception', { exception_id: 'not-a-uuid', extra: 1 });
      return messages(answered());
    });
    await runner(api).investigate([member()], testContext(box, world.runId));
    expect(bad!.isError).toBe(true);
    expect(bad!.content[0]?.text).toMatch(/^call 1 failed: invalid arguments/);
  });
});

describe('when it does not answer', () => {
  const NEEDS = (text: RegExp) => async (message: unknown) => {
    const { api } = fakeSdk(() => messages(message));
    const [draft] = await runner(api).investigate([member()], testContext(box, world.runId));
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.content.reasonCode).toBe('DUPLICATE_PAYMENT');
    expect(draft?.harnessFindings.join(' ')).toMatch(text);
  };

  it('too many turns is a tool-call budget stop, handed to a person', async () => {
    await NEEDS(/tool-call budget ran out/)(
      answered({ subtype: 'error_max_turns', structured_output: undefined }),
    );
  });

  it('the SDK’s spend ceiling is a budget stop, handed to a person', async () => {
    await NEEDS(/output-token budget ran out/)(
      answered({ subtype: 'error_max_budget_usd', structured_output: undefined }),
    );
  });

  it('a reply that will not follow the schema is invalid, handed to a person', async () => {
    await NEEDS(/not valid/)(
      answered({ subtype: 'error_max_structured_output_retries', structured_output: undefined }),
    );
    await NEEDS(/not valid/)(
      answered({ structured_output: undefined, result: 'I could not decide.' }),
    );
  });

  it('a refusal is final', async () => {
    await NEEDS(/declined to answer/)(
      answered({ stop_reason: 'refusal', structured_output: undefined }),
    );
  });

  it('a result for the wrong exception is not accepted as an answer', async () => {
    await NEEDS(/no result for this exception|not valid/)(
      answered({
        structured_output: { results: [modelResult('00000000-0000-4000-8000-000000000009')] },
      }),
    );
  });

  it('an infrastructure failure throws, so the job fails and can be retried, instead of looking like a conclusion', async () => {
    for (const bad of [
      answered({ is_error: true, result: 'API Error: 529 overloaded' }),
      answered({
        subtype: 'error_during_execution',
        errors: ['the process crashed'],
        structured_output: undefined,
      }),
    ]) {
      const { api } = fakeSdk(() => messages(bad));
      await expect(
        runner(api).investigate([member()], testContext(box, world.runId)),
      ).rejects.toThrow(/Agent SDK/);
    }
    const { api } = fakeSdk(() => messages());
    await expect(
      runner(api).investigate([member()], testContext(box, world.runId)),
    ).rejects.toThrow(/without a result/);
  });

  it('a stream that dies for any other reason than our own timeout is an error', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const { api } = fakeSdk(async function* () {
      yield* [];
      throw new Error('spawn failed');
    });
    await expect(
      runner(api).investigate([member()], testContext(box, world.runId)),
    ).rejects.toThrow('spawn failed');
  });

  it('stops at the time budget by aborting, and says so; its spend cannot be known, so none is recorded', async () => {
    const { api } = fakeSdk((s) =>
      (async function* () {
        await new Promise<void>((_, reject) =>
          s.options.abortController!.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        );
        yield* [];
      })(),
    );
    const ctx = testContext(box, world.runId);
    const [draft] = await runner(api, {
      limits: {
        maxToolCalls: 8,
        maxOutputTokens: 24_000,
        maxTokensPerRequest: 8_000,
        maxPromptTokensPerRequest: 80_000,
        timeoutMs: 30,
      },
    }).investigate([member()], ctx);
    expect(draft?.content.verdict).toBe('NEEDS_HUMAN');
    expect(draft?.harnessFindings.join(' ')).toMatch(/time budget ran out/);
    expect(ctx.recorded).toHaveLength(0);
  });
});

describe('around the model', () => {
  it('asks the gate before it starts the SDK, so a kill switch or spent budget stops it with nothing started', async () => {
    const { api, seen } = fakeSdk(() => messages(answered()));
    const ctx = testContext(box, world.runId, () => Promise.reject(new AgentHalted('kill_switch')));
    await expect(runner(api).investigate([member()], ctx)).rejects.toBeInstanceOf(AgentHalted);
    expect(seen.queries).toBe(0);
    expect(ctx.gateCalls).toBe(1);
  });

  it('reports a tool the model asked for that does not exist, and ignores ours and a subagent’s', async () => {
    const unknown: string[][] = [];
    const tool = (name: string, parent: string | null = null) => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', name }] },
    });
    const { api } = fakeSdk(() =>
      messages(
        tool(`mcp__${SDK_SERVER_NAME}__get_payment`),
        tool('approve_match'),
        tool('Bash'),
        tool('elsewhere', 'toolu_1'),
        answered(),
      ),
    );
    await runner(api, {
      telemetry: {
        unknownTool: (_ids, name) => void unknown.push([name]),
        reportedCost: () => undefined,
      },
    }).investigate([member()], testContext(box, world.runId));
    expect(unknown).toEqual([['approve_match'], ['Bash']]);
  });

  it('answers once per member for a cluster, in order, from one conversation and one recorded call', async () => {
    const other: ExceptionToInvestigate = {
      id: world.exceptions.other,
      ruleReasonCode: 'LEDGER_WITHOUT_PAYMENT',
    };
    const { api } = fakeSdk(() =>
      messages(
        answered({
          structured_output: {
            results: [
              modelResult(world.exceptions.duplicate),
              modelResult(world.exceptions.other, {
                reasonCode: 'LEDGER_WITHOUT_PAYMENT',
                suggestedAction: 'NONE',
              }),
            ],
          },
        }),
      ),
    );
    const ctx = testContext(box, world.runId);
    const drafts = await runner(api).investigate([member(), other], ctx);
    expect(drafts.map((d) => d.content.exceptionId)).toEqual([
      world.exceptions.duplicate,
      world.exceptions.other,
    ]);
    expect(ctx.recorded).toHaveLength(1);
    expect(ctx.recorded[0]?.exceptionId).toBeNull();
  });
});

describe('against the real SDK package (nothing is started, nothing is sent)', () => {
  it('accepts our nine tool definitions and builds the in-process server from them', async () => {
    const sdk = await loadSdk();
    const tools = AGENT_TOOLS.map((t) =>
      sdk.tool(
        t.name,
        t.description,
        shapeOf(t),
        () => Promise.resolve({ content: [{ type: 'text' as const, text: 'x' }] }),
        { annotations: { readOnlyHint: true }, alwaysLoad: true },
      ),
    );
    const server = sdk.createSdkMcpServer({ name: SDK_SERVER_NAME, version: '1.0.0', tools });
    expect(server.type).toBe('sdk');
    expect(server.name).toBe(SDK_SERVER_NAME);
    expect(tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
  });

  it('every tool takes an object, so each can be an SDK custom tool', () => {
    for (const t of AGENT_TOOLS) expect(Object.keys(shapeOf(t)).length).toBeGreaterThan(0);
  });
});

describe('microCeil: dollars as a float to whole micro-USD, never understating', () => {
  it.each([
    [0, 0n],
    [0.000001, 1n],
    [0.000123, 123n],
    [0.0012345, 1235n],
    [0.5, 500_000n],
    [1.234567, 1_234_567n],
    [1.2345671, 1_234_568n],
  ])('$%s is %s micro-USD', (usd, micro) => {
    expect(microCeil(usd)).toBe(micro);
  });
});
