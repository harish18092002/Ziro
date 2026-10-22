import type {
  BankLine,
  LedgerEntry,
  ReasonCode,
  RecordRef,
  RecordType,
  RzpPayment,
  RzpRefund,
  RzpSettlement,
  SettlementItem,
} from '../domain/index.js';
import type { Paise } from '../money/index.js';
import type { BusinessCalendar } from '../time/index.js';
import type { SettlementComposition } from './composition.js';

/** Every match records the rule that made it; the id is versioned so a changed rule is a new id. */
export const RULE_IDS = {
  T1: 'T1.receipt-amount.v1',
  T2: 'T2.settlement-composition.v1',
  T3: 'T3.utr-amount.v1',
  T4: 'T4.amount-window-unique.v1',
} as const;
export type RuleId = (typeof RULE_IDS)[keyof typeof RULE_IDS];

export interface MatcherInput {
  readonly ledger: readonly LedgerEntry[];
  readonly payments: readonly RzpPayment[];
  readonly refunds: readonly RzpRefund[];
  readonly settlements: readonly RzpSettlement[];
  readonly settlementItems: readonly SettlementItem[];
  readonly bankLines: readonly BankLine[];
}

export interface MatcherConfig {
  /** Which days settlement and banking skip. */
  readonly calendar: BusinessCalendar;
  /** T4: a bank credit must land within this many business days after the settlement date. */
  readonly windowBusinessDays: number;
  /** Razorpay settles a payment this many business days after capture; later is SETTLEMENT_DELAYED. */
  readonly settlementLagBusinessDays: number;
  /** How far past the T4 window to look for the late credit of an otherwise-unmatched settlement. */
  readonly delayHorizonBusinessDays: number;
  /**
   * A merchant's convention for retried checkouts: capture group 1 is the original order reference
   * (`ORD-7-R1` retries `ORD-7`). Null turns the DUPLICATE_PAYMENT rule off.
   */
  readonly retryReceiptPattern: RegExp | null;
  /** A payment this many minutes into the new IST day, for an order dated the day before, is a date shift. */
  readonly dateShiftWindowMinutes: number;
}

export const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
  calendar: { weekendDays: [0, 6], holidays: new Set<string>() },
  windowBusinessDays: 3,
  settlementLagBusinessDays: 2,
  delayHorizonBusinessDays: 10,
  retryReceiptPattern: /^(.+)-R\d+$/,
  dateShiftWindowMinutes: 60,
};

export const matcherConfig = (over: Partial<MatcherConfig> = {}): MatcherConfig => ({
  ...DEFAULT_MATCHER_CONFIG,
  ...over,
});

export const ref = (recordType: RecordType, recordId: string): RecordRef => ({
  recordType,
  recordId,
});

export interface OrderEvidence {
  readonly ledgerAmount: Paise;
  readonly paymentAmount: Paise;
  readonly refundsTotal: Paise;
}

export interface PayoutEvidence {
  readonly settlementAmount: Paise;
  readonly bankAmount: Paise;
  readonly composition: SettlementComposition;
}

/** A match the rules are certain of. Tier T2 produces verdicts, not groups (ADR-005, ADR-010). */
export interface RuleGroup {
  readonly kind: 'order' | 'payout';
  readonly tier: 'T1' | 'T3' | 'T4';
  readonly ruleId: RuleId;
  /** What explains a known, accounted-for difference, if the data shows one. */
  readonly reasonCode: ReasonCode | null;
  /** Zero, always: a group that did not reconcile to the paise would not exist. */
  readonly residual: Paise;
  readonly members: readonly RecordRef[];
  readonly evidence: OrderEvidence | PayoutEvidence;
}

export interface SettlementVerdict {
  readonly settlement: RecordRef;
  readonly ruleId: typeof RULE_IDS.T2;
  readonly verified: boolean;
  readonly composition: SettlementComposition;
}

export const EXCEPTION_CAUSES = [
  'ledger_has_no_reference',
  'ledger_has_no_payment',
  'ledger_payment_not_captured',
  'receipt_amount_differs',
  'receipt_ambiguous',
  'payment_has_no_ledger',
  'payment_is_retry_duplicate',
  'payment_retry_of_other_amount',
  'payment_retry_of_unresolved_order',
  'refund_without_payment',
  'refund_exceeds_payment',
  'composition_unbalanced',
  'composition_inconsistent',
  'utr_amount_differs',
  'utr_ambiguous',
  'window_ambiguous',
  'bank_credit_outside_window',
  'no_bank_credit',
  'bank_credit_unexplained',
] as const;
export type ExceptionCause = (typeof EXCEPTION_CAUSES)[number];

/** The most candidate refs an exception carries, matching the domain schema. */
export const MAX_CANDIDATES = 50;

export interface RuleException {
  readonly reasonCode: ReasonCode;
  readonly subject: RecordRef;
  /** Records the rules found that might be the answer; context for the agent. At most 50. */
  readonly candidates: readonly RecordRef[];
  /** How many candidates there were before the cap. */
  readonly candidateCount: number;
  /**
   * Signed paise: the subject's amount minus the amount it was compared with, or its whole amount
   * when nothing was comparable.
   */
  readonly amountAtStake: Paise;
  readonly cause: ExceptionCause;
  /** One plain sentence saying what the rules saw. */
  readonly note: string;
}

export const IGNORED_REASONS = [
  'payment_not_captured',
  'refund_failed',
  'refund_follows_payment_exception',
  'bank_debit',
  'credit_not_a_settlement_channel',
] as const;
export type IgnoredReason = (typeof IGNORED_REASONS)[number];

/** A record that is deliberately not matched and not an exception. */
export interface IgnoredRecord {
  readonly subject: RecordRef;
  readonly why: IgnoredReason;
}

export interface MatcherStats {
  readonly groups: Readonly<Record<'T1' | 'T3' | 'T4', number>>;
  readonly settlementsVerified: number;
  readonly settlementsUnverified: number;
  readonly exceptions: number;
  readonly ignored: number;
  /** Per record type: how many records the input had and how many ended up in a group. */
  readonly matched: Readonly<
    Record<RecordType, { readonly total: number; readonly matched: number }>
  >;
}

export interface MatcherOutput {
  readonly groups: readonly RuleGroup[];
  readonly verdicts: readonly SettlementVerdict[];
  readonly exceptions: readonly RuleException[];
  readonly ignored: readonly IgnoredRecord[];
  readonly stats: MatcherStats;
}
