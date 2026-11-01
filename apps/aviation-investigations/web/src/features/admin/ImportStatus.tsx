/**
 * The System section's "Automatic import" (UI_DESIGN §4.12, Task 26): the automatic NTSB snapshot
 * importer's status from `system.imports`, which is also its notification channel. An open review
 * comes first, saying what it means for the data that serves and how to resolve that kind of review
 * with the documented commands (docs/IMPORTER.md, docs/RUNBOOK.md), or, where its kind is not
 * certain, a neutral notice with no command; so does a daily check that has not completed for over
 * 36 hours; neither shows while all is well. Then the schedule and the next check, the latest listed
 * run, the last completed check and the last successful import, and the recent runs (a table where
 * there is room, else a list of blocks). Everything is in plain words (imports.ts); times are in the
 * viewer's own zone, named, and the NTSB file's advertised date is a date with no zone.
 */
import { Fragment, type ReactNode } from 'react';
import type { AdminImportRun, AdminImports, AdminOverview } from '../../../../shared/contracts/admin';
import { cx } from '../../lib/cx';
import { formatDateTime, formatDay, formatUsd } from './format';
import {
  BLOCKING_KINDS,
  IMPORT_COPY,
  IMPORT_MODE_WORDS,
  advertisedDate,
  fileCost,
  importCode,
  importCommands,
  importOutcome,
  importView,
  reasonWords,
  runMeaning,
  stepWords,
  type Attention,
  type ImportCommand,
  type ImportEnvironment,
  type ImportView,
} from './imports';
import { Fact, Id, Missing } from './parts';

/** A time zone name that may break after each "/" (a long one would not fit a phone's column). */
function ZoneName({ zone }: { zone: string }) {
  return (
    <>
      {zone.split('/').map((part, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              /<wbr />
            </>
          )}
          {part}
        </Fragment>
      ))}
    </>
  );
}

/** An instant in the viewer's zone, with the zone named: "1 Nov 2026, 05:30 (Europe/Prague)". */
function Zoned({ iso, timeZone }: { iso: string; timeZone: string }) {
  return (
    <span data-zoned="">
      <span className="whitespace-nowrap">{formatDateTime(iso, timeZone)}</span>{' '}
      <span className="text-muted">
        (<ZoneName zone={timeZone} />)
      </span>
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
      aria-labelledby={`${NOTICE_ID[kind]}-title`}
      className="card mb-3 scroll-mt-4 border-caution-edge border-l-4 border-l-ink px-3.5 py-3 text-left outline-none"
      data-import-notice={kind}
    >
      <h4 id={`${NOTICE_ID[kind]}-title`} className="font-serif text-[16px] leading-tight font-semibold">
        {title}
      </h4>
      <div className="mt-1 space-y-1 text-meta">{children}</div>
    </div>
  );
}

/**
 * Commands an operator runs, as docs/IMPORTER.md gives them, each on a line of its own (with what to
 * know before running it); a line wraps only between its words, never inside an option, and copies
 * as written. Angle brackets mark the operator's own paths and digests.
 */
function Commands({ commands }: { commands: readonly ImportCommand[] }) {
  if (commands.length === 0) return null;
  return (
    <div className="space-y-1" data-import-commands="">
      {commands.map(({ command, note }) => (
        <div key={command}>
          <code className="block font-mono text-label">
            {command.split(' ').map((word, i) => (
              <Fragment key={i}>
                {i > 0 && ' '}
                <span className="whitespace-nowrap">{word}</span>
              </Fragment>
            ))}
          </code>
          {note && <span className="block text-label text-muted">{note}</span>}
        </div>
      ))}
    </div>
  );
}

function AttentionNotice({ view, attention, generation, environment, timeZone }: { view: ImportView; attention: Attention; generation: number | null; environment: ImportEnvironment; timeZone: string }) {
  const run = attention.run;
  const date = run ? formatDay(run.checkedAt, timeZone) : '';
  const reason = run ? (reasonWords(run) ?? '') : '';
  const sentences: string[] = [];
  switch (attention.kind) {
    case 'unreadable':
      sentences.push(IMPORT_COPY.unreadable);
      break;
    case 'neutral':
      sentences.push(IMPORT_COPY.neutral);
      if (run) sentences.push(IMPORT_COPY.neutralLatest(date, importOutcome(run, view)));
      break;
    case 'recertification':
      sentences.push(IMPORT_COPY.recertificationFailed(date, reason), IMPORT_COPY.nothingChanged(generation));
      break;
    case 'after_switch':
      sentences.push(IMPORT_COPY.stoppedAfterSwitch(date, reason), IMPORT_COPY.mayBeLive(generation));
      break;
    case 'rolled_back':
      sentences.push(IMPORT_COPY.rolledBack(date));
      break;
    case 'retired':
      sentences.push(IMPORT_COPY.stopped(date, reason), IMPORT_COPY.retiredServing(generation));
      break;
    default:
      sentences.push(IMPORT_COPY.stopped(date, reason), IMPORT_COPY.beforeSwitch(generation));
  }
  return (
    <Notice kind="attention" title={IMPORT_COPY.attentionTitle}>
      <p>{sentences.join(' ')}</p>
      {run && <Id>{importCode(run)}</Id>}
      <p>{IMPORT_COPY.how[attention.kind]}</p>
      <Commands commands={importCommands(attention.kind, environment)} />
    </Notice>
  );
}

