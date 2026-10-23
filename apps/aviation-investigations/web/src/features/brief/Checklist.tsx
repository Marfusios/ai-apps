import { useEffect, useState } from 'react';
import type { BriefStage, Checklist as ChecklistResults } from '../../../../shared/contracts/briefs';
import { cx } from '../../lib/cx';
import { formatCount } from '../../lib/format';

export const CHECKLIST_TITLE = 'Answer checklist';
export const CHECKLIST_NOTE = 'Nothing is shown until each quote matches the report text word for word. Up to a minute.';

type RowState = 'done' | 'current' | 'todo';

interface Row {
  challenge: string;
  /** The result once the stage is complete. */
  result: string | null;
  /** What the polite live region says when the row completes. */
  spoken: string | null;
  state: RowState;
}

const ORDER: readonly BriefStage[] = ['scope', 'retrieve', 'compose', 'validate'];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 'S'}`;
}

/** The four rows (UI_DESIGN §4.4): scope, retrieve, compose, validate. */
export function checklistRows(checklist: ChecklistResults, stage: BriefStage, cohort: number | null): Row[] {
  const results: (string | null)[] = [
    checklist.question ? 'IN SCOPE' : null,
    checklist.searched ? `${plural(checklist.searched.cases, 'CASE')} · ${plural(checklist.searched.passages, 'PASSAGE')}` : null,
    checklist.written ? 'DONE' : null,
    checklist.verified === 'passed' ? 'PASSED' : checklist.verified === 'partially_checked' ? 'PARTLY CHECKED' : checklist.verified === 'withheld' ? 'WITHHELD' : null,
  ];
  const spoken: (string | null)[] = [
    checklist.question ? 'Question: in scope.' : null,
    checklist.searched
      ? `Search done: ${checklist.searched.cases} ${checklist.searched.cases === 1 ? 'case' : 'cases'}, ${checklist.searched.passages} ${checklist.searched.passages === 1 ? 'passage' : 'passages'}.`
      : null,
    checklist.written ? 'Answer written.' : null,
    checklist.verified
      ? `Quotes verified: ${checklist.verified === 'passed' ? 'passed' : checklist.verified === 'partially_checked' ? 'partly checked, unconfirmed statements not shown' : 'summary withheld'}.`
      : null,
  ];
  const at = ORDER.indexOf(stage);
  const challenges = ['Question', cohort === null ? 'Search investigations' : `Search ${formatCount(cohort)} investigations`, 'Write answer', 'Verify every quote'];
  return challenges.map((challenge, i) => {
    const result = results[i] ?? null;
    const state: RowState = result !== null ? 'done' : i === at ? 'current' : 'todo';
    return { challenge, result, spoken: spoken[i] ?? null, state };
  });
}

function elapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface ChecklistProps {
  checklist: ChecklistResults;
  stage: BriefStage;
  startedAt: string;
  /** The default cohort size from /api/config ("Search 24,291 investigations"). */
  cohort: number | null;
  onCancel: () => void;
  cancelling: boolean;
}

/**
 * While the AI works (UI_DESIGN §4.4): a challenge-and-response checklist card. Each
 * row fills in its real result as the stage completes, with a magenta ✓; the current
 * row has a faint magenta wash. Completions are announced politely, once each; the
 * timer is not announced. The server sends stage status and counts, plus, once the scope
 * stage is done, its readings and filters as server templates (`interpretation`: the
 * chips above this card show them, the rows here do not); never partial answer text.
 */
export function Checklist({ checklist, stage, startedAt, cohort, onCancel, cancelling }: ChecklistProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const rows = checklistRows(checklist, stage, cohort);
  const done = rows.filter((r) => r.state === 'done');
  // Only completions change this text, so polls that bring nothing new say nothing.
  const announcement = done.length > 0 ? (done[done.length - 1]?.spoken ?? '') : '';

  return (
    <section aria-labelledby="checklist-title" className="mt-4">
      <div className="overflow-hidden rounded-chip border-[1.5px] border-checklist-edge bg-raised shadow-[var(--bezel)]">
        <div className="flex items-center bg-checklist-head px-3.5 py-1.5 text-checklist-head-ink">
          <h2 id="checklist-title" className="text-label font-bold tracking-[.18em] uppercase">
            {CHECKLIST_TITLE}
          </h2>
          <span aria-hidden="true" className="ml-auto font-mono text-label tracking-[.1em] opacity-80">
            {elapsed(startedAt, now)}
          </span>
        </div>
        <ol>
          {rows.map((row) => (
            <li
              key={row.challenge}
              data-state={row.state}
              aria-current={row.state === 'current' ? 'step' : undefined}
              className={cx(
                'flex items-baseline gap-2 border-t border-hairline px-3.5 py-2 font-mono text-[12.5px] first:border-t-0',
                row.state === 'current' && 'bg-magenta-wash',
                row.state === 'todo' && 'text-muted',
              )}
            >
              <span>{row.challenge}</span>
              <span aria-hidden="true" className="flex-1 -translate-y-1 border-b-[1.5px] border-dotted border-rule" />
              <span className={cx('font-bold', row.state === 'current' && 'text-magenta')}>
                {row.result ?? (row.state === 'current' ? 'IN PROGRESS' : '—')}
                {row.state === 'done' && (
                  <span className="ml-2 text-magenta">
                    ✓<span className="sr-only"> done</span>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <p className="mt-2 text-meta text-muted">
        {CHECKLIST_NOTE}{' '}
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="cursor-pointer text-blue underline-offset-2 hover:underline disabled:cursor-default disabled:text-muted pointer-coarse:min-h-11"
        >
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
