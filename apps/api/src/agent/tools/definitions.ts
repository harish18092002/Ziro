import { type RecordRef, recordRefSchema } from '@ziro/core/domain';
import {
  composeLines,
  composeSettlement,
  type CompositionLine,
  isVerified,
} from '@ziro/core/matcher';
import { paise, ZERO } from '@ziro/core/money';
import { addDaysToBusinessDate, isBusinessDate } from '@ziro/core/time';
import { z } from 'zod';
import { expectedFee } from '../../common/fee-contract.js';
import type { Executor } from '../../db/executor.js';
import {
  adjustmentsByKeys,
  getException,
  getLedger,
  getPayments,
  getSettlement,
  groupsOf,
  itemsOfSettlement,
  paymentsByKeys,
  paymentsByRzpIds,
  refundsByKeys,
  refundsByRzpIds,
  refundsOfPayment,
  searchBank,
  searchLedger,
  settlementsOfPayments,
} from './repository.js';
import { type AgentTool, type ToolContext, ToolError, type ToolOutput } from './types.js';
import {
  bankView,
  briefRefs,
  groupView,
  ledgerView,
  paymentView,
  refOf,
  refundView,
  settlementView,
  str,
} from './views.js';
import { identifier, untrusted } from '../untrusted.js';

const DEFAULT_ROWS = 10;
const MAX_ROWS = 20;
const MAX_SPAN_DAYS = 62;
const MAX_CANDIDATES_SHOWN = 25;
const MAX_LINES_SHOWN = 15;
const MAX_IDS = 60;

/** Records ordered by what they are and their business key (never by their random row id). */
const byBusinessKey = (
  a: { type: string; key: string },
  b: { type: string; key: string },
): number =>
  a.type === b.type ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.type < b.type ? -1 : 1;

const key = z.string().min(1).max(120);
const amount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.string().refine(isBusinessDate, 'must be a real date written YYYY-MM-DD');
const limit = z.number().int().min(1).max(MAX_ROWS);
const big = (n: number | undefined): bigint | undefined =>
  n === undefined ? undefined : BigInt(n);

/** The checks every search shares: ordered bounds, a bounded date span, and at least one filter. */
function checkSearch(
  f: { amount_min?: number; amount_max?: number; date_from?: string; date_to?: string },
  extra: unknown[],
): void {
  if (
    f.amount_min === undefined &&
    f.amount_max === undefined &&
    f.date_from === undefined &&
    f.date_to === undefined &&
    extra.every((e) => e === undefined)
  ) {
    throw new ToolError(
      'give at least one filter: an amount range, a date range or a text/UTR search',
    );
  }
  if (f.amount_min !== undefined && f.amount_max !== undefined && f.amount_min > f.amount_max) {
    throw new ToolError('amount_min is above amount_max');
  }
  if (f.date_from !== undefined && f.date_to !== undefined) {
    if (f.date_from > f.date_to) throw new ToolError('date_from is after date_to');
    if (f.date_to > addDaysToBusinessDate(f.date_from, MAX_SPAN_DAYS)) {
      throw new ToolError(`a date range covers at most ${MAX_SPAN_DAYS} days`);
    }
  }
}

// --- get_exception ---------------------------------------------------------------------------

const getExceptionArgs = z.strictObject({ exception_id: z.uuid() });

const getExceptionTool: AgentTool<z.output<typeof getExceptionArgs>> = {
  name: 'get_exception',
  description:
    'The exception under investigation: what the matching rules concluded (their reason code, cause and a one-sentence note), the subject record, the amount at stake, and the candidate records the rules found. Amounts are integer paise.',
  args: getExceptionArgs,
  async execute(args, ctx): Promise<ToolOutput> {
    const row = await getException(ctx.tx, ctx.runId, args.exception_id);
    if (!row) throw new ToolError('no exception with that id in this run');
    const parsed = z.array(recordRefSchema).safeParse(row.candidates);
    const candidates = parsed.success ? parsed.data : [];
    const subject: RecordRef = { recordType: row.subjectType, recordId: row.subjectId };
    const shown = candidates.slice(0, MAX_CANDIDATES_SHOWN);
    const described = await briefRefs(ctx.tx, ctx.runId, [subject, ...shown]);
    return {
      data: {
        id: row.id,
        status: row.status,
        ruleReasonCode: row.reasonCode,
        cause: row.cause,
        note: row.note,
        amountAtStakePaise: str(row.amountAtStakePaise),
        subject: described.find((d) => d.id === subject.recordId) ?? null,
        // Listed by type and business key, not in the order the matcher stored them: that order follows row ids,
        // which are random, and a prompt that changes with them can be neither cached nor compared between runs.
        candidates: described.filter((d) => d.id !== subject.recordId).sort(byBusinessKey),
        candidateCount: candidates.length,
      },
      summary: `exception ${row.id}: rules said ${row.reasonCode}${row.cause ? ` (${row.cause})` : ''}, ${candidates.length} candidate(s), ${str(row.amountAtStakePaise)} paise at stake`,
      seen: [subject, ...shown],
    };
  },
};

