/** Offline bounds and fixed failure categories through the real read model and route. */
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { adminRoutes } from '../../server/routes/admin.js';
import { adminOverview, ADMIN_OVERVIEW_TIMEOUT_MS, AdminOverviewTimeoutError, type AdminSettings } from '../../server/admin/overview.js';
import type { ApiContext } from '../../server/routes/context.js';

vi.mock('../../server/auth/admin.js', () => ({ isAdmin: async () => true }));
afterEach(() => vi.useRealTimers());
const settings: AdminSettings = {
  emails: [], appEnv: 'dev', startedAt: '2026-10-31T00:00:00.000Z', ranking: 'er-q-v1', automaticFilters: 'none',
};

function fakeContext(query: (text: string) => Promise<{ rows: object[] }>) {
  const release = vi.fn();
  const client = {
    query: vi.fn(async (config: { text: string } | string) => query(typeof config === 'string' ? config : config.text)),
    release,
  };
  const connect = vi.fn(async () => client);
  const ctx = {
    db: { $client: { connect } }, datasets: { current: vi.fn(async () => null) },
  } as unknown as ApiContext;
  return { ctx, release, client, connect };
}

it('refuses over 10,000 accounts with a named, fixed-category 503, without logging account data', async () => {
  const { ctx, release } = fakeContext(async text => ({ rows: text.includes('FROM auth_users')
    ? Array.from({ length: 10001 }, () => ({ email: 'PRIVATE_ACCOUNT' })) : [] }));
  const logs: string[] = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => logs.push(line) } } });
  adminRoutes(app, ctx, settings);
  try {
    const response = await app.inject('/api/admin/overview');
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('unavailable');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ name: 'AdminOverviewLimitError' }));
    expect(logs.map(line => JSON.parse(line))).toEqual([expect.objectContaining({
      category: 'admin_overview_user_limit', msg: 'admin overview unavailable',
    })]);
    expect(logs.join('')).not.toContain('PRIVATE_ACCOUNT');
  } finally { await app.close(); }
});

it('bounds the whole sequence, not each of its individually fast queries; no query continues after destruction', async () => {
  vi.useFakeTimers();
  let destroyed = false;
  const { ctx, release, client } = fakeContext(async () => {
    if (destroyed) throw new Error('closed');
    await new Promise(resolve => setTimeout(resolve, 4_000));
    if (destroyed) throw new Error('closed');
    return { rows: [] };
  });
  release.mockImplementation(() => { destroyed = true; });
  const logs: string[] = [];
  const app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => logs.push(line) } } });
  adminRoutes(app, ctx, settings);
  await app.ready();
  try {
    const response = app.inject('/api/admin/overview');
    await vi.advanceTimersByTimeAsync(ADMIN_OVERVIEW_TIMEOUT_MS - 1);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await response).statusCode).toBe(503);
    expect(release).toHaveBeenCalledExactlyOnceWith(expect.any(AdminOverviewTimeoutError));
    const before = client.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    // Drizzle attempts a rollback after the in-flight query rejects; nothing else runs.
    expect(client.query.mock.calls.slice(before).map(([q]) => typeof q === 'string' ? q : q.text)).toEqual(['rollback']);
    expect(logs.map(line => JSON.parse(line))).toEqual([expect.objectContaining({ category: 'admin_overview_timeout' })]);
  } finally { await app.close(); }
});

it('bounds dataset lookup by the same deadline before acquiring a database connection', async () => {
  vi.useFakeTimers();
  const { ctx, connect } = fakeContext(async () => ({ rows: [] }));
  vi.mocked(ctx.datasets.current).mockReturnValue(new Promise(() => {}));
  const rejected = expect(adminOverview(ctx, settings)).rejects.toBeInstanceOf(AdminOverviewTimeoutError);
  await vi.advanceTimersByTimeAsync(ADMIN_OVERVIEW_TIMEOUT_MS);
  await rejected;
  expect(connect).not.toHaveBeenCalled();
});

it('returns a connection arriving after the shared deadline without beginning a transaction', async () => {
  vi.useFakeTimers();
  const { ctx, connect, client, release } = fakeContext(async () => ({ rows: [] }));
  let finish!: (value: typeof client) => void;
  connect.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const rejected = expect(adminOverview(ctx, settings)).rejects.toBeInstanceOf(AdminOverviewTimeoutError);
  await vi.advanceTimersByTimeAsync(ADMIN_OVERVIEW_TIMEOUT_MS);
  await rejected;
  finish(client);
  await vi.advanceTimersByTimeAsync(0);
  expect(release).toHaveBeenCalledExactlyOnceWith();
  expect(client.query).not.toHaveBeenCalled();
});
