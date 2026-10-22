// The verifier's vocabulary. The verifier is the second line of defence after the agent's own
// grounding checks, and it trusts none of them: it re-derives everything from the records themselves.
// Pure and deterministic: a snapshot goes in, a verdict comes out, nothing is read or written.
import type {
  AGENT_VERDICTS,
  BankLine,
  LedgerEntry,
  ReasonCode,
  RecordRef,
  RzpPayment,
  RzpRefund,
  RzpSettlement,
  SettlementItem,
} from '../domain/index.js';
import type { MatcherConfig } from '../matcher/index.js';
import type { Paise } from '../money/index.js';

/** Why a proposal was refused. Stable codes: the review queue and the "caught by the verifier" metric group on them. */
export const VERIFY_REASONS = [
  /** The proposal is not a MATCH_PROPOSED: there is nothing to verify as a match. */
  'NOT_A_PROPOSED_MATCH',
  /** The links are not a recognisable order group (ledger + payments + refunds) or payout group (settlement + bank line). */
  'UNSUPPORTED_SHAPE',
  'DUPLICATE_LINK',
  /** An id that is in no table. */
  'UNKNOWN_RECORD',
  /** An id that exists but belongs to another run. */
  'CROSS_RUN_RECORD',
  /** The record is already in an accepted group; a record sits in at most one. */
  'ALREADY_MATCHED',
  'PAYMENT_NOT_CAPTURED',
  'REFUND_NOT_PROCESSED',
  'REFUND_PAYMENT_NOT_LINKED',
  /** A payment says more was refunded than the linked refunds add up to. */
  'REFUND_MISSING',
  /** The two sides differ by a non-zero number of paise. */
  'AMOUNT_MISMATCH',
  /** The settlement's own lines do not add up, or a line contradicts its record. */
  'SETTLEMENT_UNBALANCED',
  'BANK_LINE_NOT_A_CREDIT',
  'UTR_CONFLICT',
  'DATE_WINDOW',
  'CURRENCY_NOT_INR',
  /** The reason code does not fit the links (PARTIAL_REFUND_NETTED with no refund, DUPLICATE_PAYMENT with one payment...). */
  'REASON_INCONSISTENT',
  /** A reason code that describes a missing or unmatched record cannot accompany a match. */
  'REASON_NOT_A_MATCH',
] as const;
export type VerifyReason = (typeof VERIFY_REASONS)[number];

export interface VerifyFinding {
  readonly code: VerifyReason;
  /** Written by the verifier from the records; never quotes free text. */
  readonly message: string;
  /** The records the finding is about. */
  readonly records: readonly RecordRef[];
  /** For an amount finding: left side minus right side, in paise. */
  readonly residual?: Paise;
}

export interface VerifiedGroup {
  readonly kind: 'order' | 'payout';
  /** The links, in a canonical order. */
  readonly links: readonly RecordRef[];
  /**
   * The money the group moves: the sum of its payments (order) or the settlement amount (payout).
   * This is what the auto-accept limit is compared with.
   */
  readonly gross: Paise;
  /** Always zero for a verified group: there is no tolerance. */
  readonly residual: Paise;
}

export type VerifyOutcome =
  | {
      readonly status: 'VERIFIED';
      readonly group: VerifiedGroup;
      readonly notes: readonly string[];
    }
  | { readonly status: 'REJECTED'; readonly findings: readonly VerifyFinding[] };

/** What a proposal claims. The verifier needs nothing else of it. */
export interface ProposalClaim {
  readonly verdict: (typeof AGENT_VERDICTS)[number];
  readonly reasonCode: ReasonCode;
  readonly links: readonly RecordRef[];
}

/**
 * The records a proposal touches, as the service loaded them. Records are looked up by id WITHOUT a
 * run filter, so a link into another run is reported as exactly that (and not as "unknown").
 */
export interface VerifierSnapshot {
  readonly runId: string;
  readonly ledger: ReadonlyMap<string, LedgerEntry>;
  readonly payments: ReadonlyMap<string, RzpPayment>;
  readonly refunds: ReadonlyMap<string, RzpRefund>;
  readonly settlements: ReadonlyMap<string, RzpSettlement>;
  readonly bankLines: ReadonlyMap<string, BankLine>;
  /** Lines of each linked settlement, by the settlement's Razorpay id. */
  readonly settlementItems: ReadonlyMap<string, readonly SettlementItem[]>;
  /** Payments and refunds those lines name, by Razorpay id: the composition cross-checks each line against its record. */
  readonly paymentsByRzpId: ReadonlyMap<string, RzpPayment>;
  readonly refundsByRzpId: ReadonlyMap<string, RzpRefund>;
  /** `${recordType}:${id}` of every record already in an accepted group. */
  readonly accepted: ReadonlySet<string>;
}

/** The matcher's configuration, so one set of windows governs both the rules and the verifier. */
export interface VerifierConfig extends MatcherConfig {
  /** An order's ledger date and its payment's date may differ by at most this many calendar days. */
  readonly orderDateWindowDays: number;
}

export const DEFAULT_ORDER_DATE_WINDOW_DAYS = 3;

export const recordKey = (ref: RecordRef): string => `${ref.recordType}:${ref.recordId}`;
