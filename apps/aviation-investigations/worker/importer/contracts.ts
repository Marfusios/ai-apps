/** Local until the coordinated Task 25 admin contract integration. No private report fields. */
import { z } from 'zod';

export const IMPORT_STEPS = ['check', 'acquire', 'extract', 'load', 'verify', 'plan', 'index_cases',
  'index_passages', 'validate', 'publish', 'canary', 'cleanup', 'complete'] as const;
export const IMPORT_RESULTS = ['running', 'unchanged', 'published', 'needs_review', 'deferred', 'failed',
  'skipped_dev_failed', 'cancelled', 'rolled_back'] as const;
export const IMPORT_REASONS = ['metadata_unchanged', 'same_archive', 'same_content', 'source_listing_changed',
  'source_reissued', 'source_changed_during_download', 'source_unavailable', 'source_retired', 'baseline_required',
  'baseline_changed', 'schema', 'integrity', 'verification', 'cohort_bounds', 'mapping', 'probe', 'import_cap',
  'monthly_budget', 'restore_hold', 'accounting', 'storage', 'alias_unknown', 'busy', 'backup_window', 'lock_lost',
  'timeout', 'interrupted', 'dev_failed', 'configuration', 'cleanup'] as const;
export type ImportReason = typeof IMPORT_REASONS[number];
export type ImportStep = typeof IMPORT_STEPS[number];
export type ImportResult = typeof IMPORT_RESULTS[number];
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Iso = z.iso.datetime();
const Count = z.number().int().nonnegative();
const Usd = z.number().nonnegative();
export const SourceSchema = z.strictObject({
  advertisedAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/), bytes: Count,
});
export type SourceObservation = z.infer<typeof SourceSchema>;
export const AdminImportRunSchema = z.strictObject({
  checkedAt: Iso, finishedAt: Iso.nullable(), mode: z.enum(['automatic', 'forced_dev']),
  source: SourceSchema.nullable(), archiveSha256: Sha256.nullable(), generationId: Count.nullable(),
  step: z.enum(IMPORT_STEPS), result: z.enum(IMPORT_RESULTS), reason: z.enum(IMPORT_REASONS).nullable(), costUsd: Usd,
});
export type AdminImportRun = z.infer<typeof AdminImportRunSchema>;
export const AdminImportsSchema = z.strictObject({
  enabled: z.boolean(), schedule: z.strictObject({ localTime: z.string().regex(/^\d{2}:\d{2}$/),
    timeZone: z.string().min(1).max(64), nextCheckAt: Iso.nullable() }).nullable(),
  lastCheck: AdminImportRunSchema.nullable(), lastSuccessfulImport: AdminImportRunSchema.nullable(),
  attentionRequired: z.boolean(), overdue: z.boolean(), recentRuns: z.array(AdminImportRunSchema).max(20),
});
export type AdminImports = z.infer<typeof AdminImportsSchema>;

export const POLICY_VERSION = 'snapshot-monthly.v1';
export const ADAPTER_VERSION = 'ntsb-avall.v1';
export const DIGEST_VERSION = 'projected-source.v1';
export const IMPORT_CAP_MICROS = 500_000;
export const SOURCE_CUTOFF = Date.parse('2027-04-05T00:00:00Z');
export const SOURCE_REMINDER = Date.parse('2027-03-01T00:00:00Z');
export function sourceReminder(now:Date):string|null {
  return now.getTime()>=SOURCE_REMINDER&&now.getTime()<SOURCE_CUTOFF
    ? '{"event":"source_transition_reminder","cutoff":"2027-04-05T00:00:00Z"}' : null;
}
export const REMOTE_REFRESH_MS = 7 * 24 * 60 * 60_000;
export const IMPORT_AGE_MS = 90 * 24 * 60 * 60_000;

/** Error messages and causes deliberately cannot carry upstream data. */
export class ImportFailure extends Error {
  constructor(readonly reason: ImportReason, readonly review = true) { super(reason); this.name = 'ImportFailure'; }
}
export function safeFailure(error: unknown): ImportFailure {
  return error instanceof ImportFailure ? error : new ImportFailure('interrupted');
}
export function safeLog(step: ImportStep, result: ImportResult, reason: ImportReason | null): string {
  return JSON.stringify({ step, result, reason });
}

export interface ManifestIdentity { generationId: number; casesIndex: string; passagesIndex: string; publishedAt: string }
export function sameManifest(a: ManifestIdentity | null, b: ManifestIdentity | null): boolean {
  return a !== null && b !== null && a.generationId === b.generationId && a.casesIndex === b.casesIndex
    && a.passagesIndex === b.passagesIndex && a.publishedAt === b.publishedAt;
}
