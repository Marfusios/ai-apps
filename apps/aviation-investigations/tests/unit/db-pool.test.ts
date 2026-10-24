/**
 * Database pools under failed and stalled connections (gate 22 findings 2 and 3, platform
 * review P2), offline against a fake PostgreSQL server (tests/support/fake-pg.ts):
 *
 * - a connection dropped while idle in the pool (a PostgreSQL restart) or while in use
 *   is reported, sanitized, and never ends the process; the pool opens a new one;
 * - on the API pool a statement that stalls on an established connection ends at the
 *   transport bound, its connection is destroyed, the pool serves again and closes;
 * - the health probe's database check gives back the connection it abandons, so probes
 *   against a stalled database cannot use up the pool;
 * - failures of the pool or a connection read as the service's fault (503), not the
 *   request's (500).
 */
import type { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, isUnavailable } from '../../server/app.js';
import { BoundedReadTimeoutError } from '../../server/db/bounded-read.js';
import {
  API_DB_EXECUTION,
  DatabaseTimeoutError,
  closeDb,
  connectionProblem,
  createDb,
  isDatabaseUnavailable,
  type Db,
  type DbConnectionProblem,
} from '../../server/db/client.js';
import { HEALTH_DB_TIMEOUT_MS } from '../../server/routes/health.js';
import { FakePg } from '../support/fake-pg.js';

let fake: FakePg;
const opened: Db[] = [];

beforeAll(async () => {
  fake = await FakePg.start();
});

afterEach(async () => {
  fake.mode = 'answer';
  fake.dropAll();
  await Promise.all(opened.splice(0).map((db) => closeDb(db).catch(() => undefined)));
});

afterAll(async () => {
  await fake.close();
});

function db(opts: Parameters<typeof createDb>[1] = {}): { db: Db; problems: DbConnectionProblem[] } {
  const problems: DbConnectionProblem[] = [];
  const made = createDb(fake.url, { max: 2, connectTimeoutMs: 1_000, onConnectionError: (p) => void problems.push(p), ...opts });
  opened.push(made);
  return { db: made, problems };
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return check();
}

