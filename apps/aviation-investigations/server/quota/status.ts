/**
 * Coarse AI availability for `GET /api/ai/status` (UI_DESIGN §5): a state, a reason,
 * a retry time only when it is known, and the principal's own remaining searches.
 * It never reveals budget amounts. Reads only; admission makes the binding decision.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { accountDailyLimit, accountRequestBuckets, type PauseReason } from './admit.js';
import { nextMonthStart, nextUtcMidnight, readBuckets } from './buckets.js';
import { checkInteractiveBudget, spendSnapshot, toMicros } from './pacing.js';
import { principalHash, type Principal, type QuotaPolicy } from './policy.js';
import { readAiSwitch } from './switch.js';

export type AiState = 'available' | 'signed_in_only' | 'paused';

/**
 * `paused`: `daily_budget`, `monthly_budget` or `maintenance` for everyone, `daily_cap` or
 * `monthly_cap` for this account. `signed_in_only`: `trial_used` or `anonymous_share`.
 * (`dependency`, for a failed startup check or unavailable quota storage, is the route's.)
 */
export type AiStatusReason = PauseReason | 'daily_cap' | 'monthly_cap' | 'trial_used' | 'anonymous_share';

export type AiRemaining =
  | { kind: 'trial'; left: number; limit: number }
  | { kind: 'account'; leftToday: number; limitToday: number; leftThisMonth: number; limitThisMonth: number };

export interface AiStatus {
  state: AiState;
  reason?: AiStatusReason;
  retryAt?: Date;
  remaining: AiRemaining;
}

export interface AiStatusOptions {
  policy: QuotaPolicy;
  /** The per-request reservation; "available" means one more request fits. */
  reservationUsd: number;
  now?: Date;
}

async function remainingFor(
  db: DbOrTx,
  policy: QuotaPolicy,
  principal: Principal | null,
  now: Date,
): Promise<{ remaining: AiRemaining; dailyRetryAt: Date }> {
  const l = policy.limits;
  const tomorrow = nextUtcMidnight(now);
  if (principal === null || principal.kind === 'trial') {
    let used = 0;
    if (principal !== null) {
      principalHash(policy, principal); // throws on a malformed trial id
      const res = await db.execute(
        sql`SELECT requests_used FROM trial_identities WHERE id = ${principal.id}::uuid AND expires_at > ${now}`,
      );
      used = (res.rows[0] as { requests_used: number } | undefined)?.requests_used ?? 0;
    }
    return {
      remaining: { kind: 'trial', left: Math.max(0, l.trialRequests - used), limit: l.trialRequests },
      dailyRetryAt: tomorrow,
    };
  }
  const refs = accountRequestBuckets(principalHash(policy, principal), now);
  const counts = await readBuckets(db, [refs.day, refs.month]);
  const today = counts.get(refs.day.key)?.requests ?? 0;
  const month = counts.get(refs.month.key)?.requests ?? 0;
  const { limit, newAccountUntil } = accountDailyLimit(policy, principal.createdAt, now);
  const rises = newAccountUntil !== null && newAccountUntil < tomorrow && today < l.accountDailyRequests;
  return {
    remaining: {
      kind: 'account',
      leftToday: Math.max(0, limit - today),
      limitToday: limit,
      leftThisMonth: Math.max(0, l.accountMonthlyRequests - month),
      limitThisMonth: l.accountMonthlyRequests,
    },
    dailyRetryAt: rises ? newAccountUntil : tomorrow,
  };
}

/** AI availability for this principal (null: a visitor without a trial identity yet). */
export async function aiStatus(db: DbOrTx, principal: Principal | null, opts: AiStatusOptions): Promise<AiStatus> {
  const now = opts.now ?? new Date();
  const { remaining, dailyRetryAt } = await remainingFor(db, opts.policy, principal, now);
  const status = (state: AiState, reason?: AiStatusReason, retryAt?: Date): AiStatus => ({
    state,
    ...(reason ? { reason } : {}),
    ...(retryAt ? { retryAt } : {}),
    remaining,
  });

  if (!(await readAiSwitch(db)).enabled) return status('paused', 'maintenance');
  const budget = checkInteractiveBudget(
    await spendSnapshot(db, now),
    toMicros(opts.reservationUsd),
    opts.policy.budgets,
    now,
  );
  if (!budget.ok) return status('paused', budget.pause, budget.retryAt);

  if (remaining.kind === 'account') {
    if (remaining.leftThisMonth === 0) return status('paused', 'monthly_cap', nextMonthStart(now));
    if (remaining.leftToday === 0) return status('paused', 'daily_cap', dailyRetryAt);
    return status('available');
  }
  if (remaining.left === 0) return status('signed_in_only', 'trial_used');
  if (!budget.anonymousOk) return status('signed_in_only', 'anonymous_share', nextUtcMidnight(now));
  return status('available');
}
