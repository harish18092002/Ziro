// Test support: an in-memory Postgres (PGlite) built by the project's real migrations, plus
// builders for valid rows. Not part of the production build (see tsconfig.build.json).
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function createMigratedDb() {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { client, db };
}
export type TestDb = Awaited<ReturnType<typeof createMigratedDb>>['db'];

export interface PgError {
  code: string | undefined;
  message: string;
  constraint: string | undefined;
}

/** Runs a statement that must fail and returns the Postgres error (Drizzle wraps it in `cause`). */
export async function pgErrorOf(work: PromiseLike<unknown>): Promise<PgError> {
  try {
    await work;
  } catch (err) {
    const source = (err instanceof Error && err.cause) || err;
    const e = source as { code?: string; message?: string; constraint?: string };
    return { code: e.code, message: e.message ?? String(source), constraint: e.constraint };
  }
  throw new Error('expected the statement to fail, but it succeeded');
}

export function one<T>(rows: readonly T[]): T {
  const [first] = rows;
  if (first === undefined) throw new Error('expected at least one row');
  return first;
}

// Postgres error codes the tests assert on.
export const PG = {
  outOfRange: '22003',
  badEnum: '22P02',
  notNull: '23502',
  restrict: '23001',
  foreignKey: '23503',
  unique: '23505',
  check: '23514',
} as const;

export const HASH = 'a'.repeat(64);

let sequence = 0;
const next = () => ++sequence;
const when = new Date('2026-10-21T18:45:00Z');

const base = (runId: string, ref: string) => ({
  runId,
  source: 'synthetic' as const,
  sourceRef: ref,
  importHash: HASH,
});

type Insert<T extends { $inferInsert: unknown }> = Partial<T['$inferInsert']>;

export async function seedRun(db: TestDb): Promise<string> {
  const row = one(
    await db
      .insert(schema.reconRuns)
      .values({ razorpaySource: 'synthetic', periodStart: '2026-10-01', periodEnd: '2026-10-31' })
      .returning({ id: schema.reconRuns.id }),
  );
  return row.id;
}

export async function insertLedger(
  db: TestDb,
  runId: string,
  over: Insert<typeof schema.ledgerEntries> = {},
): Promise<string> {
  const row = one(
    await db
      .insert(schema.ledgerEntries)
      .values({
        ...base(runId, `row-${next()}`),
        orderRef: `ORD-${next()}`,
        amountPaise: 250000n,
        businessDate: '2026-10-21',
        ...over,
      })
      .returning({ id: schema.ledgerEntries.id }),
  );
  return row.id;
}

export async function insertPayment(
  db: TestDb,
  runId: string,
  over: Insert<typeof schema.rzpPayments> = {},
): Promise<string> {
  const rzpId = `pay_${next()}`;
  const row = one(
    await db
      .insert(schema.rzpPayments)
      .values({
        ...base(runId, rzpId),
        rzpId,
        amountPaise: 250000n,
        feePaise: 5900n,
        taxPaise: 900n,
        method: 'wallet',
        status: 'captured',
        captured: true,
        rzpCreatedAt: when,
        businessDate: '2026-10-22',
        ...over,
      })
      .returning({ id: schema.rzpPayments.id }),
  );
  return row.id;
}

export async function insertRefund(
  db: TestDb,
  runId: string,
  over: Insert<typeof schema.rzpRefunds> = {},
): Promise<string> {
  const rzpId = `rfnd_${next()}`;
  const row = one(
    await db
      .insert(schema.rzpRefunds)
      .values({
        ...base(runId, rzpId),
        rzpId,
        rzpPaymentId: 'pay_unknown',
        amountPaise: 50000n,
        status: 'processed',
        rzpCreatedAt: when,
        businessDate: '2026-10-22',
        ...over,
      })
      .returning({ id: schema.rzpRefunds.id }),
  );
  return row.id;
}

export async function insertSettlement(
  db: TestDb,
  runId: string,
  over: Insert<typeof schema.rzpSettlements> = {},
): Promise<string> {
  const rzpId = `setl_${next()}`;
  const row = one(
    await db
      .insert(schema.rzpSettlements)
      .values({
        ...base(runId, rzpId),
        rzpId,
        amountPaise: 9973635n,
        feesPaise: 0n,
        taxPaise: 0n,
        status: 'processed',
        rzpCreatedAt: when,
        businessDate: '2026-10-23',
        ...over,
      })
      .returning({ id: schema.rzpSettlements.id }),
  );
  return row.id;
}

