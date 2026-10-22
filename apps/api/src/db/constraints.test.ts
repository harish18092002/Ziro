import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedDb,
  HASH,
  insertBankLine,
  insertException,
  insertGroup,
  insertLedger,
  insertLink,
  insertLlmCall,
  insertPayment,
  insertProposal,
  insertRefund,
  insertSettlement,
  insertSettlementItem,
  one,
  PG,
  pgErrorOf,
  seedRun,
  type LinkTarget,
  type TestDb,
} from './migrated-db.fixtures.js';
import {
  bankLines,
  ledgerEntries,
  llmCalls,
  matchGroups,
  matchLinks,
  reconExceptions,
  reconRuns,
  reviews,
  rzpPayments,
} from './schema.js';

let ctx: Awaited<ReturnType<typeof createMigratedDb>>;
let db: TestDb;

beforeAll(async () => {
  ctx = await createMigratedDb();
  db = ctx.db;
});
afterAll(async () => {
  await ctx.client.close();
});

const randomUuid = () => crypto.randomUUID();

// --- source records ------------------------------------------------------------------------------

type SourceOverrides = { sourceRef?: string; importHash?: string };
const SOURCE_TABLES: readonly {
  name: string;
  make: (db: TestDb, runId: string, over: SourceOverrides) => Promise<string>;
}[] = [
  { name: 'ledger_entries', make: (d, run, over) => insertLedger(d, run, over) },
  { name: 'rzp_payments', make: (d, run, over) => insertPayment(d, run, over) },
  { name: 'rzp_refunds', make: (d, run, over) => insertRefund(d, run, over) },
  { name: 'rzp_settlements', make: (d, run, over) => insertSettlement(d, run, over) },
  {
    name: 'settlement_items',
    make: async (d, run, over) =>
      insertSettlementItem(d, run, await insertSettlement(d, run), over),
  },
  { name: 'bank_lines', make: (d, run, over) => insertBankLine(d, run, over) },
];

describe.each(SOURCE_TABLES)('source identity: $name', ({ name, make }) => {
  it('rejects a second record with the same (run, source_ref)', async () => {
    const run = await seedRun(db);
    await make(db, run, { sourceRef: 'dup-1' });
    const error = await pgErrorOf(make(db, run, { sourceRef: 'dup-1' }));
    expect(error.code).toBe(PG.unique);
    expect(error.constraint).toBe(`${name}_run_source_ref_uq`);
  });

  it('allows the same source_ref in a different run', async () => {
    const [a, b] = [await seedRun(db), await seedRun(db)];
    await make(db, a, { sourceRef: 'shared-ref' });
    await expect(make(db, b, { sourceRef: 'shared-ref' })).resolves.toEqual(expect.any(String));
  });

  it('allows identical import_hash on different records (import_hash is not an identity)', async () => {
    const run = await seedRun(db);
    await make(db, run, { sourceRef: 'twin-1', importHash: HASH });
    await expect(make(db, run, { sourceRef: 'twin-2', importHash: HASH })).resolves.toEqual(
      expect.any(String),
    );
  });

  it('refuses an import_hash that is not lowercase sha-256 hex', async () => {
    const run = await seedRun(db);
    for (const importHash of ['abc', 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63)]) {
      const error = await pgErrorOf(make(db, run, { importHash }));
      expect(error, importHash).toMatchObject({
        code: PG.check,
        constraint: expect.stringMatching(/sha256$/) as unknown,
      });
    }
  });

  it('refuses a record that belongs to no run', async () => {
    const error = await pgErrorOf(make(db, randomUuid(), {}));
    expect(error.code).toBe(PG.foreignKey);
  });

  it('refuses to delete a run that still has records (no cascades anywhere)', async () => {
    const run = await seedRun(db);
    await make(db, run, {});
    expect((await pgErrorOf(db.delete(reconRuns).where(eq(reconRuns.id, run)))).code).toBe(
      PG.restrict,
    );
  });
});

