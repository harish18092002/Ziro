// A deterministic stand-in for the agent, for the free demo. It is NOT a language model and says so
// everywhere it appears: its proposals carry the model name `scripted-baseline`. What it shares with
// the real agent is everything that matters for the demo to be honest: it reads the records only
// through the same read-only tools, its evidence is those tool calls (real call numbers, real results),
// and its answers pass through the same `finalizeResult` grounding, so a claim about a record it never
// looked at is downgraded exactly as the real agent's would be. Then storage, the verifier, the policy
// and the review queue run for real.
//
// It also builds two PLANTED proposals: the kind of confident, grounded, wrong guess a real model can
// make. They exist so a visitor sees the verifier refuse something. They are labelled as planted.
import type { RecordRef, RecordType } from '@ziro/core/domain';
import { formatRupees, paise } from '@ziro/core/money';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  type CallRecord,
  finalizeResult,
  type ModelResult,
  needsHuman,
  type Subject,
} from '../agent/output.js';
import type { AgentToolName } from '../agent/tools/types.js';
import type {
  AgentRunner,
  ExceptionToInvestigate,
  InvestigationContext,
  ProposalDraft,
} from '../agent/types.js';
import type { Executor } from '../db/executor.js';
import {
  ledgerEntries,
  matchGroups,
  matchLinks,
  reconExceptions,
  rzpPayments,
} from '../db/schema.js';

export const SCRIPTED_MODEL = 'scripted-baseline';
export const PLANTED_MODEL = 'planted-for-demo';
export const PLANTED_NOTE = 'planted by the demo to show the verifier; this is not model output';

const rupees = (paiseText: string): string =>
  formatRupees(paise(BigInt(paiseText)), { symbol: true });

interface Brief {
  readonly type: string;
  readonly id: string;
  readonly key: string;
  readonly amountPaise: string;
  readonly date: string | null;
  readonly note?: string;
}
interface ExceptionView {
  readonly cause: string | null;
  readonly subject: Brief | null;
  readonly candidates: readonly Brief[];
}

const refOf = (b: Brief): RecordRef => ({ recordType: b.type as RecordType, recordId: b.id });

/** Cheap similarity between two UTRs: containment of a fragment scores 1; otherwise the edit distance. */
const norm = (utr: string): string => utr.toUpperCase().replace(/[^A-Z0-9]/g, '');
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      row[j] = Math.min(
        above + 1,
        (row[j - 1] ?? 0) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}
export function utrScore(settlementUtr: string, bankUtr: string | null): number {
  if (bankUtr === null) return Number.POSITIVE_INFINITY;
  const a = norm(settlementUtr);
  const b = norm(bankUtr);
  if (a.length === 0 || b.length === 0) return Number.POSITIVE_INFINITY;
  if (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a))) return 1;
  return editDistance(a, b);
}

type Journal = NonNullable<ModelResult['draftJournalEntry']>;
type Answer = Pick<
  ModelResult,
  'verdict' | 'reasonCode' | 'links' | 'explanation' | 'evidence' | 'confidence' | 'suggestedAction'
> & { draftJournalEntry?: Journal };

/** A two-line entry that moves `amount` paise from the credited account to the debited one. */
const transfer = (
  memo: string,
  debit: Journal['lines'][number]['account'],
  credit: Journal['lines'][number]['account'],
  amount: bigint,
): Journal => ({
  memo,
  lines: [
    { account: debit, debit: amount.toString(), credit: '0' },
    { account: credit, debit: '0', credit: amount.toString() },
  ],
});

/** One investigation: the calls made so far, numbered exactly as the real agent's are. */
class Session {
  readonly calls: CallRecord[] = [];
  private next = 1;
  constructor(private readonly ctx: InvestigationContext) {}

  /** Runs a tool, records the call, and returns its parsed result (null when it failed). */
  async use(name: AgentToolName, args: Record<string, unknown>, n?: number): Promise<unknown> {
    const run = await this.ctx.toolbox.run(name, args);
    const number = n ?? this.next++;
    this.calls.push({
      n: number,
      tool: name,
      args,
      ok: run.ok,
      summary: run.ok ? run.summary : `failed: ${run.error}`,
      seen: run.ok ? run.seen : [],
    });
    return run.ok ? (JSON.parse(run.content) as unknown) : null;
  }
}

