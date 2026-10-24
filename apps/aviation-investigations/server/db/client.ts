import { Socket } from 'node:net';
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

/**
 * Execution bounds of a pool on a request path (gate 22 finding 2): `connectionTimeoutMillis`
 * ends only opening and waiting for a connection, not a statement on an established one.
 *
 * - `statementTimeoutMs`: each connection's `statement_timeout` (sent at startup; a
 *   transaction may raise it with `SET LOCAL`, as the maintenance pass does to 30 s), so
 *   the server cancels a statement that runs too long, its lock waits included.
 * - `idleInTransactionTimeoutMs`: `idle_in_transaction_session_timeout`, so the server ends
 *   a transaction its client abandoned (and releases its locks) even when the client never
 *   comes back.
 * - `transportTimeoutMs`: a watchdog on the connection itself. When nothing arrives or
 *   leaves on a connection for this long (a stalled server or network: the server's own
 *   timeout cannot answer), the connection is destroyed: the statement fails with
 *   `DatabaseTimeoutError`, its caller gets the slot back (the pool removes a connection
 *   that failed, whoever releases it), and the pool can still close. It must exceed the
 *   longest statement timeout any transaction sets on the pool; idle connections leave the
 *   pool before it (`idleTimeoutMillis` is kept below it).
 *
 * `API_DB_EXECUTION` is the API's; the worker and tools keep no execution bound (their
 * long statements and holds are expected), only the connect timeout.
 */
export interface DbExecutionBounds {
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
  transportTimeoutMs: number;
}

/**
 * The API pool's bounds: request-path statements take milliseconds, and the longest one
 * the API sets is the maintenance pass's 30 s (`SET LOCAL statement_timeout`).
 */
export const API_DB_EXECUTION: Readonly<DbExecutionBounds> = Object.freeze({
  statementTimeoutMs: 15_000,
  idleInTransactionTimeoutMs: 30_000,
  transportTimeoutMs: 45_000,
});

/** A connection the transport watchdog destroyed: nothing moved on it for its bound. */
export class DatabaseTimeoutError extends Error {
  override readonly name = 'DatabaseTimeoutError';
  readonly code = 'DB_TRANSPORT_TIMEOUT';
  constructor(ms: number) {
    super(`nothing moved on the database connection for ${ms} ms`);
  }
}

/** What a pool reports about a failed connection: the error's name and code, never its message (it may hold an address). */
export interface DbConnectionProblem {
  name: string;
  code?: string;
}

export interface CreateDbOptions {
  /** Pool size (default 4). */
  max?: number;
  /** Shown in pg_stat_activity. */
  applicationName?: string;
  /** Opening a connection, or waiting for a free one (module comment; default `DB_CONNECT_TIMEOUT_MS`). */
  connectTimeoutMs?: number;
  /** Execution bounds for a request path (`DbExecutionBounds`); none by default. */
  execution?: DbExecutionBounds;
  /**
   * Told about every connection that fails, idle or in use (gate 22 finding 3): a pool
   * without a listener would let one dropped connection (a PostgreSQL restart) end the
   * process. Default: a JSON line on stderr with the problem only.
   */
  onConnectionError?: (problem: DbConnectionProblem) => void;
}

/** A finite, positive whole number of milliseconds: node-postgres reads 0 as "no timeout". */
export function checkConnectTimeout(ms: number): number {
  if (!Number.isSafeInteger(ms) || ms < 1) throw new Error('invalid database connect timeout');
  return ms;
}

/** The name and code of a connection error, nothing else. */
export function connectionProblem(err: unknown): DbConnectionProblem {
  const e = err as { name?: unknown; code?: unknown } | null;
  const name = typeof e?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : 'Error';
  const code = typeof e?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? e.code : undefined;
  return code ? { name, code } : { name };
}

const stderrProblem = (problem: DbConnectionProblem): void => {
  process.stderr.write(`${JSON.stringify({ level: 40, msg: 'database connection failed', err: problem })}\n`);
};

/** The socket under a `pg` client (node-postgres keeps it on `connection.stream`). */
function socketOf(client: pg.PoolClient): Socket | null {
  const stream = (client as unknown as { connection?: { stream?: unknown } }).connection?.stream;
  return stream instanceof Socket ? stream : null;
}