describe('payments', () => {
  it('rejects a duplicate Razorpay id within a run even under a different source_ref', async () => {
    const run = await seedRun(db);
    await insertPayment(db, run, { rzpId: 'pay_same' });
    const error = await pgErrorOf(insertPayment(db, run, { rzpId: 'pay_same' }));
    expect(error).toMatchObject({ code: PG.unique, constraint: 'rzp_payments_run_rzp_id_uq' });
  });

  it('keeps tax inside the fee (fee is GST-inclusive) but does not force 18%', async () => {
    const run = await seedRun(db);
    expect(
      await pgErrorOf(insertPayment(db, run, { feePaise: 100n, taxPaise: 101n })),
    ).toMatchObject({
      code: PG.check,
      constraint: 'rzp_payments_tax_within_fee',
    });
    // Razorpay documents samples with a fee and tax 0; the database must accept them.
    await expect(insertPayment(db, run, { feePaise: 100n, taxPaise: 0n })).resolves.toEqual(
      expect.any(String),
    );
  });

  it('cannot refund more than the payment amount', async () => {
    const run = await seedRun(db);
    expect(
      await pgErrorOf(insertPayment(db, run, { amountPaise: 1000n, amountRefundedPaise: 1001n })),
    ).toMatchObject({ code: PG.check, constraint: 'rzp_payments_refunded_within_amount' });
    await expect(
      insertPayment(db, run, { amountPaise: 1000n, amountRefundedPaise: 1000n }),
    ).resolves.toEqual(expect.any(String));
  });

  it('rejects an unknown status', async () => {
    const run = await seedRun(db);
    const error = await pgErrorOf(insertPayment(db, run, { status: 'settled' as never }));
    expect(error.code).toBe(PG.badEnum);
  });
});

// --- money ---------------------------------------------------------------------------------------

describe('money columns are non-negative bigint paise', () => {
  const NEGATIVE: readonly [string, (d: TestDb, run: string) => Promise<unknown>][] = [
    ['ledger_entries.amount_paise', (d, r) => insertLedger(d, r, { amountPaise: -1n })],
    ['rzp_payments.amount_paise', (d, r) => insertPayment(d, r, { amountPaise: -1n })],
    ['rzp_payments.fee_paise', (d, r) => insertPayment(d, r, { feePaise: -1n, taxPaise: 0n })],
    ['rzp_payments.tax_paise', (d, r) => insertPayment(d, r, { taxPaise: -1n })],
    ['rzp_refunds.amount_paise', (d, r) => insertRefund(d, r, { amountPaise: -1n })],
    ['rzp_settlements.amount_paise', (d, r) => insertSettlement(d, r, { amountPaise: -1n })],
    ['rzp_settlements.fees_paise', (d, r) => insertSettlement(d, r, { feesPaise: -1n })],
    [
      'settlement_items.credit_paise',
      async (d, r) =>
        insertSettlementItem(d, r, await insertSettlement(d, r), { creditPaise: -1n }),
    ],
    [
      'settlement_items.debit_paise',
      async (d, r) => insertSettlementItem(d, r, await insertSettlement(d, r), { debitPaise: -1n }),
    ],
    ['bank_lines.amount_paise', (d, r) => insertBankLine(d, r, { amountPaise: -1n })],
  ];

  it.each(NEGATIVE)('rejects a negative %s', async (_column, make) => {
    const run = await seedRun(db);
    expect((await pgErrorOf(make(db, run))).code).toBe(PG.check);
  });

  it('allows signed columns to go negative: bank balance, group residual, amount at stake', async () => {
    const run = await seedRun(db);
    await expect(insertBankLine(db, run, { balancePaise: -500n })).resolves.toEqual(
      expect.any(String),
    );
    await expect(
      insertGroup(db, run, { status: 'proposed', residualPaise: -6800n }),
    ).resolves.toMatchObject({
      status: 'proposed',
    });
    await expect(insertException(db, run, { amountAtStakePaise: -6800n })).resolves.toEqual(
      expect.any(String),
    );
  });

  it('round-trips integers beyond 2^53 and up to int64 max with no precision loss', async () => {
    const run = await seedRun(db);
    for (const amount of [9007199254740993n, 9223372036854775807n]) {
      const id = await insertLedger(db, run, { amountPaise: amount });
      const row = one(await db.select().from(ledgerEntries).where(eq(ledgerEntries.id, id)));
      expect(row.amountPaise, String(amount)).toBe(amount);
      expect(typeof row.amountPaise).toBe('bigint');
    }
  });

  it('rejects an amount beyond int64 instead of wrapping', async () => {
    const run = await seedRun(db);
    const error = await pgErrorOf(insertLedger(db, run, { amountPaise: 9223372036854775808n }));
    expect(error.code).toBe(PG.outOfRange);
  });

  it('reads a payment back with exact bigint paise for amount, fee and tax', async () => {
    const run = await seedRun(db);
    const id = await insertPayment(db, run, {
      amountPaise: 250000n,
      feePaise: 5900n,
      taxPaise: 900n,
    });
    const row = one(await db.select().from(rzpPayments).where(eq(rzpPayments.id, id)));
    expect([row.amountPaise, row.feePaise, row.taxPaise]).toEqual([250000n, 5900n, 900n]);
  });
});

