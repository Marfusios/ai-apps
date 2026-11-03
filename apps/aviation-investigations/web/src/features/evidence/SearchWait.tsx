import { Component, lazy, Suspense, useSyncExternalStore, type ReactNode } from 'react';
import type { PendingSearch } from './useEvidenceSearch';

/**
 * The search checklist (web/src/features/evidence/SearchChecklist.tsx) where the visitor waits for
 * an AI search. It loads with the first AI request, never with the home page (it reads the evidence
 * contracts): `preloadSearchChecklist` starts loading it as soon as an AI search starts, before its
 * Turnstile check, so in practice it is there by the time the request leaves; the control says
 * "Searching…" only once it has loaded (`useSearchChecklistReady`). A checklist that cannot load (a
 * network failure) shows nothing, and the control keeps its plain busy state: the search goes on,
 * and the page never fails for it.
 */
let ready = false;
const readyListeners = new Set<() => void>();
const load = () =>
  import('./SearchChecklist').then((module) => {
    if (!ready) {
      ready = true;
      for (const listener of [...readyListeners]) listener();
    }
    return module;
  });
const SearchChecklist = lazy(async () => ({ default: (await load()).SearchChecklist }));

/** Starts loading the checklist (an AI search is starting); a failure is left to the checklist itself. */
export function preloadSearchChecklist(): void {
  load().catch(() => undefined);
}

function onReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => void readyListeners.delete(listener);
}

/** Whether the checklist has loaded, so that it shows for a search on its way. */
export function useSearchChecklistReady(): boolean {
  return useSyncExternalStore(
    onReady,
    () => ready,
    () => false,
  );
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
