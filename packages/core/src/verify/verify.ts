// verifyProposal: re-derives, from the records alone, whether an agent's proposed match is a match.
//
//   order group   ledger entries + captured payments (+ their refunds), no settlement or bank line
//                 Σ ledger = Σ payments − Σ refunds, to the paise
//   payout group  one settlement + one bank credit
//                 the settlement's lines add up (composeSettlement, the SAME function rule tier T2 uses)
//                 and the credit equals the settlement amount, to the paise
//
// There is no tolerance on amounts. Dates are checked against the matcher's own windows. Every finding
// is collected rather than stopping at the first, so a reviewer sees everything that is wrong.
import type {
  BankLine,
  LedgerEntry,
  ReasonCode,
  RecordRef,
  RzpPayment,
  RzpRefund,
  RzpSettlement,
} from '../domain/index.js';
import {
  composeSettlement,
  isDateShift,
  isVerified,
  retryBase,
  settlementCreatedLate,
  settlementUtrKey,
  utrIsWeak,
  type SettlementComposition,
} from '../matcher/index.js';
import { paise } from '../money/index.js';
import { addBusinessDays } from '../time/index.js';
import {
  type ProposalClaim,
  recordKey,
  type VerifiedGroup,
  type VerifierConfig,
  type VerifierSnapshot,
  type VerifyFinding,
  type VerifyOutcome,
  type VerifyReason,
} from './types.js';

/** A reason code that describes a record with no counterpart cannot accompany a match. */
const NEVER_A_MATCH: ReadonlySet<ReasonCode> = new Set([
  'LEDGER_WITHOUT_PAYMENT',
  'PAYMENT_WITHOUT_LEDGER',
  'LEDGER_AMOUNT_EDITED', // an edited amount means the two sides differ: that is not a match
  'FEE_OVERCHARGE', // a leakage finding, reported separately (ADR-010), not a way to match
]);
const ORDER_REASONS: ReadonlySet<ReasonCode> = new Set([
  'DUPLICATE_PAYMENT',
  'PARTIAL_REFUND_NETTED',
  'FULL_REFUND',
  'TIMEZONE_DATE_SHIFT',
  'UNKNOWN',
]);
const PAYOUT_REASONS: ReadonlySet<ReasonCode> = new Set([
  'BATCHED_SETTLEMENT',
  'FEE_GST_DEDUCTION',
  'CHARGEBACK_ADJUSTMENT',
  'UTR_MISSING_OR_GARBLED',
  'SETTLEMENT_DELAYED',
  'PARTIAL_REFUND_NETTED',
  'FULL_REFUND',
  'UNKNOWN',
]);

const ZERO = paise(0n);
const sum = <T>(items: readonly T[], amount: (item: T) => bigint): bigint =>
  items.reduce((total, item) => total + amount(item), 0n);

/** Whole days from one business date to another (YYYY-MM-DD, already validated). */
function daysBetween(from: string, to: string): number {
  const day = (d: string): number => {
    const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, dd) / 86_400_000;
  };
  return day(to) - day(from);
}

const sortRefs = (refs: readonly RecordRef[]): RecordRef[] =>
  [...refs].sort((a, b) =>
    a.recordType === b.recordType
      ? a.recordId < b.recordId
        ? -1
        : a.recordId > b.recordId
          ? 1
          : 0
      : a.recordType < b.recordType
        ? -1
        : 1,
  );

class Findings {
  readonly list: VerifyFinding[] = [];
  add(code: VerifyReason, message: string, records: readonly RecordRef[] = [], residual?: bigint) {
    this.list.push({
      code,
      message,
      records,
      ...(residual === undefined ? {} : { residual: paise(residual) }),
    });
  }
  get any(): boolean {
    return this.list.length > 0;
  }
}

const rejected = (findings: Findings): VerifyOutcome => ({
  status: 'REJECTED',
  findings: findings.list,
});

