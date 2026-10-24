/**
 * Paid operations after a restore (RUNBOOK, "Backups"; server/quota/hold.ts; migration 0020;
 * Task 22 gate finding 5): a restored ledger lacks the spend after the backup, so admission,
 * the AI status and the indexing and evaluation spend gate refuse every paid operation until
 * an operator has charged that spend with `reconcileRestore`.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import {
  admitPaidRequest,
  aiStatus,
  canonicalRequestHash,
  createTrialIdentity,
  quotaPolicy,
  remainingCategoryUsd,
  reserveSpend,
  type AdmissionResult,
  type Principal,
} from '../../server/quota/index.js';
import {
  holdPaidOperations,
  paidOperationsHeld,
  readPaidOperationsHold,
  reconcileRestore,
  ReconcileRefusedError,
} from '../../server/quota/hold.js';
import { loadConfig } from '../../shared/config.js';
import { createLedgerSpendGate, SpendRefusedError } from '../../worker/index/spend-gate.js';
import { sqlState } from './corpus-helpers.js';
import { resetControls, testDb } from './helpers.js';

const POLICY = quotaPolicy({
  ai: loadConfig({ env: {}, files: [] }).ai,
  auth: { identityHmacSecret: 'test-identity-hmac-secret-0123456789', ipHmacSecret: 'test-network-hmac-secret-0123456789' },
});
const BUDGETS = POLICY.budgets;
const T0 = new Date('2026-11-01T10:00:00Z');
const request = { provider: 'openai', model: 'text-embedding-3-small', stage: 'embed' };

let app: Db;
let ingest: Db;
let migrator: Db;
let keySeq = 0;

beforeAll(() => {
  app = testDb('app');
  ingest = testDb('ingest');
  migrator = testDb('migrator');
});

afterAll(async () => {
  await resetHold();
  await Promise.all([closeDb(app), closeDb(ingest), closeDb(migrator)]);
});

/** The state a migrated, never-restored database has: this database's row, no hold. */
async function resetHold(): Promise<void> {
  await migrator.execute(sql`
    INSERT INTO paid_operations_hold (id, database_oid) SELECT 1, oid::bigint FROM pg_database WHERE datname = current_database()
    ON CONFLICT (id) DO UPDATE SET database_oid = EXCLUDED.database_oid, held_at = NULL, reconciled_at = NULL, note = NULL`);
}

/** What a restore into another database brings along: the row of the database the backup came from. */
async function simulateRestore(): Promise<void> {
  await migrator.execute(sql`UPDATE paid_operations_hold SET database_oid = database_oid + 1000 WHERE id = 1`);
}

beforeEach(async () => {
  await resetControls();
  await resetHold();
});

afterEach(async () => {
  await resetHold();
});

async function trial(): Promise<Principal> {
  const t = await createTrialIdentity(app, POLICY, randomBytes(32).toString('hex'), T0);
  return { kind: 'trial', id: t.id };
}

async function admit(principal: Principal, now = T0): Promise<AdmissionResult> {
  return admitPaidRequest(app, {
    policy: POLICY,
    principal,
    networkId: `net-${++keySeq}`,
    idempotencyKey: `hold-key-${keySeq}`,
    requestHash: canonicalRequestHash({ question: 'carburetor icing in cruise' }),
    reservationUsd: 0.14,
    now,
  });
}

