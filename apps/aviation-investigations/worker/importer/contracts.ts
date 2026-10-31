/** Worker-only control types plus the shared, trimmed admin status contract. */
import { z } from 'zod';

import {
  IMPORT_STEPS,
  IMPORT_RESULTS,
  IMPORT_REASONS,
  AdminImportRunSchema,
} from '../../shared/contracts/admin.js';
export {
  IMPORT_STEPS,
  IMPORT_RESULTS,
  IMPORT_REASONS,
  AdminImportRunSchema,
  AdminImportsSchema,
} from '../../shared/contracts/admin.js';
export type { AdminImportRun, AdminImports } from '../../shared/contracts/admin.js';

export type ImportReason = (typeof IMPORT_REASONS)[number];
export type ImportStep = (typeof IMPORT_STEPS)[number];
export type ImportResult = (typeof IMPORT_RESULTS)[number];
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const SourceSchema = AdminImportRunSchema.shape.source.unwrap();
export type SourceObservation = z.infer<typeof SourceSchema>;

export const POLICY_VERSION = 'snapshot-monthly.v1';
export const ADAPTER_VERSION = 'ntsb-avall.v1';
export const DIGEST_VERSION = 'projected-source.v1';
export const IMPORT_CAP_MICROS = 500_000;
export const SOURCE_CUTOFF = Date.parse('2027-04-05T00:00:00Z');
export const SOURCE_REMINDER = Date.parse('2027-03-01T00:00:00Z');
export function sourceReminder(now: Date): string | null {
  return now.getTime() >= SOURCE_REMINDER && now.getTime() < SOURCE_CUTOFF
    ? '{"event":"source_transition_reminder","cutoff":"2027-04-05T00:00:00Z"}'
    : null;
}
export const REMOTE_REFRESH_MS = 7 * 24 * 60 * 60_000;
export const IMPORT_AGE_MS = 90 * 24 * 60 * 60_000;

/** Error messages and causes deliberately cannot carry upstream data. */
export class ImportFailure extends Error {
  constructor(
    readonly reason: ImportReason,
    readonly review = true,
  ) {
    super(reason);
    this.name = 'ImportFailure';
  }
}
export function safeFailure(error: unknown): ImportFailure {
  return error instanceof ImportFailure ? error : new ImportFailure('interrupted');
}
export function safeLog(
  step: ImportStep,
  result: ImportResult,
  reason: ImportReason | null,
): string {
  return JSON.stringify({ step, result, reason });
}

export interface ManifestIdentity {
  generationId: number;
  casesIndex: string;
  passagesIndex: string;
  publishedAt: string;
}
export function sameManifest(a: ManifestIdentity | null, b: ManifestIdentity | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.generationId === b.generationId &&
    a.casesIndex === b.casesIndex &&
    a.passagesIndex === b.passagesIndex &&
    a.publishedAt === b.publishedAt
  );
}
