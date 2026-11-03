/** Synthetic automatic-import health. No worker, database or provider runs in mock mode. */
import {
  AdminImportRunSchema,
  type AdminImportRun,
  type AdminImports,
  type AdminOverview,
} from '../../shared/contracts/admin.js';
import {
  projectImports,
  type ImportHealth,
  type StatusRow,
  type ImportSchedule,
} from '../../worker/importer/status.js';
import { TEMPORARY_REASONS } from '../../shared/import-policy.js';
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
  'disabled_unreadable',
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
/** Inputs to the production projector, also exposed for the fixture-contract test. */
export function mockImportInputs(
  state: MockImportState,
  now: Date,
): {
  rows: StatusRow[];
  schedule: ImportSchedule;
  health: ImportHealth | true;
} {
  const checks = checksBefore(now.getTime(), 14),
    latest = checks[0]!;
  const previous = run(checks[10]!, {
    result: 'published',
    reason: null,
    generationId: 7,
    costUsd: 0.2114,
    changes: { new: 123, updated: 404, removed: 2 },
  });
  let runs = [...checks.slice(0, 10).map((at) => run(at)), previous];
  const schedule = {
    enabled: state !== 'disabled' && state !== 'disabled_unreadable',
    localTime: LOCAL_TIME,
    timeZone: TIME_ZONE,
  };
  const health: ImportHealth = {
    automaticSince: iso(latest),
    restoreHeld: false,
    switchHeld: false,
    switchHoldReason: 'alias_unknown',
    hold: null,
    temporaryDays: 0,
    delayedSince: null,
    fixSince: null,
    serving: {
      generationId: 7,
      sourceDate: config.snapshotDate,
      importedAt: previous.finishedAt,
      restoredAt: null,
    },
    lastGood: run(latest),
    waiting: null,
    issue: null,
  };
  if (state === 'unreadable' || state === 'disabled_unreadable')
    return { rows: [], schedule, health: true };
  if (state === 'disabled' || state === 'never_run') {
    runs = [];
    health.lastGood = null;
  } else if (state === 'published') {
    const published = run(latest, {
      result: 'published',
      reason: null,
      generationId: 8,
      source: newerFile(latest, 105120448),
      costUsd: 0.1873,
      changes: { new: 152, updated: 501, removed: 2 },
    });
    runs[0] = published;
    health.lastGood = published;
    health.serving = {
      generationId: 8,
      sourceDate: published.source!.advertisedAtLocal.slice(0, 10),
      importedAt: published.finishedAt,
      restoredAt: null,
    };
  } else if (state === 'legacy') {
    runs[0] = run(latest, {
      result: 'needs_review',
      reason: 'cohort_bounds',
      step: 'extract',
      source: { advertisedAtLocal: '2026-11-01T07:30:00', bytes: 105120448 },
    });
    health.waiting = {
      source: runs[0]!.source,
      since: runs[0]!.checkedAt,
      reason: null,
      retry: 'daily',
    };
    health.lastGood = previous;
  } else if (state === 'overdue' || state === 'restore_hold') {
    // import_claim refuses a held restore before creating a run or an issue.
    runs = runs.slice(2);
    health.lastGood = runs[0]!;
    health.restoreHeld = state === 'restore_hold';
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
    const postSuccess = state.startsWith('post_success');
    const temporary = TEMPORARY_REASONS.has(cause) || state === 'post_success';
    const inherited = state === 'dev_failed' || state === 'dev_temporary';
    const restored = state === 'restored' || state === 'manual_rollback';
    const unverified = state === 'restore_unverified';
    const manual = state === 'manual_rollback';
    let origin: NonNullable<AdminImportRun['origin']> = 'dev';
    if (postSuccess) origin = 'host';
    else if (state === 'dev_shrunk') origin = 'live';
    const first = manual ? latest : checks[2]!;
    const stepByCause: Partial<
      Record<NonNullable<AdminImportRun['reason']>, AdminImportRun['step']>
    > = {
      source_unavailable: 'check',
      busy: 'check',
      backup_window: 'check',
      configuration: 'check',
      source_retired: 'check',
      source_listing_changed: 'check',
      dev_failed: 'check',
      source_changed_during_download: 'acquire',
      cache_miss: 'plan',
      monthly_budget: 'plan',
      lock_lost: 'index_cases',
      timeout: 'index_cases',
      interrupted: 'index_cases',
      probe: 'validate',
      site_check: 'canary',
      rollback_failed: 'canary',
      alias_unknown: 'check',
      manual_rollback: 'canary',
      baseline_changed: 'publish',
    };
    const step = stepByCause[cause] ?? 'extract';
    const fileTouched = step !== 'check' && step !== 'acquire' && !manual;
    const source =
      fileTouched || postSuccess || state === 'dev_failed' || step === 'acquire'
        ? newerFile(first, 105120448)
        : null;
    const cost =
      (fileTouched &&
        !['cache_miss', 'monthly_budget', 'lock_lost', 'timeout', 'interrupted'].includes(
          cause,
        )) ||
      postSuccess ||
      manual
        ? 0.1873
        : 0;
    const suppressesFile =
      !temporary && !postSuccess && (fileTouched || manual || state === 'dev_failed');
    let result: AdminImportRun['result'] = 'failed';
    if (postSuccess) result = 'published';
    else if (manual) result = 'rolled_back';
    else if (inherited) result = 'skipped_dev_failed';
    else if (temporary) result = 'deferred';
    let archiveSha256: string | null = null;
    if (manual) archiveSha256 = digest(newerFile(first, 105120448).advertisedAtLocal);
    else if (source && step !== 'acquire')
      archiveSha256 = digest(source.advertisedAtLocal);
    const stopped = run(first, {
      result,
      reason: postSuccess ? null : cause,
      step: postSuccess || manual ? 'complete' : step,
      origin,
      source,
      archiveSha256,
      costUsd: cost,
      generationId:
        postSuccess ||
        manual ||
        [
          'verify',
          'plan',
          'index_cases',
          'index_passages',
          'validate',
          'publish',
          'canary',
        ].includes(step)
          ? 8
          : null,
      restoration:
        restored || unverified
          ? {
              sourceDate: config.snapshotDate,
              restoredAt: restored ? iso(first + 2 * MINUTE) : null,
            }
          : null,
    });
    const later = manual
      ? []
      : checks.slice(0, 2).map((time) => {
          if (postSuccess)
            return run(time, {
              source,
              archiveSha256: stopped.archiveSha256,
              generationId: 8,
              origin,
            });
          if (['alias_unknown', 'rollback_failed'].includes(cause))
            return run(time, {
              source: null,
              archiveSha256: stopped.archiveSha256,
              generationId: stopped.generationId,
              result: 'waiting',
              reason: cause,
              step: 'check',
              costUsd: cost,
              origin,
            });
          if (temporary || inherited || !suppressesFile || unverified)
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
    runs = [...later, stopped, ...runs.slice(manual ? 1 : 3)];
    health.lastGood = postSuccess ? runs[0]! : run(checks[3]!);
    health.temporaryDays = temporary ? 3 : 0;
    health.delayedSince = temporary ? iso(first) : null;
    health.fixSince = temporary ? null : iso(first);
    health.switchHeld = ['alias_unknown', 'rollback_failed'].includes(cause);
    health.switchHoldReason =
      cause === 'rollback_failed' ? 'rollback_failed' : 'alias_unknown';
    const details = {
      ...(temporary || postSuccess ? runs[0]! : stopped),
      reason: cause,
      step: postSuccess ? ('cleanup' as const) : step,
    };
    let siteState: NonNullable<ImportHealth['issue']>['siteState'] = 'unchanged';
    if (restored) siteState = 'restored';
    else if (unverified) siteState = 'restore_unverified';
    else if (health.switchHeld) siteState = 'uncertain';
    health.issue = {
      reason: cause,
      fixed: !temporary,
      since: details.checkedAt,
      origin,
      siteState,
      postSuccess,
      suppressesFile,
      preflight: false,
      details,
      originRunId: inherited ? '10000000-0000-4000-8000-000000000001' : null,
    };
    if (fileTouched && !postSuccess && !inherited)
      health.waiting = {
        source,
        since: iso(first),
        reason: cause,
        retry: suppressesFile ? 'new_file_or_release' : 'daily',
      };
    if (health.switchHeld)
      health.hold = {
        since: stopped.checkedAt,
        details: { ...stopped, reason: cause, step },
      };
    if (restored) health.serving!.restoredAt = stopped.restoration!.restoredAt;
    if (postSuccess)
      health.serving = {
        generationId: 8,
        sourceDate: source!.advertisedAtLocal.slice(0, 10),
        importedAt: stopped.finishedAt,
        restoredAt: null,
      };
  }
  health.lastGood =
    runs.find((r) => r.result === 'published' || r.result === 'unchanged') ?? null;
  return {
    schedule,
    health,
    rows: runs.map((r) => ({
      public: r,
      sourceCheckSucceeded: r.result === 'published' || r.result === 'unchanged',
      canaryPassed: r.result === 'published',
      goodCheck: r.result === 'published' || r.result === 'unchanged',
    })),
  };
}
export function mockImports(state: MockImportState, now: Date): MockImports {
  const input = mockImportInputs(state, now);
  const imports = projectImports(input.rows, input.schedule, now, input.health);
  return {
    imports,
    dataset: imports.serving
      ? {
          generationId: imports.serving.generationId,
          snapshotDate: imports.serving.sourceDate ?? config.snapshotDate,
          publishedAt: imports.serving.importedAt!,
          loadedAt: imports.serving.importedAt!,
        }
      : undefined,
  };
}
export function parseMockImportState(value: string | null | undefined): MockImportState {
  return (MOCK_IMPORT_STATES as readonly string[]).includes(value ?? '')
    ? (value as MockImportState)
    : 'healthy';
}
