/**
 * The visitor's ratings of their AI searches, as this tab sent them (UI_DESIGN §4.11, Task 25).
 * The server keeps a rating (the latest counts) but never sends it back, so the page holds what it
 * sent, per search, in memory only: after a reload a search shows unrated again. Forgotten with the
 * visitor (web/src/features/auth/visitor.ts). Free of the evidence contracts' values.
 */
import { useSyncExternalStore } from 'react';
import type { EvidenceFeedbackRating } from '../../../../shared/contracts/evidence';

const ratings = new Map<string, EvidenceFeedbackRating>();
const listeners = new Set<() => void>();

function changed(): void {
  // oxlint-disable-next-line unicorn/no-useless-spread -- the copy keeps a listener that unsubscribes or subscribes while it runs out of this loop
  for (const listener of [...listeners]) listener();
}

/** The search `id` was rated `rating` (the server answered 204). */
export function rememberRating(id: string, rating: EvidenceFeedbackRating): void {
  ratings.set(id, rating);
  changed();
}

/** What this tab rated the search `id`, or null. */
export function ratingOf(id: string): EvidenceFeedbackRating | null {
  return ratings.get(id) ?? null;
}

/** Forget every rating (the visitor changed). */
export function forgetRatings(): void {
  if (ratings.size === 0) return;
  ratings.clear();
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The search's rating as this tab sent it, kept current. */
export function useRating(id: string): EvidenceFeedbackRating | null {
  return useSyncExternalStore(
    subscribe,
    () => ratingOf(id),
    () => null,
  );
}
