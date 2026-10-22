import type { RzpPayment, RzpRefund, RzpSettlement, SettlementItem } from '@ziro/core/domain';
import {
  orderIngestSchema,
  paymentIngestSchema,
  reconItemIngestSchema,
  refundIngestSchema,
  settlementIngestSchema,
} from '@ziro/core/razorpay';
import { addDaysToBusinessDate } from '@ziro/core/time';
import {
  dedupeBy,
  dedupeById,
  epochRange,
  inRange,
  parseCollection,
  parseEntries,
} from './entries.js';
import { RazorpayApiError, RazorpayResponseError } from './errors.js';
import {
  mapPayment,
  mapReconItem,
  mapRefund,
  mapSettlement,
  receiptsByOrderId,
  sortChronologically,
} from './mappers.js';
import type { RazorpayClient } from './sdk-client.js';
import type {
  DateRange,
  Entity,
  FetchResult,
  ProvenanceReason,
  RazorpaySource,
  SourceLabel,
} from './source.js';

export interface TestModeSourceOptions {
  readonly runId: string;
  readonly client: RazorpayClient;
  /** Answers for entities test mode has no data for. Always labelled `synthetic`. */
  readonly fallback: RazorpaySource;
  /** Documented maximum for list calls is 100. */
  readonly pageSize?: number;
  /** Documented maximum for the recon report is 1000. */
  readonly reconPageSize?: number;
  /** A hard stop on pagination, so a server that ignores `skip` cannot loop forever. */
  readonly maxPages?: number;
  /** An order is usually created before its payment: how far back to look for receipts. */
  readonly orderLookbackDays?: number;
  /** Orders older than the lookback are fetched one by one, up to this many. */
  readonly maxOrderLookups?: number;
}

interface Tally {
  requests: number;
  readonly warnings: string[];
}

const SOURCE: SourceLabel = 'razorpay_testmode';

/**
 * Razorpay data from the real API with TEST keys. Payments and refunds are real test-mode records
 * (only those you created with the test keys). Test mode appears to have no settlements, so those,
 * and the recon report, fall back to synthetic data: per entity, and labelled.
 *
 * Fallback happens only when test mode answers with NO DATA. An error never falls back: bad
 * credentials, a rate limit that outlasts the retries, or a bug of ours must surface, not hide
 * behind plausible synthetic numbers.
 */
export class TestModeSource implements RazorpaySource {
  private readonly pageSize: number;
  private readonly reconPageSize: number;
  private readonly maxPages: number;
  private readonly orderLookbackDays: number;
  private readonly maxOrderLookups: number;
  private readonly payments = new Map<string, Promise<FetchResult<RzpPayment>>>();
  private readonly months = new Map<string, Promise<{ has: boolean; requests: number }>>();

  constructor(private readonly options: TestModeSourceOptions) {
    this.pageSize = options.pageSize ?? 100;
    this.reconPageSize = options.reconPageSize ?? 1000;
    this.maxPages = options.maxPages ?? 1000;
    this.orderLookbackDays = options.orderLookbackDays ?? 7;
    this.maxOrderLookups = options.maxOrderLookups ?? 200;
  }

  private get ctx() {
    return { runId: this.options.runId, source: SOURCE } as const;
  }

