/**
 * The one free undo of an AI evidence search (contract `evidence.v3`; the server's rule is
 * server/evidence/undo.ts `canUndo`, DESIGN "Evidence.v3"). What AirCase added to a question
 * search on its own (a state the question names, applied as a filter, and the AI's terms in
 * keyword search) can be taken out again without using one of the visitor's searches, once per
 * search. The page says whether that undo is still there (`undo: 'available'`, read from the
 * server's one-use claim at every page read; `used` once claimed; `none` for an edit or a search
 * with nothing added). A draft qualifies when it sends no words of its own and removes the whole
 * automatic state, the added terms, or both, and changes nothing else; removing one state of
 * several narrows the search, so that is an ordinary edit. The server decides at admission, and the
 * created page's `freeUndo` says what it decided: the hint is a snapshot, which another tab can
 * overtake.
 *
 * This tab remembers only the searches that used one of the visitor's searches though "free" was
 * shown (memory only, forgotten with the visitor, web/src/features/auth/visitor.ts), so that their
 * pages can say so.
 *
 * Kept free of the evidence contracts' values and copy, and of the browser: the Ask AI hook,
 * which records what an edit made, loads with the home page, and a Node test holds the rule to
 * the server's (hence the `.js` specifiers).
 */
import type { BriefFilters } from '../../../../shared/contracts/briefs.js';
import type { EvidencePage, EvidenceQuery } from '../../../../shared/contracts/evidence.js';
import { canonicalFilters } from '../ai/canonical-filters.js';

/** The terms the AI added to keyword search (`query.keywords`): beside the question, or instead of it. */
export interface AddedTerms {
  kind: 'question+terms' | 'terms';
  terms: string;
}

/** A question search's added terms, or null (none, or the reader's own words: `source: 'edited'`). */
export function addedTerms(query: EvidenceQuery): AddedTerms | null {
  if (query.source !== 'question' || query.keywords.kind === 'question') return null;
  return { kind: query.keywords.kind, terms: query.keywords.terms };
}

/** True when two sets of filters search the same: facets as sets, empty facets as none, years as given. */
export function sameFilters(a: BriefFilters, b: BriefFilters): boolean {
  return JSON.stringify(canonicalFilters(a)) === JSON.stringify(canonicalFilters(b));
}

/** What an edit sends (`POST /api/evidence`, `kind: 'edited'`), without its keys. */
export interface UndoEdit {
  filters: BriefFilters;
  terms?: string | undefined;
  keywords?: 'question' | undefined;
}

/** What the rule reads of the page being edited. */
export type UndoParent = Pick<EvidencePage, 'undo' | 'query' | 'appliedFilters' | 'automaticFilters'>;

/**
 * The server's rule, as the page states it: true when `edit` of `parent` would be its one free
 * undo. The page's `undo` says the search is an original question search with something added and
 * its undo unused; the edit must then remove only what was added.
 */
export function freeUndoRule(parent: UndoParent, edit: UndoEdit): boolean {
  if (parent.undo !== 'available') return false;
  // Words of the reader's own are a new search, even the same words.
  if (edit.terms !== undefined) return false;
  const removedTerms = edit.keywords === 'question' && addedTerms(parent.query) !== null;
  if (edit.keywords !== undefined && !removedTerms) return false;
  let removedState = false;
  if (!sameFilters(edit.filters, parent.appliedFilters)) {
    // Only the whole automatic state may go: one state of several left is a narrower search.
    const automatic = parent.automaticFilters;
    if (!automatic || automatic.state.length === 0 || !sameFilters({ state: automatic.state }, { state: parent.appliedFilters.state ?? [] })) return false;
    const { state: _state, ...rest } = parent.appliedFilters;
    if (!sameFilters(edit.filters, rest)) return false;
    removedState = true;
  }
  // At least one addition removed: an edit that changes nothing is no undo.
  return removedState || removedTerms;
}

// ---------------------------------------------------------------------------
// This tab's memory

const chargedHere = new Set<string>();

/** Search `id` was made by an edit shown as free, and the server counted it (its `freeUndo` is false). */
export function rememberCharged(id: string): void {
  chargedHere.add(id);
}

/** True when search `id` was shown as a free undo but used one of the visitor's searches. */
export function undoWasCharged(id: string): boolean {
  return chargedHere.has(id);
}

/** Forget everything (the visitor changed, web/src/features/auth/visitor.ts; tests). */
export function forgetUndos(): void {
  chargedHere.clear();
}
