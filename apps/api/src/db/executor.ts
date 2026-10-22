import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema.js';

/**
 * Anything that can run queries against the Ziro schema: the production pool, a PGlite database in
 * tests, or a transaction on either. Services take this, so the same code runs in all three places
 * and a caller decides where the transaction boundary is.
 */
export type Executor = PgDatabase<PgQueryResultHKT, typeof schema>;
