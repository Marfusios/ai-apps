/**
 * The automatic NTSB importer's status in the mock admin overview (`system.imports`, contract
 * `AdminImportsSchema`, Task 26; docs/IMPORTER.md), in synthetic states that tests and the dev mock
 * mode switch between. They are shaped as the server sends them (worker/importer/status.ts and the
 * status rows of migration 0028): `lastCheck` is the newest *completed* check, an unchanged or
 * published run (stops, postponements and failures never refresh it); a run's cost is its file's
 * running total; a daily run an unresolved review blocks is recorded as postponed with that review's
 * reason, at the source check, with no source of its own; `overdue` follows from `lastCheck` (none
 * within 36 hours while enabled).
 *
 * - `healthy`: the daily check at 05:30 Europe/Prague found no new file today; the serving
 *   generation 7 was imported five checks ago;
 * - `published`: today's check imported a new file as generation 8, which now serves;
 * - `needs_review`: today's run stopped for review after comparing a new file (`cohort_bounds`, at
 *   extraction);
 * - `blocked`: that stop three checks ago, and every daily run since blocked by it (overdue too);
 * - `after_switch`: today's run published generation 8, which now serves, then failed the live site's
 *   checks (`probe`, at the site checks);
 * - `restore_hold`: a database restore latched the importer two checks ago;
 * - `retired`: NTSB's download is retired (from 5 Apr 2027): the first stop, then blocked runs;
 * - `unreadable`: what the server sends when it cannot read the status: attention, no runs;
 * - `overdue`: no completed check for over 36 hours (NTSB unreachable, then an unknown failure);
 * - `disabled`: the schedule is off and nothing has run.
 *
 * Every time comes from `now` (the latest scheduled check at or before it, and the ones before), so
 * a page reads alike on every load. The digests, sizes and costs are made up.
 */
import type { AdminImportRun, AdminImports, AdminOverview } from '../../shared/contracts/admin.js';
import config from './config.json' with { type: 'json' };

export const MOCK_IMPORT_STATES = ['healthy', 'published', 'needs_review', 'blocked', 'after_switch', 'restore_hold', 'retired', 'unreadable', 'overdue', 'disabled'] as const;
export type MockImportState = (typeof MOCK_IMPORT_STATES)[number];

const TIME_ZONE = 'Europe/Prague';
const LOCAL_TIME = '05:30';
const MINUTE = 60_000;
const OVERDUE_MS = 36 * 3_600_000;

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

type Source = NonNullable<AdminImportRun['source']>;

/** The file NTSB lists for the serving dataset (the mock's snapshot). */
const CURRENT_FILE: Source = { advertisedAtLocal: `${config.snapshotDate}T06:12:37`, bytes: 104_857_311 };

/** A newer file NTSB put up the evening before `at` (a Prague date, no zone, as NTSB gives it). */
function newerFile(at: number, bytes: number): Source {
  const local = new Date(at + offsetMinutes(at) * MINUTE - 86_400_000);
  return { advertisedAtLocal: `${local.toISOString().slice(0, 10)}T21:04:52`, bytes };
}

interface RunInput {
  at: number;
  /** How long the run took, in minutes (null: not finished). */
  minutes: number | null;
  result: AdminImportRun['result'];
  reason?: AdminImportRun['reason'];
  step?: AdminImportRun['step'];
  source?: AdminImportRun['source'];
  /** The file's digest: the archive checked or the run's file (null: none). */
  archive?: string | null;
  generationId?: number | null;
  costUsd?: number;
  mode?: AdminImportRun['mode'];
}

function run({ at, minutes, result, reason = null, step = 'complete', source = null, archive = null, generationId = null, costUsd = 0, mode = 'automatic' }: RunInput): AdminImportRun {
  const checkedAt = at + 4_000;
  return { checkedAt: iso(checkedAt), finishedAt: minutes === null ? null : iso(checkedAt + minutes * MINUTE), mode, source, archiveSha256: archive, generationId, step, result, reason, costUsd };
}

const CURRENT_ARCHIVE = digest(CURRENT_FILE.advertisedAtLocal);

/** Ordinary daily checks that found nothing new; every seventh re-downloads the file, which is identical. */
function quietChecks(times: readonly number[]): AdminImportRun[] {
  return times.map((at, i) =>
    run({ at, minutes: i % 7 === 2 ? 2 : 1, result: 'unchanged', reason: i % 7 === 2 ? 'same_archive' : 'metadata_unchanged', source: CURRENT_FILE, archive: CURRENT_ARCHIVE }),
  );
}

/** The publication of the serving generation 7 at `at`. */
function servingImport(at: number): AdminImportRun {
  return run({ at, minutes: 27, result: 'published', source: CURRENT_FILE, archive: CURRENT_ARCHIVE, generationId: 7, costUsd: 0.2114 });
}

/** The daily runs before `from` (an index into `checks`): quiet, with the serving import `ago` checks before the latest. */
function history(checks: readonly number[], from: number, ago: number): AdminImportRun[] {
  return quietChecks(checks.slice(from)).map((r, i) => (from + i === ago ? servingImport(checks[ago] as number) : r));
}

/** Daily runs an unresolved review blocks: postponed with its reason, at the source check, carrying its file. */
function blockedRuns(times: readonly number[], stopped: AdminImportRun): AdminImportRun[] {
  return times.map((at) => run({ at, minutes: 0, result: 'deferred', reason: stopped.reason, step: 'check', archive: stopped.archiveSha256, generationId: stopped.generationId, costUsd: stopped.costUsd }));
}