function OverdueNotice({ imports, attention, timeZone }: { imports: AdminImports; attention: Attention | null; timeZone: string }) {
  const last = imports.lastCheck;
  if (attention && BLOCKING_KINDS.has(attention.kind)) {
    return (
      <Notice kind="overdue" title={IMPORT_COPY.overdueTitle}>
        <p>{IMPORT_COPY.overdueReview}</p>
      </Notice>
    );
  }
  if (attention?.kind === 'recertification') {
    return (
      <Notice kind="overdue" title={IMPORT_COPY.overdueTitle}>
        <p>{IMPORT_COPY.overdueRecertification}</p>
      </Notice>
    );
  }
  return (
    <Notice kind="overdue" title={IMPORT_COPY.overdueTitle}>
      <p>
        {attention?.kind === 'unreadable' ? (
          IMPORT_COPY.overdueUnreadable
        ) : (
          <>
            {IMPORT_COPY.overdueText}{' '}
            {last ? (
              <>
                {IMPORT_COPY.overdueLast} <Zoned iso={last.checkedAt} timeZone={timeZone} />.
              </>
            ) : (
              IMPORT_COPY.overdueNever
            )}
          </>
        )}
      </p>
      <p>{IMPORT_COPY.overdueHow}</p>
      <Commands commands={[{ command: IMPORT_COPY.overdueCommand }]} />
    </Notice>
  );
}

/** The step a run reached, or a dash for one refused before it started. */
function Reached({ run }: { run: AdminImportRun }) {
  const words = stepWords(run);
  return <span data-step="">{words ?? <Missing words={IMPORT_COPY.notStarted} />}</span>;
}

/** The run's file cost (its file's total so far), or a dash that says why there is none. */
function FileCost({ run, view }: { run: AdminImportRun; view: ImportView }) {
  const cost = fileCost(run, view);
  return 'none' in cost ? <Missing words={cost.none} /> : <span className="font-mono tabular-nums">{formatUsd(cost.usd)}</span>;
}

/**
 * The recent runs as a table where the System section has room for one: the page's width on a
 * tablet, or its column beside Costs from 1280px. The mode sits under the time.
 */
