/**
 * How the admin page says the automatic NTSB importer's status (`system.imports`, UI_DESIGN §4.12,
 * Task 26; docs/IMPORTER.md): every result, reason, step and mode in plain words, so no identifier
 * shows raw (they appear only on a secondary code line, as the ranking's does), and what a review
 * needs, by its kind, with the documentation and commands that resolve it. The source's advertised
 * date is NTSB's own, given with no time zone, and stays a date with none. Builder copy for the
 * owner's review.
 *
 * What the server sends (worker/importer/status.ts): `lastCheck` is the newest *completed* check (only
 * an unchanged or published run; failures, postponements and stops never refresh it); the runs are
 * newest first; a run's cost is its file's running total across attempts; a daily run that an
 * unresolved review blocks is recorded as postponed with that review's reason.
 */
import type { AdminImportRun, AdminImports, IMPORT_REASONS, IMPORT_RESULTS, IMPORT_STEPS } from '../../../../shared/contracts/admin';
import { formatDate } from '../../../../shared/format';

export type ImportReason = (typeof IMPORT_REASONS)[number];
export type ImportResult = (typeof IMPORT_RESULTS)[number];
export type ImportStep = (typeof IMPORT_STEPS)[number];

/** The importer's limits the copy names (tied to the worker's own values by tests/unit/import-words.test.ts). */
export const IMPORT_LIMITS = {
  /** No completed check for this long while enabled: overdue (worker/importer/status.ts). */
  overdueHours: 36,
  /** NTSB files further apart than this need a new reviewed baseline (worker/importer/compare.ts). */
  sourceGapDays: 62,
  /** The cost cap per file and environment (`IMPORT_CAP_MICROS`, worker/importer/contracts.ts). */
  capUsd: 0.5,
  /** The whole host run's deadline (worker/importer/host.ts). */
  deadlineHours: 3,
} as const;

/**
 * The reasons a run is postponed for and simply tries again (the worker's temporary reasons,
 * worker/importer/contracts.ts); any other reason on a postponed run while a review is open is that
 * review blocking the daily runs.
 */
export const TEMPORARY_REASONS: ReadonlySet<ImportReason> = new Set<ImportReason>([
  'source_unavailable',
  'cache_miss',
  'monthly_budget',
  'busy',
  'backup_window',
  'lock_lost',
  'timeout',
  'interrupted',
  'dev_failed',
]);

/** The steps at and after the switch to the new data: a run that stops there may already have published it. */
const AFTER_SWITCH: ReadonlySet<ImportStep> = new Set<ImportStep>(['publish', 'canary', 'cleanup']);

/** Reasons a run is refused for before it starts any work: it reached no step. */
const NEVER_STARTED: ReadonlySet<ImportReason> = new Set<ImportReason>(['busy', 'backup_window']);

/** The reviews a named, approved exception can accept (docs/IMPORTER.md, `pnpm importer approve`). */
const COMPARISON_REVIEWS: ReadonlySet<ImportReason> = new Set<ImportReason>(['cohort_bounds', 'source_reissued', 'baseline_required']);

/** The reviews the importer's own commands cannot clear: docs/RUNBOOK.md, “Paid operations after a restore”. */
const RESTORE_REVIEWS: ReadonlySet<ImportReason> = new Set<ImportReason>(['restore_hold', 'accounting']);

/**
 * Each reason a run gives, as a clause that follows "Stopped for review:", "Postponed:", "Failed:"
 * or "Cancelled:" (docs/IMPORTER.md has what each means). A few depend on the run (`reasonWords`).
 */
