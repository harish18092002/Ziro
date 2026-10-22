import { describe, expect, it } from 'vitest';
import type { BankLine } from '../domain/index.js';
import {
  credit,
  debit,
  emptyInput,
  payment,
  refund,
  settlementOf,
  type BuiltSettlement,
} from './matcher.fixtures.js';
import { paise } from '../money/index.js';
import { runMatcher } from './run.js';
import { matcherConfig, RULE_IDS, type MatcherOutput } from './types.js';

const P = (n: number) => paise(BigInt(n));
const UTR = 'UTIBN34889755412';
const UTR_NARRATION = `NEFT CR-${UTR}-RAZORPAY SOFTWARE PRIVATE LIMITED`;

// 2026-09-04 is a Friday: the T4 window is Fri 4th to Wed 9th (Mon 7, Tue 8, Wed 9 are +1, +2, +3).
const FRIDAY = '2026-09-04';
const pay = (id: string) => payment(id, null, 100_000, { fee: P(2360), tax: P(360) });
const S = (id = 'setl_1', date = FRIDAY, over = {}) =>
  settlementOf(id, date, { payments: [pay(`pay_${id}`)] }, over);
const AMOUNT = 97_640n; // 100000 − 2360

const run = (
  settlements: BuiltSettlement[],
  bankLines: BankLine[],
  config = matcherConfig(),
  extra: Partial<ReturnType<typeof emptyInput>> = {},
): MatcherOutput =>
  runMatcher(
    {
      ...emptyInput(),
      settlements: settlements.map((s) => s.settlement),
      settlementItems: settlements.flatMap((s) => s.items),
      bankLines,
      ...extra,
    },
    config,
  );

const payouts = (out: MatcherOutput) => out.groups.filter((g) => g.kind === 'payout');
const exceptionFor = (out: MatcherOutput, id: string) =>
  out.exceptions.find((e) => e.subject.recordId === id);

describe('T2: a settlement must add up before it can match', () => {
  it('records a verdict with the full breakdown for every settlement', () => {
    const s = S();
    const out = run([s], [credit(AMOUNT, FRIDAY, UTR_NARRATION)]);
    expect(out.verdicts).toMatchObject([
      {
        ruleId: RULE_IDS.T2,
        verified: true,
        settlement: { recordType: 'rzp_settlement', recordId: s.settlement.id },
        composition: { gross: 100_000n, fees: 2360n, tax: 360n, computed: AMOUNT, residual: 0n },
      },
    ]);
    expect(out.stats).toMatchObject({ settlementsVerified: 1, settlementsUnverified: 0 });
  });

  it('refuses to match a settlement that is 1 paisa out, even when a credit matches it exactly', () => {
    const s = S('setl_1', FRIDAY, { amount: P(97_641) });
    const bank = credit(97_641, FRIDAY, UTR_NARRATION);
    const out = run([s], [bank]);

    expect(out.groups).toEqual([]);
    expect(out.verdicts[0]).toMatchObject({ verified: false, composition: { residual: 1n } });
    expect(exceptionFor(out, s.settlement.id)).toMatchObject({
      reasonCode: 'UNKNOWN',
      cause: 'composition_unbalanced',
      amountAtStake: 1n,
      candidates: [{ recordType: 'bank_line', recordId: bank.id }],
    });
    // The credit is real money with nothing to explain it, so it surfaces too.
    expect(exceptionFor(out, bank.id)).toMatchObject({ cause: 'bank_credit_unexplained' });
  });

  it('refuses a settlement whose lines contradict the payment records, even if the total adds up', () => {
    const s = S();
    const disagreeing = { ...pay('pay_setl_1'), fee: P(2361) };
    const out = run([s], [credit(AMOUNT, FRIDAY, UTR_NARRATION)], matcherConfig(), {
      payments: [disagreeing],
    });
    expect(payouts(out)).toEqual([]);
    expect(exceptionFor(out, s.settlement.id)).toMatchObject({
      cause: 'composition_inconsistent',
      amountAtStake: 0n,
    });
  });

  it('does not mind a line whose payment is outside the data (a payment from before the period)', () => {
    const out = run([S()], [credit(AMOUNT, FRIDAY, UTR_NARRATION)]);
    expect(payouts(out)).toHaveLength(1);
  });
});

