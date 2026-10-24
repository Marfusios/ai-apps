/**
 * Sample `GET /api/ai/status` responses (UI_DESIGN §5) for the mock API, component
 * tests and end-to-end tests. Hand-written: the status depends on the visitor and the
 * budget, not on the fixture corpus. `fresh` is what the mock API answers by default.
 * The limits are the owner's of 2026-10-24 (`MOCK_AI_LIMITS`, which `/api/config` reports):
 * anonymous visitors 10 a day, accounts 50 a day, new accounts 20 a day for their first 3
 * days, 600 a month.
 */
import type { AiStatusResponse } from '../../shared/contracts/ai.js';
import type { ConfigResponse } from '../../shared/contracts/config.js';

/**
 * What the mock's `/api/config` reports as `aiLimits` (the server's defaults, Task 23), except
 * `briefsEnabled`: the server's default is off, the mock keeps serving briefs so that the briefs
 * that exist can be shown and refined in tests (`createHandlers({ aiLimits })` turns them off).
 */
export const MOCK_AI_LIMITS: NonNullable<ConfigResponse['aiLimits']> = {
  anonymousDaily: 10,
  accountDaily: 50,
  newAccountDaily: 20,
  newAccountDays: 3,
  accountMonthly: 600,
  reset: '00:00 UTC',
  pageSize: 10,
  candidateCeiling: 100,
  briefsEnabled: true,
};
const MONTHLY = MOCK_AI_LIMITS.accountMonthly;

const trial = (left: number, started: boolean) => ({ kind: 'trial', left, limit: MOCK_AI_LIMITS.anonymousDaily, started }) as const;

export const AI_STATUS_SAMPLES = {
  /** Anonymous, fresh: "AI searches left: 10 of 10", first-check panel. */
  fresh: { state: 'available', remaining: trial(10, false) },
  /** Anonymous, one left: "AI searches left: 1 of 10". */
  oneLeft: { state: 'available', remaining: trial(1, true) },
  /** Today's free searches used: "Sign in to keep asking"; they return at the next UTC midnight. */
  trialUsed: { state: 'signed_in_only', reason: 'trial_used', retryAt: '2026-10-17T00:00:00.000Z', remaining: trial(0, true) },
  /** Free searches paused, sign-in still open. */
  anonymousShare: {
    state: 'signed_in_only',
    reason: 'anonymous_share',
    retryAt: '2026-10-17T00:00:00.000Z',
    remaining: trial(10, false),
  },
  /** The login-required emergency mode. */
  loginRequired: { state: 'signed_in_only', reason: 'login_required', remaining: trial(2, true) },
  /** Signed in for the first time: "AI left today: 20 of 20" (new accounts, their first three days). */
  newAccount: {
    state: 'available',
    remaining: { kind: 'account', leftToday: 20, limitToday: 20, leftThisMonth: MONTHLY, limitThisMonth: MONTHLY },
  },
  /** Signed in: "AI left today: 48 of 50". */
  signedIn: {
    state: 'available',
    remaining: { kind: 'account', leftToday: 48, limitToday: 50, leftThisMonth: 553, limitThisMonth: MONTHLY },
  },
  /** Signed in, and the server asks for a Turnstile check before the next AI request (DESIGN §8). */
  checkedAccount: {
    state: 'available',
    remaining: { kind: 'account', leftToday: 8, limitToday: 50, leftThisMonth: 540, limitThisMonth: MONTHLY, check: true },
  },
  /** Paused for everyone, daily budget: "AI back tomorrow". */
  pausedDaily: { state: 'paused', reason: 'daily_budget', retryAt: '2026-10-17T00:00:00.000Z', remaining: trial(10, false) },
  /** Paused for everyone, monthly budget: "AI back on 1 Nov". */
  pausedMonthly: { state: 'paused', reason: 'monthly_budget', retryAt: '2026-11-01T00:00:00.000Z', remaining: trial(10, false) },
  /** Recovery time unknown: "AI temporarily unavailable". */
  unavailable: { state: 'paused', reason: 'dependency', remaining: null },
} as const satisfies Record<string, AiStatusResponse>;

export type AiStatusSample = keyof typeof AI_STATUS_SAMPLES;
