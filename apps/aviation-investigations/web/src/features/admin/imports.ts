/**
 * How the admin page says the automatic NTSB importer's status (`system.imports`, UI_DESIGN §4.12,
 * Task 26; docs/IMPORTER.md): every result, reason, step and mode in plain words, so no identifier
 * shows raw (they appear only on a secondary code line, as the ranking's does). The source's
 * advertised date is NTSB's own, given with no time zone, and stays a date with none. Builder copy
 * for the owner's review.
 */
import type { AdminImportRun, AdminImports, IMPORT_REASONS, IMPORT_RESULTS, IMPORT_STEPS } from '../../../../shared/contracts/admin';
import { formatDate } from '../../../../shared/format';

export type ImportReason = (typeof IMPORT_REASONS)[number];
export type ImportResult = (typeof IMPORT_RESULTS)[number];
export type ImportStep = (typeof IMPORT_STEPS)[number];

export const IMPORT_COPY = {
  /** At the head of the page, linking to the notice under System. */
  pointerAttention: 'The automatic import needs a review.',
  pointerOverdue: 'The daily snapshot check is overdue.',
  attentionTitle: 'Import needs a review',
  attentionStopped: (reason: string) => `The last run stopped for review: ${reason}.`,
  /** An open review or uncertain state with no stopped run among those listed (or status that could not be read). */
  attentionUnknown: 'The importer reports an open review, or its status could not be read.',
  attentionServing: (generation: number | null) =>
    generation === null
      ? 'Nothing new is imported until an operator resolves it.'
      : `Nothing new is imported until an operator resolves it; the site keeps serving generation ${generation}, the dataset above.`,
  attentionHow: 'How to resolve it: docs/IMPORTER.md, “Free re-certification and baseline recovery”:',
  attentionCommands: 'pnpm importer approve, rebaseline or rollback',
  overdueTitle: 'The daily snapshot check is overdue',
  overdueText: 'It has not succeeded for over 36 hours.',
  overdueLast: 'Last successful check:',
  overdueNever: 'No snapshot check has succeeded yet.',
  overdueHow: 'The importer’s journal says why:',
  overdueCommand: 'journalctl --user -u aircase-importer.service',
  schedule: (localTime: string, timeZone: string) => `Daily at ${localTime}, ${timeZone}`,
  off: 'Off',
  notKnown: 'Not known',
  noneYet: 'None yet',
  /** The last successful import's second line: the NTSB file's date, the generation, the cost. */
  imported: (file: string | null, generation: number | null, cost: string) =>
    [file ? `NTSB file of ${file}` : null, generation === null ? null : `generation ${generation}`, `cost ${cost}`].filter((part) => part !== null).join(' · '),
  runsTitle: 'Recent runs',
  runsIntro: (zone: string) => `Newest first. Times are in your time zone, ${zone}.`,
  runsCaption: 'Recent import runs, newest first',
  noRuns: 'No runs yet.',
} as const;

/**
 * Each reason a run gives, as a clause that follows "Stopped for review:", "Postponed:", "Failed:"
 * or "Cancelled:" (docs/IMPORTER.md has what each means and how to resolve it).
 */
export const IMPORT_REASON_WORDS: Record<ImportReason, string> = {
  metadata_unchanged: 'NTSB still lists the same file',
  same_archive: 'the downloaded file is identical to the current one',
  same_content: 'the downloaded file has the same content as the current one',
  source_listing_changed: 'NTSB’s download page is not laid out as expected',
  source_reissued: 'NTSB changed the file without giving it a newer date',
  source_changed_during_download: 'the file changed while it was downloading',
  source_unavailable: 'NTSB or the app could not be reached',
  source_retired: 'the NTSB download the importer uses has been retired',
  baseline_required: 'more than 62 days passed between NTSB’s files, so the new one needs a full review',
  baseline_changed: 'the dataset the site serves changed outside the importer',
  schema: 'the file’s tables or columns are not as expected',
  integrity: 'a data integrity check failed',
  verification: 'the new data did not pass verification',
  cohort_bounds: 'the new file differs from the current data by more than the automatic limits allow',
  mapping: 'the way cases are classified changed',
  probe: 'the new search indexes did not pass their checks',
  import_cap: 'this file’s $0.50 cost limit was reached',
  monthly_budget: 'this month’s budget does not cover it',
  cache_miss: 'it needs text embeddings that are not cached',
  restore_hold: 'a database restore is waiting for review',
  accounting: 'its cost records need reconciling',
  storage: 'there is not enough disk space',
  alias_unknown: 'the switch of the search indexes is in an unknown state',
  busy: 'another import or a backup was running',
  backup_window: 'it was the nightly backup window',
  lock_lost: 'it lost its lock',
  timeout: 'it ran past its three-hour limit',
  interrupted: 'it was interrupted',
  dev_failed: 'the dev check failed',
  configuration: 'the importer’s configuration needs attention',
  cleanup: 'cleaning up after it did not finish',
};

/** What each result means, one plain sentence (said under the last check when it is not a plain no-change or import). */
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

/** The reason's clause after a lead ("Postponed: another import or a backup was running"), or the lead alone. */
function led(lead: string, reason: ImportReason | null): string {
  return reason === null ? lead : `${lead}: ${IMPORT_REASON_WORDS[reason]}`;
}

/**
 * A run's outcome in words: "No new file (NTSB still lists the 1 Oct 2026 file)", "File
 * re-downloaded: identical", "Imported generation 8", "Postponed: another import or a backup was
 * running", "Live skipped: the dev check failed", "Stopped for review: …".
 */
export function importOutcome(run: AdminImportRun): string {
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
      return led('Stopped for review', run.reason);
    case 'deferred':
      return led('Postponed', run.reason);
    case 'failed':
      return led('Failed', run.reason);
    case 'skipped_dev_failed':
      return 'Live skipped: the dev check failed';
    case 'cancelled':
      return led('Cancelled', run.reason);
    case 'rolled_back':
      return 'Rolled back: the previous dataset serves again';
  }
}

/** Whether the outcome needs its meaning said too: anything but a run in progress, no change or an import. */
export function outcomeNeedsMeaning(run: AdminImportRun): boolean {
  return run.result !== 'running' && run.result !== 'unchanged' && run.result !== 'published';
}

/** The identifiers behind a run's outcome, for its secondary code line: "needs_review · cohort_bounds". */
export function importCode(run: AdminImportRun): string {
  return run.reason === null ? run.result : `${run.result} · ${run.reason}`;
}

/** The run the attention notice names: the newest one that stopped for review, if any is listed. */
export function reviewRun(imports: AdminImports): AdminImportRun | null {
  const runs = [...imports.recentRuns, ...(imports.lastCheck ? [imports.lastCheck] : [])];
  return runs.filter((r) => r.result === 'needs_review').sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0] ?? null;
}

/** The runs as the page lists them: newest first, at most 20 (as the server sends them). */
export function recentRuns(imports: AdminImports): AdminImportRun[] {
  return [...imports.recentRuns].sort((a, b) => b.checkedAt.localeCompare(a.checkedAt)).slice(0, 20);
}
