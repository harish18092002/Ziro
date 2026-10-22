import { add, type Paise, paise, sub } from '@ziro/core/money';
import { countFor } from '../config.js';
import type { Rng } from '../rng.js';
import { at, compareStrings, maxInt, minInt } from '../util.js';
import { addMember, drawAmount, newAnomaly, type WorldContext } from './orders.js';
import type { SettleResult } from './settle.js';
import {
  type AnomalyRec,
  type BankRec,
  type Label,
  newLabel,
  type SettlementRec,
} from './types.js';

export type UtrVariant = 'clean' | 'truncated' | 'garbled' | 'split' | 'missing';

const TROUBLE_VARIANTS = [
  { value: 'truncated' as const, weight: 30 },
  { value: 'garbled' as const, weight: 30 },
  { value: 'split' as const, weight: 15 },
  { value: 'missing' as const, weight: 25 },
];

/** Characters a human or an OCR step confuses; garbling swaps within these pairs. */
const CONFUSABLE: Readonly<Record<string, string>> = {
  O: '0',
  '0': 'O',
  I: '1',
  '1': 'I',
  S: '5',
  '5': 'S',
  B: '8',
  '8': 'B',
};

const NAMES = [
  'ACME TRADERS',
  'SHREE KRISHNA STORES',
  'BLUE LOTUS TEXTILES',
  'NOVA LOGISTICS',
  'GREEN LEAF FOODS',
  'MEHTA AND SONS',
  'KAVERI ENTERPRISES',
  'ORBIT COURIERS',
];
const BANKS = ['HDFC', 'ICIC', 'SBIN', 'UTIB', 'KKBK', 'YESB'];

const DEBIT_TIERS = [
  { value: [500, 5000] as const, weight: 6 },
  { value: [5000, 50_000] as const, weight: 3 },
  { value: [50_000, 200_000] as const, weight: 1 },
];

/** How a settlement UTR appears in the narration after the bank (or its export) has mangled it. */
export function degradeUtr(
  rng: Rng,
  utr: string,
  variant: Exclude<UtrVariant, 'clean'>,
): string | null {
  switch (variant) {
    case 'missing':
      return null;
    case 'truncated':
      return utr.slice(0, utr.length - rng.int(3, 6));
    case 'split': {
      const cut = rng.int(5, 11);
      return `${utr.slice(0, cut)} ${utr.slice(cut)}`;
    }
    case 'garbled': {
      const chars = [...utr];
      const positions = chars.flatMap((ch, i) => (CONFUSABLE[ch] === undefined ? [] : [i]));
      if (positions.length > 0) {
        const wanted = positions.length > 1 && rng.chance(4000) ? 2 : 1;
        for (const index of rng.shuffle([...positions]).slice(0, wanted)) {
          chars[index] = CONFUSABLE[chars[index] as string] as string;
        }
      } else {
        // No confusable character: transpose the first adjacent pair that differs.
        for (let i = 4; i + 1 < chars.length; i++) {
          if (chars[i] !== chars[i + 1]) {
            [chars[i], chars[i + 1]] = [chars[i + 1] as string, chars[i] as string];
            break;
          }
        }
      }
      return chars.join('');
    }
  }
}

function settlementNarration(rng: Rng, settlement: SettlementRec, utrText: string | null): string {
  if (settlement.utr.charAt(4) === 'R') {
    return utrText === null
      ? 'RTGS CR-RAZORPAY SOFTWARE PVT LTD-SETTLEMENT'
      : `RTGS CR-${utrText}-RAZORPAY SOFTWARE PVT LTD-SETTLEMENT`;
  }
  if (rng.chance(8500)) {
    return utrText === null
      ? 'NEFT CR-RAZORPAY SOFTWARE PRIVATE LIMITED'
      : `NEFT CR-${utrText}-RAZORPAY SOFTWARE PRIVATE LIMITED`;
  }
  return utrText === null
    ? `IMPS/P2A/${rng.digits(12)}/RAZORPAY SOFTWARE`
    : `IMPS/P2A/${rng.digits(12)}/${utrText}/RAZORPAY SOFTWARE`;
}

interface Pending {
  readonly day: number;
  readonly seq: number;
  readonly narration: string;
  readonly debit: Paise | null;
  readonly credit: Paise | null;
  readonly settlementId: string | null;
  readonly utrVariant: UtrVariant | null;
  readonly label: Label;
}

