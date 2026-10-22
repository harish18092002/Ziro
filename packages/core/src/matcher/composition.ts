// How a Razorpay settlement is put together, in ONE place. The rule matcher uses it for tier T2, the
// verifier will call the same functions, and the investigation agent's "expected settlement" tool does
// too, so "does this reconcile?" has exactly one answer.
//
//   settlement.amount  =  Σ payment amounts  −  Σ fees  −  Σ refunds  ±  adjustments
//
// `fees` is Razorpay's fee INCLUDING its GST (ADR-004), so tax is reported but is never subtracted a
// second time. All arithmetic is integer paise and must balance to the paise: there is no tolerance.
import type { RzpPayment, RzpRefund, RzpSettlement, SettlementItem } from '../domain/index.js';
import { type Paise, paise } from '../money/index.js';

/** The fields of a settlement line the arithmetic reads; a full `SettlementItem` satisfies it. */
export type CompositionLine = Pick<
  SettlementItem,
  | 'sourceRef'
  | 'itemType'
  | 'entityId'
  | 'paymentId'
  | 'amount'
  | 'fee'
  | 'tax'
  | 'debit'
  | 'credit'
>;

/**
 * The payment a settlement line concerns. Razorpay's recon report puts a payment line's own id in
 * `entity_id` and leaves `payment_id` null; `payment_id` is filled for refund lines, naming the
 * payment that was refunded. Reading only `payment_id` would leave every payment line unlinked.
 */
export function itemPaymentId(
  item: Pick<SettlementItem, 'paymentId' | 'itemType' | 'entityId'>,
): string | null {
  return item.paymentId ?? (item.itemType === 'payment' ? item.entityId : null);
}

export type CompositionIssueCode =
  | 'duplicate_line'
  | 'line_inconsistent'
  | 'line_disagrees_with_payment'
  | 'line_disagrees_with_refund'
  | 'payment_record_missing'
  | 'refund_record_missing';

export interface CompositionIssue {
  /** `blocking` stops the settlement being verified; a `note` is information only. */
  readonly severity: 'blocking' | 'note';
  readonly code: CompositionIssueCode;
  readonly entityId: string;
  readonly message: string;
}

/** What a set of settlement lines adds up to, whether or not they belong to a known settlement. */
export interface LinesComposition {
  /** Σ amounts of the payment lines. */
  readonly gross: Paise;
  /** Σ fees of the payment lines, GST included. */
  readonly fees: Paise;
  /** Σ GST on those fees. Already inside `fees`; shown, never subtracted again. */
  readonly tax: Paise;
  /** Σ amounts of the refund lines. */
  readonly refunds: Paise;
  readonly adjustmentsCredit: Paise;
  readonly adjustmentsDebit: Paise;
  /** gross − fees − refunds + adjustmentsCredit − adjustmentsDebit. */
  readonly computed: Paise;
  readonly paymentLines: number;
  readonly refundLines: number;
  readonly adjustmentLines: number;
  /** Razorpay ids of the payments among the lines. */
  readonly paymentIds: readonly string[];
  readonly issues: readonly CompositionIssue[];
}

export interface SettlementComposition extends LinesComposition {
  /** Razorpay's id (`setl_...`). */
  readonly settlementId: string;
  readonly settlementAmount: Paise;
  /** settlementAmount − computed. Zero for a settlement that reconciles. */
  readonly residual: Paise;
}

export interface CompositionLookups {
  payment(paymentId: string): Pick<RzpPayment, 'amount' | 'fee' | 'tax'> | undefined;
  refund(refundId: string): Pick<RzpRefund, 'amount'> | undefined;
}

const sortedByEntity = (lines: readonly CompositionLine[]): CompositionLine[] =>
  [...lines].sort((a, b) =>
    a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : a.sourceRef < b.sourceRef ? -1 : 1,
  );

/**
 * Adds up settlement lines and cross-checks each against the payment and refund records where those
 * exist. A line whose record is simply not in the data (a payment from before the period) is a note,
 * not a failure; a line that DISAGREES with its record is blocking. This is the one place the
 * arithmetic lives.
 */
