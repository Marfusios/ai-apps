/**
 * Indexing and evaluation spend (amendment A7). Every paid batch or evaluation call
 * reserves its maximum cost first, then settles with the reservation's fencing token,
 * exactly like an interactive request: actual usage is charged, uncertain usage at the
 * full reservation, and an expired lease is charged in full. Indexing and evaluation
 * share the monthly ingestion allowance, which is enforced when reserving, together
 * with the total monthly budget. Each retry attempt is its own reservation. Nothing is
 * reserved while paid operations are held after a restore (server/quota/hold.ts).
 */
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import { nextMonthStart, utcDay } from './buckets.js';
import {
  budgetMicros,
  microsToNumeric,
  microsToUsd,
  remainingCategoryMicros,
  spendSnapshot,
  toMicros,
} from './pacing.js';
import { LEASE_TTL_MS, QuotaInputError, SPEND_LOCK_KEY, type QuotaBudgets } from './policy.js';
import { paidOperationsHeld } from './hold.js';
import { isLockTimeout, setLockTimeout } from './locks.js';
import { settleReservation, type SettleResult, type SpendUsage } from './settle.js';

export type IngestionCategory = 'indexing' | 'evaluation';

/** What the money is for; stored on the reservation and copied to its ledger lines. */
export interface SpendRequest {
  provider: string;
  model: string;
  /** Lower-case label, e.g. `embed`. */
  stage: string;
  /** Batch or run id (no content). */
  requestId?: string;
}

export interface ReserveSpendInput {
  /** Exact importer identity, atomically tagged and capped under import → spend lock order. */
  import?: { artifactId: string; fence: string };
  category: IngestionCategory;
  /** Maximum cost of the call, e.g. `embeddingCostUsd(model, exactTokens)`. */
  usd: number;
  request: SpendRequest;
  budgets: QuotaBudgets;
  now?: Date;
  /** Lease TTL (default `LEASE_TTL_MS`, 120 s; at most 15 minutes). */
  ttlMs?: number;
}

export interface SpendReservation {
  ok: true;
  reservationId: number;
  fencingToken: string;
  usd: number;
  category: IngestionCategory;
  leaseExpiresAt: Date;
}

export type SpendRefusal =
  | {
      ok: false;
      /** `category_cap`: the indexing/evaluation allowance; `monthly_budget`: the total budget. */
      reason: 'category_cap' | 'monthly_budget';
      remainingUsd: number;
      retryAt: Date;
    }
  /** A lock wait timed out (2 s); nothing was reserved. Retry later. */
  | { ok: false; reason: 'busy' }
  /** Paid operations are held after a restore until `pnpm worker restore-reconcile` (server/quota/hold.ts). */
  | { ok: false; reason: 'restore_hold' };

const MAX_TTL_MS = 15 * 60_000;
const STAGE = /^[a-z][a-z0-9_]{0,39}$/;

function validate(a: ReserveSpendInput): void {
  if (a.category !== 'indexing' && a.category !== 'evaluation') throw new QuotaInputError('Invalid spend category');
  if (!Number.isFinite(a.usd) || a.usd <= 0) throw new QuotaInputError('The reservation must be a positive amount');
  const r = a.request;
  if (!r.provider || r.provider.length > 100 || !r.model || r.model.length > 100 || !STAGE.test(r.stage)) {
    throw new QuotaInputError('Invalid spend request labels');
  }
  if (r.requestId !== undefined && (r.requestId.length === 0 || r.requestId.length > 200)) {
    throw new QuotaInputError('Invalid request id');
  }
  if (a.ttlMs !== undefined && !(Number.isInteger(a.ttlMs) && a.ttlMs > 0 && a.ttlMs <= MAX_TTL_MS)) {
    throw new QuotaInputError('Invalid lease TTL');
  }
}

/** Reserve the maximum cost of one indexing or evaluation call, or refuse it. */
export async function reserveSpend(db: Db, a: ReserveSpendInput): Promise<SpendReservation | SpendRefusal> {
  validate(a);
  const now = a.import
    ? new Date(String((await db.execute(sql`select to_char(clock_timestamp() at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`)).rows[0]?.now))
    : a.now ?? new Date();
  const amount = toMicros(a.usd);
  const leaseExpiresAt = new Date(now.getTime() + (a.ttlMs ?? LEASE_TTL_MS));
  try {
    return await db.transaction((tx) => reserveInTransaction(tx, a, amount, now, leaseExpiresAt));
  } catch (err) {
    if (isLockTimeout(err)) return { ok: false, reason: 'busy' };
    throw err;
  }
}

async function reserveInTransaction(
  tx: DbOrTx,
  a: ReserveSpendInput,
  amount: number,
  now: Date,
  leaseExpiresAt: Date,
): Promise<SpendReservation | SpendRefusal> {
  await setLockTimeout(tx);
  if (a.import) {
    await tx.execute(sql`select set_config('aviation.import_fence', ${a.import.fence}, true)`);
    await tx.execute(sql`select import_check_budget(${a.import.artifactId}::uuid, ${a.import.fence}::uuid, ${amount}::bigint)`);
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPEND_LOCK_KEY})`);
  // Under the spend lock, which the reconciliation also holds while it charges and releases.
  if (await paidOperationsHeld(tx)) return { ok: false, reason: 'restore_hold' };
  const snap = await spendSnapshot(tx, now);
  const remaining = remainingCategoryMicros(snap, a.category, a.budgets);
  if (amount > remaining) {
    const categoryLeft = budgetMicros(a.budgets.ingestionMonthlyUsd) - snap.ingestionMonth;
    return {
      ok: false,
      reason: amount > categoryLeft ? 'category_cap' : 'monthly_budget',
      remainingUsd: microsToUsd(remaining),
      retryAt: nextMonthStart(now),
    };
  }
  const res = await tx.execute(sql`
    INSERT INTO reservations (category, principal_kind, principal_hash, usd, status, lease_expires_at, accounting_day,
      provider, model, stage, request_id, created_at, import_artifact_id)
    VALUES (${a.category}, 'system', NULL, ${microsToNumeric(amount)}::numeric, 'open', ${leaseExpiresAt},
      ${utcDay(now)}::date, ${a.request.provider}, ${a.request.model}, ${a.request.stage}, ${a.request.requestId ?? null},
      ${now}, ${a.import?.artifactId ?? null}::uuid)
    RETURNING id, fencing_token::text AS fencing_token`);
  const row = res.rows[0] as { id: string; fencing_token: string };
  return {
    ok: true,
    reservationId: Number(row.id),
    fencingToken: row.fencing_token,
    usd: microsToUsd(amount),
    category: a.category,
    leaseExpiresAt,
  };
}

/** Settle an indexing or evaluation reservation; same semantics as `settle`. */
export function settleSpend(
  db: Db,
  reservation: { readonly reservationId: number },
  usage: SpendUsage,
  fencingToken: string,
  now: Date = new Date(),
): Promise<SettleResult> {
  return settleReservation(db, reservation.reservationId, usage, fencingToken, now);
}
