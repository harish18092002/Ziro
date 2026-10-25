// Two files a Razorpay TEST account cannot supply on its own, built from the Razorpay data already in a run
// so there is something to reconcile against. Pure: rows in, CSV text out.
//
//   starter ledger    the merchant's order list. Razorpay has the orders (their `receipt` IS the merchant's
//                     order number), so this copies them out as a ledger CSV. It matches by construction,
//                     so it is only useful as a starting point: edit it (change an amount, delete a row,
//                     add an order that was never paid) to give the reconciliation something to find.
//   simulated bank    test mode moves no money, so there is no bank credit. IF the test account has
//                     settlements, this writes the credit a bank would show for each, with the UTR in the
//                     narration. It is labelled as simulated everywhere it appears.
import { formatRupees, paise } from '@ziro/core/money';
import { toCsv } from '../report/csv.js';

export interface StarterPayment {
  readonly receipt: string | null;
  readonly amountPaise: bigint;
  readonly currency: string;
  readonly captured: boolean;
  /** IST business date, `YYYY-MM-DD`. */
  readonly businessDate: string;
}

export interface StarterSkips {
  /** Payments that were not captured (failed, authorized, created). */
  readonly notCaptured: number;
  /** Captured payments whose order has no receipt, so there is nothing to call the order. */
  readonly noReceipt: number;
  /** Captured payments in a currency other than INR: Ziro reconciles rupees only. */
  readonly otherCurrency: number;
  /** A second captured payment for an order already listed: it stays out, so it shows up as a duplicate. */
  readonly repeatOfAnOrder: number;
}

export interface Starter {
  readonly csv: string;
  readonly rows: number;
  readonly skipped: StarterSkips;
}

export const LEDGER_HEADER = ['order_ref', 'order_date', 'amount', 'customer_ref', 'memo'] as const;
export const BANK_HEADER = ['value_date', 'narration', 'debit', 'credit', 'balance'] as const;

/** `2026-09-01` as `01-09-2026`, the ledger's date layout. */
export const ledgerDate = (iso: string): string => iso.split('-').reverse().join('-');
/** `2026-09-01` as `01/09/2026`, the bank statement's date layout. */
export const bankDate = (iso: string): string => iso.split('-').reverse().join('/');

/**
 * One ledger row per order that was actually paid: its receipt, the date of the first captured payment and
 * that payment's amount. A second captured payment for the same receipt is left out on purpose, so the
 * reconciliation finds a duplicate payment instead of the ledger hiding it.
 */
export function buildStarterLedger(payments: readonly StarterPayment[]): Starter {
  let notCaptured = 0;
  let noReceipt = 0;
  let otherCurrency = 0;
  let repeatOfAnOrder = 0;
  const first = new Map<string, StarterPayment>();

  const ordered = [...payments].sort(
    (a, b) =>
      a.businessDate.localeCompare(b.businessDate) ||
      (a.receipt ?? '').localeCompare(b.receipt ?? ''),
  );
  for (const p of ordered) {
    if (!p.captured) {
      notCaptured += 1;
    } else if (p.currency !== 'INR') {
      otherCurrency += 1;
    } else if (p.receipt === null || p.receipt.trim() === '') {
      noReceipt += 1;
    } else if (first.has(p.receipt)) {
      repeatOfAnOrder += 1;
    } else {
      first.set(p.receipt, p);
    }
  }

  const rows = [...first.entries()].map(([receipt, p]) => [
    receipt,
    ledgerDate(p.businessDate),
    formatRupees(paise(p.amountPaise)),
    '',
    '',
  ]);
  return {
    csv: toCsv(LEDGER_HEADER, rows),
    rows: rows.length,
    skipped: { notCaptured, noReceipt, otherCurrency, repeatOfAnOrder },
  };
}

export interface StarterSettlement {
  readonly utr: string | null;
  readonly amountPaise: bigint;
  /** IST business date, `YYYY-MM-DD`. */
  readonly businessDate: string;
  readonly rzpId: string;
}

export interface SimulatedBank {
  readonly csv: string;
  readonly rows: number;
  /** Settlements with no UTR: a bank line without one could not be matched to them, so none is made. */
  readonly withoutUtr: number;
}

/**
 * One bank credit per settlement, dated the day Razorpay says it settled, with the UTR in the narration the
 * way a bank prints it, and a running balance from zero. Oldest first, so the balances chain.
 */
export function buildSimulatedBank(settlements: readonly StarterSettlement[]): SimulatedBank {
  const withUtr = settlements.filter(
    (s): s is StarterSettlement & { utr: string } => s.utr !== null && s.utr.trim() !== '',
  );
  const ordered = [...withUtr].sort(
    (a, b) => a.businessDate.localeCompare(b.businessDate) || a.rzpId.localeCompare(b.rzpId),
  );
  let balance = 0n;
  const rows = ordered.map((s) => {
    balance += s.amountPaise;
    return [
      bankDate(s.businessDate),
      `NEFT CR-${s.utr}-RAZORPAY SOFTWARE PRIVATE LIMITED`,
      '',
      formatRupees(paise(s.amountPaise)),
      formatRupees(paise(balance)),
    ];
  });
  return {
    csv: toCsv(BANK_HEADER, rows),
    rows: rows.length,
    withoutUtr: settlements.length - withUtr.length,
  };
}
