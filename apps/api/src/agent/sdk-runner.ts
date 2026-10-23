// Harness B: the same investigation, run by the Claude Agent SDK instead of our own loop. It exists so the
// two can be measured against each other (packages/evals), and it is a real AgentRunner behind
// AGENT_HARNESS=agent-sdk.
//
// What is the same as harness A, on purpose, so that a difference in the numbers is a difference in the
// harness: the system prompt, the opening message, the nine read-only tools (the very same toolbox, wrapped
// as in-process custom tools), call 0 (the briefs), the numbering of calls that evidence cites, the
// grounding in `finalizeResult`, and how a draft is built. What differs is who runs the loop: the SDK
// spawns its own Claude Code process, manages the context, and decides when to stop.
//
// How it is locked down (all options named in the SDK's shipped types):
//   tools: []                      no built-in tool at all (no Bash, no Read, no web)
//   mcpServers + allowedTools      only our nine tools, by name
//   permissionMode: 'dontAsk'      anything not pre-approved is denied, never prompted
//   settingSources: []             no user, project or local settings: the repo's CLAUDE.md is not read
//   cwd: an empty directory        nothing for a stray tool to find
//   persistSession: false          no transcript written to disk
//   env                            the process environment without the database or cloud credentials
//
// Known differences, reported rather than hidden: no repair turn (structured output is requested instead),
// no escalation to a larger model, a per-investigation spend ceiling instead of an output-token one, and
// the process start-up is part of the latency. The daily budget and kill switch are checked before the
// query starts; once it is running the SDK's own ceiling (`maxBudgetUsd`) is what bounds it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { DEFAULT_LIMITS, type Limits } from './budget.js';
import type { LoopEnd } from './loop.js';
import { draftsFrom, fetchBriefs } from './loop-runner.js';
import { type CallRecord, OUTPUT_JSON_SCHEMA, parseModelOutput } from './output.js';
import { costMicroUsd, PricingError, ratesFor, type Usage } from './pricing.js';
import { firstMessage, promptHash, systemPrompt } from './prompt.js';
import { AGENT_TOOLS } from './tools/definitions.js';
import type { AgentTool } from './tools/types.js';
import type {
  AgentRunner,
  ExceptionToInvestigate,
  InvestigationContext,
  ProposalDraft,
  RunnerTelemetry,
} from './types.js';

/** The slice of the SDK this runner uses, so a test can supply a fake model and no process is spawned. */
export interface SdkApi {
  query(params: { prompt: string; options: Options }): AsyncIterable<SDKMessage>;
  tool: typeof import('@anthropic-ai/claude-agent-sdk').tool;
  createSdkMcpServer: typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
}

export async function loadSdk(): Promise<SdkApi> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return { query: sdk.query, tool: sdk.tool, createSdkMcpServer: sdk.createSdkMcpServer };
}

export interface SdkRunnerOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly limits?: Limits;
  /** The SDK stops an investigation whose own cost estimate reaches this. It can overshoot a little. */
  readonly maxBudgetUsd?: number;
  readonly telemetry?: RunnerTelemetry;
  /** Replaced in tests. */
  readonly api?: SdkApi;
  /** The directory the process runs in; a fresh empty one is made if absent. */
  readonly workDir?: string;
}

export const SDK_SERVER_NAME = 'ziro';
export const DEFAULT_MAX_BUDGET_USD = 1;
const toolName = (name: string): string => `mcp__${SDK_SERVER_NAME}__${name}`;

/** Credentials the model-facing process has no use for are not handed to it. */
const WITHHELD =
  /^(DATABASE_URL|REDIS_URL|RAZORPAY_|AWS_|GOOGLE_|GCP_|AZURE_|GITHUB_|NPM_)|SECRET|PASSWORD|TOKEN/i;
export function processEnv(base: NodeJS.ProcessEnv, apiKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !WITHHELD.test(k)) out[k] = v;
  }
  out['ANTHROPIC_API_KEY'] = apiKey;
  return out;
}

export function shapeOf(tool: AgentTool): z.ZodRawShape {
  if (!(tool.args instanceof z.ZodObject)) {
    throw new Error(
      `tool ${tool.name} does not take an object, so it cannot be an SDK custom tool`,
    );
  }
  return tool.args.shape;
}

export class SdkRunner implements AgentRunner {
  readonly harness = 'agent-sdk' as const;
  private readonly limits: Limits;
  private readonly workDir: string;
  private readonly ownsWorkDir: boolean;
  private api: SdkApi | null;

  constructor(private readonly options: SdkRunnerOptions) {
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.api = options.api ?? null;
    this.ownsWorkDir = options.workDir === undefined;
    this.workDir = options.workDir ?? mkdtempSync(join(tmpdir(), 'ziro-sdk-'));
  }

  /** Removes the empty working directory this runner made. */
  close(): void {
    if (this.ownsWorkDir) rmSync(this.workDir, { recursive: true, force: true });
  }

