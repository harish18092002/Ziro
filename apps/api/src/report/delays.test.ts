import { describe, expect, it } from 'vitest';
import { verifierConfigOf } from '../common/verifier-config.js';
import { type DelayConfig, findDelays, type SettlementFacts } from './delays.js';

// Weekends are Saturday and Sunday. 2026-04-06 is a Monday.
const config: DelayConfig = {
  ...verifierConfigOf(undefined).config,
  settlementLagBusinessDays: 2,
  windowBusinessDays: 3,
  delayHorizonBusinessDays: 5,
};

const settlement = (over: Partial<SettlementFacts>): SettlementFacts => ({
  id: 'id-1',
  rzpId: 'setl_1',
  businessDate: '2026-04-08',
  amountPaise: 100_000n,
  paymentDates: ['2026-04-06'],
  creditDate: '2026-04-08',
  ...over,
});

describe('findDelays', () => {
  it('leaves an on-time settlement alone: due Wednesday (T+2), created Wednesday', () => {
    const r = findDelays([settlement({})], config, '2026-04-30');
    expect(r.delayed).toEqual([]);
    expect(r.overdue).toEqual([]);
  });

  it('flags a settlement created after its due date, in business days', () => {
    // Due Wed 04-08; created Mon 04-13: Thu, Fri, Mon = 3 business days late.
    const r = findDelays(
      [settlement({ businessDate: '2026-04-13', creditDate: '2026-04-13' })],
      config,
      '2026-04-30',
    );
    expect(r.delayed).toHaveLength(1);
    expect(r.delayed[0]).toMatchObject({
      rzpId: 'setl_1',
      dueDate: '2026-04-08',
      settlementDate: '2026-04-13',
      createdLate: true,
      creditLate: false,
      businessDaysLate: 3,
    });
  });

  it('reports the due date and days late from the latest payment of a multi-day batch', () => {
    // Payments on Wed 04-01 and Mon 04-06: due two business days after the LATER one, Wed 04-08.
    // Created Mon 04-13, that is Thu, Fri, Mon = 3 business days late (from the earlier date it
    // would have looked 6 days late, due Fri 04-03).
    const r = findDelays(
      [
        settlement({
          paymentDates: ['2026-04-01', '2026-04-06'],
          businessDate: '2026-04-13',
          creditDate: '2026-04-13',
        }),
      ],
      config,
      '2026-04-30',
    );
    expect(r.delayed[0]).toMatchObject({ dueDate: '2026-04-08', businessDaysLate: 3 });
  });

  it('uses the latest payment date, so a batch is due after its last payment', () => {
    const r = findDelays(
      [settlement({ paymentDates: ['2026-04-01', '2026-04-06'], businessDate: '2026-04-08' })],
      config,
      '2026-04-30',
    );
    expect(r.delayed).toEqual([]);
  });

  it('flags a bank credit that lands after the window even when the settlement was on time', () => {
    // Settlement 04-08; window of 3 business days ends Mon 04-13.
    const onTime = findDelays([settlement({ creditDate: '2026-04-13' })], config, '2026-04-30');
    expect(onTime.delayed).toEqual([]);
    const late = findDelays([settlement({ creditDate: '2026-04-14' })], config, '2026-04-30');
    expect(late.delayed[0]).toMatchObject({
      createdLate: false,
      creditLate: true,
      businessDaysLate: 0,
    });
  });

  it('knows nothing about lateness without payment dates, and does not invent a due date', () => {
    const r = findDelays([settlement({ paymentDates: [] })], config, '2026-04-30');
    expect(r.delayed).toEqual([]);
  });

  it('calls a settlement overdue only when no credit has matched and the horizon has passed', () => {
    // Settlement 04-08; window 3 + horizon 5 = 8 business days: expected by Wed 04-20.
    const none = settlement({ creditDate: null });
    expect(findDelays([none], config, '2026-04-20').overdue).toEqual([]);
    const r = findDelays([none], config, '2026-04-23');
    expect(r.overdue).toHaveLength(1);
    expect(r.overdue[0]).toMatchObject({ expectedBy: '2026-04-20', daysOverdue: 3 });
  });

  it('never calls a settlement with a matched credit overdue, however old', () => {
    expect(findDelays([settlement({})], config, '2030-01-01').overdue).toEqual([]);
  });

  it('lists results in a stable order by Razorpay id', () => {
    const r = findDelays(
      [
        settlement({ id: '2', rzpId: 'setl_b', creditDate: null }),
        settlement({ id: '1', rzpId: 'setl_a', creditDate: null }),
      ],
      config,
      '2026-12-31',
    );
    expect(r.overdue.map((o) => o.rzpId)).toEqual(['setl_a', 'setl_b']);
  });
});