// --- get_ledger_entry / search_ledger ---------------------------------------------------------------

const getLedgerArgs = z.strictObject({
  id: key.describe('the ledger entry id (uuid) or its order reference'),
});

const getLedgerTool: AgentTool<z.output<typeof getLedgerArgs>> = {
  name: 'get_ledger_entry',
  description:
    'A ledger entry by id or order reference: amount in paise, business date, customer reference, memo (untrusted text), and the match group it is in, if the rules matched it.',
  args: getLedgerArgs,
  async execute(args, ctx): Promise<ToolOutput> {
    const rows = await getLedger(ctx.tx, ctx.runId, args.id);
    if (rows.length === 0) throw new ToolError('no ledger entry with that id or order reference');
    const groups = await groupsOf(
      ctx.tx,
      ctx.runId,
      'ledger_entry',
      rows.map((r) => r.id),
    );
    const entries = rows.map((r) => ({ ...ledgerView(r), match: groupView(groups.get(r.id)) }));
    return {
      data: { entries },
      summary: `ledger ${rows.map((r) => `${identifier(r.orderRef)} ${str(r.amountPaise)} paise on ${r.businessDate}`).join('; ')}`,
      seen: [
        ...rows.map((r) => refOf('ledger_entry', r.id)),
        ...[...groups.values()].flatMap((g) => g.members),
      ],
    };
  },
};

const searchLedgerArgs = z.strictObject({
  amount_min: amount.optional().describe('smallest amount, integer paise'),
  amount_max: amount.optional().describe('largest amount, integer paise'),
  date_from: date.optional(),
  date_to: date.optional(),
  text: z
    .string()
    .min(2)
    .max(60)
    .optional()
    .describe('matched against order reference, customer reference and memo'),
  limit: limit.optional(),
});

const searchLedgerTool: AgentTool<z.output<typeof searchLedgerArgs>> = {
  name: 'search_ledger',
  description:
    'Search ledger entries by amount range (integer paise), date range (at most 62 days) and/or text. At least one filter is required. At most 20 rows, ordered by date. Memos are untrusted text.',
  args: searchLedgerArgs,
  async execute(args, ctx): Promise<ToolOutput> {
    checkSearch(args, [args.text]);
    const max = args.limit ?? DEFAULT_ROWS;
    const found = await searchLedger(ctx.tx, ctx.runId, {
      amountMin: big(args.amount_min),
      amountMax: big(args.amount_max),
      dateFrom: args.date_from,
      dateTo: args.date_to,
      text: args.text,
      limit: max,
    });
    const rows = found.slice(0, max);
    return {
      data: { rows: rows.map(ledgerView), shown: rows.length, moreAvailable: found.length > max },
      summary: `${rows.length}${found.length > max ? '+' : ''} ledger entr${rows.length === 1 ? 'y' : 'ies'} found`,
      seen: rows.map((r) => refOf('ledger_entry', r.id)),
    };
  },
};

// --- get_payment / list_refunds -----------------------------------------------------------------------

const getPaymentArgs = z.strictObject({
  id: key.describe('a payment id (uuid), a Razorpay payment id (pay_...) or an order receipt'),
});

