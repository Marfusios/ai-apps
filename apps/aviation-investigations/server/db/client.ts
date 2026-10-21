import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema> & { $client: pg.Pool };
/** A database handle or an open transaction on it. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface CreateDbOptions {
  /** Pool size (default 4). */
  max?: number;
  /** Shown in pg_stat_activity. */
  applicationName?: string;
}

/** Drizzle over a `pg` pool. Close it with `closeDb`. */
export function createDb(url: string, opts: CreateDbOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 4,
    application_name: opts.applicationName ?? 'aviation-casebook',
  });
  return drizzle({ client: pool, schema });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}
