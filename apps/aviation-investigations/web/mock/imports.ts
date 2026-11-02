/** Synthetic automatic-import health. No worker, database or provider runs in mock mode. */
import {
  AdminImportRunSchema,
  AdminImportsSchema,
  type AdminImportRun,
  type AdminImports,
  type AdminOverview,
} from '../../shared/contracts/admin.js';
import config from './config.json' with { type: 'json' };

export const MOCK_IMPORT_STATES = [
  'healthy',
  'never_run',
  'published',
  'delayed',
  'fix',
  'disabled',
  'overdue',
  'unreadable',
  'schema',
  'shrunk',
  'source_unavailable',
  'source_changed_during_download',
  'monthly_budget',
  'cache_miss',
  'busy',
  'backup_window',
  'lock_lost',
  'timeout',
  'interrupted',
  'integrity',
  'verification',
  'mapping',
  'probe',
  'site_check',
  'import_cap',
  'storage',
  'configuration',
  'cleanup',
  'restore_hold',
  'accounting',
  'source_listing_changed',
  'source_retired',
  'unclassified',
  'alias_unknown',
  'rollback_failed',
  'restored',
  'restore_unverified',
  'manual_rollback',
  'baseline_changed',
  'legacy',
  'dev_temporary',
  'dev_failed',
  'dev_shrunk',
  'post_success',
  'post_success_storage',
] as const;
export type MockImportState = (typeof MOCK_IMPORT_STATES)[number];
const TIME_ZONE = 'Europe/Prague';
const LOCAL_TIME = '05:30';
const MINUTE = 60_000;

/** Europe/Prague's offset from UTC at `at`, in minutes (60 in winter, 120 in summer). */
function offsetMinutes(at: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return Math.round(
    (Date.UTC(
      parts.year ?? 0,
      (parts.month ?? 1) - 1,
      parts.day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
    ) -
      Math.floor(at / MINUTE) * MINUTE) /
      MINUTE,
  );
}

