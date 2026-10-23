/**
 * Account deletion and the retention of sign-in rows (DESIGN §7; UI_DESIGN §4.8).
 *
 * **A recent Google sign-in first** (OWASP: re-authenticate before sensitive operations).
 * Deleting needs a single-use confirmation (`auth_deletion_confirmations`) bound to the
 * session and to its account, valid for 5 minutes. Only a session created by a Google
 * sign-in in the last 5 minutes gets one (`issueDeletionConfirmation`):
 *
 * - right after signing in, the account page asks for it directly (no other prompt);
 * - otherwise the page sends the person through Google again with the deletion intent
 *   (server/auth/better-auth.ts): the callback issues the confirmation to the new session
 *   only when Google signed in the same account (the same subject), and ends the session
 *   the browser had before (a re-authentication rotates the session).
 *
 * A stolen session cookie therefore cannot delete the account unless it is minutes old;
 * Google's own account chooser and sign-in are the re-authentication (Google offers no
 * `max_age` or `prompt=login`).
 *
 * `deleteAccount`, for the signed-in account (`POST /api/account/delete`), in one
 * transaction as aviation_app that holds the account's lifecycle lock (server/auth/
 * lifecycle.ts), so no request of the account can create or take over content while it
 * runs and none can afterwards:
 *
 * - **The confirmation is consumed** (deleted) first; without a live one nothing happens.
 * - **Saved content goes:** every brief the account reads, with all its steps (questions,
 *   answers, evidence and diagnostics, steps billed to the trial that signed in
 *   included), and the account's idempotency records (hashes of its requests), through
 *   `delete_account_content()` (migrations 0017, 0018), which locks the briefs first and
 *   returns the steps that were still running. After the commit each of those that runs in
 *   this process is aborted; one running elsewhere stops at its next stage, which finds no
 *   row. Either way it settles as usual and its final write finds nothing left.
 * - **Every session ends:** the user row goes, and its sessions, Google account link and
 *   confirmations with it (ON DELETE CASCADE), so every browser signed in to it is signed
 *   out on its next request (no session cookie cache). The route also expires this
 *   browser's cookie.
 * - **Kept, without email or profile:** the anti-abuse record keyed by HMAC(issuer, sub)
 *   (`abuse_records`), retained at least until the current month's quota window ends plus
 *   7 days, and the usage buckets, reservations and ledger lines, which carry only that
 *   HMAC and amounts. Signing up again with the same Google account finds the same counts:
 *   deletion never grants fresh quota. Backups never hold accounts or content
 *   (server/db/backup.ts), so a restore cannot bring a deleted account back.
 *
 * `pruneAuth` (control maintenance, about every 10 minutes) deletes expired sessions,
 * OAuth state, claimed states and confirmations; Better Auth itself deletes a session at
 * sign-out and OAuth state when its callback consumes it.
 */
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import type { RunningStep } from '../briefs/services.js';
import { accountRequestBuckets } from '../quota/admit.js';
import { addToBuckets, bucketRef, countsOf, lockBuckets } from '../quota/buckets.js';
import { isLockTimeout, setLockTimeout } from '../quota/locks.js';
import { lockAccount, sessionLive, type AccountSession } from './lifecycle.js';

/** A session's Google sign-in counts as recent this long (the re-authentication window). */
export const RECENT_SIGN_IN_SECONDS = 300;
/** A deletion confirmation lives this long. */
export const DELETION_CONFIRMATION_SECONDS = 300;
/**
 * A signed-in account may start at most this many re-authentications for a deletion per
 * UTC hour. They are counted per account, not per network, so other sign-in traffic on its
 * network never holds them up (server/routes/account.ts).
 */
export const REAUTH_STARTS_PER_HOUR = 5;
/** Deletion waits at most this long for the account's lock (requests hold it for milliseconds). */
const DELETION_LOCK_TIMEOUT = '5s';

