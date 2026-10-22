import type { ReasonCode } from '@ziro/core/domain';
import type { Paise } from '@ziro/core/money';
import type { GenConfig, Method } from '../config.js';

export type RecordType =
  | 'ledger_entry'
  | 'rzp_order'
  | 'rzp_payment'
  | 'rzp_refund'
  | 'rzp_settlement'
  | 'settlement_item'
  | 'bank_line';

export type InjectionField = 'memo' | 'narration' | 'notes';

export interface Injection {
  readonly field: InjectionField;
  readonly style: string;
  readonly text: string;
}

/** Ground truth for one record, written to truth.json. */
export interface Label {
  /** The true match group, or null when the record is a genuine leftover or pure noise. */
  groupId: string | null;
  /** What the record is in the normal world ('normal', 'cash_order', 'failed_attempt', ...). */
  role: string;
  anomalyIds: string[];
  injection: Injection | null;
  /** Other bank credits of the same amount close in time: the ambiguity a matcher must resolve. */
  ambiguousWith: string[];
}

export function newLabel(role: string, groupId: string | null = null): Label {
  return { groupId, role, anomalyIds: [], injection: null, ambiguousWith: [] };
}

export interface Customer {
  readonly ref: string;
  readonly email: string;
  readonly contact: string;
  readonly vpa: string;
  readonly bank4: string;
}

export interface LedgerRec {
  readonly orderRef: string;
  /** IST day number of the order. */
  readonly day: number;
  readonly amount: Paise;
  readonly customerRef: string;
  memo: string;
  readonly label: Label;
}

export interface OrderRec {
  readonly id: string;
  readonly receipt: string | null;
  readonly amount: Paise;
  readonly attempts: number;
  /** null renders as `[]`, which is how Razorpay's own samples show empty notes. */
  readonly notes: Record<string, string> | null;
  readonly createdAt: number;
  readonly label: Label;
}

export interface PaymentError {
  readonly code: string;
  readonly description: string;
  readonly source: string;
  readonly step: string;
  readonly reason: string;
}

export interface PaymentRec {
  readonly id: string;
  readonly orderId: string;
  readonly amount: Paise;
  /** Fee including GST, and the GST part of it (ADR-004). Null on failed attempts. */
  readonly fee: Paise | null;
  readonly tax: Paise | null;
  /** The contracted fee (incl. GST) this payment should have paid; differs on FEE_OVERCHARGE. */
  readonly expectedFee: Paise | null;
  readonly method: Method;
  status: 'captured' | 'refunded' | 'failed';
  amountRefunded: Paise;
  readonly createdAt: number;
  readonly customer: Customer;
  notes: Record<string, string> | null;
  readonly description: string | null;
  readonly cardId: string | null;
  readonly cardNetwork: string | null;
  readonly cardType: string | null;
  readonly bank4: string | null;
  readonly vpa: string | null;
  readonly rrn: string;
  readonly error: PaymentError | null;
  readonly label: Label;
}

export interface RefundRec {
  readonly id: string;
  readonly paymentId: string;
  readonly amount: Paise;
  readonly createdAt: number;
  readonly reason: string;
  notes: Record<string, string>;
  readonly label: Label;
}

export interface SettlementRec {
  readonly id: string;
  readonly utr: string;
  /** Net payout: sum of credits minus sum of debits of its items. */
  amount: Paise;
  readonly createdAt: number;
  readonly settleDay: number;
  /** IST day the money is credited in the bank (settleDay, or the day after). */
  readonly bankDay: number;
  readonly label: Label;
}

export type ItemType = 'payment' | 'refund' | 'transfer' | 'adjustment';

export interface ItemRec {
  readonly settlementId: string;
  readonly type: ItemType;
  readonly entityId: string;
  /** For a refund: the refunded payment. Null for payments and adjustments, as in the docs. */
  readonly paymentId: string | null;
  readonly orderId: string | null;
  readonly receipt: string | null;
  readonly method: Method | null;
  readonly cardNetwork: string | null;
  readonly cardType: string | null;
  readonly cardIssuer: string | null;
  readonly amount: Paise;
  readonly fee: Paise;
  readonly tax: Paise;
  readonly debit: Paise;
  readonly credit: Paise;
  readonly createdAt: number;
  readonly settledAt: number;
  readonly description: string | null;
  readonly disputeId: string | null;
  readonly label: Label;
}

export interface BankRec {
  /** 1-based row number in bank_statement.csv: the key used in truth.json (`row-<n>`). */
  rowNumber: number;
  readonly day: number;
  narration: string;
  readonly debit: Paise | null;
  readonly credit: Paise | null;
  balance: Paise;
  /** Settlement this line is the credit for, if any. */
  readonly settlementId: string | null;
  readonly utrVariant: string | null;
  readonly label: Label;
}

export interface AnomalyMember {
  readonly type: RecordType;
  readonly key: string;
  readonly role: string;
}

export interface AnomalyRec {
  id: string;
  readonly code: ReasonCode;
  readonly records: AnomalyMember[];
  readonly detail: Record<string, string>;
}

export interface GroupRec {
  readonly id: string;
  readonly kind: 'order' | 'payout';
  readonly members: string[];
  readonly structural: ReasonCode[];
  anomalies: ReasonCode[];
  composition: Record<string, string>;
}

export interface Dataset {
  readonly config: GenConfig;
  readonly ledger: LedgerRec[];
  readonly orders: OrderRec[];
  readonly payments: PaymentRec[];
  readonly refunds: RefundRec[];
  readonly settlements: SettlementRec[];
  readonly items: ItemRec[];
  readonly bank: BankRec[];
  readonly groups: GroupRec[];
  readonly anomalies: AnomalyRec[];
}

export function recordKey(type: RecordType, key: string): string {
  return `${type}:${key}`;
}
