/**
 * Account deletion and the retention of sign-in rows (DESIGN §7; UI_DESIGN §4.8).
 *
 * `deleteAccount`, for the signed-in account (`POST /api/account/delete`), in one
 * transaction as aviation_app:
 *
 * - **Saved content goes:** every brief the account reads, with all its steps (questions,
 *   answers, evidence and diagnostics, steps billed to the trial that signed in
 *   included), and the account's idempotency records (hashes of its requests), through
 *   `delete_account_content()` (migration 0017). A step still running is cancelled first;
 *   it settles as usual and its final write finds nothing left.
 * - **Every session ends:** the user row goes, and its sessions and Google account link
 *   with it (ON DELETE CASCADE), so every browser signed in to it is signed out on its
 *   next request (no session cookie cache). The route also expires this browser's cookie.
 * - **Kept, without email or profile:** the anti-abuse record keyed by HMAC(issuer, sub)
 *   (`abuse_records`), retained at least until the current month's quota window ends plus
 *   7 days, and the usage buckets, reservations and ledger lines, which carry only that
 *   HMAC and amounts. Signing up again with the same Google account finds the same counts:
 *   deletion never grants fresh quota. Backups expire within 30 days (RUNBOOK).
 *
 * `pruneAuth` (control maintenance, about every 10 minutes) deletes expired sessions and
 * expired OAuth state; Better Auth itself deletes a session at sign-out and OAuth state
 * when its callback consumes it.
 */
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import { requestCancel } from '../briefs/store.js';
import type { RunningStep } from '../briefs/services.js';
import { accountRequestBuckets } from '../quota/admit.js';
import type { SignedIn } from './better-auth.js';

export interface DeletionReport {
  briefs: number;
  briefSteps: number;
  idempotency: number;
  /** Running steps cancelled first. */
  cancelledSteps: number;
}

export interface DeletionDeps {
  /** PostgreSQL as aviation_app. */
  db: Db;
  /** Steps running in this process (server/briefs/services.ts), to stop the account's. */
  runs?: Map<string, RunningStep> | null;
  now: () => Date;
}

/** Until when the anti-abuse record of an account deleted at `now` is kept: the month's window plus 7 days. */
export function abuseRecordRetention(accountHash: string, now: Date): Date {
  return accountRequestBuckets(accountHash, now).month.expiresAt;
}

/** Delete the signed-in account and its saved content; keep the anti-abuse record. */
export async function deleteAccount(deps: DeletionDeps, account: Pick<SignedIn, 'userId' | 'hash'>): Promise<DeletionReport> {
  const now = deps.now();
  const running = await deps.db.execute(sql`
    SELECT s.id::text AS id FROM brief_steps s JOIN briefs b ON b.id = s.brief_id
    WHERE b.read_owner = ${account.hash} AND b.read_owner_kind = 'account' AND s.status = 'running'`);
  const stepIds = (running.rows as { id: string }[]).map((r) => r.id);
  for (const id of stepIds) {
    await requestCancel(deps.db, id, now);
    deps.runs?.get(id)?.controller.abort();
  }
  const retainUntil = abuseRecordRetention(account.hash, now);
  return deps.db.transaction(async (tx) => {
    const content = await tx.execute(sql`SELECT delete_account_content(${account.hash}) AS report`);
    const report = (content.rows[0] as { report: { briefs: number; briefSteps: number; idempotency: number } }).report;
    await tx.execute(sql`DELETE FROM auth_users WHERE id = ${account.userId}::uuid`);
    await tx.execute(sql`
      INSERT INTO abuse_records (identity_hash, first_seen_at, last_seen_at, retain_until)
      VALUES (${account.hash}, ${now}, ${now}, ${retainUntil})
      ON CONFLICT (identity_hash) DO UPDATE
        SET last_seen_at = greatest(abuse_records.last_seen_at, EXCLUDED.last_seen_at),
            retain_until = greatest(abuse_records.retain_until, EXCLUDED.retain_until)`);
    return { ...report, cancelledSteps: stepIds.length };
  });
}

/** Delete expired sessions and expired OAuth state (database time). */
export async function pruneAuth(db: DbOrTx): Promise<{ sessions: number; verifications: number }> {
  const sessions = await db.execute(sql`DELETE FROM auth_sessions WHERE expires_at < now()`);
  const verifications = await db.execute(sql`DELETE FROM auth_verifications WHERE expires_at < now()`);
  return { sessions: sessions.rowCount ?? 0, verifications: verifications.rowCount ?? 0 };
}
