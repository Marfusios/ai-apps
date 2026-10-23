/**
 * One read-only statement bounded by a deadline and a caller's signal (task 10e fix
 * round 1, gate finding 1): AI retrieval reads the manifest's cases index on the
 * request path, so a stalled pool or database must not hold the retrieve stage, and
 * abandoned work must not leak pool capacity.
 *
 * - **Acquisition** races the bound. A connection the pool hands over after the bound
 *   has passed is released straight back, so a late acquisition never strands a slot.
 *   An acquisition that never completes (a server that stalls in the handshake, a queue
 *   that does not move) is ended by the pool's own connect timeout (server/db/client.ts),
 *   so neither the connecting client nor the queued waiter outlives it, and the pool can
 *   still shut down.
 * - **Execution** is bounded twice: on the server by `SET LOCAL statement_timeout` (the
 *   statement runs in its own read-only transaction, so the setting never outlives it),
 *   and here by the same bound and the caller's signal. When either ends the wait first,
 *   the connection is destroyed (released with an error) instead of being returned while
 *   a statement may still run on it: its pool slot is free at once, and the server stops
 *   the statement at its timeout at the latest.
 * - The error is `BoundedReadTimeoutError` when the bound elapsed (here, or on the server
 *   as its statement timeout, SQLSTATE 57014), the signal's reason when the caller
 *   aborted, and the database's error otherwise. None of them is passed to a client by
 *   the callers (fixed failure categories only).
 */
import type pg from 'pg';

export class BoundedReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`the database read did not finish within ${ms} ms`);
    this.name = 'BoundedReadTimeoutError';
  }
}

/**
 * `work`, or a rejection as soon as `signal` aborts (with `onAbort(reason)` as the error);
 * a late rejection of `work` is observed so it never goes unhandled.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal, onAbort: (reason: unknown) => unknown = (r) => r): Promise<T> {
  work.catch(() => undefined);
  if (signal.aborted) return Promise.reject(onAbort(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort(signal.reason));
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
  });
}

export interface BoundedReadOptions {
  /** The bound of acquisition and execution together. */
  timeoutMs: number;
  /** The caller's cancellation (a request's deadline or a cancel). */
  signal?: AbortSignal;
}

/** Run one read-only `text` with `values` within the bound (module comment); its rows. */
export async function boundedRead<R>(pool: pg.Pool, text: string, values: readonly unknown[], opts: BoundedReadOptions): Promise<R[]> {
  if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1) throw new Error('invalid bounded read timeout');
  const started = performance.now();
  const timer = new AbortController();
  const t = setTimeout(() => timer.abort(new BoundedReadTimeoutError(opts.timeoutMs)), opts.timeoutMs);
  const bound = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
  try {
    bound.throwIfAborted();
    const acquiring = pool.connect();
    let client: pg.PoolClient;
    try {
      client = await untilAborted(acquiring, bound);
    } catch (err) {
      // A connection that arrives after the bound goes straight back to the pool.
      acquiring.then((c) => c.release(), () => undefined);
      throw err;
    }
    const remaining = Math.max(1, Math.floor(opts.timeoutMs - (performance.now() - started)));
    const work = (async () => {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${remaining}`);
      const res = await client.query({ text, values: [...values] });
      await client.query('COMMIT');
      return res.rows as R[];
    })();
    try {
      const rows = await untilAborted(work, bound);
      client.release();
      return rows;
    } catch (err) {
      // Never return a connection that may still run a statement: destroy it.
      client.release(err instanceof Error ? err : new Error('bounded read failed'));
      // The server's statement timeout is the same bound, enforced there (SQLSTATE 57014).
      if ((err as { code?: unknown }).code === '57014' && !opts.signal?.aborted) throw new BoundedReadTimeoutError(opts.timeoutMs);
      throw err;
    }
  } finally {
    clearTimeout(t);
  }
}
