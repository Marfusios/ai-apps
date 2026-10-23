import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema> & { $client: pg.Pool };
/** A database handle or an open transaction on it. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Connection timeouts (task 10e fix round 2). Every pool and client this app opens has a
 * finite one: without it, a server that accepts TCP and then stalls in the PostgreSQL
 * handshake keeps the connecting client in its pool slot forever, every later
 * acquisition waits behind it, and `pool.end()` never finishes.
 *
 * For a pool, node-postgres uses one setting (`connectionTimeoutMillis`) for two waits:
 * opening a new connection (TCP, startup and authentication; a stalled attempt is
 * destroyed and its slot freed) and waiting in the queue for a free connection (the
 * acquisition fails, also while the pool is ending). A single client uses it for opening
 * only.
 *
 * - `DB_CONNECT_TIMEOUT_MS` (5 s): the API's pool, every tool's pool (`createDb`'s
 *   default) and every single client. Request-path reads have their own, shorter bound
 *   (the cases index lookup: 2 s, `server/db/bounded-read.ts`), which decides the
 *   request; the pool's timeout then clears what the request abandoned. It is shorter
 *   than the retrieve stage (8 s) and the server's shutdown grace (9 s, then a forced exit
 *   at 10 s), so a stalled connection is gone before shutdown closes the pool.
 * - `WORKER_DB_CONNECT_TIMEOUT_MS` (120 s): the worker's pools. They are sized so that
 *   their long holds (build locks, snapshot streams) never queue another acquisition, so
 *   the bound only has to end a stalled server; it matches the longest waits a worker
 *   command already accepts (its Elasticsearch requests and the alias lock, 120 s).
 */
export const DB_CONNECT_TIMEOUT_MS = 5_000;
export const WORKER_DB_CONNECT_TIMEOUT_MS = 120_000;

export interface CreateDbOptions {
  /** Pool size (default 4). */
  max?: number;
  /** Shown in pg_stat_activity. */
  applicationName?: string;
  /** Opening a connection, or waiting for a free one (module comment; default `DB_CONNECT_TIMEOUT_MS`). */
  connectTimeoutMs?: number;
}

/** A finite, positive whole number of milliseconds: node-postgres reads 0 as "no timeout". */
export function checkConnectTimeout(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 1) throw new Error('invalid database connect timeout');
  return ms;
}

/** Drizzle over a `pg` pool. Close it with `closeDb`. */
export function createDb(url: string, opts: CreateDbOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 4,
    application_name: opts.applicationName ?? 'aviation-casebook',
    connectionTimeoutMillis: checkConnectTimeout(opts.connectTimeoutMs ?? DB_CONNECT_TIMEOUT_MS),
  });
  return drizzle({ client: pool, schema });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}