export function composeLines(
  lines: readonly CompositionLine[],
  lookups: CompositionLookups,
): LinesComposition {
  let gross = 0n;
  let fees = 0n;
  let tax = 0n;
  let refunds = 0n;
  let adjustmentsCredit = 0n;
  let adjustmentsDebit = 0n;
  let paymentLines = 0;
  let refundLines = 0;
  let adjustmentLines = 0;
  const paymentIds: string[] = [];
  const issues: CompositionIssue[] = [];
  const seen = new Set<string>();

  const block = (code: CompositionIssueCode, entityId: string, message: string) =>
    issues.push({ severity: 'blocking', code, entityId, message });
  const note = (code: CompositionIssueCode, entityId: string, message: string) =>
    issues.push({ severity: 'note', code, entityId, message });

  for (const item of sortedByEntity(lines)) {
    const lineKey = `${item.itemType}:${item.entityId}`;
    if (seen.has(lineKey)) {
      block('duplicate_line', item.entityId, `${lineKey} appears more than once in the settlement`);
      continue;
    }
    seen.add(lineKey);

    if (item.itemType === 'payment') {
      paymentLines += 1;
      gross += item.amount;
      fees += item.fee;
      tax += item.tax;
      if (item.credit !== item.amount - item.fee || item.debit !== 0n || item.tax > item.fee) {
        block(
          'line_inconsistent',
          item.entityId,
          'a payment line must credit amount − fee and debit nothing',
        );
      }
      const paymentId = itemPaymentId(item);
      if (paymentId !== null) paymentIds.push(paymentId);
      const record = paymentId === null ? undefined : lookups.payment(paymentId);
      if (record === undefined) {
        note(
          'payment_record_missing',
          item.entityId,
          'no payment record for this line in the data',
        );
      } else if (
        record.amount !== item.amount ||
        record.fee !== item.fee ||
        record.tax !== item.tax
      ) {
        block(
          'line_disagrees_with_payment',
          item.entityId,
          'amount, fee or tax differs from the payment record',
        );
      }
    } else if (item.itemType === 'refund') {
      refundLines += 1;
      refunds += item.amount;
      if (item.debit !== item.amount || item.credit !== 0n) {
        block(
          'line_inconsistent',
          item.entityId,
          'a refund line must debit its amount and credit nothing',
        );
      }
      const record = lookups.refund(item.entityId);
      if (record === undefined) {
        note('refund_record_missing', item.entityId, 'no refund record for this line in the data');
      } else if (record.amount !== item.amount) {
        block('line_disagrees_with_refund', item.entityId, 'amount differs from the refund record');
      }
    } else {
      adjustmentLines += 1;
      adjustmentsCredit += item.credit;
      adjustmentsDebit += item.debit;
    }
  }

  return {
    gross: paise(gross),
    fees: paise(fees),
    tax: paise(tax),
    refunds: paise(refunds),
    adjustmentsCredit: paise(adjustmentsCredit),
    adjustmentsDebit: paise(adjustmentsDebit),
    computed: paise(gross - fees - refunds + adjustmentsCredit - adjustmentsDebit),
    paymentLines,
    refundLines,
    adjustmentLines,
    paymentIds,
    issues,
  };
}

/** One settlement's breakdown: its lines, added up, against the amount Razorpay says it paid out. */
export function composeSettlement(
  settlement: Pick<RzpSettlement, 'settlementId' | 'amount'>,
  items: readonly CompositionLine[],
  lookups: CompositionLookups,
): SettlementComposition {
  const lines = composeLines(items, lookups);
  return {
    ...lines,
    settlementId: settlement.settlementId,
    settlementAmount: settlement.amount,
    residual: paise(settlement.amount - lines.computed),
  };
}

/** True when the settlement reconciles exactly and no line contradicts its record. */
export function isVerified(composition: SettlementComposition): boolean {
  return composition.residual === 0n && !composition.issues.some((i) => i.severity === 'blocking');
}
