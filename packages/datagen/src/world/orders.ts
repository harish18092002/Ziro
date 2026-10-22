import type { ReasonCode } from '@ziro/core/domain';
import {
  formatRupees,
  gstOnFee,
  type Paise,
  paise,
  percentOfHalfUp,
  add,
  sub,
} from '@ziro/core/money';
import { countFor, type GenConfig, type Method, ORDER_POOL_CODES } from '../config.js';
import type { IdFactory } from '../ids.js';
import type { Rng } from '../rng.js';
import { type BusinessCalendar, epochFromIst, formatIsoDay, SECONDS_PER_DAY } from '../time.js';
import { at, divFloor, maxInt, minInt, pad } from '../util.js';
import {
  type AnomalyRec,
  type Customer,
  type LedgerRec,
  newLabel,
  type OrderRec,
  type PaymentRec,
  type RecordType,
} from './types.js';

type PoolCode = (typeof ORDER_POOL_CODES)[number];
type OrderRole = 'normal' | PoolCode;

/**
 * Days a refund or chargeback chain can run after an order, in the worst case: settlement
 * (<= 7 days, holidays included) + a delayed settlement (<= 7 more) + the refund or dispute lag +
 * the wait for a settlement big enough to absorb it. Orders too close to the end of the statement
 * are not eligible for these roles, so everything lands inside the window.
 */
const REFUND_HORIZON_DAYS = 28;
const CHARGEBACK_HORIZON_DAYS = 38;
/** An order this late in the day is not given a duplicate: its retry must stay on the same IST day. */
const DUPLICATE_LATEST_SECOND = 84_000;
/** A failed attempt needs room before midnight for the retry that follows it. */
const FAILED_ATTEMPT_LATEST_SECOND = 82_800;

const HOUR_WEIGHTS = [
  1, 1, 1, 1, 1, 2, 3, 5, 8, 10, 12, 12, 11, 10, 10, 11, 12, 13, 14, 14, 13, 10, 6, 3,
];

const PRICE_TIERS = [
  { value: [199, 499], weight: 4 },
  { value: [500, 999], weight: 5 },
  { value: [1000, 2499], weight: 5 },
  { value: [2500, 4999], weight: 3 },
  { value: [5000, 9999], weight: 2 },
  { value: [10_000, 24_999], weight: 1 },
] as const;

/** -1 means "a random 1..98 paise"; the rest are the usual retail endings. */
const PAISE_ENDINGS = [
  { value: 0, weight: 70 },
  { value: 50, weight: 10 },
  { value: 99, weight: 10 },
  { value: 49, weight: 5 },
  { value: -1, weight: 5 },
];

const PARTIAL_REFUND_BPS = [1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7500, 9000];

const NORMAL_MEMOS = [
  '',
  '',
  'Online order',
  'Gift wrap requested',
  'Repeat customer',
  'Express delivery',
  'Festival sale order',
  'Delivered to alternate address',
];
const CASH_MEMOS = [
  'COD - cash collected on delivery',
  'Cash sale at counter',
  'Pay on delivery (courier remittance pending)',
];
const CARD_NETWORKS = ['Visa', 'MasterCard', 'RuPay'];
const BANKS = ['HDFC', 'ICIC', 'SBIN', 'UTIB', 'KKBK', 'YESB'];
const UPI_HANDLES = ['okaxis', 'oksbi', 'okhdfcbank', 'ybl', 'paytm'];
const FAILURES = [
  {
    code: 'BAD_REQUEST_ERROR',
    description: 'Payment failed due to incorrect OTP',
    source: 'customer',
    step: 'payment_authentication',
    reason: 'incorrect_otp',
  },
  {
    code: 'BAD_REQUEST_ERROR',
    description: 'Payment was cancelled by the customer',
    source: 'customer',
    step: 'payment_authentication',
    reason: 'payment_cancelled',
  },
  {
    code: 'BAD_REQUEST_ERROR',
    description: 'Payment declined by the issuing bank',
    source: 'issuer',
    step: 'payment_authorization',
    reason: 'payment_declined',
  },
] as const;

