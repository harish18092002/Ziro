// Drizzle schema for Ziro. One file on purpose: drizzle-kit's loader copes poorly with NodeNext
// `.js`-suffixed imports between schema files, and the whole model reads better in one place.
//
// Conventions
//  - Money is `bigint` paise (mode 'bigint'), never numeric/float. The one deliberate decimal is
//    llm_calls.cost_usd: LLM spend in USD, not merchant money.
//  - Razorpay's own ids live in `rzp_*` text columns; `<table>_id` columns are uuid foreign keys.
//  - Every ingested source record carries run_id, source, source_ref, import_hash (+ raw, created_at).
//    (run_id, source_ref) is the identity; import_hash is deliberately NOT unique, because two
//    identical bank lines are legitimate and a changed re-import is detected by comparing hashes.
//  - No ON DELETE CASCADE anywhere: audit_events is append-only, so runs are archived, never deleted.
//  - Free text (memo, narration, description, raw) is untrusted data (CLAUDE.md §4.5).
//  - The audit_events append-only trigger lives in the custom migration 0001_audit_append_only.sql,
//    because Drizzle cannot express triggers.
import {
  ACTORS,
  AGENT_VERDICTS,
  BANK_DIRECTIONS,
  DEGRADED_REASONS,
  EXCEPTION_STATUSES,
  MATCH_BASES,
  MATCH_GROUP_KINDS,
  MATCH_GROUP_STATUSES,
  MATCH_TIERS,
  PAYMENT_STATUSES,
  REASON_CODES,
  RECORD_TYPES,
  REVIEW_DECISIONS,
  REVIEWER_KINDS,
  SETTLEMENT_ITEM_TYPES,
  SETTLEMENT_STATUSES,
  SOURCES,
  SUGGESTED_ACTIONS,
  VERIFIER_STATUSES,
} from '@ziro/core/domain';
import { UTR_QUALITIES } from '@ziro/core/normalize';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  primaryKey,
  smallint,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// --- enums (values come from @ziro/core/domain wherever the domain defines them) ----------------

/** pgEnum needs a non-empty tuple; the domain exports plain readonly arrays for some lists. */
function values<T extends string>(list: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = list;
  if (first === undefined) throw new Error('enum needs at least one value');
  return [first, ...rest];
}

const RUN_STATUSES = [
  'created',
  'ingesting',
  'matching',
  'investigating',
  'complete',
  'failed',
] as const;
const RAZORPAY_SOURCES = ['synthetic', 'testmode'] as const;
const HARNESSES = ['loop', 'agent-sdk'] as const;

export const recordSource = pgEnum('record_source', SOURCES);
export const reasonCode = pgEnum('reason_code', values(REASON_CODES));
export const runStatus = pgEnum('run_status', RUN_STATUSES);
export const razorpaySource = pgEnum('razorpay_source', RAZORPAY_SOURCES);
export const paymentStatus = pgEnum('payment_status', PAYMENT_STATUSES);
export const settlementStatus = pgEnum('settlement_status', SETTLEMENT_STATUSES);
export const settlementItemType = pgEnum('settlement_item_type', SETTLEMENT_ITEM_TYPES);
export const bankDirection = pgEnum('bank_direction', BANK_DIRECTIONS);
export const utrQuality = pgEnum('utr_quality', UTR_QUALITIES);
export const agentVerdict = pgEnum('agent_verdict', AGENT_VERDICTS);
export const suggestedAction = pgEnum('suggested_action', SUGGESTED_ACTIONS);
export const recordType = pgEnum('record_type', RECORD_TYPES);
export const matchGroupKind = pgEnum('match_group_kind', MATCH_GROUP_KINDS);
export const matchGroupStatus = pgEnum('match_group_status', MATCH_GROUP_STATUSES);
export const matchBasis = pgEnum('match_basis', MATCH_BASES);
export const matchTier = pgEnum('match_tier', MATCH_TIERS);
export const exceptionStatus = pgEnum('exception_status', EXCEPTION_STATUSES);
export const verifierStatus = pgEnum('verifier_status', VERIFIER_STATUSES);
export const reviewDecision = pgEnum('review_decision', REVIEW_DECISIONS);
export const reviewerKind = pgEnum('reviewer_kind', REVIEWER_KINDS);
export const actor = pgEnum('actor', ACTORS);
export const harness = pgEnum('harness', HARNESSES);