export async function insertSettlementItem(
  db: TestDb,
  runId: string,
  settlementId: string,
  over: Insert<typeof schema.settlementItems> = {},
): Promise<string> {
  const row = one(
    await db
      .insert(schema.settlementItems)
      .values({
        ...base(runId, `recon-${next()}`),
        settlementId,
        itemType: 'payment',
        rzpEntityId: `pay_${next()}`,
        amountPaise: 250000n,
        feePaise: 5900n,
        taxPaise: 900n,
        debitPaise: 0n,
        creditPaise: 244100n,
        ...over,
      })
      .returning({ id: schema.settlementItems.id }),
  );
  return row.id;
}

export async function insertBankLine(
  db: TestDb,
  runId: string,
  over: Insert<typeof schema.bankLines> = {},
): Promise<string> {
  const row = one(
    await db
      .insert(schema.bankLines)
      .values({
        ...base(runId, `stmt-${next()}`),
        valueDate: '2026-10-23',
        direction: 'credit',
        amountPaise: 9973635n,
        narration: 'NEFT CR UTIB0123456789 RAZORPAY SOFTWARE',
        ...over,
      })
      .returning({ id: schema.bankLines.id }),
  );
  return row.id;
}

export interface GroupRef {
  id: string;
  status: (typeof schema.matchGroups.$inferSelect)['status'];
}

export async function insertGroup(
  db: TestDb,
  runId: string,
  over: Insert<typeof schema.matchGroups> = {},
): Promise<GroupRef> {
  return one(
    await db
      .insert(schema.matchGroups)
      .values({
        runId,
        kind: 'order',
        status: 'proposed',
        basis: 'rule',
        tier: 'T1',
        ruleId: 'T1.receipt-amount.v1',
        ...over,
      })
      .returning({ id: schema.matchGroups.id, status: schema.matchGroups.status }),
  );
}

export type LinkTarget = Pick<
  typeof schema.matchLinks.$inferInsert,
  'ledgerEntryId' | 'paymentId' | 'refundId' | 'settlementId' | 'bankLineId'
>;

/** Links a record to a group; group_status is copied from the group, as the foreign key requires. */
export function insertLink(db: TestDb, group: GroupRef, target: LinkTarget) {
  return db
    .insert(schema.matchLinks)
    .values({ groupId: group.id, groupStatus: group.status, ...target })
    .returning({ id: schema.matchLinks.id });
}

export async function insertException(
  db: TestDb,
  runId: string,
  over: Insert<typeof schema.reconExceptions> = {},
): Promise<string> {
  const row = one(
    await db
      .insert(schema.reconExceptions)
      .values({
        runId,
        reasonCode: 'FEE_GST_DEDUCTION',
        subjectType: 'rzp_payment',
        subjectId: crypto.randomUUID(),
        ...over,
      })
      .returning({ id: schema.reconExceptions.id }),
  );
  return row.id;
}

export async function insertLlmCall(
  db: TestDb,
  runId: string,
  over: Insert<typeof schema.llmCalls> = {},
): Promise<string> {
  const row = one(
    await db
      .insert(schema.llmCalls)
      .values({
        runId,
        model: 'test-model',
        harness: 'loop',
        tokensIn: 1200,
        tokensOut: 300,
        costUsd: '0.004200',
        latencyMs: 850,
        promptHash: HASH,
        ...over,
      })
      .returning({ id: schema.llmCalls.id }),
  );
  return row.id;
}

export async function insertProposal(
  db: TestDb,
  runId: string,
  exceptionId: string,
  over: Insert<typeof schema.agentProposals> = {},
): Promise<string> {
  const row = one(
    await db
      .insert(schema.agentProposals)
      .values({
        runId,
        exceptionId,
        reasonCode: 'FEE_GST_DEDUCTION',
        links: [],
        claimedResidualPaise: 0n,
        explanation: 'Payment less fee matches the ledger.',
        evidence: [],
        ...over,
      })
      .returning({ id: schema.agentProposals.id }),
  );
  return row.id;
}

export function insertAudit(db: TestDb, over: Insert<typeof schema.auditEvents> = {}) {
  return db
    .insert(schema.auditEvents)
    .values({ actor: 'system', action: 'test.event', entityType: 'test', entityId: '1', ...over })
    .returning({ id: schema.auditEvents.id });
}
