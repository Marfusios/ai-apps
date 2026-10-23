import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { BriefIdSchema, MAX_BRIEF_STEPS } from '../../../shared/contracts/briefs';
import { NtsbNoSchema } from '../../../shared/contracts/common';
import { caseQuery, isNotFound } from '../api';
import { Button } from '../components/Button';
import { Placard } from '../components/Placard';
import { cx } from '../lib/cx';
import { formatChartDate } from '../lib/format';
import { caseContextQuery } from '../features/brief/api';
import type { AiCaseContext } from '../features/case/BriefContext';
import { CaseStory } from '../features/case/CaseStory';
import { StorySkeleton } from '../features/case/CaseDrawer';
import { COMPARE_FULL_MESSAGE, CompareTray } from '../features/explore/CompareTray';
import { useCompareSelection } from '../features/explore/url-state';

/** Print-only header (UI_DESIGN §7): page title, case numbers, snapshot date and the page URL. */
export function PrintHeader({ title, cases, snapshotDate }: { title: string; cases: readonly string[]; snapshotDate: string | null }) {
  return (
    <div data-print="only" className="mb-4 border-b border-ink pb-2 text-meta">
      <p className="font-bold tracking-caps uppercase">Aviation Casebook · {title}</p>
      <p>
        {cases.join(' · ')}
        {snapshotDate && ` · NTSB data snapshot ${formatChartDate(snapshotDate)}`}
      </p>
      <p className="break-all">{typeof window === 'undefined' ? '' : window.location.href}</p>
    </div>
  );
}

/**
 * The element id a link's hash names (`#probable-cause`), or null. A hash with a malformed
 * percent-escape (`#%`, `#analysis%E`) names nothing: it never breaks the page (Task 22
 * review W-1).
 */
export function hashTarget(hash: string): string | null {
  if (hash.length < 2) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

/**
 * `brief` and `step` of a case or compare link opened from a brief, or null. A link with
 * a malformed reference reads as a brief that is gone (`invalid`).
 */
export function readBriefRef(params: URLSearchParams): { id: string; step: number } | 'invalid' | null {
  const id = params.get('brief');
  if (id === null) return null;
  const raw = params.get('step') ?? '';
  const step = /^\d$/.test(raw) ? Number(raw) : NaN;
  if (!BriefIdSchema.safeParse(id).success || !(step >= 1 && step <= MAX_BRIEF_STEPS)) return 'invalid';
  return { id, step };
}

/**
 * The full case page (UI_DESIGN §4.5) in a 680px column: NTSB data only, unless it is
 * opened from the viewer's own live brief (`?brief=…&step=n`); then that step's AI
 * context comes from the private endpoint, or a muted note says it is gone.
 */
export function CasePage() {
  const { ntsbNo: raw = '' } = useParams();
  const ntsbNo = raw.toUpperCase();
  const valid = NtsbNoSchema.safeParse(ntsbNo).success;
  const location = useLocation();
  const [params] = useSearchParams();
  const ref = readBriefRef(params);
  const brief = ref !== null && ref !== 'invalid' ? ref : null;
  const from = (location.state as { from?: string } | null)?.from ?? (brief ? `/briefs/${brief.id}?step=${brief.step}` : undefined);
  const query = useQuery({ ...caseQuery(ntsbNo), enabled: valid });
  const context = useQuery({ ...caseContextQuery(brief?.id ?? '', brief?.step ?? 1, ntsbNo), enabled: valid && brief !== null });
  const ai: AiCaseContext | undefined =
    ref === null
      ? undefined
      : ref === 'invalid' || !brief || isNotFound(context.error)
        ? { state: 'gone', briefId: '', step: 1 }
        : context.isError
          ? { state: 'error', briefId: brief.id, step: brief.step, retry: () => void context.refetch() }
          : context.data
            ? { state: 'ready', briefId: brief.id, step: brief.step, context: context.data }
            : { state: 'loading', briefId: brief.id, step: brief.step };
  const compare = useCompareSelection();
  const [notice, setNotice] = useState<string | null>(null);
  const inCompare = compare.selected.includes(ntsbNo);

  useEffect(() => {
    if (!query.data) return;
    const target = hashTarget(location.hash);
    if (target) document.getElementById(target)?.scrollIntoView?.();
  }, [query.data, location.hash]);

  const toggle = (): void => {
    const result = compare.toggle(ntsbNo);
    setNotice(result === 'full' ? COMPARE_FULL_MESSAGE : null);
  };

  const notFound = !valid || isNotFound(query.error);
  return (
    <div className={cx('mx-auto w-full max-w-case px-4 pt-5 pb-12 sm:pt-7', compare.selected.length > 0 && 'pb-24')}>
      <title>{query.data ? `${query.data.ntsbNo}: ${query.data.headline} · Aviation Casebook` : `${ntsbNo} · Aviation Casebook`}</title>
      <nav data-print="hide" className="mb-3 text-ui">
        {from ? (
          <Link to={from} className="text-blue hover:underline">
            ← Back to results
          </Link>
        ) : (
          <Link to="/explore" className="text-blue hover:underline">
            ← Explore
          </Link>
        )}
      </nav>
      {notFound ? (
        <div className="card px-6 py-6">
          <Placard as="p">Not found</Placard>
          <h1 className="mt-2 font-serif text-headline font-semibold tracking-headline">No investigation has that number.</h1>
          <p className="mt-3 font-serif text-quote">
            Check the case number, or search for it in{' '}
            <Link to="/explore" className="link">
              Explore
            </Link>
            .
          </p>
        </div>
      ) : query.data ? (
        <>
          <PrintHeader title="Case" cases={[query.data.ntsbNo]} snapshotDate={query.data.provenance.snapshotDate} />
          <div className="card px-4 py-5 sm:px-8 sm:py-7">
            <CaseStory
              detail={query.data}
              mode="page"
              ai={ai}
              openAtCited={false}
              actions={
                <div className="mt-3 flex flex-wrap items-center gap-2" data-print="hide">
                  <Button variant="search" size="sm" aria-pressed={inCompare} onClick={toggle}>
                    {inCompare ? '✓ In compare' : '+ Compare'}
                  </Button>
                  <Button variant="search" size="sm" onClick={() => window.print()}>
                    Print for class
                  </Button>
                  {notice && (
                    <p role="status" className="text-meta text-ink">
                      {notice}
                    </p>
                  )}
                </div>
              }
            />
          </div>
        </>
      ) : query.isError ? (
        <div role="alert" className="card px-6 py-6">
          <p className="font-serif text-[19px] font-semibold">This case didn’t load.</p>
          <p className="mt-1 text-ui text-muted">Check your connection and try again.</p>
          <button type="button" onClick={() => query.refetch()} className="mt-2 cursor-pointer text-ui text-blue hover:underline">
            Try again
          </button>
        </div>
      ) : (
        <div className="card px-6 py-6">
          <p className="font-mono text-[13px] font-bold tracking-mono text-blue">{ntsbNo}</p>
          <StorySkeleton />
        </div>
      )}
      <CompareTray
        selected={compare.selected}
        onRemove={compare.remove}
        notice={null}
        from={`${location.pathname}${location.search}`}
      />
    </div>
  );
}