export function verifyProposal(
  claim: ProposalClaim,
  snapshot: VerifierSnapshot,
  config: VerifierConfig,
): VerifyOutcome {
  const findings = new Findings();
  if (claim.verdict !== 'MATCH_PROPOSED') {
    findings.add('NOT_A_PROPOSED_MATCH', `the verdict is ${claim.verdict}, not MATCH_PROPOSED`);
    return rejected(findings);
  }
  if (claim.links.length === 0) {
    findings.add('UNSUPPORTED_SHAPE', 'a proposed match links no records');
    return rejected(findings);
  }

  // --- every link must be a real record of this run that is still free ------------------------------
  const seen = new Set<string>();
  for (const link of claim.links) {
    const key = recordKey(link);
    if (seen.has(key)) findings.add('DUPLICATE_LINK', 'the same record is linked twice', [link]);
    seen.add(key);
  }
  /** The linked records of one type, each checked to exist, to be in this run and to be free. */
  const take = <T extends { readonly id: string; readonly runId: string }>(
    type: RecordRef['recordType'],
    records: ReadonlyMap<string, T>,
  ): T[] => {
    const out: T[] = [];
    for (const link of claim.links) {
      if (link.recordType !== type) continue;
      const found = records.get(link.recordId);
      if (found === undefined) {
        findings.add('UNKNOWN_RECORD', `no ${type} with this id exists`, [link]);
      } else if (found.runId !== snapshot.runId) {
        findings.add('CROSS_RUN_RECORD', `this ${type} belongs to a different run`, [link]);
      } else if (snapshot.accepted.has(recordKey(link))) {
        findings.add('ALREADY_MATCHED', `this ${type} is already in an accepted group`, [link]);
      } else {
        out.push(found);
      }
    }
    return out;
  };
  const ledger = take('ledger_entry', snapshot.ledger);
  const payments = take('rzp_payment', snapshot.payments);
  const refunds = take('rzp_refund', snapshot.refunds);
  const settlements = take('rzp_settlement', snapshot.settlements);
  const banks = take('bank_line', snapshot.bankLines);
  // Nothing below is meaningful if a record is missing, foreign, taken or repeated.
  if (findings.any) return rejected(findings);

  if (NEVER_A_MATCH.has(claim.reasonCode)) {
    findings.add(
      'REASON_NOT_A_MATCH',
      `${claim.reasonCode} describes records that do not reconcile, so it cannot accompany a match`,
    );
  }

  const isOrder =
    ledger.length > 0 && payments.length > 0 && settlements.length === 0 && banks.length === 0;
  const isPayout =
    settlements.length === 1 &&
    banks.length === 1 &&
    ledger.length === 0 &&
    payments.length === 0 &&
    refunds.length === 0;
  if (!isOrder && !isPayout) {
    findings.add(
      'UNSUPPORTED_SHAPE',
      `the links (${ledger.length} ledger, ${payments.length} payment, ${refunds.length} refund, ` +
        `${settlements.length} settlement, ${banks.length} bank) are neither an order group ` +
        'nor one settlement with one bank credit',
    );
    return rejected(findings);
  }

  let group: VerifiedGroup;
  const notes: string[] = [];
  if (isOrder) {
    group = verifyOrder(claim, { ledger, payments, refunds }, config, findings);
  } else {
    const [settlement] = settlements;
    const [bank] = banks;
    if (settlement === undefined || bank === undefined) return rejected(findings);
    group = verifyPayout(claim.reasonCode, settlement, bank, snapshot, config, findings, notes);
  }
  if (findings.any) return rejected(findings);
  return { status: 'VERIFIED', group: { ...group, links: sortRefs(claim.links) }, notes };
}

// --- order groups ------------------------------------------------------------------------------------

