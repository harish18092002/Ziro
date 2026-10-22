// T1: a ledger entry <-> the captured payment for its order. The join key is the order reference on
// the ledger and the `receipt` on the Razorpay order (compared after the same cleaning), and the
// amounts must be equal to the paise. Anything short of one ledger entry and one captured payment
// agreeing exactly is an exception with the candidates attached: the rules never pick a winner.
import {
  type LedgerEntry,
  ReasonCode,
  type RecordRef,
  type RzpPayment,
  type RzpRefund,
} from '../domain/index.js';
import { normalizeRef } from '../normalize/index.js';
import { addDaysToBusinessDate, istDayBounds } from '../time/index.js';
import { addException, addGroup, addIgnored, byId, type MatchState, pushTo } from './state.js';
import {
  type ExceptionCause,
  type MatcherConfig,
  type MatcherInput,
  type OrderEvidence,
  ref,
  RULE_IDS,
} from './types.js';
import { paise } from '../money/index.js';

interface Pair {
  readonly ledger: LedgerEntry;
  readonly payment: RzpPayment;
}

const ledgerRef = (l: LedgerEntry) => ref('ledger_entry', l.id);
const paymentRef = (p: RzpPayment) => ref('rzp_payment', p.id);
const refundRef = (r: RzpRefund) => ref('rzp_refund', r.id);

/** Minutes between IST midnight of the payment's business date and the payment, or null if unparseable. */
function minutesIntoIstDay(payment: RzpPayment): number | null {
  const ms = Date.parse(payment.createdAt);
  if (Number.isNaN(ms)) return null;
  return (Math.floor(ms / 1000) - istDayBounds(payment.businessDate).fromEpoch) / 60;
}