// --- shared column builders --------------------------------------------------------------------

const paise = (name: string) => bigint(name, { mode: 'bigint' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

type Json = Record<string, unknown>;

/** char(64) silently pads a short string, so the database also insists on lowercase sha-256 hex. */
const sha256Check = (table: string, column: AnyPgColumn) =>
  check(`${table}_${column.name}_sha256`, sql`${column} ~ '^[0-9a-f]{64}$'`);

// --- runs --------------------------------------------------------------------------------------

export const reconRuns = pgTable(
  'recon_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    status: runStatus('status').notNull().default('created'),
    razorpaySource: razorpaySource('razorpay_source').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    /** Snapshot of the date windows, thresholds and rule versions this run used. */
    config: jsonb('config').$type<Json>().notNull().default({}),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [check('recon_runs_period_ordered', sql`${t.periodStart} <= ${t.periodEnd}`)],
);

/** Columns every ingested source record shares. A function so each table gets its own builders. */
const sourceColumns = () => ({
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => reconRuns.id, { onDelete: 'restrict' }),
  source: recordSource('source').notNull(),
  sourceRef: text('source_ref').notNull(),
  importHash: char('import_hash', { length: 64 }).notNull(),
  /** The record exactly as received. Untrusted. */
  raw: jsonb('raw').$type<Json>().notNull().default({}),
  createdAt: createdAt(),
});

// --- the three sources -------------------------------------------------------------------------

export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    ...sourceColumns(),
    orderRef: text('order_ref').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    customerRef: text('customer_ref'),
    memo: text('memo'),
  },
  (t) => [
    uniqueIndex('ledger_entries_run_source_ref_uq').on(t.runId, t.sourceRef),
    index('ledger_entries_run_order_ref_idx').on(t.runId, t.orderRef),
    check('ledger_entries_amount_nonneg', sql`${t.amountPaise} >= 0`),
    sha256Check('ledger_entries', t.importHash),
  ],
);

