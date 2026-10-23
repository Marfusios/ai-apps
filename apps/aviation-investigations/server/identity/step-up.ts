/**
 * Extra checks for signed-in AI (DESIGN §8: "Challenge anonymous AI use and suspicious
 * authenticated activity"; §7: step-up checks; UI_DESIGN §5, "Extra check, signed in").
 *
 * An ordinary signed-in AI request takes no Turnstile check. A request whose account or
 * network looks scripted or farmed takes one before anything is spent: a fresh,
 * single-use token, verified exactly like the anonymous gate's (`AnonymousGate.challenge`,
 * server/identity/gate.ts). Refused, it answers 403 `challenge_required` or
 * `challenge_failed`, and the page shows the "Quick check before this AI search" panel;
 * `GET /api/ai/status` says `check: true` beforehand, so the page usually takes the check
 * at click time without a refusal. The decision is the server's alone, made from counters
 * admission keeps anyway (server/quota/admit.ts, buckets.ts), read without locks before
 * admission:
 *
 * | Signal | Check while | Why |
 * | --- | --- | --- |
 * | `operator` | `ai_switch.account_check` is `always` (`pnpm worker ai-switch --account-check always`) | an attack on signed-in AI: every request is checked |
 * | `burst` | the account made at least 3 AI attempts in the current minute (its limit is 5) | scripted bursts |
 * | `daily_share` | the account has used at least half of today's allowance (10 of 20, 3 of a new account's 5) | an account spending its whole allowance, the way scripted accounts exhaust the shared daily AI |
 * | `network` | its network identity (IPv4 address or IPv6 /64) made at least 10 signed-in AI attempts in the current hour (the hourly limit is 30) | several accounts on one network (account farming) |
 *
 * It is bounded: every signal ends with its window (the minute, the UTC day, the hour), or
 * when the operator switches back; a check never blocks AI by itself, and the hard limits
 * stay in admission. Shared networks (a school) meet `network` sooner: their members take
 * the check, which Cloudflare usually passes without interaction.
 */
import type { DbOrTx } from '../db/client.js';
import { accountDailyLimit, accountRequestBuckets, attemptBuckets } from '../quota/admit.js';
import { countsOf, readBuckets } from '../quota/buckets.js';
import { principalHash, type Principal, type QuotaPolicy } from '../quota/policy.js';
import { readAiSwitch } from '../quota/switch.js';

/** The thresholds of the table above. */
export const ACCOUNT_CHECK_RULES = {
  /** AI attempts by the account in the current minute. */
  perMinute: 3,
  /** Share of today's allowance the account has used. */
  dailyShare: 0.5,
  /** Signed-in AI attempts from the network identity in the current hour. */
  networkPerHour: 10,
} as const;

export type AccountCheckSignal = 'operator' | 'burst' | 'daily_share' | 'network';

/**
 * Why this account's next AI request needs a Turnstile check (empty: it does not). Reads
 * only. `networkId` is the request's validated network identity (none for a status read
 * without one: the network signal is then not considered).
 */
export async function accountCheckSignals(
  db: DbOrTx,
  policy: QuotaPolicy,
  principal: Extract<Principal, { kind: 'account' }>,
  networkId: string | null,
  now: Date,
): Promise<AccountCheckSignal[]> {
  const signals: AccountCheckSignal[] = [];
  if ((await readAiSwitch(db)).accountCheck === 'always') signals.push('operator');
  const pHash = principalHash(policy, principal);
  const attempts = networkId ? attemptBuckets(policy, principal, pHash, networkId, now) : [];
  const minute = attempts.find((b) => b.ref.scope === 'principal' && b.ref.period === 'minute')?.ref;
  const networkHour = attempts.find((b) => b.ref.scope === 'network' && b.ref.period === 'hour')?.ref;
  const today = accountRequestBuckets(pHash, now).day;
  const counts = await readBuckets(db, [today, ...(minute ? [minute] : []), ...(networkHour ? [networkHour] : [])]);
  if (minute && countsOf(counts, minute).attempts >= ACCOUNT_CHECK_RULES.perMinute) signals.push('burst');
  const { limit } = accountDailyLimit(policy, principal.createdAt, now);
  if (countsOf(counts, today).requests >= Math.ceil(limit * ACCOUNT_CHECK_RULES.dailyShare)) signals.push('daily_share');
  if (networkHour && countsOf(counts, networkHour).attempts >= ACCOUNT_CHECK_RULES.networkPerHour) signals.push('network');
  return signals;
}
