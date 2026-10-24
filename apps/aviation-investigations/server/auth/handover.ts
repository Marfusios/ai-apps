/**
 * Signing in mid-brief (UI_DESIGN §5; DESIGN §7): when an anonymous visitor signs in from
 * a brief, that live brief moves to the new account. Billing and reading are separate:
 *
 * - **Billing principal, per step:** fixed when the step is admitted and never changed
 *   (a guard trigger, migration 0014). Steps admitted before sign-in stay charged to the
 *   trial; refinements admitted after it are charged to the account. Nothing moves
 *   between quotas and nothing is re-charged.
 * - **Read owner, per brief:** this is what moves, by one compare-and-set
 *   (`move_brief_read_owner()`, migration 0014): from the trial that owns the brief to the
 *   account, at most once, only while the brief lives. A second or concurrent attempt
 *   finds no matching row and changes nothing. The brief's steps, running ones included,
 *   and its idempotent results follow the brief: a step still running completes normally
 *   and only the account can read it.
 *
 * Where it happens:
 *
 * 1. **Sign-in start** (`POST /api/auth/sign-in/social`, a Better Auth `before` hook):
 *    when the return path is `/briefs/<id>` and this browser's trial cookie proves the
 *    trial that owns that live brief, the brief and the trial's HMAC ride the OAuth state
 *    as server-trusted context (`addOAuthServerContext`; the client cannot set it).
 * 2. **Callback** (`GET /api/auth/callback/google`, an `after` hook, once the session
 *    exists): the same browser's trial cookie must still prove that trial; then, under
 *    the account's lifecycle lock with its new session checked live (server/auth/
 *    lifecycle.ts) and with the brief locked, the compare-and-set moves the brief to the
 *    account. A callback is accepted once (its OAuth state is claimed atomically before a
 *    user or session is made, server/auth/better-auth.ts), so a replay never gets here;
 *    two concurrent callbacks of two sign-ins (two tabs) both try, and only one moves the
 *    brief.
 * 3. **A signed-in request on a brief this browser's trial still owns** (a sign-in that
 *    started elsewhere): a refinement, admitted and billed to the account, or the retry of
 *    a request the trial made, takes the brief over by the same compare-and-set first,
 *    under the same lock and checks (server/routes/briefs.ts). Reads never move anything.
 *
 * After a move the trial cannot read the brief (404), and an idempotent retry from the
 * trial alone gets 403 `moved` ("sign in to view"): never a replay, never a new run. The
 * same retry from the signed-in browser replays the brief for the account. An account
 * deleted meanwhile takes nothing over (`account_gone`): the brief stays the trial's.
 */
import { readOwnedSearch, takeOverSearch } from '../evidence/store.js';
import { sql } from 'drizzle-orm';
import { BriefIdSchema } from '../../shared/contracts/briefs.js';
import { lockBrief, moveBriefReadOwner, readBrief } from '../briefs/store.js';
import type { Db, DbOrTx } from '../db/client.js';
import type { TrialIdentities } from '../identity/trial.js';
import { principalHash, type QuotaPolicy } from '../quota/policy.js';
import { ACCOUNT_GONE, withLiveAccount, type AccountSession } from './lifecycle.js';

/** The key of the handover in the OAuth state's server context. */
export const HANDOVER_CONTEXT_KEY = 'aviationHandover';

export interface HandoverDeps {
  /** PostgreSQL as aviation_app. */
  db: Db;
  policy: QuotaPolicy;
  trials: TrialIdentities;
  now: () => Date;
}

/** A brief a sign-in may take over: its id and the HMAC of the trial that owns it. */
export interface HandoverCandidate {
  kind?: 'evidence';
  briefId: string;
  from: string;
}

/**
 * What the callback did: `moved` the brief; found it `already_moved` to this account; the
 * browser's trial cookie no longer proves the owner (`trial_changed`); the brief is no
 * longer the trial's to give (`not_moved`: expired, or another account took it first); or
 * the account or its new session was gone by then (`account_gone`: deleted meanwhile).
 */
export type HandoverOutcome = 'moved' | 'already_moved' | 'trial_changed' | 'not_moved' | 'account_gone';