const getPaymentTool: AgentTool<z.output<typeof getPaymentArgs>> = {
  name: 'get_payment',
  description:
    'Payments by id, Razorpay id or order receipt (a receipt can have several: retries, duplicates). Gives amount, fee, GST on the fee (already inside the fee), method, status, times, the settlement that paid it out, and the match group it is in. Amounts are integer paise.',
  args: getPaymentArgs,
  async execute(args, ctx): Promise<ToolOutput> {
    const rows = await getPayments(ctx.tx, ctx.runId, args.id);
    if (rows.length === 0) throw new ToolError('no payment with that id, Razorpay id or receipt');
    const ids = rows.map((r) => r.id);
    const [groups, settlements] = await Promise.all([
      groupsOf(ctx.tx, ctx.runId, 'rzp_payment', ids),
      settlementsOfPayments(ctx.tx, ctx.runId, ids),
    ]);
    const payments = rows.map((r) => {
      const settled = settlements.find((s) => s.paymentId === r.id);
      return {
        ...paymentView(r),
        settlement: settled
          ? {
              id: settled.id,
              razorpayId: settled.rzpId,
              amountPaise: str(settled.amountPaise),
              date: settled.businessDate,
            }
          : null,
        match: groupView(groups.get(r.id)),
      };
    });
    return {
      data: { payments },
      summary: `payment ${rows.map((r) => `${r.rzpId} ${str(r.amountPaise)} paise, fee ${str(r.feePaise)}, ${r.status}`).join('; ')}`,
      seen: [
        ...rows.map((r) => refOf('rzp_payment', r.id)),
        ...settlements.map((s) => refOf('rzp_settlement', s.id)),
        ...[...groups.values()].flatMap((g) => g.members),
      ],
    };
  },
};

const listRefundsArgs = z.strictObject({
  payment_id: key.describe('a payment id (uuid) or Razorpay payment id (pay_...)'),
});

const listRefundsTool: AgentTool<z.output<typeof listRefundsArgs>> = {
  name: 'list_refunds',
  description:
    'The refunds made against one payment, with amounts (integer paise), status and dates.',
  args: listRefundsArgs,
  async execute(args, ctx): Promise<ToolOutput> {
    const [payment] = await getPayments(ctx.tx, ctx.runId, args.payment_id);
    if (!payment) throw new ToolError('no payment with that id or Razorpay id');
    const rows = await refundsOfPayment(ctx.tx, ctx.runId, payment.rzpId);
    const total = rows.reduce((sum, r) => sum + r.amountPaise, 0n);
    return {
      data: {
        payment: payment.rzpId,
        refunds: rows.map(refundView),
        totalRefundedPaise: str(total),
      },
      summary: `${rows.length} refund(s) of ${payment.rzpId}, ${str(total)} paise in total`,
      seen: [refOf('rzp_payment', payment.id), ...rows.map((r) => refOf('rzp_refund', r.id))],
    };
  },
};

// --- get_settlement_composition ---------------------------------------------------------------------

const getSettlementArgs = z.strictObject({
  settlement_id: key.describe('a settlement id (uuid) or Razorpay settlement id (setl_...)'),
});

/** Payment and refund figures for the cross-check, keyed by Razorpay id. */
async function lookupsFor(
  tx: Executor,
  runId: string,
  lines: readonly { itemType: string; rzpEntityId: string; rzpPaymentId: string | null }[],
) {
  const payments = await paymentsByRzpIds(
    tx,
    runId,
    lines.filter((l) => l.itemType === 'payment').map((l) => l.rzpPaymentId ?? l.rzpEntityId),
  );
  const refunds = await refundsByRzpIds(
    tx,
    runId,
    lines.filter((l) => l.itemType === 'refund').map((l) => l.rzpEntityId),
  );
  const byPayment = new Map(payments.map((p) => [p.rzpId, p]));
  const byRefund = new Map(refunds.map((r) => [r.rzpId, r]));
  return {
    payment: (id: string) => {
      const p = byPayment.get(id);
      return p && { amount: paise(p.amountPaise), fee: paise(p.feePaise), tax: paise(p.taxPaise) };
    },
    refund: (id: string) => {
      const r = byRefund.get(id);
      return r && { amount: paise(r.amountPaise) };
    },
  };
}

