/** Synthetic automatic-import health. No worker, database or provider runs in mock mode. */
import { AdminImportRunSchema, AdminImportsSchema, type AdminImportRun, type AdminImports, type AdminOverview } from '../../shared/contracts/admin.js';
import config from './config.json' with { type: 'json' };

export const MOCK_IMPORT_STATES = [
  'healthy', 'published', 'delayed', 'fix', 'disabled', 'overdue', 'unreadable',
  'schema', 'shrunk', 'source_unavailable', 'source_changed_during_download', 'monthly_budget',
  'cache_miss', 'busy', 'backup_window', 'lock_lost', 'timeout', 'interrupted',
  'integrity', 'verification', 'mapping', 'probe', 'site_check', 'import_cap', 'storage',
  'configuration', 'cleanup', 'restore_hold', 'accounting', 'source_listing_changed',
  'source_retired', 'unclassified', 'alias_unknown', 'rollback_failed',
  'restored', 'dev_failed', 'dev_shrunk', 'post_success', 'post_success_storage',
] as const;
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

/** A made-up SHA-256 digest from a seed (64 hex characters): every character of the seed counts (FNV-1a, salted per group). */
function digest(seed: string): string {
  let out = '';
  for (let group = 0; out.length < 64; group++) {
    let h = (2_166_136_261 ^ group) >>> 0;
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16_777_619) >>> 0;
    out += h.toString(16).padStart(8, '0');
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


const CURRENT_ARCHIVE = digest(CURRENT_FILE.advertisedAtLocal);
const TEMPORARY = new Set<string>(['source_unavailable', 'source_changed_during_download', 'monthly_budget', 'cache_miss', 'busy', 'backup_window', 'lock_lost', 'timeout', 'interrupted']);
function run(at: number, overrides: Partial<AdminImportRun> = {}): AdminImportRun {
  return AdminImportRunSchema.parse({
    runId: `00000000-0000-4000-8000-${Math.floor(at / 1000).toString().padStart(12, '0')}`,
    code: 'a'.repeat(40), image: `sha256:${'b'.repeat(64)}`, origin: 'dev',
    checkedAt: iso(at + 4000), finishedAt: iso(at + MINUTE), mode: 'automatic',
    source: CURRENT_FILE, archiveSha256: CURRENT_ARCHIVE, generationId: null,
    step: 'complete', result: 'unchanged', reason: 'metadata_unchanged', costUsd: 0, ...overrides,
  });
}
export interface MockImports {
  imports: AdminImports;
  dataset?: Partial<NonNullable<AdminOverview['system']['dataset']>>;
}
export function mockImports(state: MockImportState, now: Date): MockImports {
  const checks = checksBefore(now.getTime(), 14);
  const latest = checks[0]!;
  const previous = run(checks[10]!, { result: 'published', reason: null, generationId: 7, costUsd: 0.2114,
    changes: { new: 123, updated: 404, removed: 2 } });
  const base: AdminImports = AdminImportsSchema.parse({
    enabled: true, status: 'working',
    schedule: { localTime: LOCAL_TIME, timeZone: TIME_ZONE, nextCheckAt: iso(nextCheck(now.getTime())) },
    serving: { generationId: 7, sourceDate: config.snapshotDate, importedAt: previous.finishedAt, restoredAt: null },
    lastStartedAt: iso(latest), lastCheck: run(latest), lastGoodCheck: run(latest),
    waiting: null, alert: null, recentRuns: [...checks.slice(0, 10).map(at => run(at)), previous],
  });
  if (state === 'disabled') {
    base.enabled = false; base.status = 'off'; base.schedule!.nextCheckAt = null;
    base.lastStartedAt = null; base.lastCheck = null; base.lastGoodCheck = null; base.recentRuns = [];
  } else if (state === 'published') {
    const published = run(latest, { result: 'published', reason: null, generationId: 8, source: newerFile(latest, 105120448),
      costUsd: 0.1873, changes: { new: 152, updated: 501, removed: 2 } });
    base.lastCheck = base.lastGoodCheck = published; base.recentRuns[0] = published;
    base.serving = { generationId: 8, sourceDate: published.source!.advertisedAtLocal.slice(0, 10), importedAt: published.finishedAt, restoredAt: null };
  } else if (state !== 'healthy') {
    const cause = state === 'delayed' ? 'source_unavailable' : state === 'fix' ? 'schema'
      : state === 'restored' ? 'site_check' : state === 'dev_failed' ? 'probe'
      : state === 'dev_shrunk' ? 'shrunk' : state === 'post_success' ? 'cleanup'
      : state === 'post_success_storage' ? 'storage' : state === 'unreadable' ? 'status_unavailable' : state;
    const temporary = TEMPORARY.has(cause) || state === 'post_success';
    const special = cause === 'overdue' || cause === 'status_unavailable';
    const failureDays = temporary ? 3 : 1;
    const since = checks[failureDays - 1]!;
    const source = newerFile(since, 105120448);
    const postSuccess = state.startsWith('post_success');
    const stopped = run(since, { result: postSuccess ? 'published' : state === 'restored' ? 'rolled_back' : temporary ? 'deferred' : 'failed',
      reason: special ? null : cause, step: 'extract', source, archiveSha256: digest(source.advertisedAtLocal),
      costUsd: 0.1873, generationId: postSuccess ? 8 : null,
      restoration: state === 'restored' ? { sourceDate: config.snapshotDate, restoredAt: iso(since + 2 * MINUTE) } : null });
    base.status = temporary ? 'delayed' : 'fix';
    base.lastGoodCheck = run(checks[failureDays]!);
    base.waiting = special || postSuccess ? null : { source, since: iso(since), reason: stopped.reason, retry: temporary ? 'daily' : 'new_file_or_release' };
    base.recentRuns = [ ...checks.slice(0, failureDays - 1).map(at => run(at, { result: temporary ? 'deferred' : 'waiting',
      source, reason: stopped.reason, step: 'check', suppressed: !temporary })), stopped, ...base.recentRuns.slice(failureDays) ];
    base.lastCheck = base.recentRuns[0]!;
    base.alert = { level: base.status, cause, since: iso(since), failedDays: failureDays, origin: state === 'dev_failed' ? 'dev' : 'host',
      siteState: ['alias_unknown', 'rollback_failed'].includes(cause) ? 'uncertain' : state === 'restored' ? 'restored' : 'unchanged',
      nextAction: temporary || postSuccess ? 'daily' : ['alias_unknown', 'rollback_failed'].includes(cause) ? 'release' : 'new_file_or_release',
      retryAt: cause === 'monthly_budget' ? iso(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) : null,
      postSuccess, devAdvanced: state === 'dev_shrunk', details: special ? null : stopped, originRunId: state === 'dev_failed' ? stopped.runId : null };
    if (state === 'restored') base.serving!.restoredAt = stopped.restoration!.restoredAt;
    if (postSuccess) {
      base.serving = { generationId: 8, sourceDate: source.advertisedAtLocal.slice(0,10), importedAt: stopped.finishedAt, restoredAt: null };
      base.lastGoodCheck = stopped;
    }
    if (state === 'overdue') {
      base.lastStartedAt = iso(checks[2]!); base.alert.since = base.lastStartedAt;
      base.recentRuns = base.recentRuns.slice(2); base.lastCheck = base.lastGoodCheck = base.recentRuns[0]!;
    }
    if (state === 'unreadable') {
      base.recentRuns = []; base.lastCheck = base.lastGoodCheck = null; base.lastStartedAt = null; base.serving = null;
    }
  }
  return { imports: AdminImportsSchema.parse(base), dataset: base.serving ? {
    generationId: base.serving.generationId, snapshotDate: base.serving.sourceDate ?? config.snapshotDate,
    publishedAt: base.serving.importedAt!, loadedAt: base.serving.importedAt!,
  } : undefined };
}
export function parseMockImportState(value: string | null | undefined): MockImportState {
  return (MOCK_IMPORT_STATES as readonly string[]).includes(value ?? '') ? value as MockImportState : 'healthy';
}
