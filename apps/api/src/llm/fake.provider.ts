// A provider that answers from a script, for tests of everything above the port. It records what it was
// asked, so a test can check the conversation a harness built; running past the end of the script is an
// error, never a silent default.
import type { LlmResult } from '@ziro/core/llm';
import { type LlmProvider, type LlmRequest, LlmAbortedError } from './provider.js';

/** An answer, a failure to throw, or a function deciding from the request and the call number (from 1). */
export type FakeStep =
  LlmResult | Error | ((request: LlmRequest, call: number) => LlmResult | Error);

/** A plain end-of-turn reply; override what a test cares about. */
export function fakeResult(over: Partial<LlmResult> = {}): LlmResult {
  return {
    text: '',
    toolCalls: [],
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      thoughtTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    finishReason: 'stop',
    stopReason: 'fake_stop',
    requestId: null,
    ...over,
  };
}

export class FakeProvider implements LlmProvider {
  /** Every request received, in order. */
  readonly requests: LlmRequest[] = [];

  constructor(
    readonly name: string,
    private readonly script: readonly FakeStep[],
  ) {}

  complete(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    const call = this.requests.length;
    if (request.signal.aborted) return Promise.reject(new LlmAbortedError());
    const step = this.script[call - 1];
    if (step === undefined) {
      return Promise.reject(
        new Error(`FakeProvider "${this.name}": no scripted answer for call ${call}`),
      );
    }
    const answer = typeof step === 'function' ? step(request, call) : step;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }
}
