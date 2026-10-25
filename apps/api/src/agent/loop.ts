// Harness A: a hand-rolled tool-use loop. One conversation, append-only, until the model gives a final
// reply or a budget runs out. The loop decides nothing about money; it moves messages, runs the
// read-only tools the model asks for, counts, and stops. Everything the model claims is checked
// afterwards (output.ts), and again by the verifier later.
//
// The loop talks to a SESSION (llm/router.ts): one model, chosen by the router, for this whole
// conversation. If that model fails in a way another one might not, the session throws and the router runs
// the loop again from its first message on the next model, so the history is never mixed.
//
// Rules the loop keeps:
//  - the model's turn goes back unchanged (thinking blocks and signed thoughts are bound to their turn);
//  - a budget is checked before every request, and a spent budget ends the investigation without
//    another model call;
//  - the final reply may be repaired once; a second bad reply ends it. A provider-side MALFORMED reply
//    (a broken tool call) gets the same single repair;
//  - a refusal or a safety block ends it. Nothing here retries one or reasons around it.
import { LlmError, type LlmMessage, type LlmToolResult } from '@ziro/core/llm';
import { LlmAbortedError } from '../llm/provider.js';
import type { LlmSession, SessionAnswer } from '../llm/router.js';
import { Budget, type Limits } from './budget.js';
import type { LoopEnd, LoopOutcome } from './outcome.js';
import { type CallRecord, modelOutputSchema, parseModelOutput } from './output.js';
import { NO_MORE_TOOLS_NOTICE, promptHash, repairMessage } from './prompt.js';
import { runToolCall } from './tool-call.js';
import type { InvestigationContext } from './types.js';

export type { LoopEnd, LoopOutcome };

export interface LoopParams {
  readonly session: LlmSession;
  readonly ctx: Pick<InvestigationContext, 'toolbox' | 'gate'>;
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

const MALFORMED_REPAIR = 'the previous reply was malformed or incomplete';

export async function runLoop(params: LoopParams): Promise<LoopOutcome> {
  const { session, ctx, limits } = params;
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

    let answer: SessionAnswer;
    try {
      answer = await session.complete(
        {
          system: params.system,
          // The array is read when the request is made; a copy keeps a recorded request what was sent.
          messages: [...messages],
          tools: ctx.toolbox.llmTools,
          maxOutputTokens: budget.nextMaxTokens(),
          output: modelOutputSchema,
          signal: AbortSignal.timeout(Math.max(1, budget.msLeft)),
        },
        { harness: 'loop', exceptionId: params.attributedTo, promptHash: hash },
      );
    } catch (error) {
      if (error instanceof LlmAbortedError) return finish({ kind: 'exhausted', by: 'time' });
      if (error instanceof LlmError) {
        if (error.kind === 'SAFETY_BLOCKED') return finish({ kind: 'refused' });
        if (error.kind === 'BAD_REQUEST') {
          return finish({
            kind: 'rejected',
            reason: `the model API refused the request (${error.message})`,
          });
        }
        if (error.kind === 'MALFORMED') {
          if (repaired) return finish({ kind: 'invalid', problems: [MALFORMED_REPAIR] });
          repaired = true;
          messages.push({ role: 'user', content: repairMessage([MALFORMED_REPAIR]) });
          continue;
        }
      }
      throw error; // a failure another model might not have: the router decides
    }

    const { result } = answer;
    lastLlmCallId = answer.callId ?? lastLlmCallId;
    budget.addUsage(
      result.usage.outputTokens + result.usage.thoughtTokens,
      result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens,
    );

    if (result.finishReason === 'refusal') return finish({ kind: 'refused' });
    if (result.finishReason === 'context') return finish({ kind: 'exhausted', by: 'context' });

    // A reply cut off by the token limit may still be complete JSON; anything else cut off is unusable,
    // and a half-written tool call must never be executed.
    const toolCalls = result.finishReason === 'length' ? [] : result.toolCalls;

    if (toolCalls.length > 0) {
      if (budget.toolCallsLeft === 0) return finish({ kind: 'exhausted', by: 'tool_calls' });
      messages.push({
        role: 'assistant',
        text: result.text,
        toolCalls,
        ...(result.native === undefined ? {} : { native: result.native }),
      });
      const results: LlmToolResult[] = [];
      for (const call of toolCalls) {
        if (budget.toolCallsLeft === 0) {
          results.push({
            callId: call.id,
            name: call.name,
            content: 'not run: the tool-call budget is spent',
            isError: true,
          });
          continue;
        }
        budget.useToolCall();
        const done = await runToolCall(ctx.toolbox, call.name, call.args, budget.toolCallsUsed);
        results.push({
          callId: call.id,
          name: call.name,
          content: done.text,
          ...(done.isError ? { isError: true } : {}),
        });
        if (done.record !== null) calls.push(done.record);
      }
      messages.push({
        role: 'tool',
        results,
        ...(budget.toolCallsLeft === 0 ? { notice: NO_MORE_TOOLS_NOTICE } : {}),
      });
      continue;
    }

    if (result.finishReason === 'pause') {
      messages.push({
        role: 'assistant',
        text: result.text,
        toolCalls: [],
        ...(result.native === undefined ? {} : { native: result.native }),
      });
      continue;
    }

    const parsed = parseModelOutput(result.text, params.memberIds);
    if (parsed.ok) return finish({ kind: 'answered', output: parsed.output });

    if (result.finishReason === 'length') return finish({ kind: 'exhausted', by: 'tokens' });
    if (repaired) return finish({ kind: 'invalid', problems: parsed.problems });
    repaired = true;
    // An empty assistant turn is refused by the APIs; the adapters echo an empty reply as a placeholder.
    messages.push({
      role: 'assistant',
      text: result.text,
      toolCalls: [],
      ...(result.native === undefined ? {} : { native: result.native }),
    });
    messages.push({ role: 'user', content: repairMessage(parsed.problems) });
  }
}