// --- matching: a record in at most one accepted group --------------------------------------------

const KINDS: readonly {
  name: string;
  index: string;
  make: (d: TestDb, run: string) => Promise<string>;
  target: (id: string) => LinkTarget;
}[] = [
  {
    name: 'ledger entry',
    index: 'match_links_one_accepted_ledger_entry',
    make: (d, r) => insertLedger(d, r),
    target: (id) => ({ ledgerEntryId: id }),
  },
  {
    name: 'payment',
    index: 'match_links_one_accepted_payment',
    make: (d, r) => insertPayment(d, r),
    target: (id) => ({ paymentId: id }),
  },
  {
    name: 'refund',
    index: 'match_links_one_accepted_refund',
    make: (d, r) => insertRefund(d, r),
    target: (id) => ({ refundId: id }),
  },
  {
    name: 'settlement',
    index: 'match_links_one_accepted_settlement',
    make: (d, r) => insertSettlement(d, r),
    target: (id) => ({ settlementId: id }),
  },
  {
    name: 'bank line',
    index: 'match_links_one_accepted_bank_line',
    make: (d, r) => insertBankLine(d, r),
    target: (id) => ({ bankLineId: id }),
  },
];

const linkStatuses = async (groupId: string) =>
  (
    await db
      .select({ s: matchLinks.groupStatus })
      .from(matchLinks)
      .where(eq(matchLinks.groupId, groupId))
  ).map((r) => r.s);

describe.each(KINDS)(
  'a $name sits in at most one accepted match group',
  ({ index, make, target }) => {
    it('rejects linking it into a second accepted group', async () => {
      const run = await seedRun(db);
      const record = await make(db, run);
      await insertLink(db, await insertGroup(db, run, { status: 'accepted' }), target(record));

      const second = await insertGroup(db, run, { status: 'accepted' });
      const error = await pgErrorOf(insertLink(db, second, target(record)));
      expect(error).toMatchObject({ code: PG.unique, constraint: index });
    });

    it('allows it alongside proposed, rejected and reversed groups', async () => {
      const run = await seedRun(db);
      const record = await make(db, run);
      await insertLink(db, await insertGroup(db, run, { status: 'accepted' }), target(record));
      for (const status of ['proposed', 'rejected', 'reversed'] as const) {
        const group = await insertGroup(db, run, { status });
        await expect(insertLink(db, group, target(record)), status).resolves.toHaveLength(1);
      }
    });

    it('rejects promoting a second group to accepted, and the failed promotion changes nothing', async () => {
      const run = await seedRun(db);
      const record = await make(db, run);
      await insertLink(db, await insertGroup(db, run, { status: 'accepted' }), target(record));

      const contender = await insertGroup(db, run, { status: 'proposed' });
      await insertLink(db, contender, target(record));

      const error = await pgErrorOf(
        db.update(matchGroups).set({ status: 'accepted' }).where(eq(matchGroups.id, contender.id)),
      );
      expect(error).toMatchObject({ code: PG.unique, constraint: index });

      const [group] = await db.select().from(matchGroups).where(eq(matchGroups.id, contender.id));
      expect(group?.status).toBe('proposed');
      expect(await linkStatuses(contender.id)).toEqual(['proposed']);
    });

    it('frees the record when its accepted group is reversed, so another group can take it', async () => {
      const run = await seedRun(db);
      const record = await make(db, run);
      const first = await insertGroup(db, run, { status: 'accepted' });
      await insertLink(db, first, target(record));
      const second = await insertGroup(db, run, { status: 'proposed' });
      await insertLink(db, second, target(record));

      await db.update(matchGroups).set({ status: 'reversed' }).where(eq(matchGroups.id, first.id));
      await db.update(matchGroups).set({ status: 'accepted' }).where(eq(matchGroups.id, second.id));

      // The status mirrored into the links follows the group through the composite foreign key.
      expect(await linkStatuses(first.id)).toEqual(['reversed']);
      expect(await linkStatuses(second.id)).toEqual(['accepted']);
    });
  },
);

