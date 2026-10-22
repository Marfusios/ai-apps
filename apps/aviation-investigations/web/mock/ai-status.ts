/**
 * Sample `GET /api/ai/status` responses (UI_DESIGN §5) for the mock API, component
 * tests and end-to-end tests. Hand-written: the status depends on the visitor and the
 * budget, not on the fixture corpus. `fresh` is what the mock API answers by default.
 */
import type { AiStatusResponse } from '../../shared/contracts/ai.js';

const trial = (left: number, started: boolean) => ({ kind: 'trial', left, limit: 3, started }) as const;

export const AI_STATUS_SAMPLES = {
  /** Anonymous, fresh: "AI searches left: 3 of 3", first-check panel. */
  fresh: { state: 'available', remaining: trial(3, false) },
  /** Anonymous, one left: "AI searches left: 1 of 3". */
  oneLeft: { state: 'available', remaining: trial(1, true) },
  /** Trial used: "Sign in to keep asking". */
  trialUsed: { state: 'signed_in_only', reason: 'trial_used', remaining: trial(0, true) },
  /** Free searches paused, sign-in still open. */
  anonymousShare: {
    state: 'signed_in_only',
    reason: 'anonymous_share',
    retryAt: '2026-10-17T00:00:00.000Z',
    remaining: trial(3, false),
  },
  /** The login-required emergency mode. */
  loginRequired: { state: 'signed_in_only', reason: 'login_required', remaining: trial(2, true) },
  /** Signed in: "AI left today: 18 of 20". */
  signedIn: {
    state: 'available',
    remaining: { kind: 'account', leftToday: 18, limitToday: 20, leftThisMonth: 109, limitThisMonth: 150 },
  },
  /** Paused for everyone, daily budget: "AI back tomorrow". */
  pausedDaily: { state: 'paused', reason: 'daily_budget', retryAt: '2026-10-17T00:00:00.000Z', remaining: trial(3, false) },
  /** Paused for everyone, monthly budget: "AI back on 1 Nov". */
  pausedMonthly: { state: 'paused', reason: 'monthly_budget', retryAt: '2026-11-01T00:00:00.000Z', remaining: trial(3, false) },
  /** Recovery time unknown: "AI temporarily unavailable". */
  unavailable: { state: 'paused', reason: 'dependency', remaining: null },
} as const satisfies Record<string, AiStatusResponse>;

export type AiStatusSample = keyof typeof AI_STATUS_SAMPLES;
