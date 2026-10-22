/**
 * Settlement and lease expiry (DESIGN §8), shared by interactive requests and by
 * indexing/evaluation spend.
 *
 * - Settling needs the reservation's fencing token and an open, unexpired lease. It
 *   writes the reported usage to the ledger and releases the rest of the reservation.
 * - Usage that is uncertain (no reliable usage report, timeout, abort) settles at the
 *   full reservation, marked uncertain. Known lines are kept and the remainder up to
 *   the reservation is charged as one uncertain line.
 * - A lease that expires first is charged the full reservation (`expired_charged`) and
 *   never refunded; a late settlement is refused. Expiry frees the concurrency slot.
 */
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import type { ReservationStatus } from '../db/schema/index.js';
import { microsToNumeric, microsToUsd, toMicros } from './pacing.js';
import { QuotaInputError } from './policy.js';

/** One priced call. `usd` comes from `stageCostUsd`/`embeddingCostUsd`. */
export interface SpendLine {
  usd: number;
  provider?: string;
  model?: string;
  /** Lower-case stage label, e.g. `scope`, `compose`, `check`, `embed`. */
  stage?: string;
  /** Token counts by kind; no content. */
  tokens?: Readonly<Record<string, number>>;
}

/**
 * What a reservation is charged: a USD amount, `'uncertain'` (the full reservation),
 * or itemized lines, optionally marked uncertain (lines plus the rest of the reservation).
 */
export type SpendUsage = number | 'uncertain' | { readonly lines: readonly SpendLine[]; readonly uncertain?: boolean };

export type SettleRefusal = 'stale_token' | 'not_open' | 'lease_expired';

export type SettleResult =
  | { ok: true; chargedUsd: number; uncertain: boolean }
  | {
      ok: false;
      reason: SettleRefusal;
      status: ReservationStatus;
      /** For `lease_expired`: the full reservation, charged now. */
      chargedUsd?: number;
    };

const STAGE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_LINES = 50;

/** Raw row: bigint columns come back as text. */
interface ReservationRow {
  id: string;
  category: string;
  principal_kind: string;
  principal_hash: string | null;
  usd_micros: string;
  status: ReservationStatus;
  fencing_token: string;
  /** Epoch milliseconds (raw queries return timestamps as text). */
  lease_expires_ms: string;
  accounting_day: string;
  provider: string | null;
  model: string | null;
  stage: string | null;
  request_id: string | null;
}

interface LedgerLine {
  micros: number;
  provider: string | null;
  model: string | null;
  stage: string;
  tokens: Record<string, number> | null;
  uncertain: boolean;
}

function label(value: string | undefined, fallback: string | null, max: number): string | null {
  if (value === undefined) return fallback;
  if (value.length === 0 || value.length > max) throw new QuotaInputError('Invalid provider or model label');
  return value;
}

function validTokens(tokens: SpendLine['tokens']): Record<string, number> | null {
  if (tokens === undefined) return null;
  const out: Record<string, number> = {};
  const entries = Object.entries(tokens);
  if (entries.length > 10) throw new QuotaInputError('Too many token kinds');
  for (const [k, v] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) || !Number.isSafeInteger(v) || v < 0) {
      throw new QuotaInputError('Token counts must be non-negative integers');
    }
    out[k] = v;
  }
  return out;
}

function ledgerLines(usage: SpendUsage, row: ReservationRow): { lines: LedgerLine[]; uncertain: boolean } {
  const defaultStage = row.stage ?? 'request';
  let lines: LedgerLine[];
  let uncertain: boolean;
  if (usage === 'uncertain') {
    lines = [];
    uncertain = true;
  } else if (typeof usage === 'number') {
    lines = [
      { micros: toMicros(usage), provider: row.provider, model: row.model, stage: defaultStage, tokens: null, uncertain: false },
    ];
    uncertain = false;
  } else {
    if (usage.lines.length > MAX_LINES) throw new QuotaInputError(`At most ${MAX_LINES} lines per settlement`);
    lines = usage.lines.map((l) => {
      const stage = l.stage ?? defaultStage;
      if (!STAGE.test(stage)) throw new QuotaInputError('Invalid stage label');
      return {
        micros: toMicros(l.usd),
        provider: label(l.provider, row.provider, 100),
        model: label(l.model, row.model, 100),
        stage,
        tokens: validTokens(l.tokens),
        uncertain: false,
      };
    });
    uncertain = usage.uncertain === true;
  }
  if (uncertain) {
    const known = lines.reduce((s, l) => s + l.micros, 0);
    lines.push({
      micros: Math.max(0, Number(row.usd_micros) - known),
      provider: row.provider,
      model: row.model,
      stage: 'uncertain',
      tokens: null,
      uncertain: true,
    });
  } else if (lines.length === 0) {
    lines.push({ micros: 0, provider: row.provider, model: row.model, stage: defaultStage, tokens: null, uncertain: false });
  }
  return { lines, uncertain };
}

async function lockReservation(tx: DbOrTx, id: number): Promise<ReservationRow> {
  const res = await tx.execute(sql`
    SELECT id, category, principal_kind, principal_hash, (usd * 1000000)::bigint AS usd_micros, status,
      fencing_token::text AS fencing_token, (extract(epoch FROM lease_expires_at) * 1000)::bigint AS lease_expires_ms,
      accounting_day::text AS accounting_day,
      provider, model, stage, request_id
    FROM reservations WHERE id = ${id} FOR UPDATE`);
  const row = res.rows[0] as ReservationRow | undefined;
  if (!row) throw new QuotaInputError(`Unknown reservation ${id}`);
  return row;
}