describe('match group and link integrity', () => {
  it('a link cannot claim a status different from its group (composite foreign key)', async () => {
    const run = await seedRun(db);
    const group = await insertGroup(db, run, { status: 'proposed' });
    const record = await insertLedger(db, run);
    const error = await pgErrorOf(
      insertLink(db, { ...group, status: 'accepted' }, { ledgerEntryId: record }),
    );
    expect(error).toMatchObject({ code: PG.foreignKey, constraint: 'match_links_group_fk' });
  });

  it('a link must point at exactly one record', async () => {
    const run = await seedRun(db);
    const group = await insertGroup(db, run);
    const none = await pgErrorOf(insertLink(db, group, {}));
    expect(none).toMatchObject({ code: PG.check, constraint: 'match_links_exactly_one_record' });

    const both = await pgErrorOf(
      insertLink(db, group, {
        ledgerEntryId: await insertLedger(db, run),
        paymentId: await insertPayment(db, run),
      }),
    );
    expect(both).toMatchObject({ code: PG.check, constraint: 'match_links_exactly_one_record' });
  });

  it('a link must point at a record that exists', async () => {
    const run = await seedRun(db);
    const error = await pgErrorOf(
      insertLink(db, await insertGroup(db, run), { paymentId: randomUuid() }),
    );
    expect(error.code).toBe(PG.foreignKey);
  });

  it('a rule-made group records its tier and rule id; agent and human groups need neither', async () => {
    const run = await seedRun(db);
    for (const over of [{ tier: null }, { ruleId: null }, { tier: null, ruleId: null }]) {
      const error = await pgErrorOf(insertGroup(db, run, over));
      expect(error, JSON.stringify(over)).toMatchObject({
        code: PG.check,
        constraint: 'match_groups_rule_records_tier_and_rule',
      });
    }
    for (const basis of ['agent', 'human'] as const) {
      await expect(
        insertGroup(db, run, { basis, tier: null, ruleId: null }),
      ).resolves.toMatchObject({ status: 'proposed' });
    }
  });

  it('an accepted group must reconcile to the paise: residual 0', async () => {
    const run = await seedRun(db);
    for (const residualPaise of [1n, -1n, 6800n]) {
      const error = await pgErrorOf(insertGroup(db, run, { status: 'accepted', residualPaise }));
      expect(error, String(residualPaise)).toMatchObject({
        code: PG.check,
        constraint: 'match_groups_accepted_reconciles',
      });
    }
    await expect(
      insertGroup(db, run, { status: 'accepted', residualPaise: 0n }),
    ).resolves.toMatchObject({
      status: 'accepted',
    });
  });

  it('cannot be promoted to accepted with a residual, nor given one once accepted', async () => {
    const run = await seedRun(db);
    const proposed = await insertGroup(db, run, { status: 'proposed', residualPaise: -6800n });
    const promote = await pgErrorOf(
      db.update(matchGroups).set({ status: 'accepted' }).where(eq(matchGroups.id, proposed.id)),
    );
    expect(promote).toMatchObject({
      code: PG.check,
      constraint: 'match_groups_accepted_reconciles',
    });

    // Resolving the residual and promoting in the same statement is fine.
    await db
      .update(matchGroups)
      .set({ status: 'accepted', residualPaise: 0n })
      .where(eq(matchGroups.id, proposed.id));

    const accepted = await insertGroup(db, run, { status: 'accepted' });
    const drift = await pgErrorOf(
      db.update(matchGroups).set({ residualPaise: 5n }).where(eq(matchGroups.id, accepted.id)),
    );
    expect(drift.code).toBe(PG.check);
  });

  it('lets a payment sit in an accepted order group while its settlement sits in an accepted payout group', async () => {
    // The whole point of the two group kinds: a normal fully-reconciled payment uses both.
    const run = await seedRun(db);
    const ledger = await insertLedger(db, run);
    const payment = await insertPayment(db, run);
    const settlement = await insertSettlement(db, run);
    const bank = await insertBankLine(db, run);
    await insertSettlementItem(db, run, settlement, { paymentId: payment });

    const order = await insertGroup(db, run, { kind: 'order', status: 'accepted' });
    await insertLink(db, order, { ledgerEntryId: ledger });
    await insertLink(db, order, { paymentId: payment });

    const payout = await insertGroup(db, run, {
      kind: 'payout',
      status: 'accepted',
      reasonCode: 'BATCHED_SETTLEMENT',
    });
    await insertLink(db, payout, { settlementId: settlement });
    await insertLink(db, payout, { bankLineId: bank });

    const accepted = await db
      .select()
      .from(matchLinks)
      .where(eq(matchLinks.groupStatus, 'accepted'));
    expect(accepted.length).toBeGreaterThanOrEqual(4);
  });
});

