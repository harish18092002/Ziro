import { add, type Paise, paise, sub, sum } from '@ziro/core/money';
import { countFor } from '../config.js';
import { epochFromIst, formatIsoDay, istDay } from '../time.js';
import { at, compareStrings, pad } from '../util.js';
import { addMember, newAnomaly, type OrderWorld, type WorldContext } from './orders.js';
import {
  type AnomalyRec,
  type ItemRec,
  newLabel,
  type OrderRec,
  type PaymentRec,
  type RefundRec,
  type SettlementRec,
} from './types.js';

/** A settlement can never be absorbed down to nothing: keep at least ₹1.00 of net. */
const MIN_NET = paise(100n);
const UTR_BANKS = ['UTIB', 'HDFC', 'ICIC'];
/** RTGS has a ₹2 lakh minimum, so settlements at or above it arrive as RTGS. */
const RTGS_MINIMUM = paise(20_000_000n);

export interface SettleResult {
  readonly settlements: SettlementRec[];
  readonly items: ItemRec[];
  readonly refunds: RefundRec[];
  /** SETTLEMENT_DELAYED anomalies by settlement id, so the bank stage can add the credit line. */
  readonly delayed: Map<string, AnomalyRec>;
}

interface Draft {
  readonly id: string;
  readonly groupId: string;
  readonly captureDay: number;
  settleDay: number;
  createdAt: number;
  bankDay: number;
  readonly items: ItemRec[];
  net: Paise;
  delayedBy: number;
}

