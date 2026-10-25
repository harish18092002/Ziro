// Harness B ("single-shot"): the harness gathers the evidence itself, with the same read-only tools in a
// fixed order, and makes ONE structured-output call with no tools. A tool-use loop costs a request per
// step; on a free tier with a daily request allowance that is the scarce thing, and for most exceptions the
// evidence needed is predictable from the brief: the records the rules found, their refunds and settlement,
// the arithmetic, the fee contract. A harness that fetches those unconditionally uses one request where the
// loop uses four to nine.
//
// Everything that makes the loop safe is kept: the same tools (read-only, run-scoped, size-capped), the same
// numbering of calls (the brief is call 0, the evidence is calls 1..n), the same `<untrusted>` wrapping of
// free text, the same zod-validated reply, grounding and verifier. What changes is only WHO chooses the
// calls. A model that needs something the bundle lacks says NEEDS_HUMAN and names it, which is a good answer.
//
// One request normally; a second only to repair a reply that was not valid JSON, the same single repair the
// loop allows.
import { LlmError, type LlmMessage } from '@ziro/core/llm';
import { z } from 'zod';
import { LlmAbortedError } from '../llm/provider.js';
import type { LlmRouter, LlmSession, SessionAnswer } from '../llm/router.js';
import { type Limits, DEFAULT_LIMITS, Budget } from './budget.js';
import { fetchBriefs, type LoopOutcome } from './outcome.js';
import { type CallRecord, modelOutputSchema, parseModelOutput } from './output.js';
import { type Brief, firstMessage, promptHash, repairMessage, systemPrompt } from './prompt.js';
import { runRouted } from './routed.js';
import { runToolCall } from './tool-call.js';
import type { Toolbox } from './tools/toolbox.js';
import type { AgentToolName } from './tools/types.js';
import type {
  AgentRunner,
  ExceptionToInvestigate,
  InvestigationContext,
  ProposalDraft,
} from './types.js';

/** Most lookups made for one conversation, the arithmetic and the fee contract included. */
export const MAX_EVIDENCE_CALLS = 12;
/** Kept free for the two lookups that come last. */
const RESERVED_FOR_SUMMARY = 2;

const refSchema = z.looseObject({ type: z.string(), id: z.string() });
const briefSchema = z.looseObject({
  subject: refSchema.nullable().optional(),
  candidates: z.array(refSchema).optional(),
});

/** The records a brief names, subject first, each once. */
function refsOf(briefs: readonly Brief[]): { type: string; id: string }[] {
  const seen = new Set<string>();
  const refs: { type: string; id: string }[] = [];
  for (const brief of briefs) {
    let json: unknown;
    try {
      json = JSON.parse(brief.json);
    } catch {
      continue;
    }
    const parsed = briefSchema.safeParse(json);
    if (!parsed.success) continue;
    for (const ref of [parsed.data.subject, ...(parsed.data.candidates ?? [])]) {
      if (ref === null || ref === undefined) continue;
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ type: ref.type, id: ref.id });
    }
  }
  return refs;
}

const paymentsSchema = z.looseObject({
  payments: z.array(z.looseObject({ method: z.string(), amountPaise: z.string() })).min(1),
});
const refundsSchema = z.looseObject({ refunds: z.array(z.looseObject({ id: z.string() })) });

