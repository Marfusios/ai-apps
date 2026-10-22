/**
 * `GET /api/ai/status` (UI_DESIGN §5): whether Ask AI can work for this visitor, before
 * anyone clicks. A coarse state, a reason, a retry time only when it is actually known,
 * and the visitor's own remaining searches. It never carries budget amounts, spend or
 * any other visitor's data. Per visitor (it reads the trial cookie): never cached.
 */
import { z } from 'zod';

/**
 * The Turnstile action of every anonymous AI request (DESIGN §8). The widget is rendered
 * with it and the server refuses tokens solved for another action. Cloudflare allows up
 * to 32 characters of `A-Za-z0-9_-`.
 */
export const TURNSTILE_ACTION = 'ask-ai';

export const AI_STATES = ['available', 'signed_in_only', 'paused'] as const;
export type AiState = (typeof AI_STATES)[number];

/**
 * Why AI is paused:
 * - for everyone: `daily_budget` and `monthly_budget` (with `retryAt`), `maintenance`
 *   (the kill switch) and `dependency` (a provider, quota storage, configuration or the
 *   Turnstile check is unavailable; no time is promised);
 * - for this account: `daily_cap` and `monthly_cap` (with `retryAt`).
 */
export const AI_PAUSE_REASONS = ['daily_budget', 'monthly_budget', 'maintenance', 'dependency', 'daily_cap', 'monthly_cap'] as const;

/**
 * Why only signed-in AI is open: `trial_used` (this visitor's three searches are spent),
 * `anonymous_share` (today's free searches are used up; `retryAt` is the next UTC
 * midnight) or `login_required` (the login-required emergency mode; no time promised).
 */
export const AI_SIGNED_IN_ONLY_REASONS = ['trial_used', 'anonymous_share', 'login_required'] as const;

export const AI_STATUS_REASONS = [...AI_PAUSE_REASONS, ...AI_SIGNED_IN_ONLY_REASONS] as const;
export type AiStatusReason = (typeof AI_STATUS_REASONS)[number];

const count = z.number().int().nonnegative().max(100_000);

/**
 * An anonymous visitor's trial. `started` is true once this browser holds a trial
 * identity, i.e. it has passed the first Turnstile check: the "Quick check before your
 * first AI search" explanation is shown only while it is false.
 */
export const TrialRemainingSchema = z.strictObject({
  kind: z.literal('trial'),
  left: count,
  limit: count,
  started: z.boolean(),
});

/** A signed-in account: searches left today and this month (the daily limit is 5 for new accounts). */
export const AccountRemainingSchema = z.strictObject({
  kind: z.literal('account'),
  leftToday: count,
  limitToday: count,
  leftThisMonth: count,
  limitThisMonth: count,
});

/** The visitor's own counts; null when they cannot be read (`paused` with `dependency`). */
export const AiRemainingSchema = z.discriminatedUnion('kind', [TrialRemainingSchema, AccountRemainingSchema]).nullable();
export type AiRemaining = z.infer<typeof AiRemainingSchema>;

/** UTC instant, e.g. `2026-11-01T00:00:00.000Z`. */
const RetryAtSchema = z.iso.datetime();

export const AiStatusResponseSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('available'), remaining: AiRemainingSchema }),
  z.strictObject({
    state: z.literal('signed_in_only'),
    reason: z.enum(AI_SIGNED_IN_ONLY_REASONS),
    retryAt: RetryAtSchema.optional(),
    remaining: AiRemainingSchema,
  }),
  z.strictObject({
    state: z.literal('paused'),
    reason: z.enum(AI_PAUSE_REASONS),
    retryAt: RetryAtSchema.optional(),
    remaining: AiRemainingSchema,
  }),
]);
export type AiStatusResponse = z.infer<typeof AiStatusResponseSchema>;
