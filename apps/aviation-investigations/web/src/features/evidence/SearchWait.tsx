import { Component, lazy, Suspense, type ReactNode } from 'react';
import type { PendingSearch } from './useEvidenceSearch';

/**
 * The search checklist (web/src/features/evidence/SearchChecklist.tsx) where the visitor waits for
 * an AI search. It loads with the first AI request, never with the home page (it reads the evidence
 * contracts): `preloadSearchChecklist` starts loading it as the request starts, so it is there by
 * the time the request leaves. A checklist that cannot load (a network failure) shows nothing: the
 * search goes on, and the page never fails for it.
 */
const load = () => import('./SearchChecklist');
const SearchChecklist = lazy(async () => ({ default: (await load()).SearchChecklist }));

/** Starts loading the checklist (an AI request is starting); a failure is left to the checklist itself. */
export function preloadSearchChecklist(): void {
  load().catch(() => undefined);
}

/** Shows nothing instead of the checklist when it could not load. */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** The checklist of the AI search on its way (`pending`), or nothing. */
export function SearchWait({ pending, className }: { pending: PendingSearch | null; className?: string }) {
  if (!pending) return null;
  return (
    <Quiet key={pending.key}>
      <Suspense fallback={null}>
        <SearchChecklist pending={pending} className={className} />
      </Suspense>
    </Quiet>
  );
}