export interface WorldContext {
  readonly config: GenConfig;
  readonly rng: Rng;
  readonly ids: IdFactory;
  readonly cal: BusinessCalendar;
  /** IST day number of the first day of the statement. */
  readonly startDay: number;
  /** IST day number of the last day of the statement. */
  readonly lastDay: number;
  readonly anomalies: AnomalyRec[];
}

/** A refund to be created and debited from a settlement once settlement dates are known. */
export interface RefundPlan {
  readonly payment: PaymentRec;
  readonly amount: Paise;
  readonly reason: string;
  readonly anomaly: AnomalyRec | null;
}

export interface ChargebackPlan {
  readonly payment: PaymentRec;
  readonly anomaly: AnomalyRec;
}

export interface OrderWorld {
  readonly ledger: LedgerRec[];
  readonly orders: OrderRec[];
  readonly payments: PaymentRec[];
  readonly refundPlans: RefundPlan[];
  readonly chargebackPlans: ChargebackPlan[];
  readonly customers: readonly Customer[];
}

interface Plan {
  index: number;
  readonly day: number;
  second: number;
  readonly amount: Paise;
  readonly method: Method;
  readonly customer: Customer;
  role: OrderRole;
  ref: string;
}

export function newAnomaly(
  ctx: WorldContext,
  code: ReasonCode,
  detail: Record<string, string>,
): AnomalyRec {
  const anomaly: AnomalyRec = { id: '', code, records: [], detail };
  ctx.anomalies.push(anomaly);
  return anomaly;
}

export function addMember(anomaly: AnomalyRec, type: RecordType, key: string, role: string): void {
  anomaly.records.push({ type, key, role });
}

function makeCustomers(count: number): Customer[] {
  const customers: Customer[] = [];
  for (let i = 0; i < count; i++) {
    const n = pad(i + 1, 5);
    customers.push({
      ref: `CUST-${n}`,
      email: `cust${n}@example.com`,
      // +91 followed by a number starting 0000 can never be a real mobile number.
      contact: `+910000${pad(i + 1, 6)}`,
      vpa: `cust${n}@${at(UPI_HANDLES, i % UPI_HANDLES.length)}`,
      bank4: at(BANKS, i % BANKS.length),
    });
  }
  return customers;
}

export function drawAmount(rng: Rng): Paise {
  const [lo, hi] = rng.weighted(PRICE_TIERS.map((t) => ({ value: t.value, weight: t.weight })));
  const rupees = rng.int(lo, hi);
  const ending = rng.weighted(PAISE_ENDINGS);
  const paiseDigits = ending === -1 ? rng.int(1, 98) : ending;
  return paise(BigInt(rupees) * 100n + BigInt(paiseDigits));
}

function drawSecondOfDay(rng: Rng): number {
  const hour = rng.weighted(HOUR_WEIGHTS.map((weight, value) => ({ value, weight })));
  return hour * 3600 + rng.int(0, 3599);
}

function payDelay(rng: Rng, method: Method): number {
  if (method === 'card') return rng.int(20, 180);
  if (method === 'upi') return rng.int(15, 300);
  return rng.int(40, 420);
}

function drawMethod(rng: Rng, config: GenConfig): Method {
  const w = config.methodWeights;
  return rng.weighted<Method>([
    { value: 'card', weight: w.card },
    { value: 'upi', weight: w.upi },
    { value: 'netbanking', weight: w.netbanking },
  ]);
}

interface FeeSplit {
  readonly fee: Paise;
  readonly tax: Paise;
}

/** Razorpay's fee is GST-inclusive: fee = base + GST, tax = GST on the base (ADR-004). */
function feeFor(amount: Paise, feeBps: number, gstBps: number): FeeSplit {
  const base = percentOfHalfUp(amount, feeBps);
  const tax = gstOnFee(base, gstBps);
  return { fee: add(base, tax), tax };
}

