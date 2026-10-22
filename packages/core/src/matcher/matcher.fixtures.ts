// Test support: small builders for matcher inputs. Not part of the production build.
import type {
  BankLine,
  LedgerEntry,
  RzpPayment,
  RzpRefund,
  RzpSettlement,
  SettlementItem,
} from '../domain/index.js';
import { type Paise, paise } from '../money/index.js';
import { extractUtr } from '../normalize/index.js';

export const RUN = '00000000-0000-4000-8000-0000000000aa';
const HASH = 'c'.repeat(64);

let counter = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
const base = (sourceRef: string) => ({
  id: uuid(),
  runId: RUN,
  source: 'synthetic' as const,
  sourceRef,
  importHash: HASH,
});
const P = (value: number | bigint): Paise => paise(BigInt(value));

export function ledger(
  orderRef: string,
  amount: number,
  over: Partial<LedgerEntry> = {},
): LedgerEntry {
  return {
    ...base(orderRef),
    orderRef,
    amount: P(amount),
    businessDate: '2026-09-01',
    customerRef: 'CUST-1',
    memo: null,
    ...over,
  };
}

export function payment(
  paymentId: string,
  receipt: string | null,
  amount: number,
  over: Partial<RzpPayment> = {},
): RzpPayment {
  return {
    ...base(paymentId),
    paymentId,
    orderId: `order_${paymentId.slice(4)}`,
    receipt,
    amount: P(amount),
    fee: P(236),
    tax: P(36),
    currency: 'INR',
    amountRefunded: P(0),
    method: 'card',
    status: 'captured',
    captured: true,
    createdAt: '2026-09-01T06:00:00Z',
    businessDate: '2026-09-01',
    ...over,
  };
}

export function refund(
  refundId: string,
  paymentId: string,
  amount: number,
  over: Partial<RzpRefund> = {},
): RzpRefund {
  return {
    ...base(refundId),
    refundId,
    paymentId,
    currency: 'INR',
    amount: P(amount),
    status: 'processed',
    createdAt: '2026-09-02T06:00:00Z',
    businessDate: '2026-09-02',
    ...over,
  };
}

export interface Adjustment {
  readonly id: string;
  readonly debit?: number;
  readonly credit?: number;
  readonly description?: string;
}

export interface BuiltSettlement {
  readonly settlement: RzpSettlement;
  readonly items: SettlementItem[];
}

/** A settlement whose amount is exactly the composition of the given lines, with its recon lines. */
export function settlementOf(
  settlementId: string,
  businessDate: string,
  lines: {
    readonly payments?: readonly RzpPayment[];
    readonly refunds?: readonly RzpRefund[];
    readonly adjustments?: readonly Adjustment[];
  },
  over: Partial<RzpSettlement> = {},
): BuiltSettlement {
  const payments = lines.payments ?? [];
  const refunds = lines.refunds ?? [];
  const adjustments = lines.adjustments ?? [];
  let amount = 0n;
  const items: SettlementItem[] = [];
  const line = (entityId: string, over2: Partial<SettlementItem>): SettlementItem => ({
    ...base(`${settlementId}:${entityId}`),
    settlementId,
    itemType: 'payment',
    entityId,
    paymentId: null,
    orderId: null,
    currency: 'INR',
    amount: P(0),
    fee: P(0),
    tax: P(0),
    debit: P(0),
    credit: P(0),
    settledAt: `${businessDate}T06:00:00Z`,
    description: null,
    ...over2,
  });

  for (const p of payments) {
    amount += p.amount - p.fee;
    items.push(
      line(p.paymentId, {
        itemType: 'payment',
        amount: p.amount,
        fee: p.fee,
        tax: p.tax,
        credit: P(p.amount - p.fee),
        orderId: p.orderId,
      }),
    );
  }
  for (const r of refunds) {
    amount -= r.amount;
    items.push(
      line(r.refundId, {
        itemType: 'refund',
        paymentId: r.paymentId,
        amount: r.amount,
        debit: r.amount,
      }),
    );
  }
  for (const a of adjustments) {
    amount += BigInt(a.credit ?? 0) - BigInt(a.debit ?? 0);
    items.push(
      line(a.id, {
        itemType: 'adjustment',
        debit: P(a.debit ?? 0),
        credit: P(a.credit ?? 0),
        amount: P((a.debit ?? 0) + (a.credit ?? 0)),
        description: a.description ?? null,
      }),
    );
  }

  const settlement: RzpSettlement = {
    ...base(settlementId),
    settlementId,
    amount: P(amount),
    fees: P(0),
    tax: P(0),
    utr: 'UTIBN34889755412',
    status: 'processed',
    createdAt: `${businessDate}T06:00:00Z`,
    businessDate,
    ...over,
  };
  return { settlement, items };
}

/** A bank line as the importer would store it: the UTR and its quality come from the narration. */
export function credit(
  amount: number | bigint,
  valueDate: string,
  narration = 'NEFT CR-RAZORPAY SOFTWARE PRIVATE LIMITED',
  over: Partial<BankLine> = {},
): BankLine {
  const found = extractUtr(narration);
  return {
    ...base(`row-${counter + 1}`),
    valueDate,
    direction: 'credit',
    amount: P(amount),
    narration,
    utr: found.utr,
    utrQuality: found.quality,
    balance: null,
    ...over,
  };
}

export const debit = (
  amount: number,
  valueDate: string,
  narration = 'CHQ PAID 1 SOMEONE',
): BankLine => credit(amount, valueDate, narration, { direction: 'debit' });

export const emptyInput = () => ({
  ledger: [] as LedgerEntry[],
  payments: [] as RzpPayment[],
  refunds: [] as RzpRefund[],
  settlements: [] as RzpSettlement[],
  settlementItems: [] as SettlementItem[],
  bankLines: [] as BankLine[],
});
