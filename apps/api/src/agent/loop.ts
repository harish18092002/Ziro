// Harness A: a hand-rolled tool-use loop. One conversation, append-only, until the model gives a final
// reply or a budget runs out. The loop decides nothing about money; it moves messages, runs the
// read-only tools the model asks for, counts, and stops. Everything the model claims is checked
// afterwards (output.ts), and again by the verifier later.
//
// Rules the loop keeps:
//  - the model's response content goes back unchanged (thinking blocks are bound to their turn);
//  - a budget is checked before every request, and a spent budget ends the investigation without
//    another model call;
//  - the final reply may be repaired once; a second bad reply ends it;
//  - a refusal ends it. Nothing here retries a refusal or reasons around one.
import { Budget, type Exhausted, type Limits } from './budget.js';
import {
  isText,
  isToolUse,
  type Effort,
  type LlmClient,
  LlmAbortedError,
  type LlmMessage,
  type LlmResponse,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from './llm.js';
import {
  type CallRecord,
  type ModelOutput,
  OUTPUT_JSON_SCHEMA,
  parseModelOutput,
} from './output.js';
import { costMicroUsd, totalPromptTokens } from './pricing.js';
import { NO_MORE_TOOLS_NOTICE, promptHash, repairMessage } from './prompt.js';
import { AGENT_TOOLS } from './tools/definitions.js';
import type { Toolbox } from './tools/toolbox.js';
import type { AgentToolName } from './tools/types.js';
import type { InvestigationContext } from './types.js';

export type LoopEnd =
  | { readonly kind: 'answered'; readonly output: ModelOutput }
  | { readonly kind: 'exhausted'; readonly by: Exhausted }
  | { readonly kind: 'refused' }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] }
  /** The model API did not answer, even after retries. Set by the resilience layer, never by the loop. */
  | { readonly kind: 'unavailable'; readonly reason: string }
  /** The model API refused the request itself (a 400-class error). Same origin. */
  | { readonly kind: 'rejected'; readonly reason: string };

export interface LoopOutcome {
  readonly end: LoopEnd;
  /** Call 0 (the briefs) and every tool call the model made, in order. */
  readonly calls: readonly CallRecord[];
  /** The last request made; the one the conclusion (or the failure to conclude) came from. */
  readonly lastLlmCallId: string | null;
}

export interface LoopParams {
  readonly client: LlmClient;
  readonly ctx: Pick<InvestigationContext, 'toolbox' | 'gate' | 'recordLlmCall'>;
  readonly model: string;
  readonly effort?: Effort;
  readonly limits: Limits;
  readonly system: string;
  /** The first user message. */
  readonly opening: string;
  /** The exceptions this conversation covers; a reply must answer for exactly these. */
  readonly memberIds: readonly string[];
  /** The exception briefs, already fetched (call 0). */
  readonly briefCalls: readonly CallRecord[];
  /** The exception the calls are attributed to; null for a cluster. */
  readonly attributedTo: string | null;
  readonly now?: () => number;
}

const TOOL_NAMES: ReadonlySet<string> = new Set(AGENT_TOOLS.map((t) => t.name));

const asArgs = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

async function runTool(
  toolbox: Toolbox,
  use: ToolUseBlock,
  n: number,
): Promise<{ block: ToolResultBlock; record: CallRecord | null }> {
  const outcome = await toolbox.run(use.name, use.input);
  const known = TOOL_NAMES.has(use.name);
  if (!outcome.ok) {
    return {
      block: {
        type: 'tool_result',
        tool_use_id: use.id,
        content: `call ${n} failed: ${outcome.error}`,
        is_error: true,
      },
      record: known
        ? {
            n,
            tool: use.name as AgentToolName,
            args: asArgs(use.input),
            ok: false,
            summary: `failed: ${outcome.error}`,
            seen: [],
          }
        : null,
    };
  }
  return {
    block: { type: 'tool_result', tool_use_id: use.id, content: `call ${n}:\n${outcome.content}` },
    record: {
      n,
      tool: use.name as AgentToolName,
      args: asArgs(use.input),
      ok: true,
      summary: outcome.summary,
      seen: outcome.seen,
    },
  };
}

