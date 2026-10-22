/**
 * Periodic upkeep of the control tables, run inside the API server: expire the leases of
 * reservations nobody settled (`expireLeases`) and apply retention (`pruneControls`).
 *
 * Both are available to the app role (`prune_controls()` is granted to `aviation_app` in
 * migration 0008; `expireLeases` needs only the table privileges the app already has),
 * so no grant is widened for this. Several API instances may run: each pass takes a
 * transaction-level advisory lock with `pg_try_advisory_xact_lock`, and an instance that
 * does not get it skips the pass. A failure is logged (the error's name only) and never
 * stops the server or the schedule; the next pass tries again.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { MAINTENANCE_LOCK_KEY } from './policy.js';
import { pruneControls, type PruneReport } from './retention.js';
import { expireLeases } from './settle.js';

export interface MaintenanceLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export type MaintenanceResult =
  | { ran: true; expired: { expired: number; chargedUsd: number } | null; pruned: PruneReport | null; failed: string[] }
  | { ran: false; reason: 'lock_held' | 'failed' };

/** One pass. Never throws. */
export async function runControlMaintenance(db: Db, log: MaintenanceLog, now: Date = new Date()): Promise<MaintenanceResult> {
  try {
    return await db.transaction(async (tx): Promise<MaintenanceResult> => {
      const res = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${MAINTENANCE_LOCK_KEY}) AS ok`);
      if ((res.rows[0] as { ok?: boolean } | undefined)?.ok !== true) return { ran: false, reason: 'lock_held' };
      const failed: string[] = [];
      let expired: { expired: number; chargedUsd: number } | null = null;
      let pruned: PruneReport | null = null;
      // Leases first, so what they close is retained like any other settled reservation.
      try {
        expired = await expireLeases(db, now);
      } catch (err) {
        failed.push('expireLeases');
        log.warn({ err: { name: (err as Error)?.name } }, 'control maintenance: lease expiry failed');
      }
      try {
        pruned = await pruneControls(tx);
      } catch (err) {
        failed.push('pruneControls');
        log.warn({ err: { name: (err as Error)?.name } }, 'control maintenance: retention failed');
      }
      return { ran: true, expired, pruned, failed };
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
  let stopped = false;
  let handle: unknown;
  const wait = (): number => Math.max(1, Math.round(interval * (1 + jitter * (2 * random() - 1))));
  const tick = (): void => {
    void run(db, log)
      .catch((err: unknown) => log.warn({ err: { name: (err as Error)?.name } }, 'control maintenance failed'))
      .finally(() => {
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
