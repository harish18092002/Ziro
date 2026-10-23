// Vouchers for the books, in the shape an accountant can bring into Tally. Pure: no database, no
// clock. See ADR-014 for the format and what it assumes.
//
// A Razorpay settlement is booked as two vouchers, both against the "Razorpay Clearing" ledger that the
// merchant's sales were debited to:
//
//   Receipt   Dr Bank                        net payout                  (the money that landed)
//   Journal   Dr Payment Gateway Charges     fees minus GST
//             Dr GST Input Credit            GST on the fees
//             Dr Refunds                     refunds netted in the payout
//             Dr Chargeback Loss             chargebacks and disputes
//             Dr Suspense                    other debit adjustments
//             Cr Suspense                    credit adjustments
//             Cr Razorpay Clearing           whatever balances the voucher
//
// Together the two credit Razorpay Clearing by exactly the gross of the settled payments, which is what
// the sales debited, so the clearing ledger returns to zero. Every voucher balances to the paise; a
// voucher that does not is a bug here and throws rather than reaching a spreadsheet.
import { JOURNAL_ACCOUNTS } from '@ziro/core/domain';
import { z } from 'zod';
import { plainRupees } from './csv.js';

export type JournalAccount = (typeof JOURNAL_ACCOUNTS)[number];
export type LedgerNames = Readonly<Record<JournalAccount, string>>;

export const DEFAULT_LEDGER_NAMES: LedgerNames = {
  RAZORPAY_CLEARING: 'Razorpay Clearing',
  BANK: 'Bank Account',
  SALES: 'Sales',
  REFUNDS: 'Refunds',
  PAYMENT_GATEWAY_FEES: 'Payment Gateway Charges',
  GST_INPUT_CREDIT: 'GST Input Credit',
  CHARGEBACK_LOSS: 'Chargeback Loss',
  SUSPENSE: 'Suspense',
};

const ledgerNamesSchema = z.partialRecord(
  z.enum(JOURNAL_ACCOUNTS),
  z.string().trim().min(1).max(100),
);

/** The default names with any the run's config overrides (`config.ledgerNames`). */
export function ledgerNamesOf(runConfig: unknown): LedgerNames {
  const stored = (runConfig as { ledgerNames?: unknown } | null)?.ledgerNames;
  const parsed = ledgerNamesSchema.safeParse(stored);
  return parsed.success ? { ...DEFAULT_LEDGER_NAMES, ...parsed.data } : DEFAULT_LEDGER_NAMES;
}

export type VoucherType = 'Receipt' | 'Journal';
export interface Leg {
  readonly ledger: string;
  readonly paise: bigint;
}
export interface Voucher {
  readonly no: string;
  readonly type: VoucherType;
  /** ISO date, YYYY-MM-DD. */
  readonly date: string;
  readonly narration: string;
  /** Every record the voucher rests on: Razorpay ids, the bank statement row, a proposal id. */
  readonly recordIds: readonly string[];
  /** What the voucher is about: a settlement, or an approved agent adjustment. */
  readonly source: 'settlement' | 'agent adjustment';
  readonly debits: readonly Leg[];
  readonly credits: readonly Leg[];
}

const NARRATION_MAX = 250;
const IDS_IN_NARRATION = 4;

const clip = (text: string): string =>
  text.length <= NARRATION_MAX ? text : `${text.slice(0, NARRATION_MAX - 3)}...`;
const few = (ids: readonly string[]): string =>
  ids.length === 0
    ? 'none'
    : ids.length <= IDS_IN_NARRATION
      ? ids.join(', ')
      : `${ids.slice(0, IDS_IN_NARRATION).join(', ')} +${ids.length - IDS_IN_NARRATION} more`;

const total = (legs: readonly Leg[]): bigint => legs.reduce((sum, l) => sum + l.paise, 0n);

function balanced(voucher: Voucher): Voucher {
  const dr = total(voucher.debits);
  const cr = total(voucher.credits);
  if (dr !== cr) {
    throw new Error(
      `voucher ${voucher.no} does not balance: debits ${dr} paise, credits ${cr} paise`,
    );
  }
  if ([...voucher.debits, ...voucher.credits].some((l) => l.paise <= 0n)) {
    throw new Error(`voucher ${voucher.no} has a leg that is not a positive amount`);
  }
  return voucher;
}

const leg = (ledger: string, amount: bigint): Leg[] =>
  amount > 0n ? [{ ledger, paise: amount }] : [];

/** A bank-confirmed settlement and what it is made of, from the one composition the matcher uses. */
export interface SettlementBooking {
  readonly rzpId: string;
  readonly utr: string | null;
  readonly bankRef: string;
  /** The bank credit's value date: when the money actually moved. */
  readonly bankDate: string;
  /** The net payout (= the bank credit = gross − fees − refunds ± adjustments). */
  readonly netPaise: bigint;
  /** Σ fees INCLUDING GST. */
  readonly feesPaise: bigint;
  /** The GST inside `feesPaise`. */
  readonly gstPaise: bigint;
  readonly refundsPaise: bigint;
  readonly chargebackPaise: bigint;
  readonly otherDebitPaise: bigint;
  readonly creditAdjustmentsPaise: bigint;
  readonly paymentIds: readonly string[];
  readonly refundIds: readonly string[];
  readonly adjustmentIds: readonly string[];
}

