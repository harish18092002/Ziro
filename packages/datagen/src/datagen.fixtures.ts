// Test support. It re-derives everything from the WRITTEN FILES with code that shares nothing with
// the generator (its own calendar, Intl for IST, its own CSV parser), so a bug in the generator
// cannot cancel itself out.
import { type Paise, parseRupees } from '@ziro/core/money';
import { z } from 'zod';
import type { GenConfig } from './config.js';
import type { FileName } from './render/files.js';
import {
  collectionSchema,
  orderSchema,
  paymentSchema,
  reconItemSchema,
  refundSchema,
  settlementSchema,
} from './razorpay-schemas.js';

/** Minimal RFC 4180 parser: quoted cells, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const istFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface IstParts {
  readonly date: string; // YYYY-MM-DD
  readonly secondOfDay: number;
}

/** IST date and second-of-day of an epoch-seconds instant, via Intl (not the generator's maths). */
export function istOf(epochSeconds: number): IstParts {
  const parts = Object.fromEntries(
    istFormat.formatToParts(new Date(epochSeconds * 1000)).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    secondOfDay:
      Number(parts['hour']) * 3600 + Number(parts['minute']) * 60 + Number(parts['second']),
  };
}

export const dmyToIso = (dmy: string, separator: string): string => {
  const [d, m, y] = dmy.split(separator);
  return `${y}-${m}-${d}`;
};