export interface Plant {
  /** The payment the planted proposal wrongly pairs the ledger entry with. */
  readonly paymentId: string;
}

export class ScriptedRunner implements AgentRunner {
  readonly harness = 'loop' as const;

  /** `plants` maps an exception id to the wrong payment its planted proposal names. */
  constructor(private readonly plants: ReadonlyMap<string, Plant> = new Map()) {}

  async investigate(
    members: readonly ExceptionToInvestigate[],
    ctx: InvestigationContext,
  ): Promise<ProposalDraft[]> {
    const drafts: ProposalDraft[] = [];
    for (const member of members) drafts.push(await this.one(member, ctx));
    return drafts;
  }

  private async one(
    member: ExceptionToInvestigate,
    ctx: InvestigationContext,
  ): Promise<ProposalDraft> {
    const session = new Session(ctx);
    const subject: Subject = { exceptionId: member.id, ruleReasonCode: member.ruleReasonCode };
    const view = (await session.use(
      'get_exception',
      { exception_id: member.id },
      0,
    )) as ExceptionView | null;
    if (view === null || view.subject === null) {
      const done = needsHuman(subject, 'the exception could not be read', session.calls);
      return {
        content: done.content,
        model: SCRIPTED_MODEL,
        harnessFindings: done.findings,
        llmCallId: null,
      };
    }

    const plant = this.plants.get(member.id);
    const answer =
      plant === undefined
        ? await this.answer(view, view.subject, session)
        : await this.planted(view.subject, plant, session);
    const finalized = finalizeResult(
      { exceptionId: member.id, ...answer, draftJournalEntry: answer.draftJournalEntry ?? null },
      subject,
      session.calls,
    );
    return {
      content: finalized.content,
      model: plant === undefined ? SCRIPTED_MODEL : PLANTED_MODEL,
      harnessFindings:
        plant === undefined ? finalized.findings : [...finalized.findings, PLANTED_NOTE],
      llmCallId: null,
    };
  }

  // --- a deliberately wrong guess, for the verifier to refuse -------------------------------------------

  private async planted(subject: Brief, plant: Plant, session: Session): Promise<Answer> {
    const found = (await session.use('get_payment', { id: plant.paymentId })) as {
      payments?: { razorpayId: string; amountPaise: string }[];
    } | null;
    const payment = found?.payments?.[0];
    return {
      verdict: 'MATCH_PROPOSED',
      reasonCode: 'UNKNOWN',
      links: [refOf(subject), { recordType: 'rzp_payment', recordId: plant.paymentId }],
      explanation:
        'Planted by the demo to show the verifier: this ledger entry is paired with a payment that does not match it.',
      evidence: [
        {
          call: 0,
          keyFinding: `Ledger ${subject.key} is ${rupees(subject.amountPaise)} with no payment under its reference.`,
        },
        {
          call: 1,
          keyFinding: `Payment ${payment?.razorpayId ?? plant.paymentId} is ${rupees(payment?.amountPaise ?? '0')}, offered as the match.`,
        },
      ],
      confidence: 0.95,
      suggestedAction: 'ACCEPT_MATCH',
    };
  }

  // --- the baseline's own reading of each kind of exception ---------------------------------------------------

  private async answer(view: ExceptionView, subject: Brief, session: Session): Promise<Answer> {
    switch (view.cause) {
      case 'ledger_has_no_payment':
      case 'ledger_payment_not_captured':
      case 'ledger_has_no_reference':
        return this.ledgerAlone(subject, session);
      case 'payment_has_no_ledger':
        return this.paymentAlone(subject, session);
      case 'receipt_amount_differs':
        return this.amountDiffers(view, subject, session);
      case 'payment_is_retry_duplicate':
        return this.duplicate(view, subject, session);
      case 'window_ambiguous':
      case 'utr_ambiguous':
        return this.ambiguousPayout(view, subject, session);
      default:
        return this.cannotTell(view);
    }
  }

