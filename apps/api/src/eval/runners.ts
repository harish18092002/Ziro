// The four configurations as AgentRunners. `rules` has none: the rules run alone.
//
//   small     harness A on the small model, no escalation
//   large     harness A on the large model, no escalation (the API's default effort; the product's second
//             look uses a higher one, so this is the large model on its own, not the product's escalation)
//   harnessB  the Claude Agent SDK on the small model, so that comparing it with `small` isolates the harness
//
// Escalation is off in the eval so that each row measures one model. The product's default (small, then
// large when unsure) is a fifth configuration that is not run unless asked for.
import { AnthropicLlmClient } from '../agent/anthropic-client.js';
import { LoopRunner } from '../agent/loop-runner.js';
import { SdkRunner } from '../agent/sdk-runner.js';
import type { AgentRunner, RunnerTelemetry } from '../agent/types.js';
import type { ConfigName } from '@ziro/evals';

export interface ModelSettings {
  readonly apiKey: string;
  readonly small: string;
  readonly large: string;
}

/** The model a config calls, or null when it calls none. */
export function modelFor(
  config: ConfigName,
  m: Pick<ModelSettings, 'small' | 'large'>,
): string | null {
  switch (config) {
    case 'rules':
      return null;
    case 'large':
      return m.large;
    default:
      return m.small;
  }
}

export interface Built {
  readonly runner: AgentRunner | null;
  readonly close: () => void;
}

export function buildRunner(
  config: ConfigName,
  m: ModelSettings,
  telemetry: RunnerTelemetry,
): Built {
  switch (config) {
    case 'rules':
      return { runner: null, close: () => undefined };
    case 'small':
    case 'large': {
      const model = config === 'small' ? m.small : m.large;
      return {
        runner: new LoopRunner({
          client: AnthropicLlmClient.fromApiKey(m.apiKey),
          smallModel: model,
          largeModel: model,
          escalation: false,
        }),
        close: () => undefined,
      };
    }
    case 'harnessB': {
      const runner = new SdkRunner({ apiKey: m.apiKey, model: m.small, telemetry });
      return { runner, close: () => runner.close() };
    }
  }
}
