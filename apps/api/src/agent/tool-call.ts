// One tool call, run through the toolbox and turned into what the model reads and what the harness keeps.
// Shared by both harnesses, so a call is numbered, worded and recorded the same way whichever one made it.
import type { CallRecord } from './output.js';
import { AGENT_TOOLS } from './tools/definitions.js';
import type { Toolbox } from './tools/toolbox.js';
import type { AgentToolName } from './tools/types.js';

const TOOL_NAMES: ReadonlySet<string> = new Set(AGENT_TOOLS.map((t) => t.name));

const asArgs = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

export interface ToolCallResult {
  /** What the model is shown. */
  readonly text: string;
  readonly isError: boolean;
  /** The harness's record of the call; null when the tool does not exist (nothing to cite). */
  readonly record: CallRecord | null;
  /** The tool's JSON on success, for a harness that needs to read it; null on failure. */
  readonly content: string | null;
}

export async function runToolCall(
  toolbox: Toolbox,
  name: string,
  input: unknown,
  n: number,
): Promise<ToolCallResult> {
  const outcome = await toolbox.run(name, input);
  const known = TOOL_NAMES.has(name);
  if (!outcome.ok) {
    return {
      text: `call ${n} failed: ${outcome.error}`,
      isError: true,
      content: null,
      record: known
        ? {
            n,
            tool: name as AgentToolName,
            args: asArgs(input),
            ok: false,
            summary: `failed: ${outcome.error}`,
            seen: [],
          }
        : null,
    };
  }
  return {
    text: `call ${n}:\n${outcome.content}`,
    isError: false,
    content: outcome.content,
    record: {
      n,
      tool: name as AgentToolName,
      args: asArgs(input),
      ok: true,
      summary: outcome.summary,
      seen: outcome.seen,
    },
  };
}
