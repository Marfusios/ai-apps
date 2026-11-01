/**
 * How the admin page says the automatic NTSB importer's status (`system.imports`, UI_DESIGN §4.12,
 * Task 26; docs/IMPORTER.md): every result, reason, step and mode in plain words, so no identifier
 * shows raw (they appear only on a secondary code line, as the ranking's does), and what an open
 * review needs, by its kind, with the documentation and the documented commands that resolve it.
 * The source's advertised date is NTSB's own, given with no time zone, and stays a date with none.
 * Builder copy for the owner's review.
 *
 * What the server sends (worker/importer/status.ts, the status rows of migration 0028):
 * - `lastCheck` is the newest *completed* check, an unchanged or published run (stops,
 *   postponements, failures and failed re-checks never refresh it); a successful re-certification
 *   can be it, though the runs never list one;
 * - the runs are newest first, at most 20; a run's cost is its file's running total, and 0 for a run
 *   linked to no file;
 * - a daily run an open review blocks is recorded as postponed with that review's reason;
 * - a failed re-certification of the serving data is recorded as postponed with the failure's own
 *   reason, on the serving file, and keeps attention on until a later re-certification succeeds;
 * - a rollback turns the stopped run into a rolled-back one, and the review stays open until the
 *   data that serves is adopted.
 *
 * The kind of an open review is inferred from the newest listed run that explains it. Where that is
 * not certain (the stop has left the list, or the reason has more than one remedy), the notice is
 * neutral: accurate but general, and it suggests no command.
 */
import type { AdminImportRun, AdminImports, IMPORT_REASONS, IMPORT_RESULTS, IMPORT_STEPS } from '../../../../shared/contracts/admin';
import { formatDate } from '../../../../shared/format';

export type ImportReason = (typeof IMPORT_REASONS)[number];
export type ImportResult = (typeof IMPORT_RESULTS)[number];
export type ImportStep = (typeof IMPORT_STEPS)[number];
export type ImportEnvironment = 'dev' | 'live';

/** The importer's limits the copy names (tied to the worker's own values by tests/web/import-words.test.ts). */
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

/** The reasons a run is postponed for and simply tries again (the worker's temporary reasons, worker/importer/contracts.ts). */
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

/** The steps at and after the switch to the new data: a stop there may already have published it. */
const AFTER_SWITCH: ReadonlySet<ImportStep> = new Set<ImportStep>(['publish', 'canary', 'cleanup']);

/** Reasons a run is refused for before it starts any work: it reached no step. */
const NEVER_STARTED: ReadonlySet<ImportReason> = new Set<ImportReason>(['busy', 'backup_window']);

/** The reviews a named, approved exception can accept (docs/IMPORTER.md, the `approve` command). */
const COMPARISON_REVIEWS: ReadonlySet<ImportReason> = new Set<ImportReason>(['cohort_bounds', 'source_reissued', 'baseline_required']);

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
  /** At the site checks, the live site failed them, not candidate indexes. */
  probeAtSiteChecks: 'the live site did not pass its checks',
  /** A stop for review after the run stopped unexpectedly once too often. */
  interruptedTooOften: 'it stopped unexpectedly too many times',
} as const;

/** A run's reason in words, as it applies to that run. */
export function reasonWords(run: Pick<AdminImportRun, 'reason' | 'result' | 'step'>): string | null {
  if (run.reason === null) return null;
  if (run.reason === 'probe' && run.step === 'canary') return REASON_WORDS_FOR.probeAtSiteChecks;
  if (run.reason === 'interrupted' && run.result === 'needs_review') return REASON_WORDS_FOR.interruptedTooOften;
  return IMPORT_REASON_WORDS[run.reason];
}

/** What each result means, one plain sentence, said under the latest listed run unless it found nothing new or imported a file. */
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

