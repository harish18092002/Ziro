// Plain-language meanings for the words a first-time visitor trips on. Shown by <Term> as a tooltip.
export const GLOSSARY = {
  fee: 'Razorpay’s charge for taking a payment: a share of the amount, set by your plan.',
  gstOnFee:
    'GST at 18% on Razorpay’s fee, not on your sale. Razorpay’s fee figure already includes it.',
  t2: 'T is the day of the payment. T+2 means the money reaches your bank two business days later.',
  utr: 'Unique Transaction Reference: the bank’s id for a transfer. It sits in the statement narration, sometimes cut short or garbled.',
  settlement:
    'Razorpay’s payout to your bank: many payments in one transfer, minus fees, GST and refunds.',
  exception:
    'A record the rules could not match safely: nothing fitted, or more than one thing could. It waits for the AI and you.',
} as const;

export type TermKey = keyof typeof GLOSSARY;
