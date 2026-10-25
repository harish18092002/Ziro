import type { RzpPayment, RzpRefund, RzpSettlement, SettlementItem } from '@ziro/core/domain';

/**
 * Where an entity's data actually came from. This is what the UI shows, so it must be honest. A run draws
 * on exactly one: the generated dataset (`synthetic`) or Razorpay's test-mode API (`razorpay_testmode`).
 * Test mode never borrows from the generated data: an empty answer is an empty answer (ADR-019).
 */
export type SourceLabel = 'synthetic' | 'razorpay_testmode';

/** An inclusive range of IST business dates, `YYYY-MM-DD`. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

/** A domain record together with the payload it was built from (stored as `raw`, hashed for re-imports). */
export interface Sourced<T> {
  readonly record: T;
  readonly raw: unknown;
}

export type Entity = 'payments' | 'refunds' | 'settlements' | 'settlement_recon';

/**
 * A list that stopped part-way: Razorpay failed on a later page after the retries were spent. What was
 * fetched is real and is kept; the tail is missing, and the run says so.
 */
export interface Incomplete {
  /** What was being listed ("payments", "orders", "settlement recon"). */
  readonly what: string;
  /** Records received before it stopped. */
  readonly fetched: number;
  /** Why it stopped, in words that carry no credentials (status, code, tries). */
  readonly reason: string;
}

export interface Provenance {
  readonly entity: Entity;
  readonly source: SourceLabel;
  /** HTTP calls made to Razorpay for this entity (0 for synthetic data). */
  readonly requests: number;
  /** Non-fatal oddities worth showing, e.g. an order that could not be found. */
  readonly warnings: readonly string[];
  /** Set when a list stopped part-way; absent for a complete answer. */
  readonly incomplete?: readonly Incomplete[];
}

export interface FetchResult<T> {
  /** Also on every record's own `source` field. */
  readonly source: SourceLabel;
  readonly items: readonly Sourced<T>[];
  readonly provenance: Provenance;
}

/**
 * The one door through which Razorpay data enters Ziro. Whatever is behind it, a caller gets the
 * same domain records. Dates are IST business dates; every list is complete (paginated to the end).
 */
export interface RazorpaySource {
  fetchPayments(range: DateRange): Promise<FetchResult<RzpPayment>>;
  fetchRefunds(range: DateRange): Promise<FetchResult<RzpRefund>>;
  fetchSettlements(range: DateRange): Promise<FetchResult<RzpSettlement>>;
  /** Everything Razorpay says it settled on one IST day. */
  fetchSettlementRecon(date: string): Promise<FetchResult<SettlementItem>>;
}
