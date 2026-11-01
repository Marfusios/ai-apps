/**
 * The automatic NTSB importer's status in the mock admin overview (`system.imports`, contract
 * `AdminImportsSchema`, Task 26; docs/IMPORTER.md), in five synthetic states that tests and the dev
 * mock mode switch between:
 *
 * - `healthy`: the daily check at 05:30 Europe/Prague found no new file today, and the serving
 *   generation was imported five checks ago;
 * - `published`: today's check imported a new file as generation 8, which now serves;
 * - `needs_review`: today's check stopped for review (`cohort_bounds`), so attention is required;
 * - `overdue`: no check has succeeded for over 36 hours (NTSB unreachable, then an interruption);
 * - `disabled`: the schedule is off and nothing has run.
 *
 * Every time comes from `now` (the latest scheduled check at or before it, and the ones before), so
 * a page reads alike on every load. The digests, sizes and costs are made up.
 */
import type { AdminImportRun, AdminImports, AdminOverview } from '../../shared/contracts/admin.js';
import config from './config.json' with { type: 'json' };

export const MOCK_IMPORT_STATES = ['healthy', 'published', 'needs_review', 'overdue', 'disabled'] as const;
export type MockImportState = (typeof MOCK_IMPORT_STATES)[number];

const TIME_ZONE = 'Europe/Prague';
const LOCAL_TIME = '05:30';
const MINUTE = 60_000;

/** Europe/Prague's offset from UTC at `at`, in minutes (60 in winter, 120 in summer). */
function offsetMinutes(at: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(at))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return Math.round((Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0) - Math.floor(at / MINUTE) * MINUTE) / MINUTE);
}

/** 05:30 in Prague on the Prague calendar day that is `days` days after the one holding `at`. */
function checkOnDay(at: number, days: number): number {
  const local = new Date(at + offsetMinutes(at) * MINUTE);
  const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, 5, 30);
  return guess - offsetMinutes(guess) * MINUTE;
}

/** The scheduled checks at or before `now`, newest first: `count` of them. */
function checksBefore(now: number, count: number): number[] {
  const today = checkOnDay(now, 0);
  const latest = today <= now ? today : checkOnDay(now, -1);
  return Array.from({ length: count }, (_, k) => checkOnDay(latest, -k));
}

/** The next scheduled check after `now`. */
function nextCheck(now: number): number {
  const today = checkOnDay(now, 0);
  return today > now ? today : checkOnDay(now, 1);
}

const iso = (t: number): string => new Date(t).toISOString();