/** Meanings that depend on the run. */
export const RUN_MEANINGS = {
  stoppedAfterSwitch: 'The run stopped after the switch to the new data, which may already be live.',
  blocked: 'Each daily run waits until the open review is resolved.',
  recertification: 'Nothing changed on the site; the re-check runs again with the next daily check, or by hand once the cause is fixed.',
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

/** The step a run reached in words, or null for one refused before it started any work. */
export function stepWords(run: AdminImportRun): string | null {
  return run.result === 'deferred' && run.reason !== null && NEVER_STARTED.has(run.reason) ? null : IMPORT_STEP_WORDS[run.step];
}

/**
 * What an open review needs, by its kind (docs/IMPORTER.md):
 * - `comparison`: a named comparison review of a downloaded file (approve an exception, or abandon the file);
 * - `candidate`: any other review of a downloaded file before the switch (abandon the file);
 * - `after_switch`: a stop at or after the publication, whose switch may have committed (roll back, then rebaseline);
 * - `rolled_back`: a rolled-back publication whose data still awaits adoption (rebaseline);
 * - `recertification`: a failed re-check of the serving data (fix the cause, re-certify);
 * - `preartifact`: a stop before any file was downloaded (acknowledge it once fixed, or rebaseline);
 * - `retired`: NTSB's download is retired, so every daily run stops (turn the schedule off, acknowledge);
 * - `restore`: a database restore holds paid operations and latches the importer (RUNBOOK, then a
 *   reviewed importer reconciliation; no importer command);
 * - `neutral`: no listed run explains it with certainty (the stop has left the list, a cost-record
 *   stop has more than one remedy, a cause no run shows): the latest listed run, and the recovery
 *   sections, with no command;
 * - `unreadable`: no runs and no completed check at all: the status could not be read, or a fresh
 *   database's restore latch.
 */
export type AttentionKind = 'comparison' | 'candidate' | 'after_switch' | 'rolled_back' | 'recertification' | 'preartifact' | 'retired' | 'restore' | 'neutral' | 'unreadable';

export interface Attention {
  kind: AttentionKind;
  /** The run that explains the review, or, for the neutral notice, the latest listed run (null: none). */
  run: AdminImportRun | null;
}

/** The importer's status as the page reads it: the runs, the serving file, and what an open review needs. */
export interface ImportView {
  imports: AdminImports;
  /** Newest first, at most 20. */
  runs: AdminImportRun[];
  /** The digest of the file the accepted data came from (the last completed check's, or the last import's). */
  serving: string | null;
  /** The newest listed stop for review (or its rolled-back run) that nothing completed after (null: none listed). */
  stop: AdminImportRun | null;
  attention: Attention | null;
}

/** Whether `run` completed a check: found nothing new, or imported a file. */
const completed = (run: AdminImportRun): boolean => run.result === 'unchanged' || run.result === 'published';

/** Whether `run` is a failed re-check of the serving data (a re-certification): postponed, on the serving file. */
function isRecertification(run: AdminImportRun, serving: string | null): boolean {
  return run.result === 'deferred' && serving !== null && run.archiveSha256 === serving && run.reason !== null;
}

/** The kind of review a stop needs. */
function kindOf(stop: AdminImportRun): AttentionKind {
  if (stop.result === 'rolled_back') return 'rolled_back';
  const reason = stop.reason;
  if (reason === 'restore_hold') return 'restore';
  // A cost-record stop follows a restore (the RUNBOOK first) or a file's 89 days (rebaseline): not one remedy.
  if (reason === 'accounting') return 'neutral';
  if (reason === 'source_retired') return 'retired';
  if (AFTER_SWITCH.has(stop.step)) return 'after_switch';
  if (stop.archiveSha256 === null) return 'preartifact';
  if (reason !== null && COMPARISON_REVIEWS.has(reason)) return 'comparison';
  return 'candidate';
}

/** The importer's status as the page reads it (see `ImportView`). */
export function importView(imports: AdminImports): ImportView {
  const runs = [...imports.recentRuns].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).slice(0, 20);
  const serving = imports.lastCheck?.archiveSha256 ?? imports.lastSuccessfulImport?.archiveSha256 ?? null;
  // A completed check, listed or not (a successful re-certification is never listed), closes what came before it.
  const completedAt = imports.lastCheck?.checkedAt ?? '';
  let stop: AdminImportRun | null = null;
  let explaining: AdminImportRun | null = null;
  for (const run of runs) {
    if (completed(run) || run.checkedAt <= completedAt) break;
    if (isRecertification(run, serving) || run.result === 'needs_review' || run.result === 'rolled_back') {
      explaining = run;
      if (run.result === 'needs_review' || run.result === 'rolled_back') stop = run;
      break;
    }
  }
  let attention: Attention | null = null;
  if (imports.attentionRequired) {
    if (runs.length === 0 && imports.lastCheck === null) attention = { kind: 'unreadable', run: null };
    else if (explaining === null) attention = { kind: 'neutral', run: runs[0] ?? null };
    else if (isRecertification(explaining, serving)) attention = { kind: 'recertification', run: explaining };
    else {
      const kind = kindOf(explaining);
      attention = { kind, run: kind === 'neutral' ? (runs[0] ?? null) : explaining };
    }
  }
  return { imports, runs, serving, stop, attention };
}

