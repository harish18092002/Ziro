// The words for each reason an investigation was handed to a person without a conclusion. The codes
// themselves live in @ziro/core/domain (the database constrains the column to them). A model that
// concludes "I cannot tell" is not degraded: it answered. Degraded means the harness stopped, was
// refused, or got nothing usable.
import { DEGRADED_REASONS, type DegradedReason } from '@ziro/core/domain';

export { DEGRADED_REASONS, type DegradedReason };

/** One short line for a person; the same words in the console, the report and the docs. */
export const DEGRADED_LABEL: Record<DegradedReason, string> = {
  model_unavailable: 'the model API did not answer',
  model_rejected: 'the model API refused the request',
  invalid_reply: 'the model’s reply was not valid',
  tool_budget: 'ran out of tool calls',
  token_budget: 'ran out of output tokens',
  time_budget: 'ran out of time',
  context: 'the conversation grew too long',
  refused: 'the model declined to answer',
};