export const rzpPayments = pgTable(
  'rzp_payments',
  {
    ...sourceColumns(),
    rzpId: text('rzp_id').notNull(),
    rzpOrderId: text('rzp_order_id'),
    /** As Razorpay states it. Anything but INR is stored faithfully and refused by the verifier. */
    currency: text('currency').notNull().default('INR'),
    /** The order's receipt; equals the ledger's order_ref. */
    receipt: text('receipt'),
    amountPaise: paise('amount_paise').notNull(),
    /** Razorpay's fee INCLUDING GST; the base fee is fee_paise - tax_paise. */
    feePaise: paise('fee_paise').notNull(),
    taxPaise: paise('tax_paise').notNull(),
    amountRefundedPaise: paise('amount_refunded_paise')
      .notNull()
      .default(sql`0`),
    method: text('method').notNull(),
    status: paymentStatus('status').notNull(),
    captured: boolean('captured').notNull(),
    rzpCreatedAt: timestamp('rzp_created_at', { withTimezone: true }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
  },
  (t) => [
    uniqueIndex('rzp_payments_run_source_ref_uq').on(t.runId, t.sourceRef),
    uniqueIndex('rzp_payments_run_rzp_id_uq').on(t.runId, t.rzpId),
    index('rzp_payments_run_order_idx').on(t.runId, t.rzpOrderId),
    index('rzp_payments_run_receipt_idx').on(t.runId, t.receipt),
    sha256Check('rzp_payments', t.importHash),
    check('rzp_payments_amount_nonneg', sql`${t.amountPaise} >= 0`),
    check('rzp_payments_fee_nonneg', sql`${t.feePaise} >= 0`),
    check(
      'rzp_payments_tax_within_fee',
      sql`${t.taxPaise} >= 0 and ${t.taxPaise} <= ${t.feePaise}`,
    ),
    check(
      'rzp_payments_refunded_within_amount',
      sql`${t.amountRefundedPaise} >= 0 and ${t.amountRefundedPaise} <= ${t.amountPaise}`,
    ),
  ],
);

export const rzpRefunds = pgTable(
  'rzp_refunds',
  {
    ...sourceColumns(),
    rzpId: text('rzp_id').notNull(),
    /** Razorpay's id of the refunded payment (always known)... */
    rzpPaymentId: text('rzp_payment_id').notNull(),
    /** ...and our row for it, null when that payment is not in this run's data. */
    paymentId: uuid('payment_id').references(() => rzpPayments.id, { onDelete: 'restrict' }),
    currency: text('currency').notNull().default('INR'),
    amountPaise: paise('amount_paise').notNull(),
    status: text('status').notNull(),
    rzpCreatedAt: timestamp('rzp_created_at', { withTimezone: true }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
  },
  (t) => [
    uniqueIndex('rzp_refunds_run_source_ref_uq').on(t.runId, t.sourceRef),
    uniqueIndex('rzp_refunds_run_rzp_id_uq').on(t.runId, t.rzpId),
    index('rzp_refunds_run_rzp_payment_idx').on(t.runId, t.rzpPaymentId),
    sha256Check('rzp_refunds', t.importHash),
    check('rzp_refunds_amount_nonneg', sql`${t.amountPaise} >= 0`),
  ],
);

export const rzpSettlements = pgTable(
  'rzp_settlements',
  {
    ...sourceColumns(),
    rzpId: text('rzp_id').notNull(),
    /** Net payout. */
    amountPaise: paise('amount_paise').notNull(),
    /** Informational (0 for a normal settlement per the docs); the items hold the real fees. */
    feesPaise: paise('fees_paise').notNull(),
    taxPaise: paise('tax_paise').notNull(),
    utr: text('utr'),
    status: settlementStatus('status').notNull(),
    rzpCreatedAt: timestamp('rzp_created_at', { withTimezone: true }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
  },
  (t) => [
    uniqueIndex('rzp_settlements_run_source_ref_uq').on(t.runId, t.sourceRef),
    uniqueIndex('rzp_settlements_run_rzp_id_uq').on(t.runId, t.rzpId),
    index('rzp_settlements_run_utr_idx').on(t.runId, t.utr),
    sha256Check('rzp_settlements', t.importHash),
    check('rzp_settlements_amount_nonneg', sql`${t.amountPaise} >= 0`),
    check('rzp_settlements_fees_nonneg', sql`${t.feesPaise} >= 0 and ${t.taxPaise} >= 0`),
  ],
);

/** One line of Razorpay's settlement recon report: which payments/refunds/adjustments a payout holds. */
export const settlementItems = pgTable(
  'settlement_items',
  {
    ...sourceColumns(),
    settlementId: uuid('settlement_id')
      .notNull()
      .references(() => rzpSettlements.id, { onDelete: 'restrict' }),
    itemType: settlementItemType('item_type').notNull(),
    /** The settled transaction's Razorpay id (pay_..., rfnd_..., an adjustment or transfer id). */
    rzpEntityId: text('rzp_entity_id').notNull(),
    rzpPaymentId: text('rzp_payment_id'),
    rzpOrderId: text('rzp_order_id'),
    currency: text('currency').notNull().default('INR'),
    paymentId: uuid('payment_id').references(() => rzpPayments.id, { onDelete: 'restrict' }),
    refundId: uuid('refund_id').references(() => rzpRefunds.id, { onDelete: 'restrict' }),
    amountPaise: paise('amount_paise').notNull(),
    feePaise: paise('fee_paise').notNull(),
    taxPaise: paise('tax_paise').notNull(),
    debitPaise: paise('debit_paise').notNull(),
    creditPaise: paise('credit_paise').notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    description: text('description'),
  },
  (t) => [
    uniqueIndex('settlement_items_run_source_ref_uq').on(t.runId, t.sourceRef),
    index('settlement_items_settlement_idx').on(t.settlementId),
    index('settlement_items_payment_idx').on(t.paymentId),
    sha256Check('settlement_items', t.importHash),
    check(
      'settlement_items_amounts_nonneg',
      sql`${t.amountPaise} >= 0 and ${t.feePaise} >= 0 and ${t.taxPaise} >= 0 and ${t.debitPaise} >= 0 and ${t.creditPaise} >= 0`,
    ),
  ],
);

export const bankLines = pgTable(
  'bank_lines',
  {
    ...sourceColumns(),
    valueDate: date('value_date', { mode: 'string' }).notNull(),
    direction: bankDirection('direction').notNull(),
    amountPaise: paise('amount_paise').notNull(),
    /** Free text from the statement. Untrusted. */
    narration: text('narration').notNull(),
    /** Extracted from the narration by normalization; null if absent or unrecoverable. */
    utr: text('utr'),
    /** How far to trust `utr` (a `truncated` one is a fragment, a `repaired` one a correction). */
    utrQuality: utrQuality('utr_quality'),
    /** Running balance when the statement has one. Signed: overdrafts exist. */
    balancePaise: paise('balance_paise'),
  },
  (t) => [
    uniqueIndex('bank_lines_run_source_ref_uq').on(t.runId, t.sourceRef),
    index('bank_lines_run_utr_idx').on(t.runId, t.utr),
    index('bank_lines_run_date_amount_idx').on(t.runId, t.valueDate, t.amountPaise),
    sha256Check('bank_lines', t.importHash),
    check('bank_lines_amount_nonneg', sql`${t.amountPaise} >= 0`),
    check('bank_lines_utr_quality_in_step', sql`(${t.utr} is null) = (${t.utrQuality} is null)`),
  ],
);

// --- matching ----------------------------------------------------------------------------------

/**
 * `order` groups: ledger entries <-> payments/refunds. `payout` groups: a settlement <-> a bank line.
 * Which payments a settlement holds comes from settlement_items, not from a group, so a record is
 * in at most one accepted group (enforced on match_links).
 */
export const matchGroups = pgTable(
  'match_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconRuns.id, { onDelete: 'restrict' }),
    kind: matchGroupKind('kind').notNull(),
    status: matchGroupStatus('status').notNull(),
    basis: matchBasis('basis').notNull(),
    tier: matchTier('tier'),
    /** The rule that made a rule-basis match (e.g. T1.receipt-amount.v1); null for agent and human groups. */
    ruleId: text('rule_id'),
    /** What explains a known, accounted-for difference (e.g. FEE_GST_DEDUCTION), if anything. */
    reasonCode: reasonCode('reason_code'),
    /** Verifier-computed difference, signed. Must be 0 for an accepted group. */
    residualPaise: paise('residual_paise')
      .notNull()
      .default(sql`0`),
    createdAt: createdAt(),
  },
  (t) => [
    // Target of match_links' composite foreign key, so a link can mirror its group's status.
    unique('match_groups_id_status_uq').on(t.id, t.status),
    index('match_groups_run_idx').on(t.runId),
    check(
      'match_groups_accepted_reconciles',
      sql`${t.status} <> 'accepted' or ${t.residualPaise} = 0`,
    ),
    check(
      'match_groups_rule_records_tier_and_rule',
      sql`${t.basis} <> 'rule' or (${t.tier} is not null and ${t.ruleId} is not null)`,
    ),
  ],
);

/**
 * Links a record to a group, with one typed foreign key per record type (real referential
 * integrity) and exactly one of them set. `group_status` mirrors the group's status through a
 * composite foreign key with ON UPDATE CASCADE, which lets a partial unique index say "a record is
 * in at most one ACCEPTED group" without a trigger, and keeps holding when a group is promoted.
 */
export const matchLinks = pgTable(
  'match_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id').notNull(),
    groupStatus: matchGroupStatus('group_status').notNull(),
    ledgerEntryId: uuid('ledger_entry_id').references(() => ledgerEntries.id, {
      onDelete: 'restrict',
    }),
    paymentId: uuid('payment_id').references(() => rzpPayments.id, { onDelete: 'restrict' }),
    refundId: uuid('refund_id').references(() => rzpRefunds.id, { onDelete: 'restrict' }),
    settlementId: uuid('settlement_id').references(() => rzpSettlements.id, {
      onDelete: 'restrict',
    }),
    bankLineId: uuid('bank_line_id').references(() => bankLines.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'match_links_group_fk',
      columns: [t.groupId, t.groupStatus],
      foreignColumns: [matchGroups.id, matchGroups.status],
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check(
      'match_links_exactly_one_record',
      sql`num_nonnulls(${t.ledgerEntryId}, ${t.paymentId}, ${t.refundId}, ${t.settlementId}, ${t.bankLineId}) = 1`,
    ),
    uniqueIndex('match_links_one_accepted_ledger_entry')
      .on(t.ledgerEntryId)
      .where(sql`${t.groupStatus} = 'accepted'`),
    uniqueIndex('match_links_one_accepted_payment')
      .on(t.paymentId)
      .where(sql`${t.groupStatus} = 'accepted'`),
    uniqueIndex('match_links_one_accepted_refund')
      .on(t.refundId)
      .where(sql`${t.groupStatus} = 'accepted'`),
    uniqueIndex('match_links_one_accepted_settlement')
      .on(t.settlementId)
      .where(sql`${t.groupStatus} = 'accepted'`),
    uniqueIndex('match_links_one_accepted_bank_line')
      .on(t.bankLineId)
      .where(sql`${t.groupStatus} = 'accepted'`),
    index('match_links_group_idx').on(t.groupId),
  ],
);

// --- investigation -----------------------------------------------------------------------------

/** A record the rules could not match safely. The subject is polymorphic (type + id, no FK). */
export const reconExceptions = pgTable(
  'recon_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconRuns.id, { onDelete: 'restrict' }),
    reasonCode: reasonCode('reason_code').notNull(),
    status: exceptionStatus('status').notNull().default('open'),
    subjectType: recordType('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    /** RecordRef[] of the candidates the rules found. */
    candidates: jsonb('candidates').$type<Json[]>().notNull().default([]),
    /** The unexplained difference, signed. */
    amountAtStakePaise: paise('amount_at_stake_paise')
      .notNull()
      .default(sql`0`),
    /** The rules' machine-readable reason for raising it (e.g. receipt_amount_differs). Trusted. */
    cause: text('cause'),
    /** The rules' one-sentence description of what they saw. Trusted: generated, not quoted. */
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    // One exception per record per run; reclassification updates it in place.
    uniqueIndex('recon_exceptions_run_subject_uq').on(t.runId, t.subjectType, t.subjectId),
    index('recon_exceptions_run_status_idx').on(t.runId, t.status),
  ],
);

/** Every model call, for the daily budget, the audit trail and the cost numbers in the README. */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconRuns.id, { onDelete: 'restrict' }),
    exceptionId: uuid('exception_id').references(() => reconExceptions.id, {
      onDelete: 'restrict',
    }),
    model: text('model').notNull(),
    harness: harness('harness').notNull(),
    tokensIn: integer('tokens_in').notNull(),
    tokensOut: integer('tokens_out').notNull(),
    /** USD spend: exact decimal, read back as a string. Not merchant money. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull(),
    latencyMs: integer('latency_ms').notNull(),
    /** sha-256 of the prompt: identifies it without storing untrusted text twice. */
    promptHash: char('prompt_hash', { length: 64 }).notNull(),
    /** Input tokens read from / written to the prompt cache; `tokens_in` is the uncached remainder. */
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    /** Why the model stopped: end_turn, tool_use, max_tokens, refusal... */
    stopReason: text('stop_reason'),
    /** Anthropic's request id, for support and for tracing one call end to end. */
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (t) => [
    check('llm_calls_cache_nonneg', sql`${t.cacheReadTokens} >= 0 and ${t.cacheWriteTokens} >= 0`),
    index('llm_calls_run_idx').on(t.runId),
    index('llm_calls_created_idx').on(t.createdAt),
    sha256Check('llm_calls', t.promptHash),
    check(
      'llm_calls_nonneg',
      sql`${t.tokensIn} >= 0 and ${t.tokensOut} >= 0 and ${t.costUsd} >= 0 and ${t.latencyMs} >= 0`,
    ),
  ],
);

