// T2, T3 and T4: Razorpay settlements <-> the bank.
//
//   T2  settlement <-> its payments: the recon lines must add up to the settlement to the paise
//       (composeSettlement). This is a verdict, not a group (ADR-005): only a verified settlement
//       goes on to T3 and T4.
//   T3  a verified settlement and a bank credit with the same UTR and the same amount.
//   T4  no usable UTR: equal amount, value date in [settlement date, +N business days], and exactly
//       one candidate on BOTH sides.
//
// Anything else is an exception with the candidates attached. A UTR that points one way while the
// amount points another is never resolved by choosing.
import {
  ReasonCode,
  type BankLine,
  type RzpSettlement,
  type SettlementItem,
} from '../domain/index.js';
import { extractUtr } from '../normalize/index.js';
import { paise } from '../money/index.js';
import { addBusinessDays, addDaysToBusinessDate } from '../time/index.js';
import { composeSettlement, isVerified, type SettlementComposition } from './composition.js';
import { addException, addGroup, addIgnored, byId, type MatchState, pushTo } from './state.js';
import {
  type MatcherConfig,
  type MatcherInput,
  type PayoutEvidence,
  ref,
  RULE_IDS,
} from './types.js';

const CHARGEBACK = /charge\s*back|dispute/i;

/**
 * A debit adjustment (or transfer) whose description names a chargeback or dispute. The one definition:
 * the rule matcher labels a settlement CHARGEBACK_ADJUSTMENT with it and the books book the line to the
 * chargeback ledger with it, so the two cannot disagree.
 */
export const isChargebackLine = (
  item: Pick<SettlementItem, 'itemType' | 'debit' | 'description'>,
): boolean =>
  (item.itemType === 'adjustment' || item.itemType === 'transfer') &&
  item.debit > 0n &&
  CHARGEBACK.test(item.description ?? '');

const NON_TRANSFER_CHANNELS = new Set(['upi', 'ach', 'cheque']);
const TRUSTED_UTR = new Set(['exact', 'rejoined']);

const settlementRef = (s: RzpSettlement) => ref('rzp_settlement', s.id);
const bankRef = (b: BankLine) => ref('bank_line', b.id);

/** A settlement's UTR as the bank would print it: upper case, letters and digits only. */
export function settlementUtrKey(settlement: RzpSettlement): string | null {
  const key = settlement.utr?.toUpperCase().replace(/[^A-Z0-9]/g, '') ?? '';
  return key.length >= 10 ? key : null;
}

/** Bank credits of one amount in date order, searchable by date. */
class CreditIndex {
  private readonly byAmount = new Map<bigint, BankLine[]>();

  constructor(credits: readonly BankLine[]) {
    for (const credit of [...credits].sort((a, b) =>
      a.valueDate < b.valueDate ? -1 : a.valueDate > b.valueDate ? 1 : byId(a, b),
    )) {
      pushTo(this.byAmount, credit.amount, credit);
    }
  }

  /** Credits of exactly `amount` with a value date in [from, to]. */
  find(amount: bigint, from: string, to: string, accept: (b: BankLine) => boolean): BankLine[] {
    const list = this.byAmount.get(amount);
    if (list === undefined) return [];
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((list[mid] as BankLine).valueDate < from) low = mid + 1;
      else high = mid;
    }
    const found: BankLine[] = [];
    for (let i = low; i < list.length; i++) {
      const credit = list[i] as BankLine;
      if (credit.valueDate > to) break;
      if (accept(credit)) found.push(credit);
    }
    return found;
  }
}

/** A credit whose UTR cannot confirm anything: missing, or only a repair or a fragment. */
export const utrIsWeak = (b: BankLine): boolean =>
  b.utr === null || !TRUSTED_UTR.has(b.utrQuality ?? '');

