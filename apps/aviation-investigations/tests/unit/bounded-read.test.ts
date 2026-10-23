/**
 * The bounded database read (server/db/bounded-read.ts; task 10e fix round 1, gate
 * finding 1) over a pool that can stall: acquisition and execution both end at the
 * bound or the caller's cancel, a connection that may still run a statement is
 * destroyed rather than returned, and a connection handed over late goes back to the
 * pool. tests/integration/case-retrieval.test.ts shows the same on real PostgreSQL.
 */
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { BoundedReadTimeoutError, boundedRead } from '../../server/db/bounded-read.js';

interface FakeClient {
  queries: unknown[];
  released: { error: Error | undefined }[];
}

/**
 * A pool whose acquisition takes `acquireMs` (or never ends with `Infinity`) and whose
 * statement (anything but the transaction commands) answers `answer()`.
 */
function fakePool(opts: { acquireMs?: number; answer?: () => Promise<{ rows: unknown[] }> } = {}) {
  const clients: FakeClient[] = [];
  let connects = 0;
  const pool = {
    connect: () => {
      connects += 1;
      const c: FakeClient = { queries: [], released: [] };
      const client = {
        query: async (q: unknown) => {
          c.queries.push(q);
          if (typeof q === 'string') return { rows: [] };
          return (opts.answer ?? (async () => ({ rows: [{ cases_index: 'cases-a' }] })))();
        },
        release: (error?: Error) => {
          c.released.push({ error });
        },
      };
      clients.push(c);
      const ms = opts.acquireMs ?? 0;
      if (ms === Infinity) return new Promise<never>(() => undefined);
      return new Promise((resolve) => setTimeout(() => resolve(client), ms));
    },
  };
  return { pool: pool as unknown as pg.Pool, clients, connects: () => connects };
}

const never = () => new Promise<never>(() => undefined);
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('boundedRead', () => {
  it('runs the statement alone in a read-only transaction, the rest of the bound as its server timeout, and returns the connection', async () => {
    const p = fakePool();
    const rows = await boundedRead<{ cases_index: string }>(p.pool, 'select cases_index from t where a = $1', [7], { timeoutMs: 2_000 });
    expect(rows).toEqual([{ cases_index: 'cases-a' }]);
    const [c] = p.clients;
    expect(c?.queries[0]).toBe('BEGIN READ ONLY');
    const timeout = /^SET LOCAL statement_timeout = (\d+)$/.exec(String(c?.queries[1]));
    expect(Number(timeout?.[1])).toBeGreaterThan(0);
    expect(Number(timeout?.[1])).toBeLessThanOrEqual(2_000);
    expect(c?.queries[2]).toEqual({ text: 'select cases_index from t where a = $1', values: [7] });
    expect(c?.queries[3]).toBe('COMMIT');
    expect(c?.released).toEqual([{ error: undefined }]);
  });

  it('ends a stalled acquisition at the bound, and returns a connection handed over late', async () => {
    const p = fakePool({ acquireMs: 250 });
    const t0 = performance.now();
    const err = await boundedRead(p.pool, 'select 1', [], { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(err).toBeInstanceOf(BoundedReadTimeoutError);
    await settle(300);
    // The late connection went straight back, healthy, and nothing ran on it.
    expect(p.clients[0]?.released).toEqual([{ error: undefined }]);
    expect(p.clients[0]?.queries).toEqual([]);
  });

  it('ends a stalled statement at the bound and destroys its connection', async () => {
    const p = fakePool({ answer: never });
    const t0 = performance.now();
    const err = await boundedRead(p.pool, 'select pg_sleep(60)', [], { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(err).toBeInstanceOf(BoundedReadTimeoutError);
    expect(p.clients[0]?.released).toHaveLength(1);
    expect(p.clients[0]?.released[0]?.error).toBeInstanceOf(Error);
  });

  it("reports the server's statement timeout (SQLSTATE 57014) as the same bound", async () => {
    const canceled = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const p = fakePool({ answer: async () => Promise.reject(canceled) });
    const err = await boundedRead(p.pool, 'select pg_sleep(60)', [], { timeoutMs: 2_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundedReadTimeoutError);
    expect(p.clients[0]?.released[0]?.error).toBe(canceled);
  });

  it("passes the database's other errors through and destroys the connection", async () => {
    const broken = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const p = fakePool({ answer: async () => Promise.reject(broken) });
    expect(await boundedRead(p.pool, 'select 1 from missing', [], { timeoutMs: 2_000 }).catch((e: unknown) => e)).toBe(broken);
    expect(p.clients[0]?.released[0]?.error).toBe(broken);
  });

  it("ends at the caller's cancel, while acquiring and while the statement runs, with the caller's reason", async () => {
    const reason = new Error('the request was cancelled');
    // While acquiring: the pool never answers.
    let controller = new AbortController();
    const acquiring = fakePool({ acquireMs: Infinity });
    let pending = boundedRead(acquiring.pool, 'select 1', [], { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);
    let t0 = performance.now();
    expect(await pending.catch((e: unknown) => e)).toBe(reason);
    expect(performance.now() - t0).toBeLessThan(200);
    // While the statement runs: the connection is destroyed.
    controller = new AbortController();
    const running = fakePool({ answer: never });
    pending = boundedRead(running.pool, 'select pg_sleep(60)', [], { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(reason), 20);
    t0 = performance.now();
    expect(await pending.catch((e: unknown) => e)).toBe(reason);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(running.clients[0]?.released[0]?.error).toBeInstanceOf(Error);
    // Already cancelled: nothing is acquired.
    const idle = fakePool();
    expect(await boundedRead(idle.pool, 'select 1', [], { timeoutMs: 2_000, signal: AbortSignal.abort(reason) }).catch((e: unknown) => e)).toBe(reason);
    expect(idle.connects()).toBe(0);
  });

  it('refuses a bound that is not a positive whole number of milliseconds', async () => {
    const p = fakePool();
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Infinity]) {
      await expect(boundedRead(p.pool, 'select 1', [], { timeoutMs })).rejects.toThrow('invalid bounded read timeout');
    }
    expect(p.connects()).toBe(0);
  });
});
