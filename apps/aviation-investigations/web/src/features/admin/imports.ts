/** Fixed words only. Alert severity and retry decisions come from the server. */
import type { AdminImportRun, AdminImports } from '../../../../shared/contracts/admin.js';
import {
  DATA_CHECK_REASONS,
  TEMPORARY_REASONS,
} from '../../../../shared/import-policy.js';
import { formatDate } from '../../../../shared/format.js';
import { formatDateTime, formatDay } from './format.js';

export const IMPORT_LIMITS = {
  capUsd: 2,
  overdueHours: 36,
  deadlineHours: 3,
  delayedDays: 3,
  fixDays: 7,
} as const;
export type ImportEnvironment = 'dev' | 'live';
export const UNKNOWN_IMPORT_STATUS = 'Unknown: the status could not be read.';

/** The source's day has no timezone; do not shift it into the viewer's zone. */
export function sourceDay(date: string | null | undefined): string {
  return formatDate(date ?? null);
}

export function reasonWords(reason: AdminImportRun['reason']): string {
  switch (reason) {
    case 'schema':
      return 'The file’s tables or columns changed. AirCase cannot read it.';
    case 'shrunk':
      return 'The new file looks damaged: more than a tenth of its cases are missing. It was not put on this site.';
    case 'source_unavailable':
      return 'The NTSB download or the site did not answer.';
    case 'source_changed_during_download':
      return 'NTSB changed the file while it was downloading.';
    case 'monthly_budget':
      return 'This month’s OpenAI spending limit is used up.';
    case 'cache_miss':
      return 'The saved search data is not available yet.';
    case 'busy':
    case 'backup_window':
      return 'Another import or a backup was running.';
    case 'interrupted':
    case 'lock_lost':
    case 'timeout':
      return 'The import stopped before it finished.';
    case 'site_check':
    case 'probe':
      return 'The new data failed the site checks.';
    case 'rollback_failed':
    case 'alias_unknown':
      return 'The data switch could not be confirmed. The site may show mixed data.';
    case 'import_cap':
      return `This file would cost more than the $${IMPORT_LIMITS.capUsd.toFixed(2)} import limit.`;
    case 'source_retired':
      return 'NTSB stopped publishing this file. Automatic imports have ended.';
    case 'source_listing_changed':
      return 'The NTSB download page changed. AirCase cannot find the file.';
    case 'storage':
      return 'The server cannot safely save the import files. Check its disk space and permissions.';
    case 'cleanup':
      return 'The importer could not clean up its temporary files.';
    case 'restore_hold':
      return 'Imports are stopped until the restored spending records are checked.';
    case 'accounting':
      return 'The cost records for this file block more work.';
    case 'integrity':
    case 'verification':
    case 'mapping':
      return 'The file or search data failed an integrity check.';
    case 'configuration':
      return 'The importer’s settings need a fix.';
    case 'dev_failed':
      return 'The test copy of the site has not finished its checks.';
    case 'manual_rollback':
      return 'The site was returned to the previous data.';
    case 'post_success':
      return 'The import finished, but a later task did not finish.';
    case 'metadata_unchanged':
    case 'same_archive':
    case 'same_content':
      return 'No new file.';
    case 'baseline_changed':
      return 'The data on the site changed during the import.';
    case 'cohort_bounds':
    case 'source_reissued':
    case 'baseline_required':
      return 'An old review rule stopped it. This rule is gone.';
    default:
      return 'The import stopped with an unexpected error.';
  }
}

export function waitingWords(reason: AdminImportRun['reason']): string {
  if (reason === null) return 'Not imported yet';
  switch (reason) {
    case 'schema':
      return 'Not imported: AirCase can’t read it';
    case 'shrunk':
      return 'Not imported: it looks damaged';
    case 'site_check':
    case 'probe':
      return 'Not imported: it failed the site checks';
    case 'monthly_budget':
      return 'Not imported: this month’s spending limit is used up';
    default:
      return TEMPORARY_REASONS.has(reason)
        ? 'Not imported yet: the system tries again every day'
        : 'Not imported: it needs a fix';
  }
}