export const IMPORT_REASON_WORDS: Record<ImportReason, string> = {
  metadata_unchanged: 'NTSB still lists the same file',
  same_archive: 'the downloaded file is identical to the current one',
  same_content: 'the downloaded file has the same content as the current one',
  source_listing_changed: 'NTSB’s download listing is not in the expected form',
  source_reissued: 'NTSB changed the file without giving it a newer date',
  source_changed_during_download: 'the file changed while it was downloading',
  source_unavailable: 'NTSB or the app could not be reached',
  source_retired: 'the NTSB download the importer uses has been retired',
  baseline_required: `the importer has no reviewed starting point for this file (NTSB’s files are more than ${IMPORT_LIMITS.sourceGapDays} days apart, or none was recorded)`,
  baseline_changed: 'the dataset the site serves changed outside the importer',
  schema: 'the file’s tables or columns are not as expected',
  integrity: 'a data integrity check failed',
  verification: 'the new data did not pass verification',
  cohort_bounds: 'the new file differs from the current data in a way the automatic checks do not accept',
  mapping: 'the way cases are classified changed',
  probe: 'the new search indexes did not pass their checks',
  import_cap: `this file’s $${IMPORT_LIMITS.capUsd.toFixed(2)} cost limit was reached`,
  monthly_budget: 'this month’s budget does not cover it',
  cache_miss: 'it needs text embeddings that are not cached',
  restore_hold: 'a database restore is waiting for review',
  accounting: 'its cost records need reconciling',
  storage: 'the importer hit a storage limit or its free-space reserve',
  alias_unknown: 'the switch of the search indexes is in an unknown state',
  busy: 'another import or a backup was running',
  backup_window: 'it was the nightly backup window',
  lock_lost: 'it lost the lock that lets one run work at a time',
  timeout: `it ran past its ${IMPORT_LIMITS.deadlineHours}-hour limit`,
  interrupted: 'it stopped unexpectedly',
  dev_failed: 'the dev check failed',
  configuration: 'the importer’s configuration needs attention',
  cleanup: 'its temporary files or containers could not be cleaned up',
};

/** Reason words that depend on where the run stopped and how. */
const REASON_WORDS_FOR = {
  /** At the site checks after the switch, the live site failed them, not the candidate indexes. */
  probeAfterSwitch: 'the live site did not pass its checks after the switch',
  /** A stop for review after the run stopped unexpectedly once too often. */
  interruptedTooOften: 'it stopped unexpectedly too many times',
} as const;

/** A run's reason in words, as it applies to that run. */
export function reasonWords(run: Pick<AdminImportRun, 'reason' | 'result' | 'step'>): string | null {
  if (run.reason === null) return null;
  if (run.reason === 'probe' && AFTER_SWITCH.has(run.step)) return REASON_WORDS_FOR.probeAfterSwitch;
  if (run.reason === 'interrupted' && run.result === 'needs_review') return REASON_WORDS_FOR.interruptedTooOften;
  return IMPORT_REASON_WORDS[run.reason];
}

/** What each result means, one plain sentence, said under the latest run unless it was a plain no-change or an import. */
export const IMPORT_RESULT_MEANINGS: Record<ImportResult, string> = {
  running: 'A run is in progress.',
  unchanged: 'The check found nothing new to import; the site keeps its data.',
  published: 'A new NTSB snapshot was imported and now serves.',
  needs_review: 'The run stopped and waits for an operator’s review; nothing new is imported until then.',
  deferred: 'The run was postponed; the next daily check tries again.',
  failed: 'The run failed; the next daily check tries again, within its retry limit.',
  skipped_dev_failed: 'Live was skipped because the dev check failed; live keeps its data.',
  cancelled: 'The run was cancelled before it finished.',
  rolled_back: 'An operator rolled the import back; the previous dataset serves again.',
};

/** Meanings that depend on the run: a stop after the switch, and a daily run an open review blocks. */
export const RUN_MEANINGS = {
  stoppedAfterSwitch: 'The run stopped after the switch to the new data; an operator should check the site and roll it back if needed.',
  blocked: 'Each daily run waits until the open review is resolved.',
} as const;

/** The step a run reached, as the recent runs say it. */
export const IMPORT_STEP_WORDS: Record<ImportStep, string> = {
  check: 'Source check',
  acquire: 'Download',
  extract: 'Extraction',
  load: 'Load',
  verify: 'Verification',
  plan: 'Indexing plan',
  index_cases: 'Case index',
  index_passages: 'Passage index',
  validate: 'Validation',
  publish: 'Publication',
  canary: 'Site checks',
  cleanup: 'Cleanup',
  complete: 'Complete',
};

