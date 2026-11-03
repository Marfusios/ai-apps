/**
 * The admin page's importer copy names the importer's own limits and classifications
 * (web/src/features/admin/imports.ts): they are tied here to the worker's values, so the words
 * cannot drift from what the importer does (Task 26 review M15).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMPORT_REASONS } from '../../shared/contracts/admin';
import { IMPORT_LIMITS, TEMPORARY_REASONS } from '../../web/src/features/admin/imports';
import { IMPORT_CAP_MICROS, ImportFailure } from '../../worker/importer/contracts';
import { projectImports, type StatusRow } from '../../worker/importer/status';

const APP = resolve(fileURLToPath(import.meta.url), '../../..');
const source = (path: string): string => readFileSync(resolve(APP, path), 'utf8');

describe('the importer limits the admin page names', () => {
  it('the cost cap per file', () => {
    expect(IMPORT_LIMITS.capUsd * 1_000_000).toBe(IMPORT_CAP_MICROS);
  });

  it('overdue after 36 hours without a completed check, as the status projection decides', () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const at = (hours: number): StatusRow => ({
      public: {
        checkedAt: new Date(now.getTime() - hours * 3_600_000).toISOString(),
        finishedAt: new Date(now.getTime() - hours * 3_600_000 + 60_000).toISOString(),
        mode: 'automatic',
        source: null,
        archiveSha256: null,
        generationId: null,
        step: 'complete',
        result: 'unchanged',
        reason: 'metadata_unchanged',
        costUsd: 0,
      },
      sourceCheckSucceeded: true,
      canaryPassed: false,
      unresolved: false,
    });
    const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };
    const limit = IMPORT_LIMITS.overdueHours;
    expect(projectImports([at(limit - 0.1)], schedule, now).overdue).toBe(false);
    expect(projectImports([at(limit + 0.1)], schedule, now).overdue).toBe(true);
  });

  it('the gap between NTSB’s files that needs a new baseline, and the run’s deadline', () => {
    expect(source('worker/importer/compare.ts')).toContain(`gap <= ${IMPORT_LIMITS.sourceGapDays} * 86_400_000`);
    const host = source('worker/importer/host.ts');
    expect(host).toContain(`export const IMPORT_DEADLINE_MS = ${IMPORT_LIMITS.deadlineHours} * 3_600_000`);
    expect(host).toContain('Date.now() + IMPORT_DEADLINE_MS');
  });

  it('the reasons a run is only postponed for are the worker’s temporary ones', () => {
    for (const reason of IMPORT_REASONS) expect(new ImportFailure(reason).review, reason).toBe(!TEMPORARY_REASONS.has(reason));
  });
});