export function importOutcome(run: AdminImportRun): string {
  const day = sourceDay(run.source?.advertisedAtLocal);
  if (run.result === 'published') {
    const changes = run.changes
      ? `: ${run.changes.new.toLocaleString('en-US')} new cases, ${run.changes.updated.toLocaleString('en-US')} updated, ${run.changes.removed.toLocaleString('en-US')} removed`
      : '';
    return `Imported ${run.source ? `the ${day} file` : 'a new file'}${changes}`;
  }
  if (run.suppressed || run.result === 'waiting')
    return run.source
      ? `No new file. The ${day} file waits for a fix.`
      : 'Checked. Imports are on hold until a fix.';
  if (run.result === 'unchanged') return 'No new file.';
  if (run.result === 'running') return 'Import in progress.';
  if (
    run.workKind === 'recertification' &&
    run.reason &&
    DATA_CHECK_REASONS.has(run.reason)
  )
    return run.result === 'skipped_dev_failed'
      ? 'Held back by the test copy of the site: The data on the site failed the release checks.'
      : 'Failed: The data on the site failed the release checks.';
  if (run.result === 'skipped_dev_failed')
    return `Held back by the test copy of the site: ${reasonWords(run.reason)}`;
  if (run.result === 'rolled_back') return 'The site went back to the previous data.';
  return `Failed: ${reasonWords(run.reason)}`;
}

