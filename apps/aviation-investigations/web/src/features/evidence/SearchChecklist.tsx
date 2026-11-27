import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { configQuery } from '../../api';
import { cx } from '../../lib/cx';
import { SEARCH_CHECKLIST_NOTE, SEARCH_CHECKLIST_TITLE, checklistAnnouncement, checklistRows, elapsed, spokenCompletions, type ChecklistRow } from './checklist';
import { evidenceProgressQuery } from './progress';
import type { PendingSearch } from './useEvidenceSearch';

export interface SearchChecklistProps {
  /** The search on its way: its idempotency key (the progress is read under it), its kind and when it left. */
  pending: PendingSearch;
  className?: string;
}

/**
 * While an AI search runs (UI_DESIGN §4.10, Task 25): a challenge-and-response checklist card in
 * the cockpit style of the brief's (§4.4), where the visitor waits. The ink title bar says "Search
 * checklist" and the time since the request left; the rows (B612 Mono, dotted leaders) are the
 * question, the search of the default cohort and the order of the leading results, read from the
 * search's progress about every 500 ms while its POST runs: each fills in its real result as its
 * stage ends, with a magenta ✓, the row under way has a faint magenta wash, and rows not reached are
 * muted. Until the first good read the card stays unticked. Completions are announced politely, once
 * each, and stages that end between two reads together, in order; the timer is not. Statuses and
 * counts only, never model text; it does not print. It reads only for the visitor who sent the
 * search (`pending.visitor`).
 */
export function SearchChecklist({ pending, className }: SearchChecklistProps) {
  const cohort = useQuery(configQuery()).data?.coverage.defaultCohort ?? null;
  const progress = useQuery(evidenceProgressQuery(pending.key, pending.visitor)).data ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const titleId = useId();
  const rows = checklistRows({ kind: pending.kind, progress, cohort });
  // Each completion is said once: the rows already said, and what the live region says now.
  const said = useRef(new Set<ChecklistRow['id']>());
  const [announcement, setAnnouncement] = useState('');
  const completed = spokenCompletions(rows)
    .map((r) => r.id)
    .join(' ');
  useEffect(() => {
    const next = checklistAnnouncement(rows, said.current);
    if (!next) return;
    for (const r of spokenCompletions(rows)) said.current.add(r.id);
    setAnnouncement(next);
    // Only a new completion changes what is said.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- rows is new on every render; the effect runs only when the completed rows change
  }, [completed]);
  return (
    <section aria-labelledby={titleId} className={cx('w-full max-w-[640px] text-left', className)} data-search-checklist="" data-print="hide">
      <div className="overflow-hidden rounded-chip border-[1.5px] border-checklist-edge bg-raised shadow-[var(--bezel)]">
        <div className="flex items-center bg-checklist-head px-3.5 py-1.5 text-checklist-head-ink">
          <h2 id={titleId} className="text-label font-bold tracking-[.18em] uppercase">
            {SEARCH_CHECKLIST_TITLE}
          </h2>
          <span aria-hidden="true" className="ml-auto font-mono text-label tracking-[.1em] opacity-80" data-checklist-timer="">
            {elapsed(pending.startedAt, now)}
          </span>
        </div>
        <ol>
          {rows.map((row) => (
            <li
              key={row.id}
              data-row={row.id}
              data-state={row.tone}
              aria-current={row.tone === 'current' ? 'step' : undefined}
              className={cx(
                'flex flex-wrap items-baseline gap-x-2 border-t border-hairline px-3.5 py-2 font-mono text-[12px] first:border-t-0 sm:text-[12.5px]',
                row.tone === 'current' && 'bg-magenta-wash',
                (row.tone === 'todo' || row.tone === 'skipped') && 'text-muted',
              )}
            >
              <span className="min-w-0" data-challenge="">
                {row.challenge}
              </span>
              <span aria-hidden="true" className="min-w-4 flex-1 -translate-y-1 border-b-[1.5px] border-dotted border-rule" />
              <span className={cx('ml-auto font-bold', row.tone === 'current' && 'text-magenta')}>
                <span data-result="">{row.result}</span>
                {row.tick && (
                  <span className="checklist-tick ml-2 text-magenta" data-tick="">
                    ✓<span className="sr-only"> done</span>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <p className="mt-2 text-meta text-muted">{SEARCH_CHECKLIST_NOTE}</p>
      {/* Rendered empty first, so each completion is announced; reads that bring nothing new say nothing. */}
      <p aria-live="polite" className="sr-only" data-checklist-live="">
        {announcement}
      </p>
    </section>
  );
}
