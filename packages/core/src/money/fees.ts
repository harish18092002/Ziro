import { assertInRange, MoneyError, type Paise } from './paise.js';

const BPS_DENOMINATOR = 10_000n;
const HALF = BPS_DENOMINATOR / 2n;

/** GST on Razorpay's fee: 18%. */
export const GST_RATE_BPS = 1800;

function toBasisPoints(basisPoints: bigint | number): bigint {
  if (typeof basisPoints === 'number' && !Number.isSafeInteger(basisPoints)) {
    throw new MoneyError('NOT_INTEGER', 'basis points must be a safe integer');
  }
  const bps = BigInt(basisPoints);
  if (bps < 0n) throw new MoneyError('INVALID_ARGUMENT', 'basis points must not be negative');
  return bps;
}

/**
 * `amount * basisPoints / 10_000`, rounded half-up to the paise: exact ties go up. Pure bigint
 * arithmetic, so there is no float error at any size. The amount must be non-negative: fees and
 * GST are never negative, and a refund is modelled by subtracting a positive amount.
 */
export function percentOfHalfUp(amount: Paise, basisPoints: bigint | number): Paise {
  if (amount < 0n) {
    throw new MoneyError('INVALID_ARGUMENT', 'percentOfHalfUp needs a non-negative amount');
  }
  // For non-negative operands bigint division truncates, i.e. floors, so adding half first rounds up.
  return assertInRange((amount * toBasisPoints(basisPoints) + HALF) / BPS_DENOMINATOR);
}

/**
 * GST charged on a base (pre-GST) fee, half-up to the paise. Note Razorpay's payment `fee` already
 * includes GST: pass `fee - tax`, not `fee`, when checking a payment's reported tax.
 */
export function gstOnFee(baseFee: Paise, rateBps: bigint | number = GST_RATE_BPS): Paise {
  return percentOfHalfUp(baseFee, rateBps);
}