describe('T3: UTR and amount', () => {
  it('matches a settlement and the credit carrying its UTR, recording tier and rule', () => {
    const s = S();
    const bank = credit(AMOUNT, FRIDAY, UTR_NARRATION);
    const out = run([s], [bank]);
    expect(out.exceptions).toEqual([]);
    expect(payouts(out)).toMatchObject([
      {
        kind: 'payout',
        tier: 'T3',
        ruleId: RULE_IDS.T3,
        residual: 0n,
        members: [
          { recordType: 'rzp_settlement', recordId: s.settlement.id },
          { recordType: 'bank_line', recordId: bank.id },
        ],
        evidence: { settlementAmount: AMOUNT, bankAmount: AMOUNT, composition: { residual: 0n } },
      },
    ]);
  });

  it('has no date condition: a credit three weeks late with the right UTR still matches', () => {
    const out = run([S()], [credit(AMOUNT, '2026-09-25', UTR_NARRATION)]);
    expect(payouts(out)).toMatchObject([{ tier: 'T3' }]);
  });

  it('reads the settlement`s UTR the way the bank prints it', () => {
    const s = S('setl_1', FRIDAY, { utr: 'utibn-3488 9755412' });
    const out = run([s], [credit(AMOUNT, FRIDAY, UTR_NARRATION)]);
    expect(payouts(out)).toMatchObject([{ tier: 'T3' }]);
  });

  it('accepts a UTR that was only split by a space', () => {
    const out = run([S()], [credit(AMOUNT, FRIDAY, 'NEFT CR-UTIBN 34889755412-RAZORPAY SOFTWARE')]);
    expect(payouts(out)).toMatchObject([{ tier: 'T3' }]);
  });

  it.each([
    ['repaired', 'NEFT CR-UT1BN34889755412-RAZORPAY SOFTWARE'],
    ['truncated', 'NEFT CR-UTIBN348897-RAZORPAY SOFTWARE'],
  ])('does not take a %s UTR as proof: that credit can only match at T4', (_q, narration) => {
    const out = run([S()], [credit(AMOUNT, FRIDAY, narration)]);
    expect(payouts(out)).toMatchObject([{ tier: 'T4', ruleId: RULE_IDS.T4 }]);
  });

  it('a UTR hit with a different amount is an exception, and is not then matched by amount', () => {
    const s = S();
    const wrong = credit(97_641, FRIDAY, UTR_NARRATION);
    const lookalike = credit(AMOUNT, FRIDAY); // equal amount, no UTR, same day
    const out = run([s], [wrong, lookalike]);

    expect(out.groups).toEqual([]);
    expect(exceptionFor(out, s.settlement.id)).toMatchObject({
      cause: 'utr_amount_differs',
      amountAtStake: -1n,
      candidates: [{ recordId: wrong.id }],
    });
    expect(exceptionFor(out, wrong.id)).toMatchObject({
      cause: 'utr_amount_differs',
      amountAtStake: 1n,
    });
    expect(exceptionFor(out, lookalike.id)).toMatchObject({ cause: 'bank_credit_unexplained' });
  });

  it('two credits carrying one UTR are ambiguous, even if one of them has the right amount', () => {
    const s = S();
    const a = credit(AMOUNT, FRIDAY, UTR_NARRATION);
    const b = credit(1234, FRIDAY, UTR_NARRATION);
    const out = run([s], [a, b]);
    expect(out.groups).toEqual([]);
    expect(out.exceptions.map((e) => e.cause)).toEqual([
      'utr_ambiguous',
      'utr_ambiguous',
      'utr_ambiguous',
    ]);
  });

  it('two settlements claiming one UTR are ambiguous', () => {
    const out = run([S('setl_1'), S('setl_2')], [credit(AMOUNT, FRIDAY, UTR_NARRATION)]);
    expect(out.groups).toEqual([]);
    expect(out.exceptions).toHaveLength(3);
  });

  it('takes T3 matches first, so a leftover settlement can match its own credit at T4', () => {
    const s1 = S('setl_1');
    const s2 = S('setl_2', FRIDAY, { utr: null });
    const b1 = credit(AMOUNT, FRIDAY, UTR_NARRATION);
    const b2 = credit(AMOUNT, FRIDAY);
    const out = run([s1, s2], [b1, b2]);
    expect(out.exceptions).toEqual([]);
    expect(payouts(out).map((g) => [g.tier, g.members.map((m) => m.recordId)])).toEqual([
      ['T3', [s1.settlement.id, b1.id]],
      ['T4', [s2.settlement.id, b2.id]],
    ]);
  });
});