function parsed<T extends z.ZodType>(schema: T, content: string | null): z.output<T> | null {
  if (content === null) return null;
  try {
    const result = schema.safeParse(JSON.parse(content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export interface Evidence {
  /** Call 0 and every lookup after it, in order: what grounding checks the reply against. */
  readonly calls: readonly CallRecord[];
  /** The lookups as the model reads them. */
  readonly text: string;
}

// Structural tags of the prompt. Free text is already defanged for its own <untrusted> tag; the evidence is
// also put between tags in a user message, so the tags around it cannot be closable from inside it either.
const defang = (text: string): string =>
  text.replace(/<(\s*\/?\s*(evidence|exceptions|brief|earlier_calls))/gi, '&lt;$1');

/**
 * The fixed lookups for a set of briefs, in a fixed order: each ledger entry; each payment and its refunds;
 * each settlement's composition; then the expected settlement of the payments found, and the fee contract
 * for the first of them. Capped at MAX_EVIDENCE_CALLS. A lookup that fails is shown as failed, as in the loop.
 */
export async function gatherEvidence(
  toolbox: Toolbox,
  briefs: readonly Brief[],
  briefCalls: readonly CallRecord[],
): Promise<Evidence> {
  const calls: CallRecord[] = [...briefCalls];
  const blocks: string[] = [];
  let n = 0;

  const look = async (tool: AgentToolName, args: Record<string, unknown>) => {
    n += 1;
    const done = await runToolCall(toolbox, tool, args, n);
    if (done.record !== null) calls.push(done.record);
    blocks.push(`${tool} ${JSON.stringify(args)}\n${done.text}`);
    return done;
  };

  const payments: string[] = [];
  const settlements: string[] = [];
  const refunds: string[] = [];
  let firstPayment: { method: string; amount: number } | null = null;

  for (const ref of refsOf(briefs)) {
    if (n >= MAX_EVIDENCE_CALLS - RESERVED_FOR_SUMMARY) break;
    if (ref.type === 'ledger_entry') {
      await look('get_ledger_entry', { id: ref.id });
    } else if (ref.type === 'rzp_payment') {
      const got = await look('get_payment', { id: ref.id });
      payments.push(ref.id);
      const one = parsed(paymentsSchema, got.content)?.payments[0];
      const amount = one === undefined ? Number.NaN : Number(one.amountPaise);
      if (firstPayment === null && one !== undefined && Number.isSafeInteger(amount)) {
        firstPayment = { method: one.method, amount };
      }
      if (n < MAX_EVIDENCE_CALLS - RESERVED_FOR_SUMMARY) {
        const listed = await look('list_refunds', { payment_id: ref.id });
        refunds.push(...(parsed(refundsSchema, listed.content)?.refunds ?? []).map((r) => r.id));
      }
    } else if (ref.type === 'rzp_settlement') {
      await look('get_settlement_composition', { settlement_id: ref.id });
      settlements.push(ref.id);
    }
  }

  if (payments.length > 0 && n < MAX_EVIDENCE_CALLS) {
    await look('compute_expected_settlement', {
      payment_ids: payments,
      refund_ids: refunds,
      adjustment_ids: [],
      ...(settlements.length === 1 && settlements[0] !== undefined
        ? { settlement_id: settlements[0] }
        : {}),
    });
  }
  if (firstPayment !== null && n < MAX_EVIDENCE_CALLS) {
    await look('get_fee_contract', {
      method: firstPayment.method,
      amount_paise: firstPayment.amount,
    });
  }
  return { calls, text: defang(blocks.join('\n\n')) };
}

export interface ShotParams {
  readonly session: LlmSession;
  readonly ctx: Pick<InvestigationContext, 'toolbox' | 'gate'>;
  readonly limits: Limits;
  readonly briefs: readonly Brief[];
  readonly evidence: Evidence;
  readonly memberIds: readonly string[];
  readonly attributedTo: string | null;
  readonly now?: () => number;
}

/** One structured-output request with no tools, and at most one repair of an invalid reply. */
export async function runShot(params: ShotParams): Promise<LoopOutcome> {
  const { session, ctx, limits, evidence } = params;
  const now = params.now ?? Date.now;
  const budget = new Budget(limits, now);
  const system = systemPrompt(limits, 'single-shot');
  const opening = firstMessage(params.briefs, undefined, evidence.text);
  const hash = promptHash(system, JSON.stringify(ctx.toolbox.definitions), opening);
  const messages: LlmMessage[] = [{ role: 'user', content: opening }];
  let lastLlmCallId: string | null = null;
  let repaired = false;

  const finish = (end: LoopOutcome['end']): LoopOutcome => ({
    end,
    calls: evidence.calls,
    lastLlmCallId,
  });

  for (;;) {
    const spent = budget.exhausted();
    if (spent !== null) return finish({ kind: 'exhausted', by: spent });
    await ctx.gate();

    let answer: SessionAnswer;
    try {
      answer = await session.complete(
        {
          system,
          messages: [...messages],
          tools: [],
          maxOutputTokens: budget.nextMaxTokens(),
          output: modelOutputSchema,
          signal: AbortSignal.timeout(Math.max(1, budget.msLeft)),
        },
        { harness: 'single-shot', exceptionId: params.attributedTo, promptHash: hash },
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
          if (repaired) return finish({ kind: 'invalid', problems: ['the reply was malformed'] });
          repaired = true;
          messages.push({
            role: 'user',
            content: repairMessage(['the previous reply was malformed or incomplete']),
          });
          continue;
        }
      }
      throw error;
    }

    const { result } = answer;
    lastLlmCallId = answer.callId ?? lastLlmCallId;
    budget.addUsage(
      result.usage.outputTokens + result.usage.thoughtTokens,
      result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens,
    );
    if (result.finishReason === 'refusal') return finish({ kind: 'refused' });
    if (result.finishReason === 'context') return finish({ kind: 'exhausted', by: 'context' });

    const reply = parseModelOutput(result.text, params.memberIds);
    if (reply.ok) return finish({ kind: 'answered', output: reply.output });
    if (result.finishReason === 'length') return finish({ kind: 'exhausted', by: 'tokens' });
    if (repaired) return finish({ kind: 'invalid', problems: reply.problems });
    repaired = true;
    messages.push({
      role: 'assistant',
      text: result.text,
      toolCalls: [],
      ...(result.native === undefined ? {} : { native: result.native }),
    });
    messages.push({ role: 'user', content: repairMessage(reply.problems) });
  }
}

export interface SingleShotRunnerOptions {
  readonly router: LlmRouter;
  /** Allow one second look by the next model in the chain when the first is unsure. */
  readonly escalation: boolean;
  readonly limits?: Limits;
  readonly now?: () => number;
}

export class SingleShotRunner implements AgentRunner {
  readonly harness = 'single-shot' as const;
  private readonly limits: Limits;

  constructor(private readonly options: SingleShotRunnerOptions) {
    this.limits = options.limits ?? DEFAULT_LIMITS;
  }

  async investigate(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
  ): Promise<ProposalDraft[]> {
    const { briefCalls, briefs } = await fetchBriefs(members, ctx);
    // Gathered at most once, and only if a model is going to be asked: an exhausted chain answers a person
    // at once without reading the database for evidence nobody will see.
    let gathered: Promise<Evidence> | undefined;
    const evidence = (): Promise<Evidence> =>
      (gathered ??= gatherEvidence(ctx.toolbox, briefs, briefCalls));

    return runRouted({
      router: this.options.router,
      ctx,
      members,
      briefCalls,
      escalation: this.options.escalation,
      attempt: async (session) =>
        runShot({
          session,
          ctx,
          limits: this.limits,
          briefs,
          evidence: await evidence(),
          memberIds: members.map((m) => m.id),
          attributedTo: members.length === 1 ? (members[0]?.id ?? null) : null,
          ...(this.options.now === undefined ? {} : { now: this.options.now }),
        }),
    });
  }
}