const getSettlementTool: AgentTool<z.output<typeof getSettlementArgs>> = {
  name: 'get_settlement_composition',
  description:
    'How a Razorpay settlement is made up: the settlement (amount, UTR, date) and its recon lines (payments, refunds, adjustments), added up by the same function the matching rules use: payments minus fees (GST included) minus refunds plus or minus adjustments, compared with the amount Razorpay says it paid. Gives the residual in paise (0 means it reconciles) and any line that contradicts its payment or refund record.',
  args: getSettlementArgs,
  async execute(args, ctx): Promise<ToolOutput> {
    const settlement = await getSettlement(ctx.tx, ctx.runId, args.settlement_id);
    if (!settlement) throw new ToolError('no settlement with that id or Razorpay id');
    const items = await itemsOfSettlement(ctx.tx, ctx.runId, settlement.id);
    const lines: CompositionLine[] = items.map((i) => ({
      sourceRef: i.sourceRef,
      itemType: i.itemType,
      entityId: i.rzpEntityId,
      paymentId: i.rzpPaymentId,
      amount: paise(i.amountPaise),
      fee: paise(i.feePaise),
      tax: paise(i.taxPaise),
      debit: paise(i.debitPaise),
      credit: paise(i.creditPaise),
    }));
    const lookups = await lookupsFor(ctx.tx, ctx.runId, items);
    const c = composeSettlement(
      { settlementId: settlement.rzpId, amount: paise(settlement.amountPaise) },
      lines,
      lookups,
    );
    const shown = items.slice(0, MAX_LINES_SHOWN);
    const groups = await groupsOf(ctx.tx, ctx.runId, 'rzp_settlement', [settlement.id]);
    return {
      data: {
        settlement: settlementView(settlement),
        composition: {
          grossPaise: str(c.gross),
          feesPaiseIncludingGst: str(c.fees),
          gstInsideFeesPaise: str(c.tax),
          refundsPaise: str(c.refunds),
          adjustmentsCreditPaise: str(c.adjustmentsCredit),
          adjustmentsDebitPaise: str(c.adjustmentsDebit),
          computedNetPaise: str(c.computed),
          settlementAmountPaise: str(c.settlementAmount),
          residualPaise: str(c.residual),
          reconciles: isVerified(c),
          issues: c.issues.slice(0, 10),
        },
        lines: shown.map((i) => ({
          type: i.itemType,
          key: i.rzpEntityId,
          amountPaise: str(i.amountPaise),
          feePaise: str(i.feePaise),
          debitPaise: str(i.debitPaise),
          creditPaise: str(i.creditPaise),
          description: untrusted('description', i.description),
        })),
        lineCount: items.length,
        linesShown: shown.length,
        match: groupView(groups.get(settlement.id)),
      },
      summary: `settlement ${settlement.rzpId}: ${str(c.settlementAmount)} paise, lines compute to ${str(c.computed)}, residual ${str(c.residual)}${isVerified(c) ? ' (reconciles)' : ' (does NOT reconcile)'}`,
      seen: [
        refOf('rzp_settlement', settlement.id),
        ...[...groups.values()].flatMap((g) => g.members),
      ],
    };
  },
};

// --- search_bank_lines ----------------------------------------------------------------------------------

const searchBankArgs = z.strictObject({
  amount_min: amount.optional().describe('smallest amount, integer paise'),
  amount_max: amount.optional().describe('largest amount, integer paise'),
  date_from: date.optional(),
  date_to: date.optional(),
  utr_fragment: z
    .string()
    .regex(/^[A-Za-z0-9]{6,30}$/, 'letters and digits only, 6 to 30 characters')
    .optional()
    .describe('part of a bank reference (UTR), searched in the UTR and the narration'),
  direction: z.enum(['credit', 'debit']).optional(),
  limit: limit.optional(),
});

