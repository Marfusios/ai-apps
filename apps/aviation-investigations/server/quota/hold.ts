/**
 * Paid operations held after a restore (RUNBOOK, "Backups"; migration 0020; gate finding 5
 * of Task 22).
 *
 * A backup's ledger stops at the moment it was taken. Restoring it would make the money
 * spent afterwards available again, although the providers still bill it. So after a
 * restore nothing paid may start (interactive admission refuses with `global_paused`
 * `maintenance`, the AI status shows it paused, `reserveSpend` refuses indexing and
 * evaluation spend) until an operator has reconciled the ledger:
 *
 * - The restore sets the hold in its own transaction (docker/postgres/after-restore.sql), and
 *   migration 0020 starts held on a database restored from a backup taken before it.
 *   `holdPaidOperations` (run by `pnpm worker restore-check`) sets it again. A row written in
 *   another database (`database_oid`) holds them too, but nothing relies on that: a new
 *   cluster can repeat an OID.
 * - `reconcileRestore` (`pnpm worker restore-reconcile`) charges, under the spend lock and
 *   in one transaction: every reservation the backup left open, in full (its request's
 *   outcome is unknown, so it is charged like an expired lease), and the spend the restored
 *   ledger lacks: the amounts the providers report for the time since the backup, or, when
 *   they are not known, everything the budgets still allowed this month (`chargeRemaining`),
 *   which keeps paid operations at zero until the month ends. Then it releases the hold.
 *
 * Both run as aviation_migrator, the only role that may change the hold. The lost spend is
 * charged as reservations of principal kind `system` with stage `restore_reconcile`, settled
 * at once and marked uncertain, with one ledger line each; interactive spend in
 * `interactive`, indexing and evaluation spend in `indexing` (they share one allowance).
 */
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import { RESTORE_RECONCILE_STAGE } from '../db/schema/index.js';
import { utcDay } from './buckets.js';
import { microsToNumeric, microsToUsd, remainingCategoryMicros, spendSnapshot, toMicros } from './pacing.js';
import { QuotaInputError, SPEND_LOCK_KEY, type QuotaBudgets } from './policy.js';
import { expireLeases } from './settle.js';

/** `restored`: `held_at` is set (the restore, migration 0020 or the restore check). */
export type HoldReason = 'restored' | 'other_database' | 'missing';

export interface PaidOperationsHold {
  held: boolean;
  /** Why paid operations are held; null when they are not. */
  reason: HoldReason | null;
  heldAt: Date | null;
  reconciledAt: Date | null;
  note: string | null;
}

interface HoldRow {
  held_ms: string | null;
  reconciled_ms: string | null;
  note: string | null;
  same_database: boolean;
}

const CURRENT_DATABASE_OID = sql`(SELECT d.oid::bigint FROM pg_database d WHERE d.datname = current_database())`;

/** The hold as the cost gate sees it. A missing row holds paid operations (fail closed). */
export async function readPaidOperationsHold(db: DbOrTx): Promise<PaidOperationsHold> {
  const res = await db.execute(sql`
    SELECT (extract(epoch FROM held_at) * 1000)::bigint AS held_ms,
      (extract(epoch FROM reconciled_at) * 1000)::bigint AS reconciled_ms, note,
      database_oid = ${CURRENT_DATABASE_OID} AS same_database
    FROM paid_operations_hold WHERE id = 1`);
  const row = res.rows[0] as HoldRow | undefined;
  if (!row) return { held: true, reason: 'missing', heldAt: null, reconciledAt: null, note: null };
  const reason: HoldReason | null = row.held_ms !== null ? 'restored' : row.same_database !== true ? 'other_database' : null;
  return {
    held: reason !== null,
    reason,
    heldAt: row.held_ms === null ? null : new Date(Number(row.held_ms)),
    reconciledAt: row.reconciled_ms === null ? null : new Date(Number(row.reconciled_ms)),
    note: row.note,
  };
}

