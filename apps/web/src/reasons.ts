// What each reason code means, in a merchant's words: shown beside an exception and in the architecture. The codes
// are the closed list in CLAUDE.md §8 (@ziro/core's REASON_CODES); reasons.test.ts keeps the two the same.
export const REASONS: Record<string, string> = {
  FEE_GST_DEDUCTION:
    'Razorpay kept its fee and the GST on it, so less reached the bank than was sold.',
  BATCHED_SETTLEMENT: 'Several payments were paid out together as one settlement.',
  PARTIAL_REFUND_NETTED: 'Part of the payment was refunded and netted out of a settlement.',
  FULL_REFUND: 'The whole payment was refunded.',
  CHARGEBACK_ADJUSTMENT: 'A chargeback was deducted from a settlement as an adjustment.',
  DUPLICATE_PAYMENT: 'The customer paid twice for one order (a checkout retry).',
  LEDGER_WITHOUT_PAYMENT: 'The ledger has an order Razorpay never captured a payment for.',
  PAYMENT_WITHOUT_LEDGER: 'Razorpay captured a payment the ledger has no order for.',
  UTR_MISSING_OR_GARBLED:
    'The bank line’s UTR is missing or broken, so it cannot be tied to a settlement by reference.',
  LEDGER_AMOUNT_EDITED:
    'The ledger amount differs from what the customer paid, as if it was edited.',
  TIMEZONE_DATE_SHIFT: 'The dates differ by a day because of IST and UTC.',
  SETTLEMENT_DELAYED: 'The payout reached the bank later than the usual T+2.',
  FEE_OVERCHARGE: 'Razorpay charged more fee than the contract allows.',
  UNKNOWN: 'Nothing the rules know explains it yet.',
};

/**
 * The label a person reads for each code. UNKNOWN is a real code the rules give when no known pattern fits; it is
 * shown as what it means ("Unclassified discrepancy"), and the raw code stays in the technical details.
 */
export const REASON_LABELS: Record<string, string> = {
  FEE_GST_DEDUCTION: 'Fee and GST deducted',
  BATCHED_SETTLEMENT: 'Batched settlement',
  PARTIAL_REFUND_NETTED: 'Partial refund netted',
  FULL_REFUND: 'Full refund',
  CHARGEBACK_ADJUSTMENT: 'Chargeback adjustment',
  DUPLICATE_PAYMENT: 'Duplicate payment',
  LEDGER_WITHOUT_PAYMENT: 'Order with no payment',
  PAYMENT_WITHOUT_LEDGER: 'Payment with no order',
  UTR_MISSING_OR_GARBLED: 'UTR missing or garbled',
  LEDGER_AMOUNT_EDITED: 'Order amount edited',
  TIMEZONE_DATE_SHIFT: 'IST/UTC date shift',
  SETTLEMENT_DELAYED: 'Settlement delayed',
  FEE_OVERCHARGE: 'Fee overcharged',
  UNKNOWN: 'Unclassified discrepancy',
};

export const reasonLabel = (code: string): string => REASON_LABELS[code] ?? code;

/** What a record is, in a word, for a title: "Bank line row-15", "Order ORD-100023". */
const RECORD_NOUN: Record<string, string> = {
  ledger_entry: 'Order',
  rzp_payment: 'Payment',
  rzp_refund: 'Refund',
  rzp_settlement: 'Settlement',
  bank_line: 'Bank line',
};
export const recordNoun = (type: string): string => RECORD_NOUN[type] ?? 'Record';

export const reasonMeaning = (code: string): string => REASONS[code] ?? 'No description yet.';