const searchBankTool: AgentTool<z.output<typeof searchBankArgs>> = {
  name: 'search_bank_lines',
  description:
    'Search bank statement lines by amount range (integer paise), value-date range (at most 62 days), direction and/or a fragment of the UTR. At least one filter is required. At most 20 rows. Each row shows the UTR the importer extracted with its quality (exact, rejoined, repaired, truncated) and the narration (untrusted text).',
  args: searchBankArgs,
  async execute(args, ctx): Promise<ToolOutput> {
    checkSearch(args, [args.utr_fragment, args.direction]);
    const max = args.limit ?? DEFAULT_ROWS;
    const found = await searchBank(ctx.tx, ctx.runId, {
      amountMin: big(args.amount_min),
      amountMax: big(args.amount_max),
      dateFrom: args.date_from,
      dateTo: args.date_to,
      utrFragment: args.utr_fragment,
      direction: args.direction,
      limit: max,
    });
    const rows = found.slice(0, max);
    const groups = await groupsOf(
      ctx.tx,
      ctx.runId,
      'bank_line',
      rows.map((r) => r.id),
    );
    return {
      data: {
        rows: rows.map((r) => ({ ...bankView(r), match: groupView(groups.get(r.id)) })),
        shown: rows.length,
        moreAvailable: found.length > max,
      },
      summary: `${rows.length}${found.length > max ? '+' : ''} bank line(s) found`,
      seen: [
        ...rows.map((r) => refOf('bank_line', r.id)),
        ...[...groups.values()].flatMap((g) => g.members),
      ],
    };
  },
};

// --- compute_expected_settlement -------------------------------------------------------------------------

const computeArgs = z.strictObject({
  payment_ids: z.array(key).max(MAX_IDS),
  refund_ids: z.array(key).max(MAX_IDS),
  adjustment_ids: z.array(key).max(MAX_IDS),
  settlement_id: key.optional().describe('also compare the result with this settlement'),
});

const computeTool: AgentTool<z.output<typeof computeArgs>> = {
  name: 'compute_expected_settlement',
  description:
    'What a settlement of exactly these payments, refunds and adjustments should pay out: payments minus fees (GST included) minus refunds plus or minus adjustments, computed by the same function the matching rules use. Ids may be uuids or Razorpay ids (pay_..., rfnd_..., adj_...). Up to 60 ids in total. Give settlement_id to also get the residual against that settlement. Use this for ALL money arithmetic; never add amounts yourself.',
  args: computeArgs,
  async execute(args, ctx): Promise<ToolOutput> {
    const total = args.payment_ids.length + args.refund_ids.length + args.adjustment_ids.length;
    if (total === 0) throw new ToolError('give at least one payment, refund or adjustment id');
    if (total > MAX_IDS) throw new ToolError(`give at most ${MAX_IDS} ids in total`);
    const [payments, refunds, adjustments] = await Promise.all([
      paymentsByKeys(ctx.tx, ctx.runId, args.payment_ids),
      refundsByKeys(ctx.tx, ctx.runId, args.refund_ids),
      adjustmentsByKeys(ctx.tx, ctx.runId, args.adjustment_ids),
    ]);
    const zero = ZERO;
    const lines: CompositionLine[] = [
      ...payments.map((p) => ({
        sourceRef: p.sourceRef,
        itemType: 'payment' as const,
        entityId: p.rzpId,
        paymentId: null,
        amount: paise(p.amountPaise),
        fee: paise(p.feePaise),
        tax: paise(p.taxPaise),
        debit: zero,
        credit: paise(p.amountPaise - p.feePaise),
      })),
      ...refunds.map((r) => ({
        sourceRef: r.sourceRef,
        itemType: 'refund' as const,
        entityId: r.rzpId,
        paymentId: r.rzpPaymentId,
        amount: paise(r.amountPaise),
        fee: zero,
        tax: zero,
        debit: paise(r.amountPaise),
        credit: zero,
      })),
      ...adjustments.map((a) => ({
        sourceRef: a.sourceRef,
        itemType: a.itemType,
        entityId: a.rzpEntityId,
        paymentId: a.rzpPaymentId,
        amount: paise(a.amountPaise),
        fee: paise(a.feePaise),
        tax: paise(a.taxPaise),
        debit: paise(a.debitPaise),
        credit: paise(a.creditPaise),
      })),
    ];
    const c = composeLines(
      lines,
      await lookupsFor(
        ctx.tx,
        ctx.runId,
        lines.map((l) => ({
          itemType: l.itemType,
          rzpEntityId: l.entityId,
          rzpPaymentId: l.paymentId,
        })),
      ),
    );

    const known = new Set<string>([
      ...payments.flatMap((p) => [p.id, p.rzpId]),
      ...refunds.flatMap((r) => [r.id, r.rzpId]),
      ...adjustments.flatMap((a) => [a.id, a.rzpEntityId]),
    ]);
    const notFound = [...args.payment_ids, ...args.refund_ids, ...args.adjustment_ids].filter(
      (k) => !known.has(k) && !known.has(k.toLowerCase()),
    );

    let against: Record<string, unknown> | null = null;
    if (args.settlement_id !== undefined) {
      const settlement = await getSettlement(ctx.tx, ctx.runId, args.settlement_id);
      if (!settlement) throw new ToolError('no settlement with that id or Razorpay id');
      against = {
        settlement: settlement.rzpId,
        settlementAmountPaise: str(settlement.amountPaise),
        residualPaise: str(settlement.amountPaise - c.computed),
      };
    }
    return {
      data: {
        expectedNetPaise: str(c.computed),
        grossPaise: str(c.gross),
        feesPaiseIncludingGst: str(c.fees),
        gstInsideFeesPaise: str(c.tax),
        refundsPaise: str(c.refunds),
        adjustmentsCreditPaise: str(c.adjustmentsCredit),
        adjustmentsDebitPaise: str(c.adjustmentsDebit),
        lineCounts: {
          payments: c.paymentLines,
          refunds: c.refundLines,
          adjustments: c.adjustmentLines,
        },
        issues: c.issues.filter((i) => i.severity === 'blocking').slice(0, 10),
        notFound,
        againstSettlement: against,
      },
      summary: `expected net ${str(c.computed)} paise from ${c.paymentLines} payment(s), ${c.refundLines} refund(s), ${c.adjustmentLines} adjustment(s)${against ? `; residual against ${String(against['settlement'])} is ${String(against['residualPaise'])}` : ''}${notFound.length ? `; ${notFound.length} id(s) not found` : ''}`,
      seen: [
        ...payments.map((p) => refOf('rzp_payment', p.id)),
        ...refunds.map((r) => refOf('rzp_refund', r.id)),
      ],
    };
  },
};