export const IMPORT_MODE_WORDS: Record<AdminImportRun['mode'], string> = {
  automatic: 'Automatic',
  forced_dev: 'Forced (dev)',
};

/** "1 Oct 2026": the date NTSB advertises for the run's file, as NTSB gives it (no time zone), or null. */
export function advertisedDate(run: AdminImportRun): string | null {
  return run.source ? formatDate(run.source.advertisedAtLocal.slice(0, 10)) : null;
}

/** Whether the run stopped at or after the switch to the new data (which may then already serve). */
export function afterSwitch(run: AdminImportRun): boolean {
  return AFTER_SWITCH.has(run.step);
}

/** Whether the run is a daily run an open review blocked: postponed, with the review's reason rather than a temporary one. */
export function isBlocked(run: AdminImportRun, imports: AdminImports): boolean {
  return (
    imports.attentionRequired &&
    run.result === 'deferred' &&
    run.reason !== null &&
    !TEMPORARY_REASONS.has(run.reason) &&
    run.reason !== 'configuration' &&
    run.reason !== 'alias_unknown'
  );
}

/** The step a run reached in words, or null for one refused before it started any work. */
export function stepWords(run: AdminImportRun): string | null {
  return run.result === 'deferred' && run.reason !== null && NEVER_STARTED.has(run.reason) ? null : IMPORT_STEP_WORDS[run.step];
}

/** The reason's clause after a lead ("Postponed: another import or a backup was running"), or the lead alone. */
function led(lead: string, run: AdminImportRun): string {
  const words = reasonWords(run);
  return words === null ? lead : `${lead}: ${words}`;
}

/**
 * A run's outcome in words: "No new file (NTSB still lists the 1 Oct 2026 file)", "File
 * re-downloaded: identical", "Imported generation 8", "Postponed: another import or a backup was
 * running", "Blocked: an earlier run is waiting for review", "Live skipped: the dev check failed",
 * "Stopped for review: …".
 */
export function importOutcome(run: AdminImportRun, imports: AdminImports): string {
  switch (run.result) {
    case 'running':
      return `Running (${IMPORT_STEP_WORDS[run.step].toLowerCase()})`;
    case 'unchanged': {
      if (run.reason === 'metadata_unchanged') {
        const file = advertisedDate(run);
        return file ? `No new file (NTSB still lists the ${file} file)` : 'No new file';
      }
      if (run.reason === 'same_archive') return 'File re-downloaded: identical';
      if (run.reason === 'same_content') return 'File re-downloaded: the same content, repackaged';
      return 'No change';
    }
    case 'published':
      return run.generationId === null ? 'Imported a new snapshot' : `Imported generation ${run.generationId}`;
    case 'needs_review':
      return led('Stopped for review', run);
    case 'deferred':
      return isBlocked(run, imports) ? 'Blocked: an earlier run is waiting for review' : led('Postponed', run);
    case 'failed':
      return led('Failed', run);
    case 'skipped_dev_failed':
      return 'Live skipped: the dev check failed';
    case 'cancelled':
      return led('Cancelled', run);
    case 'rolled_back':
      return 'Rolled back: the previous dataset serves again';
  }
}

/** What the run's result means, when the outcome alone does not say it (anything but a run in progress, no change or an import). */
export function runMeaning(run: AdminImportRun, imports: AdminImports): string | null {
  if (run.result === 'running' || run.result === 'unchanged' || run.result === 'published') return null;
  if (run.result === 'needs_review' && afterSwitch(run)) return RUN_MEANINGS.stoppedAfterSwitch;
  if (isBlocked(run, imports)) return RUN_MEANINGS.blocked;
  return IMPORT_RESULT_MEANINGS[run.result];
}

/** The identifiers behind a run's outcome, for its secondary code line: "needs_review · cohort_bounds". */
export function importCode(run: AdminImportRun): string {
  return run.reason === null ? run.result : `${run.result} · ${run.reason}`;
}

/** The runs as the page lists them: newest first, at most 20 (as the server sends them). */
export function recentRuns(imports: AdminImports): AdminImportRun[] {
  return [...imports.recentRuns].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).slice(0, 20);
}

