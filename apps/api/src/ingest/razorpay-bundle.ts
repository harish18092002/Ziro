import type { RzpPayment, RzpRefund, RzpSettlement, SettlementItem } from '@ziro/core/domain';
import { addDaysToBusinessDate } from '@ziro/core/time';
import { RazorpayApiError } from '../razorpay/errors.js';
import type {
  Entity,
  FetchResult,
  Provenance,
  RazorpaySource,
  Sourced,
} from '../razorpay/source.js';

/** A payment made on the last day of the window settles T+2 or later, so settlements look further on. */
export const SETTLEMENT_LOOKAHEAD_DAYS = 7;
/** The longest window one request may ask for. */
export const MAX_WINDOW_DAYS = 93;
/** One recon call is made per day between the first and last settlement, so this bounds the calls. */
export const MAX_RECON_DAYS = 400;
/**
 * Razorpay already got its retries per call. After this many recon days in a row that still failed it is
 * down, not unlucky: stop asking, because every further day would spend the same minute failing.
 */
export const RECON_FAILURE_STREAK = 3;

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

/**
 * Something the import could not get from Razorpay. A run with any gap is PARTIAL: what arrived is real
 * and was imported, what did not is listed here, and the exceptions it causes (a ledger entry with "no
 * payment", a settlement nobody explains) may be artefacts of the gap, not findings.
 *
 *   not_fetched   nothing of this entity arrived
 *   cut_short     a list stopped part-way; the records before the failure were kept
 *   days_missing  the settlement recon report for some days did not arrive (`days` names them)
 */
export interface Gap {
  readonly entity: Entity;
  readonly kind: 'not_fetched' | 'cut_short' | 'days_missing';
  /** One sentence for a person; the console, the report and the audit trail show these words. */
  readonly detail: string;
  /** The IST days of a `days_missing` gap, else empty. */
  readonly days: readonly string[];
}

export interface RazorpayBundle {
  readonly payments: readonly Sourced<RzpPayment>[];
  readonly refunds: readonly Sourced<RzpRefund>[];
  readonly settlements: readonly Sourced<RzpSettlement>[];
  readonly items: readonly Sourced<SettlementItem>[];
  readonly provenance: readonly Provenance[];
  /** What could not be fetched; empty for a complete import. */
  readonly gaps: readonly Gap[];
}

/** The window a request means: payments and refunds in [from, to], settlements a week further on. */
export function windowFor(from: string, to: string): RazorpayWindow {
  return { from, to, settlementsThrough: addDaysToBusinessDate(to, SETTLEMENT_LOOKAHEAD_DAYS) };
}

/** True when nothing at all arrived because Razorpay failed: there is nothing to import. */
export const nothingFetched = (bundle: RazorpayBundle): boolean =>
  bundle.gaps.length > 0 &&
  bundle.payments.length +
    bundle.refunds.length +
    bundle.settlements.length +
    bundle.items.length ===
    0;

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

type Fetched<T> = { readonly result: FetchResult<T> } | { readonly failure: string };

/**
 * One call to the source. Razorpay failing (the retries are already spent inside the source) is data
 * here, not an exception: the import carries on without it. Anything else that goes wrong (a response
 * we cannot read, a bad configuration, a bug) is not an outage and is thrown as it always was.
 */
async function attempt<T>(call: () => Promise<FetchResult<T>>): Promise<Fetched<T>> {
  try {
    return { result: await call() };
  } catch (error) {
    if (error instanceof RazorpayApiError) return { failure: error.summary };
    throw error;
  }
}

const ENTITY_WORDS: Record<Entity, string> = {
  payments: 'payments',
  refunds: 'refunds',
  settlements: 'settlements',
  settlement_recon: 'settlement recon',
};

/**
 * Everything the source holds for the window. Network happens here, never inside a database
 * transaction. Recon items are fetched for each day from the first to the last settlement, because
 * Razorpay's recon report is per day. The recon provenance is one entry: if its days came from
 * different places it is labelled synthetic (the less real label) with a warning.
 *
 * Each entity is fetched on its own. When Razorpay keeps failing for one of them, the others still
 * come back, and the bundle lists what is missing instead of failing whole.
 */