  private cannotTell(view: ExceptionView): Answer {
    return {
      verdict: 'NEEDS_HUMAN',
      reasonCode: 'UNKNOWN',
      links: [],
      explanation: `The rules could not decide this (${view.cause ?? 'no cause given'}) and the scripted baseline has no rule for it, so it needs a person.`,
      evidence: [{ call: 0, keyFinding: `The rules raised it as ${view.cause ?? 'unspecified'}.` }],
      confidence: 0.3,
      suggestedAction: 'NONE',
    };
  }

  /** A ledger entry no payment explains: is there any money of that amount at all? */
  private async ledgerAlone(subject: Brief, session: Session): Promise<Answer> {
    const amount = Number(subject.amountPaise);
    const bank = (await session.use('search_bank_lines', {
      amount_min: amount,
      amount_max: amount,
      direction: 'credit',
    })) as { rows?: unknown[] } | null;
    const credits = bank?.rows?.length ?? 0;
    if (credits === 0) {
      return {
        verdict: 'EXPLAINED_NO_MATCH',
        reasonCode: 'LEDGER_WITHOUT_PAYMENT',
        links: [refOf(subject)],
        explanation: `Ledger ${subject.key} records ${rupees(subject.amountPaise)}, but no Razorpay payment carries that reference and no bank credit of exactly that amount exists. It may be a cash or offline sale.`,
        evidence: [
          { call: 0, keyFinding: `No payment was found for ${subject.key}.` },
          { call: 1, keyFinding: 'No bank credit of exactly that amount exists in the statement.' },
        ],
        confidence: 0.7,
        suggestedAction: 'NONE',
      };
    }
    return {
      verdict: 'NEEDS_HUMAN',
      reasonCode: 'LEDGER_WITHOUT_PAYMENT',
      links: [],
      explanation: `Ledger ${subject.key} has no payment, but ${credits} bank credit(s) of exactly ${rupees(subject.amountPaise)} exist, so it may have been paid some other way.`,
      evidence: [
        { call: 0, keyFinding: `No payment was found for ${subject.key}.` },
        { call: 1, keyFinding: `${credits} bank credit(s) of exactly that amount exist.` },
      ],
      confidence: 0.4,
      suggestedAction: 'NONE',
    };
  }

  /** A captured payment with no ledger entry: does any ledger entry of that amount exist? */
  private async paymentAlone(subject: Brief, session: Session): Promise<Answer> {
    const found = (await session.use('get_payment', { id: subject.key })) as {
      payments?: { settlement: { razorpayId: string } | null }[];
    } | null;
    const amount = Number(subject.amountPaise);
    const ledger = (await session.use('search_ledger', {
      amount_min: amount,
      amount_max: amount,
    })) as {
      rows?: unknown[];
    } | null;
    const settled = found?.payments?.[0]?.settlement?.razorpayId;
    if ((ledger?.rows?.length ?? 0) === 0) {
      return {
        verdict: 'EXPLAINED_NO_MATCH',
        reasonCode: 'PAYMENT_WITHOUT_LEDGER',
        links: [refOf(subject)],
        explanation: `Payment ${subject.key} of ${rupees(subject.amountPaise)} was captured${settled ? ` and settled in ${settled}` : ''}, but no ledger entry has its reference or its amount. The ledger may be missing a sale.`,
        evidence: [
          {
            call: 1,
            keyFinding: `${subject.key} is captured${settled ? ` and was paid out in ${settled}` : ''}.`,
          },
          { call: 2, keyFinding: 'No ledger entry has exactly that amount.' },
        ],
        confidence: 0.75,
        suggestedAction: 'ADJUST_LEDGER',
        draftJournalEntry: transfer(
          `Record the sale behind payment ${subject.key}`,
          'RAZORPAY_CLEARING',
          'SALES',
          BigInt(subject.amountPaise),
        ),
      };
    }
    return {
      verdict: 'NEEDS_HUMAN',
      reasonCode: 'PAYMENT_WITHOUT_LEDGER',
      links: [],
      explanation: `Payment ${subject.key} has no ledger entry by reference, but ledger entries of exactly ${rupees(subject.amountPaise)} exist, so it may belong to one of them.`,
      evidence: [
        { call: 1, keyFinding: `${subject.key} is a captured payment.` },
        { call: 2, keyFinding: 'Ledger entries of exactly that amount exist.' },
      ],
      confidence: 0.4,
      suggestedAction: 'NONE',
    };
  }