/** `p`'s outcome, or 'pending' if it has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([p, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))]);

const select1 = (d: Db) => d.execute(sql`select 1`);

describe('a failed connection never ends the process (gate 22 finding 3)', () => {
  it('a plain pool has no listener for it: the error it emits would be unhandled', async () => {
    // The gate's probe: node-postgres emits `error` on the pool for an idle connection that fails.
    const pool = new pg.Pool({ connectionString: fake.url, max: 1, connectionTimeoutMillis: 1_000 });
    await pool.query('select 1');
    expect(pool.listenerCount('error')).toBe(0);
    const emitted: unknown[] = [];
    pool.on('error', (err) => void emitted.push(err));
    fake.dropAll();
    expect(await until(() => emitted.length === 1)).toBe(true);
    await pool.end();
  });

  it('an idle connection dropped by the server (a restart) is reported, sanitized, and replaced', async () => {
    const { db: d, problems } = db();
    await select1(d);
    expect(d.$client.idleCount).toBe(1);
    fake.dropAll();
    expect(await until(() => d.$client.totalCount === 0)).toBe(true);
    expect(problems.length).toBeGreaterThan(0);
    // Its name and code only: never the message, which may hold the server's address.
    for (const p of problems) expect(Object.keys(p).every((k) => k === 'name' || k === 'code')).toBe(true);
    const accepted = fake.accepted;
    await select1(d);
    expect(fake.accepted).toBe(accepted + 1);
  });

  it('a connection dropped while in use fails its transaction, not the process; the pool serves again', async () => {
    const { db: d, problems } = db();
    const failed = await d
      .transaction(async (tx) => {
        await tx.execute(sql`select 1`);
        fake.dropAll();
        await new Promise((r) => setTimeout(r, 50));
        await tx.execute(sql`select 1`);
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(failed).toBeInstanceOf(Error);
    expect(isDatabaseUnavailable(failed)).toBe(true);
    expect(problems.length).toBeGreaterThan(0);
    expect(await until(() => d.$client.totalCount === 0)).toBe(true);
    await select1(d);
  });

  it('reports only a well-formed name and code', () => {
    expect(connectionProblem(Object.assign(new Error('connect ECONNREFUSED 192.0.2.10:5432'), { code: 'ECONNREFUSED' }))).toEqual({ name: 'Error', code: 'ECONNREFUSED' });
    expect(connectionProblem({ name: 'bad name with spaces', code: 'x'.repeat(80) })).toEqual({ name: 'Error' });
    expect(connectionProblem(null)).toEqual({ name: 'Error' });
  });
});

describe('statements on an established connection are bounded on the API pool (gate 22 finding 2)', () => {
  it('a statement that stalls ends at the transport bound with its connection destroyed; the pool serves again and closes', async () => {
    const { db: d } = db({ max: 1, execution: { statementTimeoutMs: 100, idleInTransactionTimeoutMs: 100, transportTimeoutMs: 300 } });
    await select1(d);
    fake.mode = 'stall';
    const started = performance.now();
    const err = await select1(d).then(
      () => null,
      (e: unknown) => e,
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(isDatabaseUnavailable(err)).toBe(true);
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(DatabaseTimeoutError);
    expect(await until(() => d.$client.totalCount === 0)).toBe(true);
    // A stalled transaction ends the same way, and the slot comes back although Drizzle never
    // releases a connection whose BEGIN failed (it sends BEGIN before its try/finally).
    const tx = await d.transaction(async (t) => t.execute(sql`select 1`)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isDatabaseUnavailable(tx)).toBe(true);
    expect(await until(() => d.$client.totalCount === 0)).toBe(true);
    fake.mode = 'answer';
    await select1(d);
    const closing = closeDb(d);
    opened.splice(opened.indexOf(d), 1);
    expect(await within(closing, 3_000)).toBeUndefined();
  });

  it('without execution bounds (the API pool before this fix) a stalled statement keeps its slot and closing never finishes', async () => {
    const pool = new pg.Pool({ connectionString: fake.url, max: 1, connectionTimeoutMillis: 1_000 });
    await pool.query('select 1');
    fake.mode = 'stall';
    const stalled = pool.query('select 1').catch((e: unknown) => e);
    expect(await within(stalled, 600)).toBe('pending');
    expect(pool.totalCount).toBe(1);
    const ending = pool.end();
    expect(await within(ending, 600)).toBe('pending');
    // Only the server going away frees it.
    fake.dropAll();
    expect(await within(ending, 3_000)).toBeUndefined();
  });

  it('the API pool sends its statement and idle-in-transaction timeouts at startup, and its watchdog outlasts every statement timeout the API sets', () => {
    const { db: d } = db({ execution: API_DB_EXECUTION });
    const options = d.$client.options as pg.PoolConfig & { statement_timeout?: number; idle_in_transaction_session_timeout?: number };
    expect(options.statement_timeout).toBe(API_DB_EXECUTION.statementTimeoutMs);
    expect(options.idle_in_transaction_session_timeout).toBe(API_DB_EXECUTION.idleInTransactionTimeoutMs);
    // The maintenance pass raises its statement timeout to 30 s (server/quota/maintenance.ts).
    expect(API_DB_EXECUTION.transportTimeoutMs).toBeGreaterThan(30_000);
    expect(options.idleTimeoutMillis).toBeLessThan(API_DB_EXECUTION.transportTimeoutMs);
    expect(() => db({ execution: { statementTimeoutMs: 1_000, idleInTransactionTimeoutMs: 1_000, transportTimeoutMs: 1_000 } })).toThrow(/transport bound/);
  });
});

describe('a failed pool or connection is the service’s fault, not the request’s (platform P2)', () => {
  it('reads the pool’s acquisition timeout, broken and stalled connections and server-side timeouts as unavailable', async () => {
    // A real acquisition timeout: the only connection is held.
    const { db: d } = db({ max: 1, connectTimeoutMs: 200 });
    const held = await d.$client.connect();
    const timedOut = await select1(d).then(
      () => null,
      (e: unknown) => e,
    );
    held.release();
    expect((timedOut as { cause?: { message?: string } }).cause?.message).toBe('timeout exceeded when trying to connect');
    for (const err of [
      timedOut,
      new DatabaseTimeoutError(45_000),
      new BoundedReadTimeoutError(2_000),
      new Error('Connection terminated unexpectedly'),
      new Error('Client has encountered a connection error and is not queryable'),
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
      Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), { code: '25P03' }),
      Object.assign(new Error('Failed query: select 1'), { cause: new Error('Connection terminated unexpectedly') }),
    ]) {
      expect(isDatabaseUnavailable(err), String(err)).toBe(true);
      expect(isUnavailable(err), String(err)).toBe(true);
    }
    for (const err of [new Error('boom'), Object.assign(new Error('syntax error'), { code: '42601' }), null, 'text']) {
      expect(isDatabaseUnavailable(err), String(err)).toBe(false);
    }
  });
});

describe('the health probe (gate 22 finding 2)', () => {
  it('bounds its database check and destroys the connection it abandons, so probes cannot use up the pool', async () => {
    const { db: d } = db({ max: 2, execution: API_DB_EXECUTION });
    const app = buildApp({
      config: { appUrl: 'https://casebook.example', trustedProxyCidrs: [] },
      db: d,
      // Never reached: the search check runs only after the database check passes.
      es: {} as Client,
      healthCacheMs: 0,
    });
    try {
      fake.mode = 'stall';
      const probe = () => app.inject({ method: 'GET', url: '/api/health', remoteAddress: '127.0.0.1' });
      for (let round = 0; round < 2; round++) {
        const started = performance.now();
        const answers = await Promise.all([probe(), probe()]);
        expect(performance.now() - started).toBeLessThan(HEALTH_DB_TIMEOUT_MS + 1_500);
        for (const r of answers) expect([r.statusCode, JSON.parse(r.body)]).toEqual([503, { status: 'unavailable', database: 'error', search: 'error' }]);
        // Every abandoned check gave its connection back.
        expect(await until(() => d.$client.totalCount === 0 && d.$client.waitingCount === 0, 2_000)).toBe(true);
      }
      fake.mode = 'answer';
      const ok = await probe();
      expect(JSON.parse(ok.body)).toMatchObject({ database: 'ok' });
    } finally {
      await app.close();
    }
  }, 20_000);
});