function payoutReason(
  settlement: RzpSettlement,
  composition: SettlementComposition,
  items: readonly SettlementItem[],
  paymentDate: (paymentId: string) => string | undefined,
  config: MatcherConfig,
): ReasonCode | null {
  // The line's description is only a label hint; the amounts are what reconcile.
  const chargeback = items.some(isChargebackLine);
  if (chargeback) return ReasonCode.CHARGEBACK_ADJUSTMENT;

  const captured = composition.paymentIds
    .map(paymentDate)
    .filter((d): d is string => d !== undefined);
  if (settlementCreatedLate(settlement.businessDate, captured, config)) {
    return ReasonCode.SETTLEMENT_DELAYED;
  }
  return null;
}

/**
 * Razorpay created the settlement later than its payments' latest capture date plus the normal lag.
 * One of the two meanings of SETTLEMENT_DELAYED (the other is a bank credit past the window); the
 * verifier asks this same question, so a rule's label and a verifier's check cannot drift apart.
 */
export function settlementCreatedLate(
  settlementDate: string,
  paymentDates: readonly string[],
  config: Pick<MatcherConfig, 'settlementLagBusinessDays' | 'calendar'>,
): boolean {
  const latest = [...paymentDates].sort().at(-1);
  if (latest === undefined) return false;
  return (
    settlementDate > addBusinessDays(latest, config.settlementLagBusinessDays, config.calendar)
  );
}