/**
 * What a review needs, by its kind (docs/IMPORTER.md):
 * - `comparison`: a named comparison review of a downloaded file (approve an exception, or abandon the file);
 * - `candidate`: any other review of a downloaded file before the switch (abandon the file);
 * - `after_switch`: a stop at or after the switch (the new data may serve: check, roll back if needed);
 * - `preartifact`: a stop before any file was downloaded (acknowledge it once fixed, or rebaseline);
 * - `retired`: NTSB's download is retired, so every daily run stops (turn the timer off, acknowledge);
 * - `restore`: a database restore or cost records to reconcile (docs/RUNBOOK.md only);
 * - `unexplained`: an open review that no listed run explains (a restore latch, an uncertain cost
 *   record or index switch, a failed re-certification, a stuck run);
 * - `unreadable`: no runs and no completed check at all: the status could not be read, or a fresh
 *   database's restore latch.
 */
export type AttentionKind = 'comparison' | 'candidate' | 'after_switch' | 'preartifact' | 'retired' | 'restore' | 'unexplained' | 'unreadable';

export interface Attention {
  kind: AttentionKind;
  /** The run that stopped for review, when one is listed and nothing completed after it. */
  stopped: AdminImportRun | null;
  /** A daily run the review blocks, when the stopped run itself is no longer listed. */
  blocked: AdminImportRun | null;
}

/** The kind of review a run's stop needs. */
function kindOf(run: AdminImportRun): AttentionKind {
  const reason = run.reason;
  if (reason !== null && RESTORE_REVIEWS.has(reason)) return 'restore';
  if (reason === 'source_retired') return 'retired';
  if (afterSwitch(run)) return 'after_switch';
  if (run.archiveSha256 === null) return 'preartifact';
  if (reason !== null && COMPARISON_REVIEWS.has(reason)) return 'comparison';
  return 'candidate';
}

/**
 * What the attention notice names: the newest run that stopped for review with nothing completed
 * after it (a later completed check means that review was resolved), or else a daily run it still
 * blocks; and the kind of review it needs. Null while no attention is required.
 */
export function attentionOf(imports: AdminImports): Attention | null {
  if (!imports.attentionRequired) return null;
  const runs = recentRuns(imports);
  if (runs.length === 0 && imports.lastCheck === null) return { kind: 'unreadable', stopped: null, blocked: null };
  const completed = runs.findIndex((r) => r.result === 'unchanged' || r.result === 'published');
  const open = completed < 0 ? runs : runs.slice(0, completed);
  const stopped = open.find((r) => r.result === 'needs_review') ?? null;
  if (stopped) return { kind: kindOf(stopped), stopped, blocked: null };
  const blocked = open.find((r) => isBlocked(r, imports)) ?? null;
  if (blocked) return { kind: kindOf(blocked), stopped: null, blocked };
  return { kind: 'unexplained', stopped: null, blocked: null };
}

