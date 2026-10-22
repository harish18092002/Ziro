// Test support: a model that says exactly what a test scripts, and remembers what it was asked.
import { randomUUID } from 'node:crypto';
import type { AssistantBlock, LlmClient, LlmRequest, LlmResponse } from './llm.js';
import type { ModelResult } from './output.js';
import type { Usage } from './pricing.js';
import type { Toolbox } from './tools/toolbox.js';
import type { InvestigationContext, LlmCallRecord } from './types.js';

export const USAGE: Usage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export type Step =
  | LlmResponse
  | Error
  | ((request: LlmRequest, index: number) => LlmResponse | Promise<LlmResponse>);

export class ScriptedLlm implements LlmClient {
  /** Each request as it was when sent (the loop keeps appending to the same message array). */
  readonly requests: LlmRequest[] = [];
  private index = 0;

  constructor(private readonly steps: readonly Step[]) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.steps[this.index];
    this.index += 1;
    if (step === undefined) throw new Error(`the script has no step for request ${this.index}`);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(request, this.index - 1) : step;
  }

  get calls(): number {
    return this.requests.length;
  }
}

export const toolUse = (id: string, name: string, input: unknown): AssistantBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
});

/** A response that asks for tools. */
export function asksFor(blocks: AssistantBlock[], over: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: blocks,
    stopReason: 'tool_use',
    usage: USAGE,
    requestId: `req_${randomUUID().slice(0, 8)}`,
    ...over,
  };
}

/** A response that ends the turn with this text. */
export function says(text: string, over: Partial<LlmResponse> = {}): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: USAGE,
    requestId: `req_${randomUUID().slice(0, 8)}`,
    ...over,
  };
}

export const replyWith = (
  results: readonly Partial<ModelResult>[],
  over: Partial<LlmResponse> = {},
): LlmResponse => says(JSON.stringify({ results }), over);

/** A well-formed result that cites call 0; tests override what they care about. */
export function result(exceptionId: string, over: Partial<ModelResult> = {}): ModelResult {
  return {
    exceptionId,
    verdict: 'EXPLAINED_NO_MATCH',
    reasonCode: 'DUPLICATE_PAYMENT',
    links: [],
    explanation: 'Two captured payments share one order.',
    evidence: [{ call: 0, keyFinding: 'The rules found two candidate payments.' }],
    confidence: 0.9,
    suggestedAction: 'REFUND_CUSTOMER',
    draftJournalEntry: null,
    ...over,
  };
}

export interface TestContext extends InvestigationContext {
  readonly recorded: LlmCallRecord[];
  gateCalls: number;
}

/** An investigation context that keeps llm calls in memory instead of the database. */
export function testContext(
  toolbox: Toolbox,
  runId: string,
  gate: () => Promise<void> = () => Promise.resolve(),
): TestContext {
  const recorded: LlmCallRecord[] = [];
  const ctx: TestContext = {
    runId,
    toolbox,
    recorded,
    gateCalls: 0,
    gate() {
      ctx.gateCalls += 1;
      return gate();
    },
    recordLlmCall(call) {
      recorded.push(call);
      return Promise.resolve(`call-${recorded.length}`);
    },
  };
  return ctx;
}