export function buildBank(ctx: WorldContext, settle: SettleResult): BankRec[] {
  const { config, startDay, lastDay } = ctx;
  const rng = ctx.rng.fork('bank');
  const pending: Pending[] = [];
  let seq = 0;
  const push = (line: Omit<Pending, 'seq'>): void => {
    pending.push({ ...line, seq });
    seq += 1;
  };

  const settlements = [...settle.settlements].sort(
    (a, b) => a.settleDay - b.settleDay || compareStrings(a.id, b.id),
  );

  // 1. Which settlement credits have a damaged UTR (exact count), and how.
  const troubleWanted = countFor(config.rates.UTR_MISSING_OR_GARBLED, settlements.length);
  const troubleOrder = rng.fork('utr').shuffle(settlements.map((_, i) => i));
  const variantOf = new Map<string, Exclude<UtrVariant, 'clean'>>();
  for (const index of troubleOrder.slice(0, troubleWanted)) {
    variantOf.set(at(settlements, index).id, rng.weighted(TROUBLE_VARIANTS));
  }

  // 2. The settlement credits themselves.
  const utrAnomalies: { anomaly: AnomalyRec; settlementId: string }[] = [];
  for (const settlement of settlements) {
    const variant = variantOf.get(settlement.id);
    const utrText =
      variant === undefined ? settlement.utr : degradeUtr(rng, settlement.utr, variant);
    push({
      day: settlement.bankDay,
      narration: settlementNarration(rng, settlement, utrText),
      debit: null,
      credit: settlement.amount,
      settlementId: settlement.id,
      utrVariant: variant ?? 'clean',
      label: newLabel('settlement_credit', settlement.label.groupId),
    });
    if (variant !== undefined) {
      const anomaly = newAnomaly(ctx, 'UTR_MISSING_OR_GARBLED', {
        settlementId: settlement.id,
        utr: settlement.utr,
        variant,
        narrationUtr: utrText ?? '',
      });
      addMember(anomaly, 'rzp_settlement', settlement.id, 'counterpart_settlement');
      utrAnomalies.push({ anomaly, settlementId: settlement.id });
    }
  }

  // 3. Decoys: an unrelated credit of exactly the same amount, near the real one. Damaged-UTR
  //    settlements come first, because that is when amount-and-date matching has to choose.
  const decoyWanted = countFor(config.bank.decoyBps, settlements.length);
  const decoyOrder = [
    ...troubleOrder.filter((i) => variantOf.has(at(settlements, i).id)),
    ...troubleOrder.filter((i) => !variantOf.has(at(settlements, i).id)),
  ];
  for (const index of decoyOrder.slice(0, decoyWanted)) {
    const settlement = at(settlements, index);
    const day = minInt(lastDay, maxInt(startDay, settlement.bankDay + rng.int(-2, 2)));
    const name = rng.pick(NAMES);
    push({
      day,
      narration: rng.chance(5000)
        ? `NEFT CR-${rng.pick(BANKS)}N${rng.digits(11)}-${name}`
        : `UPI/CR/${rng.digits(12)}/${name}/${rng.pick(BANKS)}`,
      debit: null,
      credit: settlement.amount,
      settlementId: null,
      utrVariant: null,
      label: newLabel('decoy'),
    });
  }

  // 4. Everything else a busy current account holds: customer transfers, vendors, charges.
  const noiseRng = rng.fork('noise');
  const debitPlans: { day: number; narration: string; weight: number }[] = [];
  for (let i = 0; i < config.bank.noiseLines; i++) {
    const day = startDay + noiseRng.int(0, config.days - 1);
    const name = noiseRng.pick(NAMES);
    if (noiseRng.chance(4500)) {
      push({
        day,
        narration: noiseRng.pick([
          `UPI/CR/${noiseRng.digits(12)}/${name}/${noiseRng.pick(BANKS)}`,
          `NEFT CR-${noiseRng.pick(BANKS)}N${noiseRng.digits(11)}-${name}`,
          `IMPS-${noiseRng.digits(12)}-${name}`,
        ]),
        debit: null,
        credit: drawAmount(noiseRng),
        settlementId: null,
        utrVariant: null,
        label: newLabel('noise'),
      });
    } else {
      const [lo, hi] = noiseRng.weighted(
        DEBIT_TIERS.map((t) => ({ value: t.value, weight: t.weight })),
      );
      debitPlans.push({
        day,
        narration: noiseRng.pick([
          `UPI/DR/${noiseRng.digits(12)}/${name}/${noiseRng.pick(BANKS)}`,
          `NEFT DR-${noiseRng.pick(BANKS)}N${noiseRng.digits(11)}-${name}`,
          `ACH D- ${name}-${noiseRng.digits(6)}`,
          `GST PAYMENT CHALLAN ${noiseRng.digits(10)}`,
          'BANK CHARGES - SMS ALERT QTR',
          `CHQ PAID ${noiseRng.digits(6)} ${name}`,
        ]),
        weight: noiseRng.int(lo, hi),
      });
    }
  }

  // The debits' sizes are relative until now. Scale them so that, in total, they are the
  // configured share of everything that came in. Exact integer maths, whole rupees, at least ₹10.
  const income = pending.reduce((total, line) => total + (line.credit ?? 0n), 0n);
  const budget = (income * BigInt(config.bank.debitShareBps)) / 10_000n;
  const totalWeight = BigInt(debitPlans.reduce((total, plan) => total + plan.weight, 0));
  for (const plan of debitPlans) {
    const share = totalWeight === 0n ? 0n : (BigInt(plan.weight) * budget) / totalWeight;
    const rupees = (share / 100n) * 100n;
    push({
      day: plan.day,
      narration: plan.narration,
      debit: paise(rupees < 1000n ? 1000n : rupees),
      credit: null,
      settlementId: null,
      utrVariant: null,
      label: newLabel('noise'),
    });
  }

  // 5. Order the statement and run the balance. A debit larger than the balance is cut down, so
  //    the account never overdraws and every figure stays an exact integer number of paise.
  pending.sort((a, b) => a.day - b.day || a.seq - b.seq);
  let balance = paise(config.bank.openingBalancePaise);
  const rows: BankRec[] = pending.map((line, index) => {
    let { debit } = line;
    if (debit !== null && debit > balance) {
      // A safety net, rare now that debits track income. It never overdraws, and it refuses to
      // paper over a configuration whose opening balance cannot carry the early debits.
      const cut = balance / 2n;
      if (cut < 100n) {
        throw new RangeError(
          'bank balance exhausted: raise bank.openingBalancePaise or lower debitShareBps',
        );
      }
      debit = paise(cut);
    }
    if (line.credit !== null) balance = add(balance, line.credit);
    if (debit !== null) balance = sub(balance, debit);
    if (balance < 0n)
      throw new RangeError('bank balance went negative: raise bank.openingBalancePaise');
    return {
      rowNumber: index + 1,
      day: line.day,
      narration: line.narration,
      debit,
      credit: line.credit,
      balance,
      settlementId: line.settlementId,
      utrVariant: line.utrVariant,
      label: line.label,
    };
  });

  // 6. Link anomalies to their bank rows, and record who is ambiguous with whom.
  const rowBySettlement = new Map<string, BankRec>();
  for (const row of rows) if (row.settlementId !== null) rowBySettlement.set(row.settlementId, row);
  for (const { anomaly, settlementId } of utrAnomalies) {
    const row = rowBySettlement.get(settlementId);
    if (row) addMember(anomaly, 'bank_line', `row-${row.rowNumber}`, 'garbled_credit');
  }
  for (const [settlementId, anomaly] of settle.delayed) {
    const row = rowBySettlement.get(settlementId);
    if (row) addMember(anomaly, 'bank_line', `row-${row.rowNumber}`, 'delayed_credit');
  }

  const creditsByAmount = new Map<bigint, BankRec[]>();
  for (const row of rows) {
    if (row.credit === null) continue;
    const list = creditsByAmount.get(row.credit);
    if (list) list.push(row);
    else creditsByAmount.set(row.credit, [row]);
  }
  for (const list of creditsByAmount.values()) {
    if (list.length < 2) continue;
    for (const row of list) {
      row.label.ambiguousWith = list
        .filter((other) => other !== row && other.day - row.day <= 3 && row.day - other.day <= 3)
        .map((other) => `row-${other.rowNumber}`);
    }
  }
  return rows;
}