export async function runLoop(params: LoopParams): Promise<LoopOutcome> {
  const { client, ctx, limits } = params;
  const now = params.now ?? Date.now;
  const budget = new Budget(limits, now);
  const calls: CallRecord[] = [...params.briefCalls];
  const messages: LlmMessage[] = [{ role: 'user', content: params.opening }];
  const hash = promptHash(params.system, JSON.stringify(ctx.toolbox.definitions), params.opening);
  let lastLlmCallId: string | null = null;
  let repaired = false;

  const finish = (end: LoopEnd): LoopOutcome => ({ end, calls, lastLlmCallId });

  for (;;) {
    const spent = budget.exhausted();
    if (spent !== null) return finish({ kind: 'exhausted', by: spent });
    await ctx.gate();

    const startedAt = now();
    let response: LlmResponse;
    try {
      response = await client.complete({
        model: params.model,
        system: params.system,
        messages,
        tools: ctx.toolbox.definitions,
        maxTokens: budget.nextMaxTokens(),
        outputSchema: OUTPUT_JSON_SCHEMA,
        ...(params.effort === undefined ? {} : { effort: params.effort }),
        signal: AbortSignal.timeout(Math.max(1, budget.msLeft)),
      });
    } catch (error) {
      if (error instanceof LlmAbortedError) return finish({ kind: 'exhausted', by: 'time' });
      throw error;
    }

    lastLlmCallId = await ctx.recordLlmCall({
      exceptionId: params.attributedTo,
      model: params.model,
      harness: 'loop',
      usage: response.usage,
      costMicroUsd: costMicroUsd(params.model, response.usage),
      latencyMs: Math.max(0, now() - startedAt),
      promptHash: hash,
      stopReason: response.stopReason,
      requestId: response.requestId,
    });
    budget.addUsage(response.usage.outputTokens, totalPromptTokens(response.usage));

    if (response.stopReason === 'refusal') return finish({ kind: 'refused' });
    if (response.stopReason === 'model_context_window_exceeded') {
      return finish({ kind: 'exhausted', by: 'context' });
    }

    // A reply cut off by max_tokens may still be complete JSON; anything else cut off is unusable,
    // and a half-written tool call must never be executed.
    const toolUses = response.stopReason === 'max_tokens' ? [] : response.content.filter(isToolUse);

    if (toolUses.length > 0) {
      if (budget.toolCallsLeft === 0) return finish({ kind: 'exhausted', by: 'tool_calls' });
      messages.push({ role: 'assistant', content: response.content });
      const results: ToolResultBlock[] = [];
      for (const use of toolUses) {
        if (budget.toolCallsLeft === 0) {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: 'not run: the tool-call budget is spent',
            is_error: true,
          });
          continue;
        }
        budget.useToolCall();
        const { block, record } = await runTool(ctx.toolbox, use, budget.toolCallsUsed);
        results.push(block);
        if (record !== null) calls.push(record);
      }
      const notice: TextBlock[] =
        budget.toolCallsLeft === 0 ? [{ type: 'text', text: NO_MORE_TOOLS_NOTICE }] : [];
      messages.push({ role: 'user', content: [...results, ...notice] });
      continue;
    }

    if (response.stopReason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const text = response.content
      .filter(isText)
      .map((b) => b.text)
      .join('');
    const parsed = parseModelOutput(text, params.memberIds);
    if (parsed.ok) return finish({ kind: 'answered', output: parsed.output });

    if (response.stopReason === 'max_tokens') return finish({ kind: 'exhausted', by: 'tokens' });
    if (repaired) return finish({ kind: 'invalid', problems: parsed.problems });
    repaired = true;
    // The API refuses an empty assistant turn, so an empty reply is echoed as a placeholder.
    messages.push({
      role: 'assistant',
      content:
        response.content.length > 0 ? response.content : [{ type: 'text', text: '(empty reply)' }],
    });
    messages.push({ role: 'user', content: repairMessage(parsed.problems) });
  }
}