// --- exceptions, proposals, reviews, runs --------------------------------------------------------

describe('exceptions, proposals and reviews', () => {
  it('allows one exception per record per run', async () => {
    const [a, b] = [await seedRun(db), await seedRun(db)];
    const subjectId = randomUuid();
    await insertException(db, a, { subjectType: 'bank_line', subjectId });
    const dup = await pgErrorOf(insertException(db, a, { subjectType: 'bank_line', subjectId }));
    expect(dup).toMatchObject({ code: PG.unique, constraint: 'recon_exceptions_run_subject_uq' });

    await expect(
      insertException(db, a, { subjectType: 'rzp_payment', subjectId }),
    ).resolves.toEqual(expect.any(String));
    await expect(insertException(db, b, { subjectType: 'bank_line', subjectId })).resolves.toEqual(
      expect.any(String),
    );
  });

  it('only accepts the 14 reason codes', async () => {
    const run = await seedRun(db);
    const error = await pgErrorOf(insertException(db, run, { reasonCode: 'MYSTERY' as never }));
    expect(error.code).toBe(PG.badEnum);
    const rows = await db.select().from(reconExceptions).where(eq(reconExceptions.runId, run));
    expect(rows).toHaveLength(0);
  });

  it('a proposal needs a real exception', async () => {
    const run = await seedRun(db);
    expect((await pgErrorOf(insertProposal(db, run, randomUuid()))).code).toBe(PG.foreignKey);
  });

  it('allows one review per proposal', async () => {
    const run = await seedRun(db);
    const proposal = await insertProposal(db, run, await insertException(db, run));
    await db.insert(reviews).values({
      runId: run,
      proposalId: proposal,
      decision: 'approved',
      reviewerKind: 'human',
      reviewer: 'asha',
    });
    const second = await pgErrorOf(
      db.insert(reviews).values({
        runId: run,
        proposalId: proposal,
        decision: 'rejected',
        reviewerKind: 'human',
        reviewer: 'ravi',
      }),
    );
    expect(second).toMatchObject({ code: PG.unique, constraint: 'reviews_proposal_uq' });
  });

  it('keeps the verifier verdict separate from the agent proposal, defaulting to pending', async () => {
    const run = await seedRun(db);
    const id = await insertProposal(db, run, await insertException(db, run));
    const row = one(
      await db.query.agentProposals.findMany({ where: (p, { eq: is }) => is(p.id, id) }),
    );
    expect(row).toMatchObject({
      verifierStatus: 'pending',
      verifierFindings: [],
      harnessFindings: [],
      attempt: 1,
      clusterId: null,
      draftJournalEntry: null,
      confidencePermille: 800,
    });
  });

  it('is idempotent per (exception, attempt): the same investigation cannot be stored twice', async () => {
    const run = await seedRun(db);
    const exception = await insertException(db, run);
    await insertProposal(db, run, exception, { attempt: 1 });
    const again = await pgErrorOf(insertProposal(db, run, exception, { attempt: 1 }));
    expect(again).toMatchObject({
      code: PG.unique,
      constraint: 'agent_proposals_exception_attempt_uq',
    });
    // A re-run asked for by a person is a new attempt.
    await expect(insertProposal(db, run, exception, { attempt: 2 })).resolves.toEqual(
      expect.any(String),
    );
  });

  it('keeps attempt positive and confidence between 0 and 1', async () => {
    const run = await seedRun(db);
    const exception = await insertException(db, run);
    const attempt = await pgErrorOf(insertProposal(db, run, exception, { attempt: 0 }));
    expect(attempt).toMatchObject({
      code: PG.check,
      constraint: 'agent_proposals_attempt_positive',
    });
    for (const confidencePermille of [1001, -1]) {
      const error = await pgErrorOf(
        insertProposal(db, run, await insertException(db, run), { confidencePermille }),
      );
      expect(error, String(confidencePermille)).toMatchObject({
        code: PG.check,
        constraint: 'agent_proposals_confidence_range',
      });
    }
  });

  it('only allows the known verdicts and suggested actions', async () => {
    const run = await seedRun(db);
    const exception = await insertException(db, run);
    const verdict = await pgErrorOf(
      insertProposal(db, run, exception, { verdict: 'MATCHED' as never }),
    );
    expect(verdict.code).toBe(PG.badEnum);
    const action = await pgErrorOf(
      insertProposal(db, run, exception, { suggestedAction: 'PAY_OUT' as never }),
    );
    expect(action.code).toBe(PG.badEnum);
  });
});

