// The production migration path on a REAL Postgres server, in a scratch database made and dropped here:
// the same runMigrations the deploy job calls, with the driver and lock it really uses.
//
//   RUN_PG_SMOKE=1 npm test -w @ziro/api -- src/scripts/migrate.pg.test.ts
//
// Like the other smoke tests it uses DATABASE_URL for credentials, refuses any host that is not this
// machine, and never touches the database named in the URL.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../config/dotenv.js';
import { grantAppRole, MIGRATIONS_FOLDER, runMigrations } from './migrate.js';

const ENABLED = process.env['RUN_PG_SMOKE'] === '1';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

describe.skipIf(!ENABLED)('runMigrations on a real Postgres server (scratch database)', () => {
  let admin: Pool;
  let scratch = '';
  let scratchUrl = '';

  beforeAll(async () => {
    loadDotEnv();
    const raw = process.env['DATABASE_URL'];
    if (!raw) throw new Error('DATABASE_URL is not set');
    const url = new URL(raw);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(
        `refusing to run against ${url.hostname}: this test only uses a local server`,
      );
    }
    scratch = `ziro_migrate_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    admin = new Pool({ connectionString: raw, max: 1 });
    await admin.query(`CREATE DATABASE ${scratch}`);
    url.pathname = `/${scratch}`;
    scratchUrl = url.toString();
  });

  afterAll(async () => {
    if (scratch !== '') await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin.end();
  });

  const inScratch = async <T>(sqlText: string): Promise<T[]> => {
    const pool = new Pool({ connectionString: scratchUrl, max: 1 });
    try {
      return (await pool.query(sqlText)).rows as T[];
    } finally {
      await pool.end();
    }
  };

  const journalEntries = (): number =>
    (
      JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as {
        entries: unknown[];
      }
    ).entries.length;

  it('applies every migration on an empty database, including the audit trigger', async () => {
    await runMigrations(scratchUrl);
    const [applied] = await inScratch<{ n: number }>(
      'select count(*)::int n from drizzle.__drizzle_migrations',
    );
    expect(applied?.n).toBe(journalEntries());
    const triggers = await inScratch<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid = 'audit_events'::regclass and not tgisinternal`,
    );
    expect(triggers.length).toBeGreaterThan(0);
  });

  it('is a no-op the second time', async () => {
    await runMigrations(scratchUrl);
    const [applied] = await inScratch<{ n: number }>(
      'select count(*)::int n from drizzle.__drizzle_migrations',
    );
    expect(applied?.n).toBe(journalEntries());
  });

  it('survives two deploys migrating at the same moment', async () => {
    const other = scratchUrl.replace(scratch, `${scratch}_b`);
    await admin.query(`CREATE DATABASE ${scratch}_b`);
    try {
      await Promise.all([runMigrations(other), runMigrations(other)]);
      const pool = new Pool({ connectionString: other, max: 1 });
      try {
        const rows = (await pool.query('select count(*)::int n from drizzle.__drizzle_migrations'))
          .rows as { n: number }[];
        expect(rows[0]?.n).toBe(journalEntries());
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${scratch}_b WITH (FORCE)`);
    }
  });

  it('fails loudly, and does not hang, on a database it cannot reach', async () => {
    await expect(runMigrations('postgres://nobody:nothing@127.0.0.1:1/none')).rejects.toThrow();
  });
});

describe.skipIf(!ENABLED)('grantAppRole on a real Postgres server', () => {
  let admin: Pool;
  let scratch = '';
  let scratchUrl = '';
  const role = `ziro_app_t${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const rolePassword = 'app-role-test-password';

  beforeAll(async () => {
    loadDotEnv();
    const raw = process.env['DATABASE_URL'];
    if (!raw) throw new Error('DATABASE_URL is not set');
    const url = new URL(raw);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(
        `refusing to run against ${url.hostname}: this test only uses a local server`,
      );
    }
    scratch = `ziro_grants_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    admin = new Pool({ connectionString: raw, max: 1 });
    await admin.query(`CREATE DATABASE ${scratch}`);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}'`);
    url.pathname = `/${scratch}`;
    scratchUrl = url.toString();
    await runMigrations(scratchUrl);
    await grantAppRole(scratchUrl, role);
  });

  afterAll(async () => {
    if (scratch !== '') await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  /** A connection as the application role. */
  const asApp = (): Pool => {
    const url = new URL(scratchUrl);
    url.username = role;
    url.password = rolePassword;
    return new Pool({ connectionString: url.toString(), max: 1 });
  };

  it('lets the application read and write rows, and add to the audit trail', async () => {
    const app = asApp();
    try {
      await app.query(
        `insert into recon_runs (razorpay_source, period_start, period_end) values ('synthetic', '2026-09-01', '2026-09-30')`,
      );
      expect((await app.query('select id from recon_runs')).rowCount).toBe(1);
      await app.query(`update recon_runs set status = 'matching'`);
      await app.query(
        `insert into audit_events (actor, action, entity_type, entity_id) values ('system', 'test', 'test', '1')`,
      );
      expect((await app.query('select id from audit_events')).rowCount).toBe(1);
    } finally {
      await app.end();
    }
  });

  it('refuses to change or remove what the audit trail holds, at the privilege, before the trigger', async () => {
    const app = asApp();
    try {
      await expect(app.query(`update audit_events set action = 'x'`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.query('delete from audit_events')).rejects.toThrow(/permission denied/);
      await expect(app.query('truncate audit_events')).rejects.toThrow(/permission denied/);
      await expect(app.query('delete from recon_runs')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });

  it('cannot turn the append-only trigger off: it does not own the table', async () => {
    const app = asApp();
    try {
      await expect(app.query('alter table audit_events disable trigger all')).rejects.toThrow(
        /must be owner|permission denied/,
      );
    } finally {
      await app.end();
    }
  });

  it('covers a table added by a later deploy, because it is granted again every time', async () => {
    const owner = new Pool({ connectionString: scratchUrl, max: 1 });
    try {
      await owner.query('create table later_table (id int primary key)');
    } finally {
      await owner.end();
    }
    const app = asApp();
    try {
      await expect(app.query('select * from later_table')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
    await grantAppRole(scratchUrl, role);
    const again = asApp();
    try {
      await again.query('insert into later_table values (1)');
    } finally {
      await again.end();
    }
  });

  it('refuses a role that does not exist, and a name that is not a plain identifier', async () => {
    await expect(grantAppRole(scratchUrl, 'no_such_role_here')).rejects.toThrow(/does not exist/);
    await expect(grantAppRole(scratchUrl, 'x"; drop table audit_events; --')).rejects.toThrow(
      /not a usable/,
    );
    await expect(grantAppRole(scratchUrl, 'Upper')).rejects.toThrow(/not a usable/);
  });
});