/** 05:30 in Prague on the Prague calendar day that is `days` days after the one holding `at`. */
function checkOnDay(at: number, days: number): number {
  const local = new Date(at + offsetMinutes(at) * MINUTE);
  const guess = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + days,
    5,
    30,
  );
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
    for (let i = 0; i < seed.length; i++)
      h = Math.imul(h ^ seed.charCodeAt(i), 16_777_619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

type Source = NonNullable<AdminImportRun['source']>;

/** The file NTSB lists for the serving dataset (the mock's snapshot). */
const CURRENT_FILE: Source = {
  advertisedAtLocal: `${config.snapshotDate}T06:12:37`,
  bytes: 104_857_311,
};

/** A newer file NTSB put up the evening before `at` (a Prague date, no zone, as NTSB gives it). */
function newerFile(at: number, bytes: number): Source {
  const local = new Date(at + offsetMinutes(at) * MINUTE - 86_400_000);
  return { advertisedAtLocal: `${local.toISOString().slice(0, 10)}T21:04:52`, bytes };
}

const CURRENT_ARCHIVE = digest(CURRENT_FILE.advertisedAtLocal);
const TEMPORARY = new Set<string>([
  'source_unavailable',
  'source_changed_during_download',
  'monthly_budget',
  'cache_miss',
  'busy',
  'backup_window',
  'lock_lost',
  'timeout',
  'interrupted',
]);
function run(at: number, overrides: Partial<AdminImportRun> = {}): AdminImportRun {
  return AdminImportRunSchema.parse({
    runId: `00000000-0000-4000-8000-${Math.floor(at / 1000)
      .toString()
      .padStart(12, '0')}`,
    code: 'a'.repeat(40),
    image: `sha256:${'b'.repeat(64)}`,
    origin: 'dev',
    checkedAt: iso(at),
    finishedAt: iso(at + MINUTE),
    mode: 'automatic',
    source: CURRENT_FILE,
    archiveSha256: CURRENT_ARCHIVE,
    generationId: null,
    step: 'complete',
    result: 'unchanged',
    reason: 'metadata_unchanged',
    costUsd: 0,
    ...overrides,
  });
}
export interface MockImports {
  imports: AdminImports;
  dataset?: Partial<NonNullable<AdminOverview['system']['dataset']>>;
}
export function mockImports(state: MockImportState, now: Date): MockImports {
  const checks = checksBefore(now.getTime(), 14);
  const latest = checks[0]!;
  const previous = run(checks[10]!, {
    result: 'published',
    reason: null,
    generationId: 7,
    costUsd: 0.2114,
    changes: { new: 123, updated: 404, removed: 2 },
  });
  const base: AdminImports = AdminImportsSchema.parse({
    enabled: true,
    status: 'working',
    schedule: {
      localTime: LOCAL_TIME,
      timeZone: TIME_ZONE,
      nextCheckAt: iso(nextCheck(now.getTime())),
    },
    serving: {
      generationId: 7,
      sourceDate: config.snapshotDate,
      importedAt: previous.finishedAt,
      restoredAt: null,
    },
    lastStartedAt: iso(latest),
    lastCheck: run(latest),
    lastGoodCheck: run(latest),
    waiting: null,
    alert: null,
    recentRuns: [...checks.slice(0, 10).map((at) => run(at)), previous],
  });
  if (state === 'disabled' || state === 'never_run') {
    base.enabled = state !== 'disabled';
    base.status = base.enabled ? 'working' : 'off';
    if (!base.enabled) base.schedule!.nextCheckAt = null;
    base.lastStartedAt = null;
    base.lastCheck = null;
    base.lastGoodCheck = null;
    base.recentRuns = [];
  } else if (state === 'published') {
    const published = run(latest, {
      result: 'published',
      reason: null,
      generationId: 8,
      source: newerFile(latest, 105120448),
      costUsd: 0.1873,
      changes: { new: 152, updated: 501, removed: 2 },
    });
    base.lastCheck = base.lastGoodCheck = published;
    base.recentRuns[0] = published;
    base.serving = {
      generationId: 8,
      sourceDate: published.source!.advertisedAtLocal.slice(0, 10),
      importedAt: published.finishedAt,
      restoredAt: null,
    };
  } else if (state === 'legacy') {
    const old = run(latest, {
      result: 'needs_review',
      reason: 'cohort_bounds',
      step: 'extract',
      source: newerFile(latest, 105120448),
    });
    base.lastCheck = old;
    base.recentRuns[0] = old;
    base.waiting = {
      source: old.source,
      since: old.checkedAt,
      reason: null,
      retry: 'daily',
    };
    base.lastGoodCheck = previous;
  } else if (state === 'overdue' || state === 'unreadable') {
    base.status = 'fix';
    base.alert = {
      level: 'fix',
      cause: state === 'overdue' ? 'overdue' : 'status_unavailable',
      since: null,
      failedDays: 0,
      origin: 'host',
      siteState: 'unchanged',
      nextAction: 'release',
      retryAt: null,
      postSuccess: false,
      devAdvanced: false,
      details: null,
      originRunId: null,
    };
    if (state === 'overdue') {
      base.recentRuns = base.recentRuns.slice(2);
      base.lastCheck = base.lastGoodCheck = base.recentRuns[0]!;
      base.lastStartedAt = base.lastCheck.checkedAt;
      base.alert.since = base.lastStartedAt;
    } else {
      base.recentRuns = [];
      base.lastCheck = base.lastGoodCheck = null;
      base.lastStartedAt = null;
      base.serving = null;
    }
  } else if (state !== 'healthy') {
    const causes: Partial<Record<MockImportState, AdminImportRun['reason']>> = {
      delayed: 'source_unavailable',
      fix: 'schema',
      restored: 'site_check',
      restore_unverified: 'site_check',
      dev_failed: 'probe',
      dev_temporary: 'source_unavailable',
      dev_shrunk: 'shrunk',
      post_success: 'cleanup',
      post_success_storage: 'storage',
    };
    const cause = causes[state] ?? (state as NonNullable<AdminImportRun['reason']>);
    const temporary =
      TEMPORARY.has(cause) || state === 'post_success' || state === 'dev_temporary';
    const postSuccess = state.startsWith('post_success');
    const inherited = state === 'dev_failed' || state === 'dev_temporary';
    let origin: NonNullable<AdminImportRun['origin']> = 'dev';
    if (state === 'dev_shrunk') origin = 'live';
    if (postSuccess) origin = 'host';
    const at = checks[2]!;
    const fileTouched =
      ![
        'source_unavailable',
        'busy',
        'backup_window',
        'restore_hold',
        'configuration',
        'source_retired',
        'source_listing_changed',
        'dev_failed',
      ].includes(cause) && !inherited;
    const source =
      fileTouched || postSuccess || state === 'dev_failed'
        ? newerFile(at, 105120448)
        : null;
    const cost = fileTouched || postSuccess ? 0.1873 : 0;
    let result: AdminImportRun['result'] = 'failed';
    if (temporary) result = 'deferred';
    if (inherited) result = 'skipped_dev_failed';
    if (postSuccess) result = 'published';
    const restored = state === 'restored' || state === 'manual_rollback';
    const unverified = state === 'restore_unverified';
    const stopped = run(at, {
      result,
      reason: postSuccess ? null : cause,
      step: fileTouched ? 'extract' : 'check',
      origin,
      source,
      archiveSha256: source ? digest(source.advertisedAtLocal) : null,
      costUsd: cost,
      generationId: postSuccess ? 8 : null,
      restoration:
        restored || unverified
          ? {
              sourceDate: config.snapshotDate,
              restoredAt: restored ? iso(at + 2 * MINUTE) : null,
            }
          : null,
    });
    const laterRuns = checks.slice(0, 2).map((time) => {
      if (postSuccess)
        return run(time, {
          source,
          archiveSha256: stopped.archiveSha256,
          generationId: 8,
          origin,
        });
      if (temporary || inherited || !fileTouched)
        return run(time, {
          ...stopped,
          runId: run(time).runId,
          checkedAt: iso(time),
          finishedAt: iso(time + MINUTE),
        });
      return run(time, {
        source,
        archiveSha256: stopped.archiveSha256,
        result: 'waiting',
        reason: cause,
        step: 'check',
        suppressed: true,
        costUsd: cost,
        origin,
      });
    });
    base.status = temporary ? 'delayed' : 'fix';
    base.lastGoodCheck = run(checks[3]!);
    base.recentRuns = [...laterRuns, stopped, ...base.recentRuns.slice(3)];
    base.lastCheck = base.recentRuns[0]!;
    base.lastStartedAt = base.lastCheck.checkedAt;
    let nextAction: NonNullable<AdminImports['alert']>['nextAction'] =
      'new_file_or_release';
    if (temporary || postSuccess || unverified) nextAction = 'daily';
    if (['alias_unknown', 'rollback_failed', 'restore_hold'].includes(cause))
      nextAction = 'release';
    let siteState: NonNullable<AdminImports['alert']>['siteState'] = 'unchanged';
    if (restored) siteState = 'restored';
    if (unverified) siteState = 'restore_unverified';
    if (['alias_unknown', 'rollback_failed'].includes(cause)) siteState = 'uncertain';
    base.waiting =
      fileTouched && !postSuccess
        ? {
            source,
            since: iso(at),
            reason: cause,
            retry: temporary ? 'daily' : 'new_file_or_release',
          }
        : null;
    const details =
      temporary || postSuccess ? { ...base.lastCheck, reason: cause } : stopped;
    if (postSuccess) details.step = 'cleanup';
    base.alert = {
      level: base.status,
      cause,
      since: iso(at),
      failedDays: temporary ? 3 : 0,
      origin,
      siteState,
      nextAction,
      retryAt:
        cause === 'monthly_budget'
          ? iso(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
          : null,
      postSuccess,
      devAdvanced: state === 'dev_shrunk',
      details,
      originRunId: inherited ? '10000000-0000-4000-8000-000000000001' : null,
    };
    if (restored) base.serving!.restoredAt = stopped.restoration!.restoredAt;
    if (postSuccess) {
      base.serving = {
        generationId: 8,
        sourceDate: source!.advertisedAtLocal.slice(0, 10),
        importedAt: stopped.finishedAt,
        restoredAt: null,
      };
      base.lastGoodCheck = base.lastCheck;
    }
  }
  return {
    imports: AdminImportsSchema.parse(base),
    dataset: base.serving
      ? {
          generationId: base.serving.generationId,
          snapshotDate: base.serving.sourceDate ?? config.snapshotDate,
          publishedAt: base.serving.importedAt!,
          loadedAt: base.serving.importedAt!,
        }
      : undefined,
  };
}
export function parseMockImportState(value: string | null | undefined): MockImportState {
  return (MOCK_IMPORT_STATES as readonly string[]).includes(value ?? '')
    ? (value as MockImportState)
    : 'healthy';
}