  async investigate(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
  ): Promise<ProposalDraft[]> {
    const api = (this.api ??= await loadSdk());
    const ids = members.map((m) => m.id);
    const { briefCalls, briefs } = await fetchBriefs(members, ctx);
    const calls: CallRecord[] = [...briefCalls];
    let used = 0;

    const tools = AGENT_TOOLS.map((t) =>
      api.tool(
        t.name,
        t.description,
        shapeOf(t),
        async (args: unknown) => {
          // Parallel calls are allowed (read-only), so the number is taken before anything is awaited.
          if (used >= this.limits.maxToolCalls) {
            return {
              content: [{ type: 'text' as const, text: 'not run: the tool-call budget is spent' }],
              isError: true,
            };
          }
          used += 1;
          const n = used;
          const asArgs =
            typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
          const run = await ctx.toolbox.run(t.name, args);
          calls.push({
            n,
            tool: t.name,
            args: asArgs,
            ok: run.ok,
            summary: run.ok ? run.summary : `failed: ${run.error}`,
            seen: run.ok ? run.seen : [],
          });
          return run.ok
            ? { content: [{ type: 'text' as const, text: `call ${n}:\n${run.content}` }] }
            : {
                content: [{ type: 'text' as const, text: `call ${n} failed: ${run.error}` }],
                isError: true,
              };
        },
        // Read-only, so the SDK may batch them; and shown in full from the first turn, so that harness B
        // does not trade an extra round-trip for fewer tokens and look cheaper for the wrong reason.
        { annotations: { readOnlyHint: true }, alwaysLoad: true },
      ),
    );
    const server = api.createSdkMcpServer({ name: SDK_SERVER_NAME, version: '1.0.0', tools });
    const registered = new Set(AGENT_TOOLS.map((t) => toolName(t.name)));

    const system = systemPrompt(this.limits);
    const opening = firstMessage(briefs);
    await ctx.gate();

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.limits.timeoutMs);
    const options: Options = {
      model: this.options.model,
      systemPrompt: system,
      tools: [],
      mcpServers: { [SDK_SERVER_NAME]: server },
      allowedTools: [...registered],
      permissionMode: 'dontAsk',
      settingSources: [],
      persistSession: false,
      maxTurns: this.limits.maxToolCalls + 3,
      maxBudgetUsd: this.options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
      outputFormat: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA },
      abortController: abort,
      cwd: this.workDir,
      env: processEnv(process.env, this.options.apiKey),
    };

    let result: Extract<SDKMessage, { type: 'result' }> | null = null;
    let timedOut = false;
    try {
      for await (const message of api.query({ prompt: opening, options })) {
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          for (const block of message.message.content) {
            if (block.type === 'tool_use' && !registered.has(block.name)) {
              this.options.telemetry?.unknownTool(ids, block.name);
            }
          }
        } else if (message.type === 'result') {
          result = message;
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
      timedOut = true;
    } finally {
      clearTimeout(timer);
    }

    let lastLlmCallId: string | null = null;
    if (result !== null) {
      this.options.telemetry?.reportedCost(ids, Number(microCeil(result.total_cost_usd)));
      lastLlmCallId = await ctx.recordLlmCall({
        exceptionId: members.length === 1 ? (members[0]?.id ?? null) : null,
        model: this.options.model,
        harness: 'agent-sdk',
        ...totalsOf(result),
        latencyMs: Math.max(0, Math.round(result.duration_ms)),
        promptHash: promptHash(system, JSON.stringify(ctx.toolbox.definitions), opening),
        stopReason: result.stop_reason ?? result.subtype,
        requestId: null,
      });
    }

    const end = endOf(result, timedOut, ids);
    return draftsFrom({ end, calls, lastLlmCallId }, this.options.model, members);
  }
}

/** Tokens summed over every model the SDK used (it may use a small one for housekeeping) and the cost. */
function totalsOf(result: Extract<SDKMessage, { type: 'result' }>): {
  usage: Usage;
  costMicroUsd: bigint;
} {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let cost = 0n;
  for (const [model, u] of Object.entries(result.modelUsage)) {
    const part: Usage = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadInputTokens,
      cacheWriteTokens: u.cacheCreationInputTokens,
    };
    usage.inputTokens += part.inputTokens;
    usage.outputTokens += part.outputTokens;
    usage.cacheReadTokens += part.cacheReadTokens;
    usage.cacheWriteTokens += part.cacheWriteTokens;
    // Our own price table where it knows the model, so every harness is priced the same way; the SDK's
    // estimate only for a model we have no rates for.
    try {
      cost += ratesFor(model) === undefined ? microCeil(u.costUSD) : costMicroUsd(model, part);
    } catch (error) {
      if (!(error instanceof PricingError)) throw error;
      cost += microCeil(u.costUSD);
    }
  }
  return { usage, costMicroUsd: cost };
}

function endOf(
  result: Extract<SDKMessage, { type: 'result' }> | null,
  timedOut: boolean,
  memberIds: readonly string[],
): LoopEnd {
  if (timedOut) return { kind: 'exhausted', by: 'time' };
  if (result === null) throw new Error('the Agent SDK ended without a result');
  switch (result.subtype) {
    case 'success': {
      if (result.is_error)
        throw new Error(`the Agent SDK ended on an error: ${result.result.slice(0, 200)}`);
      if (result.stop_reason === 'refusal') return { kind: 'refused' };
      const text =
        result.structured_output !== undefined
          ? JSON.stringify(result.structured_output)
          : result.result;
      const parsed = parseModelOutput(text, memberIds);
      return parsed.ok
        ? { kind: 'answered', output: parsed.output }
        : { kind: 'invalid', problems: parsed.problems };
    }
    case 'error_max_turns':
      return { kind: 'exhausted', by: 'tool_calls' };
    case 'error_max_budget_usd':
      return { kind: 'exhausted', by: 'tokens' };
    case 'error_max_structured_output_retries':
      return {
        kind: 'invalid',
        problems: ['the SDK could not get a reply that follows the output schema'],
      };
    default:
      throw new Error(
        `the Agent SDK failed (${result.subtype}): ${result.errors.join('; ').slice(0, 200)}`,
      );
  }
}

/**
 * Dollars as a float (all the SDK gives) to whole micro-USD, rounded up so that spend is never understated.
 * The product is first rounded to a thousandth of a micro-dollar: 0.000123 * 1e6 is 123.00000000000001 in
 * floating point, which would otherwise round up to 124.
 */
export function microCeil(usd: number): bigint {
  return BigInt(Math.ceil(Number((usd * 1_000_000).toFixed(3))));
}
