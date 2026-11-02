/** Server-owned health; the browser renders fixed words, never derives severity from recent runs. */
import { useEffect, useState } from 'react';
import type { AdminImports, AdminOverview } from '../../../../shared/contracts/admin';
import { cx } from '../../lib/cx';
import { Fact } from './parts';
import { formatDateTime, formatUsd } from './format';
import {
  alertDetails,
  alertSentences,
  chipLine,
  importOutcome,
  sourceDay,
  waitingWords,
  UNKNOWN_IMPORT_STATUS,
  type ImportEnvironment,
} from './imports';

const COPY_MESSAGES = {
  no: '',
  copied: 'Details copied.',
  failed: 'Copy did not work. Select the details and copy them.',
} as const;

export function ImportAlert({
  imports,
  environment,
  timeZone,
}: {
  imports: AdminImports;
  environment: ImportEnvironment;
  timeZone: string;
}) {
  const [copied, setCopied] = useState<'no' | 'copied' | 'failed'>('no');
  const alert = imports.alert;
  const details = alertDetails(imports, timeZone);
  useEffect(() => setCopied('no'), [details, alert]);
  if (!alert) return null;
  const fixed = alert.level === 'fix';
  return (
    <section
      role="note"
      aria-labelledby="admin-import-alert-title"
      data-import-alert={alert.level}
      className={cx(
        'card mb-3.5 border-l-4 px-3.5 py-3 text-left',
        fixed ? 'border-l-magenta bg-magenta-wash' : 'border-l-ink',
      )}
    >
      <h2
        id="admin-import-alert-title"
        className={cx('font-serif text-[18px] font-semibold', fixed && 'text-magenta')}
      >
        {fixed ? 'Automatic import needs a fix' : 'Automatic import is delayed'}
      </h2>
      <div className="mt-1 space-y-1 text-meta">
        {alertSentences(imports, environment, timeZone).map((sentence, i) => (
          <p key={i}>{sentence}</p>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-start gap-2 text-label">
        <code
          className="min-w-0 flex-1 select-text break-all font-mono text-muted"
          data-import-details=""
        >
          {copied === 'failed' ? details : alertDetails(imports, timeZone, true)}
        </code>
        <button
          type="button"
          className="shrink-0 rounded border border-hairline bg-blue-wash px-2 py-0.5 text-blue pointer-coarse:min-h-11"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(details);
              setCopied('copied');
            } catch {
              setCopied('failed');
            }
          }}
        >
          Copy details
        </button>
      </div>
      <p aria-live="polite" className="text-label text-muted">
        {COPY_MESSAGES[copied]}
      </p>
    </section>
  );
}
const LABEL = {
  off: 'Off',
  working: 'Working',
  delayed: 'Delayed',
  fix: 'Needs a fix',
} as const;
const CHIP_CLASSES = {
  off: 'border-hairline text-ink',
  working: 'border-blue bg-blue-wash text-blue',
  delayed: 'border-hairline text-ink',
  fix: 'border-magenta text-magenta',
} as const;

export function ImportStatus({
  imports,
  timeZone,
}: {
  imports: AdminImports;
  dataset: AdminOverview['system']['dataset'];
  environment: ImportEnvironment;
  timeZone: string;
}) {
  const { status, serving, alert, schedule } = imports;
  const last = alert ? imports.lastGoodCheck : imports.lastCheck;
  const unreadable = alert?.cause === 'status_unavailable';
  const time = (iso: string | null | undefined) =>
    iso ? `${formatDateTime(iso, timeZone)} (${timeZone})` : 'Not recorded';
  return (
    <div data-imports="">
      <p className="mb-2 text-meta">
        <span
          className={cx(
            'mr-2 inline-block rounded-chip border px-2 py-0.5 font-bold',
            CHIP_CLASSES[status],
          )}
        >
          {LABEL[status]}
        </span>
        {chipLine(imports, timeZone)}
      </p>
      {unreadable ? (
        <dl className="mb-3">
          {['Data on the site', 'Last good check', 'Waiting', 'Next check'].map(
            (label) => (
              <Fact key={label} label={label}>
                {UNKNOWN_IMPORT_STATUS}
              </Fact>
            ),
          )}
        </dl>
      ) : (
        <dl className="mb-3">
          <Fact label="Data on the site">
            {serving ? (
              <>
                {serving.sourceDate
                  ? `NTSB file of ${sourceDay(serving.sourceDate)}`
                  : 'File date not recorded'}
                <span className="block text-muted">
                  {serving.restoredAt ? 'Restored' : 'Imported'}{' '}
                  {time(serving.restoredAt ?? serving.importedAt)}
                </span>
              </>
            ) : (
              'Not recorded'
            )}
          </Fact>
          <Fact label={alert ? 'Last good check' : 'Last check'}>
            {last ? (
              <>
                {time(last.finishedAt ?? last.checkedAt)}
                <span className="block text-muted">{importOutcome(last)}</span>
              </>
            ) : (
              'No check recorded yet'
            )}
          </Fact>
          {imports.waiting && (
            <Fact label="Waiting">
              {imports.waiting.source
                ? `NTSB file of ${sourceDay(imports.waiting.source.advertisedAtLocal)}`
                : 'The next file'}
              <span className="block text-muted">
                {waitingWords(imports.waiting.reason)}
              </span>
            </Fact>
          )}
          <Fact label="Next check">
            {imports.enabled && schedule ? (
              <>
                {time(schedule.nextCheckAt)}
                <span className="block text-muted">
                  Every day at {schedule.localTime}, {schedule.timeZone}
                </span>
              </>
            ) : (
              'None'
            )}
          </Fact>
        </dl>
      )}
      <h4 className="text-micro font-bold tracking-caps text-muted uppercase">
        Recent runs
      </h4>
      <ul aria-label="Recent import runs" className="mt-1 text-meta">
        {imports.recentRuns.map((run, i) => (
          <li
            key={run.runId ?? `${run.checkedAt}-${i}`}
            className="grid grid-cols-[1fr_auto] gap-x-2 border-t border-hairline py-2 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]"
          >
            <time
              dateTime={run.checkedAt}
              className="col-span-2 text-label text-muted sm:col-span-1"
            >
              {formatDateTime(run.checkedAt, timeZone)}
            </time>
            <span
              className={
                [
                  'failed',
                  'deferred',
                  'needs_review',
                  'skipped_dev_failed',
                  'cancelled',
                ].includes(run.result)
                  ? 'text-magenta'
                  : undefined
              }
            >
              {importOutcome(run)}
            </span>
            <span className="text-right tabular-nums">
              {run.result === 'published' ? formatUsd(run.costUsd) : ''}
            </span>
          </li>
        ))}
      </ul>
      {imports.recentRuns.length === 0 && (
        <p className="mt-1 text-meta text-muted">
          {unreadable ? UNKNOWN_IMPORT_STATUS : 'No runs recorded yet.'}
        </p>
      )}
    </div>
  );
}
