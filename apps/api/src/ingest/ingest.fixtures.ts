// Test support: a Razorpay source that returns exactly what a test gives it and records how it was
// asked, so window arithmetic and provenance handling can be tested without any dataset.
import { randomUUID } from 'node:crypto';
import type { RzpSettlement, SettlementItem } from '@ziro/core/domain';
import { paise } from '@ziro/core/money';
import type {
  DateRange,
  Entity,
  FetchResult,
  Provenance,
  RazorpaySource,
  Sourced,
  SourceLabel,
} from '../razorpay/source.js';

export const STUB_RUN_ID = '00000000-0000-4000-8000-0000000000bb';
const HASH = 'b'.repeat(64);

export interface StubCalls {
  readonly payments: DateRange[];
  readonly refunds: DateRange[];
  readonly settlements: DateRange[];
  readonly recon: string[];
}

export interface StubConfig {
  readonly settlements?: readonly Sourced<RzpSettlement>[];
  readonly items?: readonly Sourced<SettlementItem>[];
  /** Per-entity source label; recon's can differ by day. */
  readonly labels?: Partial<Record<Entity, SourceLabel>>;
  readonly reconLabelFor?: (date: string) => SourceLabel;
  readonly warnings?: Partial<Record<Entity, string[]>>;
}

function provenance(
  entity: Entity,
  source: SourceLabel,
  requests: number,
  warnings: readonly string[] = [],
): Provenance {
  return { entity, source, reason: 'ok', requests, warnings };
}

export function stubSource(config: StubConfig = {}): { source: RazorpaySource; calls: StubCalls } {
  const calls: StubCalls = { payments: [], refunds: [], settlements: [], recon: [] };
  const label = (entity: Entity): SourceLabel => config.labels?.[entity] ?? 'synthetic';
  const result = <T>(
    entity: Entity,
    items: readonly Sourced<T>[],
    source: SourceLabel = label(entity),
  ): FetchResult<T> => ({
    source,
    items,
    provenance: provenance(
      entity,
      source,
      source === 'synthetic' ? 0 : 3,
      config.warnings?.[entity],
    ),
  });
  const source: RazorpaySource = {
    fetchPayments: (range) => {
      calls.payments.push(range);
      return Promise.resolve(result('payments', []));
    },
    fetchRefunds: (range) => {
      calls.refunds.push(range);
      return Promise.resolve(result('refunds', []));
    },
    fetchSettlements: (range) => {
      calls.settlements.push(range);
      return Promise.resolve(result('settlements', config.settlements ?? []));
    },
    fetchSettlementRecon: (date) => {
      calls.recon.push(date);
      const items = (config.items ?? []).filter((i) => i.record.settledAt?.slice(0, 10) === date);
      return Promise.resolve(
        result(
          'settlement_recon',
          items,
          config.reconLabelFor?.(date) ?? label('settlement_recon'),
        ),
      );
    },
  };
  return { source, calls };
}

export function settlementOn(
  id: string,
  businessDate: string,
  runId = STUB_RUN_ID,
): Sourced<RzpSettlement> {
  return {
    raw: { id },
    record: {
      id: randomUUID(),
      runId,
      source: 'synthetic',
      sourceRef: id,
      importHash: HASH,
      settlementId: id,
      amount: paise(100_000n),
      fees: paise(0n),
      tax: paise(0n),
      utr: 'UTIBN34889755412',
      status: 'processed',
      createdAt: `${businessDate}T06:00:00Z`,
      businessDate,
    },
  };
}

/** A payment line of a settlement's recon report, settled on `date`. */
export function itemOf(
  n: number,
  settlementId: string,
  date: string,
  runId = STUB_RUN_ID,
): Sourced<SettlementItem> {
  return {
    raw: { n },
    record: {
      id: randomUUID(),
      runId,
      source: 'synthetic',
      sourceRef: `recon-${n}`,
      importHash: HASH,
      currency: 'INR',
      settlementId,
      itemType: 'payment',
      entityId: `pay_item${n}`,
      paymentId: null,
      orderId: null,
      amount: paise(1_000n),
      fee: paise(0n),
      tax: paise(0n),
      debit: paise(0n),
      credit: paise(1_000n),
      settledAt: `${date}T06:00:00Z`,
      description: null,
    },
  };
}

/**
 * The stub source, with some calls replaced. `asked` collects every recon day requested, failed or not
 * (the stub's own log only sees the days that reached it).
 */
export function withFailures(
  base: RazorpaySource,
  failures: Partial<{
    payments: Error;
    refunds: Error;
    settlements: Error;
    recon: (date: string) => Error | undefined;
  }>,
  asked: string[] = [],
): RazorpaySource {
  return {
    fetchPayments: (r) =>
      failures.payments ? Promise.reject(failures.payments) : base.fetchPayments(r),
    fetchRefunds: (r) =>
      failures.refunds ? Promise.reject(failures.refunds) : base.fetchRefunds(r),
    fetchSettlements: (r) =>
      failures.settlements ? Promise.reject(failures.settlements) : base.fetchSettlements(r),
    fetchSettlementRecon: (d) => {
      asked.push(d);
      const error = failures.recon?.(d);
      return error ? Promise.reject(error) : base.fetchSettlementRecon(d);
    },
  };
}