  /** The same order reference at two amounts: the ledger was edited, or the customer paid a different sum. */
  private async amountDiffers(
    view: ExceptionView,
    subject: Brief,
    session: Session,
  ): Promise<Answer> {
    const pair = [subject, ...view.candidates];
    const ledger = pair.find((b) => b.type === 'ledger_entry');
    const payment = pair.find((b) => b.type === 'rzp_payment');
    if (ledger === undefined || payment === undefined) return this.cannotTell(view);
    await session.use('get_payment', { id: payment.key });
    const gap = BigInt(ledger.amountPaise) - BigInt(payment.amountPaise);
    const shown = formatRupees(paise(gap < 0n ? -gap : gap), { symbol: true });
    return {
      verdict: 'EXPLAINED_NO_MATCH',
      reasonCode: 'LEDGER_AMOUNT_EDITED',
      links: [refOf(ledger), refOf(payment)],
      explanation: `Ledger ${ledger.key} says ${rupees(ledger.amountPaise)} but its payment ${payment.key} was ${rupees(payment.amountPaise)}, ${shown} ${gap < 0n ? 'more' : 'less'} on the same order reference. The ledger amount was probably edited after the sale.`,
      evidence: [
        {
          call: 0,
          keyFinding: `The rules found one payment for ${ledger.key} at a different amount.`,
        },
        { call: 1, keyFinding: `${payment.key} was captured for ${rupees(payment.amountPaise)}.` },
      ],
      confidence: 0.85,
      suggestedAction: 'ADJUST_LEDGER',
      ...(gap === 0n
        ? {}
        : {
            draftJournalEntry:
              gap > 0n
                ? transfer(
                    `Correct ${ledger.key} down to the captured amount`,
                    'SALES',
                    'RAZORPAY_CLEARING',
                    gap,
                  )
                : transfer(
                    `Correct ${ledger.key} up to the captured amount`,
                    'RAZORPAY_CLEARING',
                    'SALES',
                    -gap,
                  ),
          }),
    };
  }

  /**
   * A retried checkout paid twice. The rules have already matched the ledger entry to the original
   * payment, so the retry and any refund of it are all that is left, and they have no ledger entry of
   * their own. If the retry was refunded in full they cancel out: an explanation, not a match (linking the
   * ledger entry again would reuse records that are already matched, which the verifier refuses).
   */
  private async duplicate(view: ExceptionView, subject: Brief, session: Session): Promise<Answer> {
    const ledger = view.candidates.find((b) => b.type === 'ledger_entry');
    if (ledger === undefined) return this.cannotTell(view);
    await session.use('get_payment', { id: subject.key });
    const originals = (await session.use('get_payment', { id: ledger.key })) as {
      payments?: { id: string }[];
    } | null;
    const refunds = (await session.use('list_refunds', { payment_id: subject.key })) as {
      refunds?: { id: string; razorpayId: string }[];
      totalRefundedPaise?: string;
    } | null;
    const refunded = BigInt(refunds?.totalRefundedPaise ?? '0');
    const owed = BigInt(subject.amountPaise) - refunded;
    const links: RecordRef[] = [
      refOf(ledger),
      ...(originals?.payments ?? []).map((p): RecordRef => ({
        recordType: 'rzp_payment',
        recordId: p.id,
      })),
      refOf(subject),
      ...(refunds?.refunds ?? []).map((r): RecordRef => ({
        recordType: 'rzp_refund',
        recordId: r.id,
      })),
    ];
    if (refunded > 0n && owed <= 0n) {
      return {
        verdict: 'EXPLAINED_NO_MATCH',
        reasonCode: 'DUPLICATE_PAYMENT',
        links,
        explanation: `Order ${ledger.key} was paid twice (${subject.key} is the retry) and the retry was refunded in full (${(refunds?.refunds ?? []).map((r) => r.razorpayId).join(', ')}), so the customer is whole. The retry and its refund cancel out and need no ledger entry.`,
        evidence: [
          { call: 0, keyFinding: `${subject.key} is a retry of the order ${ledger.key}.` },
          { call: 3, keyFinding: `${subject.key} was refunded in full.` },
        ],
        confidence: 0.9,
        suggestedAction: 'NONE',
      };
    }
    return {
      verdict: 'EXPLAINED_NO_MATCH',
      reasonCode: 'DUPLICATE_PAYMENT',
      links,
      explanation: `Order ${ledger.key} was paid twice: ${subject.key} is a retry of an earlier payment and ${refunded > 0n ? `was refunded only in part, so the customer is still owed ${rupees(owed.toString())}` : `has no refund, so the customer is owed ${rupees(subject.amountPaise)}`}.`,
      evidence: [
        { call: 0, keyFinding: `${subject.key} is a retry of the order ${ledger.key}.` },
        {
          call: 3,
          keyFinding:
            refunded > 0n
              ? `${subject.key} was refunded only in part.`
              : `${subject.key} has no refund.`,
        },
      ],
      confidence: 0.9,
      suggestedAction: 'REFUND_CUSTOMER',
      draftJournalEntry: transfer(
        `Owed to the customer: duplicate payment ${subject.key}`,
        'RAZORPAY_CLEARING',
        'SUSPENSE',
        owed,
      ),
    };
  }