export const agentProposals = pgTable(
  'agent_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconRuns.id, { onDelete: 'restrict' }),
    exceptionId: uuid('exception_id')
      .notNull()
      .references(() => reconExceptions.id, { onDelete: 'restrict' }),
    /** The last model call of the investigation. */
    llmCallId: uuid('llm_call_id').references(() => llmCalls.id, { onDelete: 'restrict' }),
    /** Which investigation of the exception this is. (exception_id, attempt) is unique: idempotency. */
    attempt: integer('attempt').notNull().default(1),
    /** Shared by the proposals that came out of one clustered investigation. */
    clusterId: uuid('cluster_id'),
    model: text('model'),
    verdict: agentVerdict('verdict').notNull(),
    reasonCode: reasonCode('reason_code').notNull(),
    /** RecordRef[] the agent proposes to link. A claim, not a match. */
    links: jsonb('links').$type<Json[]>().notNull(),
    /** LLM-written text. Untrusted. */
    explanation: text('explanation').notNull(),
    /** {tool, args, keyFinding}[], each checked by the harness against the calls actually made. */
    evidence: jsonb('evidence').$type<Json[]>().notNull(),
    /** 0 to 1000 (per-mille). The model's own certainty, not a probability anyone has calibrated. */
    confidencePermille: smallint('confidence_permille').notNull(),
    suggestedAction: suggestedAction('suggested_action').notNull(),
    /** A balanced draft entry for the books, or null. Never posted automatically. */
    draftJournalEntry: jsonb('draft_journal_entry').$type<Json>(),
    /** Why the harness changed or limited what the model said. */
    harnessFindings: jsonb('harness_findings').$type<string[]>().notNull().default([]),
    /**
     * Set when the harness could not get a conclusion and handed the exception to a person: the model API did
     * not answer, its reply was unusable, a budget ran out, it declined. Null for a conclusion, including the
     * model's own "I cannot tell". A code, so it can be counted; the prose is in the explanation.
     */
    degraded: text('degraded'),
    verifierStatus: verifierStatus('verifier_status').notNull().default('pending'),
    verifierFindings: jsonb('verifier_findings').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_proposals_exception_idx').on(t.exceptionId),
    uniqueIndex('agent_proposals_exception_attempt_uq').on(t.exceptionId, t.attempt),
    check('agent_proposals_attempt_positive', sql`${t.attempt} >= 1`),
    check(
      'agent_proposals_degraded_known',
      sql`${t.degraded} is null or ${t.degraded} in (${sql.raw(DEGRADED_REASONS.map((r) => `'${r}'`).join(', '))})`,
    ),
    check(
      'agent_proposals_confidence_range',
      sql`${t.confidencePermille} >= 0 and ${t.confidencePermille} <= 1000`,
    ),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconRuns.id, { onDelete: 'restrict' }),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => agentProposals.id, { onDelete: 'restrict' }),
    decision: reviewDecision('decision').notNull(),
    reviewerKind: reviewerKind('reviewer_kind').notNull(),
    reviewer: text('reviewer').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    // One decision per proposal; a changed mind is a new proposal, not an edited review.
    uniqueIndex('reviews_proposal_uq').on(t.proposalId),
  ],
);