describe('paid operations after a restore', () => {
  it('a migrated database that was never restored holds nothing', async () => {
    expect(await paidOperationsHeld(app)).toBe(false);
    expect(await readPaidOperationsHold(ingest)).toMatchObject({ held: false, reason: null });
    expect(await admit(await trial())).toMatchObject({ ok: true });
  });

  it('a restore into another database refuses admission, pauses the AI status and refuses indexing and evaluation spend', async () => {
    await simulateRestore();
    expect(await readPaidOperationsHold(app)).toMatchObject({ held: true, reason: 'other_database' });
    const principal = await trial();
    expect(await admit(principal)).toEqual({ ok: false, reason: 'global_paused', pause: 'maintenance' });
    expect(await aiStatus(app, principal, { policy: POLICY, reservationUsd: 0.14, now: T0 })).toMatchObject({
      state: 'paused',
      reason: 'maintenance',
    });
    for (const category of ['indexing', 'evaluation'] as const) {
      expect(await reserveSpend(ingest, { category, usd: 0.5, request, budgets: BUDGETS, now: T0 })).toEqual({
        ok: false,
        reason: 'restore_hold',
      });
    }
    const gate = createLedgerSpendGate(ingest, { budgets: BUDGETS, provider: 'openai', model: 'text-embedding-3-small', stage: 'embed', now: () => T0 });
    await expect(gate.reserve({ category: 'indexing', usd: 0.01, purpose: 'embed batch' })).rejects.toThrow(SpendRefusedError);
    await expect(gate.reserve({ category: 'evaluation', usd: 0.01, purpose: 'judge' })).rejects.toThrow(/held after a restore/);
    // Nothing was reserved or counted.
    const rows = await migrator.execute(sql`SELECT count(*)::int AS n FROM reservations`);
    expect(rows.rows[0]).toEqual({ n: 0 });
  });

  it('the restore check holds paid operations in the same database too, and the runtime roles cannot release them', async () => {
    const held = await holdPaidOperations(migrator, 'restore check', T0);
    expect(held).toMatchObject({ held: true, reason: 'restored', note: 'restore check' });
    expect(await admit(await trial())).toMatchObject({ ok: false, reason: 'global_paused' });
    for (const role of [app, ingest]) {
      expect(await sqlState(role.execute(sql`UPDATE paid_operations_hold SET held_at = NULL WHERE id = 1`))).toBe('42501');
      expect(await sqlState(role.execute(sql`DELETE FROM paid_operations_hold`))).toBe('42501');
    }
    await expect(holdPaidOperations(ingest, 'not allowed', T0)).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a missing row holds paid operations (fail closed)', async () => {
    await migrator.execute(sql`DELETE FROM paid_operations_hold`);
    expect(await paidOperationsHeld(app)).toBe(true);
    expect(await readPaidOperationsHold(app)).toMatchObject({ held: true, reason: 'missing' });
    expect(await admit(await trial())).toMatchObject({ ok: false, reason: 'global_paused' });
  });

  it('reconciling charges the open reservations of the backup in full and the lost spend, then releases the hold', async () => {
    // A request the backup caught in flight: admitted an hour before, never settled.
    const inFlight = await admit(await trial(), new Date(T0.getTime() - 3_600_000));
    expect(inFlight).toMatchObject({ ok: true });
    await simulateRestore();

    const preview = await reconcileRestore(migrator, { interactiveUsd: 1.25, ingestionUsd: 0.4, note: 'console usage', budgets: BUDGETS, now: T0, dryRun: true });
    expect(preview).toEqual({ dryRun: true, openCharged: { count: 1, usd: 0.14 }, charged: { interactive: 1.25, indexing: 0.4 }, released: false });
    expect(await paidOperationsHeld(app)).toBe(true);

    const report = await reconcileRestore(migrator, { interactiveUsd: 1.25, ingestionUsd: 0.4, note: 'console usage', budgets: BUDGETS, now: T0 });
    expect(report).toEqual({ dryRun: false, openCharged: { count: 1, usd: 0.14 }, charged: { interactive: 1.25, indexing: 0.4 }, released: true });
    expect(await readPaidOperationsHold(app)).toMatchObject({ held: false, reason: null, note: 'console usage' });

    const ledger = await migrator.execute(sql`
      SELECT category, principal_kind, stage, usd::text AS usd, uncertain FROM cost_ledger ORDER BY id`);
    expect(ledger.rows).toEqual([
      { category: 'interactive', principal_kind: 'trial', stage: 'lease_expired', usd: '0.140000', uncertain: true },
      { category: 'interactive', principal_kind: 'system', stage: 'restore_reconcile', usd: '1.250000', uncertain: true },
      { category: 'indexing', principal_kind: 'system', stage: 'restore_reconcile', usd: '0.400000', uncertain: true },
    ]);
    // The charges count against the budgets, and paid operations start again.
    expect(await remainingCategoryUsd(ingest, 'indexing', T0, BUDGETS)).toBeCloseTo(BUDGETS.ingestionMonthlyUsd - 0.4, 6);
    expect(await admit(await trial())).toMatchObject({ ok: true });
    expect(await reserveSpend(ingest, { category: 'indexing', usd: 0.5, request, budgets: BUDGETS, now: T0 })).toMatchObject({ ok: true });
  });

  it('without the providers’ figures it charges everything the budgets still allow this month', async () => {
    await holdPaidOperations(migrator, 'restore check', T0);
    const report = await reconcileRestore(migrator, { chargeRemaining: true, note: 'figures unknown', budgets: BUDGETS, now: T0 });
    expect(report.released).toBe(true);
    expect(report.charged.interactive).toBeCloseTo(BUDGETS.interactiveMonthlyUsd, 6);
    expect(report.charged.indexing).toBeCloseTo(Math.min(BUDGETS.ingestionMonthlyUsd, BUDGETS.monthlyUsd - BUDGETS.interactiveMonthlyUsd), 6);
    expect(await remainingCategoryUsd(ingest, 'indexing', T0, BUDGETS)).toBe(0);
    expect(await remainingCategoryUsd(app, 'interactive', T0, BUDGETS)).toBe(0);
    expect(await admit(await trial())).toMatchObject({ ok: false, reason: 'global_paused', pause: 'monthly_budget' });
    expect(await reserveSpend(ingest, { category: 'evaluation', usd: 0.01, request, budgets: BUDGETS, now: T0 })).toMatchObject({ ok: false });
    // The next month's budgets are untouched.
    const next = new Date('2026-12-01T10:00:00Z');
    expect(await reserveSpend(ingest, { category: 'evaluation', usd: 0.01, request, budgets: BUDGETS, now: next })).toMatchObject({ ok: true });
  });

  it('refuses, changing nothing, when nothing is held, while a backup reservation still has a lease, or with both kinds of amounts', async () => {
    await expect(reconcileRestore(migrator, { interactiveUsd: 1, note: 'n', budgets: BUDGETS, now: T0 })).rejects.toBeInstanceOf(ReconcileRefusedError);
    await simulateRestore();
    const running = await reserveSpend(ingest, { category: 'indexing', usd: 0.5, request, budgets: BUDGETS, now: T0 });
    expect(running).toEqual({ ok: false, reason: 'restore_hold' });
    // A reservation whose lease outlives the restore (made in the database before the restore was simulated).
    await resetHold();
    const lease = await reserveSpend(ingest, { category: 'indexing', usd: 0.5, request, budgets: BUDGETS, now: T0, ttlMs: 10 * 60_000 });
    expect(lease).toMatchObject({ ok: true });
    await simulateRestore();
    await expect(reconcileRestore(migrator, { interactiveUsd: 1, note: 'n', budgets: BUDGETS, now: T0 })).rejects.toThrow(/lease runs until/);
    await expect(reconcileRestore(migrator, { interactiveUsd: 1, chargeRemaining: true, note: 'n', budgets: BUDGETS, now: T0 })).rejects.toThrow(/not both/);
    await expect(reconcileRestore(migrator, { note: 'n', budgets: BUDGETS, now: T0 })).rejects.toThrow(/not both/);
    await expect(reconcileRestore(migrator, { interactiveUsd: -1, note: 'n', budgets: BUDGETS, now: T0 })).rejects.toThrow(/between 0/);
    expect(await paidOperationsHeld(app)).toBe(true);
    const ledger = await migrator.execute(sql`SELECT count(*)::int AS n FROM cost_ledger`);
    expect(ledger.rows[0]).toEqual({ n: 0 });
  });

  it('only the reconciliation may charge interactive spend without a principal', async () => {
    const insert = (stage: string) =>
      sqlState(
        migrator.execute(sql`
          INSERT INTO reservations (category, principal_kind, principal_hash, usd, status, lease_expires_at, accounting_day, stage, created_at)
          VALUES ('interactive', 'system', NULL, 1, 'open', ${new Date(T0.getTime() + 1000)}, '2026-11-01', ${stage}, ${T0})`),
      );
    expect(await insert('compose')).toBe('23514');
    expect(await insert('restore_reconcile')).toBeUndefined();
  });
});