/** Whether `run` is a daily run the open stop blocks: postponed after it, with its reason. */
export function isBlocked(run: AdminImportRun, view: ImportView): boolean {
  const stop = view.stop;
  return run.result === 'deferred' && stop !== null && run.checkedAt > stop.checkedAt && run.reason === stop.reason && !isRecertification(run, view.serving);
}

/** The reason's clause after a lead ("Postponed: another import or a backup was running"), or the lead alone. */
function led(lead: string, run: AdminImportRun): string {
  const words = reasonWords(run);
  return words === null ? lead : `${lead}: ${words}`;
}

/**
 * A run's outcome in words: "No new file (NTSB still lists the 1 Oct 2026 file)", "File
 * re-downloaded: identical", "Imported generation 8", "Postponed: another import or a backup was
 * running", "Blocked: an earlier run is waiting for review", "Re-check of the serving data failed:
 * …", "Live skipped: the dev check failed", "Stopped for review: …".
 */
export function importOutcome(run: AdminImportRun, view: ImportView): string {
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
      if (isRecertification(run, view.serving)) return led('Re-check of the serving data failed', run);
      return isBlocked(run, view) ? 'Blocked: an earlier run is waiting for review' : led('Postponed', run);
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
export function runMeaning(run: AdminImportRun, view: ImportView): string | null {
  if (run.result === 'running' || completed(run)) return null;
  if (run.result === 'needs_review' && AFTER_SWITCH.has(run.step)) return RUN_MEANINGS.stoppedAfterSwitch;
  if (isRecertification(run, view.serving)) return RUN_MEANINGS.recertification;
  if (isBlocked(run, view)) return RUN_MEANINGS.blocked;
  return IMPORT_RESULT_MEANINGS[run.result];
}

/** What a run's file cost shows: its file's total so far, or why there is none (no file; no work on it). */
export function fileCost(run: AdminImportRun, view: ImportView): { usd: number } | { none: string } {
  if (run.archiveSha256 === null) return { none: IMPORT_COPY.noFile };
  if (completed(run) && run.result !== 'published') return { none: IMPORT_COPY.noWork };
  if (isRecertification(run, view.serving)) return { none: IMPORT_COPY.noWork };
  return { usd: run.costUsd };
}

/** The identifiers behind a run's outcome, for its secondary code line: "needs_review · cohort_bounds". */
export function importCode(run: AdminImportRun): string {
  return run.reason === null ? run.result : `${run.result} · ${run.reason}`;
}

/** A command an operator runs, as docs/IMPORTER.md gives it, with placeholders for the operator's own paths and digests. */
export interface ImportCommand {
  command: string;
  /** What to know before running it. */
  note?: string;
}

/** The documented commands that resolve a kind of review, for the page's environment. */
export function importCommands(kind: AttentionKind, environment: ImportEnvironment): ImportCommand[] {
  const base = `--config <importer.json> --env ${environment}`;
  const rebaseline: ImportCommand = {
    command: `pnpm importer rebaseline ${base} --publication-sha256 <current-publication-sha256>`,
    note: IMPORT_COPY.dryRun,
  };
  const acknowledge: ImportCommand = {
    command: `pnpm importer acknowledge-preartifact ${base} --run <run-uuid> --evidence-sha256 <evidence-sha256>`,
    note: IMPORT_COPY.dryRun,
  };
  switch (kind) {
    case 'comparison':
      return [{ command: `pnpm importer approve ${base} --artifact <archive-sha256> --approval <approval.json>` }, { command: `pnpm importer run ${base}` }, rebaseline];
    case 'candidate':
    case 'rolled_back':
      return [rebaseline];
    case 'after_switch':
      return [{ command: `pnpm importer rollback ${base} --artifact <archive-sha256> --publication-sha256 <publication-sha256>` }, rebaseline];
    case 'recertification':
      return [{ command: `pnpm importer recertify ${base}` }];
    case 'preartifact':
      return [acknowledge, rebaseline];
    case 'retired':
      return [{ command: 'systemctl --user disable --now aircase-importer.timer' }, { command: 'systemctl --user stop aircase-importer.service' }, acknowledge];
    case 'restore':
    case 'neutral':
    case 'unreadable':
      return [];
  }
}

/** The attention and overdue notices' copy. */
export const IMPORT_COPY = {
  /** At the head of the page, linking to the notice under System. */
  pointerAttention: 'The automatic import needs a review.',
  pointerOverdue: 'The daily snapshot check is overdue.',
  attentionTitle: 'Import needs a review',
  /** The run that explains the review: "On 31 Oct 2026, a run stopped for review: …". */
  stopped: (date: string, reason: string) => `On ${date}, a run stopped for review: ${reason}.`,
  stoppedAfterSwitch: (date: string, reason: string) => `On ${date}, a run stopped after the switch to the new data: ${reason}.`,
  rolledBack: (date: string) => `On ${date}, a run’s new data was rolled back; the review stays open until the data that serves is adopted.`,
  recertificationFailed: (date: string, reason: string) => `On ${date}, the re-check of the serving data failed: ${reason}.`,
  /** No listed run explains it with certainty. */
  neutral: 'The importer reports an open review.',
  neutralLatest: (date: string, outcome: string) => `The latest listed run (${date}): ${outcome}.`,
  unreadable: 'The importer’s status could not be read, or a database restore waits for its review.',
  beforeSwitch: (generation: number | null) =>
    generation === null ? 'Nothing new is imported until it is resolved.' : `Nothing new is imported until it is resolved; the site keeps serving generation ${generation}, the dataset above.`,
  mayBeLive: (generation: number | null) => `The new data may already be live: the site serves ${generation === null ? 'the dataset above' : `generation ${generation}, the dataset above`}.`,
  nothingChanged: (generation: number | null) =>
    generation === null ? 'Nothing changed on the site.' : `Nothing changed on the site: it keeps serving generation ${generation}, the dataset above.`,
  retiredServing: (generation: number | null) => `Automatic imports have ended${generation === null ? '' : `; the site keeps serving generation ${generation}, the dataset above`}.`,
  /** How to resolve it, by kind: where to read, in the documentation's own words; the commands follow. */
  how: {
    comparison:
      'How to resolve it: approve the named exception, then run again (docs/IMPORTER.md, “Configuration and operator commands”); or abandon the file and keep the data that serves (“Free re-certification and baseline recovery”).',
    candidate: 'How to resolve it: review the private reports, then abandon the file and keep the data that serves (docs/IMPORTER.md, “Free re-certification and baseline recovery”).',
    after_switch:
      'How to resolve it: the importer clears a failed switch only by a rollback. Roll back, then adopt the previous data with rebaseline (docs/IMPORTER.md, “Configuration and operator commands” and “Free re-certification and baseline recovery”).',
    rolled_back: 'How to resolve it: adopt the data that now serves with rebaseline (docs/IMPORTER.md, “Free re-certification and baseline recovery”).',
    recertification: 'How to resolve it: fix the cause, then re-certify the serving data (docs/IMPORTER.md, “Free re-certification and baseline recovery”).',
    preartifact:
      'How to resolve it: once the cause is fixed, acknowledge the stopped run (docs/IMPORTER.md, “Acknowledge a proved pre-artifact setup failure”); a review before any download after a manual publication, a verifier upgrade or a corrected listing is resolved by rebaseline instead (“Free re-certification and baseline recovery”).',
    retired:
      'How to resolve it: turn the daily check off and stop the service (docs/IMPORTER.md, “Installation gate”); set the schedule’s enabled intent to false in the importer’s and the app’s configuration, and deploy it; then acknowledge each stopped run (“Acknowledge a proved pre-artifact setup failure”). A new source needs its own reviewed adapter.',
    restore:
      'How to resolve it: a restored database holds paid operations until its spend is reconciled (docs/RUNBOOK.md, “Paid operations after a restore”), and that reconciliation does not clear the importer’s own latch: a restore needs reviewed importer and accounting reconciliation before any further import, not an automated reset (docs/IMPORTER.md, “Money, isolation and recovery”).',
    neutral:
      'How to resolve it: docs/IMPORTER.md, “Configuration and operator commands”, “Free re-certification and baseline recovery” and “Acknowledge a proved pre-artifact setup failure”; after a database restore, docs/RUNBOOK.md, “Paid operations after a restore”.',
    unreadable: 'After a database restore: docs/RUNBOOK.md, “Paid operations after a restore”. Otherwise reload the page; if it persists, the app’s logs say why.',
  } satisfies Record<AttentionKind, string>,
  /** Under a command that only reports until it is repeated with `--apply`. */
  dryRun: 'A dry run: read its report, then repeat it with --apply.',
  overdueTitle: 'The daily snapshot check is overdue',
  overdueText: `No check has completed for over ${IMPORT_LIMITS.overdueHours} hours.`,
  /** Both flags, and a latched review explains it. */
  overdueReview: `No check has completed for over ${IMPORT_LIMITS.overdueHours} hours: the daily runs wait for the open review, above.`,
  /** Both flags, and the re-check of the serving data fails. */
  overdueRecertification: `No check has completed for over ${IMPORT_LIMITS.overdueHours} hours, because the re-check of the serving data fails, above.`,
  overdueUnreadable: `No check has completed for over ${IMPORT_LIMITS.overdueHours} hours, or the importer’s status could not be read.`,
  overdueLast: 'Last completed check:',
  overdueNever: 'No check has completed yet.',
  overdueHow: 'The importer’s journal says why:',
  overdueCommand: 'journalctl --user -u aircase-importer.service',
  schedule: (localTime: string, timeZone: string) => `Daily at ${localTime}, ${timeZone}`,
  off: 'Off',
  notKnown: 'Not known',
  noneYet: 'None yet',
  /** The last completed check when it is the latest listed run itself. */
  sameAsLatest: 'The latest listed run, above',
  notStarted: 'Not started',
  noFile: 'No file',
  noWork: 'No work on the file',
  /** The last successful import's second line: the NTSB file's date, the generation, the cost. */
  imported: (file: string | null, generation: number | null, cost: string) =>
    [file ? `NTSB file of ${file}` : null, generation === null ? null : `generation ${generation}`, `cost ${cost}`].filter((part) => part !== null).join(' · '),
  runsTitle: 'Recent runs',
  runsIntro: (zone: string) => `Newest first. Times are in your time zone, ${zone}. File cost is the file’s total so far, across its attempts.`,
  runsCaption: 'Recent import runs, newest first',
  noRuns: 'No runs yet.',
} as const;

/** The kinds whose review blocks the daily runs (a latched file or stop): the overdue notice says they wait for it. */
export const BLOCKING_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>(['comparison', 'candidate', 'after_switch', 'rolled_back', 'preartifact', 'retired', 'restore']);