const HEX64 = /^[0-9a-f]{64}$/;
const BRIEF_PATH = /^\/briefs\/([0-9a-f-]{36})(?:\?[^#]*)?$/;

/** The brief of a return path `/briefs/<id>` (with any query), or null. */
export function briefOfReturnPath(path: string): string | null {
  const id = BRIEF_PATH.exec(path)?.[1];
  return id && BriefIdSchema.safeParse(id).success ? id : null;
}

/** A candidate read back from the OAuth state, or null when it is not one. */
export function parseHandoverCandidate(value: unknown): HandoverCandidate | null {
  if (typeof value !== 'object' || value === null) return null;
  const { briefId, from, kind } = value as Record<string, unknown>;
  if (kind !== undefined && kind !== 'evidence') return null;
  if (typeof briefId !== 'string' || !BriefIdSchema.safeParse(briefId).success) return null;
  if (typeof from !== 'string' || !HEX64.test(from)) return null;
  return { briefId, from, ...(kind === 'evidence' ? { kind } : {}) };
}

/**
 * At sign-in start: the brief this sign-in may take over, when the return path names a
 * live brief that the trial proven by this browser's cookie reads. Otherwise null.
 */
export async function handoverCandidate(deps: HandoverDeps, cookieHeader: string | null, returnPath: string): Promise<HandoverCandidate | null> {
  const evidenceId = /^\/ai\/([0-9a-f-]{36})(?:\?[^#]*)?$/.exec(returnPath)?.[1];
  const kind = evidenceId && BriefIdSchema.safeParse(evidenceId).success ? 'evidence' as const : undefined;
  const briefId = kind ? evidenceId! : briefOfReturnPath(returnPath);
  if (!briefId) return null;
  const now = deps.now();
  const trial = await deps.trials.fromCookieHeader(cookieHeader, now);
  if (!trial) return null;
  const from = principalHash(deps.policy, trial);
  const brief = kind
    ? await readOwnedSearch(deps.db, briefId, [{ kind: 'trial', hash: from }], now)
    : await readBrief(deps.db, briefId, now);
  if (!brief || brief.expiresAt <= now || brief.readOwner !== from || brief.readOwnerKind !== 'trial') return null;
  return { briefId, from, ...(kind ? { kind } : {}) };
}

/**
 * At the callback, once the account's session exists: move the brief when this browser's
 * trial cookie still proves the trial recorded at sign-in start, under the account's
 * lifecycle lock with its session checked live.
 */
export async function completeHandover(
  deps: HandoverDeps,
  cookieHeader: string | null,
  candidate: HandoverCandidate,
  account: AccountSession,
): Promise<HandoverOutcome> {
  const now = deps.now();
  const trial = await deps.trials.fromCookieHeader(cookieHeader, now);
  if (!trial || principalHash(deps.policy, trial) !== candidate.from) return 'trial_changed';
  const outcome = await withLiveAccount(deps.db, account, async (tx): Promise<HandoverOutcome> => {
    const took = candidate.kind === 'evidence'
      ? (await takeOverSearch(tx, candidate.briefId, candidate.from, account.hash)) ? 'moved' :
        (await readOwnedSearch(tx, candidate.briefId, [{ kind: 'account', hash: account.hash }], now)) !== null ? 'already' : 'no'
      : await takeOver(tx, candidate.briefId, candidate.from, account.hash, now);
    if (took === 'moved') return 'moved';
    return took === 'already' ? 'already_moved' : 'not_moved';
  });
  return outcome === ACCOUNT_GONE ? 'account_gone' : outcome;
}

/**
 * A signed-in request takes over a brief its browser's trial still owns: the brief is
 * locked (`lock_brief()`), its owner checked, then the compare-and-set moves it. Must run
 * in a transaction that holds the account's lifecycle lock with its session checked live
 * (`withLiveAccount`). `moved` now, `already` the account's (a concurrent request of the
 * same browser moved it), or `no` (not this trial's live brief).
 */
export async function takeOver(tx: DbOrTx, briefId: string, trialHash: string, accountHash: string, now: Date): Promise<'moved' | 'already' | 'no'> {
  const brief = await lockBrief(tx, briefId);
  if (!brief || brief.expiresAt <= now) return 'no';
  if (brief.readOwner === accountHash && brief.readOwnerKind === 'account') return 'already';
  if (brief.readOwner !== trialHash || brief.readOwnerKind !== 'trial') return 'no';
  return (await moveBriefReadOwner(tx, briefId, trialHash, accountHash)) ? 'moved' : 'no';
}

/**
 * True when `trialHash` asked this live brief's first question and the brief has since
 * moved to an account: a retry from that trial gets `moved`.
 */
export async function movedFrom(db: DbOrTx, briefId: string, trialHash: string, now: Date): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM briefs b JOIN brief_steps s ON s.brief_id = b.id AND s.n = 1
      WHERE b.id = ${briefId}::uuid AND b.owner_moved_at IS NOT NULL AND b.expires_at > ${now}
        AND s.billing_principal = ${trialHash} AND s.billing_kind = 'trial'
    ) AS moved`);
  return (res.rows[0] as { moved?: boolean } | undefined)?.moved === true;
}
