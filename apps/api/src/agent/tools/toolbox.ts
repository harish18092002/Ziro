// The nine tools as the model sees them, and the one place they are run. A call is: look the tool up,
// validate its arguments (zod is authoritative; the API's schema only guides the model), run it in its
// own READ ONLY transaction with a statement timeout, and cap what comes back. A mistake by the model
// becomes a tool_result error it can react to; a failure of ours (the database is down) is rethrown so
// the job fails and retries instead of the model concluding that a record "does not exist".
import { sql } from 'drizzle-orm';
import { feeContractOf } from '../../common/fee-contract.js';
import type { Executor } from '../../db/executor.js';
import type { LlmToolDef } from '@ziro/core/llm';
import { type JsonSchema, toAnthropicJsonSchema } from '../../llm/json-schema.js';
import { AGENT_TOOLS } from './definitions.js';
import { runConfigOf } from './repository.js';
import { type AgentTool, type ToolContext, ToolError, type ToolRun } from './types.js';

/**
 * What the model may be shown per call. Tools cap their own rows; this is the backstop. It is sized
 * so that a full set of calls cannot push a prompt past the pricing tier (see limits.test.ts).
 */
export const MAX_RESULT_CHARS = 12_000;
export const STATEMENT_TIMEOUT_MS = 5_000;
const MAX_ERROR_CHARS = 400;

/** A tool as plain JSON, for fingerprinting a prompt and for tests. What providers receive is `llmTools`. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
  readonly strict: true;
}

/** Postgres reports a statement that hit statement_timeout as SQLSTATE 57014, possibly wrapped. */
function isQueryCanceled(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === '57014') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function describeIssues(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  const text = error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? i.path.map(String).join('.') : 'arguments'}: ${i.message}`)
    .join('; ');
  return `invalid arguments: ${text}`.slice(0, MAX_ERROR_CHARS);
}

export class Toolbox {
  readonly definitions: readonly ToolDefinition[];
  /** The same tools in the provider-neutral form; each adapter converts the zod schema it needs. */
  readonly llmTools: readonly LlmToolDef[];
  private readonly byName: ReadonlyMap<string, AgentTool>;

  private constructor(
    private readonly db: Executor,
    private readonly runId: string,
    private readonly fees: ToolContext['fees'],
    tools: readonly AgentTool[],
  ) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
    this.llmTools = tools.map((t) => ({ name: t.name, description: t.description, input: t.args }));
    this.definitions = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toAnthropicJsonSchema(t.args),
      strict: true,
    }));
  }

  /** A toolbox scoped to one run. The fee contract is read once, from the run's own config. */
  static async create(
    db: Executor,
    runId: string,
    tools: readonly AgentTool[] = AGENT_TOOLS,
  ): Promise<Toolbox> {
    return new Toolbox(db, runId, feeContractOf(await runConfigOf(db, runId)), tools);
  }

  get toolNames(): string[] {
    return [...this.byName.keys()];
  }

  async run(name: string, input: unknown): Promise<ToolRun> {
    const tool = this.byName.get(name);
    if (tool === undefined) {
      return {
        ok: false,
        error: `unknown tool "${name.slice(0, 60)}"; use one of: ${this.toolNames.join(', ')}`,
      };
    }
    const parsed = tool.args.safeParse(input);
    if (!parsed.success) return { ok: false, error: describeIssues(parsed.error) };

    try {
      const output = await this.db.transaction(
        async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
          );
          return tool.execute(parsed.data, { tx, runId: this.runId, fees: this.fees });
        },
        { accessMode: 'read only' },
      );
      const content = JSON.stringify(output.data);
      if (content.length > MAX_RESULT_CHARS) {
        return {
          ok: false,
          error: `the result is too large (${content.length} characters); narrow the filters or lower the limit`,
        };
      }
      return { ok: true, content, summary: output.summary, seen: output.seen };
    } catch (error) {
      if (error instanceof ToolError)
        return { ok: false, error: error.message.slice(0, MAX_ERROR_CHARS) };
      if (isQueryCanceled(error)) {
        return { ok: false, error: 'the search took too long; narrow the filters' };
      }
      throw error;
    }
  }
}