/** A made-up SHA-256 digest from a seed (64 hex characters). */
function digest(seed: string): string {
  let out = '';
  for (let i = 0; out.length < 64; i++) {
    const x = Math.sin((seed.charCodeAt(i % seed.length) + i) * 12.9898) * 43_758.5453;
    out += Math.floor((x - Math.floor(x)) * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, 64);
}

/** The file NTSB lists for the serving dataset (the mock's snapshot), and a newer one. */
const CURRENT_FILE = { advertisedAtLocal: `${config.snapshotDate}T06:12:37`, bytes: 104_857_311 };

/** The local date (YYYY-MM-DD) in Prague of the day before `at`: when NTSB put up a newer file. */
function dayBefore(at: number): string {
  const local = new Date(at + offsetMinutes(at) * MINUTE - 86_400_000);
  return local.toISOString().slice(0, 10);
}

interface RunInput {
  at: number;
  /** How long the run took, in minutes (null: not finished). */
  minutes: number | null;
  result: AdminImportRun['result'];
  reason?: AdminImportRun['reason'];
  step?: AdminImportRun['step'];
  source?: AdminImportRun['source'];
  generationId?: number | null;
  costUsd?: number;
  mode?: AdminImportRun['mode'];
}

function run({ at, minutes, result, reason = null, step = 'complete', source = CURRENT_FILE, generationId = null, costUsd = 0, mode = 'automatic' }: RunInput): AdminImportRun {
  const checkedAt = at + 4_000;
  return {
    checkedAt: iso(checkedAt),
    finishedAt: minutes === null ? null : iso(checkedAt + minutes * MINUTE),
    mode,
    source,
    archiveSha256: source ? digest(source.advertisedAtLocal) : null,
    generationId,
    step,
    result,
    reason,
    costUsd,
  };
}

/** Ordinary daily checks that found nothing new; every seventh re-downloads the file, which is identical. */
function quietChecks(times: readonly number[]): AdminImportRun[] {
  return times.map((at, i) => (i % 7 === 2 ? run({ at, minutes: 2, result: 'unchanged', reason: 'same_archive' }) : run({ at, minutes: 1, result: 'unchanged', reason: 'metadata_unchanged' })));
}

/** The publication of the serving generation 7, `daysAgo` checks before the latest one. */
function servingImport(checks: readonly number[], daysAgo: number): AdminImportRun {
  return run({ at: checks[daysAgo] as number, minutes: 27, result: 'published', generationId: 7, costUsd: 0.2114 });
}

export interface MockImports {
  imports: AdminImports;
  /** The dataset that serves in this state (the published state's generation 8), or the overview's own. */
  dataset?: Partial<NonNullable<AdminOverview['system']['dataset']>>;
}

/** `system.imports` in `state`, as of `now`. */
export function mockImports(state: MockImportState, now: Date): MockImports {
  const t = now.getTime();
  const checks = checksBefore(t, 12);
  const schedule = { localTime: LOCAL_TIME, timeZone: TIME_ZONE, nextCheckAt: iso(nextCheck(t)) };
  const base = { enabled: true, schedule, attentionRequired: false, overdue: false };
  const latest = checks[0] as number;
  switch (state) {
    case 'healthy': {
      const success = servingImport(checks, 5);
      // A busy night three checks ago: postponed, and no successful check that day.
      const runs = quietChecks(checks).map((r, i) => (i === 5 ? success : i === 3 ? run({ at: checks[3] as number, minutes: 0, result: 'deferred', reason: 'busy', step: 'check', source: null }) : r));
      return {
        imports: { ...base, lastCheck: runs[0] as AdminImportRun, lastSuccessfulImport: success, recentRuns: runs },
        dataset: { generationId: 7, loadedAt: iso(Date.parse(success.checkedAt) + 6 * MINUTE), publishedAt: iso(Date.parse(success.finishedAt as string) - 11 * MINUTE) },
      };
    }
    case 'published': {
      const file = { advertisedAtLocal: `${dayBefore(latest)}T21:04:52`, bytes: 105_120_448 };
      const published = run({ at: latest, minutes: 31, result: 'published', generationId: 8, source: file, costUsd: 0.1873 });
      const runs = [published, ...quietChecks(checks.slice(1))];
      return {
        imports: { ...base, lastCheck: published, lastSuccessfulImport: published, recentRuns: runs },
        dataset: {
          generationId: 8,
          snapshotDate: file.advertisedAtLocal.slice(0, 10),
          loadedAt: iso(Date.parse(published.checkedAt) + 7 * MINUTE),
          publishedAt: iso(Date.parse(published.finishedAt as string) - 11 * MINUTE),
        },
      };
    }
    case 'needs_review': {
      const file = { advertisedAtLocal: `${dayBefore(latest)}T21:04:52`, bytes: 98_204_115 };
      const stopped = run({ at: latest, minutes: 9, result: 'needs_review', reason: 'cohort_bounds', step: 'verify', source: file });
      const success = servingImport(checks, 5);
      const runs = [stopped, ...quietChecks(checks.slice(1)).map((r, i) => (i === 4 ? success : r))];
      return {
        imports: { ...base, attentionRequired: true, lastCheck: stopped, lastSuccessfulImport: success, recentRuns: runs },
        dataset: { generationId: 7, loadedAt: iso(Date.parse(success.checkedAt) + 6 * MINUTE), publishedAt: iso(Date.parse(success.finishedAt as string) - 11 * MINUTE) },
      };
    }
    case 'overdue': {
      // Since the last successful check: NTSB could not be reached, then a run was interrupted.
      const failed = [
        run({ at: checks[0] as number, minutes: 3, result: 'failed', reason: 'interrupted', step: 'check', source: null }),
        run({ at: checks[1] as number, minutes: 1, result: 'deferred', reason: 'source_unavailable', step: 'check', source: null }),
      ];
      const earlier = quietChecks(checks.slice(2));
      const success = servingImport(checks, 7);
      const runs = [...failed, ...earlier.map((r, i) => (i === 5 ? success : r))];
      return {
        imports: { ...base, overdue: true, lastCheck: runs[2] as AdminImportRun, lastSuccessfulImport: success, recentRuns: runs },
        dataset: { generationId: 7, loadedAt: iso(Date.parse(success.checkedAt) + 6 * MINUTE), publishedAt: iso(Date.parse(success.finishedAt as string) - 11 * MINUTE) },
      };
    }
    case 'disabled':
      return {
        imports: { enabled: false, schedule: { localTime: LOCAL_TIME, timeZone: TIME_ZONE, nextCheckAt: null }, lastCheck: null, lastSuccessfulImport: null, attentionRequired: false, overdue: false, recentRuns: [] },
      };
  }
}

/** The state a value names (session storage, a handler option), or `healthy`. */
export function parseMockImportState(value: string | null | undefined): MockImportState {
  return (MOCK_IMPORT_STATES as readonly string[]).includes(value ?? '') ? (value as MockImportState) : 'healthy';
}
