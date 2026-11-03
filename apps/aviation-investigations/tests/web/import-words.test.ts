import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  IMPORT_LIMITS,
  alertSentences,
  reasonWords,
  chipLine,
  alertDetails,
} from '../../web/src/features/admin/imports';
import { IMPORT_CAP_MICROS } from '../../worker/importer/contracts';
import {
  mockImports,
  mockImportInputs,
  MOCK_IMPORT_STATES,
} from '../../web/mock/imports';

describe('automatic importer words and limits', () => {
  it('names the actual per-file cap and execution deadline', () => {
    expect(IMPORT_LIMITS.capUsd * 1_000_000).toBe(IMPORT_CAP_MICROS);
    expect(IMPORT_LIMITS.capUsd).toBe(2);
    expect(reasonWords('import_cap')).toBe(
      `This file would cost more than the $${IMPORT_LIMITS.capUsd.toFixed(2)} import limit.`,
    );
    expect(
      readFileSync(
        resolve(fileURLToPath(import.meta.url), '../../../worker/importer/host.ts'),
        'utf8',
      ),
    ).toContain(
      `export const IMPORT_DEADLINE_MS = ${IMPORT_LIMITS.deadlineHours} * 3_600_000`,
    );
    expect(IMPORT_LIMITS).toMatchObject({ overdueHours: 36, delayedDays: 3, fixDays: 7 });
  });
  it.each(MOCK_IMPORT_STATES)(
    '%s has fixed, plain explanations without commands',
    (state) => {
      const x = mockImports(state, new Date('2026-11-01T07:15:00Z')).imports;
      const words = alertSentences(x, 'live', 'UTC').join(' ');
      expect(words).not.toMatch(/\b[a-z]+_[a-z_]+\b|pnpm|approve|rebaseline|acknowledge/);
      if (x.alert) expect(words.length).toBeGreaterThan(50);
      if (x.alert?.siteState === 'uncertain')
        expect(words).not.toContain('The site checks passed');
    },
  );
  it('does not promise nothing to do after a disk failure following a successful import', () => {
    const x = mockImports('post_success_storage', new Date()).imports;
    const words = alertSentences(x, 'live', 'UTC').join(' ');
    expect(words).toContain('disk space');
    expect(words).not.toContain('Nothing for you to do');
    expect(reasonWords('shrunk')).toContain('more than a tenth');
  });
});

import { projectImports } from '../../worker/importer/status';
it.each(MOCK_IMPORT_STATES)('%s is produced by the real status projection', (state) => {
  const now = new Date('2026-11-03T12:00:00Z'),
    inputs = mockImportInputs(state, now);
  expect(mockImports(state, now).imports).toEqual(
    projectImports(inputs.rows, inputs.schedule, now, inputs.health),
  );
});
it('fixed per-run warnings retry daily, whereas file suppression requires a release or new bytes', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  expect(
    alertSentences(mockImports('configuration', now).imports, 'dev', 'UTC'),
  ).toContain('Fix the server. The system tries again every day.');
  expect(alertSentences(mockImports('storage', now).imports, 'dev', 'UTC')).toContain(
    'Fix the server, then release. The file is tried again after the release or when NTSB posts a newer file.',
  );
});
it('unknown start dates say so; overdue retains a switch hold without duplicating its explanation', () => {
  const now = new Date('2026-11-03T12:00:00Z'),
    input = mockImportInputs('healthy', now);
  if (input.health === true) throw Error('fixture must be readable');
  input.health.issue = null;
  input.health.switchHeld = true;
  input.health.switchHoldReason = 'rollback_failed';
  const fresh = projectImports(input.rows, input.schedule, now, input.health);
  expect(chipLine(fresh, 'UTC')).toBe('Start date unknown.');
  const stale = projectImports(
    input.rows,
    input.schedule,
    new Date(+now + 48 * 3600000),
    input.health,
  );
  const lines = alertSentences(stale, 'dev', 'UTC');
  expect(lines[0]).toMatch(/^No import check has run since/);
  expect(lines).toContain(reasonWords('rollback_failed'));
  expect(lines.filter((s) => s.includes('site may show mixed data'))).toHaveLength(1);
  expect(alertDetails(stale, 'UTC')).toContain('rollback_failed');
});
it('accounting and manual rollback explanations are not repeated', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const accounting = alertSentences(mockImports('accounting', now).imports, 'dev', 'UTC');
  expect(reasonWords('accounting')).toBe(
    'The cost records for this file block more work.',
  );
  expect(accounting.filter((s) => s.includes('person'))).toEqual([
    'A person must check the cost records. The alert goes away after the next good import.',
  ]);
  const manual = mockImports('manual_rollback', now).imports;
  expect(manual.waiting).toBeNull();
  expect(manual.recentRuns[0]).toMatchObject({
    result: 'rolled_back',
    step: 'complete',
    source: null,
  });
  expect(manual.alert?.details).toMatchObject({ step: 'canary', source: null });
  expect(
    alertSentences(manual, 'dev', 'UTC').filter((s) => s.includes('went back')),
  ).toHaveLength(1);
});
it('unverified restoration repeats a failed site check, and inherited dev file details give a Waiting fact', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  expect(mockImports('restore_unverified', now).imports.recentRuns.slice(0, 3)).toEqual(
    Array(3).fill(
      expect.objectContaining({
        result: 'failed',
        reason: 'site_check',
        step: 'canary',
        suppressed: false,
      }),
    ),
  );
  expect(mockImports('dev_failed', now).imports.waiting?.source).toEqual(
    mockImports('dev_failed', now).imports.alert?.details?.source,
  );
});

it('a nonsuppressing recertification warning keeps its daily next step despite unrelated temporary dates', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const input = mockImportInputs('probe', now);
  if (input.health === true) throw Error('readable fixture required');
  input.health.issue!.suppressesFile = false;
  input.health.temporaryDays = 3;
  expect(
    alertSentences(
      projectImports(input.rows, input.schedule, now, input.health),
      'dev',
      'UTC',
    ),
  ).toContain('Fix the server. The system tries again every day.');
});