function RunsTable({ view, timeZone }: { view: ImportView; timeZone: string }) {
  const th = 'px-2 py-1.5 text-left text-micro font-bold tracking-caps text-muted uppercase first:pl-0 last:pr-0';
  return (
    <div className="hidden overflow-x-auto sm:block lg:hidden min-[1280px]:block" data-import-runs-wrap="">
      <table className="w-full text-meta" data-import-runs-table="">
        <caption className="sr-only">{IMPORT_COPY.runsCaption}</caption>
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className={th}>
              Checked
            </th>
            <th scope="col" className={th}>
              Result
            </th>
            <th scope="col" className={th}>
              Reached
            </th>
            <th scope="col" className={cx(th, 'text-right whitespace-nowrap')}>
              File cost
            </th>
          </tr>
        </thead>
        <tbody>
          {view.runs.map((run) => (
            <tr key={`${run.checkedAt}-${run.mode}`} className="border-b border-hairline align-top last:border-b-0">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal whitespace-nowrap text-ink">
                {formatDateTime(run.checkedAt, timeZone)}
                <span className="block text-label text-muted" data-mode="">
                  {IMPORT_MODE_WORDS[run.mode]}
                </span>
              </th>
              <td className="px-2 py-1.5 text-ink" data-outcome="">
                {importOutcome(run, view)}
              </td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <Reached run={run} />
              </td>
              <td className="py-1.5 pl-2 text-right">
                <FileCost run={run} view={view} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** On a phone, and in the column beside Costs below 1280px, each run is a block of its own, in the table's order. */
function RunsList({ view, timeZone }: { view: ImportView; timeZone: string }) {
  return (
    <ul className="sm:hidden lg:block min-[1280px]:hidden" aria-label={IMPORT_COPY.runsCaption} data-import-runs-list="">
      {view.runs.map((run) => (
        <li key={`${run.checkedAt}-${run.mode}`} className="border-t border-hairline py-2 text-meta first:border-t-0 first:pt-0">
          <p className="font-bold text-ink">
            {formatDateTime(run.checkedAt, timeZone)}{' '}
            <span className="font-normal text-muted">
              · <span data-mode="">{IMPORT_MODE_WORDS[run.mode]}</span>
            </span>
          </p>
          <p className="text-ink" data-outcome="">
            {importOutcome(run, view)}
          </p>
          <p className="text-muted">
            Reached: <Reached run={run} /> · file cost <FileCost run={run} view={view} />
          </p>
        </li>
      ))}
    </ul>
  );
}

/** A run's time and outcome, its meaning when the outcome alone does not say it, and its identifiers. */
function RunFact({ run, view, timeZone, withCode }: { run: AdminImportRun; view: ImportView; timeZone: string; withCode: boolean }) {
  const meaning = runMeaning(run, view);
  return (
    <>
      <Zoned iso={run.checkedAt} timeZone={timeZone} />
      <span className="block" data-outcome="">
        {importOutcome(run, view)}
      </span>
      {meaning && <span className="block text-muted">{meaning}</span>}
      {withCode && <Id>{importCode(run)}</Id>}
    </>
  );
}

/**
 * At the head of the page, while the importer needs attention (an open review, an overdue check):
 * one line that says so and takes the reader to its notice in the System section, so the page's
 * notification cannot be missed at its foot. Nothing while all is well.
 */
export function ImportPointer({ imports }: { imports: AdminImports }) {
  const kinds = [...(imports.attentionRequired ? (['attention'] as const) : []), ...(imports.overdue ? (['overdue'] as const) : [])];
  if (kinds.length === 0) return null;
  return (
    <p className="card mb-3.5 border-caution-edge border-l-4 border-l-ink px-3.5 py-1.5 text-ui" data-import-pointer="" data-print="hide">
      {kinds.map((kind, i) => (
        <Fragment key={kind}>
          {i > 0 && ' '}
          <a
            href={`#${NOTICE_ID[kind]}`}
            onClick={(event) => {
              // In the page, without a router navigation: the notice takes focus and scrolls into view.
              event.preventDefault();
              document.getElementById(NOTICE_ID[kind])?.focus();
            }}
            className="inline-block py-0.5 font-bold text-blue hover:underline pointer-coarse:min-h-11 pointer-coarse:py-2.5"
          >
            {kind === 'attention' ? IMPORT_COPY.pointerAttention : IMPORT_COPY.pointerOverdue}
          </a>
        </Fragment>
      ))}
    </p>
  );
}

export function ImportStatus({
  imports,
  dataset,
  environment,
  timeZone,
}: {
  imports: AdminImports;
  dataset: AdminOverview['system']['dataset'];
  environment: ImportEnvironment;
  timeZone: string;
}) {
  const view = importView(imports);
  const schedule = imports.enabled ? imports.schedule : null;
  const latest = view.runs[0] ?? null;
  const completed = imports.lastCheck;
  const success = imports.lastSuccessfulImport;
  return (
    <div data-imports="">
      {view.attention && <AttentionNotice view={view} attention={view.attention} generation={dataset?.generationId ?? null} environment={environment} timeZone={timeZone} />}
      {imports.overdue && <OverdueNotice imports={imports} attention={view.attention} timeZone={timeZone} />}
      <dl className="mb-3">
        <Fact label="Schedule">{schedule ? IMPORT_COPY.schedule(schedule.localTime, schedule.timeZone) : IMPORT_COPY.off}</Fact>
        {schedule && (
          <Fact label="Next snapshot check">{schedule.nextCheckAt ? <Zoned iso={schedule.nextCheckAt} timeZone={timeZone} /> : IMPORT_COPY.notKnown}</Fact>
        )}
        {latest && (
          <Fact label="Latest listed run">
            <RunFact run={latest} view={view} timeZone={timeZone} withCode />
          </Fact>
        )}
        <Fact label="Last completed check">
          {completed === null ? (
            IMPORT_COPY.noneYet
          ) : latest !== null && completed.checkedAt === latest.checkedAt ? (
            IMPORT_COPY.sameAsLatest
          ) : (
            <RunFact run={completed} view={view} timeZone={timeZone} withCode={false} />
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
      <h4 className="text-micro font-bold tracking-caps text-muted uppercase">{IMPORT_COPY.runsTitle}</h4>
      {view.runs.length === 0 ? (
        <p className="mt-1 text-meta text-muted">{IMPORT_COPY.noRuns}</p>
      ) : (
        <>
          <p className="mt-0.5 mb-1.5 text-label text-muted">{IMPORT_COPY.runsIntro(timeZone)}</p>
          <RunsTable view={view} timeZone={timeZone} />
          <RunsList view={view} timeZone={timeZone} />
        </>
      )}
    </div>
  );
}