/** Close an open reservation with these ledger lines and release its lease. */
async function close(
  tx: DbOrTx,
  row: ReservationRow,
  status: 'settled' | 'expired_charged',
  lines: readonly LedgerLine[],
  uncertain: boolean,
  now: Date,
): Promise<number> {
  const charged = lines.reduce((s, l) => s + l.micros, 0);
  const updated = await tx.execute(sql`
    UPDATE reservations SET status = ${status}, settled_at = ${now}, charged_usd = ${microsToNumeric(charged)}::numeric,
      uncertain = ${uncertain}
    WHERE id = ${row.id} AND status = 'open'`);
  if (updated.rowCount !== 1) throw new Error(`reservation ${row.id} changed while settling`);
  const values = sql.join(
    lines.map(
      (l) => sql`(${row.id}, ${row.category}, ${row.principal_kind}, ${row.principal_hash}, ${l.provider}, ${l.model},
        ${l.stage}, ${microsToNumeric(l.micros)}::numeric, ${l.tokens === null ? null : JSON.stringify(l.tokens)}::jsonb,
        ${l.uncertain}, ${row.request_id}, ${row.accounting_day}::date, ${now})`,
    ),
    sql`, `,
  );
  await tx.execute(sql`
    INSERT INTO cost_ledger (reservation_id, category, principal_kind, principal_hash, provider, model, stage, usd, tokens,
      uncertain, request_id, accounting_day, created_at)
    VALUES ${values}`);
  // Only interactive reservations hold a concurrency lease (aviation_ingest cannot see leases).
  if (row.category === 'interactive') {
    await tx.execute(sql`UPDATE leases SET released_at = ${now} WHERE reservation_id = ${row.id} AND released_at IS NULL`);
  }
  return charged;
}

/** Settle any reservation (interactive or spend) with its fencing token. */
export async function settleReservation(
  db: Db,
  reservationId: number,
  usage: SpendUsage,
  fencingToken: string,
  now: Date = new Date(),
): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, reservationId);
    if (row.fencing_token !== fencingToken) return { ok: false, reason: 'stale_token', status: row.status };
    if (row.status !== 'open') return { ok: false, reason: 'not_open', status: row.status };
    if (now.getTime() >= Number(row.lease_expires_ms)) {
      const full = Number(row.usd_micros);
      const charged = await close(
        tx,
        row,
        'expired_charged',
        [{ micros: full, provider: row.provider, model: row.model, stage: 'lease_expired', tokens: null, uncertain: true }],
        true,
        now,
      );
      return { ok: false, reason: 'lease_expired', status: 'expired_charged', chargedUsd: microsToUsd(charged) };
    }
    const { lines, uncertain } = ledgerLines(usage, row);
    const charged = await close(tx, row, 'settled', lines, uncertain, now);
    return { ok: true, chargedUsd: microsToUsd(charged), uncertain };
  });
}

/** Settle an admitted interactive request. `'uncertain'` charges the full reservation. */
export function settle(
  db: Db,
  admission: { readonly reservationId: number },
  usage: SpendUsage,
  fencingToken: string,
  now: Date = new Date(),
): Promise<SettleResult> {
  return settleReservation(db, admission.reservationId, usage, fencingToken, now);
}

/**
 * Sweep open reservations whose lease has run out: charge each its full reservation
 * (uncertain, never refunded) and free its concurrency slot. Rows a settlement holds
 * right now are skipped; that settlement sees the expiry itself. Under aviation_ingest,
 * row-level security limits the sweep to indexing and evaluation reservations.
 */
export async function expireLeases(db: Db, now: Date = new Date()): Promise<{ expired: number; chargedUsd: number }> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      WITH due AS (
        SELECT id FROM reservations WHERE status = 'open' AND lease_expires_at <= ${now}
        ORDER BY id FOR UPDATE SKIP LOCKED
      )
      UPDATE reservations r SET status = 'expired_charged', settled_at = ${now}, charged_usd = r.usd, uncertain = true
      FROM due WHERE r.id = due.id
      RETURNING r.id, r.category, (r.usd * 1000000)::bigint AS usd_micros`);
    const rows = res.rows as { id: string; category: string; usd_micros: string }[];
    if (rows.length === 0) return { expired: 0, chargedUsd: 0 };
    const ids = rows.map((r) => Number(r.id));
    await tx.execute(sql`
      INSERT INTO cost_ledger (reservation_id, category, principal_kind, principal_hash, provider, model, stage, usd, tokens,
        uncertain, request_id, accounting_day, created_at)
      SELECT id, category, principal_kind, principal_hash, provider, model, 'lease_expired', usd, NULL, true, request_id,
        accounting_day, ${now}
      FROM reservations WHERE id = ANY(${sql.param(ids)}::bigint[]) ORDER BY id`);
    const interactive = rows.filter((r) => r.category === 'interactive').map((r) => Number(r.id));
    if (interactive.length > 0) {
      await tx.execute(sql`
        UPDATE leases SET released_at = ${now}
        WHERE reservation_id = ANY(${sql.param(interactive)}::bigint[]) AND released_at IS NULL`);
    }
    return { expired: rows.length, chargedUsd: microsToUsd(rows.reduce((s, r) => s + Number(r.usd_micros), 0)) };
  });
}
