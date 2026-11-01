/**
 * The System section's "Automatic import" (UI_DESIGN §4.12, Task 26): the automatic NTSB snapshot
 * importer's status from `system.imports`, which is also its notification channel. A stop for
 * review comes first, with what to do (docs/IMPORTER.md), and so does a daily check that has not
 * succeeded for over 36 hours; neither shows while all is well. Then the schedule and the next
 * check, the last check and the last successful import, and the recent runs (a table, and on a
 * phone a list of blocks). Everything is in plain words (imports.ts); times are in the viewer's own
 * zone, named, and the NTSB file's advertised date is a date with no zone, as NTSB gives it.
 */
import type { ReactNode } from 'react';
import type { AdminImportRun, AdminImports, AdminOverview } from '../../../../shared/contracts/admin';
import { cx } from '../../lib/cx';
import { formatDateTime, formatUsd } from './format';
import {
  IMPORT_COPY,
  IMPORT_MODE_WORDS,
  IMPORT_REASON_WORDS,
  IMPORT_RESULT_MEANINGS,
  IMPORT_STEP_WORDS,
  advertisedDate,
  importCode,
  importOutcome,
  outcomeNeedsMeaning,
  recentRuns,
  reviewRun,
} from './imports';
import { Fact, Id } from './parts';

/** An instant in the viewer's zone, with the zone named: "1 Nov 2026, 05:30 (Europe/Prague)". */
function Zoned({ iso, timeZone }: { iso: string; timeZone: string }) {
  return (
    <span data-zoned="">
      <span className="whitespace-nowrap">{formatDateTime(iso, timeZone)}</span> <span className="whitespace-nowrap text-muted">({timeZone})</span>
    </span>
  );
}

const NOTICE_ID = { attention: 'admin-import-attention', overdue: 'admin-import-overdue' } as const;

/** A notice at the top of the block (an ink-edged box, as the AI notices): what needs doing, and how. */
function Notice({ kind, title, children }: { kind: 'attention' | 'overdue'; title: string; children: ReactNode }) {
  return (
    <div
      id={NOTICE_ID[kind]}
      tabIndex={-1}
      role="note"
      aria-label={title}
      className="card mb-3 scroll-mt-4 border-caution-edge border-l-4 border-l-ink px-3.5 py-3 text-left outline-none"
      data-import-notice={kind}
    >
      <p className="font-serif text-[16px] leading-tight font-semibold">{title}</p>
      <div className="mt-1 space-y-1 text-meta">{children}</div>
    </div>
  );
}

/** A command an operator runs, as code. */
function Command({ children }: { children: string }) {
  return <code className="font-mono text-label break-words">{children}</code>;
}

function Outcome({ run }: { run: AdminImportRun }) {
  return (
    <>
      <span className="block">{importOutcome(run)}</span>
      {outcomeNeedsMeaning(run) && <span className="block text-muted">{IMPORT_RESULT_MEANINGS[run.result]}</span>}
      <Id>{importCode(run)}</Id>
    </>
  );
}

