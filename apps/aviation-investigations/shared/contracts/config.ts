/**
 * `GET /api/config`: public client configuration and the coverage facts the home
 * page and footer print. Publicly cacheable; changes with the dataset or public settings.
 */
import { z } from 'zod';
import { IsoDateSchema } from './common.js';

export const CoverageSchema = z.strictObject({
  /** US events that are completed with probable-cause text: the default cohort. */
  defaultCohort: z.number().int().nonnegative(),
  /** US events outside the default cohort ("other records", UI_DESIGN §4.2). */
  otherRecords: z.number().int().nonnegative(),
  /** First and last event year in the corpus. */
  yearFrom: z.number().int().min(1900).max(2100),
  yearTo: z.number().int().min(1900).max(2100),
  /** True while the completed-status mapping is unverified (amendment A5). */
  provisional: z.boolean(),
});
export type Coverage = z.infer<typeof CoverageSchema>;

export const ConfigResponseSchema = z.strictObject({
  /** Cloudflare Turnstile site key; null when AI requests are not offered. */
  turnstileSiteKey: z.string().max(200).nullable(),
  googleEnabled: z.boolean(),
  /** Fields the active policy may apply; empty when disabled, absent in older cached configs. */
  aiAutomaticFilters: z.array(z.literal('state')).max(1).optional(),
  /** Evidence search allowances; amounts are private. Optional for older clients/fixtures. */
  aiLimits: z.strictObject({ anonymousDaily: z.number().int().nonnegative(), accountDaily: z.number().int().nonnegative(),
    newAccountDaily: z.number().int().nonnegative(), newAccountDays: z.number().int().nonnegative(),
    accountMonthly: z.number().int().nonnegative(), reset: z.literal('00:00 UTC'), pageSize: z.literal(10), candidateCeiling: z.literal(100),
    briefsEnabled: z.boolean() }).optional(),
  /** Date of the NTSB snapshot the active dataset was loaded from. */
  snapshotDate: IsoDateSchema,
  datasetRevision: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  coverage: CoverageSchema,
});
export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;
