/**
 * The admin page's data (Task 25): `GET /api/admin/overview`, only for a signed-in account whose
 * verified e-mail is in `AIRCASE_ADMIN_EMAILS` (404 for everyone else, so the route is not
 * discoverable). Private, `no-store`, never logged or traced. Counts and sums come from the
 * accounts, the quota counters, the reservations and the spend ledger; nothing here is model text.
 */
import { z } from 'zod';

const Iso = z.iso.datetime();
const Count = z.number().int().min(0);
const Usd = z.number().min(0);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** The source's advertised date/time, without a timezone (NTSB supplies none). */
const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

export const IMPORT_STEPS = [
  'check',
  'acquire',
  'extract',
  'load',
  'verify',
  'plan',
  'index_cases',
  'index_passages',
  'validate',
  'publish',
  'canary',
  'cleanup',
  'complete',
] as const;
export const IMPORT_RESULTS = [
  'running',
  'waiting',
  'unchanged',
  'published',
  'needs_review',
  'deferred',
  'failed',
  'skipped_dev_failed',
  'cancelled',
  'rolled_back',
] as const;
export const IMPORT_REASONS = [
  'metadata_unchanged',
  'same_archive',
  'same_content',
  'source_listing_changed',
  'source_reissued',
  'source_changed_during_download',
  'source_unavailable',
  'source_retired',
  'baseline_required',
  'baseline_changed',
  'schema',
  'integrity',
  'verification',
  'cohort_bounds',
  'mapping',
  'probe',
  'import_cap',
  'monthly_budget',
  'cache_miss',
  'restore_hold',
  'accounting',
  'storage',
  'alias_unknown',
  'busy',
  'backup_window',
  'lock_lost',
  'timeout',
  'interrupted',
  'dev_failed',
  'configuration',
  'cleanup',
  'shrunk',
  'unclassified',
  'site_check',
  'rollback_failed',
  'post_success',
  'manual_rollback',
] as const;

const ImportSourceSchema = z.strictObject({
  advertisedAtLocal: LocalDateTime,
  bytes: Count,
});
const ImportOrigin = z.enum(['dev', 'live', 'host']);
const ImportRetry = z.enum(['daily', 'new_file_or_release', 'release']);
export const AdminImportRunSchema = z.strictObject({
  runId: z.uuid().nullable().default(null),
  code: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable()
    .default(null),
  image: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  origin: ImportOrigin.nullable().default(null),
  workKind: z.enum(['import', 'recertification']).default('import'),
  suppressed: z.boolean().default(false),
  changes: z
    .strictObject({ new: Count, updated: Count, removed: Count })
    .nullable()
    .default(null),
  restoration: z
    .strictObject({ sourceDate: z.iso.date().nullable(), restoredAt: Iso.nullable() })
    .nullable()
    .default(null),
  checkedAt: Iso,
  finishedAt: Iso.nullable(),
  mode: z.enum(['automatic', 'forced_dev']),
  source: ImportSourceSchema.nullable(),
  archiveSha256: Sha256.nullable(),
  generationId: Count.nullable(),
  step: z.enum(IMPORT_STEPS),
  result: z.enum(IMPORT_RESULTS),
  reason: z.enum(IMPORT_REASONS).nullable(),
  /** This artifact/environment's settled, uncertain and outstanding charges, all attempts. */
  costUsd: Usd,
});
export type AdminImportRun = z.infer<typeof AdminImportRunSchema>;

export const ImportAlertSchema = z.strictObject({
  level: z.enum(['delayed', 'fix']),
  holds: z.array(z.enum(['restore_hold', 'alias_unknown', 'rollback_failed'])).max(2),
  cause: z.enum([...IMPORT_REASONS, 'overdue', 'status_unavailable']),
  since: Iso.nullable(),
  failedDays: Count,
  origin: ImportOrigin,
  siteState: z.enum(['unchanged', 'restored', 'restore_unverified', 'uncertain']),
  nextAction: ImportRetry,
  retryAt: Iso.nullable(),
  postSuccess: z.boolean(),
  devAdvanced: z.boolean(),
  details: AdminImportRunSchema.nullable(),
  originRunId: z.uuid().nullable(),
});
export const AdminImportsSchema = z.strictObject({
  enabled: z.boolean(),
  readable: z.boolean(),
  status: z.enum(['off', 'working', 'delayed', 'fix']),
  schedule: z
    .strictObject({
      localTime: z.string().regex(/^\d{2}:\d{2}$/),
      timeZone: z.string().min(1).max(64),
      nextCheckAt: Iso.nullable(),
    })
    .nullable(),
  serving: z
    .strictObject({
      generationId: Count,
      sourceDate: z.iso.date().nullable(),
      importedAt: Iso.nullable(),
      restoredAt: Iso.nullable(),
    })
    .nullable(),
  lastStartedAt: Iso.nullable(),
  lastCheck: AdminImportRunSchema.nullable(),
  lastGoodCheck: AdminImportRunSchema.nullable(),
  waiting: z
    .strictObject({
      source: ImportSourceSchema.nullable(),
      since: Iso,
      reason: z.enum(IMPORT_REASONS).nullable(),
      retry: ImportRetry,
    })
    .nullable(),
  alert: ImportAlertSchema.nullable(),
  recentRuns: z.array(AdminImportRunSchema).max(20),
});
export type AdminImports = z.infer<typeof AdminImportsSchema>;