/** True while paid operations must not start: one cheap read for admission and the spend gate. */
export async function paidOperationsHeld(db: DbOrTx): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT coalesce((SELECT h.held_at IS NOT NULL OR h.database_oid IS DISTINCT FROM ${CURRENT_DATABASE_OID}
      FROM paid_operations_hold h WHERE h.id = 1), true) AS held`);
  return (res.rows[0] as { held: boolean } | undefined)?.held !== false;
}

function checkNote(note: string): string {
  const text = note.trim();
  if (text === '' || text.length > 200) throw new QuotaInputError('A note of 1-200 characters is required');
  return text;
}

/**
 * Hold paid operations (aviation_migrator): after a restore, until `reconcileRestore`. A row
 * from another database keeps its OID, so it stays held for that reason too.
 */
export async function holdPaidOperations(db: DbOrTx, note: string, now: Date = new Date()): Promise<PaidOperationsHold> {
  const text = checkNote(note);
  await db.execute(sql`
    INSERT INTO paid_operations_hold (id, database_oid, held_at, note, updated_at)
    VALUES (1, ${CURRENT_DATABASE_OID}, ${now}, ${text}, ${now})
    ON CONFLICT (id) DO UPDATE SET held_at = coalesce(paid_operations_hold.held_at, EXCLUDED.held_at),
      note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`);
  return readPaidOperationsHold(db);
}

export interface ReconcileInput {
  /** Interactive spend since the backup that the ledger lacks, as the providers report it. */
  interactiveUsd?: number;
  /** Indexing and evaluation spend since the backup that the ledger lacks. */
  ingestionUsd?: number;
  /** Instead of amounts: charge everything the budgets still allow this month. */
  chargeRemaining?: boolean;
  note: string;
  budgets: QuotaBudgets;
  now?: Date;
  /** Compute and report everything, then roll back: nothing is charged or released. */
  dryRun?: boolean;
}

export interface ReconcileReport {
  dryRun: boolean;
  /** Reservations the backup left open, now charged in full. */
  openCharged: { count: number; usd: number };
  /** Lost spend charged, by ledger category. */
  charged: { interactive: number; indexing: number };
  released: boolean;
}

/** Thrown when the restored ledger is not ready to be reconciled; nothing changed. */
export class ReconcileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconcileRefusedError';
  }
}

class DryRunRollback extends Error {
  constructor(readonly report: ReconcileReport) {
    super('dry run');
  }
}

/** Upper bound on one manual amount: a typo must not book a fortune. */
const MAX_AMOUNT_USD = 10_000;

function amountMicros(name: string, usd: number | undefined): number {
  if (usd === undefined) return 0;
  if (!Number.isFinite(usd) || usd < 0 || usd > MAX_AMOUNT_USD) {
    throw new QuotaInputError(`${name} must be between 0 and ${MAX_AMOUNT_USD} USD`);
  }
  return toMicros(usd);
}

/** One settled `system` reservation of `micros` with its ledger line (uncertain: an estimate). */
async function chargeLost(tx: DbOrTx, category: 'interactive' | 'indexing', micros: number, now: Date): Promise<void> {
  if (micros <= 0) return;
  const amount = microsToNumeric(micros);
  const day = utcDay(now);
  const requestId = `restore-reconcile:${now.toISOString()}`;
  const res = await tx.execute(sql`
    INSERT INTO reservations (category, principal_kind, principal_hash, usd, status, lease_expires_at, accounting_day,
      provider, model, stage, request_id, created_at)
    VALUES (${category}, 'system', NULL, ${amount}::numeric, 'open', ${new Date(now.getTime() + 1000)}, ${day}::date,
      NULL, NULL, ${RESTORE_RECONCILE_STAGE}, ${requestId}, ${now})
    RETURNING id`);
  const id = (res.rows[0] as { id: string }).id;
  await tx.execute(sql`
    UPDATE reservations SET status = 'settled', settled_at = ${now}, charged_usd = ${amount}::numeric, uncertain = true
    WHERE id = ${id} AND status = 'open'`);
  await tx.execute(sql`
    INSERT INTO cost_ledger (reservation_id, category, principal_kind, principal_hash, provider, model, stage, usd, tokens,
      uncertain, request_id, accounting_day, created_at)
    VALUES (${id}, ${category}, 'system', NULL, NULL, NULL, ${RESTORE_RECONCILE_STAGE}, ${amount}::numeric, NULL, true,
      ${requestId}, ${day}::date, ${now})`);
}

/**
 * Charge what a restore lost and release the hold (aviation_migrator), in one transaction
 * under the spend lock. Refuses, changing nothing, when paid operations are not held, or
 * while a reservation the backup left open still has a running lease (wait for it).
 */
export async function reconcileRestore(db: Db, input: ReconcileInput): Promise<ReconcileReport> {
  const now = input.now ?? new Date();
  const note = checkNote(input.note);
  const amounts = input.interactiveUsd !== undefined || input.ingestionUsd !== undefined;
  if (amounts === (input.chargeRemaining === true)) {
    throw new QuotaInputError('Give the lost spend (interactive and ingestion amounts) or charge the remaining budgets, not both');
  }
  const interactive = amountMicros('The interactive amount', input.interactiveUsd);
  const ingestion = amountMicros('The ingestion amount', input.ingestionUsd);
  try {
    return await db.transaction(async (tx): Promise<ReconcileReport> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${SPEND_LOCK_KEY})`);
      await tx.execute(sql`SELECT 1 FROM paid_operations_hold WHERE id = 1 FOR UPDATE`);
      const hold = await readPaidOperationsHold(tx);
      if (!hold.held) throw new ReconcileRefusedError('paid operations are not held: there is no restore to reconcile');
      const running = await tx.execute(sql`
        SELECT (extract(epoch FROM max(lease_expires_at)) * 1000)::bigint AS until_ms
        FROM reservations WHERE status = 'open' AND lease_expires_at > ${now}`);
      const until = (running.rows[0] as { until_ms: string | null }).until_ms;
      if (until !== null) {
        throw new ReconcileRefusedError(`a reservation's lease runs until ${new Date(Number(until)).toISOString()}; reconcile after that`);
      }
      // Every reservation the backup left open: its outcome is unknown, so it is charged in full.
      const open = await expireLeases(tx as unknown as Db, now);
      const left = await tx.execute(sql`SELECT count(*)::int AS n FROM reservations WHERE status = 'open'`);
      if ((left.rows[0] as { n: number }).n > 0) {
        throw new ReconcileRefusedError('another transaction holds an open reservation; run the reconciliation again');
      }
      let lostInteractive = interactive;
      let lostIngestion = ingestion;
      if (input.chargeRemaining === true) {
        lostInteractive = remainingCategoryMicros(await spendSnapshot(tx, now), 'interactive', input.budgets);
        await chargeLost(tx, 'interactive', lostInteractive, now);
        lostIngestion = remainingCategoryMicros(await spendSnapshot(tx, now), 'indexing', input.budgets);
        await chargeLost(tx, 'indexing', lostIngestion, now);
      } else {
        await chargeLost(tx, 'interactive', lostInteractive, now);
        await chargeLost(tx, 'indexing', lostIngestion, now);
      }
      await tx.execute(sql`
        INSERT INTO paid_operations_hold (id, database_oid, held_at, reconciled_at, note, updated_at)
        VALUES (1, ${CURRENT_DATABASE_OID}, NULL, ${now}, ${note}, ${now})
        ON CONFLICT (id) DO UPDATE SET database_oid = EXCLUDED.database_oid, held_at = NULL,
          reconciled_at = EXCLUDED.reconciled_at, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`);
      const report: ReconcileReport = {
        dryRun: input.dryRun === true,
        openCharged: { count: open.expired, usd: open.chargedUsd },
        charged: { interactive: microsToUsd(lostInteractive), indexing: microsToUsd(lostIngestion) },
        released: input.dryRun !== true,
      };
      if (input.dryRun === true) throw new DryRunRollback(report);
      return report;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.report;
    throw err;
  }
}
