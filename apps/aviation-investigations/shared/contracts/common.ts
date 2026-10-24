/**
 * Building blocks shared by the public API contracts (config, search, cases,
 * dashboard). Every object schema is strict: an unexpected key fails validation,
 * so nothing (an internal `ev_id`, an AI field) can ride along unnoticed.
 *
 * Public responses carry NTSB data only. AI context is a separate private read
 * (UI_DESIGN §3) and has no place in these schemas.
 */
import { z } from 'zod';
import { PHASE_GROUPS, type PhaseGroup } from '../codes.js';
import type { CompletionClass } from '../completion.js';

/** Event-level public case number, e.g. `DFW08TA066`. Never the internal `ev_id`. */
export const NTSB_NO_PATTERN = /^[A-Z0-9]{5,20}$/;
export const NtsbNoSchema = z.string().regex(NTSB_NO_PATTERN, 'not an NTSB case number');

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** ISO date-time without an invented zone (the source has none), e.g. `2008-03-11T12:00:00`. */
export const IsoDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'expected YYYY-MM-DDTHH:MM:SS');

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');

export const PhaseGroupSchema = z.enum(PHASE_GROUPS as readonly [PhaseGroup, ...PhaseGroup[]]);

export const COMPLETION_CLASSES = ['completed', 'in_progress', 'status_unknown', 'other_status'] as const satisfies
  readonly CompletionClass[];
export const CompletionClassSchema = z.enum(COMPLETION_CLASSES);

/**
 * A coded NTSB value with its display label. `code` is the value as published
 * (trimmed, upper-case), null when blank; `label` is the product label from the
 * dictionary, the "not reported" wording for blank, or the raw code when the
 * vocabulary does not know it.
 */
export const CodedSchema = z.strictObject({
  code: z.string().max(16).nullable(),
  label: z.string().min(1).max(120),
});
export type Coded = z.infer<typeof CodedSchema>;

/**
 * Completion facts (UI_DESIGN §4.2). Status, probable-cause availability and the
 * mapping are separate facts; the badge never claims more than `class` says.
 */
export const CompletionSchema = z.strictObject({
  class: CompletionClassSchema,
  /** `NTSB_Admin.rec_stat` as published; shown on every badge other than COMPLETED. */
  rawStatus: z.string().max(8).nullable(),
  hasProbableCause: z.boolean(),
  mappingVersion: z.string().min(1).max(40),
  /** False while the completed-status mapping is provisional (amendment A5). */
  mappingVerified: z.boolean(),
});
export type Completion = z.infer<typeof CompletionSchema>;

/** The dataset generation a response was built from. */
export const DatasetSchema = z.strictObject({
  /** Changes whenever any published record changes; part of ETags and cache keys. */
  revision: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  /** Date of the NTSB snapshot the generation was loaded from. */
  snapshotDate: IsoDateSchema,
});
export type Dataset = z.infer<typeof DatasetSchema>;

/**
 * Body of every 4xx/5xx JSON response. `message` is plain text for people.
 *
 * The anonymous AI gate (server/identity/gate.ts) adds three 403 codes:
 * `challenge_required` (no Turnstile token was sent, or the trial ended meanwhile:
 * take a new check), `challenge_failed` (the token was rejected, expired or already
 * used: get a fresh one) and `sign_in_required` (the login-required emergency mode
 * refuses anonymous AI).
 *
 * AI briefs (shared/contracts/briefs.ts) add, before any spend:
 * - `ai_paused` (503): AI is paused for everyone (budget or kill switch); `retryAfter`
 *   when the recovery time is known. `GET /api/ai/status` has the reason.
 * - `trial_used` (429): this visitor's free searches are used up.
 * - `free_searches_paused` (429): today's free searches are used up for everyone;
 *   signed-in AI may still be open.
 * - `quota_exhausted` (429): a signed-in account's daily or monthly searches are used up.
 * - `in_flight` (429): this visitor already has an AI request running.
 * - `conflict` (409): the idempotency key was used with another request.
 * - `refinement_limit` (409): the brief has used its three refinements.
 *
 * Accounts (shared/contracts/account.ts) add, all 403:
 * - `moved`: a retry, from the anonymous trial that asked, of a request whose brief has
 *   since moved to the account that signed in from it (UI_DESIGN §5, "Signing in
 *   mid-brief"): sign in to view it. Nothing is replayed and nothing runs.
 * - `signed_out`: a signed-in AI request whose session ended (signed out, or the account
 *   deleted) before it could start. Nothing was kept or spent.
 * - `reauth_required`: deleting the account needs a recent Google sign-in first
 *   (`POST /api/account/delete/start`).
 *
 * And, 503 with `Retry-After`:
 * - `sign_out_pending`: a sign-out ended this browser's session cookie but the server could
 *   not confirm the session itself is gone; it finishes on this browser's next sign-out or
 *   account read (server/auth/better-auth.ts, "Signing out"). Also a sign-in refused because
 *   such a sign-out still cannot be finished.
 */
export const ErrorResponseSchema = z.strictObject({
  error: z.enum([
    'bad_request',
    'forbidden',
    'not_found',
    'rate_limited',
    'unavailable',
    'internal',
    'challenge_required',
    'challenge_failed',
    'sign_in_required',
    'ai_paused',
    'trial_used',
    'free_searches_paused',
    'quota_exhausted',
    'in_flight',
    'conflict',
    'refinement_limit',
    'moved',
    'signed_out',
    'reauth_required',
    'sign_out_pending',
  ]),
  message: z.string().max(500),
  /** For `bad_request`: which parameters failed. */
  issues: z.array(z.strictObject({ path: z.string().max(80), message: z.string().max(200) })).max(20).optional(),
  /** For `rate_limited`: seconds until a request is accepted again (also the `Retry-After` header). */
  retryAfter: z.number().int().positive().max(86_400).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
