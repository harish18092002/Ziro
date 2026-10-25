import { formatRupees, paise } from '@ziro/core/money';

/** Razorpay will not refund less than Re 1 ("The amount must be at least INR 1.00"). */
export const MIN_REFUND_PAISE = 100n;

export interface PaymentForRefund {
  readonly status: string;
  readonly captured: boolean;
  readonly amount: bigint;
  readonly amountRefunded: bigint;
}

export interface RefundState {
  /** What could still be refunded, in paise (0 when nothing). */
  readonly refundable: bigint;
  readonly allowed: boolean;
  /** One short sentence for a person when `allowed` is false, else null. */
  readonly why: string | null;
}

/**
 * Whether a payment can be refunded now, and for how much. Razorpay refunds only CAPTURED payments, never
 * more than what is left, and nothing under Re 1. Checking before the request turns a vague refusal into a
 * reason a person can act on. Pure: the same rule decides what the console offers and what the server allows.
 */
export function refundState(p: PaymentForRefund): RefundState {
  const left = p.amount - p.amountRefunded;
  const refundable = left > 0n ? left : 0n;
  const no = (why: string): RefundState => ({ refundable, allowed: false, why });

  if (p.status === 'refunded' || (p.amountRefunded > 0n && refundable === 0n)) {
    return no('Already fully refunded.');
  }
  if (p.status === 'failed') return no('The payment failed, so there is nothing to refund.');
  if (p.status === 'created') return no('Not paid yet.');
  if (!p.captured || p.status !== 'captured') {
    return no('Not captured yet: Razorpay refunds only captured payments.');
  }
  if (refundable === 0n) return no('Nothing left to refund.');
  if (refundable < MIN_REFUND_PAISE) {
    return no(
      `Only ${formatRupees(paise(refundable), { symbol: true })} is left; Razorpay's smallest refund is ₹1.00.`,
    );
  }
  return { refundable, allowed: true, why: null };
}
