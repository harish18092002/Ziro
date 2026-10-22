// Turns a datagen directory into matcher input by the same road production data takes: the real CSV
// parsers for the ledger and the bank statement, the real SyntheticSource for Razorpay's side. The
// test, the benchmark and (later) the eval all start here, so they measure what production would feed
// the matcher, not a convenient copy of it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BankLine, LedgerEntry } from '@ziro/core/domain';
import { type MatcherConfig, type MatcherInput, matcherConfig } from '@ziro/core/matcher';
import { expandFixedHolidays } from '@ziro/core/time';
import { type PresetName, resolveConfig } from '@ziro/datagen';
import { parseBankCsv, parseLedgerCsv } from '../ingest/csv-files.js';
import { deterministicUuid } from '../razorpay/identity.js';
import { SyntheticSource } from '../razorpay/synthetic.source.js';

export const DATASET_RUN_ID = '00000000-0000-4000-8000-0000000000d1';

export interface DomainDataset {
  readonly input: MatcherInput;
  /** Record id -> `type:key` as truth.json writes it (e.g. `ledger_entry:ORD-100001`, `bank_line:row-7`). */
  readonly truthKey: ReadonlyMap<string, string>;
}

const WHOLE_RANGE = { from: '2000-01-01', to: '2099-12-31' };

export async function loadDomainDataset(
  dir: string,
  runId: string = DATASET_RUN_ID,
): Promise<DomainDataset> {
  const ledgerFile = parseLedgerCsv(readFileSync(join(dir, 'ledger.csv'), 'utf8'));
  const bankFile = parseBankCsv(readFileSync(join(dir, 'bank_statement.csv'), 'utf8'));
  for (const file of [ledgerFile, bankFile]) {
    if (file.fatal.length > 0 || file.errors.length > 0) {
      throw new Error(
        `generated data should import cleanly: ${JSON.stringify(file.fatal.concat(file.errors.map((e) => e.reason)))}`,
      );
    }
  }

  const ledger: LedgerEntry[] = ledgerFile.rows.map((r) => ({
    id: deterministicUuid(runId, 'ledger_entry', r.sourceRef),
    runId,
    source: 'csv',
    sourceRef: r.sourceRef,
    importHash: r.importHash,
    orderRef: r.orderRef,
    amount: r.amount,
    businessDate: r.businessDate,
    customerRef: r.customerRef,
    memo: r.memo,
  }));
  const bankLines: BankLine[] = bankFile.rows.map((r) => ({
    id: deterministicUuid(runId, 'bank_line', r.sourceRef),
    runId,
    source: 'csv',
    sourceRef: r.sourceRef,
    importHash: r.importHash,
    valueDate: r.valueDate,
    direction: r.direction,
    amount: r.amount,
    narration: r.narration,
    utr: r.utr,
    utrQuality: r.utrQuality,
    balance: r.balance,
  }));

  // Razorpay's side straight from the source, whole dataset, each file parsed once.
  const source = new SyntheticSource({ runId, dir });
  const [payments, refunds, settlements, items] = [
    await source.fetchPayments(WHOLE_RANGE),
    await source.fetchRefunds(WHOLE_RANGE),
    await source.fetchSettlements(WHOLE_RANGE),
    await source.fetchAllSettlementRecon(),
  ];
  const input: MatcherInput = {
    ledger,
    bankLines,
    payments: payments.items.map((s) => s.record),
    refunds: refunds.items.map((s) => s.record),
    settlements: settlements.items.map((s) => s.record),
    settlementItems: items.items.map((s) => s.record),
  };

  const truthKey = new Map<string, string>();
  for (const l of ledger) truthKey.set(l.id, `ledger_entry:${l.orderRef}`);
  for (const b of bankLines) truthKey.set(b.id, `bank_line:${b.sourceRef}`);
  for (const p of input.payments) truthKey.set(p.id, `rzp_payment:${p.paymentId}`);
  for (const r of input.refunds) truthKey.set(r.id, `rzp_refund:${r.refundId}`);
  for (const s of input.settlements) truthKey.set(s.id, `rzp_settlement:${s.settlementId}`);
  return { input, truthKey };
}

/**
 * The calendar datagen assumed when it generated a preset: Saturdays and Sundays off, its fixed
 * holidays, and its settlement lag. A real deployment supplies its bank's calendar instead.
 */
export function matcherConfigFor(seed: number, preset: PresetName): MatcherConfig {
  const generated = resolveConfig(seed, preset);
  return matcherConfig({
    calendar: {
      weekendDays: [0, 6],
      holidays: expandFixedHolidays(generated.fixedHolidays, 2020, 2035),
    },
    settlementLagBusinessDays: generated.settlementLagBusinessDays,
  });
}
