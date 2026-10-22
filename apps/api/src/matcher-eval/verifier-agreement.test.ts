// The verifier against the rule matcher, on datagen's data. Both are built on one set of definitions
// (the settlement composition, the windows, the date-shift test), so every group the rules make should
// be one the verifier can verify. Where it does not, the reason must be a known and deliberate one, not
// drift between two implementations of "do these records reconcile?".
//
// The one deliberate difference: a rule group may carry refunds as an ANNOTATION (the ledger equals the
// payment and the refund is shown beside it), which the verifier's order balance (ledger = payments
// minus refunds) does not accept for an AGENT's proposal. Those are rejected with exactly the refund
// amount as the residual, and nothing else.
import { type MatcherOutput, runMatcher } from '@ziro/core/matcher';
import { paise } from '@ziro/core/money';
import {
  type VerifierConfig,
  type VerifierSnapshot,
  type VerifyOutcome,
  recordKey,
  verifyProposal,
} from '@ziro/core/verify';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_ORDER_DATE_WINDOW_DAYS } from '@ziro/core/verify';
import { makeSyntheticDataset, type TempDataset } from '../razorpay/razorpay.fixtures.js';
import { loadDomainDataset, matcherConfigFor } from './dataset.js';

const datasets: TempDataset[] = [];
afterAll(() => datasets.forEach((d) => d.cleanup()));

async function world(preset: 'demo' | 'eval', seed: number) {
  const generated = makeSyntheticDataset(preset, seed);
  datasets.push(generated);
  const { input } = await loadDomainDataset(generated.dir);
  const rules = matcherConfigFor(seed, preset);
  const out: MatcherOutput = runMatcher(input, rules);
  const config: VerifierConfig = { ...rules, orderDateWindowDays: DEFAULT_ORDER_DATE_WINDOW_DAYS };

  const byId = <T extends { id: string }>(list: readonly T[]) =>
    new Map(list.map((r) => [r.id, r]));
  const items = new Map<string, (typeof input.settlementItems)[number][]>();
  for (const item of input.settlementItems) {
    items.set(item.settlementId, [...(items.get(item.settlementId) ?? []), item]);
  }
  const snapshot: VerifierSnapshot = {
    runId: input.ledger[0]?.runId ?? '',
    ledger: byId(input.ledger),
    payments: byId(input.payments),
    refunds: byId(input.refunds),
    settlements: byId(input.settlements),
    bankLines: byId(input.bankLines),
    settlementItems: items,
    paymentsByRzpId: new Map(input.payments.map((p) => [p.paymentId, p])),
    refundsByRzpId: new Map(input.refunds.map((r) => [r.refundId, r])),
    accepted: new Set<string>(),
  };
  return { input, out, config, snapshot };
}

const verifyGroup = (
  w: Awaited<ReturnType<typeof world>>,
  group: MatcherOutput['groups'][number],
  snapshot: VerifierSnapshot = w.snapshot,
): VerifyOutcome =>
  verifyProposal(
    { verdict: 'MATCH_PROPOSED', reasonCode: group.reasonCode ?? 'UNKNOWN', links: group.members },
    snapshot,
    w.config,
  );

describe.each([
  ['eval', 42],
  ['eval', 7],
  ['demo', 42],
] as const)('verifier against the rules: %s preset, seed %i', (preset, seed) => {
  it('verifies every payout group the rules made', async () => {
    const w = await world(preset, seed);
    const payouts = w.out.groups.filter((g) => g.kind === 'payout');
    expect(payouts.length).toBeGreaterThan(0);
    const refused = payouts
      .map((g) => ({ g, outcome: verifyGroup(w, g) }))
      .filter((r) => r.outcome.status !== 'VERIFIED')
      .map((r) => ({
        reason: r.g.reasonCode,
        findings:
          r.outcome.status === 'REJECTED'
            ? r.outcome.findings.map((f) => `${f.code}: ${f.message}`)
            : [],
      }));
    expect(refused).toEqual([]);
    console.info(`agreement ${preset}/${seed}: ${payouts.length} payout groups, all verified`);
  });

  it('verifies every order group without refunds, and refuses those with refunds by exactly the refund', async () => {
    const w = await world(preset, seed);
    const orders = w.out.groups.filter((g) => g.kind === 'order');
    expect(orders.length).toBeGreaterThan(0);
    let withRefunds = 0;
    for (const group of orders) {
      const refundTotal = group.members
        .filter((m) => m.recordType === 'rzp_refund')
        .reduce((sum, m) => sum + (w.snapshot.refunds.get(m.recordId)?.amount ?? 0n), 0n);
      const outcome = verifyGroup(w, group);
      if (refundTotal === 0n) {
        expect(
          outcome.status,
          JSON.stringify(outcome, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
        ).toBe('VERIFIED');
      } else {
        withRefunds += 1;
        expect(outcome.status).toBe('REJECTED');
        if (outcome.status === 'REJECTED') {
          expect(outcome.findings.map((f) => f.code)).toEqual(['AMOUNT_MISMATCH']);
          expect(outcome.findings[0]?.residual).toBe(paise(refundTotal));
        }
      }
    }
    console.info(
      `agreement ${preset}/${seed}: ${orders.length} order groups, ${orders.length - withRefunds} verified, ${withRefunds} carry a refund annotation`,
    );
  });

  it('refuses every verified group once any one amount in it is off by a single paisa', async () => {
    const w = await world(preset, seed);
    let tried = 0;
    for (const group of w.out.groups) {
      if (verifyGroup(w, group).status !== 'VERIFIED') continue;
      // Move one paisa on the bank credit (payout) or the ledger entry (order).
      const target = group.members.find(
        (m) => m.recordType === (group.kind === 'payout' ? 'bank_line' : 'ledger_entry'),
      );
      if (target === undefined) continue;
      const bumped: VerifierSnapshot =
        group.kind === 'payout'
          ? {
              ...w.snapshot,
              bankLines: new Map(w.snapshot.bankLines).set(target.recordId, {
                ...(w.snapshot.bankLines.get(target.recordId) as NonNullable<
                  ReturnType<typeof w.snapshot.bankLines.get>
                >),
                amount: paise((w.snapshot.bankLines.get(target.recordId)?.amount ?? 0n) + 1n),
              }),
            }
          : {
              ...w.snapshot,
              ledger: new Map(w.snapshot.ledger).set(target.recordId, {
                ...(w.snapshot.ledger.get(target.recordId) as NonNullable<
                  ReturnType<typeof w.snapshot.ledger.get>
                >),
                amount: paise((w.snapshot.ledger.get(target.recordId)?.amount ?? 0n) + 1n),
              }),
            };
      expect(verifyGroup(w, group, bumped).status).toBe('REJECTED');
      tried += 1;
    }
    expect(tried).toBeGreaterThan(0);
  });

  it('refuses a group once any of its records is already in an accepted group', async () => {
    const w = await world(preset, seed);
    const group = w.out.groups.find((g) => verifyGroup(w, g).status === 'VERIFIED');
    expect(group).toBeDefined();
    const first = group?.members[0];
    if (group === undefined || first === undefined) return;
    const taken: VerifierSnapshot = { ...w.snapshot, accepted: new Set([recordKey(first)]) };
    const outcome = verifyGroup(w, group, taken);
    expect(outcome.status).toBe('REJECTED');
    if (outcome.status === 'REJECTED') expect(outcome.findings[0]?.code).toBe('ALREADY_MATCHED');
  });
});