export const AdminUserSchema = z.strictObject({
  name: z.string().max(200),
  email: z.string().min(3).max(320),
  createdAt: Iso,
  /** The latest session activity of the account, if it has a session. */
  lastSignInAt: Iso.nullable(),
  /** The latest AI search the account was charged a search for. */
  lastAiSearchAt: Iso.nullable(),
  /** Charged AI searches; usage records are kept 90 days, so the longest window is 90 days. */
  aiSearches: z.strictObject({
    today: Count,
    last7Days: Count,
    last30Days: Count,
    last90Days: Count,
  }),
  isAdmin: z.boolean(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

/** One UTC day of AI search use (the last 30 days, oldest first). */
export const AdminUsageDaySchema = z.strictObject({
  day: z.iso.date(),
  /** Searches charged to anonymous trials and to accounts (free undos included as their own count). */
  trialSearches: Count,
  accountSearches: Count,
  freeUndos: Count,
  /** Searches that failed after admission. */
  failedSearches: Count,
  /** Spend settled that day, all categories. */
  usd: Usd,
});
export type AdminUsageDay = z.infer<typeof AdminUsageDaySchema>;

export const AdminStageCostSchema = z.strictObject({
  stage: z.string().max(40),
  provider: z.string().max(40).nullable(),
  model: z.string().max(80).nullable(),
  calls: Count,
  usd: Usd,
});
export type AdminStageCost = z.infer<typeof AdminStageCostSchema>;

export const AdminOverviewSchema = z.strictObject({
  generatedAt: Iso,
  users: z.strictObject({
    total: Count,
    newLast7Days: Count,
    /** Most recently active first; at most 1,000. */
    list: z.array(AdminUserSchema).max(1000),
  }),
  usage: z.strictObject({
    days: z.array(AdminUsageDaySchema).max(31),
    /** Distinct anonymous trial identities that searched in the last 30 days. */
    activeTrialsLast30Days: Count,
    /** Distinct accounts that searched in the last 30 days. */
    activeAccountsLast30Days: Count,
    /** Visitors' ratings of their searches (Task 25), all time and the last 30 days. */
    feedback: z.strictObject({
      useful: Count,
      notUseful: Count,
      usefulLast30Days: Count,
      notUsefulLast30Days: Count,
    }),
  }),
  costs: z.strictObject({
    /** Today (UTC), all categories. */
    today: Usd,
    /** Today (UTC), settled interactive spend only: what `budgets.interactiveDaily` caps. */
    interactiveToday: Usd,
    monthToDate: Usd,
    previousMonth: Usd,
    /** This month, by spend category. */
    byCategory: z.strictObject({ interactive: Usd, indexing: Usd, evaluation: Usd }),
    /** This month, by pipeline stage, provider and model; most expensive first. */
    byStage: z.array(AdminStageCostSchema).max(50),
    /** This month: settled interactive spend per charged AI search. */
    perSearch: z.strictObject({ searches: Count, meanUsd: Usd.nullable() }),
    /** Charges kept at their reserved worst case because the provider's bill was uncertain, this month. */
    uncertainUsd: Usd,
    budgets: z.strictObject({
      monthly: Usd,
      interactiveMonthly: Usd,
      interactiveDaily: Usd,
      ingestionMonthly: Usd,
    }),
  }),
  system: z.strictObject({
    appVersion: z.string().max(80).nullable(),
    appEnv: z.enum(['dev', 'live']),
    startedAt: Iso,
    ranking: z.string().max(40),
    automaticFilters: z.string().max(40),
    ai: z.strictObject({
      enabled: z.boolean(),
      anonymousEnabled: z.boolean(),
      accountCheck: z.enum(['suspicious', 'always']),
    }),
    tracing: z.strictObject({
      enabled: z.boolean(),
      lastExportOkAt: Iso.nullable(),
      failedExports: Count,
    }),
    /** The dataset AirCase serves: its generation, the NTSB snapshot date, when it was loaded and published. */
    dataset: z
      .strictObject({
        generationId: Count,
        snapshotDate: z.iso.date(),
        loadedAt: Iso.nullable(),
        publishedAt: Iso.nullable(),
        cases: Count,
        eligibleCases: Count,
      })
      .nullable(),
    imports: AdminImportsSchema,
  }),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;