export interface MockImports {
  imports: AdminImports;
  /** The dataset that serves in this state, over the overview's own (a later generation, when one was published). */
  dataset?: Partial<NonNullable<AdminOverview['system']['dataset']>>;
}

/** The dataset fields of a generation published by `run`. */
function servedBy(run: AdminImportRun): MockImports['dataset'] {
  return {
    generationId: run.generationId ?? 7,
    loadedAt: iso(Date.parse(run.checkedAt) + 6 * MINUTE),
    publishedAt: iso(Date.parse(run.checkedAt) + 15 * MINUTE),
    ...(run.source && run.source !== CURRENT_FILE ? { snapshotDate: run.source.advertisedAtLocal.slice(0, 10) } : {}),
  };
}

/** `system.imports` in `state`, as of `now`. */
export function mockImports(state: MockImportState, now: Date): MockImports {
  const t = now.getTime();
  const checks = checksBefore(t, 14);
  const latest = checks[0] as number;
  const schedule = { localTime: LOCAL_TIME, timeZone: TIME_ZONE, nextCheckAt: iso(nextCheck(t)) };
  /** The status as the server projects it from `runs` (newest first): the completed check, the last import, overdue. */
  const imports = (runs: AdminImportRun[], attentionRequired = false): AdminImports => {
    const lastCheck = runs.find((r) => (r.result === 'unchanged' || r.result === 'published') && r.finishedAt !== null) ?? null;
    return {
      enabled: true,
      schedule,
      lastCheck,
      lastSuccessfulImport: runs.find((r) => r.result === 'published') ?? null,
      attentionRequired,
      overdue: lastCheck === null || t - Date.parse(lastCheck.checkedAt) > OVERDUE_MS,
      recentRuns: runs.slice(0, 20),
    };
  };
  switch (state) {
    case 'healthy': {
      // A busy night three checks ago: postponed before it started.
      const runs = history(checks, 0, 5).map((r, i) => (i === 3 ? run({ at: checks[3] as number, minutes: 0, result: 'deferred', reason: 'busy', step: 'check' }) : r));
      return { imports: imports(runs), dataset: servedBy(runs[5] as AdminImportRun) };
    }
    case 'published': {
      const file = newerFile(latest, 105_120_448);
      const published = run({ at: latest, minutes: 31, result: 'published', source: file, archive: digest(file.advertisedAtLocal), generationId: 8, costUsd: 0.1873 });
      return { imports: imports([published, ...history(checks, 1, 99)]), dataset: servedBy(published) };
    }
    case 'needs_review': {
      const file = newerFile(latest, 98_204_115);
      const stopped = run({ at: latest, minutes: 9, result: 'needs_review', reason: 'cohort_bounds', step: 'extract', source: file, archive: digest(file.advertisedAtLocal) });
      const runs = [stopped, ...history(checks, 1, 5)];
      return { imports: imports(runs, true), dataset: servedBy(runs[5] as AdminImportRun) };
    }
    case 'blocked': {
      const file = newerFile(checks[3] as number, 98_204_115);
      const stopped = run({ at: checks[3] as number, minutes: 9, result: 'needs_review', reason: 'cohort_bounds', step: 'extract', source: file, archive: digest(file.advertisedAtLocal) });
      const runs = [...blockedRuns(checks.slice(0, 3), stopped), stopped, ...history(checks, 4, 8)];
      return { imports: imports(runs, true), dataset: servedBy(runs[8] as AdminImportRun) };
    }
    case 'after_switch': {
      const file = newerFile(latest, 105_120_448);
      // Published as generation 8 (which now serves), then the live site failed its checks.
      const stopped = run({ at: latest, minutes: 24, result: 'needs_review', reason: 'probe', step: 'canary', source: file, archive: digest(file.advertisedAtLocal), generationId: 8, costUsd: 0.1873 });
      const runs = [stopped, ...history(checks, 1, 5)];
      return { imports: imports(runs, true), dataset: servedBy(stopped) };
    }
    case 'restore_hold': {
      const stopped = run({ at: checks[1] as number, minutes: 0, result: 'needs_review', reason: 'restore_hold', step: 'check' });
      const runs = [...blockedRuns(checks.slice(0, 1), stopped), stopped, ...history(checks, 2, 6)];
      return { imports: imports(runs, true), dataset: servedBy(runs[6] as AdminImportRun) };
    }
    case 'retired': {
      const stopped = run({ at: checks[2] as number, minutes: 0, result: 'needs_review', reason: 'source_retired', step: 'check' });
      const runs = [...blockedRuns(checks.slice(0, 2), stopped), stopped, ...history(checks, 3, 7)];
      return { imports: imports(runs, true), dataset: servedBy(runs[7] as AdminImportRun) };
    }
    case 'unreadable':
      // The server's answer when it cannot read the importer's status: attention, and no runs.
      return { imports: { ...imports([], true), lastSuccessfulImport: null } };
    case 'overdue': {
      // Since the last completed check: NTSB could not be reached, then an unknown failure.
      const runs = [
        run({ at: checks[0] as number, minutes: 3, result: 'failed', reason: 'interrupted', step: 'check' }),
        run({ at: checks[1] as number, minutes: 1, result: 'deferred', reason: 'source_unavailable', step: 'check' }),
        ...history(checks, 2, 7),
      ];
      return { imports: imports(runs), dataset: servedBy(runs[7] as AdminImportRun) };
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