export async function fetchBundle(
  source: RazorpaySource,
  window: RazorpayWindow,
): Promise<RazorpayBundle> {
  const gaps: Gap[] = [];
  const provenance: Provenance[] = [];
  const notFetched = (entity: Entity, why: string): void => {
    gaps.push({
      entity,
      kind: 'not_fetched',
      detail: `${ENTITY_WORDS[entity]} were not fetched: ${why}`,
      days: [],
    });
  };
  const keep = (p: Provenance): void => {
    provenance.push(p);
    for (const cut of p.incomplete ?? []) {
      gaps.push({
        entity: p.entity,
        kind: 'cut_short',
        detail: `${cut.what} stopped after ${cut.fetched} records: ${cut.reason}`,
        days: [],
      });
    }
  };

  const payments = await attempt(() => source.fetchPayments({ from: window.from, to: window.to }));
  if ('failure' in payments) notFetched('payments', payments.failure);
  else keep(payments.result.provenance);

  // Refunds belong to payments: without them there is nothing for a refund to point at.
  let refunds: Fetched<RzpRefund> = { failure: '' };
  if ('failure' in payments) {
    notFetched('refunds', 'the payments they belong to are missing');
  } else {
    refunds = await attempt(() => source.fetchRefunds({ from: window.from, to: window.to }));
    if ('failure' in refunds) notFetched('refunds', refunds.failure);
    else keep(refunds.result.provenance);
  }

  const settlements = await attempt(() =>
    source.fetchSettlements({ from: window.from, to: window.settlementsThrough }),
  );
  const items: Sourced<SettlementItem>[] = [];
  if ('failure' in settlements) {
    notFetched('settlements', settlements.failure);
    notFetched(
      'settlement_recon',
      'the settlements are missing, so the days to ask for are unknown',
    );
  } else {
    keep(settlements.result.provenance);
    const dates = settlements.result.items.map((s) => s.record.businessDate).sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    const days = first === undefined || last === undefined ? [] : daysBetween(first, last);

    const reconProvenance: Provenance[] = [];
    const failedDays: string[] = [];
    const notAsked: string[] = [];
    let lastFailure = '';
    let streak = 0;
    for (const [i, day] of days.entries()) {
      if (streak >= RECON_FAILURE_STREAK) {
        notAsked.push(...days.slice(i));
        break;
      }
      const recon = await attempt(() => source.fetchSettlementRecon(day));
      if ('failure' in recon) {
        failedDays.push(day);
        lastFailure = recon.failure;
        streak += 1;
        continue;
      }
      streak = 0;
      items.push(...recon.result.items);
      reconProvenance.push(recon.result.provenance);
    }

    if (failedDays.length + notAsked.length > 0) {
      const missingDays = [...failedDays, ...notAsked];
      const stopped =
        notAsked.length === 0
          ? ''
          : `; stopped asking after ${RECON_FAILURE_STREAK} failures in a row, so ${notAsked.length} ${notAsked.length === 1 ? 'day was' : 'days were'} not requested`;
      gaps.push({
        entity: 'settlement_recon',
        kind: 'days_missing',
        detail: `settlement recon is missing for ${missingDays.length} of ${days.length} days (${missingDays.join(', ')}): ${lastFailure}${stopped}`,
        days: missingDays,
      });
    }

    const sources = new Set(reconProvenance.map((p) => p.source));
    const warnings = reconProvenance.flatMap((p) => p.warnings);
    if (sources.size > 1) {
      warnings.push('settlement recon came partly from test mode and partly from synthetic data');
    }
    const incomplete = reconProvenance.flatMap((p) => p.incomplete ?? []);
    keep({
      entity: 'settlement_recon',
      source:
        sources.size === 1 && sources.has('razorpay_testmode') ? 'razorpay_testmode' : 'synthetic',
      reason: reconProvenance.find((p) => p.reason !== 'ok')?.reason ?? 'ok',
      requests: reconProvenance.reduce((total, p) => total + p.requests, 0),
      warnings: [...new Set(warnings)],
      ...(incomplete.length === 0 ? {} : { incomplete }),
    });
  }

  return {
    payments: 'result' in payments ? uniqueBySourceRef(payments.result.items) : [],
    refunds: 'result' in refunds ? uniqueBySourceRef(refunds.result.items) : [],
    settlements: 'result' in settlements ? uniqueBySourceRef(settlements.result.items) : [],
    items: uniqueBySourceRef(items),
    provenance,
    gaps,
  };
}