  /** Two bank credits of one amount for one settlement: pick the one whose UTR fits, if one clearly does. */
  private async ambiguousPayout(
    view: ExceptionView,
    subject: Brief,
    session: Session,
  ): Promise<Answer> {
    const settlementBrief =
      subject.type === 'rzp_settlement'
        ? subject
        : view.candidates.find((b) => b.type === 'rzp_settlement');
    if (settlementBrief === undefined) return this.cannotTell(view);
    const composition = (await session.use('get_settlement_composition', {
      settlement_id: settlementBrief.key,
    })) as {
      settlement?: { utr: string | null };
      composition?: { reconciles: boolean };
    } | null;
    const settlementUtr = composition?.settlement?.utr ?? null;
    const reconciles = composition?.composition?.reconciles === true;

    const rivals = (await session.use('search_bank_lines', {
      amount_min: Number(settlementBrief.amountPaise),
      amount_max: Number(settlementBrief.amountPaise),
      direction: 'credit',
    })) as { rows?: { id: string; row: string; utr: string | null }[] } | null;
    const credits = rivals?.rows ?? [];
    const scored = credits
      .map((row) => ({
        row,
        score: settlementUtr === null ? Number.POSITIVE_INFINITY : utrScore(settlementUtr, row.utr),
      }))
      .sort((a, b) => a.score - b.score);
    const best = scored[0];
    const second = scored[1];
    const clear =
      reconciles &&
      best !== undefined &&
      best.score <= 4 &&
      (second === undefined || second.score - best.score >= 2);

    if (!clear || best === undefined) {
      return {
        verdict: 'NEEDS_HUMAN',
        reasonCode: 'UTR_MISSING_OR_GARBLED',
        links: [],
        explanation: `${credits.length} bank credits of ${rupees(settlementBrief.amountPaise)} could be the payout of ${settlementBrief.key} and their UTRs do not single one out, so a person must choose.`,
        evidence: [
          {
            call: 1,
            keyFinding: reconciles
              ? `${settlementBrief.key} adds up exactly.`
              : `${settlementBrief.key} does not add up.`,
          },
          { call: 2, keyFinding: `${credits.length} credits of exactly that amount exist.` },
        ],
        confidence: 0.35,
        suggestedAction: 'NONE',
      };
    }
    const mine = subject.type === 'bank_line' ? subject.id : best.row.id;
    const isBest = best.row.id === mine;
    if (subject.type === 'bank_line' && !isBest) {
      return {
        verdict: 'EXPLAINED_NO_MATCH',
        reasonCode: 'UNKNOWN',
        links: [refOf(subject)],
        explanation: `Another credit of the same amount (statement row ${best.row.row}) carries a UTR that fits ${settlementBrief.key} better, so this one is probably an unrelated deposit of the same sum.`,
        evidence: [
          {
            call: 1,
            keyFinding: `${settlementBrief.key} adds up exactly with UTR ${settlementUtr ?? 'none'}.`,
          },
          {
            call: 2,
            keyFinding: `Row ${best.row.row} fits that UTR better than this credit does.`,
          },
        ],
        confidence: 0.6,
        suggestedAction: 'NONE',
      };
    }
    return {
      verdict: 'MATCH_PROPOSED',
      reasonCode: 'UTR_MISSING_OR_GARBLED',
      links: [refOf(settlementBrief), { recordType: 'bank_line', recordId: best.row.id }],
      explanation: `Of ${credits.length} credits of ${rupees(settlementBrief.amountPaise)}, only statement row ${best.row.row} has a UTR that fits ${settlementBrief.key}, once allowing for a garbled reference.`,
      evidence: [
        {
          call: 1,
          keyFinding: `${settlementBrief.key} adds up exactly with UTR ${settlementUtr ?? 'none'}.`,
        },
        {
          call: 2,
          keyFinding: `Row ${best.row.row}'s UTR fits it; the other credit(s) fit worse.`,
        },
      ],
      confidence: 0.8,
      suggestedAction: 'ACCEPT_MATCH',
    };
  }
}