describe('T4: amount, window and exactly one candidate on each side', () => {
  it('matches a unique equal-amount credit inside the window with no UTR at all', () => {
    const s = S();
    const b = credit(AMOUNT, FRIDAY);
    const out = run([s], [b]);
    expect(out.exceptions).toEqual([]);
    expect(payouts(out)).toMatchObject([
      { tier: 'T4', ruleId: RULE_IDS.T4, residual: 0n, reasonCode: null },
    ]);
  });

  describe('the window is [settlement date, +3 business days], weekends skipped', () => {
    it.each([
      ['the settlement date itself', '2026-09-04', true],
      ['the next Monday (+1)', '2026-09-07', true],
      ['Wednesday (+3), the last day', '2026-09-09', true],
      ['Thursday (+4), a day too late', '2026-09-10', false],
      ['the day before the settlement', '2026-09-03', false],
      ['the Saturday just after the settlement', '2026-09-05', true],
    ])('%s -> %s', (_name, date, matches) => {
      const out = run([S()], [credit(AMOUNT, date)]);
      expect(payouts(out).length === 1).toBe(matches);
    });

    it('moves the end when a holiday intervenes', () => {
      const config = matcherConfig({
        calendar: { weekendDays: [0, 6], holidays: new Set(['2026-09-07']) },
      });
      expect(payouts(run([S()], [credit(AMOUNT, '2026-09-10')], config))).toHaveLength(1);
      expect(payouts(run([S()], [credit(AMOUNT, '2026-09-11')], config))).toHaveLength(0);
    });

    it('uses the window the configuration says', () => {
      const config = matcherConfig({ windowBusinessDays: 1 });
      expect(payouts(run([S()], [credit(AMOUNT, '2026-09-07')], config))).toHaveLength(1);
      expect(payouts(run([S()], [credit(AMOUNT, '2026-09-08')], config))).toHaveLength(0);
    });
  });

  it('never matches an amount that is a paisa away', () => {
    for (const off of [1, -1]) {
      const out = run([S()], [credit(AMOUNT + BigInt(off), FRIDAY)]);
      expect(out.groups).toEqual([]);
    }
  });

  describe('ambiguity on the bank side', () => {
    const s = S();
    const a = credit(AMOUNT, '2026-09-04');
    const b = credit(AMOUNT, '2026-09-07');

    it('two equal credits in the window: nothing is matched, all three are exceptions', () => {
      const out = run([s], [a, b]);
      expect(out.groups).toEqual([]);
      expect(out.exceptions).toHaveLength(3);
      expect(exceptionFor(out, s.settlement.id)).toMatchObject({
        cause: 'window_ambiguous',
        candidates: [{ recordId: a.id }, { recordId: b.id }].sort((x, y) =>
          x.recordId < y.recordId ? -1 : 1,
        ),
        amountAtStake: AMOUNT,
      });
      expect(exceptionFor(out, a.id)).toMatchObject({
        cause: 'window_ambiguous',
        candidates: [{ recordType: 'rzp_settlement', recordId: s.settlement.id }],
      });
    });

    it('blames the missing UTR when a candidate has none: UTR_MISSING_OR_GARBLED', () => {
      const out = run([s], [a, b]);
      expect(out.exceptions.map((e) => e.reasonCode)).toEqual([
        'UTR_MISSING_OR_GARBLED',
        'UTR_MISSING_OR_GARBLED',
        'UTR_MISSING_OR_GARBLED',
      ]);
    });

    it('also blames a repaired or truncated UTR, because it proves nothing', () => {
      const repaired = credit(AMOUNT, '2026-09-04', 'NEFT CR-UT1BN34889755412-RAZORPAY SOFTWARE');
      const out = run([s], [repaired, b]);
      expect(exceptionFor(out, s.settlement.id)?.reasonCode).toBe('UTR_MISSING_OR_GARBLED');
      expect(exceptionFor(out, repaired.id)?.reasonCode).toBe('UTR_MISSING_OR_GARBLED');
    });

    it('stays UNKNOWN when every candidate carries a good UTR that is not this settlement`s', () => {
      const x = credit(AMOUNT, '2026-09-04', 'NEFT CR-HDFCN97329733959-RAZORPAY SOFTWARE');
      const y = credit(AMOUNT, '2026-09-07', 'NEFT CR-ICICN80128080862-RAZORPAY SOFTWARE');
      const out = run([s], [x, y]);
      expect(out.exceptions.map((e) => e.reasonCode)).toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    });

    it('the decoy case: the real credit has a damaged UTR and an identical one sits beside it', () => {
      const real = credit(AMOUNT, '2026-09-04', 'NEFT CR-UTIBN348897-RAZORPAY SOFTWARE'); // truncated
      const decoy = credit(AMOUNT, '2026-09-04', 'NEFT CR-GREEN LEAF FOODS');
      const out = run([s], [real, decoy]);
      expect(out.groups).toEqual([]);
      expect(exceptionFor(out, s.settlement.id)?.candidates).toHaveLength(2);
    });
  });

  describe('ambiguity on the settlement side', () => {
    it('two settlements of one amount and one credit: all three are exceptions', () => {
      const s1 = S('setl_1');
      const s2 = S('setl_2', '2026-09-07');
      const b = credit(AMOUNT, '2026-09-07');
      const out = run([s1, s2], [b]);
      expect(out.groups).toEqual([]);
      expect(out.exceptions).toHaveLength(3);
      expect(exceptionFor(out, b.id)).toMatchObject({
        cause: 'window_ambiguous',
        candidates: [
          { recordType: 'rzp_settlement', recordId: s1.settlement.id },
          { recordType: 'rzp_settlement', recordId: s2.settlement.id },
        ],
      });
    });

    it('two settlements and two credits, all alike: nothing is paired, nothing is guessed', () => {
      const out = run([S('setl_1'), S('setl_2')], [credit(AMOUNT, FRIDAY), credit(AMOUNT, FRIDAY)]);
      expect(out.groups).toEqual([]);
      expect(out.exceptions).toHaveLength(4);
    });
  });

  it('counts only credits: a debit and a UPI credit of the same amount are ignored, not rivals', () => {
    const s = S();
    const good = credit(AMOUNT, FRIDAY);
    const out = run(
      [s],
      [
        good,
        debit(Number(AMOUNT), FRIDAY),
        credit(AMOUNT, FRIDAY, 'UPI/CR/865953446985/GREEN LEAF/KKBK'),
      ],
    );
    expect(payouts(out)).toMatchObject([{ tier: 'T4' }]);
    expect(out.ignored.map((i) => i.why).sort()).toEqual([
      'bank_debit',
      'credit_not_a_settlement_channel',
    ]);
    expect(out.exceptions).toEqual([]);
  });
});

