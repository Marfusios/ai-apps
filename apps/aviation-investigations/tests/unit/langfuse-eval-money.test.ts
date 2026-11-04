import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { loadConfig } from '../../shared/config.js';
import { Task25Allocation, taskTotals } from '../../evals/langfuse/money.js';

const state = vi.hoisted(() => ({ locked: true, lost: false, settlementFails: false, records: [] as any[], prior: 0, monthly: 31_000_000,
  create: vi.fn(), close: vi.fn(), configs: [] as any[] }));
vi.mock('../../server/db/client.js', () => ({ createDb: state.create, closeDb: state.close }));
vi.mock('../../server/quota/pacing.js', async original => ({ ...await original<typeof import('../../server/quota/pacing.js')>(),
  spendSnapshot: async () => ({ ingestionMonth: state.monthly }) }));
vi.mock('../../worker/index/spend-gate.js', async original => ({ ...await original<typeof import('../../worker/index/spend-gate.js')>(),
  createLedgerSpendGate: (_db: unknown, options: any) => {
    state.configs.push(options);
    return { remainingUsd: async () => 50,
      reserve: async (req: any) => {
        const row = { ...req, reservationId: `r${state.records.length}`, fencingToken: 'synthetic', open: true, charged: 0 };
        state.records.push(row); return { reservationId: row.reservationId, fencingToken: row.fencingToken };
      },
      settle: async (res: any, outcome: any) => {
        if (state.settlementFails) throw new Error('synthetic failure');
        const row = state.records.find(r => r.reservationId === res.reservationId)!;
        row.open = false; row.charged = Math.round((outcome === 'uncertain' ? row.usd : outcome.usd) * 1e6);
      },
    };
  } }));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'task25-money-offline-'));
  state.locked = true; state.lost = false; state.settlementFails = false; state.records = []; state.prior = 0; state.configs = [];
  state.close.mockReset().mockResolvedValue(undefined);
  const dialect = new PgDialect();
  const client = { release: vi.fn(), query: vi.fn(async (query: string) => ({ rows: query.includes('current_database') ? [{ database: 'aviation_dev', locked: state.locked }]
    : [{ locked: query.includes('pg_try_advisory_lock') ? state.locked : !state.lost }] })) };
  state.create.mockReset().mockReturnValue({ $client: { connect: async () => client }, execute: async (query: any) => {
    const q = dialect.sqlToQuery(query);
    if (q.sql.startsWith('select id')) return { rows: state.records.filter(r => r.purpose === q.params[0]).map(r => ({ id: r.reservationId })) };
    const open = state.records.filter(r => r.open), charged = state.prior + state.records.reduce((s, r) => s + r.charged, 0);
    return { rows: [{ reservations: state.records.length, open: open.length, open_usd: open.reduce((s, r) => s + r.usd, 0).toFixed(6),
      charged_usd: (charged / 1e6).toFixed(6), ledger_usd: (charged / 1e6).toFixed(6) }] };
  } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const env = { APP_ENV: 'dev', DATABASE_INGEST_URL: 'postgresql://example.invalid/aviation_dev' };
const settings = () => ({ env, config: loadConfig({ env, files: [] }) });
describe('Task 25 production gate supervisor', () => {
  it('stops before reserve when another evaluator owns the lock or the target is live', async () => {
    state.locked = false; await expect(Task25Allocation.open(settings(), dir)).rejects.toThrow('already running'); expect(state.records).toHaveLength(0);
    const s = settings(); s.config.appEnv = 'live'; await expect(Task25Allocation.open(s, dir)).rejects.toThrow('development');
  });
  it('charges uncertainty in full, rejects duplicate attempts and refuses concurrent reservations', async () => {
    const a = await Task25Allocation.open(settings(), dir);
    const g = a.gate('selection', 'a'.repeat(64), 'anthropic', 'synthetic', 'rerank');
    const first = g.reserve({ category: 'evaluation', usd: .009, purpose: 'one' });
    await expect(g.reserve({ category: 'evaluation', usd: .009, purpose: 'two' })).rejects.toThrow('Concurrent');
    const r = await first; await g.settle(r, 'uncertain');
    expect((await taskTotals(a.db)).chargedMicros).toBe(9000);
    await expect(g.reserve({ category: 'evaluation', usd: .009, purpose: 'one' })).rejects.toThrow('already reserved');
    expect(state.records).toHaveLength(1); expect((await a.close()).open).toBe(0);
  });
  it('checks cumulative task spend before each stage even when the production category gate has room', async () => {
    state.prior = 741_000;
    const a = await Task25Allocation.open(settings(), dir);
    const g = a.gate('selection', 'a'.repeat(64), 'anthropic', 'synthetic', 'rerank');
    await expect(a.assertBlock(9001)).rejects.toThrow('$0.75');
    const r = await g.reserve({ category: 'evaluation', usd: .009, purpose: 'last' }); await g.settle(r, 'uncertain');
    await expect(g.reserve({ category: 'evaluation', usd: .000001, purpose: 'over' })).rejects.toThrow('$0.75');
    expect((await a.close()).chargedMicros).toBe(750_000); expect(state.records).toHaveLength(1);
  });
  it('a lost lock or failed settlement poisons further dispatch and requires reconciliation', async () => {
    const a = await Task25Allocation.open(settings(), dir);
    const g = a.gate('selection', 'a'.repeat(64), 'anthropic', 'synthetic', 'scope');
    const r = await g.reserve({ category: 'evaluation', usd: .0025, purpose: 'one' });
    state.settlementFails = true; await expect(g.settle(r, { usd: .001 })).rejects.toThrow('reconciliation');
    await expect(g.reserve({ category: 'evaluation', usd: .0025, purpose: 'two' })).rejects.toThrow();
    await expect(a.close()).rejects.toThrow('reconciliation'); expect(state.records).toHaveLength(1);
  });
  it('detects lock loss before a new reservation', async () => {
    const a = await Task25Allocation.open(settings(), dir); state.lost = true;
    await expect(a.gate('selection', 'b'.repeat(64), 'openai', 'synthetic', 'embed').reserve({ category: 'evaluation', usd: .00002, purpose: 'one' })).rejects.toThrow('lock lost');
    expect(state.records).toHaveLength(0); await expect(a.close()).rejects.toThrow('reconciliation');
  });
});
