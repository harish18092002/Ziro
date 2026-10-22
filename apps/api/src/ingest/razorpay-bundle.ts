import type { RzpPayment, RzpRefund, RzpSettlement, SettlementItem } from '@ziro/core/domain';
import { addDaysToBusinessDate } from '@ziro/core/time';
import type { Provenance, RazorpaySource, Sourced } from '../razorpay/source.js';

/** A payment made on the last day of the window settles T+2 or later, so settlements look further on. */
export const SETTLEMENT_LOOKAHEAD_DAYS = 7;
/** The longest window one request may ask for. */
export const MAX_WINDOW_DAYS = 93;
/** One recon call is made per day between the first and last settlement, so this bounds the calls. */
export const MAX_RECON_DAYS = 400;

export class ImportRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRangeError';
  }
}

export interface RazorpayWindow {
  readonly from: string;
  readonly to: string;
  /** Settlements and their recon items are fetched through this date. */
  readonly settlementsThrough: string;
}

export interface RazorpayBundle {
  readonly payments: readonly Sourced<RzpPayment>[];
  readonly refunds: readonly Sourced<RzpRefund>[];
  readonly settlements: readonly Sourced<RzpSettlement>[];
  readonly items: readonly Sourced<SettlementItem>[];
  readonly provenance: readonly Provenance[];
}

/** The window a request means: payments and refunds in [from, to], settlements a week further on. */
export function windowFor(from: string, to: string): RazorpayWindow {
  return { from, to, settlementsThrough: addDaysToBusinessDate(to, SETTLEMENT_LOOKAHEAD_DAYS) };
}

const uniqueBySourceRef = <T extends { sourceRef: string }>(
  list: readonly Sourced<T>[],
): Sourced<T>[] => {
  const seen = new Set<string>();
  return list.filter(({ record }) => !seen.has(record.sourceRef) && !!seen.add(record.sourceRef));
};

function daysBetween(first: string, last: string): string[] {
  const days: string[] = [];
  for (let day = first; day <= last; day = addDaysToBusinessDate(day, 1)) {
    days.push(day);
    if (days.length > MAX_RECON_DAYS) {
      throw new ImportRangeError(
        `the settlements span more than ${MAX_RECON_DAYS} days; use a shorter window`,
      );
    }
  }
  return days;
}

/**
 * Everything the source holds for the window. Network happens here, never inside a database
 * transaction. Recon items are fetched for each day from the first to the last settlement, because
 * Razorpay's recon report is per day. The recon provenance is one entry: if its days came from
 * different places it is labelled synthetic (the less real label) with a warning.
 */
export async function fetchBundle(
  source: RazorpaySource,
  window: RazorpayWindow,
): Promise<RazorpayBundle> {
  const payments = await source.fetchPayments({ from: window.from, to: window.to });
  const refunds = await source.fetchRefunds({ from: window.from, to: window.to });
  const settlements = await source.fetchSettlements({
    from: window.from,
    to: window.settlementsThrough,
  });

  const dates = settlements.items.map((s) => s.record.businessDate).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const days = first === undefined || last === undefined ? [] : daysBetween(first, last);

  const items: Sourced<SettlementItem>[] = [];
  const reconProvenance: Provenance[] = [];
  for (const day of days) {
    const recon = await source.fetchSettlementRecon(day);
    items.push(...recon.items);
    reconProvenance.push(recon.provenance);
  }

  const sources = new Set(reconProvenance.map((p) => p.source));
  const warnings = reconProvenance.flatMap((p) => p.warnings);
  if (sources.size > 1) {
    warnings.push('settlement recon came partly from test mode and partly from synthetic data');
  }
  const recon: Provenance = {
    entity: 'settlement_recon',
    source:
      sources.size === 1 && sources.has('razorpay_testmode') ? 'razorpay_testmode' : 'synthetic',
    reason: reconProvenance.find((p) => p.reason !== 'ok')?.reason ?? 'ok',
    requests: reconProvenance.reduce((total, p) => total + p.requests, 0),
    warnings: [...new Set(warnings)],
  };

  return {
    payments: uniqueBySourceRef(payments.items),
    refunds: uniqueBySourceRef(refunds.items),
    settlements: uniqueBySourceRef(settlements.items),
    items: uniqueBySourceRef(items),
    provenance: [payments.provenance, refunds.provenance, settlements.provenance, recon],
  };
}
