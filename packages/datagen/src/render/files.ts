import { formatRupees } from '@ziro/core/money';
import { formatDmy } from '../time.js';
import { compareStrings } from '../util.js';
import type { Dataset } from '../world/types.js';
import { csvRow } from './csv.js';
import { collectionChunks, type Json } from './json.js';
import { orderJson, paymentJson, reconItemJson, refundJson, settlementJson } from './razorpay.js';
import { truthChunks } from './truth.js';

export const FILE_NAMES = [
  'ledger.csv',
  'razorpay_orders.json',
  'razorpay_payments.json',
  'razorpay_refunds.json',
  'razorpay_settlements.json',
  'settlement_recon.json',
  'bank_statement.csv',
  'truth.json',
] as const;

export type FileName = (typeof FILE_NAMES)[number];

export interface OutputFile {
  readonly name: FileName;
  /** Produces the file's content lazily, in order; concatenating the chunks gives the file. */
  chunks(): Generator<string>;
}

/**
 * Newest first. Razorpay's docs do not state a list order, so this is a deliberately unfriendly one:
 * no consumer may rely on creation order.
 */
const newestFirst = <T extends { readonly createdAt: number }>(
  items: readonly T[],
  id: (item: T) => string,
): T[] => [...items].sort((a, b) => b.createdAt - a.createdAt || compareStrings(id(a), id(b)));

export function outputFiles(data: Dataset): OutputFile[] {
  const indent = data.config.jsonIndent;
  const utrBySettlement = new Map(data.settlements.map((s) => [s.id, s.utr]));

  const json = (name: FileName, items: () => Iterable<Json>, count: number): OutputFile => ({
    name,
    chunks: () => collectionChunks(items(), count, indent),
  });

  return [
    {
      name: 'ledger.csv',
      *chunks() {
        yield csvRow(['order_ref', 'order_date', 'amount', 'customer_ref', 'memo']);
        for (const row of data.ledger) {
          yield csvRow([
            row.orderRef,
            formatDmy(row.day, '-'),
            formatRupees(row.amount),
            row.customerRef,
            row.memo,
          ]);
        }
      },
    },
    json(
      'razorpay_orders.json',
      () => newestFirst(data.orders, (o) => o.id).map(orderJson),
      data.orders.length,
    ),
    json(
      'razorpay_payments.json',
      () => newestFirst(data.payments, (p) => p.id).map(paymentJson),
      data.payments.length,
    ),
    json(
      'razorpay_refunds.json',
      () => newestFirst(data.refunds, (r) => r.id).map(refundJson),
      data.refunds.length,
    ),
    json(
      'razorpay_settlements.json',
      () => newestFirst(data.settlements, (s) => s.id).map(settlementJson),
      data.settlements.length,
    ),
    json(
      'settlement_recon.json',
      () =>
        [...data.items]
          .sort(
            (a, b) =>
              b.settledAt - a.settledAt ||
              b.createdAt - a.createdAt ||
              compareStrings(a.entityId, b.entityId),
          )
          .map((item) => reconItemJson(item, utrBySettlement.get(item.settlementId) ?? '')),
      data.items.length,
    ),
    {
      name: 'bank_statement.csv',
      *chunks() {
        yield csvRow(['value_date', 'narration', 'debit', 'credit', 'balance']);
        for (const row of data.bank) {
          yield csvRow([
            formatDmy(row.day, '/'),
            row.narration,
            row.debit === null ? '' : formatRupees(row.debit),
            row.credit === null ? '' : formatRupees(row.credit),
            formatRupees(row.balance),
          ]);
        }
      },
    },
    { name: 'truth.json', chunks: () => truthChunks(data) },
  ];
}

/** Renders every output file to a string. For tests and small presets; the CLI streams instead. */
export function renderToStrings(data: Dataset): Map<FileName, string> {
  const out = new Map<FileName, string>();
  for (const file of outputFiles(data)) out.set(file.name, [...file.chunks()].join(''));
  return out;
}
