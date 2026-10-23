/**
 * An account's lifecycle (DESIGN §7: "Account deletion ends sessions and removes saved
 * content"): what keeps a deletion from racing the requests that create or move content
 * for the account.
 *
 * - **One lock per account.** A transaction-level advisory lock keyed by the account's
 *   HMAC (`accountLockKey`; a re-registered account has the same HMAC, so the same lock).
 *   Account deletion holds it for its whole transaction (server/auth/deletion.ts), and so
 *   does every transaction that writes rows the account owns: the end of the admission of
 *   the account's paid request (before anything is reserved), the transaction that
 *   creates its brief or step (server/routes/briefs.ts), a signed-in takeover of a brief
 *   this browser's trial owns, and the sign-in callback's handover
 *   (server/auth/handover.ts).
 * - **Revalidation under the lock.** Each of them first checks that the session the
 *   request was authenticated with still exists and has not expired, and that its user
 *   still exists (`lockLiveAccount`). Deletion removes the user, and with it every
 *   session, before it commits; so a request that read its session before the deletion
 *   and reaches one of these points after it creates nothing: no reservation, no brief
 *   or step, no handover, no model call. Between admission and its step only a step
 *   transaction can see the account gone; it gives the admission back (the search
 *   returned, the reservation settled at zero) and nothing runs.
 * - Lock waits are bounded like the cost gate's (`setLockTimeout`, 2 s) and fail closed.
 */
import { sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client.js';
import { setLockTimeout } from '../quota/locks.js';

/** Class of the two-key advisory locks of accounts (single-key advisory locks are another key space). */
export const ACCOUNT_LOCK_CLASS = 7_311_906;

/** The advisory lock of the account with this HMAC: the class and the HMAC's first 32 bits. */
export function accountLockKey(accountHash: string): [number, number] {
  if (!/^[0-9a-f]{64}$/.test(accountHash)) throw new Error('an account lock needs the account HMAC');
  return [ACCOUNT_LOCK_CLASS, Number.parseInt(accountHash.slice(0, 8), 16) | 0];
}

/** The signed-in account a request was authenticated as: its HMAC, its user and the session. */
export interface AccountSession {
  hash: string;
  userId: string;
  sessionId: string;
}

/** Take the account's lifecycle lock until the transaction ends. */
export async function lockAccount(tx: DbOrTx, accountHash: string): Promise<void> {
  const [classId, objectId] = accountLockKey(accountHash);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${classId}::int, ${objectId}::int)`);
}

/** True while the session exists, belongs to the user and has not expired (database time, as Better Auth's own check). */
export async function sessionLive(db: DbOrTx, who: Pick<AccountSession, 'userId' | 'sessionId'>): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
      WHERE s.id = ${who.sessionId}::uuid AND s.user_id = ${who.userId}::uuid AND s.expires_at > now()
    ) AS live`);
  return (res.rows[0] as { live?: boolean } | undefined)?.live === true;
}

/** Lock the account, then check its session: true when the transaction may write for it. */
export async function lockLiveAccount(tx: DbOrTx, who: AccountSession): Promise<boolean> {
  await lockAccount(tx, who.hash);
  return sessionLive(tx, who);
}

/** What `withLiveAccount` returns when the session or the account is gone (nothing was done). */
export const ACCOUNT_GONE = Symbol('account gone');

/**
 * Run `fn` in a transaction that holds the account's lock, once the session is checked
 * live under it; `ACCOUNT_GONE` (and nothing done) otherwise.
 */
export async function withLiveAccount<T>(db: Db, who: AccountSession, fn: (tx: DbOrTx) => Promise<T>): Promise<T | typeof ACCOUNT_GONE> {
  return db.transaction(async (tx) => {
    await setLockTimeout(tx);
    if (!(await lockLiveAccount(tx, who))) return ACCOUNT_GONE;
    return fn(tx);
  });
}
