import { readdirSync } from 'node:fs';
import {
  ACTORS,
  BANK_DIRECTIONS,
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
  VERIFIER_STATUSES,
} from '@ziro/core/domain';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDb, MIGRATIONS_FOLDER } from './migrated-db.fixtures.js';

let ctx: Awaited<ReturnType<typeof createMigratedDb>>;

beforeAll(async () => {
  // Fresh database + the real migrator: this is the "migrations apply on a fresh DB" check.
  ctx = await createMigratedDb();
});
afterAll(async () => {
  await ctx.client.close();
});

const names = async (sql: string, params: unknown[] = []): Promise<string[]> => {
  const { rows } = await ctx.client.query<{ name: string }>(sql, params);
  return rows.map((r) => r.name);
};

const EXPECTED_TABLES = [
  'agent_proposals',
  'audit_event_records',
  'audit_events',
  'bank_lines',
  'ledger_entries',
  'llm_cache',
  'llm_calls',
  'match_groups',
  'match_links',
  'recon_exceptions',
  'recon_runs',
  'reviews',
  'rzp_payments',
  'rzp_refunds',
  'rzp_settlements',
  'settlement_items',
];

describe('migrations on a fresh database', () => {
  it('create exactly the 16 expected tables', async () => {
    const tables = await names(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  it('record every migration file as applied', async () => {
    const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql'));
    const { rows } = await ctx.client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.n).toBe(files.length);
  });

  it('can be run again as a no-op', async () => {
    await expect(migrate(ctx.db, { migrationsFolder: MIGRATIONS_FOLDER })).resolves.not.toThrow();
    const tables = await names(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    expect(tables).toEqual(EXPECTED_TABLES);
  });
});

describe('money is integer paise', () => {
  it('stores every *_paise column as bigint', async () => {
    const { rows } = await ctx.client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%\\_paise'`,
    );
    expect(rows.length).toBeGreaterThan(15);
    expect(rows.filter((r) => r.data_type !== 'bigint')).toEqual([]);
  });

  it('has no float or decimal column except the two USD columns of llm_calls (LLM spend, not merchant money)', async () => {
    const found = await names(
      `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type IN ('numeric', 'real', 'double precision', 'money')
       ORDER BY 1`,
    );
    expect(found).toEqual(['llm_calls.cost_usd', 'llm_calls.est_cost_usd']);
  });
});

describe('every source record carries run_id, source, source_ref, import_hash', () => {
  const SOURCE_TABLES = [
    'ledger_entries',
    'rzp_payments',
    'rzp_refunds',
    'rzp_settlements',
    'settlement_items',
    'bank_lines',
  ];

  it.each(SOURCE_TABLES)('%s', async (table) => {
    const { rows } = await ctx.client.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
         AND column_name IN ('run_id', 'source', 'source_ref', 'import_hash')`,
      [table],
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'import_hash',
      'run_id',
      'source',
      'source_ref',
    ]);
    expect(rows.every((r) => r.is_nullable === 'NO')).toBe(true);
  });
});

describe('database enums match the domain lists in @ziro/core', () => {
  // If a list changes in core (e.g. a new reason code via an ADR) without a migration, this fails.
  const ENUMS: readonly (readonly [string, readonly string[]])[] = [
    ['reason_code', REASON_CODES],
    ['record_source', SOURCES],
    ['record_type', RECORD_TYPES],
    ['actor', ACTORS],
    ['match_group_kind', MATCH_GROUP_KINDS],
    ['match_group_status', MATCH_GROUP_STATUSES],
    ['match_basis', MATCH_BASES],
    ['match_tier', MATCH_TIERS],
    ['payment_status', PAYMENT_STATUSES],
    ['settlement_status', SETTLEMENT_STATUSES],
    ['settlement_item_type', SETTLEMENT_ITEM_TYPES],
    ['bank_direction', BANK_DIRECTIONS],
    ['exception_status', EXCEPTION_STATUSES],
    ['verifier_status', VERIFIER_STATUSES],
    ['review_decision', REVIEW_DECISIONS],
    ['reviewer_kind', REVIEWER_KINDS],
  ];

  it.each(ENUMS)('%s', async (typeName, domainValues) => {
    const labels = await names(
      `SELECT e.enumlabel AS name FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = $1 ORDER BY e.enumsortorder`,
      [typeName],
    );
    expect(labels).toEqual([...domainValues]);
  });

  it('reason_code is exactly the 14 codes of CLAUDE.md §8', async () => {
    const labels = await names(
      `SELECT e.enumlabel AS name FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'reason_code' ORDER BY e.enumsortorder`,
    );
    expect(labels).toHaveLength(14);
  });
});
