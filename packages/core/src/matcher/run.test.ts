// Properties of the whole waterfall on randomly generated worlds whose true matches are known by
// construction. Each world is a ledger, payments, refunds, settlements (composed exactly), and a bank
// credit per settlement, some with a clean UTR (T3) and some with none (T4).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { paise } from '../money/index.js';
import { addDaysToBusinessDate } from '../time/index.js';
import {
  credit,
  debit,
  emptyInput,
  ledger,
  payment,
  refund,
  settlementOf,
} from './matcher.fixtures.js';
import { runMatcher } from './run.js';
import type { MatcherInput, MatcherOutput } from './types.js';

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const between = (r: () => number, low: number, high: number): number =>
  low + Math.floor(r() * (high - low + 1));

interface World {
  readonly input: MatcherInput;
  readonly orders: number;
  readonly settlements: number;
}

/**
 * `count` settlements of 1-5 orders each. Settlement k's first payment is in its own million-paise
 * band, so every settlement amount is distinct; even k carry a UTR on the bank credit (T3), odd k
 * do not (T4).
 */
function buildWorld(seed: number, count: number): World {
  const r = random(seed);
  const input = emptyInput();
  let orders = 0;
  for (let k = 0; k < count; k++) {
    const date = addDaysToBusinessDate('2026-09-01', k * 7);
    const payments = [];
    const refunds = [];
    const size = between(r, 1, 5);
    for (let j = 0; j < size; j++) {
      const amount =
        j === 0 ? (k + 1) * 1_000_000 + between(r, 600_000, 900_000) : between(r, 1000, 99_000);
      const fee = BigInt(Math.floor(amount * 0.02));
      const ref = `ORD-${k}-${j}`;
      const p = payment(`pay_${k}_${j}`, ref, amount, {
        fee: paise(fee),
        tax: paise((fee * 18n) / 118n),
        businessDate: date,
      });
      input.ledger.push(ledger(ref, amount));
      input.payments.push(p);
      payments.push(p);
      orders += 1;
    }
    if (r() < 0.4) {
      const first = payments[0];
      if (first !== undefined) {
        refunds.push(refund(`rfnd_${k}`, first.paymentId, between(r, 1, Number(first.amount) - 1)));
      }
    }
    const adjustments =
      r() < 0.3
        ? [{ id: `adj_${k}`, debit: between(r, 1, 5000), description: 'Chargeback: dispute' }]
        : [];
    const utr = `UTIBN${String(10_000_000_000 + k * 7919).padStart(11, '0')}`;
    const built = settlementOf(`setl_${k}`, date, { payments, refunds, adjustments }, { utr });
    input.refunds.push(...refunds);
    input.settlements.push(built.settlement);
    input.settlementItems.push(...built.items);
    const narration =
      k % 2 === 0
        ? `NEFT CR-${utr}-RAZORPAY SOFTWARE PRIVATE LIMITED`
        : 'NEFT CR-RAZORPAY SOFTWARE PRIVATE LIMITED';
    input.bankLines.push(
      credit(built.settlement.amount, addDaysToBusinessDate(date, between(r, 0, 1)), narration),
    );
  }
  input.bankLines.push(
    debit(12_345, '2026-09-02'),
    credit(777_777, '2026-09-03', 'UPI/CR/865953446985/SHOP/KKBK'),
  );
  return { input, orders, settlements: count };
}

const keys = (input: MatcherInput): string[] => [
  ...input.ledger.map((x) => `ledger_entry:${x.id}`),
  ...input.payments.map((x) => `rzp_payment:${x.id}`),
  ...input.refunds.map((x) => `rzp_refund:${x.id}`),
  ...input.settlements.map((x) => `rzp_settlement:${x.id}`),
  ...input.bankLines.map((x) => `bank_line:${x.id}`),
];

const placed = (out: MatcherOutput): string[] => [
  ...out.groups.flatMap((g) => g.members.map((m) => `${m.recordType}:${m.recordId}`)),
  ...out.exceptions.map((e) => `${e.subject.recordType}:${e.subject.recordId}`),
  ...out.ignored.map((i) => `${i.subject.recordType}:${i.subject.recordId}`),
];