// --- choosing what to plant -----------------------------------------------------------------------------

/**
 * Two ledger entries that no payment explains each get a confident wrong proposal: the first is paired
 * with a payment that is already in another group, the second with an orphan payment of a different
 * amount. Both are chosen by business key, so the same data always plants on the same entries.
 */
export async function planPlants(db: Executor, runId: string): Promise<Map<string, Plant>> {
  const open = await db
    .select()
    .from(reconExceptions)
    .where(and(eq(reconExceptions.runId, runId), eq(reconExceptions.status, 'open')));
  const ledgerIds = open
    .filter((e) => e.cause === 'ledger_has_no_payment' && e.subjectType === 'ledger_entry')
    .map((e) => e.subjectId);
  const orphanIds = open
    .filter((e) => e.cause === 'payment_has_no_ledger' && e.subjectType === 'rzp_payment')
    .map((e) => e.subjectId);
  if (ledgerIds.length === 0) return new Map();

  const ledgers = await db
    .select()
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.id, ledgerIds))
    .orderBy(asc(ledgerEntries.orderRef));
  const orphans = orphanIds.length
    ? await db
        .select()
        .from(rzpPayments)
        .where(inArray(rzpPayments.id, orphanIds))
        .orderBy(asc(rzpPayments.rzpId))
    : [];
  const grouped = await db
    .select({ paymentId: matchLinks.paymentId })
    .from(matchLinks)
    .innerJoin(matchGroups, eq(matchGroups.id, matchLinks.groupId))
    .where(and(eq(matchGroups.runId, runId), eq(matchGroups.status, 'accepted')));
  const matchedIds = grouped.map((g) => g.paymentId).filter((id): id is string => id !== null);
  const matched = matchedIds.length
    ? await db
        .select()
        .from(rzpPayments)
        .where(inArray(rzpPayments.id, matchedIds))
        .orderBy(asc(rzpPayments.rzpId))
    : [];

  const plants = new Map<string, Plant>();
  const exceptionOf = (ledgerId: string) => open.find((e) => e.subjectId === ledgerId)?.id;
  const [first, second] = ledgers;
  const reused = first && matched.find((p) => p.amountPaise !== first.amountPaise);
  const firstException = first && exceptionOf(first.id);
  if (first && reused && firstException) plants.set(firstException, { paymentId: reused.id });
  const orphan = second && orphans.find((p) => p.amountPaise !== second.amountPaise);
  const secondException = second && exceptionOf(second.id);
  if (second && orphan && secondException) plants.set(secondException, { paymentId: orphan.id });
  return plants;
}
