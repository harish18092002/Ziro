// What the model may say, and what the harness lets stand. The model returns `results`, one per
// exception it was given. Each result is checked against what the tools actually showed; a result that
// claims more than the evidence supports is downgraded to NEEDS_HUMAN, never repaired into a match.
// "Never claim a match the numbers don't support" is enforced here, in code, not just in the prompt.
import {
  AGENT_VERDICTS,
  type AgentProposalContent,
  agentProposalContentSchema,
  draftJournalEntrySchema,
  explanationSchema,
  JOURNAL_ACCOUNTS,
  type ReasonCode,
  reasonCodeSchema,
  type RecordRef,
  recordRefSchema,
  SUGGESTED_ACTIONS,
} from '@ziro/core/domain';
import { z } from 'zod';
import { type JsonSchema, toAnthropicJsonSchema } from '../llm/json-schema.js';
import type { AgentToolName } from './tools/types.js';

/** Most exceptions one conversation may cover (CLUSTER_EXCEPTIONS). */
export const MAX_CLUSTER_MEMBERS = 6;
/** Below this the model is unsure enough that the next model up looks again. */
export const ESCALATION_CONFIDENCE = 0.7;
/** A conclusion the harness had to downgrade is not trusted above this. */
const DOWNGRADED_CONFIDENCE = 0.3;
const MAX_FINDING_CHARS = 300;

const digits = z.string().regex(/^\d{1,15}$/, 'integer paise as digits, e.g. "250000"');

const journalLine = z.strictObject({
  account: z.enum(JOURNAL_ACCOUNTS),
  debit: digits,
  credit: digits,
});

export const modelResultSchema = z.strictObject({
  exceptionId: z.uuid(),
  verdict: z.enum(AGENT_VERDICTS),
  reasonCode: reasonCodeSchema,
  links: z.array(recordRefSchema).max(50),
  explanation: explanationSchema,
  evidence: z
    .array(
      z.strictObject({
        call: z.number().int().min(0).max(20),
        keyFinding: z.string().min(1).max(300),
      }),
    )
    .max(20),
  confidence: z.number().min(0).max(1),
  suggestedAction: z.enum(SUGGESTED_ACTIONS),
  draftJournalEntry: z
    .strictObject({
      memo: z.string().min(1).max(200),
      lines: z.array(journalLine).min(2).max(10),
    })
    .nullable(),
});
export type ModelResult = z.output<typeof modelResultSchema>;

export const modelOutputSchema = z.strictObject({
  results: z.array(modelResultSchema).min(1).max(MAX_CLUSTER_MEMBERS),
});
export type ModelOutput = z.output<typeof modelOutputSchema>;

/** The schema sent to the API as the output format. Built once; it must stay byte-identical. */
export const OUTPUT_JSON_SCHEMA: JsonSchema = toAnthropicJsonSchema(modelOutputSchema);

// --- what happened during the investigation ---------------------------------------------------

/** One tool call as the harness saw it. Call 0 is the exception brief fetched before the first turn. */
export interface CallRecord {
  readonly n: number;
  readonly tool: AgentToolName;
  readonly args: Record<string, unknown>;
  readonly ok: boolean;
  /** Deterministic, harness-written: what the call found, or why it failed. */
  readonly summary: string;
  /** The records the result showed: the only ones the model may cite. */
  readonly seen: readonly RecordRef[];
}

export interface Subject {
  readonly exceptionId: string;
  /** What the matching rules concluded: the fallback when the model's own conclusion is unusable. */
  readonly ruleReasonCode: ReasonCode;
}

export interface Finalized {
  readonly content: AgentProposalContent;
  /** Everything the harness changed or limited, for the reviewer. */
  readonly findings: string[];
}

const refKey = (r: RecordRef): string => `${r.recordType}:${r.recordId}`;
const clip = (text: string): string =>
  text.length > MAX_FINDING_CHARS ? `${text.slice(0, MAX_FINDING_CHARS - 3)}...` : text;

function seenKeys(calls: readonly CallRecord[]): Set<string> {
  return new Set(calls.filter((c) => c.ok).flatMap((c) => c.seen.map(refKey)));
}

/** Evidence the harness writes itself, from the calls made: used when the model could not conclude. */
function evidenceFromCalls(calls: readonly CallRecord[]): AgentProposalContent['evidence'] {
  return calls
    .filter((c) => c.ok && c.n > 0)
    .slice(0, 20)
    .map((c) => ({ tool: c.tool, args: c.args, keyFinding: clip(c.summary) }));
}

/**
 * NEEDS_HUMAN with whatever was gathered, for a budget that ran out, a refusal or unusable output.
 * `why` is a short harness-written phrase ("the time budget ran out"); it never quotes the model.
 */
export function needsHuman(subject: Subject, why: string, calls: readonly CallRecord[]): Finalized {
  const evidence = evidenceFromCalls(calls);
  const content = agentProposalContentSchema.parse({
    exceptionId: subject.exceptionId,
    verdict: 'NEEDS_HUMAN',
    reasonCode: subject.ruleReasonCode,
    links: [],
    explanation: `The investigation stopped before reaching a conclusion: ${why}. ${
      evidence.length === 0
        ? 'No tool had been run yet, so there is no evidence beyond the exception itself.'
        : 'The evidence gathered so far is attached.'
    }`,
    evidence,
    confidence: 0,
    suggestedAction: 'NONE',
    draftJournalEntry: null,
  });
  return { content, findings: [clip(`investigation stopped: ${why}`)] };
}