// --- get_fee_contract ---------------------------------------------------------------------------------

const feeArgs = z.strictObject({
  method: z.string().min(2).max(30).describe('card, upi or netbanking'),
  amount_paise: amount
    .optional()
    .describe('also give the fee the contract implies for this amount'),
});

const feeTool: AgentTool<z.output<typeof feeArgs>> = {
  name: 'get_fee_contract',
  description:
    "The fee Razorpay is supposed to charge for a payment method: the rate in basis points (100 = 1%), the GST rate on the fee, and how amounts are rounded (half-up to the paise at each step). Give amount_paise to get the exact expected base fee, GST and total fee (Razorpay's fee includes its GST). Compare with a payment's fee to spot an overcharge.",
  args: feeArgs,
  execute(args, ctx): Promise<ToolOutput> {
    return Promise.resolve(feeOutput(args, ctx));
  },
};

function feeOutput(args: z.output<typeof feeArgs>, ctx: ToolContext): ToolOutput {
  const { contract, source } = ctx.fees;
  const method = args.method.toLowerCase();
  const terms = contract.methods[method];
  if (terms === undefined) {
    return {
      data: {
        method,
        known: false,
        knownMethods: Object.keys(contract.methods).sort(),
        contractSource: source,
      },
      summary: `no fee terms for ${method}`,
      seen: [],
    };
  }
  const expected =
    args.amount_paise === undefined
      ? null
      : expectedFee(contract, method, paise(BigInt(args.amount_paise)));
  return {
    data: {
      method,
      known: true,
      feeBps: terms.feeBps,
      gstBps: contract.gstBps,
      rounding:
        'half-up to the paise at each step: base = amount x feeBps, gst = base x gstBps, fee = base + gst',
      contractSource: source,
      expectedFor: expected
        ? {
            amountPaise: String(args.amount_paise),
            baseFeePaise: str(expected.baseFee),
            gstPaise: str(expected.gst),
            totalFeePaise: str(expected.totalFee),
          }
        : null,
    },
    summary: `${method}: ${terms.feeBps} bps + ${contract.gstBps} bps GST${expected ? `; expected fee for ${String(args.amount_paise)} paise is ${str(expected.totalFee)}` : ''}`,
    seen: [],
  };
}

/** The frozen tool set. Changing it invalidates the compiled schema cache, so it changes rarely. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  getExceptionTool,
  getLedgerTool,
  searchLedgerTool,
  getPaymentTool,
  listRefundsTool,
  getSettlementTool,
  searchBankTool,
  computeTool,
  feeTool,
];
