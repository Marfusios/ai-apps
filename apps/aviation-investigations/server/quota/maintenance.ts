/**
 * Periodic upkeep of the control tables, run inside the API server: expire the leases of
 * reservations nobody settled (`expireLeases`), apply retention (`pruneControls`), mark
 * brief steps whose process died as failed once their reservation is closed
 * (`failOrphanedSteps`), and delete expired sign-in sessions, OAuth state, claimed states
 * and deletion confirmations (`pruneAuth`, server/auth/deletion.ts), in that order: the
 * pass takes locks in the order every writer does (server/auth/lifecycle.ts): briefs
 * before their steps, the anti-abuse records before the sign-in rows, sessions before
 * confirmations. Marking orphaned steps, which comes after the anti-abuse records, skips
 * any step another transaction holds (a later pass finds it) instead of waiting for it.
 *
 * All are available to the app role (`prune_controls()` is granted to `aviation_app` in
 * migration 0008; `expireLeases` and `pruneAuth` need only the table privileges the app
 * already has), so no grant is widened for this. Several API instances may run: each pass takes a
 * transaction-level advisory lock with `pg_try_advisory_xact_lock`, and an instance that
 * does not get it skips the pass. A failure is logged (the error's name only) and never
 * stops the server or the schedule; the next pass tries again.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { MAINTENANCE_LOCK_KEY } from './policy.js';
import { pruneAuth } from '../auth/deletion.js';
import { failOrphanedSteps } from '../briefs/store.js';
import { pruneControls, type PruneReport } from './retention.js';
import { expireLeases } from './settle.js';

export interface MaintenanceLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export type MaintenanceResult =
  | {
      ran: true;
      expired: { expired: number; chargedUsd: number } | null;
      /** Brief steps marked failed because their process died. */
      orphanedSteps: number | null;
      pruned: PruneReport | null;
      /** Expired sign-in rows deleted. */
      authPruned: Awaited<ReturnType<typeof pruneAuth>> | null;
      failed: string[];
    }
  | { ran: false; reason: 'lock_held' | 'failed' };

/** One pass. Never throws. */
export async function runControlMaintenance(db: Db, log: MaintenanceLog, now: Date = new Date()): Promise<MaintenanceResult> {
  try {
    return await db.transaction(async (tx): Promise<MaintenanceResult> => {
      const res = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${MAINTENANCE_LOCK_KEY}) AS ok`);
      if ((res.rows[0] as { ok?: boolean } | undefined)?.ok !== true) return { ran: false, reason: 'lock_held' };
      await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      const failed: string[] = [];
      let expired: { expired: number; chargedUsd: number } | null = null;
      let pruned: PruneReport | null = null;
      let orphanedSteps: number | null = null;
      let authPruned: Awaited<ReturnType<typeof pruneAuth>> | null = null;
      // Leases first, so what they close is retained like any other settled reservation.
      try {
        expired = await tx.transaction((sp) => expireLeases(sp as unknown as Db, now));
      } catch (err) {
        failed.push('expireLeases');
        log.warn({ err: { name: (err as Error)?.name } }, 'control maintenance: lease expiry failed');
      }
      // Retention before the orphaned steps: it locks expired briefs before their steps (the
      // order account deletion and every brief change use), and this pass must not hold a
      // step's lock when it asks for a brief's (migration 0019).
      try {
        pruned = await tx.transaction((sp) => pruneControls(sp));
      } catch (err) {
        failed.push('pruneControls');
        log.warn({ err: { name: (err as Error)?.name } }, 'control maintenance: retention failed');
      }
      // After lease expiry, so a step whose lease just ran out is closed in the same pass.
      try {
        orphanedSteps = await tx.transaction((sp) => failOrphanedSteps(sp, now));
      } catch (err) {
        failed.push('failOrphanedSteps');
        log.warn({ err: { name: (err as Error)?.name } }, 'control maintenance: orphaned brief steps failed');
      }
      try {
        authPruned = await tx.transaction((sp) => pruneAuth(sp));
      } catch (err) {
        failed.push('pruneAuth');
        log.warn({ err: { name: (err as Error)?.name } }, 'control maintenance: sign-in retention failed');
      }
      log.info({ leasesExpired: expired?.expired ?? null, orphanedSteps, pruned, authPruned, failed }, 'control maintenance pass');
      return { ran: true, expired, orphanedSteps, pruned, authPruned, failed };
    });
  } catch (err) {
    log.warn({ err: { name: (err as Error)?.name } }, 'control maintenance failed');
    return { ran: false, reason: 'failed' };
  }
}

export interface MaintenanceJobOptions {
  intervalMs?: number;
  /** Fraction of the interval added or removed at random from each wait (default 0.2). */
  jitter?: number;
  random?: () => number;
  /** Test seams. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** The schedule moves on after this long even if a pass has not settled (default 2 minutes). */
  passTimeoutMs?: number;
  run?: (db: Db, log: MaintenanceLog) => Promise<MaintenanceResult>;
}

export const MAINTENANCE_INTERVAL_MS = 10 * 60_000;

export interface MaintenanceJob {
  stop(): void;
}

/** Schedule `runControlMaintenance` every ~10 minutes, jittered; the first pass is after one jittered wait. */
export function startControlMaintenance(db: Db, log: MaintenanceLog, opts: MaintenanceJobOptions = {}): MaintenanceJob {
  const interval = opts.intervalMs ?? MAINTENANCE_INTERVAL_MS;
  const jitter = opts.jitter ?? 0.2;
  const random = opts.random ?? Math.random;
  const schedule = opts.setTimeout ?? ((fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  });
  const cancel = opts.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  const run = opts.run ?? runControlMaintenance;
  const passTimeoutMs = opts.passTimeoutMs ?? 2 * 60_000;
  let stopped = false;
  let handle: unknown;
  const wait = (): number => Math.max(1, Math.round(interval * (1 + jitter * (2 * random() - 1))));
  const tick = (): void => {
    let deadline: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        log.warn({}, 'control maintenance pass timed out');
        resolve();
      }, passTimeoutMs);
      deadline.unref();
    });
    void Promise.race([run(db, log).then(() => undefined), expired])
      .catch((err: unknown) => log.warn({ err: { name: (err as Error)?.name } }, 'control maintenance failed'))
      .finally(() => {
        clearTimeout(deadline);
        if (!stopped) handle = schedule(tick, wait());
      });
  };
  handle = schedule(tick, wait());
  return {
    stop() {
      stopped = true;
      cancel(handle);
    },
  };
}