/** Drizzle over a `pg` pool. Close it with `closeDb`. */
export function createDb(url: string, opts: CreateDbOptions = {}): Db {
  const bounds = opts.execution;
  if (bounds) {
    for (const v of Object.values(bounds)) checkConnectTimeout(v);
    if (bounds.transportTimeoutMs <= bounds.statementTimeoutMs) throw new Error('the transport bound must exceed the statement timeout');
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 4,
    application_name: opts.applicationName ?? 'aviation-casebook',
    connectionTimeoutMillis: checkConnectTimeout(opts.connectTimeoutMs ?? DB_CONNECT_TIMEOUT_MS),
    ...(bounds
      ? {
          statement_timeout: bounds.statementTimeoutMs,
          idle_in_transaction_session_timeout: bounds.idleInTransactionTimeoutMs,
          // Idle connections leave before the watchdog could see them as stalled.
          idleTimeoutMillis: Math.min(10_000, Math.floor(bounds.transportTimeoutMs / 2)),
        }
      : {}),
  });
  const report = opts.onConnectionError ?? stderrProblem;
  const reportSafely = (err: unknown) => {
    try {
      report(connectionProblem(err));
    } catch {
      // A failing reporter must not turn a handled error into an unhandled one.
    }
  };
  // Every connection handed out is tracked until its holder gives it back. One that fails
  // while held is given back at once, with its error, so the pool removes it and frees its
  // slot even if the holder never releases it: Drizzle's `transaction()` sends BEGIN before
  // its try/finally, so a connection that fails there would otherwise hold its slot for
  // ever. The holder's own release afterwards does nothing.
  const held = new Map<pg.PoolClient, (err?: Error | boolean) => void>();
  const guard = (client: pg.PoolClient): pg.PoolClient => {
    const release = client.release.bind(client);
    let done = false;
    const once = (err?: Error | boolean) => {
      if (done) return;
      done = true;
      held.delete(client);
      release(err);
    };
    held.set(client, once);
    client.release = once;
    return client;
  };
  type Callback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: Error | boolean) => void) => void;
  const connect = pool.connect.bind(pool) as (callback?: Callback) => Promise<pg.PoolClient> | undefined;
  (pool as unknown as { connect: (callback?: Callback) => Promise<pg.PoolClient> | undefined }).connect = (callback?: Callback) => {
    if (!callback) return (connect() as Promise<pg.PoolClient>).then(guard);
    return connect((err, client, done) => {
      if (client) guard(client);
      callback(err, client, client ? client.release : done);
    });
  };
  // An idle connection that fails: the pool has removed it already; a new one is opened on demand.
  pool.on('error', reportSafely);
  pool.on('connect', (client) => {
    // A connection that fails while in use: its statement fails, and it leaves the pool at once.
    client.on('error', (err: Error) => {
      reportSafely(err);
      held.get(client)?.(err);
    });
    if (bounds) {
      const socket = socketOf(client);
      socket?.setTimeout(bounds.transportTimeoutMs, () => socket.destroy(new DatabaseTimeoutError(bounds.transportTimeoutMs)));
    }
  });
  return drizzle({ client: pool, schema });
}

const UNAVAILABLE_MESSAGES = new Set([
  // pg-pool: no connection became free within `connectionTimeoutMillis`, or opening one took longer.
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  // node-postgres: the connection ended under a statement, or was already broken.
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Client has encountered a connection error and is not queryable',
  'Query read timeout',
]);
/** query_canceled (a statement timeout on the API pool), idle_in_transaction_session_timeout. */
const UNAVAILABLE_CODES = new Set(['57014', '25P03', 'DB_TRANSPORT_TIMEOUT']);

/**
 * True when a database error says the service, not the request, is at fault: no
 * connection in time, a connection that broke or stalled, or a statement the server ended
 * at its timeout (P2: answered 503, not 500). Follows `cause` (Drizzle wraps driver
 * errors in `DrizzleQueryError`).
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const x = e as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    if (x.name === 'DatabaseTimeoutError' || x.name === 'BoundedReadTimeoutError') return true;
    if (typeof x.message === 'string' && UNAVAILABLE_MESSAGES.has(x.message)) return true;
    if (typeof x.code === 'string' && UNAVAILABLE_CODES.has(x.code)) return true;
    e = x.cause;
  }
  return false;
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}
