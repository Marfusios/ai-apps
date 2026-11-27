import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Link, type To } from 'react-router';
import type { Snippet } from '../../../../shared/contracts/search';
import { caseQuery, isNotFound } from '../../api';
import { caseContextQuery } from '../brief/api';
import { cx } from '../../lib/cx';
import type { DrawerEvidence } from '../evidence/EvidenceSection';
import type { AiCaseContext } from './BriefContext';
import { CaseStory } from './CaseStory';

export interface DrawerPosition {
  /** 1-based place of the case in the result list. */
  index: number;
  total: number;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
}

export interface CaseDrawerProps {
  ntsbNo: string | null;
  onClose: () => void;
  position: DrawerPosition | null;
  inCompare: boolean;
  onToggleCompare: () => void;
  /** Feedback for the compare button, e.g. "Compare holds four cases. Remove one first." */
  compareNotice: string | null;
  fullPage: To;
  /** Router state for the full page, e.g. where "Back to results" returns. */
  fullPageState?: unknown;
  matched: Snippet | null;
  /**
   * The viewer's live brief and step, when the drawer is opened over a brief: its AI
   * context for the case comes from the private endpoint, and the drawer opens at the
   * cited passage (UI_DESIGN §4.3, §4.5).
   */
  brief?: { id: string; step: number } | null;
  /**
   * The case as the viewer's evidence search shows it, when the drawer is opened over that
   * search: its relevance facts and excerpts, under the search's heading and notice (UI_DESIGN
   * §4.9). Already on the page: nothing more is read.
   */
  evidence?: DrawerEvidence | null;
}

const toolButton =
  'inline-flex cursor-pointer items-center justify-center rounded-full text-blue hover:bg-blue-wash aria-disabled:cursor-default aria-disabled:text-muted aria-disabled:hover:bg-transparent pointer-coarse:min-h-11 pointer-coarse:min-w-11';