export type ParsedOutput =
  | { readonly ok: true; readonly output: ModelOutput }
  | { readonly ok: false; readonly problems: string[] };

/** A reply is JSON, but a model sometimes wraps it in a code fence; that much is forgiven. */
function unfence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/** Parses and validates a reply, and checks it answers for exactly the exceptions that were asked about. */
export function parseModelOutput(text: string, expectedIds: readonly string[]): ParsedOutput {
  let json: unknown;
  try {
    json = JSON.parse(unfence(text));
  } catch {
    return { ok: false, problems: ['the reply is not valid JSON'] };
  }
  const parsed = modelOutputSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'reply'}: ${i.message}`),
    };
  }
  const problems: string[] = [];
  const expected = new Set(expectedIds);
  const answered = new Set<string>();
  for (const r of parsed.data.results) {
    if (!expected.has(r.exceptionId))
      problems.push(`${r.exceptionId} is not an exception you were given`);
    else if (answered.has(r.exceptionId))
      problems.push(`${r.exceptionId} has more than one result`);
    answered.add(r.exceptionId);
  }
  for (const id of expected) if (!answered.has(id)) problems.push(`there is no result for ${id}`);
  return problems.length > 0 ? { ok: false, problems } : { ok: true, output: parsed.data };
}

/** Turns what the model said about one exception into what may be stored, with the reasons for any change. */
export function finalizeResult(
  result: ModelResult,
  subject: Subject,
  calls: readonly CallRecord[],
): Finalized {
  const findings: string[] = [];
  const note = (text: string) => findings.push(clip(text));
  const seen = seenKeys(calls);
  const byNumber = new Map(calls.filter((c) => c.ok && c.n > 0).map((c) => [c.n, c]));
  const brief = calls.find(
    (c) => c.ok && c.n === 0 && c.args['exception_id'] === result.exceptionId,
  );

  // Evidence: each item must point at a real, successful call; the harness fills in tool and args.
  const evidence: AgentProposalContent['evidence'] = [];
  for (const item of result.evidence) {
    const call = item.call === 0 ? brief : byNumber.get(item.call);
    if (call === undefined) {
      note(`evidence cited call ${item.call}, which does not exist or failed; it was dropped`);
      continue;
    }
    evidence.push({ tool: call.tool, args: call.args, keyFinding: item.keyFinding });
  }

  // Links: only records a tool actually returned.
  const unseen = result.links.filter((l) => !seen.has(refKey(l)));
  const links = result.links.filter((l) => seen.has(refKey(l)));
  if (unseen.length > 0) {
    note(
      `${unseen.length} linked record(s) were never returned by a tool: ${unseen.map((l) => l.recordId).join(', ')}`,
    );
  }

  // A draft entry must balance to the paise; an unbalanced one is dropped, not fixed.
  let journal: AgentProposalContent['draftJournalEntry'] = null;
  if (result.draftJournalEntry !== null) {
    const parsed = draftJournalEntrySchema.safeParse(result.draftJournalEntry);
    if (parsed.success) journal = parsed.data;
    else
      note('the draft journal entry was dropped: it is not a balanced entry of positive amounts');
  }

  let { verdict, suggestedAction, confidence } = result;
  const downgrade = (reason: string) => {
    note(`downgraded to NEEDS_HUMAN: ${reason}`);
    verdict = 'NEEDS_HUMAN';
    suggestedAction = 'NONE';
    confidence = Math.min(confidence, DOWNGRADED_CONFIDENCE);
  };

  if (verdict === 'MATCH_PROPOSED') {
    if (unseen.length > 0) downgrade('the match names records the agent never retrieved');
    else if (links.length < 2) downgrade('a match links at least two records');
  }
  if (verdict !== 'NEEDS_HUMAN' && evidence.length === 0) {
    downgrade('no valid evidence supports the conclusion');
  }
  if (suggestedAction === 'ACCEPT_MATCH' && verdict !== 'MATCH_PROPOSED') {
    note('ACCEPT_MATCH was changed to NONE: only a proposed match can be accepted');
    suggestedAction = 'NONE';
  }
  if (suggestedAction === 'ACCEPT_MATCH' && confidence < 0.5) {
    note('ACCEPT_MATCH was changed to NONE: confidence is below 0.5');
    suggestedAction = 'NONE';
  }

  const parsed = agentProposalContentSchema.safeParse({
    exceptionId: result.exceptionId,
    verdict,
    reasonCode: result.reasonCode,
    links,
    explanation: result.explanation,
    evidence,
    confidence,
    suggestedAction,
    draftJournalEntry: journal,
  });
  if (!parsed.success) {
    // The checks above should make this unreachable; if not, fail safe rather than store it.
    return needsHuman(
      subject,
      `the result failed final validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      calls,
    );
  }
  return { content: parsed.data, findings };
}

/** Whether a finalized result is worth a second look by a larger model. */
export function wantsEscalation(content: AgentProposalContent): boolean {
  return content.verdict === 'NEEDS_HUMAN' || content.confidence < ESCALATION_CONFIDENCE;
}

/** Tool name and what it found, one line per successful call: carried into an escalated conversation. */
export function digestOf(calls: readonly CallRecord[]): string {
  return calls
    .filter((c) => c.ok && c.n > 0)
    .map((c) => `call ${c.n} (${c.tool}): ${c.summary}`)
    .join('\n');
}