function verifyOrder(
  claim: ProposalClaim,
  records: { ledger: LedgerEntry[]; payments: RzpPayment[]; refunds: RzpRefund[] },
  config: VerifierConfig,
  findings: Findings,
): VerifiedGroup {
  const { ledger, payments, refunds } = records;
  const reason = claim.reasonCode;
  const ref = (type: RecordRef['recordType'], id: string): RecordRef => ({
    recordType: type,
    recordId: id,
  });
  const payRef = (p: RzpPayment) => ref('rzp_payment', p.id);

  for (const p of payments) {
    if (!p.captured) {
      findings.add('PAYMENT_NOT_CAPTURED', `payment ${p.paymentId} was never captured`, [
        payRef(p),
      ]);
    }
    if (p.currency !== 'INR') {
      findings.add('CURRENCY_NOT_INR', `payment ${p.paymentId} is in ${p.currency}, not INR`, [
        payRef(p),
      ]);
    }
  }
  const paymentByRzpId = new Map(payments.map((p) => [p.paymentId, p]));
  for (const r of refunds) {
    const here = [ref('rzp_refund', r.id)];
    if (r.status !== 'processed') {
      findings.add(
        'REFUND_NOT_PROCESSED',
        `refund ${r.refundId} is ${r.status}, not processed`,
        here,
      );
    }
    if (r.currency !== 'INR') {
      findings.add('CURRENCY_NOT_INR', `refund ${r.refundId} is in ${r.currency}, not INR`, here);
    }
    const payment = paymentByRzpId.get(r.paymentId);
    if (payment === undefined) {
      findings.add(
        'REFUND_PAYMENT_NOT_LINKED',
        `refund ${r.refundId} is against ${r.paymentId}, which is not in the group`,
        here,
      );
    } else if (r.businessDate < payment.businessDate) {
      findings.add('DATE_WINDOW', `refund ${r.refundId} is dated before its payment`, [
        ...here,
        payRef(payment),
      ]);
    }
  }
  // Every refund the payment records must be in the group, or the group is hiding money.
  const refundedBy = new Map<string, bigint>();
  for (const r of refunds) {
    if (r.status === 'processed') {
      refundedBy.set(r.paymentId, (refundedBy.get(r.paymentId) ?? 0n) + r.amount);
    }
  }
  for (const p of payments) {
    const linked = refundedBy.get(p.paymentId) ?? 0n;
    if (linked < p.amountRefunded) {
      findings.add(
        'REFUND_MISSING',
        `payment ${p.paymentId} records ${p.amountRefunded} paise refunded but the group links ${linked}`,
        [payRef(p)],
        p.amountRefunded - linked,
      );
    } else if (linked > p.amountRefunded) {
      findings.add(
        'AMOUNT_MISMATCH',
        `the linked refunds of ${p.paymentId} add up to ${linked} paise but the payment records ${p.amountRefunded}`,
        [payRef(p)],
        linked - p.amountRefunded,
      );
    }
  }

  // The balance, to the paise.
  const ledgerTotal = sum(ledger, (l) => l.amount);
  const paid = sum(payments, (p) => p.amount);
  const refunded = sum(refunds, (r) => (r.status === 'processed' ? r.amount : 0n));
  const residual = ledgerTotal - (paid - refunded);
  if (residual !== 0n) {
    findings.add(
      'AMOUNT_MISMATCH',
      `the ledger totals ${ledgerTotal} paise but payments less refunds total ${paid - refunded}`,
      claim.links,
      residual,
    );
  }

  // Dates, against the matcher's own idea of a window.
  for (const l of ledger) {
    for (const p of payments) {
      const gap = Math.abs(daysBetween(l.businessDate, p.businessDate));
      if (gap > config.orderDateWindowDays) {
        findings.add(
          'DATE_WINDOW',
          `ledger ${l.businessDate} and payment ${p.businessDate} are ${gap} days apart (the limit is ${config.orderDateWindowDays})`,
          [ref('ledger_entry', l.id), payRef(p)],
        );
      }
    }
  }

  // The reason code must fit what was linked.
  if (!NEVER_A_MATCH.has(reason)) {
    if (!ORDER_REASONS.has(reason)) {
      findings.add('REASON_INCONSISTENT', `${reason} describes a payout, not an order`);
    }
    const fullyRefunded = (p: RzpPayment) =>
      (refundedBy.get(p.paymentId) ?? 0n) === p.amount && p.amount > 0n;
    if (reason === 'PARTIAL_REFUND_NETTED') {
      if (refunds.length === 0) {
        findings.add('REASON_INCONSISTENT', 'PARTIAL_REFUND_NETTED needs a refund in the group');
      } else if (payments.some(fullyRefunded)) {
        findings.add(
          'REASON_INCONSISTENT',
          'a payment in the group is refunded in full, not partly',
        );
      }
    }
    if (reason === 'FULL_REFUND') {
      if (refunds.length === 0 || !payments.some(fullyRefunded)) {
        findings.add('REASON_INCONSISTENT', 'FULL_REFUND needs a payment that is refunded in full');
      }
    }
    if (reason === 'DUPLICATE_PAYMENT') {
      const orders = new Set(
        payments.map((p) => p.orderId ?? `receipt:${retryBase(p, config) ?? p.receipt ?? p.id}`),
      );
      const sameOrder =
        orders.size === 1 ||
        new Set(payments.map((p) => retryBase(p, config) ?? p.receipt ?? p.id)).size === 1;
      if (payments.length < 2) {
        findings.add('REASON_INCONSISTENT', 'DUPLICATE_PAYMENT needs two or more payments');
      } else if (!sameOrder) {
        findings.add('REASON_INCONSISTENT', 'the payments are not all for one order');
      }
    }
    if (reason === 'TIMEZONE_DATE_SHIFT') {
      const shifted = ledger.some((l) => payments.some((p) => isDateShift(l, p, config)));
      if (!shifted) {
        findings.add(
          'REASON_INCONSISTENT',
          'no payment falls just after IST midnight on the day after its order',
        );
      }
    }
  }
  return {
    kind: 'order',
    links: [],
    gross: paise(paid),
    residual: ZERO,
  };
}

