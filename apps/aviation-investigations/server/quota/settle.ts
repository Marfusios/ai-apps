/**
 * Settlement and lease expiry (DESIGN §8), shared by interactive requests and by
 * indexing/evaluation spend.
 *
 * - Settling needs the reservation's fencing token and an open, unexpired lease. It
 *   writes the reported usage to the ledger and releases the rest of the reservation.
 * - A call whose usage is not known (no reliable usage report, a timeout, an abort) is
 *   one line marked uncertain, charged at that call's own worst case (`SpendLine.uncertain`;
 *   DESIGN §9, "Uncertain calls"): its stage's maximum at its hard caps, which no bill
 *   for the call can exceed. Uncertain lines together never take the charge past the
 *   reservation; where they would, they are cut to what the reservation leaves and the
 *   reservation is charged in full.
 * - Usage that is uncertain as a whole (`'uncertain'`, or `uncertain: true` with known
 *   lines: the caller cannot tell which call it was) settles at the full reservation:
 *   known lines are kept and the remainder up to the reservation is one uncertain line.
 * - A reservation charged in full because of uncertainty is marked `uncertain` (migration
 *   0009 holds such a reservation to at least its amount). One charged less, with
 *   uncertain lines at their worst cases, is not; its uncertain lines are.
 * - A lease that expires first is charged the full reservation (`expired_charged`) and
 *   never refunded; a late settlement is refused. Expiry frees the concurrency slot.
 */
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import type { ReservationStatus } from '../db/schema/index.js';
import { microsToNumeric, microsToUsd, toMicros } from './pacing.js';
import { isLockTimeout, setLockTimeout } from './locks.js';
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
  /**
   * The call's usage is not known: `usd` is its own worst case (the stage's maximum at its
   * hard caps, DESIGN §9), charged as an uncertain line.
   */
  uncertain?: boolean;
}

/**
 * What a reservation is charged: a USD amount, `'uncertain'` (the full reservation),
 * or itemized lines (an uncertain line at its call's worst case), optionally marked
 * uncertain as a whole (the lines plus the rest of the reservation).
 */
export type SpendUsage = number | 'uncertain' | { readonly lines: readonly SpendLine[]; readonly uncertain?: boolean };

export type SettleRefusal = 'stale_token' | 'not_open' | 'lease_expired';

export type SettleResult =
  /** `uncertain`: some of the charge is for usage that is not known (uncertain lines, or the full reservation). */
  | { ok: true; chargedUsd: number; uncertain: boolean }
  | {
      ok: false;
      reason: SettleRefusal;
      status: ReservationStatus;
      /** For `lease_expired`: the full reservation, charged now. */
      chargedUsd?: number;
    }
  /**
   * A lock wait timed out (2 s) and nothing changed: the reservation stays open and
   * still counts in full. Retry while the lease lasts; otherwise expiry charges it.
   */
  | { ok: false; reason: 'busy' };

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

/**
 * The ledger lines of a settlement, and whether it is charged in full because of
 * uncertainty (`full`, the reservation's `uncertain` column) or carries any uncertain
 * line (`uncertain`, the result's).
 */
function ledgerLines(usage: SpendUsage, row: ReservationRow): { lines: LedgerLine[]; uncertain: boolean; full: boolean } {
  const defaultStage = row.stage ?? 'request';
  const reservation = Number(row.usd_micros);
  let lines: LedgerLine[];
  let remainder: boolean;
  if (usage === 'uncertain') {
    lines = [];
    remainder = true;
  } else if (typeof usage === 'number') {
    lines = [
      { micros: toMicros(usage), provider: row.provider, model: row.model, stage: defaultStage, tokens: null, uncertain: false },
    ];
    remainder = false;
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
        uncertain: l.uncertain === true,
      };
    });
    remainder = usage.uncertain === true;
  }
  // Uncertain lines (each at its call's worst case) never take the charge past the
  // reservation: in order, each is cut to what the known lines and those before it leave.
  let room = Math.max(0, reservation - lines.reduce((s, l) => s + (l.uncertain ? 0 : l.micros), 0));
  let cut = false;
  for (const l of lines) {
    if (!l.uncertain) continue;
    if (l.micros > room) {
      l.micros = room;
      cut = true;
    }
    room -= l.micros;
  }
  if (remainder) {
    const charged = lines.reduce((s, l) => s + l.micros, 0);
    lines.push({
      micros: Math.max(0, reservation - charged),
      provider: row.provider,
      model: row.model,
      stage: 'uncertain',
      tokens: null,
      uncertain: true,
    });
  } else if (lines.length === 0) {
    lines.push({ micros: 0, provider: row.provider, model: row.model, stage: defaultStage, tokens: null, uncertain: false });
  }
  return { lines, uncertain: lines.some((l) => l.uncertain), full: remainder || cut };
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

/**
 * Close an open reservation with these ledger lines and release its lease. `uncertain`:
 * charged in full because of uncertainty (the reservation's column).
 */
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
  try {
    return await db.transaction(async (tx): Promise<SettleResult> => {
      await setLockTimeout(tx);
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
      const { lines, uncertain, full } = ledgerLines(usage, row);
      const charged = await close(tx, row, 'settled', lines, full, now);
      return { ok: true, chargedUsd: microsToUsd(charged), uncertain };
    });
  } catch (err) {
    if (isLockTimeout(err)) return { ok: false, reason: 'busy' };
    throw err;
  }
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
