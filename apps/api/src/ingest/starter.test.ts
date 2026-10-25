import { describe, expect, it } from 'vitest';
import { parseBankCsv, parseLedgerCsv } from './csv-files.js';
import {
  bankDate,
  buildSimulatedBank,
  buildStarterLedger,
  ledgerDate,
  type StarterPayment,
  type StarterSettlement,
} from './starter.js';

const pay = (over: Partial<StarterPayment> = {}): StarterPayment => ({
  receipt: 'ORD-100001',
  amountPaise: 527_299n,
  currency: 'INR',
  captured: true,
  businessDate: '2026-09-01',
  ...over,
});

describe('date layouts', () => {
  it('writes the ledger and the bank statement each in the layout their importer reads', () => {
    expect(ledgerDate('2026-09-01')).toBe('01-09-2026');
    expect(bankDate('2026-09-01')).toBe('01/09/2026');
  });
});

describe('buildStarterLedger', () => {
  it('lists each paid order once, with its receipt, date and amount in rupees', () => {
    const out = buildStarterLedger([pay(), pay({ receipt: 'ORD-100002', amountPaise: 100_000n })]);
    expect(out.rows).toBe(2);
    expect(out.csv.split('\r\n')).toEqual([
      'order_ref,order_date,amount,customer_ref,memo',
      'ORD-100001,01-09-2026,"5,272.99",,',
      'ORD-100002,01-09-2026,"1,000.00",,',
      '',
    ]);
  });

  it('is exactly what the real ledger importer accepts, to the paisa', () => {
    const payments = [
      pay(),
      pay({ receipt: 'ORD-100002', amountPaise: 123_456_789n, businessDate: '2026-09-03' }),
      pay({ receipt: 'ORD-100003', amountPaise: 100n, businessDate: '2026-09-02' }),
    ];
    const parsed = parseLedgerCsv(buildStarterLedger(payments).csv);
    expect(parsed.fatal).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => [r.orderRef, r.businessDate, r.amount])).toEqual([
      ['ORD-100001', '2026-09-01', 527_299n],
      ['ORD-100003', '2026-09-02', 100n],
      ['ORD-100002', '2026-09-03', 123_456_789n],
    ]);
    expect(parsed.controlTotals['totalPaise']).toBe(String(527_299n + 100n + 123_456_789n));
  });

  it('leaves out what is not a paid, rupee, numbered order, and counts each reason', () => {
    const out = buildStarterLedger([
      pay(),
      pay({ receipt: 'ORD-100002', captured: false }),
      pay({ receipt: null }),
      pay({ receipt: '  ' }),
      pay({ receipt: 'ORD-100004', currency: 'USD' }),
    ]);
    expect(out.rows).toBe(1);
    expect(out.skipped).toEqual({
      notCaptured: 1,
      noReceipt: 2,
      otherCurrency: 1,
      repeatOfAnOrder: 0,
    });
  });

  it('keeps a second captured payment for the same order OUT, so it shows up as a duplicate payment', () => {
    const out = buildStarterLedger([
      pay({ businessDate: '2026-09-02' }),
      pay({ businessDate: '2026-09-01' }),
    ]);
    expect(out.rows).toBe(1);
    expect(out.skipped.repeatOfAnOrder).toBe(1);
    expect(out.csv).toContain('ORD-100001,01-09-2026'); // the EARLIER payment is the order's date
  });

  it('is deterministic whatever order the payments arrive in', () => {
    const a = [pay(), pay({ receipt: 'ORD-100002', businessDate: '2026-09-02' })];
    expect(buildStarterLedger([...a].reverse()).csv).toBe(buildStarterLedger(a).csv);
  });

  it('is a header and nothing else for an account with no payments', () => {
    const out = buildStarterLedger([]);
    expect(out.rows).toBe(0);
    expect(out.csv).toBe('order_ref,order_date,amount,customer_ref,memo\r\n');
  });

  it('defuses a receipt that a spreadsheet would run as a formula', () => {
    const out = buildStarterLedger([pay({ receipt: '=HYPERLINK("http://x")' })]);
    expect(out.csv).toContain(`"'=HYPERLINK(""http://x"")"`);
  });
});

const settlement = (over: Partial<StarterSettlement> = {}): StarterSettlement => ({
  utr: 'UTIBN34889755412',
  amountPaise: 551_019n,
  businessDate: '2026-09-03',
  rzpId: 'setl_A',
  ...over,
});

describe('buildSimulatedBank', () => {
  it('writes one credit per settlement with its UTR in a bank-style narration and a running balance', () => {
    const out = buildSimulatedBank([
      settlement({
        rzpId: 'setl_B',
        utr: 'ICICN80128080862',
        amountPaise: 55_429n,
        businessDate: '2026-09-04',
      }),
      settlement(),
    ]);
    expect(out.rows).toBe(2);
    expect(out.csv.split('\r\n')).toEqual([
      'value_date,narration,debit,credit,balance',
      '03/09/2026,NEFT CR-UTIBN34889755412-RAZORPAY SOFTWARE PRIVATE LIMITED,,"5,510.19","5,510.19"',
      '04/09/2026,NEFT CR-ICICN80128080862-RAZORPAY SOFTWARE PRIVATE LIMITED,,554.29,"6,064.48"',
      '',
    ]);
  });

  it('is exactly what the real bank importer accepts: UTRs found, balances chain, credits add up', () => {
    const settlements = [
      settlement(),
      settlement({
        rzpId: 'setl_B',
        utr: 'ICICN80128080862',
        amountPaise: 55_429n,
        businessDate: '2026-09-04',
      }),
      settlement({
        rzpId: 'setl_C',
        utr: 'HDFCN55512345678',
        amountPaise: 1_000_000n,
        businessDate: '2026-09-05',
      }),
    ];
    const parsed = parseBankCsv(buildSimulatedBank(settlements).csv);
    expect(parsed.fatal).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]); // no balance break
    expect(parsed.rows.map((r) => [r.utr, r.utrQuality, r.direction, r.amount])).toEqual([
      ['UTIBN34889755412', 'exact', 'credit', 551_019n],
      ['ICICN80128080862', 'exact', 'credit', 55_429n],
      ['HDFCN55512345678', 'exact', 'credit', 1_000_000n],
    ]);
    expect(parsed.controlTotals['creditsPaise']).toBe(String(551_019n + 55_429n + 1_000_000n));
  });

  it('skips a settlement with no UTR and says how many', () => {
    const out = buildSimulatedBank([
      settlement(),
      settlement({ rzpId: 'setl_B', utr: null }),
      settlement({ rzpId: 'setl_C', utr: ' ' }),
    ]);
    expect(out.rows).toBe(1);
    expect(out.withoutUtr).toBe(2);
  });

  it('is a header and nothing else when there are no settlements', () => {
    const out = buildSimulatedBank([]);
    expect(out.rows).toBe(0);
    expect(out.csv).toBe('value_date,narration,debit,credit,balance\r\n');
  });

  it('is deterministic whatever order the settlements arrive in', () => {
    const a = [
      settlement(),
      settlement({ rzpId: 'setl_B', utr: 'ICICN80128080862', businessDate: '2026-09-04' }),
    ];
    expect(buildSimulatedBank([...a].reverse()).csv).toBe(buildSimulatedBank(a).csv);
  });
});