/** The attention and overdue notices' copy. */
export const IMPORT_COPY = {
  /** At the head of the page, linking to the notice under System. */
  pointerAttention: 'The automatic import needs a review.',
  pointerOverdue: 'The daily snapshot check is overdue.',
  attentionTitle: 'Import needs a review',
  /** The stopped run: "On 31 Oct 2026, a run stopped for review: …". */
  stopped: (date: string, reason: string) => `On ${date}, a run stopped for review: ${reason}.`,
  stoppedAfterSwitch: (date: string, reason: string) => `On ${date}, a run stopped after the switch to the new data: ${reason}.`,
  /** The stopped run is no longer listed; a daily run it blocks is. */
  blocked: (reason: string) => `Daily runs are waiting for an earlier review: ${reason}.`,
  beforeSwitch: (generation: number | null) =>
    generation === null ? 'Nothing new is imported until it is resolved.' : `Nothing new is imported until it is resolved; the site keeps serving generation ${generation}, the dataset above.`,
  mayBeLive: (generation: number | null) =>
    `The new data may already be live: the site serves ${generation === null ? 'the dataset above' : `generation ${generation}, the dataset above`}. An operator should check it and roll it back if needed.`,
  retiredServing: (generation: number | null) =>
    `Automatic imports have ended${generation === null ? '' : `; the site keeps serving generation ${generation}, the dataset above`}.`,
  unexplained: 'The importer reports an open review that no listed run explains: a database restore, an uncertain cost record or index switch, a failed re-certification, or a stuck run.',
  unreadable: 'The importer’s status could not be read, or a database restore waits for its review.',
  /** How to resolve it, by kind: where to read, then the commands, each on a line of its own. */
  how: {
    comparison: 'How to resolve it: docs/IMPORTER.md, “Configuration and operator commands”: approve the named exception, then run again; or abandon the file, “Free re-certification and baseline recovery”.',
    candidate: 'How to resolve it: docs/IMPORTER.md, “Free re-certification and baseline recovery”: review the private reports, then abandon the file.',
    after_switch: 'How to resolve it: docs/IMPORTER.md, “Configuration and operator commands”: check the site and roll back if needed; then adopt the data that serves, “Free re-certification and baseline recovery”.',
    preartifact: 'How to resolve it: docs/IMPORTER.md, “Acknowledge a proved pre-artifact setup failure”, once the cause is fixed; or “Free re-certification and baseline recovery”.',
    retired: 'How to resolve it: turn the daily check off, docs/IMPORTER.md, “Installation gate”; then acknowledge the stopped run, “Acknowledge a proved pre-artifact setup failure”. A new source needs its own reviewed adapter.',
    restore: 'How to resolve it: docs/RUNBOOK.md, “Paid operations after a restore”; the importer’s own commands cannot clear it.',
    unexplained: 'How to resolve it: docs/IMPORTER.md, “Free re-certification and baseline recovery”; after a database restore, docs/RUNBOOK.md, “Paid operations after a restore”.',
    unreadable: 'After a database restore: docs/RUNBOOK.md, “Paid operations after a restore”. Otherwise reload the page; if it persists, the app’s logs say why.',
  } satisfies Record<AttentionKind, string>,
  commands: {
    comparison: ['pnpm importer approve', 'pnpm importer rebaseline'],
    candidate: ['pnpm importer rebaseline'],
    after_switch: ['pnpm importer rollback', 'pnpm importer rebaseline'],
    preartifact: ['pnpm importer acknowledge-preartifact', 'pnpm importer rebaseline'],
    retired: ['systemctl --user disable --now aircase-importer.timer', 'pnpm importer acknowledge-preartifact'],
    restore: [],
    unexplained: [],
    unreadable: [],
  } satisfies Record<AttentionKind, readonly string[]>,
  overdueTitle: 'The daily snapshot check is overdue',
  overdueText: `No check has completed for over ${IMPORT_LIMITS.overdueHours} hours.`,
  /** Both flags, and the review explains it. */
  overdueReview: `No check has completed for over ${IMPORT_LIMITS.overdueHours} hours: the daily runs wait for the open review, above.`,
  overdueUnreadable: `No check has completed for over ${IMPORT_LIMITS.overdueHours} hours, or the importer’s status could not be read.`,
  overdueLast: 'Last completed check:',
  overdueNever: 'No check has completed yet.',
  overdueHow: 'The importer’s journal says why:',
  overdueCommand: 'journalctl --user -u aircase-importer.service',
  schedule: (localTime: string, timeZone: string) => `Daily at ${localTime}, ${timeZone}`,
  off: 'Off',
  notKnown: 'Not known',
  noneYet: 'None yet',
  /** The last completed check when it is the latest run itself. */
  sameAsLatest: 'The latest run, above',
  notStarted: 'Not started',
  noFile: 'No file',
  /** The last successful import's second line: the NTSB file's date, the generation, the cost. */
  imported: (file: string | null, generation: number | null, cost: string) =>
    [file ? `NTSB file of ${file}` : null, generation === null ? null : `generation ${generation}`, `cost ${cost}`].filter((part) => part !== null).join(' · '),
  runsTitle: 'Recent runs',
  runsIntro: (zone: string) => `Newest first. Times are in your time zone, ${zone}. File cost is the file’s total so far, across its attempts.`,
  runsCaption: 'Recent import runs, newest first',
  noRuns: 'No runs yet.',
} as const;