function allocateRoles(ctx: WorldContext, plans: Plan[]): void {
  const { config, rng, startDay } = ctx;
  const cap = config.debitCapPaise;
  const eligible = (code: PoolCode, plan: Plan): boolean => {
    const room = config.days - 1 - (plan.day - startDay);
    switch (code) {
      case 'CHARGEBACK_ADJUSTMENT':
        return room >= CHARGEBACK_HORIZON_DAYS && plan.amount <= cap;
      case 'FULL_REFUND':
      case 'PARTIAL_REFUND_NETTED':
        return room >= REFUND_HORIZON_DAYS && plan.amount <= cap;
      case 'DUPLICATE_PAYMENT':
        return (
          plan.second <= DUPLICATE_LATEST_SECOND &&
          plan.amount <= cap &&
          room >= REFUND_HORIZON_DAYS
        );
      default:
        return true;
    }
  };

  const order = rng.fork('roles').shuffle(plans.map((_, index) => index));
  for (const code of ORDER_POOL_CODES) {
    const want = countFor(config.rates[code], config.orders);
    let found = 0;
    for (const index of order) {
      if (found === want) break;
      const plan = at(plans, index);
      if (plan.role !== 'normal' || !eligible(code, plan)) continue;
      plan.role = code;
      found += 1;
    }
    if (found < want) {
      throw new RangeError(
        `cannot place ${want} ${code} orders: only ${found} eligible. Increase orders or days, or lower the rate.`,
      );
    }
  }
}