/** The recent runs on a tablet or a desktop: a table. */
function RunsTable({ runs, timeZone }: { runs: readonly AdminImportRun[]; timeZone: string }) {
  const th = 'px-2 py-1.5 text-left text-micro font-bold tracking-caps text-muted uppercase first:pl-0 last:pr-0';
  return (
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full text-meta" data-import-runs-table="">
        <caption className="sr-only">{IMPORT_COPY.runsCaption}</caption>
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className={th}>
              Checked
            </th>
            <th scope="col" className={th}>
              Mode
            </th>
            <th scope="col" className={th}>
              Result
            </th>
            <th scope="col" className={th}>
              Reached
            </th>
            <th scope="col" className={cx(th, 'text-right')}>
              Cost
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={`${run.checkedAt}-${run.mode}`} className="border-b border-hairline align-top last:border-b-0">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal whitespace-nowrap text-ink">
                {formatDateTime(run.checkedAt, timeZone)}
              </th>
              <td className="px-2 py-1.5 whitespace-nowrap">{IMPORT_MODE_WORDS[run.mode]}</td>
              <td className="px-2 py-1.5 text-ink">{importOutcome(run)}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{IMPORT_STEP_WORDS[run.step]}</td>
              <td className="py-1.5 pl-2 text-right font-mono tabular-nums">{formatUsd(run.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** On a phone each run is a block of its own, in the table's order. */
function RunsList({ runs, timeZone }: { runs: readonly AdminImportRun[]; timeZone: string }) {
  return (
    <ul className="sm:hidden" aria-label={IMPORT_COPY.runsCaption} data-import-runs-list="">
      {runs.map((run) => (
        <li key={`${run.checkedAt}-${run.mode}`} className="border-t border-hairline py-2 text-meta first:border-t-0 first:pt-0">
          <p className="font-bold text-ink">
            {formatDateTime(run.checkedAt, timeZone)} <span className="font-normal text-muted">· {IMPORT_MODE_WORDS[run.mode]}</span>
          </p>
          <p className="text-ink">{importOutcome(run)}</p>
          <p className="text-muted">
            Reached: {IMPORT_STEP_WORDS[run.step]} · cost <span className="font-mono tabular-nums">{formatUsd(run.costUsd)}</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * At the head of the page, while the importer needs attention (a stop for review, an overdue check):
 * one line that says so and takes the reader to its notice in the System section, so the page's
 * notification cannot be missed at its foot. Nothing while all is well.
 */
export function ImportPointer({ imports }: { imports: AdminImports }) {
  const kinds = [...(imports.attentionRequired ? (['attention'] as const) : []), ...(imports.overdue ? (['overdue'] as const) : [])];
  if (kinds.length === 0) return null;
  return (
    <p className="card mb-3.5 border-caution-edge border-l-4 border-l-ink px-3.5 py-2 text-ui" data-import-pointer="" data-print="hide">
      {kinds.map((kind, i) => (
        <span key={kind}>
          {i > 0 && ' '}
          <a
            href={`#${NOTICE_ID[kind]}`}
            onClick={(event) => {
              // In the page, without a router navigation: the notice takes focus and scrolls into view.
              event.preventDefault();
              document.getElementById(NOTICE_ID[kind])?.focus();
            }}
            className="font-bold text-blue hover:underline"
          >
            {kind === 'attention' ? IMPORT_COPY.pointerAttention : IMPORT_COPY.pointerOverdue}
          </a>
        </span>
      ))}
    </p>
  );
}

export function ImportStatus({ imports, dataset, timeZone }: { imports: AdminImports; dataset: AdminOverview['system']['dataset']; timeZone: string }) {
  const schedule = imports.enabled ? imports.schedule : null;
  const review = imports.attentionRequired ? reviewRun(imports) : null;
  const last = imports.lastCheck;
  const success = imports.lastSuccessfulImport;
  const runs = recentRuns(imports);
  return (
    <div data-imports="">
      {imports.attentionRequired && (
        <Notice kind="attention" title={IMPORT_COPY.attentionTitle}>
          <p>
            {review?.reason ? IMPORT_COPY.attentionStopped(IMPORT_REASON_WORDS[review.reason]) : IMPORT_COPY.attentionUnknown}{' '}
            {IMPORT_COPY.attentionServing(dataset?.generationId ?? null)}
          </p>
          {review && <Id>{importCode(review)}</Id>}
          <p>
            {IMPORT_COPY.attentionHow} <Command>{IMPORT_COPY.attentionCommands}</Command>.
          </p>
        </Notice>
      )}
      {imports.overdue && (
        <Notice kind="overdue" title={IMPORT_COPY.overdueTitle}>
          <p>
            {IMPORT_COPY.overdueText}{' '}
            {last ? (
              <>
                {IMPORT_COPY.overdueLast} <Zoned iso={last.checkedAt} timeZone={timeZone} />.
              </>
            ) : (
              IMPORT_COPY.overdueNever
            )}
          </p>
          <p>
            {IMPORT_COPY.overdueHow} <Command>{IMPORT_COPY.overdueCommand}</Command>
          </p>
        </Notice>
      )}
      <dl className="mb-3">
        <Fact label="Schedule">{schedule ? IMPORT_COPY.schedule(schedule.localTime, schedule.timeZone) : IMPORT_COPY.off}</Fact>
        {schedule && (
          <Fact label="Next snapshot check">{schedule.nextCheckAt ? <Zoned iso={schedule.nextCheckAt} timeZone={timeZone} /> : IMPORT_COPY.notKnown}</Fact>
        )}
        <Fact label="Last check">
          {last ? (
            <>
              <Zoned iso={last.checkedAt} timeZone={timeZone} />
              <Outcome run={last} />
            </>
          ) : (
            IMPORT_COPY.noneYet
          )}
        </Fact>
        <Fact label="Last successful import">
          {success ? (
            <>
              <Zoned iso={success.finishedAt ?? success.checkedAt} timeZone={timeZone} />
              <span className="block">{IMPORT_COPY.imported(advertisedDate(success), success.generationId, formatUsd(success.costUsd))}</span>
            </>
          ) : (
            IMPORT_COPY.noneYet
          )}
        </Fact>
      </dl>
      <p className="text-micro font-bold tracking-caps text-muted uppercase">{IMPORT_COPY.runsTitle}</p>
      {runs.length === 0 ? (
        <p className="mt-1 text-meta text-muted">{IMPORT_COPY.noRuns}</p>
      ) : (
        <>
          <p className="mt-0.5 mb-1.5 text-label text-muted">{IMPORT_COPY.runsIntro(timeZone)}</p>
          <RunsTable runs={runs} timeZone={timeZone} />
          <RunsList runs={runs} timeZone={timeZone} />
        </>
      )}
    </div>
  );
}