/** ‹ or ›: stays focusable at either end of the list (aria-disabled), so focus never drops out of the drawer. */
function StepButton({ onStep, label, children }: { onStep: (() => void) | null; label: string; children: ReactNode }) {
  return (
    <button type="button" aria-disabled={!onStep} onClick={() => onStep?.()} className={cx(toolButton, 'size-6')}>
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

/**
 * The case drawer (UI_DESIGN §4.5, §8): a modal dialog from the right, about 58% of
 * the viewport (85% on tablets, full screen on phones). Focus moves to the
 * headline, Esc closes, focus returns to the row that opened it, and ‹ › step
 * through the result list.
 */
export function CaseDrawer({
  ntsbNo,
  onClose,
  position,
  inCompare,
  onToggleCompare,
  compareNotice,
  fullPage,
  fullPageState,
  matched,
  brief = null,
  evidence = null,
}: CaseDrawerProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);
  // The element that opened the drawer, for returning focus to exactly it.
  const opener = useRef<HTMLElement | null>(null);
  if (ntsbNo && shown.current === null && document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
  if (ntsbNo) shown.current = ntsbNo;
  const query = useQuery({ ...caseQuery(ntsbNo ?? ''), enabled: ntsbNo !== null });
  const context = useQuery({ ...caseContextQuery(brief?.id ?? '', brief?.step ?? 1, ntsbNo ?? ''), enabled: brief !== null && ntsbNo !== null });
  const ai: AiCaseContext | undefined = brief
    ? context.data
      ? { state: 'ready', briefId: brief.id, step: brief.step, context: context.data }
      : context.isError
        ? isNotFound(context.error)
          ? { state: 'gone', briefId: brief.id, step: brief.step }
          : { state: 'error', briefId: brief.id, step: brief.step, retry: () => void context.refetch() }
        : { state: 'loading', briefId: brief.id, step: brief.step }
    : undefined;
  // Over a brief the story scrolls itself to the cited passage, so focusing the headline must not scroll.
  const focusHeading = (): void => heading.current?.focus(brief ? { preventScroll: true } : undefined);
  // Focus goes to the headline on open; while the case loads, to its placeholder.
  const focusPending = useRef(false);
  useEffect(() => {
    if (!focusPending.current || !heading.current) return;
    focusHeading();
    if (query.data) focusPending.current = false;
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- focusHeading is new on every render; focus moves only when the case or its data changes
  }, [query.data, ntsbNo]);
  // Each case starts at the top of the drawer. A layout effect, so it runs before the
  // story's own effect scrolls to the cited passage (‹ › onto a case whose context is cached).
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [ntsbNo]);

  return (
    <Dialog.Root open={ntsbNo !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-shade" data-print="hide" />
        <Dialog.Content
          aria-describedby={undefined}
          aria-modal="true"
          // Printing with the drawer open prints the page behind it, not the fixed sheet over it.
          data-print="hide"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusPending.current = true;
            focusHeading();
            if (heading.current && query.data) focusPending.current = false;
          }}
          onCloseAutoFocus={(event) => {
            // Return focus to what opened the drawer when it still shows that case, otherwise
            // to the row of the case last shown (‹ › may have moved on). Case numbers are
            // validated as [A-Z0-9], so they are safe in a selector.
            const own = opener.current;
            opener.current = null;
            const last = shown.current;
            shown.current = null;
            const trigger =
              own && own.isConnected && own.getAttribute('data-case-trigger') === last
                ? own
                : last
                  ? document.querySelector<HTMLElement>(`[data-case-trigger="${last}"]`)
                  : null;
            if (trigger) {
              event.preventDefault();
              trigger.focus();
            }
          }}
          className={cx(
            'drawer fixed inset-0 z-50 flex flex-col bg-raised text-ink shadow-drawer',
            'sm:left-auto sm:w-[85vw] sm:border-l-2 sm:border-blue lg:w-[58vw] lg:max-w-[760px] lg:min-w-[470px]',
          )}
        >
          <Dialog.Title asChild>
            <p className="sr-only">
              {query.data ? `${query.data.ntsbNo}: ${query.data.headline}` : `Case ${ntsbNo ?? shown.current ?? ''}`}
            </p>
          </Dialog.Title>
          <div className="flex items-center gap-3.5 border-b border-hairline bg-toolbar px-3 py-1.5 text-meta sm:px-6 sm:py-[9px]">
            <Dialog.Close className={cx(toolButton, 'size-7 text-ink')}>
              <X size={16} strokeWidth={1.5} aria-hidden="true" />
              <span className="sr-only">Close</span>
            </Dialog.Close>
            {position && (
              <div className="flex items-center gap-0.5 text-muted">
                <StepButton onStep={position.onPrevious} label="Previous case">
                  <ChevronLeft size={14} strokeWidth={1.5} aria-hidden="true" />
                </StepButton>
                <span aria-live="polite">
                  {position.index} of {position.total}
                </span>
                <StepButton onStep={position.onNext} label="Next case">
                  <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
                </StepButton>
              </div>
            )}
            <span className="ml-auto" />
            <button type="button" onClick={onToggleCompare} aria-pressed={inCompare} className={cx(toolButton, 'px-2 py-0.5')}>
              {inCompare ? '✓ In compare' : '+ Compare'}
            </button>
            <Link
              to={fullPage}
              state={fullPageState}
              className="hidden items-center rounded-full border-[1.5px] border-blue px-2.5 py-0.5 text-blue hover:bg-blue-wash sm:inline-flex"
            >
              Open full page ↗
            </Link>
          </div>
          {compareNotice && (
            <p role="status" className="border-b border-hairline bg-toolbar px-6 py-1.5 text-meta text-ink">
              {compareNotice}
            </p>
          )}
          <div ref={body} className="flex-1 overflow-y-auto overscroll-contain px-4 pt-5 pb-8 sm:px-[30px] sm:pt-[22px]">
            {query.data ? (
              <>
                <CaseStory detail={query.data} mode="drawer" headingRef={heading} matched={matched} ai={ai} openAtCited={brief !== null} evidence={evidence} />
                <Link to={fullPage} state={fullPageState} className="link mt-4 inline-block text-ui sm:hidden">
                  Open the full case page
                </Link>
              </>
            ) : (
              <div>
                <h2 ref={heading} tabIndex={-1} className="font-mono text-[13px] font-bold tracking-mono text-blue outline-none">
                  {ntsbNo ?? shown.current}
                </h2>
                {query.isError ? (
                  <p className="mt-3 text-ui text-muted">
                    {isNotFound(query.error)
                      ? 'No investigation has that number in this snapshot.'
                      : 'This case did not load. Check your connection and try again.'}{' '}
                    {!isNotFound(query.error) && (
                      <button type="button" onClick={() => query.refetch()} className="cursor-pointer text-blue hover:underline">
                        Try again
                      </button>
                    )}
                  </p>
                ) : (
                  <StorySkeleton />
                )}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function StorySkeleton() {
  return (
    <div aria-hidden="true" className="mt-3 space-y-3">
      <div className="h-6 w-4/5 rounded-[3px] bg-tint" />
      <div className="h-6 w-3/5 rounded-[3px] bg-tint" />
      <div className="h-3 w-2/3 rounded-[3px] bg-tint opacity-70" />
      <div className="mt-6 h-24 rounded-chip bg-tint opacity-50" />
      <div className="h-3 w-full rounded-[3px] bg-tint opacity-60" />
      <div className="h-3 w-11/12 rounded-[3px] bg-tint opacity-60" />
    </div>
  );
}
