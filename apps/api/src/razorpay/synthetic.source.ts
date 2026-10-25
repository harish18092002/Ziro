import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RzpPayment, RzpRefund, RzpSettlement, SettlementItem } from '@ziro/core/domain';
import {
  orderIngestSchema,
  paymentIngestSchema,
  reconItemIngestSchema,
  refundIngestSchema,
  settlementIngestSchema,
} from '@ziro/core/razorpay';
import { istDayBounds } from '@ziro/core/time';
import { dedupeById, epochRange, inRange, parseCollection, parseEntries } from './entries.js';
import { RazorpayConfigError, RazorpayResponseError } from './errors.js';
import {
  mapPayment,
  mapReconItem,
  mapRefund,
  mapSettlement,
  receiptsByOrderId,
  sortChronologically,
} from './mappers.js';
import type { DateRange, Entity, FetchResult, RazorpaySource } from './source.js';

export interface SyntheticSourceOptions {
  readonly runId: string;
  /** A directory written by `npm run datagen`. */
  readonly dir: string;
}

const FILES = {
  payments: 'razorpay_payments.json',
  orders: 'razorpay_orders.json',
  refunds: 'razorpay_refunds.json',
  settlements: 'razorpay_settlements.json',
  recon: 'settlement_recon.json',
} as const;

/**
 * Razorpay data read from files @ziro/datagen wrote. It is the demo and eval world, and what
 * `RAZORPAY_SOURCE=synthetic` serves. Every record is labelled `synthetic`.
 */
export class SyntheticSource implements RazorpaySource {
  private readonly files = new Map<string, Promise<unknown[]>>();

  constructor(private readonly options: SyntheticSourceOptions) {}

  private get ctx() {
    return { runId: this.options.runId, source: 'synthetic' } as const;
  }

  /** Reads and checks one collection file, once. */
  private load(name: (typeof FILES)[keyof typeof FILES]): Promise<unknown[]> {
    let pending = this.files.get(name);
    if (!pending) {
      pending = (async () => {
        let text: string;
        try {
          text = await readFile(join(this.options.dir, name), 'utf8');
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new RazorpayConfigError(
            `cannot read ${name} in ${this.options.dir} (${reason}). Generate it with: npm run datagen -- --out <dir>`,
          );
        }
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new RazorpayResponseError(`${name} is not valid JSON`);
        }
        return parseCollection(body, name);
      })();
      this.files.set(name, pending);
    }
    return pending;
  }

  private result<T>(entity: Entity, items: FetchResult<T>['items']): FetchResult<T> {
    return {
      source: 'synthetic',
      items,
      provenance: { entity, source: 'synthetic', requests: 0, warnings: [] },
    };
  }

  async fetchPayments(range: DateRange): Promise<FetchResult<RzpPayment>> {
    const bounds = epochRange(range);
    const orders = parseEntries(
      await this.load(FILES.orders),
      orderIngestSchema,
      'synthetic orders',
    );
    const receipts = receiptsByOrderId(dedupeById(orders));
    const payments = dedupeById(
      parseEntries(await this.load(FILES.payments), paymentIngestSchema, 'synthetic payments'),
    );
    const mapped = payments
      .filter(({ parsed }) => inRange(parsed.created_at, bounds))
      .map((entry) => mapPayment(entry, receipts, this.ctx));
    return this.result(
      'payments',
      sortChronologically(mapped, (r) => r.createdAt),
    );
  }

  async fetchRefunds(range: DateRange): Promise<FetchResult<RzpRefund>> {
    const bounds = epochRange(range);
    const refunds = dedupeById(
      parseEntries(await this.load(FILES.refunds), refundIngestSchema, 'synthetic refunds'),
    );
    const mapped = refunds
      .filter(({ parsed }) => inRange(parsed.created_at, bounds))
      .map((entry) => mapRefund(entry, this.ctx));
    return this.result(
      'refunds',
      sortChronologically(mapped, (r) => r.createdAt),
    );
  }

  async fetchSettlements(range: DateRange): Promise<FetchResult<RzpSettlement>> {
    const bounds = epochRange(range);
    const settlements = dedupeById(
      parseEntries(
        await this.load(FILES.settlements),
        settlementIngestSchema,
        'synthetic settlements',
      ),
    );
    const mapped = settlements
      .filter(({ parsed }) => inRange(parsed.created_at, bounds))
      .map((entry) => mapSettlement(entry, this.ctx));
    return this.result(
      'settlements',
      sortChronologically(mapped, (r) => r.createdAt),
    );
  }

  /**
   * Every recon line in the dataset, parsed once. The per-day call below is what the Razorpay API
   * contract asks for, but it re-reads the whole file each time: right for a sixty-day demo, hopeless
   * for the two-year stress preset. Tooling that wants the whole dataset (the matcher benchmark and
   * its truth test) uses this instead.
   */
  async fetchAllSettlementRecon(): Promise<FetchResult<SettlementItem>> {
    const items = parseEntries(
      await this.load(FILES.recon),
      reconItemIngestSchema,
      'synthetic recon',
    );
    return this.result(
      'settlement_recon',
      sortChronologically(
        items.map((entry) => mapReconItem(entry, this.ctx)),
        (r) => r.settledAt ?? '',
      ),
    );
  }

  async fetchSettlementRecon(date: string): Promise<FetchResult<SettlementItem>> {
    const { fromEpoch, toEpoch } = istDayBounds(date);
    const items = parseEntries(
      await this.load(FILES.recon),
      reconItemIngestSchema,
      'synthetic recon',
    );
    const mapped = items
      .filter(({ parsed }) => parsed.settled_at >= fromEpoch && parsed.settled_at <= toEpoch)
      .map((entry) => mapReconItem(entry, this.ctx));
    return this.result(
      'settlement_recon',
      sortChronologically(mapped, (r) => r.settledAt ?? ''),
    );
  }
}
