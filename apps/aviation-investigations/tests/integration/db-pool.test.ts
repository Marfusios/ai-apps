/**
 * The API pool against the local PostgreSQL (gate 22 findings 2 and 3; the offline
 * reproductions are tests/unit/db-pool.test.ts): its execution bounds are in effect on
 * every connection, a statement over them ends as the service's fault, and a backend the
 * server terminates, idle or inside a transaction, is reported and replaced without ending
 * the process.
 */
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { isUnavailable } from '../../server/app.js';
import { API_DB_EXECUTION, closeDb, createDb, isDatabaseUnavailable, type Db, type DbConnectionProblem } from '../../server/db/client.js';
import { testDbUrl } from './helpers.js';

const opened: Db[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => closeDb(db)));
});

function apiPool(execution = API_DB_EXECUTION): { db: Db; problems: DbConnectionProblem[] } {
  const problems: DbConnectionProblem[] = [];
  const db = createDb(testDbUrl('app'), { max: 2, applicationName: 'aviation-test-db-pool', execution, onConnectionError: (p) => void problems.push(p) });
  opened.push(db);
  return { db, problems };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

const backendPid = async (db: Db | Parameters<Parameters<Db['transaction']>[0]>[0]) =>
  Number(((await db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0] as { pid: number }).pid);

describe('the API pool on PostgreSQL', () => {
  it('runs every connection under the statement and idle-in-transaction timeouts; a statement over them is unavailable', async () => {
    const { db } = apiPool();
    const shown = await db.execute(sql`SELECT current_setting('statement_timeout') AS s, current_setting('idle_in_transaction_session_timeout') AS i`);
    expect(shown.rows[0]).toEqual({ s: '15s', i: '30s' });
    // A transaction may raise it (the maintenance pass sets 30 s).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
      expect((await tx.execute(sql`SELECT current_setting('statement_timeout') AS s`)).rows[0]).toEqual({ s: '30s' });
    });
    const short = apiPool({ statementTimeoutMs: 200, idleInTransactionTimeoutMs: 1_000, transportTimeoutMs: 5_000 });
    const err = await short.db.execute(sql`SELECT pg_sleep(2)`).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('57014');
    expect(isDatabaseUnavailable(err)).toBe(true);
    expect(isUnavailable(err)).toBe(true);
  });

  it('a connection the server ends while it is idle in the pool is reported and replaced', async () => {
    const { db, problems } = apiPool();
    // The server ends this session once it has been idle for 200 ms (as a restart or an operator would).
    await db.execute(sql`SET idle_session_timeout = '200ms'`);
    const pid = await backendPid(db);
    expect(db.$client.idleCount).toBe(1);
    expect(await until(() => problems.length > 0 && db.$client.totalCount === 0)).toBe(true);
    expect(problems[0]).toMatchObject({ name: expect.any(String) });
    expect(await backendPid(db)).not.toBe(pid);
  });

  it('a transaction its holder leaves idle is ended by the server, fails as unavailable and frees its slot', async () => {
    const { db } = apiPool({ statementTimeoutMs: 1_000, idleInTransactionTimeoutMs: 300, transportTimeoutMs: 5_000 });
    const failed = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await new Promise((r) => setTimeout(r, 1_000));
        await tx.execute(sql`SELECT 1`);
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isDatabaseUnavailable(failed)).toBe(true);
    expect(await until(() => db.$client.totalCount === 0)).toBe(true);
    await db.execute(sql`SELECT 1`);
  });
});