export function matchOrders(input: MatcherInput, config: MatcherConfig, state: MatchState): void {
  // --- index ---------------------------------------------------------------------------------
  const ledgerByKey = new Map<string, LedgerEntry[]>();
  const keylessLedger: LedgerEntry[] = [];
  for (const entry of input.ledger) {
    const key = normalizeRef(entry.orderRef);
    if (key === null) keylessLedger.push(entry);
    else pushTo(ledgerByKey, key, entry);
  }

  const capturedByKey = new Map<string, RzpPayment[]>();
  const uncapturedByKey = new Map<string, RzpPayment[]>();
  const keylessCaptured: RzpPayment[] = [];
  const paymentByRzpId = new Map<string, RzpPayment>();
  for (const payment of input.payments) {
    paymentByRzpId.set(payment.paymentId, payment);
    const key = payment.receipt === null ? null : normalizeRef(payment.receipt);
    if (!payment.captured) {
      addIgnored(state, paymentRef(payment), 'payment_not_captured');
      if (key !== null) pushTo(uncapturedByKey, key, payment);
    } else if (key === null) {
      keylessCaptured.push(payment);
    } else {
      pushTo(capturedByKey, key, payment);
    }
  }

  const refundsByPayment = new Map<string, RzpRefund[]>();
  for (const refund of input.refunds) {
    if (refund.status === 'failed') addIgnored(state, refundRef(refund), 'refund_failed');
    else pushTo(refundsByPayment, refund.paymentId, refund);
  }
  for (const list of refundsByPayment.values()) list.sort(byId);
  const accountedRefunds = new Set<string>();

  /** A payment exception also takes in the payment's refunds as context, so they are not orphaned. */
  const paymentException = (
    payment: RzpPayment,
    args: {
      reasonCode: ReasonCode;
      cause: ExceptionCause;
      note: string;
      candidates: readonly RecordRef[];
      amountAtStake: bigint;
    },
  ): void => {
    const refunds = refundsByPayment.get(payment.paymentId) ?? [];
    for (const refund of refunds) {
      if (!accountedRefunds.has(refund.id)) {
        accountedRefunds.add(refund.id);
        addIgnored(state, refundRef(refund), 'refund_follows_payment_exception');
      }
    }
    addException(state, {
      ...args,
      subject: paymentRef(payment),
      candidates: [...args.candidates, ...refunds.map(refundRef)],
    });
  };

  // --- decide each order reference -------------------------------------------------------------
  const pairs: Pair[] = [];
  const orphanPayments: RzpPayment[] = [...keylessCaptured];
  const keys = [...new Set([...ledgerByKey.keys(), ...capturedByKey.keys()])].sort();

  for (const key of keys) {
    const ledger = ledgerByKey.get(key) ?? [];
    const payments = capturedByKey.get(key) ?? [];

    if (ledger.length === 1 && payments.length === 1) {
      const l = ledger[0] as LedgerEntry;
      const p = payments[0] as RzpPayment;
      if (l.amount === p.amount) {
        pairs.push({ ledger: l, payment: p });
      } else {
        const gap = `ledger ${l.amount} paise, payment ${p.amount} paise`;
        addException(state, {
          reasonCode: ReasonCode.UNKNOWN,
          subject: ledgerRef(l),
          candidates: [paymentRef(p)],
          amountAtStake: l.amount - p.amount,
          cause: 'receipt_amount_differs',
          note: `the receipt matches one captured payment but the amounts differ (${gap})`,
        });
        paymentException(p, {
          reasonCode: ReasonCode.UNKNOWN,
          cause: 'receipt_amount_differs',
          note: `the receipt matches one ledger entry but the amounts differ (${gap})`,
          candidates: [ledgerRef(l)],
          amountAtStake: p.amount - l.amount,
        });
      }
    } else if (ledger.length === 1 && payments.length === 0) {
      const l = ledger[0] as LedgerEntry;
      const uncaptured = uncapturedByKey.get(key) ?? [];
      addException(state, {
        reasonCode:
          uncaptured.length === 0 ? ReasonCode.LEDGER_WITHOUT_PAYMENT : ReasonCode.UNKNOWN,
        subject: ledgerRef(l),
        candidates: uncaptured.map(paymentRef),
        amountAtStake: l.amount,
        cause: uncaptured.length === 0 ? 'ledger_has_no_payment' : 'ledger_payment_not_captured',
        note:
          uncaptured.length === 0
            ? 'no payment of any status carries this order reference'
            : 'the only payments for this order reference were never captured',
      });
    } else if (ledger.length === 0) {
      orphanPayments.push(...payments);
    } else {
      // More than one ledger entry or more than one captured payment for one reference.
      const everyone = [...ledger.map(ledgerRef), ...payments.map(paymentRef)];
      const sameAmount =
        payments.length >= 2 &&
        payments.every((p) => p.amount === (payments[0] as RzpPayment).amount);
      const reasonCode = sameAmount ? ReasonCode.DUPLICATE_PAYMENT : ReasonCode.UNKNOWN;
      const note = `${ledger.length} ledger entries and ${payments.length} captured payments share this reference`;
      for (const l of ledger) {
        addException(state, {
          reasonCode,
          subject: ledgerRef(l),
          candidates: everyone,
          amountAtStake: l.amount,
          cause: 'receipt_ambiguous',
          note,
        });
      }
      for (const p of payments) {
        paymentException(p, {
          reasonCode,
          cause: 'receipt_ambiguous',
          note,
          candidates: everyone,
          amountAtStake: p.amount,
        });
      }
    }
  }

  for (const l of keylessLedger) {
    addException(state, {
      reasonCode: ReasonCode.UNKNOWN,
      subject: ledgerRef(l),
      candidates: [],
      amountAtStake: l.amount,
      cause: 'ledger_has_no_reference',
      note: 'the order reference is empty once cleaned, so there is nothing to join on',
    });
  }

  // --- groups, with the refunds that belong to each payment -------------------------------------
  const pairByLedgerKey = new Map<string, Pair>();
  for (const pair of pairs.sort((a, b) => byId(a.ledger, b.ledger))) {
    const { ledger, payment } = pair;
    const key = normalizeRef(ledger.orderRef) as string;
    pairByLedgerKey.set(key, pair);

    const refunds = refundsByPayment.get(payment.paymentId) ?? [];
    const total = refunds.reduce((sum, r) => sum + r.amount, 0n);
    let attached: readonly RzpRefund[] = refunds;
    let reasonCode: ReasonCode | null = null;

    if (total > payment.amount) {
      attached = [];
      for (const refund of refunds) {
        accountedRefunds.add(refund.id);
        addException(state, {
          reasonCode: ReasonCode.UNKNOWN,
          subject: refundRef(refund),
          candidates: [paymentRef(payment)],
          amountAtStake: refund.amount,
          cause: 'refund_exceeds_payment',
          note: `refunds total ${total} paise against a payment of ${payment.amount} paise`,
        });
      }
    } else if (total === payment.amount && refunds.length > 0) {
      reasonCode = ReasonCode.FULL_REFUND;
    } else if (total > 0n) {
      reasonCode = ReasonCode.PARTIAL_REFUND_NETTED;
    }
    for (const refund of attached) accountedRefunds.add(refund.id);

    if (reasonCode === null && isDateShift(ledger, payment, config)) {
      reasonCode = ReasonCode.TIMEZONE_DATE_SHIFT;
    }

    const evidence: OrderEvidence = {
      ledgerAmount: ledger.amount,
      paymentAmount: payment.amount,
      refundsTotal: paise(attached.reduce((sum, r) => sum + r.amount, 0n)),
    };
    addGroup(state, {
      kind: 'order',
      tier: 'T1',
      ruleId: RULE_IDS.T1,
      reasonCode,
      residual: paise(ledger.amount - payment.amount),
      members: [ledgerRef(ledger), paymentRef(payment), ...attached.map(refundRef)],
      evidence,
    });
  }

  // --- payments with no ledger entry of their own ----------------------------------------------
  for (const payment of orphanPayments.sort(byId)) {
    const base = retryBase(payment, config);
    const original = base === null ? undefined : pairByLedgerKey.get(base);
    const baseLedger = base === null ? undefined : ledgerByKey.get(base);

    if (original !== undefined && original.payment.amount === payment.amount) {
      paymentException(payment, {
        reasonCode: ReasonCode.DUPLICATE_PAYMENT,
        cause: 'payment_is_retry_duplicate',
        note: `a retry of ${base ?? ''}, which is already matched to a payment of the same amount`,
        candidates: [paymentRef(original.payment), ledgerRef(original.ledger)],
        amountAtStake: payment.amount,
      });
    } else if (original !== undefined) {
      paymentException(payment, {
        reasonCode: ReasonCode.UNKNOWN,
        cause: 'payment_retry_of_other_amount',
        note: `a retry of ${base ?? ''}, which is matched to a payment of a different amount (${original.payment.amount} paise)`,
        candidates: [paymentRef(original.payment), ledgerRef(original.ledger)],
        amountAtStake: payment.amount,
      });
    } else if (baseLedger !== undefined) {
      paymentException(payment, {
        reasonCode: ReasonCode.UNKNOWN,
        cause: 'payment_retry_of_unresolved_order',
        note: `a retry of ${base ?? ''}, whose own order is not cleanly matched`,
        candidates: baseLedger.map(ledgerRef),
        amountAtStake: payment.amount,
      });
    } else {
      paymentException(payment, {
        reasonCode: ReasonCode.PAYMENT_WITHOUT_LEDGER,
        cause: 'payment_has_no_ledger',
        note: "no ledger entry carries this payment's receipt",
        candidates: [],
        amountAtStake: payment.amount,
      });
    }
  }

  // --- refunds whose payment is nowhere to be matched --------------------------------------------
  for (const refund of [...input.refunds].sort(byId)) {
    if (refund.status === 'failed' || accountedRefunds.has(refund.id)) continue;
    const payment = paymentByRzpId.get(refund.paymentId);
    addException(state, {
      reasonCode: ReasonCode.UNKNOWN,
      subject: refundRef(refund),
      candidates: payment === undefined ? [] : [paymentRef(payment)],
      amountAtStake: refund.amount,
      cause: 'refund_without_payment',
      note:
        payment === undefined
          ? 'the refunded payment is not in the data'
          : 'the refunded payment was never captured',
    });
  }
}

export function retryBase(payment: RzpPayment, config: MatcherConfig): string | null {
  if (config.retryReceiptPattern === null || payment.receipt === null) return null;
  const key = normalizeRef(payment.receipt);
  const base = key === null ? undefined : config.retryReceiptPattern.exec(key)?.[1];
  return base === undefined ? null : base;
}

/** The order was dated the day before the payment, and the payment came just after IST midnight. */
export function isDateShift(
  ledger: LedgerEntry,
  payment: RzpPayment,
  config: MatcherConfig,
): boolean {
  if (addDaysToBusinessDate(ledger.businessDate, 1) !== payment.businessDate) return false;
  const minutes = minutesIntoIstDay(payment);
  return minutes !== null && minutes >= 0 && minutes < config.dateShiftWindowMinutes;
}
