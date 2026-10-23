/**
 * Connection timeouts (server/db/client.ts; task 10e fix round 2, the gate's finding on
 * round 1): a server that accepts TCP and never answers the PostgreSQL handshake. Without
 * a pool timeout the connecting client keeps its slot, a queued acquisition waits behind
 * it and `pool.end()` never finishes, although every bounded read already returned. With
 * `createDb`'s timeout the connecting client is destroyed, the waiter expires and
 * shutdown completes, and the fake server is never closed for it.
 */
import { createServer, type Server, type Socket } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHUTDOWN_GRACE_MS } from '../../server/app.js';
import { BoundedReadTimeoutError, boundedRead } from '../../server/db/bounded-read.js';
import { DB_CONNECT_TIMEOUT_MS, WORKER_DB_CONNECT_TIMEOUT_MS, closeDb, createDb } from '../../server/db/client.js';

/** Accepts every connection and never sends a byte. */
let server: Server;
let url: string;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  url = `postgres://nobody:nothing@127.0.0.1:${address.port}/nowhere`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** `p`'s outcome, or 'pending' if it has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([p, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);

const poolState = (pool: pg.Pool) => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
}

describe('database connection timeouts', () => {
  it('every pool gets a finite timeout: 5 s by default and for the API, 120 s for the worker', async () => {
    const db = createDb(url);
    expect(db.$client.options.connectionTimeoutMillis).toBe(DB_CONNECT_TIMEOUT_MS);
    await closeDb(db);
    const worker = createDb(url, { connectTimeoutMs: WORKER_DB_CONNECT_TIMEOUT_MS });
    expect(worker.$client.options.connectionTimeoutMillis).toBe(120_000);
    await closeDb(worker);
    expect(DB_CONNECT_TIMEOUT_MS).toBe(5_000);
    // A stalled connection is gone before the server's shutdown grace runs out.
    expect(DB_CONNECT_TIMEOUT_MS).toBeLessThan(SHUTDOWN_GRACE_MS);
    // node-postgres reads 0 as "no timeout": never accepted.
    for (const connectTimeoutMs of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => createDb(url, { connectTimeoutMs })).toThrow('invalid database connect timeout');
    }
  });

  it('a stalled handshake: the connecting client and the queued waiter expire, and shutdown completes', async () => {
    // The pool's bound well above the reads' own, so the state in between is observable.
    const db = createDb(url, { max: 1, connectTimeoutMs: 1_000 });
    const pool = db.$client;
    // The gate's reproduction: one slot, two reads, both end at their own bound.
    const reads = await Promise.all([0, 1].map(() => boundedRead(pool, 'select 1', [], { timeoutMs: 100 }).catch((e: unknown) => e)));
    for (const r of reads) expect(r).toBeInstanceOf(BoundedReadTimeoutError);
    // What they abandoned is still there: the connecting client and the queued acquisition.
    expect(poolState(pool)).toEqual({ total: 1, idle: 0, waiting: 1 });
    expect(sockets.size).toBeGreaterThan(0);
    // The pool's timeout clears both (a retry for the waiter, if one starts, expires too).
    expect(await until(() => pool.totalCount === 0 && pool.waitingCount === 0, 5_000)).toBe(true);
    // Shutdown completes; the fake server is still accepting and was never closed.
    expect(await within(closeDb(db), 5_000)).toBeUndefined();
    expect(server.listening).toBe(true);
  });

  it('shutdown while a connection is stalled and an acquisition is queued: both fail and end() returns', async () => {
    const db = createDb(url, { max: 1, connectTimeoutMs: 1_000 });
    const pool = db.$client;
    const connecting = pool.connect().then(
      () => 'connected',
      (e: unknown) => e,
    );
    const queued = pool.connect().then(
      () => 'connected',
      (e: unknown) => e,
    );
    await until(() => pool.waitingCount === 1, 1_000);
    expect(poolState(pool)).toEqual({ total: 1, idle: 0, waiting: 1 });
    const started = performance.now();
    expect(await within(closeDb(db), 5_000)).toBeUndefined();
    // Within about the pool's bound, not after the fake server gives up (it never does).
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(await within(connecting, 1_000)).toBeInstanceOf(Error);
    expect(await within(queued, 1_000)).toMatchObject({ message: 'timeout exceeded when trying to connect' });
    expect(poolState(pool)).toEqual({ total: 0, idle: 0, waiting: 0 });
  });

  it('a single client with the timeout fails its connect at the bound', async () => {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 200 });
    const started = performance.now();
    expect(await within(client.connect().then(() => 'connected', (e: unknown) => e), 3_000)).toBeInstanceOf(Error);
    expect(performance.now() - started).toBeLessThan(2_000);
    await client.end().catch(() => undefined);
  });

  it('without a pool timeout (the pool before this fix) the slot, the waiter and shutdown stay stuck', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const reads = await Promise.all([0, 1].map(() => boundedRead(pool, 'select 1', [], { timeoutMs: 100 }).catch((e: unknown) => e)));
    for (const r of reads) expect(r).toBeInstanceOf(BoundedReadTimeoutError);
    await new Promise((r) => setTimeout(r, 600));
    expect(poolState(pool)).toEqual({ total: 1, idle: 0, waiting: 1 });
    const ending = pool.end();
    expect(await within(ending, 500)).toBe('pending');
    // Only closing the server's side lets this pool go (its queued acquisition never settles).
    for (const s of sockets) s.destroy();
    expect(await within(ending, 3_000)).toBeUndefined();
  });
});
