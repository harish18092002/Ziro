// Fee leakage: what Razorpay charged above what the merchant's contract says it should. Deterministic,
// no model. For each captured INR payment the contract gives an expected fee (a rate per method, then GST on
// that fee, half-up to the paise at each step); a payment whose BASE fee (fee minus GST) is above the
// expected base is overcharged, and the leakage is everything it was charged above the expected total.
//
// Undercharges are reported on their own and never netted against overcharges: a merchant is not
// "made whole" on one payment by a Razorpay error in its favour on another.
import { paise } from '@ziro/core/money';
import { expectedFee, type FeeContract } from '../common/fee-contract.js';

export interface FeePayment {
  readonly rzpId: string;
  readonly method: string;
  readonly currency: string;
  readonly amount: bigint;
  /** Razorpay's fee INCLUDING GST (ADR-004). */
  readonly fee: bigint;
  /** The GST part of `fee`. */
  readonly tax: bigint;
}

export interface Overcharge {
  readonly rzpId: string;
  readonly method: string;
  readonly amountPaise: bigint;
  readonly expectedFeePaise: bigint;
  readonly actualFeePaise: bigint;
  /** actual − expected, GST included. */
  readonly excessPaise: bigint;
  readonly excessBasePaise: bigint;
  readonly excessGstPaise: bigint;
}

export interface FeeAudit {
  /** Payments the contract could judge. */
  readonly assessed: number;
  /** Payments it could not: a method the contract does not list, or a currency other than INR. */
  readonly notAssessable: number;
  readonly overcharged: {
    readonly count: number;
    readonly excessPaise: bigint;
    readonly basePaise: bigint;
    readonly gstPaise: bigint;
  };
  readonly undercharged: { readonly count: number; readonly shortfallPaise: bigint };
  /** Base fee as contracted but GST different: not a rate overcharge, but worth a look. */
  readonly gstOnlyDifferences: number;
  readonly byMethod: readonly {
    readonly method: string;
    readonly assessed: number;
    readonly overchargedCount: number;
    readonly excessPaise: bigint;
  }[];
  /** The largest overcharges first (at most WORST_KEPT). */
  readonly worst: readonly Overcharge[];
}

export const WORST_KEPT = 10;

export function auditFees(payments: readonly FeePayment[], contract: FeeContract): FeeAudit {
  let assessed = 0;
  let notAssessable = 0;
  let overCount = 0;
  let overExcess = 0n;
  let overBase = 0n;
  let overGst = 0n;
  let underCount = 0;
  let underShortfall = 0n;
  let gstOnly = 0;
  const methods = new Map<string, { assessed: number; over: number; excess: bigint }>();
  const over: Overcharge[] = [];

  for (const p of payments) {
    const expected = p.currency === 'INR' ? expectedFee(contract, p.method, paise(p.amount)) : null;
    if (expected === null) {
      notAssessable += 1;
      continue;
    }
    assessed += 1;
    const method = p.method.toLowerCase();
    const bucket = methods.get(method) ?? { assessed: 0, over: 0, excess: 0n };
    bucket.assessed += 1;
    methods.set(method, bucket);

    const base = p.fee - p.tax;
    if (base > expected.baseFee) {
      const excess = p.fee - expected.totalFee;
      overCount += 1;
      overExcess += excess;
      overBase += base - expected.baseFee;
      overGst += p.tax - expected.gst;
      bucket.over += 1;
      bucket.excess += excess;
      over.push({
        rzpId: p.rzpId,
        method,
        amountPaise: p.amount,
        expectedFeePaise: expected.totalFee,
        actualFeePaise: p.fee,
        excessPaise: excess,
        excessBasePaise: base - expected.baseFee,
        excessGstPaise: p.tax - expected.gst,
      });
    } else if (base < expected.baseFee) {
      underCount += 1;
      underShortfall += expected.totalFee - p.fee;
    } else if (p.tax !== expected.gst) {
      gstOnly += 1;
    }
  }

  over.sort((a, b) =>
    a.excessPaise === b.excessPaise
      ? a.rzpId.localeCompare(b.rzpId)
      : a.excessPaise > b.excessPaise
        ? -1
        : 1,
  );
  return {
    assessed,
    notAssessable,
    overcharged: {
      count: overCount,
      excessPaise: overExcess,
      basePaise: overBase,
      gstPaise: overGst,
    },
    undercharged: { count: underCount, shortfallPaise: underShortfall },
    gstOnlyDifferences: gstOnly,
    byMethod: [...methods.entries()]
      .map(([method, b]) => ({
        method,
        assessed: b.assessed,
        overchargedCount: b.over,
        excessPaise: b.excess,
      }))
      .sort((a, b) => a.method.localeCompare(b.method)),
    worst: over.slice(0, WORST_KEPT),
  };
}
