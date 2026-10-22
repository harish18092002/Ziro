// What Razorpay is supposed to charge: a fee in basis points per payment method, plus GST on that fee.
// A run carries a snapshot of it in its config, so "was this fee right?" is judged against the contract
// in force when the run was made. The defaults are datagen's synthetic world; a real merchant supplies
// its own pricing plan.
import { type Paise, gstOnFee, paise, percentOfHalfUp } from '@ziro/core/money';
import { z } from 'zod';

export const feeContractSchema = z.strictObject({
  /** GST on the fee, in basis points (1800 = 18%). */
  gstBps: z.number().int().min(0).max(10_000),
  /** Fee per payment method, in basis points of the payment amount. */
  methods: z.record(
    z.string().min(1).max(30),
    z.strictObject({ feeBps: z.number().int().min(0).max(10_000) }),
  ),
});
export type FeeContract = z.output<typeof feeContractSchema>;

export const DEFAULT_FEE_CONTRACT: FeeContract = {
  gstBps: 1800,
  methods: { card: { feeBps: 200 }, upi: { feeBps: 100 }, netbanking: { feeBps: 190 } },
};

export interface ExpectedFee {
  readonly baseFee: Paise;
  readonly gst: Paise;
  /** Razorpay's `fee`: base plus GST (ADR-004). */
  readonly totalFee: Paise;
}

/** The fee the contract implies for one payment, half-up to the paise at each step. */
export function expectedFee(
  contract: FeeContract,
  method: string,
  amount: Paise,
): ExpectedFee | null {
  const terms = contract.methods[method.toLowerCase()];
  if (terms === undefined) return null;
  const baseFee = percentOfHalfUp(amount, terms.feeBps);
  const gst = gstOnFee(baseFee, contract.gstBps);
  return { baseFee, gst, totalFee: paise(baseFee + gst) };
}

/** The contract stored on a run, or the default (flagged) when the run predates the snapshot. */
export function feeContractOf(runConfig: unknown): {
  contract: FeeContract;
  source: 'run' | 'default';
} {
  const stored = (runConfig as { feeContract?: unknown } | null)?.feeContract;
  const parsed = feeContractSchema.safeParse(stored);
  return parsed.success
    ? { contract: parsed.data, source: 'run' }
    : { contract: DEFAULT_FEE_CONTRACT, source: 'default' };
}