describe('a settlement with no credit in its window', () => {
  const s = S();

  it('one equal credit just after the window: SETTLEMENT_DELAYED, offered as a candidate, not matched', () => {
    const late = credit(AMOUNT, '2026-09-14');
    const out = run([s], [late]);
    expect(out.groups).toEqual([]);
    expect(exceptionFor(out, s.settlement.id)).toMatchObject({
      reasonCode: 'SETTLEMENT_DELAYED',
      cause: 'bank_credit_outside_window',
      candidates: [{ recordId: late.id }],
    });
    expect(exceptionFor(out, late.id)).toMatchObject({ reasonCode: 'SETTLEMENT_DELAYED' });
  });

  it('finds a late credit that landed on the weekend straight after the window', () => {
    // Window ends Wed 9th; Saturday the 12th is after it.
    const out = run([s], [credit(AMOUNT, '2026-09-12')]);
    expect(exceptionFor(out, s.settlement.id)?.reasonCode).toBe('SETTLEMENT_DELAYED');
  });

  it('two late credits cannot say which is the settlement: UNKNOWN', () => {
    const out = run([s], [credit(AMOUNT, '2026-09-14'), credit(AMOUNT, '2026-09-15')]);
    expect(exceptionFor(out, s.settlement.id)).toMatchObject({
      reasonCode: 'UNKNOWN',
      cause: 'bank_credit_outside_window',
    });
    expect(out.exceptions.every((e) => e.reasonCode === 'UNKNOWN')).toBe(true);
  });

  it('looks ten business days past the window, no fewer', () => {
    // The window ends Wed 9 Sept; ten business days later is Wed 23 Sept.
    expect(
      exceptionFor(run([s], [credit(AMOUNT, '2026-09-22')]), s.settlement.id)?.reasonCode,
    ).toBe('SETTLEMENT_DELAYED');
    expect(
      exceptionFor(run([s], [credit(AMOUNT, '2026-09-23')]), s.settlement.id)?.reasonCode,
    ).toBe('SETTLEMENT_DELAYED');
    expect(
      exceptionFor(run([s], [credit(AMOUNT, '2026-09-24')]), s.settlement.id)?.reasonCode,
    ).toBe('UNKNOWN');
  });

  it('a credit beyond the look-ahead horizon is not offered', () => {
    const out = run([s], [credit(AMOUNT, '2026-09-24')]);
    expect(exceptionFor(out, s.settlement.id)).toMatchObject({
      reasonCode: 'UNKNOWN',
      cause: 'no_bank_credit',
    });
  });

  it('no credit at all', () => {
    const out = run([s], []);
    expect(out.exceptions).toMatchObject([
      { cause: 'no_bank_credit', amountAtStake: AMOUNT, candidates: [] },
    ]);
  });

  it('a credit nothing explains is an exception of its own', () => {
    const lonely = credit(55_555, FRIDAY);
    const out = run([], [lonely]);
    expect(out.exceptions).toMatchObject([
      {
        subject: { recordId: lonely.id },
        cause: 'bank_credit_unexplained',
        amountAtStake: 55_555n,
      },
    ]);
  });
});

