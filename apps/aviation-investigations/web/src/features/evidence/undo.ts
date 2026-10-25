/**
 * The one free undo of an AI evidence search (contract `evidence.v3`; the server's rule is
 * server/evidence/undo.ts `canUndo`, DESIGN "Evidence.v3"). What AirCase added to a question
 * search on its own (a state the question names, applied as a filter, and the AI's terms in
 * keyword search) can be taken out again without using one of the visitor's searches: once per
 * search, by an edit of the original question search, sending no words of its own, that removes
 * the whole automatic state, the added terms, or both, and changes nothing else. Removing one
 * state of several narrows the search, so that is an ordinary edit. The server decides; the
 * created page's `freeUndo` says what it decided.
 *
 * What a page cannot say, this tab remembers (memory only, forgotten with the visitor,
 * web/src/features/auth/visitor.ts): the searches it made by editing (never an undo's parent),
 * the searches whose free undo it has used, and the searches that used one of the visitor's
 * searches though "free" was shown. A reload forgets them, and the server's answer stands.
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
export type UndoParent = Pick<EvidencePage, 'id' | 'query' | 'appliedFilters' | 'automaticFilters' | 'freeUndo' | 'expiresAt'>;

/** What the page cannot say about itself: from this tab's memory (`undoMemoryOf`). */
export interface UndoKnown {
  /** This tab made the search by editing another. */
  edited: boolean;
  /** Its free undo is used (this tab used it, or the server charged one that looked free). */
  used: boolean;
}

/**
 * True when the page may be an original question search: the reader's words never replaced the
 * question, it is no undo, and it applies exactly what AirCase applied on its own (a question
 * request carries no filters). An edit that kept the question and only removed filters can look
 * the same; this tab remembers its own (`UndoKnown.edited`), and the server knows the rest.
 */
export function mayBeOriginal(page: Pick<EvidencePage, 'query' | 'appliedFilters' | 'automaticFilters' | 'freeUndo'>): boolean {
  return page.query.source === 'question' && !page.freeUndo && sameFilters(page.appliedFilters, page.automaticFilters ?? {});
}

/**
 * The server's rule, as far as this page and this tab can tell: true when `edit` of `parent`
 * would be its one free undo. `now` is when it would be sent (ms since the epoch).
 */
export function freeUndoRule(parent: UndoParent, edit: UndoEdit, known: UndoKnown, now: number): boolean {
  if (known.edited || known.used || !mayBeOriginal(parent) || Date.parse(parent.expiresAt) <= now) return false;
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

const editedHere = new Set<string>();
const usedHere = new Set<string>();
const chargedHere = new Set<string>();

/** What this tab knows of search `id` beyond its page. */
export function undoMemoryOf(id: string): UndoKnown {
  return { edited: editedHere.has(id), used: usedHere.has(id) };
}

/**
 * An edit of `from` made search `made`. `expectedFree`: the edit was shown as free. The created
 * page's `freeUndo` is the server's word: once `from` has made a free undo, or its undo was
 * refused, every later edit of it uses one of the visitor's searches.
 */
export function rememberEdit(from: string, made: Pick<EvidencePage, 'id' | 'freeUndo'>, expectedFree: boolean): void {
  editedHere.add(made.id);
  if (made.freeUndo || expectedFree) usedHere.add(from);
  if (expectedFree && !made.freeUndo) chargedHere.add(made.id);
}

/** True when search `id` was shown as a free undo but used one of the visitor's searches. */
export function undoWasCharged(id: string): boolean {
  return chargedHere.has(id);
}

/** Forget everything (the visitor changed, web/src/features/auth/visitor.ts; tests). */
export function forgetUndos(): void {
  editedHere.clear();
  usedHere.clear();
  chargedHere.clear();
}