const memberIds = (out: MatcherOutput): Set<string> =>
  new Set(out.groups.flatMap((g) => g.members.map((m) => m.recordId)));

function shuffled<T>(items: readonly T[], r: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

/** Breaks a world in a few random ways: lost, altered and duplicated records. */
function damage(input: MatcherInput, seed: number): MatcherInput {
  const r = random(seed);
  let next: MatcherInput = { ...input };
  for (let n = between(r, 1, 4); n > 0; n--) {
    const pick = <T>(list: readonly T[]) => list[between(r, 0, list.length - 1)] as T;
    const choice = between(r, 0, 5);
    // An earlier operation may have emptied the list this one needs; then there is nothing to damage.
    const needs = [
      next.payments,
      next.payments,
      next.bankLines,
      next.bankLines,
      next.ledger,
      next.settlementItems,
    ];
    if ((needs[choice] ?? []).length === 0) continue;
    switch (choice) {
      case 0: {
        const victim = pick(next.payments);
        next = { ...next, payments: next.payments.filter((p) => p !== victim) };
        break;
      }
      case 1: {
        const victim = pick(next.payments);
        const moved = { ...victim, amount: paise(victim.amount + BigInt(between(r, 1, 5))) };
        next = { ...next, payments: next.payments.map((p) => (p === victim ? moved : p)) };
        break;
      }
      case 2: {
        const victim = pick(next.bankLines);
        next = { ...next, bankLines: next.bankLines.filter((b) => b !== victim) };
        break;
      }
      case 3: {
        const victim = pick(next.bankLines);
        next = {
          ...next,
          bankLines: [...next.bankLines, credit(victim.amount, victim.valueDate, victim.narration)],
        };
        break;
      }
      case 4: {
        const victim = pick(next.ledger);
        next = { ...next, ledger: next.ledger.filter((l) => l !== victim) };
        break;
      }
      default: {
        const victim = pick(next.settlementItems);
        next = { ...next, settlementItems: next.settlementItems.filter((i) => i !== victim) };
      }
    }
  }
  return next;
}

const worldArb = fc.record({
  seed: fc.integer({ min: 1, max: 2 ** 30 }),
  count: fc.integer({ min: 1, max: 8 }),
});

describe('a clean world matches completely', () => {
  it('every order and every settlement, with nothing left over, each in the tier its evidence allows', () => {
    fc.assert(
      fc.property(worldArb, ({ seed, count }) => {
        const world = buildWorld(seed, count);
        const out = runMatcher(world.input);

        expect(out.exceptions).toEqual([]);
        expect(out.groups.filter((g) => g.tier === 'T1')).toHaveLength(world.orders);
        const payouts = out.groups.filter((g) => g.kind === 'payout');
        expect(payouts).toHaveLength(world.settlements);
        expect(payouts.filter((g) => g.tier === 'T3')).toHaveLength(Math.ceil(count / 2));
        expect(payouts.filter((g) => g.tier === 'T4')).toHaveLength(Math.floor(count / 2));
        expect(out.stats.settlementsVerified).toBe(count);
      }),
      { numRuns: 150 },
    );
  });
});

describe('every group balances to the paise', () => {
  it('in clean and in damaged worlds alike', () => {
    fc.assert(
      fc.property(worldArb, fc.integer({ min: 1, max: 2 ** 30 }), ({ seed, count }, damageSeed) => {
        const out = runMatcher(damage(buildWorld(seed, count).input, damageSeed));
        const verified = new Set(
          out.verdicts.filter((v) => v.verified).map((v) => v.settlement.recordId),
        );
        for (const g of out.groups) {
          expect(g.residual).toBe(0n);
          if ('ledgerAmount' in g.evidence) {
            expect(g.evidence.ledgerAmount).toBe(g.evidence.paymentAmount);
          } else {
            expect(g.evidence.bankAmount).toBe(g.evidence.settlementAmount);
            expect(g.evidence.composition.residual).toBe(0n);
            expect(g.evidence.composition.computed).toBe(g.evidence.settlementAmount);
            const settlement = g.members.find((m) => m.recordType === 'rzp_settlement');
            expect(verified.has(settlement?.recordId ?? '')).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('every record ends in exactly one place', () => {
  it('a group, an exception or the ignored list, whatever has gone wrong with the data', () => {
    fc.assert(
      fc.property(worldArb, fc.integer({ min: 1, max: 2 ** 30 }), ({ seed, count }, damageSeed) => {
        const input = damage(buildWorld(seed, count).input, damageSeed);
        const out = runMatcher(input);
        expect(placed(out).sort()).toEqual(keys(input).sort());
      }),
      { numRuns: 250 },
    );
  });
});

describe('the result does not depend on the order of the input', () => {
  it('shuffling every list changes nothing', () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.integer({ min: 1, max: 2 ** 30 }),
        ({ seed, count }, shuffleSeed) => {
          const input = damage(buildWorld(seed, count).input, shuffleSeed);
          const r = random(shuffleSeed ^ 0x5bd1e995);
          const mixed: MatcherInput = {
            ledger: shuffled(input.ledger, r),
            payments: shuffled(input.payments, r),
            refunds: shuffled(input.refunds, r),
            settlements: shuffled(input.settlements, r),
            settlementItems: shuffled(input.settlementItems, r),
            bankLines: shuffled(input.bankLines, r),
          };
          expect(runMatcher(mixed)).toEqual(runMatcher(input));
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('zero tolerance: one paisa out is never matched, and nothing else changes', () => {
  it('a ledger amount', () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.integer({ min: 0, max: 99 }),
        fc.boolean(),
        ({ seed, count }, pickAt, up) => {
          const { input } = buildWorld(seed, count);
          const base = runMatcher(input);
          const victim = input.ledger[pickAt % input.ledger.length]!;
          const moved = { ...victim, amount: paise(victim.amount + (up ? 1n : -1n)) };
          const out = runMatcher({
            ...input,
            ledger: input.ledger.map((l) => (l === victim ? moved : l)),
          });

          const touched = out.groups.flatMap((g) => g.members.map((m) => m.recordId));
          expect(touched).not.toContain(victim.id);
          const victimGroup = base.groups.find((g) =>
            g.members.some((m) => m.recordId === victim.id),
          )!;
          expect(out.groups).toEqual(base.groups.filter((g) => g !== victimGroup));
        },
      ),
      { numRuns: 150 },
    );
  });

  it('a bank credit', () => {
    fc.assert(
      fc.property(
        worldArb,
        fc.integer({ min: 0, max: 99 }),
        fc.boolean(),
        ({ seed, count }, pickAt, up) => {
          const { input } = buildWorld(seed, count);
          const base = runMatcher(input);
          const credits = input.bankLines.filter((b) =>
            base.groups.some((g) => g.members.some((m) => m.recordId === b.id)),
          );
          const victim = credits[pickAt % credits.length]!;
          const moved = { ...victim, amount: paise(victim.amount + (up ? 1n : -1n)) };
          const out = runMatcher({
            ...input,
            bankLines: input.bankLines.map((b) => (b === victim ? moved : b)),
          });

          expect(memberIds(out).has(victim.id)).toBe(false);
          const victimGroup = base.groups.find((g) =>
            g.members.some((m) => m.recordId === victim.id),
          )!;
          expect(out.groups).toEqual(base.groups.filter((g) => g !== victimGroup));
          const settlementId = victimGroup.members.find(
            (m) => m.recordType === 'rzp_settlement',
          )!.recordId;
          expect(out.exceptions.some((e) => e.subject.recordId === settlementId)).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('a settlement amount', () => {
    fc.assert(
      fc.property(worldArb, fc.integer({ min: 0, max: 99 }), ({ seed, count }, pickAt) => {
        const { input } = buildWorld(seed, count);
        const base = runMatcher(input);
        const victim = input.settlements[pickAt % input.settlements.length]!;
        const moved = { ...victim, amount: paise(victim.amount + 1n) };
        const out = runMatcher({
          ...input,
          settlements: input.settlements.map((s) => (s === victim ? moved : s)),
        });
        expect(memberIds(out).has(victim.id)).toBe(false);
        expect(out.verdicts.find((v) => v.settlement.recordId === victim.id)).toMatchObject({
          verified: false,
          composition: { residual: 1n },
        });
        const victimGroup = base.groups.find((g) =>
          g.members.some((m) => m.recordId === victim.id),
        )!;
        expect(out.groups).toEqual(base.groups.filter((g) => g !== victimGroup));
      }),
      { numRuns: 100 },
    );
  });
});

describe('ambiguity is never guessed', () => {
  it('a duplicated credit takes its settlement and both credits out of the matches', () => {
    fc.assert(
      fc.property(worldArb, fc.integer({ min: 0, max: 99 }), ({ seed, count }, pickAt) => {
        const { input } = buildWorld(seed, count);
        const base = runMatcher(input);
        const payoutCredits = input.bankLines.filter((b) =>
          base.groups.some(
            (g) => g.kind === 'payout' && g.members.some((m) => m.recordId === b.id),
          ),
        );
        const victim = payoutCredits[pickAt % payoutCredits.length]!;
        const twin = credit(victim.amount, victim.valueDate, victim.narration);
        const out = runMatcher({ ...input, bankLines: [...input.bankLines, twin] });

        expect(memberIds(out).has(victim.id)).toBe(false);
        expect(memberIds(out).has(twin.id)).toBe(false);
        const victimGroup = base.groups.find((g) =>
          g.members.some((m) => m.recordId === victim.id),
        )!;
        const settlementId = victimGroup.members.find(
          (m) => m.recordType === 'rzp_settlement',
        )!.recordId;
        const exception = out.exceptions.find((e) => e.subject.recordId === settlementId)!;
        expect(exception.candidates.map((c) => c.recordId)).toEqual(
          expect.arrayContaining([victim.id, twin.id]),
        );
        expect(out.groups).toEqual(base.groups.filter((g) => g !== victimGroup));
      }),
      { numRuns: 150 },
    );
  });

  it('a duplicated payment for an order takes the order out of the matches', () => {
    fc.assert(
      fc.property(worldArb, fc.integer({ min: 0, max: 99 }), ({ seed, count }, pickAt) => {
        const { input } = buildWorld(seed, count);
        const base = runMatcher(input);
        const victim = input.payments[pickAt % input.payments.length]!;
        const twin = payment(`${victim.paymentId}_again`, victim.receipt, Number(victim.amount));
        const out = runMatcher({ ...input, payments: [...input.payments, twin] });

        expect(memberIds(out).has(victim.id)).toBe(false);
        expect(memberIds(out).has(twin.id)).toBe(false);
        const victimGroup = base.groups.find((g) =>
          g.members.some((m) => m.recordId === victim.id),
        )!;
        expect(out.groups).toEqual(base.groups.filter((g) => g !== victimGroup));
        expect(out.exceptions.filter((e) => e.reasonCode === 'DUPLICATE_PAYMENT')).toHaveLength(3);
      }),
      { numRuns: 100 },
    );
  });
});

describe('statistics', () => {
  it('count what was matched per record type', () => {
    const { input, orders, settlements } = buildWorld(7, 4);
    const { stats } = runMatcher(input);
    expect(stats.matched.ledger_entry).toEqual({ total: orders, matched: orders });
    expect(stats.matched.rzp_settlement).toEqual({ total: settlements, matched: settlements });
    expect(stats.groups.T3 + stats.groups.T4).toBe(settlements);
    // The debit and the UPI credit are in the data and deliberately not matched.
    expect(stats.matched.bank_line.total - stats.matched.bank_line.matched).toBe(2);
    expect(stats.ignored).toBeGreaterThanOrEqual(2);
  });
});