/** An independent T+n business-day calendar: weekends plus fixed MM-DD holidays. */
export function addBusinessDaysIso(
  iso: string,
  count: number,
  holidays: readonly string[],
): string {
  const date = new Date(`${iso}T00:00:00Z`);
  let left = count;
  const isBusiness = (d: Date): boolean => {
    const dow = d.getUTCDay();
    const mmdd = `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    return dow !== 0 && dow !== 6 && !holidays.includes(mmdd);
  };
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isBusiness(date)) left -= 1;
  }
  while (!isBusiness(date)) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export type RawOrder = z.infer<typeof orderSchema>;
export type RawPayment = z.infer<typeof paymentSchema>;
export type RawRefund = z.infer<typeof refundSchema>;
export type RawSettlement = z.infer<typeof settlementSchema>;
export type RawItem = z.infer<typeof reconItemSchema>;

export interface RawLedger {
  readonly order_ref: string;
  readonly order_date: string; // ISO
  readonly amount: Paise;
  readonly customer_ref: string;
  readonly memo: string;
}

export interface RawBank {
  readonly row: number;
  readonly value_date: string; // ISO
  readonly narration: string;
  readonly debit: Paise | null;
  readonly credit: Paise | null;
  readonly balance: Paise;
}

export interface TruthRecordFile {
  readonly type: string;
  readonly key: string;
  readonly groupId: string | null;
  readonly role: string;
  readonly reasonCodes: string[];
  readonly anomalyIds: string[];
  readonly injection: { field: string; style: string; text: string } | null;
  readonly ambiguousWith: string[];
}

export interface TruthFile {
  readonly meta: {
    seed: number;
    preset: string;
    counts: { anomalies: Record<string, number>; injections: number };
  };
  readonly groups: {
    id: string;
    kind: string;
    members: string[];
    structural: string[];
    anomalies: string[];
    composition: Record<string, string>;
  }[];
  readonly anomalies: {
    id: string;
    reasonCode: string;
    records: { type: string; key: string; role: string }[];
    detail: Record<string, string>;
  }[];
  readonly records: TruthRecordFile[];
}

export interface Raw {
  readonly ledger: RawLedger[];
  readonly orders: RawOrder[];
  readonly payments: RawPayment[];
  readonly refunds: RawRefund[];
  readonly settlements: RawSettlement[];
  readonly items: RawItem[];
  readonly bank: RawBank[];
  readonly truth: TruthFile;
}

const optionalMoney = (cell: string | undefined): Paise | null =>
  cell === undefined || cell === '' ? null : parseRupees(cell);

/** Parses the rendered files back, validating every Razorpay file against the doc-derived schemas. */
export function loadRaw(files: ReadonlyMap<FileName, string>): Raw {
  const get = (name: FileName): string => {
    const text = files.get(name);
    if (text === undefined) throw new Error(`missing output file ${name}`);
    return text;
  };
  const collection = <T extends z.ZodType>(name: FileName, item: T): z.infer<T>[] => {
    const doc = collectionSchema(item).parse(JSON.parse(get(name)));
    if (doc.count !== doc.items.length)
      throw new Error(`${name}: count ${doc.count} != items ${doc.items.length}`);
    return doc.items;
  };

  const ledgerRows = parseCsv(get('ledger.csv'));
  if (ledgerRows[0]?.join(',') !== 'order_ref,order_date,amount,customer_ref,memo')
    throw new Error('bad ledger.csv header');
  const bankRows = parseCsv(get('bank_statement.csv'));
  if (bankRows[0]?.join(',') !== 'value_date,narration,debit,credit,balance')
    throw new Error('bad bank_statement.csv header');

  return {
    ledger: ledgerRows.slice(1).map((c) => ({
      order_ref: c[0] ?? '',
      order_date: dmyToIso(c[1] ?? '', '-'),
      amount: parseRupees(c[2] ?? ''),
      customer_ref: c[3] ?? '',
      memo: c[4] ?? '',
    })),
    orders: collection('razorpay_orders.json', orderSchema),
    payments: collection('razorpay_payments.json', paymentSchema),
    refunds: collection('razorpay_refunds.json', refundSchema),
    settlements: collection('razorpay_settlements.json', settlementSchema),
    items: collection('settlement_recon.json', reconItemSchema),
    bank: bankRows.slice(1).map((c, i) => ({
      row: i + 1,
      value_date: dmyToIso(c[0] ?? '', '/'),
      narration: c[1] ?? '',
      debit: optionalMoney(c[2]),
      credit: optionalMoney(c[3]),
      balance: parseRupees(c[4] ?? ''),
    })),
    truth: JSON.parse(get('truth.json')) as TruthFile,
  };
}

/** Rounds a basis-point share of a pool half-up: the test's own copy of the counting rule. */
export const expectedCount = (bps: number, pool: number): number =>
  Math.floor((bps * pool + 5000) / 10_000);

/** Half-up base fee, written independently of @ziro/core so the two can disagree. */
const baseFee = (amount: bigint, bps: number): bigint => (amount * BigInt(bps) + 5000n) / 10_000n;

/** Everything recounted from raw files. Keys are reason codes. */
export function recountAnomalies(raw: Raw, config: GenConfig): Record<string, number> {
  const orderById = new Map(raw.orders.map((o) => [o.id, o]));
  const capturedByReceipt = new Map<string, RawPayment>();
  const captured = raw.payments.filter((p) => p.status === 'captured' || p.status === 'refunded');
  for (const p of captured) {
    const receipt = p.order_id === null ? null : (orderById.get(p.order_id)?.receipt ?? null);
    if (receipt !== null) capturedByReceipt.set(receipt, p);
  }
  const isRetryReceipt = (receipt: string | null): boolean =>
    receipt !== null && /-R1$/.test(receipt);
  const receiptOf = (p: RawPayment): string | null =>
    p.order_id === null ? null : (orderById.get(p.order_id)?.receipt ?? null);
  const paymentById = new Map(raw.payments.map((p) => [p.id, p]));

  const counts: Record<string, number> = {};
  const bump = (code: string, by = 1): void => {
    counts[code] = (counts[code] ?? 0) + by;
  };

  // LEDGER_WITHOUT_PAYMENT: a ledger row no Razorpay order refers to.
  const receipts = new Set(raw.orders.flatMap((o) => (o.receipt === null ? [] : [o.receipt])));
  bump('LEDGER_WITHOUT_PAYMENT', raw.ledger.filter((l) => !receipts.has(l.order_ref)).length);

  // PAYMENT_WITHOUT_LEDGER: money received on an order that has no receipt (a payment link).
  bump('PAYMENT_WITHOUT_LEDGER', captured.filter((p) => receiptOf(p) === null).length);

  // DUPLICATE_PAYMENT: a paid retry order (receipt ends -R1).
  bump('DUPLICATE_PAYMENT', captured.filter((p) => isRetryReceipt(receiptOf(p))).length);

  // Refunds: a refund of a retry payment is the duplicate's refund; otherwise full or partial.
  for (const r of raw.refunds) {
    const payment = paymentById.get(r.payment_id);
    if (!payment || isRetryReceipt(receiptOf(payment))) continue;
    bump(r.amount === payment.amount ? 'FULL_REFUND' : 'PARTIAL_REFUND_NETTED');
  }

  bump(
    'CHARGEBACK_ADJUSTMENT',
    raw.items.filter((i) => i.type === 'adjustment' && i.debit > 0).length,
  );

  for (const row of raw.ledger) {
    const payment = capturedByReceipt.get(row.order_ref);
    if (!payment) continue;
    if (BigInt(payment.amount) !== row.amount) bump('LEDGER_AMOUNT_EDITED');
    if (istOf(payment.created_at).date !== row.order_date) bump('TIMEZONE_DATE_SHIFT');
  }

  // FEE_OVERCHARGE: the base fee (fee minus GST) is above what the contracted rate gives.
  for (const p of captured) {
    if (p.fee === null || p.tax === null) continue;
    const base = BigInt(p.fee) - BigInt(p.tax);
    const expected = baseFee(
      BigInt(p.amount),
      config.feeBps[p.method as 'card' | 'upi' | 'netbanking'],
    );
    if (base !== expected) bump('FEE_OVERCHARGE');
  }

  // SETTLEMENT_DELAYED: a settlement later than T+2 business days after its payments were captured.
  const itemsBySettlement = new Map<string, RawItem[]>();
  for (const item of raw.items) {
    const list = itemsBySettlement.get(item.settlement_id);
    if (list) list.push(item);
    else itemsBySettlement.set(item.settlement_id, [item]);
  }
  for (const s of raw.settlements) {
    const first = (itemsBySettlement.get(s.id) ?? []).find((i) => i.type === 'payment');
    if (!first) continue;
    const due = addBusinessDaysIso(
      istOf(first.created_at).date,
      config.settlementLagBusinessDays,
      config.fixedHolidays,
    );
    if (istOf(s.created_at).date > due) bump('SETTLEMENT_DELAYED');
  }

  // UTR_MISSING_OR_GARBLED: a Razorpay credit whose narration does not carry the exact UTR.
  const utrs = raw.settlements.map((s) => s.utr);
  const razorpayCredits = raw.bank.filter(
    (b) => b.credit !== null && b.narration.includes('RAZORPAY SOFTWARE'),
  );
  bump(
    'UTR_MISSING_OR_GARBLED',
    razorpayCredits.filter((b) => !utrs.some((u) => b.narration.includes(u))).length,
  );

  return counts;
}
