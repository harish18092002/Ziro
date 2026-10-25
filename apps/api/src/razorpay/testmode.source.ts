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
  Incomplete,
  RazorpaySource,
  SourceLabel,
} from './source.js';

export interface TestModeSourceOptions {
  readonly runId: string;
  readonly client: RazorpayClient;
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
  /** Lists that stopped part-way (see listAll). */
  readonly incomplete: Incomplete[];
}

const newTally = (requests = 0): Tally => ({ requests, warnings: [], incomplete: [] });

const SOURCE: SourceLabel = 'razorpay_testmode';

/**
 * Razorpay data from the real API with TEST keys: the payments, refunds and (if test mode has any)
 * settlements that exist in your test account, and nothing else. A fresh account answers with empty lists,
 * and that is what the run gets: an empty answer is a true answer, never topped up with generated data
 * (ADR-019). Errors surface too: bad credentials, a rate limit that outlasts the retries or a bug of ours
 * must not hide behind plausible numbers.
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

  /**
   * Walks count/skip to the end of a list. If a later page fails once the retries are spent, the pages
   * already received are kept and the list is recorded as incomplete: they are real records, and
   * throwing them away would make a transient outage cost the whole import. A failure on the FIRST page
   * has nothing to keep and is thrown.
   */
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
      let body: unknown;
      try {
        body = await fetchPage(all.length);
      } catch (error) {
        if (page === 0 || !(error instanceof RazorpayApiError)) throw error;
        tally.incomplete.push({ what: label, fetched: all.length, reason: error.summary });
        return all;
      }
      const items = parseCollection(body, label);
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
        requests: tally.requests,
        warnings: tally.warnings,
        ...(tally.incomplete.length === 0 ? {} : { incomplete: tally.incomplete }),
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
    const tally = newTally();
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
    const bounds = epochRange(range);
    const tally = newTally();
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
    return this.result(
      'refunds',
      sortChronologically(mapped, (r) => r.createdAt),
      tally,
    );
  }

  async fetchSettlements(range: DateRange): Promise<FetchResult<RzpSettlement>> {
    const bounds = epochRange(range);
    const tally = newTally();
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
    const mapped = settlements.map((entry) => mapSettlement(entry, this.ctx));
    return this.result(
      'settlements',
      sortChronologically(mapped, (r) => r.createdAt),
      tally,
    );
  }

  /** Does the account have any settlement at all in this date's calendar month? One call, remembered. */
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
    // One call per month tells whether anything settled at all, so a month with no settlement does not
    // cost a recon request for every day of it. Nothing settled is a true, empty answer.
    const probe = await this.monthHasSettlements(date);
    const tally = newTally(probe.requests);
    if (!probe.has) return this.result('settlement_recon', [], tally);

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