export function buildSettlements(ctx: WorldContext, world: OrderWorld): SettleResult {
  const { config, ids, cal, lastDay } = ctx;
  const rng = ctx.rng.fork('settlements');
  const orderById = new Map<string, OrderRec>(world.orders.map((o) => [o.id, o]));

  // 1. Batch captured payments by the IST day they were captured: one settlement per capture day.
  const captured = world.payments
    .filter((p) => p.status !== 'failed')
    .sort((a, b) => a.createdAt - b.createdAt || compareStrings(a.id, b.id));
  const byDay = new Map<number, PaymentRec[]>();
  for (const payment of captured) {
    const day = istDay(payment.createdAt);
    const batch = byDay.get(day);
    if (batch) batch.push(payment);
    else byDay.set(day, [payment]);
  }

  const drafts: Draft[] = [];
  for (const [captureDay, payments] of byDay) {
    const settleDay = cal.addBusinessDays(captureDay, config.settlementLagBusinessDays);
    const id = ids.make('setl_');
    const createdAt = epochFromIst(settleDay, rng.int(6 * 3600, 11 * 3600));
    const items: ItemRec[] = payments.map((p) =>
      paymentItem(p, id, createdAt, orderById, `PG-${pad(drafts.length + 1, 6)}`),
    );
    drafts.push({
      id,
      groupId: `PG-${pad(drafts.length + 1, 6)}`,
      captureDay,
      settleDay,
      createdAt,
      bankDay: settleDay,
      items,
      net: sum(items.map((item) => item.credit)),
      delayedBy: 0,
    });
  }

  // 2. SETTLEMENT_DELAYED: an exact count of settlements arrive late. Each is pushed 2..5 business
  //    days past T+2, shortened if needed so the money still lands inside the statement window.
  const delayed = new Map<string, AnomalyRec>();
  const wantDelayed = countFor(config.rates.SETTLEMENT_DELAYED, drafts.length);
  for (const index of rng.fork('delays').shuffle(drafts.map((_, i) => i))) {
    if (delayed.size === wantDelayed) break;
    const draft = at(drafts, index);
    for (let extra = rng.int(2, 5); extra >= 2; extra--) {
      const settleDay = cal.addBusinessDays(draft.settleDay, extra);
      if (settleDay > lastDay - 1) continue;
      const wasDay = draft.settleDay;
      draft.settleDay = settleDay;
      draft.createdAt = epochFromIst(settleDay, rng.int(6 * 3600, 11 * 3600));
      draft.delayedBy = extra;
      draft.bankDay = settleDay;
      const anomaly = newAnomaly(ctx, 'SETTLEMENT_DELAYED', {
        settlementId: draft.id,
        expectedSettleDate: formatIsoDay(wasDay),
        actualSettleDate: formatIsoDay(settleDay),
        businessDaysLate: String(extra),
      });
      addMember(anomaly, 'rzp_settlement', draft.id, 'delayed_settlement');
      delayed.set(draft.id, anomaly);
      break;
    }
  }
  if (delayed.size < wantDelayed) {
    throw new RangeError(
      `cannot place ${wantDelayed} delayed settlements inside the statement window`,
    );
  }
  // Item settled_at follows the (possibly delayed) settlement time.
  for (const draft of drafts) {
    draft.items.forEach((item, i) => {
      draft.items[i] = { ...item, settledAt: draft.createdAt };
    });
    draft.bankDay = draft.settleDay + (rng.chance(config.bank.lagOneDayBps) ? 1 : 0);
  }

  // 3. Debits (refunds, chargebacks) are netted out of the first settlement that can absorb them.
  const sorted = [...drafts].sort(
    (a, b) => a.settleDay - b.settleDay || a.createdAt - b.createdAt || compareStrings(a.id, b.id),
  );
  const draftByPayment = new Map<string, Draft>();
  for (const draft of drafts) {
    for (const item of draft.items) draftByPayment.set(item.entityId, draft);
  }

  const place = (fromDay: number, amount: Paise, what: string): Draft => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at(sorted, mid).settleDay < fromDay) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < sorted.length; i++) {
      const draft = at(sorted, i);
      if (sub(draft.net, amount) >= MIN_NET) return draft;
    }
    throw new RangeError(
      `no settlement on or after day ${fromDay} can absorb ${what}; add orders or lower the debit rates`,
    );
  };

  const refunds: RefundRec[] = [];
  for (const plan of world.refundPlans) {
    const payment = plan.payment;
    const source = draftByPayment.get(payment.id);
    if (!source) throw new Error(`refund planned for unsettled payment ${payment.id}`);
    const refundDay = source.settleDay + rng.int(1, 4);
    const createdAt = epochFromIst(refundDay, rng.int(10 * 3600, 18 * 3600));
    const target = place(refundDay + 1, plan.amount, `refund of ${payment.id}`);

    const refund: RefundRec = {
      id: ids.make('rfnd_'),
      paymentId: payment.id,
      amount: plan.amount,
      createdAt,
      reason: plan.reason,
      notes: { comment: plan.reason },
      label: newLabel('normal', payment.label.groupId),
    };
    refunds.push(refund);
    const item: ItemRec = {
      settlementId: target.id,
      type: 'refund',
      entityId: refund.id,
      paymentId: payment.id,
      orderId: null,
      receipt: null,
      method: payment.method,
      cardNetwork: payment.cardNetwork,
      cardType: payment.cardType,
      cardIssuer: payment.method === 'card' ? payment.customer.bank4 : null,
      amount: plan.amount,
      fee: paise(0n),
      tax: paise(0n),
      debit: plan.amount,
      credit: paise(0n),
      createdAt,
      settledAt: target.createdAt,
      description: null,
      disputeId: null,
      label: newLabel('settlement_line', target.groupId),
    };
    target.items.push(item);
    target.net = sub(target.net, plan.amount);

    payment.amountRefunded = add(payment.amountRefunded, plan.amount);
    if (payment.amountRefunded === payment.amount) payment.status = 'refunded';

    if (plan.anomaly) {
      const duplicate = plan.anomaly.code === 'DUPLICATE_PAYMENT';
      addMember(plan.anomaly, 'rzp_refund', refund.id, duplicate ? 'duplicate_refund' : 'refund');
      addMember(
        plan.anomaly,
        'settlement_item',
        `${target.id}:${refund.id}`,
        duplicate ? 'duplicate_refund_line' : 'refund_line',
      );
    }
  }

  for (const plan of world.chargebackPlans) {
    const payment = plan.payment;
    const source = draftByPayment.get(payment.id);
    if (!source) throw new Error(`chargeback planned for unsettled payment ${payment.id}`);
    const disputeDay = source.settleDay + rng.int(5, 14);
    const createdAt = epochFromIst(disputeDay, rng.int(10 * 3600, 18 * 3600));
    const target = place(disputeDay, payment.amount, `chargeback on ${payment.id}`);
    const adjustmentId = ids.make('adj_');
    const disputeId = ids.make('disp_');

    target.items.push({
      settlementId: target.id,
      type: 'adjustment',
      entityId: adjustmentId,
      // Like the documented adjustment sample, the line does not name the payment: it is only in
      // the description. Linking the two is part of the exercise.
      paymentId: null,
      orderId: null,
      receipt: null,
      method: null,
      cardNetwork: null,
      cardType: null,
      cardIssuer: null,
      amount: payment.amount,
      fee: paise(0n),
      tax: paise(0n),
      debit: payment.amount,
      credit: paise(0n),
      createdAt,
      settledAt: target.createdAt,
      description: `Chargeback: dispute ${disputeId} on ${payment.id}`,
      disputeId,
      label: newLabel('settlement_line', target.groupId),
    });
    target.net = sub(target.net, payment.amount);
    addMember(plan.anomaly, 'settlement_item', `${target.id}:${adjustmentId}`, 'adjustment_line');
    plan.anomaly.detail['settlementId'] = target.id;
    plan.anomaly.detail['adjustmentId'] = adjustmentId;
    plan.anomaly.detail['disputeId'] = disputeId;
  }

  // 4. Freeze: settlements get their UTR once the net (and so RTGS vs NEFT) is known.
  const settlements: SettlementRec[] = [];
  const items: ItemRec[] = [];
  for (const draft of drafts) {
    const mode = draft.net >= RTGS_MINIMUM ? 'R' : 'N';
    settlements.push({
      id: draft.id,
      utr: `${rng.pick(UTR_BANKS)}${mode}${rng.digits(11)}`,
      amount: draft.net,
      createdAt: draft.createdAt,
      settleDay: draft.settleDay,
      bankDay: draft.bankDay,
      label: newLabel('normal', draft.groupId),
    });
    items.push(...draft.items);
  }
  return { settlements, items, refunds, delayed };
}

function paymentItem(
  payment: PaymentRec,
  settlementId: string,
  settledAt: number,
  orderById: Map<string, OrderRec>,
  groupId: string,
): ItemRec {
  if (payment.fee === null || payment.tax === null)
    throw new Error(`captured payment ${payment.id} has no fee`);
  return {
    settlementId,
    type: 'payment',
    entityId: payment.id,
    paymentId: null,
    orderId: payment.orderId,
    receipt: orderById.get(payment.orderId)?.receipt ?? null,
    method: payment.method,
    cardNetwork: payment.cardNetwork,
    cardType: payment.cardType,
    cardIssuer: payment.method === 'card' ? payment.customer.bank4 : null,
    amount: payment.amount,
    fee: payment.fee,
    tax: payment.tax,
    debit: paise(0n),
    credit: sub(payment.amount, payment.fee),
    createdAt: payment.createdAt,
    settledAt,
    description: null,
    disputeId: null,
    label: newLabel('settlement_line', groupId),
  };
}