describe('what a payout group is explained by', () => {
  const group = (s: BuiltSettlement, extra: Partial<ReturnType<typeof emptyInput>> = {}) =>
    payouts(
      run(
        [s],
        [credit(s.settlement.amount, s.settlement.businessDate, UTR_NARRATION)],
        matcherConfig(),
        extra,
      ),
    )[0];

  it('a chargeback adjustment is CHARGEBACK_ADJUSTMENT', () => {
    const s = settlementOf('setl_1', FRIDAY, {
      payments: [pay('pay_1')],
      adjustments: [
        { id: 'adj_1', debit: 5000, description: 'Chargeback: dispute disp_1 on pay_1' },
      ],
    });
    expect(group(s)?.reasonCode).toBe('CHARGEBACK_ADJUSTMENT');
  });

  it('only a debit that calls itself a chargeback or dispute counts: the text is a hint, amounts decide', () => {
    const hold = settlementOf('setl_1', FRIDAY, {
      payments: [pay('pay_1')],
      adjustments: [{ id: 'adj_1', debit: 5000, description: 'Reserve hold' }],
    });
    expect(group(hold)?.reasonCode).toBeNull();
    const credited = settlementOf('setl_2', FRIDAY, {
      payments: [pay('pay_2')],
      adjustments: [{ id: 'adj_2', credit: 5000, description: 'Chargeback reversed' }],
    });
    expect(group(credited)?.reasonCode).toBeNull();
    expect(group(hold)?.residual).toBe(0n);
  });

  it('refund lines on their own add no payout code (the order group carries FULL/PARTIAL_REFUND)', () => {
    // Paid Wednesday 2 Sept, so Friday 4 Sept is exactly T+2 and not late.
    const p = payment('pay_1', null, 100_000, {
      fee: P(2360),
      tax: P(360),
      businessDate: '2026-09-02',
    });
    const r = refund('rfnd_1', 'pay_1', 10_000);
    const s = settlementOf('setl_1', FRIDAY, { payments: [p], refunds: [r] });
    expect(group(s, { payments: [p], refunds: [r] })?.reasonCode).toBeNull();
  });

  describe('SETTLEMENT_DELAYED: later than payment date + 2 business days', () => {
    // Paid Tuesday 1 Sept; T+2 is Thursday 3 Sept.
    const paidTuesday = payment('pay_1', null, 100_000, { fee: P(2360), tax: P(360) });
    const settleOn = (date: string) => {
      const s = settlementOf('setl_1', date, { payments: [paidTuesday] });
      return group(s, { payments: [paidTuesday] })?.reasonCode;
    };
    it.each([
      ['on T+2', '2026-09-03', null],
      ['a day late', '2026-09-04', 'SETTLEMENT_DELAYED'],
      ['early', '2026-09-02', null],
    ])('%s', (_name, date, expected) => {
      expect(settleOn(date)).toBe(expected);
    });

    it('counts business days: paid Friday, T+2 is Tuesday', () => {
      const paidFriday = payment('pay_1', null, 100_000, {
        fee: P(2360),
        tax: P(360),
        businessDate: FRIDAY,
      });
      const on = (date: string) =>
        group(settlementOf('setl_1', date, { payments: [paidFriday] }), { payments: [paidFriday] })
          ?.reasonCode;
      expect(on('2026-09-08')).toBeNull();
      expect(on('2026-09-09')).toBe('SETTLEMENT_DELAYED');
    });

    it('a chargeback outranks a delay', () => {
      const s = settlementOf('setl_1', '2026-09-09', {
        payments: [paidTuesday],
        adjustments: [{ id: 'adj_1', debit: 100, description: 'Dispute fee' }],
      });
      expect(group(s, { payments: [paidTuesday] })?.reasonCode).toBe('CHARGEBACK_ADJUSTMENT');
    });
  });
});

describe('payouts: determinism', () => {
  it('gives the same result for reversed input', () => {
    const settlements = [
      S('setl_1'),
      S('setl_2', '2026-09-07', { utr: null }),
      S('setl_3', '2026-09-08', { amount: P(5) }),
    ];
    const banks = [
      credit(AMOUNT, FRIDAY, UTR_NARRATION),
      credit(AMOUNT, '2026-09-07'),
      credit(AMOUNT, '2026-09-08'),
      debit(100, FRIDAY),
    ];
    const forward = run(settlements, banks);
    const backward = run([...settlements].reverse(), [...banks].reverse());
    expect(backward).toEqual(forward);
  });
});