// --- payout groups -----------------------------------------------------------------------------------

function verifyPayout(
  reason: ReasonCode,
  settlement: RzpSettlement,
  bank: BankLine,
  snapshot: VerifierSnapshot,
  config: VerifierConfig,
  findings: Findings,
  notes: string[],
): VerifiedGroup {
  const settlementRef: RecordRef = { recordType: 'rzp_settlement', recordId: settlement.id };
  const bankRef: RecordRef = { recordType: 'bank_line', recordId: bank.id };

  // The settlement must add up on its own: the very function rule tier T2 applies.
  const items = snapshot.settlementItems.get(settlement.settlementId) ?? [];
  let composition: SettlementComposition | null = null;
  if (items.length === 0) {
    findings.add('SETTLEMENT_UNBALANCED', `settlement ${settlement.settlementId} has no lines`, [
      settlementRef,
    ]);
  } else {
    composition = composeSettlement(settlement, items, {
      payment: (id) => snapshot.paymentsByRzpId.get(id),
      refund: (id) => snapshot.refundsByRzpId.get(id),
    });
    if (!isVerified(composition)) {
      const blocking = composition.issues.filter((i) => i.severity === 'blocking');
      findings.add(
        'SETTLEMENT_UNBALANCED',
        `settlement ${settlement.settlementId} lines compute to ${composition.computed} paise against ${settlement.amount}` +
          (blocking.length > 0 ? `; ${blocking.map((i) => i.code).join(', ')}` : ''),
        [settlementRef],
        composition.residual,
      );
    }
  }
  for (const item of items) {
    if (item.currency !== 'INR') {
      findings.add('CURRENCY_NOT_INR', `line ${item.entityId} is in ${item.currency}, not INR`, [
        settlementRef,
      ]);
    }
  }

  if (bank.direction !== 'credit') {
    findings.add('BANK_LINE_NOT_A_CREDIT', 'the bank line is a debit, not money received', [
      bankRef,
    ]);
  }
  if (bank.amount !== settlement.amount) {
    findings.add(
      'AMOUNT_MISMATCH',
      `the settlement is ${settlement.amount} paise but the bank credit is ${bank.amount}`,
      [settlementRef, bankRef],
      settlement.amount - bank.amount,
    );
  }

  // A trusted UTR on both sides must agree; a weak one is evidence, not a veto.
  const settlementUtr = settlementUtrKey(settlement);
  const utrDiffers =
    settlementUtr !== null &&
    bank.utr !== null &&
    !utrIsWeak(bank) &&
    bank.utr.toUpperCase() !== settlementUtr;
  if (utrDiffers && reason !== 'UTR_MISSING_OR_GARBLED') {
    findings.add(
      'UTR_CONFLICT',
      'the settlement and the bank credit carry different, trusted UTRs',
      [settlementRef, bankRef],
    );
  } else if (utrDiffers) {
    notes.push('the UTRs differ, as UTR_MISSING_OR_GARBLED claims');
  }

  // The credit must land inside the window, or late and said to be late.
  const windowEnd = addBusinessDays(
    settlement.businessDate,
    config.windowBusinessDays,
    config.calendar,
  );
  const horizon = addBusinessDays(windowEnd, config.delayHorizonBusinessDays, config.calendar);
  let late = false;
  if (bank.valueDate < settlement.businessDate) {
    findings.add(
      'DATE_WINDOW',
      `the credit (${bank.valueDate}) is dated before the settlement (${settlement.businessDate})`,
      [settlementRef, bankRef],
    );
  } else if (bank.valueDate > horizon) {
    findings.add(
      'DATE_WINDOW',
      `the credit (${bank.valueDate}) is past the latest plausible date (${horizon})`,
      [settlementRef, bankRef],
    );
  } else if (bank.valueDate > windowEnd) {
    late = true;
    if (reason !== 'SETTLEMENT_DELAYED') {
      findings.add(
        'DATE_WINDOW',
        `the credit (${bank.valueDate}) is after the window (${windowEnd}); only SETTLEMENT_DELAYED may claim that`,
        [settlementRef, bankRef],
      );
    }
  }

  // The reason code must fit.
  if (!NEVER_A_MATCH.has(reason)) {
    if (!PAYOUT_REASONS.has(reason)) {
      findings.add('REASON_INCONSISTENT', `${reason} describes an order, not a payout`);
    }
    if (composition !== null) {
      const need = (ok: boolean, text: string) => {
        if (!ok) findings.add('REASON_INCONSISTENT', text);
      };
      if (reason === 'BATCHED_SETTLEMENT')
        need(
          composition.paymentLines >= 2,
          'BATCHED_SETTLEMENT needs two or more payments in the settlement',
        );
      if (reason === 'FEE_GST_DEDUCTION')
        need(composition.fees > 0n, 'FEE_GST_DEDUCTION needs a settlement that deducted fees');
      if (reason === 'CHARGEBACK_ADJUSTMENT')
        need(
          composition.adjustmentsDebit > 0n,
          'CHARGEBACK_ADJUSTMENT needs a debit adjustment in the settlement',
        );
      if (reason === 'PARTIAL_REFUND_NETTED' || reason === 'FULL_REFUND')
        need(composition.refundLines > 0, `${reason} needs a refund line in the settlement`);
    }
    if (reason === 'SETTLEMENT_DELAYED' && !late) {
      // Two ways to be late: the credit missed the window (above), or Razorpay created the settlement
      // later than its payments' capture date plus the normal lag.
      const capturedOn = composition?.paymentIds.flatMap((id) => {
        const date = snapshot.paymentsByRzpId.get(id)?.businessDate;
        return date === undefined ? [] : [date];
      });
      if (!settlementCreatedLate(settlement.businessDate, capturedOn ?? [], config)) {
        findings.add(
          'REASON_INCONSISTENT',
          'SETTLEMENT_DELAYED, but the settlement was created on time and the credit is inside the normal window',
        );
      }
    }
    if (reason === 'UTR_MISSING_OR_GARBLED' && !utrDiffers && !utrIsWeak(bank)) {
      findings.add(
        'REASON_INCONSISTENT',
        'UTR_MISSING_OR_GARBLED, but both UTRs are present, trusted and equal',
      );
    }
  }
  return { kind: 'payout', links: [], gross: settlement.amount, residual: ZERO };
}