export interface DeletionReport {
  briefs: number;
  briefSteps: number;
  idempotency: number;
  /** Steps that were still running (stopped after the commit). */
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

/**
 * Give this session a deletion confirmation (5 minutes, single use), replacing one it
 * had: only while the session is live and its Google sign-in was within the last
 * `RECENT_SIGN_IN_SECONDS`. Its expiry, or null (a fresh sign-in is needed first).
 */
export async function issueDeletionConfirmation(db: Db, session: Pick<AccountSession, 'userId' | 'sessionId'>): Promise<Date | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM auth_deletion_confirmations WHERE session_id = ${session.sessionId}::uuid`);
    const res = await tx.execute(sql`
      INSERT INTO auth_deletion_confirmations (session_id, user_id, created_at, expires_at)
      SELECT s.id, s.user_id, now(), now() + make_interval(secs => ${DELETION_CONFIRMATION_SECONDS})
      FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
      WHERE s.id = ${session.sessionId}::uuid AND s.user_id = ${session.userId}::uuid AND s.expires_at > now()
        AND s.created_at > now() - make_interval(secs => ${RECENT_SIGN_IN_SECONDS})
      RETURNING (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms`);
    const row = res.rows[0] as { expires_ms: string } | undefined;
    return row ? new Date(Number(row.expires_ms)) : null;
  });
}

/**
 * Count one start of a deletion's re-authentication for this account, unless it already
 * made `REAUTH_STARTS_PER_HOUR` this UTC hour: then when it may try again. One short
 * transaction on the account's usage bucket row (locked), so concurrent starts never
 * exceed the limit. A lock wait that times out refuses (fail closed).
 */
export async function reauthStartAllowed(db: Db, accountHash: string, now: Date): Promise<{ ok: true } | { ok: false; retryAt: Date }> {
  const ref = bucketRef('principal', `reauth:${accountHash}`, 'hour', now);
  try {
    return await db.transaction(async (tx) => {
      await setLockTimeout(tx);
      const counts = await lockBuckets(tx, [ref]);
      if (countsOf(counts, ref).attempts >= REAUTH_STARTS_PER_HOUR) return { ok: false as const, retryAt: ref.end };
      await addToBuckets(tx, [ref], 'attempts', 1);
      return { ok: true as const };
    });
  } catch (err) {
    if (isLockTimeout(err)) return { ok: false, retryAt: new Date(now.getTime() + 60_000) };
    throw err;
  }
}

/** Until when this session's deletion confirmation lives, or null. */
export async function deletionConfirmedUntil(db: DbOrTx, sessionId: string): Promise<Date | null> {
  const res = await db.execute(sql`
    SELECT (extract(epoch FROM expires_at) * 1000)::bigint AS expires_ms FROM auth_deletion_confirmations
    WHERE session_id = ${sessionId}::uuid AND expires_at > now()`);
  const row = res.rows[0] as { expires_ms: string } | undefined;
  return row ? new Date(Number(row.expires_ms)) : null;
}

/** End one session (a re-authentication replaced it). */
export async function endSession(db: DbOrTx, sessionId: string): Promise<void> {
  await db.execute(sql`DELETE FROM auth_sessions WHERE id = ${sessionId}::uuid`);
}

/** Why `deleteAccount` deleted nothing. */
export type NotDeleted = 'not_confirmed' | 'signed_out';

/**
 * Delete the signed-in account and its saved content, consuming this session's
 * confirmation; keep the anti-abuse record. `signed_out` when the session or the account
 * is already gone, `not_confirmed` without a live confirmation (nothing changes).
 */
export async function deleteAccount(deps: DeletionDeps, account: AccountSession): Promise<DeletionReport | NotDeleted> {
  const now = deps.now();
  const retainUntil = abuseRecordRetention(account.hash, now);
  const done = await deps.db.transaction(async (tx): Promise<{ report: DeletionReport; running: string[] } | NotDeleted> => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${DELETION_LOCK_TIMEOUT}'`));
    await lockAccount(tx, account.hash);
    if (!(await sessionLive(tx, account))) return 'signed_out';
    const confirmed = await tx.execute(sql`
      DELETE FROM auth_deletion_confirmations
      WHERE session_id = ${account.sessionId}::uuid AND user_id = ${account.userId}::uuid AND expires_at > now()
      RETURNING session_id`);
    if (confirmed.rows.length === 0) return 'not_confirmed';
    const content = await tx.execute(sql`SELECT delete_account_content(${account.hash}) AS report`);
    const r = (content.rows[0] as { report: { briefs: number; briefSteps: number; idempotency: number; running: string[] } }).report;
    await tx.execute(sql`DELETE FROM auth_users WHERE id = ${account.userId}::uuid`);
    await tx.execute(sql`
      INSERT INTO abuse_records (identity_hash, first_seen_at, last_seen_at, retain_until)
      VALUES (${account.hash}, ${now}, ${now}, ${retainUntil})
      ON CONFLICT (identity_hash) DO UPDATE
        SET last_seen_at = greatest(abuse_records.last_seen_at, EXCLUDED.last_seen_at),
            retain_until = greatest(abuse_records.retain_until, EXCLUDED.retain_until)`);
    return { report: { briefs: r.briefs, briefSteps: r.briefSteps, idempotency: r.idempotency, cancelledSteps: r.running.length }, running: r.running };
  });
  if (typeof done === 'string') return done;
  // Committed: stop the account's steps that run here (they find no row to write to).
  for (const id of done.running) deps.runs?.get(id)?.controller.abort();
  return done.report;
}

/** Delete expired sessions, OAuth state, claimed states and deletion confirmations (database time). */
export async function pruneAuth(db: DbOrTx): Promise<{ sessions: number; verifications: number; stateUses: number; confirmations: number }> {
  const sessions = await db.execute(sql`DELETE FROM auth_sessions WHERE expires_at < now()`);
  const verifications = await db.execute(sql`DELETE FROM auth_verifications WHERE expires_at < now()`);
  const stateUses = await db.execute(sql`DELETE FROM auth_state_uses WHERE expires_at < now()`);
  const confirmations = await db.execute(sql`DELETE FROM auth_deletion_confirmations WHERE expires_at < now()`);
  return {
    sessions: sessions.rowCount ?? 0,
    verifications: verifications.rowCount ?? 0,
    stateUses: stateUses.rowCount ?? 0,
    confirmations: confirmations.rowCount ?? 0,
  };
}