  /** Walks count/skip to the end of a list. */
  private async listAll(
    tally: Tally,
    label: string,
    pageSize: number,
    fetchPage: (skip: number) => Promise<unknown>,
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 0; ; page++) {
      if (page >= this.maxPages) {
        throw new RazorpayResponseError(
          `${label}: still paging after ${this.maxPages} pages; refusing to continue`,
        );
      }
      tally.requests += 1;
      const items = parseCollection(await fetchPage(all.length), label);
      all.push(...items);
      if (items.length < pageSize) return all;
    }
  }

  private result<T>(entity: Entity, items: FetchResult<T>['items'], tally: Tally): FetchResult<T> {
    return {
      source: SOURCE,
      items,
      provenance: {
        entity,
        source: SOURCE,
        reason: 'ok',
        requests: tally.requests,
        warnings: tally.warnings,
      },
    };
  }

  /** The fallback's answer, with the reason it was needed and the requests wasted finding out. */
  private fellBack<T>(
    result: FetchResult<T>,
    reason: ProvenanceReason,
    tally: Tally,
  ): FetchResult<T> {
    return {
      ...result,
      provenance: {
        ...result.provenance,
        reason,
        requests: tally.requests,
        warnings: tally.warnings,
      },
    };
  }

  fetchPayments(range: DateRange): Promise<FetchResult<RzpPayment>> {
    const key = `${range.from}|${range.to}`;
    let pending = this.payments.get(key);
    if (!pending) {
      pending = this.loadPayments(range);
      this.payments.set(key, pending);
    }
    return pending;
  }

  private async loadPayments(range: DateRange): Promise<FetchResult<RzpPayment>> {
    const bounds = epochRange(range);
    const tally: Tally = { requests: 0, warnings: [] };
    const raws = await this.listAll(tally, 'payments', this.pageSize, (skip) =>
      this.options.client.listPayments({
        from: bounds.fromEpoch,
        to: bounds.toEpoch,
        count: this.pageSize,
        skip,
      }),
    );
    const payments = dedupeById(parseEntries(raws, paymentIngestSchema, 'payments')).filter(
      ({ parsed }) => inRange(parsed.created_at, bounds),
    );
    if (payments.length === 0) {
      return this.fellBack(
        await this.options.fallback.fetchPayments(range),
        'test-mode-empty',
        tally,
      );
    }

    const receipts = await this.receiptsFor(
      tally,
      range,
      payments.map(({ parsed }) => parsed.order_id),
    );
    const mapped = payments.map((entry) => mapPayment(entry, receipts, this.ctx));
    return this.result(
      'payments',
      sortChronologically(mapped, (r) => r.createdAt),
      tally,
    );
  }

  /** The receipt lives on the Order, not the Payment: resolve each payment's order. */
  private async receiptsFor(
    tally: Tally,
    range: DateRange,
    orderIds: readonly (string | null | undefined)[],
  ): Promise<Map<string, string | null>> {
    const wanted = [...new Set(orderIds.filter((id): id is string => typeof id === 'string'))];
    if (wanted.length === 0) return new Map();

    const lookback = epochRange({
      from: addDaysToBusinessDate(range.from, -this.orderLookbackDays),
      to: range.to,
    });
    const raws = await this.listAll(tally, 'orders', this.pageSize, (skip) =>
      this.options.client.listOrders({
        from: lookback.fromEpoch,
        to: lookback.toEpoch,
        count: this.pageSize,
        skip,
      }),
    );
    const receipts = receiptsByOrderId(dedupeById(parseEntries(raws, orderIngestSchema, 'orders')));

    const missing = wanted.filter((id) => !receipts.has(id));
    if (missing.length > this.maxOrderLookups) {
      throw new RazorpayResponseError(
        `${missing.length} payments belong to orders older than ${this.orderLookbackDays} days; ` +
          'widen orderLookbackDays instead of making that many single lookups',
      );
    }
    for (const id of missing) {
      try {
        tally.requests += 1;
        const [order] = parseEntries(
          [await this.options.client.fetchOrder(id)],
          orderIngestSchema,
          'order',
        );
        receipts.set(
          id,
          order?.parsed.receipt === undefined || order.parsed.receipt === ''
            ? null
            : order.parsed.receipt,
        );
      } catch (error) {
        if (!(error instanceof RazorpayApiError) || error.statusCode !== 404) throw error;
        tally.warnings.push(`order ${id} was not found, so its payment has no receipt`);
        receipts.set(id, null);
      }
    }
    return receipts;
  }

  async fetchRefunds(range: DateRange): Promise<FetchResult<RzpRefund>> {
    // Refunds belong to payments. If the payments are synthetic, real refunds would point at
    // payments that are not in the run, and synthetic ones are the only coherent answer.
    const payments = await this.fetchPayments(range);
    if (payments.source === 'synthetic') {
      return this.fellBack(await this.options.fallback.fetchRefunds(range), 'follows-payments', {
        requests: 0,
        warnings: [],
      });
    }

    const bounds = epochRange(range);
    const tally: Tally = { requests: 0, warnings: [] };
    const raws = await this.listAll(tally, 'refunds', this.pageSize, (skip) =>
      this.options.client.listRefunds({
        from: bounds.fromEpoch,
        to: bounds.toEpoch,
        count: this.pageSize,
        skip,
      }),
    );
    const refunds = dedupeById(parseEntries(raws, refundIngestSchema, 'refunds')).filter(
      ({ parsed }) => inRange(parsed.created_at, bounds),
    );
    const mapped = refunds.map((entry) => mapRefund(entry, this.ctx));
    // Real payments with no refunds is a true answer, not missing data: no fallback here.
    return this.result(
      'refunds',
      sortChronologically(mapped, (r) => r.createdAt),
      tally,
    );
  }

  async fetchSettlements(range: DateRange): Promise<FetchResult<RzpSettlement>> {
    const bounds = epochRange(range);
    const tally: Tally = { requests: 0, warnings: [] };
    const raws = await this.listAll(tally, 'settlements', this.pageSize, (skip) =>
      this.options.client.listSettlements({
        from: bounds.fromEpoch,
        to: bounds.toEpoch,
        count: this.pageSize,
        skip,
      }),
    );
    const settlements = dedupeById(
      parseEntries(raws, settlementIngestSchema, 'settlements'),
    ).filter(({ parsed }) => inRange(parsed.created_at, bounds));
    if (settlements.length === 0) {
      return this.fellBack(
        await this.options.fallback.fetchSettlements(range),
        'test-mode-empty',
        tally,
      );
    }
    const mapped = settlements.map((entry) => mapSettlement(entry, this.ctx));
    return this.result(
      'settlements',
      sortChronologically(mapped, (r) => r.createdAt),
      tally,
    );
  }

  /** Does test mode have any settlement at all in this date's calendar month? One call, remembered. */
  private monthHasSettlements(date: string): Promise<{ has: boolean; requests: number }> {
    const month = date.slice(0, 7);
    let pending = this.months.get(month);
    if (!pending) {
      pending = (async () => {
        const first = `${month}-01`;
        const nextFirst = `${addDaysToBusinessDate(first, 31).slice(0, 7)}-01`;
        const bounds = epochRange({ from: first, to: addDaysToBusinessDate(nextFirst, -1) });
        const body = await this.options.client.listSettlements({
          from: bounds.fromEpoch,
          to: bounds.toEpoch,
          count: 1,
          skip: 0,
        });
        return { has: parseCollection(body, 'settlements').length > 0, requests: 1 };
      })();
      this.months.set(month, pending);
    }
    return pending;
  }

  async fetchSettlementRecon(date: string): Promise<FetchResult<SettlementItem>> {
    // A day with nothing settled is a true empty answer ONLY if test mode settles at all. So recon
    // follows settlements: if test mode has none this month, the synthetic report is the coherent one.
    const probe = await this.monthHasSettlements(date);
    const tally: Tally = { requests: probe.requests, warnings: [] };
    if (!probe.has) {
      return this.fellBack(
        await this.options.fallback.fetchSettlementRecon(date),
        'test-mode-empty',
        tally,
      );
    }

    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    const raws = await this.listAll(tally, 'settlement recon', this.reconPageSize, (skip) =>
      this.options.client.settlementRecon({ year, month, day, count: this.reconPageSize, skip }),
    );
    const items = dedupeBy(
      parseEntries(raws, reconItemIngestSchema, 'settlement recon'),
      (item) => `${item.settlement_id}:${item.entity_id}`,
    );
    const mapped = items.map((entry) => mapReconItem(entry, this.ctx));
    return this.result(
      'settlement_recon',
      sortChronologically(mapped, (r) => r.settledAt ?? ''),
      tally,
    );
  }
}