export function settlementVouchers(b: SettlementBooking, names: LedgerNames): Voucher[] {
  const clearing = names.RAZORPAY_CLEARING;
  const recordIds = [
    b.rzpId,
    `bank:${b.bankRef}`,
    ...b.paymentIds,
    ...b.refundIds,
    ...b.adjustmentIds,
  ];
  const utr = b.utr === null ? '' : ` (UTR ${b.utr})`;

  const receipt = balanced({
    no: `ZIRO-${b.rzpId}-R`,
    type: 'Receipt',
    date: b.bankDate,
    narration: clip(
      `Razorpay settlement ${b.rzpId}${utr} received in bank, statement row ${b.bankRef}: ` +
        `${b.paymentIds.length} payments, ${b.refundIds.length} refunds, ${b.adjustmentIds.length} adjustments`,
    ),
    recordIds,
    source: 'settlement',
    debits: leg(names.BANK, b.netPaise),
    credits: leg(clearing, b.netPaise),
  });

  const debits: Leg[] = [
    ...leg(names.PAYMENT_GATEWAY_FEES, b.feesPaise - b.gstPaise),
    ...leg(names.GST_INPUT_CREDIT, b.gstPaise),
    ...leg(names.REFUNDS, b.refundsPaise),
    ...leg(names.CHARGEBACK_LOSS, b.chargebackPaise),
    ...leg(names.SUSPENSE, b.otherDebitPaise),
  ];
  const credits: Leg[] = leg(names.SUSPENSE, b.creditAdjustmentsPaise);
  const plug = total(debits) - total(credits);
  if (plug > 0n) credits.push({ ledger: clearing, paise: plug });
  else if (plug < 0n) debits.push({ ledger: clearing, paise: -plug });
  if (debits.length === 0 && credits.length === 0) return [receipt];

  const journal = balanced({
    no: `ZIRO-${b.rzpId}-J`,
    type: 'Journal',
    date: b.bankDate,
    narration: clip(
      `Fees, GST on fees, refunds and adjustments netted in Razorpay settlement ${b.rzpId}: ` +
        `payments ${few(b.paymentIds)}; refunds ${few(b.refundIds)}; adjustments ${few(b.adjustmentIds)}`,
    ),
    recordIds,
    source: 'settlement',
    debits,
    credits,
  });
  return [receipt, journal];
}

// --- agent adjustments, once a person has approved them -----------------------------------------------

/** How the agent's draft entry is stored: integer paise as digit strings. */
export const storedEntrySchema = z.object({
  memo: z.string(),
  lines: z.array(
    z.object({
      account: z.enum(JOURNAL_ACCOUNTS),
      debit: z.string().regex(/^\d+$/),
      credit: z.string().regex(/^\d+$/),
    }),
  ),
});

export interface ApprovedDraft {
  readonly proposalId: string;
  readonly exceptionId: string;
  readonly about: string;
  readonly reviewer: string;
  /** The IST date the person approved it. */
  readonly date: string;
  readonly entry: z.output<typeof storedEntrySchema>;
}

export function adjustmentVoucher(d: ApprovedDraft, names: LedgerNames): Voucher {
  const debits: Leg[] = [];
  const credits: Leg[] = [];
  for (const line of d.entry.lines) {
    debits.push(...leg(names[line.account], BigInt(line.debit)));
    credits.push(...leg(names[line.account], BigInt(line.credit)));
  }
  return balanced({
    no: `ZIRO-ADJ-${d.proposalId.slice(0, 8)}`,
    type: 'Journal',
    date: d.date,
    narration: clip(`${d.entry.memo} (${d.about}; approved by ${d.reviewer})`),
    recordIds: [d.about, `proposal:${d.proposalId}`, `exception:${d.exceptionId}`],
    source: 'agent adjustment',
    debits,
    credits,
  });
}

// --- the two CSV shapes ---------------------------------------------------------------------------------

export const PAIR_HEADER = [
  'date',
  'voucher_type',
  'voucher_no',
  'debit_ledger',
  'credit_ledger',
  'amount',
  'narration',
  'record_ids',
  'source',
] as const;

/** One row per debit/credit pair; a voucher with several legs on a side becomes several rows. */
export function pairRows(v: Voucher): string[][] {
  const rows: string[][] = [];
  const debits = v.debits.map((l) => ({ ...l }));
  const credits = v.credits.map((l) => ({ ...l }));
  let d = 0;
  let c = 0;
  while (d < debits.length && c < credits.length) {
    const dr = debits[d];
    const cr = credits[c];
    if (dr === undefined || cr === undefined) break;
    const amount = dr.paise < cr.paise ? dr.paise : cr.paise;
    rows.push([
      v.date,
      v.type,
      v.no,
      dr.ledger,
      cr.ledger,
      plainRupees(amount),
      v.narration,
      v.recordIds.join(';'),
      v.source,
    ]);
    dr.paise -= amount;
    cr.paise -= amount;
    if (dr.paise === 0n) d += 1;
    if (cr.paise === 0n) c += 1;
  }
  return rows;
}

export const LINE_HEADER = [
  'voucher_no',
  'date',
  'voucher_type',
  'ledger',
  'dr_cr',
  'amount',
  'narration',
  'record_ids',
] as const;

/** One row per ledger line: the layout TallyPrime's "Import Data from Excel" maps column by column. */
export function lineRows(v: Voucher): string[][] {
  const row = (l: Leg, side: 'Dr' | 'Cr') => [
    v.no,
    v.date,
    v.type,
    l.ledger,
    side,
    plainRupees(l.paise),
    v.narration,
    v.recordIds.join(';'),
  ];
  return [...v.debits.map((l) => row(l, 'Dr')), ...v.credits.map((l) => row(l, 'Cr'))];
}