/** Builds ledger rows, Razorpay orders and payments, and the plans for refunds and chargebacks. */
export function buildOrders(ctx: WorldContext): OrderWorld {
  const { config, rng, ids, startDay } = ctx;
  const orderDays = config.days - config.tailDays;
  const customers = makeCustomers(maxInt(8, divFloor(config.orders, 3)));

  // 1. Plan every ledger row: when, how much, who, how they pay.
  const planRng = rng.fork('plans');
  const plans: Plan[] = [];
  for (let i = 0; i < config.orders; i++) {
    plans.push({
      index: 0,
      day: startDay + planRng.int(0, orderDays - 1),
      second: drawSecondOfDay(planRng),
      amount: drawAmount(planRng),
      method: drawMethod(planRng, config),
      customer: at(customers, planRng.int(0, customers.length - 1)),
      role: 'normal',
      ref: '',
    });
  }
  plans.sort((a, b) => a.day - b.day || a.second - b.second);
  plans.forEach((plan, index) => {
    plan.index = index;
    plan.ref = `ORD-${100_001 + index}`;
  });

  // 2. Hand out the anomalies by exact count, then pick the failed-attempt noise the same way.
  allocateRoles(ctx, plans);
  const failedRng = rng.fork('failed');
  const failedWanted = countFor(config.failedAttemptBps, config.orders);
  const failedSet = new Set<number>();
  for (const index of failedRng.shuffle(plans.map((_, i) => i))) {
    if (failedSet.size === failedWanted) break;
    const plan = at(plans, index);
    const clean =
      plan.role !== 'LEDGER_WITHOUT_PAYMENT' &&
      plan.role !== 'TIMEZONE_DATE_SHIFT' &&
      plan.role !== 'DUPLICATE_PAYMENT';
    if (clean && plan.second <= FAILED_ATTEMPT_LATEST_SECOND) failedSet.add(index);
  }

  const world: OrderWorld = {
    ledger: [],
    orders: [],
    payments: [],
    refundPlans: [],
    chargebackPlans: [],
    customers,
  };

  const feeRng = rng.fork('fees');
  const miscRng = rng.fork('misc');
  const timeRng = rng.fork('times');

  const makePayment = (args: {
    orderId: string;
    amount: Paise;
    method: Method;
    customer: Customer;
    createdAt: number;
    contractedBps: number;
    chargedBps: number;
    role: string;
    groupId: string | null;
  }): PaymentRec => {
    const charged = feeFor(args.amount, args.chargedBps, config.gstBps);
    const expected = feeFor(args.amount, args.contractedBps, config.gstBps);
    const isCard = args.method === 'card';
    return {
      id: ids.make('pay_'),
      orderId: args.orderId,
      amount: args.amount,
      fee: charged.fee,
      tax: charged.tax,
      expectedFee: expected.fee,
      method: args.method,
      status: 'captured',
      amountRefunded: paise(0n),
      createdAt: args.createdAt,
      customer: args.customer,
      notes: miscRng.chance(6000) ? { customer_ref: args.customer.ref } : null,
      description: 'Online order payment',
      cardId: isCard ? ids.make('card_') : null,
      cardNetwork: isCard ? miscRng.pick(CARD_NETWORKS) : null,
      cardType: isCard ? miscRng.pick(['credit', 'debit']) : null,
      bank4: args.method === 'netbanking' ? args.customer.bank4 : null,
      vpa: args.method === 'upi' ? args.customer.vpa : null,
      rrn: miscRng.digits(12),
      error: null,
      label: newLabel(args.role, args.groupId),
    };
  };

  const makeOrder = (args: {
    receipt: string | null;
    amount: Paise;
    attempts: number;
    notes: Record<string, string> | null;
    createdAt: number;
    role: string;
    groupId: string | null;
  }): OrderRec => ({
    id: ids.make('order_'),
    receipt: args.receipt,
    amount: args.amount,
    attempts: args.attempts,
    notes: args.notes,
    createdAt: args.createdAt,
    label: newLabel(args.role, args.groupId),
  });

  // 3. Build each order's records.
  for (const plan of plans) {
    const groupId = `OG-${pad(plan.index + 1, 6)}`;
    const orderedAt = epochFromIst(plan.day, plan.second);
    const dayEnd = epochFromIst(plan.day + 1, 0);

    if (plan.role === 'LEDGER_WITHOUT_PAYMENT') {
      const ledger: LedgerRec = {
        orderRef: plan.ref,
        day: plan.day,
        amount: plan.amount,
        customerRef: plan.customer.ref,
        memo: miscRng.pick(CASH_MEMOS),
        label: newLabel('cash_order'),
      };
      world.ledger.push(ledger);
      const anomaly = newAnomaly(ctx, 'LEDGER_WITHOUT_PAYMENT', {
        orderRef: plan.ref,
        amountPaise: plan.amount.toString(),
      });
      addMember(anomaly, 'ledger_entry', plan.ref, 'cash_order');
      continue;
    }

    // The contracted rate, and what was actually charged.
    const contractedBps = config.feeBps[plan.method];
    const [extraLo, extraHi] = config.overchargeExtraBps;
    const chargedBps =
      plan.role === 'FEE_OVERCHARGE' ? contractedBps + feeRng.int(extraLo, extraHi) : contractedBps;

    // The ledger amount: edited downward after the order when a discount was granted afterwards.
    let ledgerAmount = plan.amount;
    let memo = miscRng.pick(NORMAL_MEMOS);
    let discount: Paise | null = null;
    if (plan.role === 'LEDGER_AMOUNT_EDITED') {
      const rawBps = miscRng.pick([500, 750, 1000, 1500, 2000]);
      const wholeRupees = (percentOfHalfUp(plan.amount, rawBps) / 100n) * 100n;
      discount = paise(wholeRupees < 1000n ? 1000n : wholeRupees);
      ledgerAmount = sub(plan.amount, discount);
      memo = `Post-order discount of ${formatRupees(discount, { symbol: true })} applied (revised from ${formatRupees(plan.amount, { symbol: true })})`;
    }

    const ledger: LedgerRec = {
      orderRef: plan.ref,
      day: plan.day,
      amount: ledgerAmount,
      customerRef: plan.customer.ref,
      memo,
      label: newLabel('normal', groupId),
    };
    world.ledger.push(ledger);

    // Payment timing. TIMEZONE_DATE_SHIFT pushes the payment past IST midnight.
    let paidAt: number;
    if (plan.role === 'TIMEZONE_DATE_SHIFT') {
      plan.second = timeRng.int(84_600, SECONDS_PER_DAY - 1);
      paidAt = epochFromIst(plan.day + 1, payDelay(timeRng, plan.method));
    } else {
      paidAt = minInt(orderedAt + payDelay(timeRng, plan.method), dayEnd - 1);
    }
    const createdAt = epochFromIst(plan.day, plan.second);

    const failed = failedSet.has(plan.index);
    const order = makeOrder({
      receipt: plan.ref,
      amount: plan.amount,
      attempts: failed ? 2 : 1,
      notes: null,
      createdAt,
      role: 'normal',
      groupId,
    });
    world.orders.push(order);

    if (failed) {
      const failure = miscRng.pick(FAILURES);
      const failedAt = createdAt + timeRng.int(5, 20);
      paidAt = minInt(createdAt + payDelay(timeRng, plan.method) + timeRng.int(30, 90), dayEnd - 1);
      world.payments.push({
        ...makePayment({
          orderId: order.id,
          amount: plan.amount,
          method: plan.method,
          customer: plan.customer,
          createdAt: failedAt,
          contractedBps,
          chargedBps: contractedBps,
          role: 'failed_attempt',
          groupId: null,
        }),
        fee: null,
        tax: null,
        expectedFee: null,
        status: 'failed',
        description: null,
        error: failure,
      });
    }

    const payment = makePayment({
      orderId: order.id,
      amount: plan.amount,
      method: plan.method,
      customer: plan.customer,
      createdAt: paidAt,
      contractedBps,
      chargedBps,
      role: 'normal',
      groupId,
    });
    world.payments.push(payment);

    switch (plan.role) {
      case 'LEDGER_AMOUNT_EDITED': {
        const anomaly = newAnomaly(ctx, 'LEDGER_AMOUNT_EDITED', {
          orderRef: plan.ref,
          ledgerPaise: ledgerAmount.toString(),
          paymentPaise: plan.amount.toString(),
          discountPaise: (discount ?? paise(0n)).toString(),
        });
        addMember(anomaly, 'ledger_entry', plan.ref, 'edited_ledger');
        addMember(anomaly, 'rzp_payment', payment.id, 'counterpart_payment');
        break;
      }
      case 'TIMEZONE_DATE_SHIFT': {
        const anomaly = newAnomaly(ctx, 'TIMEZONE_DATE_SHIFT', {
          orderRef: plan.ref,
          ledgerDate: formatIsoDay(plan.day),
          paymentBusinessDate: formatIsoDay(plan.day + 1),
        });
        addMember(anomaly, 'ledger_entry', plan.ref, 'shifted_ledger');
        addMember(anomaly, 'rzp_payment', payment.id, 'shifted_payment');
        break;
      }
      case 'FEE_OVERCHARGE': {
        const anomaly = newAnomaly(ctx, 'FEE_OVERCHARGE', {
          paymentId: payment.id,
          method: plan.method,
          contractedBps: String(contractedBps),
          chargedBps: String(chargedBps),
          expectedFeePaise: (payment.expectedFee ?? paise(0n)).toString(),
          actualFeePaise: (payment.fee ?? paise(0n)).toString(),
        });
        addMember(anomaly, 'rzp_payment', payment.id, 'overcharged_payment');
        break;
      }
      case 'PARTIAL_REFUND_NETTED':
      case 'FULL_REFUND': {
        const full = plan.role === 'FULL_REFUND';
        const refundAmount = full
          ? plan.amount
          : percentOfHalfUp(plan.amount, miscRng.pick(PARTIAL_REFUND_BPS));
        const anomaly = newAnomaly(ctx, plan.role, {
          paymentId: payment.id,
          paymentPaise: plan.amount.toString(),
          refundPaise: refundAmount.toString(),
        });
        world.refundPlans.push({
          payment,
          amount: refundAmount,
          reason: full ? 'Order cancelled by customer' : 'Partial refund - item returned',
          anomaly,
        });
        break;
      }
      case 'CHARGEBACK_ADJUSTMENT': {
        const anomaly = newAnomaly(ctx, 'CHARGEBACK_ADJUSTMENT', {
          paymentId: payment.id,
          paymentPaise: plan.amount.toString(),
        });
        addMember(anomaly, 'rzp_payment', payment.id, 'disputed_payment');
        world.chargebackPlans.push({ payment, anomaly });
        break;
      }
      case 'DUPLICATE_PAYMENT': {
        // A checkout retry: a second Razorpay order for the same ledger row (receipts must be
        // unique, so it carries a suffix), and the customer paid both.
        const refunded = miscRng.chance(5000);
        const dupGroup = refunded ? groupId : null;
        const dupOrderedAt = createdAt + timeRng.int(300, 1800);
        const dupOrder = makeOrder({
          receipt: `${plan.ref}-R1`,
          amount: plan.amount,
          attempts: 1,
          notes: null,
          createdAt: dupOrderedAt,
          role: 'retry_order',
          groupId: dupGroup,
        });
        world.orders.push(dupOrder);
        const dupPayment = makePayment({
          orderId: dupOrder.id,
          amount: plan.amount,
          method: plan.method,
          customer: plan.customer,
          createdAt: dupOrderedAt + payDelay(timeRng, plan.method),
          contractedBps,
          chargedBps: contractedBps,
          role: 'duplicate',
          groupId: dupGroup,
        });
        world.payments.push(dupPayment);
        const anomaly = newAnomaly(ctx, 'DUPLICATE_PAYMENT', {
          orderRef: plan.ref,
          originalPaymentId: payment.id,
          duplicatePaymentId: dupPayment.id,
          refunded: refunded ? 'true' : 'false',
        });
        addMember(anomaly, 'rzp_order', dupOrder.id, 'retry_order');
        addMember(anomaly, 'rzp_payment', dupPayment.id, 'duplicate_payment');
        if (refunded) {
          world.refundPlans.push({
            payment: dupPayment,
            amount: plan.amount,
            reason: 'Duplicate payment refund',
            anomaly,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // 4. Payments made through a manual payment link: real money, no ledger row, no receipt.
  const linkRng = rng.fork('links');
  const linkCount = countFor(config.rates.PAYMENT_WITHOUT_LEDGER, config.orders);
  for (let i = 0; i < linkCount; i++) {
    const day = startDay + linkRng.int(0, orderDays - 1);
    const second = drawSecondOfDay(linkRng);
    const method = drawMethod(linkRng, config);
    const customer = at(customers, linkRng.int(0, customers.length - 1));
    const amount = drawAmount(linkRng);
    const createdAt = epochFromIst(day, second);
    const linkId = ids.make('plink_');
    const order = makeOrder({
      receipt: null,
      amount,
      attempts: 1,
      notes: { payment_link: linkId },
      createdAt,
      role: 'payment_link_order',
      groupId: null,
    });
    world.orders.push(order);
    const bps = config.feeBps[method];
    const payment = makePayment({
      orderId: order.id,
      amount,
      method,
      customer,
      createdAt: minInt(createdAt + payDelay(linkRng, method), epochFromIst(day + 1, 0) - 1),
      contractedBps: bps,
      chargedBps: bps,
      role: 'payment_link',
      groupId: null,
    });
    payment.notes = { payment_link: linkId };
    world.payments.push(payment);
    const anomaly = newAnomaly(ctx, 'PAYMENT_WITHOUT_LEDGER', {
      paymentId: payment.id,
      paymentLink: linkId,
    });
    addMember(anomaly, 'rzp_payment', payment.id, 'payment_link_payment');
    addMember(anomaly, 'rzp_order', order.id, 'payment_link_order');
  }

  return world;
}