export function alertDetails(
  imports: AdminImports,
  zone: string,
  compact = false,
): string {
  const a = imports.alert;
  if (!a) return '';
  const r = a.details;
  const at = r?.checkedAt ?? a.since;
  return [
    r?.result,
    a.cause,
    ...a.holds.filter((h) => h !== a.cause),
    r?.reason !== a.cause ? r?.reason : null,
    r?.step,
    at ? `${formatDateTime(at, zone)} (${zone})` : null,
    r?.runId ? `run ${compact ? r.runId.slice(0, 8) : r.runId}` : null,
    r?.source ? `file ${sourceDay(r.source.advertisedAtLocal)}` : null,
    r?.code ? `code ${compact ? r.code.slice(0, 12) : r.code}` : null,
    r?.image ? `image ${compact ? r.image.slice(0, 19) : r.image}` : null,
    a.originRunId
      ? `dev run ${compact ? a.originRunId.slice(0, 8) : a.originRunId}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function chipLine(imports: AdminImports, zone: string): string {
  if (imports.status === 'off') return 'Automatic import is turned off.';
  if (imports.status === 'working') return 'Each new NTSB file goes in by itself.';
  const a = imports.alert;
  if (!a) return '';
  if (a.cause === 'status_unavailable') return 'The status could not be read.';
  if (!a.since) return 'Start date unknown.';
  if (a.cause === 'overdue') return `No check since ${formatDateTime(a.since, zone)}.`;
  const since = `Since ${formatDay(a.since, zone)}`;
  if (a.cause === 'monthly_budget')
    return `${since}. Continues on the 1st of next month.`;
  if (a.nextAction === 'daily') return `${since}, retrying daily.`;
  return `${since}.`;
}

export function alertSentences(
  imports: AdminImports,
  environment: ImportEnvironment,
  zone: string,
): string[] {
  const a = imports.alert;
  if (!a) return [];
  if (a.cause === 'status_unavailable')
    return [
      'AirCase cannot read the import status.',
      'Reload the page. If this stays, the server or its database needs a fix.',
      'The alert goes away when the status can be read again.',
    ];
  const lines: string[] = [];
  if (a.cause === 'overdue') {
    if (a.since)
      lines.push(
        `No import check has run since ${formatDateTime(a.since, zone)} (${zone}).`,
      );
    if (a.holds.length && !a.holds.includes('restore_hold'))
      lines.push('The schedule or server needs a fix.');
  } else {
    if (a.postSuccess) lines.push('The import finished. A later task needs attention.');
    if (a.origin === 'dev' && environment === 'live') {
      const fileFailed =
        !a.servingChecks &&
        a.nextAction !== 'daily' &&
        a.details?.source &&
        !a.postSuccess;
      lines.push(
        a.servingChecks
          ? 'The release checks failed in the test copy of the site (dev). Live was not touched.'
          : fileFailed
            ? 'The new file failed in the test copy of the site (dev). Live was not touched.'
            : 'The test copy of the site (dev) has not finished its checks. Live was not touched.',
      );
    }
    if (!a.postSuccess && !a.servingChecks && a.details?.source)
      lines.push(
        `The NTSB file of ${sourceDay(a.details.source.advertisedAtLocal)} is waiting.`,
      );
    if (
      a.cause !== 'manual_rollback' &&
      !(a.servingChecks && a.origin === 'dev' && environment === 'live')
    )
      lines.push(
        a.servingChecks
          ? 'The data on the site failed the release checks.'
          : reasonWords(a.cause),
      );
    if (a.failedDays >= IMPORT_LIMITS.delayedDays) {
      if (a.postSuccess)
        lines.push(`A later task failed on ${a.failedDays} different days.`);
      else
        lines.push(
          `Imports have failed on ${a.failedDays >= IMPORT_LIMITS.fixDays ? 'at least ' : ''}${a.failedDays} different days.`,
        );
    }
  }
  for (const hold of a.holds) if (hold !== a.cause) lines.push(reasonWords(hold));
  if (a.devAdvanced)
    lines.push('Dev has the new file. Live still has the previous file.');
  const source = imports.serving?.sourceDate;
  if (a.siteState === 'uncertain') {
    if (
      !['alias_unknown', 'rollback_failed'].includes(a.cause) &&
      !a.holds.some((h) => h === 'alias_unknown' || h === 'rollback_failed')
    )
      lines.push('The site may show mixed data.');
  } else if (a.siteState === 'restore_unverified') {
    lines.push(
      source
        ? `AirCase switched back to the data from ${sourceDay(source)}. Its site check has not passed yet.`
        : 'AirCase switched back to the previous data. Its site check has not passed yet.',
    );
  } else if (a.siteState === 'restored') {
    lines.push(
      source
        ? `The site went back to the data from ${sourceDay(source)}. The site checks passed.`
        : 'The site went back to the previous data. The site checks passed.',
    );
  } else {
    lines.push(
      source
        ? `The site still shows the data from the NTSB file of ${sourceDay(source)}.`
        : 'The file date of the data on the site is not recorded.',
    );
  }
  if (a.cause === 'overdue' && a.holds.length === 0)
    lines.push(
      'The schedule or server needs a fix. The alert goes away when checks run again.',
    );
  else if (a.siteState === 'uncertain')
    lines.push(
      'A release is needed before the system can try recovery. It will not switch data while the result is uncertain.',
    );
  else if (a.cause === 'monthly_budget')
    lines.push('The import continues on the 1st of next month.');
  else if (!a.postSuccess && ['storage', 'configuration', 'cleanup'].includes(a.cause))
    lines.push(
      a.nextAction === 'new_file_or_release'
        ? 'Fix the server, then release. The file is tried again after the release or when NTSB posts a newer file.'
        : 'Fix the server. The system tries again every day.',
    );
  else if (
    a.holds.includes('restore_hold') ||
    ['restore_hold', 'accounting'].includes(a.cause)
  )
    lines.push(
      'A person must check the cost records. The alert goes away after the next good import.',
    );
  else if (a.cause === 'source_retired')
    lines.push('A new NTSB source needs a code change.');
  else if (a.cause === 'source_listing_changed')
    lines.push(
      'This needs a code change. The system still checks every day, and this alert goes away after the first good import.',
    );
  else if (a.siteState === 'restore_unverified')
    lines.push('The system repeats the site check every day.');
  else if (
    a.nextAction === 'daily' &&
    a.level === 'fix' &&
    ![...TEMPORARY_REASONS].some((reason) => reason === a.cause) &&
    !a.postSuccess
  )
    lines.push('Fix the server. The system tries again every day.');
  else if (a.nextAction === 'daily')
    lines.push(
      a.level === 'fix'
        ? 'The system still tries every day. The server or service needs a fix.'
        : 'The system tries again every day. Nothing for you to do.',
    );
  else
    lines.push(
      'This needs a code change or a newer file. The system still checks every day. The alert goes away after a good import.',
    );
  return lines;
}