export function matchPayouts(input: MatcherInput, config: MatcherConfig, state: MatchState): void {
  const { calendar } = config;
  const paymentByRzp = new Map(input.payments.map((p) => [p.paymentId, p]));
  const refundByRzp = new Map(input.refunds.map((r) => [r.refundId, r]));
  const itemsBySettlement = new Map<string, SettlementItem[]>();
  for (const item of input.settlementItems) pushTo(itemsBySettlement, item.settlementId, item);
  const lookups = {
    payment: (id: string) => paymentByRzp.get(id),
    refund: (id: string) => refundByRzp.get(id),
  };
  const paymentDate = (id: string) => paymentByRzp.get(id)?.businessDate;

  // --- which bank lines could be a Razorpay settlement at all -----------------------------------
  const credits: BankLine[] = [];
  for (const line of input.bankLines) {
    if (line.direction === 'debit') {
      addIgnored(state, bankRef(line), 'bank_debit');
    } else if (NON_TRANSFER_CHANNELS.has(extractUtr(line.narration).channel ?? '')) {
      // Razorpay pays out by NEFT, RTGS or IMPS; a UPI, direct-debit or cheque credit is not one.
      addIgnored(state, bankRef(line), 'credit_not_a_settlement_channel');
    } else {
      credits.push(line);
    }
  }
  const index = new CreditIndex(credits);
  const creditById = new Map(credits.map((c) => [c.id, c]));
  const taken = new Set<string>(); // credits that are matched or already carry an exception

  // --- T2: does each settlement add up? ---------------------------------------------------------
  const compositions = new Map<string, SettlementComposition>();
  const verified: RzpSettlement[] = [];
  const windowEnds = new Map<string, string>();
  const windowEnd = (date: string): string => {
    let end = windowEnds.get(date);
    if (end === undefined) {
      end = addBusinessDays(date, config.windowBusinessDays, calendar);
      windowEnds.set(date, end);
    }
    return end;
  };

  for (const settlement of [...input.settlements].sort(byId)) {
    const items = itemsBySettlement.get(settlement.settlementId) ?? [];
    const composition = composeSettlement(settlement, items, lookups);
    compositions.set(settlement.id, composition);
    const ok = isVerified(composition);
    state.verdicts.push({
      settlement: settlementRef(settlement),
      ruleId: RULE_IDS.T2,
      verified: ok,
      composition,
    });
    if (ok) {
      verified.push(settlement);
    } else {
      const context = index.find(
        settlement.amount,
        settlement.businessDate,
        windowEnd(settlement.businessDate),
        () => true,
      );
      const balanced = composition.residual === 0n;
      addException(state, {
        reasonCode: ReasonCode.UNKNOWN,
        subject: settlementRef(settlement),
        candidates: context.map(bankRef),
        amountAtStake: composition.residual,
        cause: balanced ? 'composition_inconsistent' : 'composition_unbalanced',
        note: balanced
          ? 'the recon lines add up, but a line contradicts its payment or refund record'
          : `the recon lines are ${composition.residual} paise away from the settlement amount`,
      });
    }
  }

  const groupPayout = (tier: 'T3' | 'T4', settlement: RzpSettlement, bank: BankLine): void => {
    const composition = compositions.get(settlement.id) as SettlementComposition;
    const evidence: PayoutEvidence = {
      settlementAmount: settlement.amount,
      bankAmount: bank.amount,
      composition,
    };
    addGroup(state, {
      kind: 'payout',
      tier,
      ruleId: tier === 'T3' ? RULE_IDS.T3 : RULE_IDS.T4,
      reasonCode: payoutReason(
        settlement,
        composition,
        itemsBySettlement.get(settlement.settlementId) ?? [],
        paymentDate,
        config,
      ),
      residual: paise(bank.amount - settlement.amount),
      members: [settlementRef(settlement), bankRef(bank)],
      evidence,
    });
    taken.add(bank.id);
  };

  // --- T3: UTR and amount -------------------------------------------------------------------------
  const settlementsByUtr = new Map<string, RzpSettlement[]>();
  for (const settlement of verified) {
    const key = settlementUtrKey(settlement);
    if (key !== null) pushTo(settlementsByUtr, key, settlement);
  }
  const banksByUtr = new Map<string, BankLine[]>();
  for (const bank of credits) {
    if (bank.utr !== null && TRUSTED_UTR.has(bank.utrQuality ?? '')) {
      pushTo(banksByUtr, bank.utr.toUpperCase(), bank);
    }
  }

  const decided = new Set<string>(); // settlements T3 matched or excepted
  for (const utr of [...settlementsByUtr.keys()].sort()) {
    const settlements = settlementsByUtr.get(utr) ?? [];
    const banks = banksByUtr.get(utr) ?? [];
    if (banks.length === 0) continue; // no credit carries this UTR: T4 may still find it

    const only = settlements.length === 1 && banks.length === 1;
    const settlement = settlements[0] as RzpSettlement;
    const bank = banks[0] as BankLine;
    if (only && settlement.amount === bank.amount) {
      groupPayout('T3', settlement, bank);
      decided.add(settlement.id);
      continue;
    }
    const everyone = [...settlements.map(settlementRef), ...banks.map(bankRef)];
    const cause = only ? 'utr_amount_differs' : 'utr_ambiguous';
    const note = only
      ? `the UTR matches but the amounts differ (${settlement.amount} against ${bank.amount} paise)`
      : `${settlements.length} settlements and ${banks.length} bank credits share this UTR`;
    for (const s of settlements) {
      addException(state, {
        reasonCode: ReasonCode.UNKNOWN,
        subject: settlementRef(s),
        candidates: everyone,
        amountAtStake: only ? s.amount - bank.amount : s.amount,
        cause,
        note,
      });
      decided.add(s.id);
    }
    for (const b of banks) {
      addException(state, {
        reasonCode: ReasonCode.UNKNOWN,
        subject: bankRef(b),
        candidates: everyone,
        amountAtStake: only ? b.amount - settlement.amount : b.amount,
        cause,
        note,
      });
      taken.add(b.id);
    }
  }

  // --- T4: amount, window, and exactly one candidate on each side ------------------------------------
  const pool = verified.filter((s) => !decided.has(s.id));
  const candidatesOf = new Map<string, BankLine[]>();
  const settlementsOf = new Map<string, RzpSettlement[]>();
  for (const settlement of pool) {
    const found = index.find(
      settlement.amount,
      settlement.businessDate,
      windowEnd(settlement.businessDate),
      (b) => !taken.has(b.id),
    );
    candidatesOf.set(settlement.id, found);
    for (const bank of found) pushTo(settlementsOf, bank.id, settlement);
  }

  const matchedBanks = new Set<string>();
  const unresolved: RzpSettlement[] = [];
  for (const settlement of pool) {
    const found = candidatesOf.get(settlement.id) ?? [];
    const bank = found[0];
    if (
      found.length === 1 &&
      bank !== undefined &&
      (settlementsOf.get(bank.id) ?? []).length === 1
    ) {
      groupPayout('T4', settlement, bank);
      matchedBanks.add(bank.id);
    } else if (found.length === 0) {
      unresolved.push(settlement);
    } else {
      const weak = settlementUtrKey(settlement) === null || found.some(utrIsWeak);
      addException(state, {
        reasonCode: weak ? ReasonCode.UTR_MISSING_OR_GARBLED : ReasonCode.UNKNOWN,
        subject: settlementRef(settlement),
        candidates: found.map(bankRef),
        amountAtStake: settlement.amount,
        cause: 'window_ambiguous',
        note: `${found.length} bank credits of exactly this amount fall in the window and the UTR cannot choose between them`,
      });
    }
  }
  // Credits that were candidates of an ambiguous settlement stay unmatched, each with its rivals.
  for (const [bankId, rivals] of [...settlementsOf.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    if (matchedBanks.has(bankId)) continue;
    const bank = creditById.get(bankId) as BankLine;
    addException(state, {
      reasonCode: utrIsWeak(bank) ? ReasonCode.UTR_MISSING_OR_GARBLED : ReasonCode.UNKNOWN,
      subject: bankRef(bank),
      candidates: rivals.map(settlementRef),
      amountAtStake: bank.amount,
      cause: 'window_ambiguous',
      note: `${rivals.length} settlements of exactly this amount could have landed as this credit`,
    });
    taken.add(bank.id);
  }

  // --- settlements with no credit in the window: late, or missing -------------------------------------
  const lateCandidates = new Map<string, BankLine[]>();
  const lateRivals = new Map<string, RzpSettlement[]>();
  for (const settlement of unresolved) {
    const end = windowEnd(settlement.businessDate);
    const horizon = addBusinessDays(end, config.delayHorizonBusinessDays, calendar);
    const after = index.find(
      settlement.amount,
      addDaysToBusinessDate(end, 1),
      horizon,
      (b) => !taken.has(b.id),
    );
    lateCandidates.set(settlement.id, after);
    for (const bank of after) pushTo(lateRivals, bank.id, settlement);
  }
  const lateBanks = new Set<string>();
  for (const settlement of unresolved) {
    const after = lateCandidates.get(settlement.id) ?? [];
    const bank = after[0];
    const clean =
      after.length === 1 && bank !== undefined && (lateRivals.get(bank.id) ?? []).length === 1;
    addException(state, {
      reasonCode: clean ? ReasonCode.SETTLEMENT_DELAYED : ReasonCode.UNKNOWN,
      subject: settlementRef(settlement),
      candidates: after.map(bankRef),
      amountAtStake: settlement.amount,
      cause: after.length === 0 ? 'no_bank_credit' : 'bank_credit_outside_window',
      note:
        after.length === 0
          ? 'no bank credit of exactly this amount in or after the window'
          : 'the only credits of exactly this amount arrived after the window',
    });
    if (clean && bank !== undefined) lateBanks.add(bank.id);
  }
  for (const [bankId, rivals] of [...lateRivals.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bank = creditById.get(bankId) as BankLine;
    addException(state, {
      reasonCode: lateBanks.has(bankId) ? ReasonCode.SETTLEMENT_DELAYED : ReasonCode.UNKNOWN,
      subject: bankRef(bank),
      candidates: rivals.map(settlementRef),
      amountAtStake: bank.amount,
      cause: 'bank_credit_outside_window',
      note: 'this credit arrived after the window of a settlement of exactly this amount',
    });
    taken.add(bank.id);
  }

  // --- every other credit that could have been a settlement but explains nothing --------------------
  const settlementsByAmount = new Map<bigint, RzpSettlement[]>();
  for (const settlement of input.settlements)
    pushTo(settlementsByAmount, settlement.amount, settlement);
  for (const bank of credits) {
    if (taken.has(bank.id)) continue;
    addException(state, {
      reasonCode: ReasonCode.UNKNOWN,
      subject: bankRef(bank),
      candidates: (settlementsByAmount.get(bank.amount) ?? []).map(settlementRef),
      amountAtStake: bank.amount,
      cause: 'bank_credit_unexplained',
      note: 'a NEFT, RTGS or IMPS credit that no settlement accounts for',
    });
  }
}
