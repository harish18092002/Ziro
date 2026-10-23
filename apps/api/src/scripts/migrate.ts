// Applies the SQL migrations in apps/api/drizzle to the database in DATABASE_URL.
//
// The production image has no drizzle-kit (a dev dependency), so this uses drizzle-orm's own migrator, the
// same one the tests use on PGlite. It must be given the DIRECT (non-pooled) connection and the OWNER role:
// Neon's pooler does not support session state, and the audit trail's append-only trigger is created by the
// migrations, so the role that runs them must be the role the application is not (ADR-005, ADR-017).
//
// Safe to run at every deploy and from two places at once: a session advisory lock on the one connection
// serialises them, and a migration that is already applied is skipped.
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/** apps/api/drizzle, from apps/api/{src,dist}/scripts. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Any constant will do; it only has to be the same in every process that migrates this database. */
const LOCK_KEY = 7_330_451;

export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await migrate(drizzle({ client }), { migrationsFolder });
    } finally {
      await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

/** Roles are plain identifiers here; anything else is refused before it gets near SQL. */
export const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Gives the application's database role exactly what it needs and no more, after every migration so a new
 * table is covered the day it is created. Run as the OWNER role.
 *
 * The application reads and writes rows; it has never needed DELETE (runs are archived, not deleted), and
 * it may add to the audit trail and read it but never change it. The append-only trigger already refuses an
 * UPDATE or DELETE; taking the privilege away too means a bug cannot even reach the trigger, and a role that
 * is not the owner cannot disable the trigger (ADR-005, ADR-017).
 */
export async function grantAppRole(databaseUrl: string, role: string): Promise<void> {
  if (!ROLE_NAME.test(role)) throw new Error(`"${role}" is not a usable database role name`);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const who = client.escapeIdentifier(role);
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
    if (exists.rowCount === 0) {
      throw new Error(
        `the database role ${role} does not exist; create it first (docs/DEPLOY.md, part 1)`,
      );
    }
    await client.query('begin');
    try {
      await client.query(`grant usage on schema public to ${who}`);
      await client.query(`grant select, insert, update on all tables in schema public to ${who}`);
      await client.query(`grant usage, select on all sequences in schema public to ${who}`);
      await client.query(`revoke update on audit_events, audit_event_records from ${who}`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}