// --- audit -------------------------------------------------------------------------------------

/**
 * Append-only (CLAUDE.md §4.7). A Postgres trigger (migration 0001) rejects UPDATE, DELETE and
 * TRUNCATE. It stops the application; a table owner or superuser could still drop it, so the app
 * must not connect as the owner in production.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid('run_id').references(() => reconRuns.id, { onDelete: 'restrict' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actor: actor('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    detail: jsonb('detail').$type<Json>().notNull().default({}),
  },
  (t) => [
    index('audit_events_run_idx').on(t.runId, t.id),
    index('audit_events_entity_idx').on(t.entityType, t.entityId),
  ],
);

/**
 * Which source records an audit event is about. An event names its own entity (a proposal, a group, a
 * review) but is also "about" the ledger entries, payments and bank lines involved; this index is what
 * lets GET /records/:id/audit list everything that ever touched one record without scanning JSON.
 * Append-only like audit_events (migration 0007 adds the same trigger).
 */
export const auditEventRecords = pgTable(
  'audit_event_records',
  {
    auditEventId: bigint('audit_event_id', { mode: 'bigint' })
      .notNull()
      .references(() => auditEvents.id, { onDelete: 'restrict' }),
    recordType: recordType('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.auditEventId, t.recordType, t.recordId] }),
    index('audit_event_records_record_idx').on(t.recordId, t.auditEventId),
  ],
);