describe('llm_calls', () => {
  it('stores spend as an exact decimal, read back as a string', async () => {
    const run = await seedRun(db);
    const id = await insertLlmCall(db, run, { costUsd: '0.000123' });
    const row = one(await db.select().from(llmCalls).where(eq(llmCalls.id, id)));
    expect(row.costUsd).toBe('0.000123');
  });

  it('rejects negative counts, latency or cost', async () => {
    const run = await seedRun(db);
    for (const over of [
      { tokensIn: -1 },
      { tokensOut: -1 },
      { latencyMs: -1 },
      { costUsd: '-0.01' },
    ]) {
      const error = await pgErrorOf(insertLlmCall(db, run, over));
      expect(error, JSON.stringify(over)).toMatchObject({
        code: PG.check,
        constraint: 'llm_calls_nonneg',
      });
    }
  });

  it('rejects a prompt_hash that is not sha-256 hex', async () => {
    const run = await seedRun(db);
    const error = await pgErrorOf(insertLlmCall(db, run, { promptHash: 'abc' }));
    expect(error).toMatchObject({ code: PG.check, constraint: 'llm_calls_prompt_hash_sha256' });
  });

  it('can be tied to the exception it investigated', async () => {
    const run = await seedRun(db);
    const exception = await insertException(db, run);
    const id = await insertLlmCall(db, run, { exceptionId: exception });
    expect(one(await db.select().from(llmCalls).where(eq(llmCalls.id, id))).exceptionId).toBe(
      exception,
    );
  });
});

describe('recon_runs and bank lines', () => {
  it('requires the period to end on or after it starts', async () => {
    const error = await pgErrorOf(
      db.insert(reconRuns).values({
        razorpaySource: 'synthetic',
        periodStart: '2026-10-31',
        periodEnd: '2026-10-01',
      }),
    );
    expect(error).toMatchObject({ code: PG.check, constraint: 'recon_runs_period_ordered' });
    await expect(
      db
        .insert(reconRuns)
        .values({ razorpaySource: 'testmode', periodStart: '2026-10-01', periodEnd: '2026-10-01' }),
    ).resolves.toBeDefined();
  });

  it('keeps IST business dates as plain dates, not timestamps', async () => {
    const run = await seedRun(db);
    const id = await insertBankLine(db, run, { valueDate: '2026-10-23' });
    const row = one(await db.select().from(bankLines).where(eq(bankLines.id, id)));
    expect(row.valueDate).toBe('2026-10-23');
  });

  it('keeps utr and utr_quality in step, and only allows the known qualities', async () => {
    const run = await seedRun(db);
    for (const over of [{ utr: 'UTIBN34889755412' }, { utrQuality: 'exact' as const }]) {
      const error = await pgErrorOf(insertBankLine(db, run, over));
      expect(error).toMatchObject({ code: PG.check, constraint: 'bank_lines_utr_quality_in_step' });
    }
    for (const quality of ['exact', 'rejoined', 'repaired', 'truncated'] as const) {
      await expect(
        insertBankLine(db, run, { utr: 'UTIBN34889755412', utrQuality: quality }),
      ).resolves.toEqual(expect.any(String));
    }
    const bad = await pgErrorOf(
      insertBankLine(db, run, { utr: 'UTIBN34889755412', utrQuality: 'guess' as never }),
    );
    expect(bad.code).toBe(PG.badEnum);
  });
});
