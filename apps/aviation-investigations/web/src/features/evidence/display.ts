/**
 * Wording of the AI evidence view (UI_DESIGN §4.9): the contract's fixed copy (the heading and
 * the notice, shared/contracts/evidence.ts) and how coded data and counts are said. Nothing here
 * is model text: labels are fixed, values come from the contract's NTSB and coded fields, and
 * the question and typed words are the reader's own. The scope stage's suggestion is shown only
 * under its own label, never applied unless the reader chooses it; what AirCase applied on its
 * own (a state the question names, the AI's terms in keyword search, AI order) is said as such
 * and can be undone (contract `evidence.v3`). The AI's terms are the only model text shown, always
 * quoted and labelled. Copy marked Builder awaits the owner's review.
 */
import { aircraftLetter, aircraftName } from '../../../../shared/case-view';
import { BRIEF_FILTER_FACETS, type BriefFilterFacet, type BriefFilters } from '../../../../shared/contracts/briefs';
import {
  EVIDENCE_CANDIDATE_CEILING,
  EVIDENCE_HEADING,
  EVIDENCE_NOTE_TEXT,
  EVIDENCE_NOTICE,
  EVIDENCE_BOUNDARY,
  EVIDENCE_SUGGESTION_LABEL,
  type EvidenceExcerpt,
  type EvidencePage,
  type EvidenceRelevance,
  type ProbableCauseVariant,
} from '../../../../shared/contracts/evidence';
import { FACET_TITLE, facetValueLabel, type AircraftBrief } from '../../../../shared/contracts/search';
import { formatDate } from '../../../../shared/format';
import { formatCount, numberWord } from '../../lib/format';
import { canonicalFilters } from '../ai/unsettled';
import { addedTerms, sameFilters } from './undo';

export { EVIDENCE_BOUNDARY, EVIDENCE_HEADING, EVIDENCE_NOTE_TEXT, EVIDENCE_NOTICE };

// ---------------------------------------------------------------------------
// Builder copy (Task 23), for the owner's review.

/** What retrieval used (blue: the reader's own question, words and filters). */
export const YOUR_SEARCH_LABEL = 'Your search';
/** The label once the reader has searched again with changed words or filters. */
export const EDITED_LABEL = 'Your edited search';
export const SEARCHED_LABEL = 'Searched for';
export const QUESTION_AS_ASKED = 'Your question, as asked';
export const OWN_WORDS = 'Use your own words';
export const WORDS_LABEL = 'Search words';
export const FILTERS_LABEL = 'Filters';
export const SEARCH_AGAIN = 'Search again';
export const UNDO_CHANGES = 'Undo changes';
export const KEYWORD_SEARCH = 'Show keyword results';
export const EDIT_HINT = 'Change the words or filters to search again.';
export const EMPTY_WORDS = 'Type at least one search word.';
/**
 * The scope stage's suggestion (magenta: the AI's), never applied unless the reader chooses it,
 * under the contract's required label (`EVIDENCE_SUGGESTION_LABEL`).
 */
export const SUGGESTION_LABEL = EVIDENCE_SUGGESTION_LABEL;
export const SUGGESTION_NOTE = 'AI suggested these from your question. Your results come from the question as asked; AirCase applies none of this unless you choose it.';
export const SUGGESTED_FILTERS = 'Suggested filters';
export const TERMS_LABEL = 'Terms';
/** Each makes an edited search, one AI search ("· uses 1" follows on the button). */
export const APPLY_FILTERS = 'Apply these filters';
export const APPLY_BOTH = 'Apply filters and terms';
export const SEARCH_SUGGESTED_TERMS = 'Search these terms';
/** A draft chip or words the reader has not searched with yet (dashed, and said so). */
export const NOT_SEARCHED_YET = 'not searched yet';

// ---------------------------------------------------------------------------
// Builder copy (Task 24, contract `evidence.v3`), for the owner's review: what AirCase added on
// its own, said as such, and the one free undo.

/** The row of the AI's terms that keyword search read beside the question (`question+terms`)… */
export const ALSO_SEARCHED_LABEL = 'Also searched';
/** …or instead of it (`terms`), with a note that similarity search still read the question. */
export const KEYWORDS_SEARCHED_LABEL = 'Keywords searched';
export const KEYWORDS_SEARCHED_NOTE = 'Keyword search used these terms instead of your question; similarity search still used your question.';
/** The small magenta tag on those terms, and what a screen reader hears for it (the chip removes them, like a filter's). */
export const AI_TAG = 'AI';
export const AI_TAG_SPOKEN = 'added by AI';
/** The summary lines' word for the added terms (an empty or tiny result, print): "Also searched (added by AI): “…”". */
export const ADDED_BY_AI = 'added by AI';
/** The tag of a filter applied automatically because the question names it, and what a screen reader hears. */
export const FROM_QUESTION = 'from your question';
export const FROM_QUESTION_SPOKEN = 'added automatically from your question';
/** The suggestion's note when AirCase applied something on its own (a state, or terms). */
export const SUGGESTION_NOTE_AUTOMATIC = 'AI suggested these as well. AirCase applies none of them unless you choose them.';
/** "Search again · free": an undo of what AirCase added, which uses none of the visitor's searches. */
export const FREE_COUNTER = 'free';
/** Said on the search a free-looking undo made when the server counted it after all (its `freeUndo` is false). */
export const UNDO_CHARGED = 'This search used one of your AI searches.';
/** The order the count line names: AI's (`order: 'ai_relevance'`), or the match's. */
export const AI_ORDER = 'leading results ordered by AI for relevance';
export const MATCH_ORDER = 'highest-ranked first';
/** Why the suggestion's buttons are off while the reader's own changes wait for Search again. */
export const DRAFT_PENDING_NOTE = 'Your changes above are not searched yet: search again or undo them before applying the suggestion.';
/** The hints of an explicit counting or comparison request, shown above the results. */
export const STATISTICS_HINT = 'For counts and trends, the dashboard charts the investigations in this snapshot by year, phase and more.';
export const COMPARISON_HINT = 'Comparing named investigations is free; it doesn’t need the AI.';
export const COMPARISON_NONE = 'None of those case numbers is in this snapshot.';
export { EXPIRED_TITLE } from './keys';
export const EXPIRED_TEXT = 'AirCase deletes AI searches after 24 hours, and each one opens only for the person who asked it.';
export const LOAD_FAILED = 'This AI search didn’t load.';
export const PAGE_FAILED = 'The next investigations didn’t load.';
export const EMPTY_TITLE = 'No investigations were retrieved for this search.';
/** The key to the marks: whose words the excerpts mark, and their synonyms (dotted). */
export const LEGEND = { yours: 'your words', suggested: 'the suggested terms', searched: 'the words searched', synonym: 'their synonyms' } as const;
export const FULL_SECTION_GONE = 'This section is no longer in the case record, so it can’t be shown here.';
export const FULL_SECTION_CHANGED = 'This section has changed since your search, so the excerpt is not marked in it.';
export const FULL_SECTION_FAILED = 'The full section didn’t load.';
/** Where a folded probable-cause excerpt's marks are, in the drawer and Compare (its statement is shown above). */
export const FOLDED_ONLY = 'Its excerpt is the probable cause above, marked there.';
export const FOLDED_TOO = 'The probable cause above is marked too.';
/** A ranked case with no passage to quote (the server keeps it, with its facts and probable causes). */
export const NO_EXCERPT = 'No excerpt for this case. Its case page has the whole report narrative.';
/** The paragraph's place, for screen readers, in the full section. */
export const EXCERPT_START = 'Start of the excerpt.';
export const EXCERPT_END = 'End of the excerpt.';

/** "Only one investigation was retrieved." (a tiny result, UI_DESIGN §4.9). */
export function tinyTitle(total: number): string {
  return total === 1 ? 'Only one investigation was retrieved.' : `Only ${numberWord(total)} investigations were retrieved.`;
}

/** A result this small shows its filters and the free way out under the cards. */
export const TINY_RESULTS = 3;

/** "Keyword search for “carb icing”, without filters" (free; the way out of an empty or tiny result). */
export function withoutFiltersLabel(terms: string): string {
  return `Keyword search for “${terms}”, without filters`;
}

/** The words a search ran with: the reader's own, or the question as asked. */
export function queryWords(search: Pick<EvidencePage, 'question' | 'query'>): string {
  return search.query.source === 'edited' ? search.query.terms : search.question;
}

/**
 * Whose words the excerpts mark and the relevance facts count (the server's `marks`): the
 * suggested terms (`suggested_terms`), or the words searched (`search_words`), which are the
 * reader's own (their question, or the words they typed) unless AirCase added terms to keyword
 * search: then they are "the words searched".
 */
export type MarkedWords = 'yours' | 'suggested' | 'searched';

/** What a search's relevance facts are said against: the filters it applied, and whose words it marks. */
export interface RelevanceContext {
  appliedFilters: BriefFilters;
  marked: MarkedWords;
}

export function markedWords(search: Pick<EvidencePage, 'marks' | 'query'>): MarkedWords {
  if (search.marks === 'suggested_terms') return 'suggested';
  return addedTerms(search.query) ? 'searched' : 'yours';
}

export function relevanceContext(search: Pick<EvidencePage, 'appliedFilters' | 'marks' | 'query'>): RelevanceContext {
  return { appliedFilters: search.appliedFilters, marked: markedWords(search) };
}

/** The relevance facts' word counts, said as whose words they are. */
const MARKED_IN_EXCERPTS: Readonly<Record<MarkedWords, string>> = { suggested: 'Suggested terms', yours: 'Your words', searched: 'Words searched' };

/**
 * "21 retrieved · highest-ranked first · not every matching investigation" (DESIGN §5: never all
 * matches), or, when AI put the leading results in order (`order: 'ai_relevance'`), "21 retrieved ·
 * leading results ordered by AI for relevance · not every matching investigation". Fixed words:
 * never a grade or anything the AI wrote.
 */
export function countLine(total: number, order: EvidencePage['order']): string {
  const ceiling = total >= EVIDENCE_CANDIDATE_CEILING ? ` · the most one search ranks` : '';
  return `${formatCount(total)} retrieved · ${order === 'ai_relevance' ? AI_ORDER : MATCH_ORDER}${ceiling} · not every matching investigation`;
}

/** What a screen reader hears when a search's results open: "21 investigations retrieved." */
export function arrivalLine(total: number): string {
  if (total === 0) return EMPTY_TITLE;
  return `${formatCount(total)} ${total === 1 ? 'investigation' : 'investigations'} retrieved.`;
}

/** "Showing 1–10 of 21". */
export function showingLine(shown: number, total: number): string {
  return `Showing 1–${formatCount(shown)} of ${formatCount(total)}`;
}

/** "Show 10 more" (the next page's size, never past the total). */
export function showMoreLabel(shown: number, total: number, pageSize: number): string {
  return `Show ${formatCount(Math.min(pageSize, total - shown))} more`;
}

/** "That’s all 21 retrieved." (a tiny result says how many in its own box instead) */
export function allShownLine(total: number): string {
  return `That’s all ${formatCount(total)} retrieved.`;
}

/** "Only you can open this search. AirCase deletes it on 25 Oct 2026 at 22:00 UTC." (the contract's times are UTC) */
export function expiryLine(expiresAt: string): string {
  const time = expiresAt.slice(11, 16);
  return `Only you can open this search. AirCase deletes it on ${formatDate(expiresAt.slice(0, 10))} at ${time} UTC.`;
}

// ---------------------------------------------------------------------------
// Filters

/** The facets of `filters` that hold values, in the contract's order. */
function appliedFacets(filters: BriefFilters): BriefFilterFacet[] {
  return BRIEF_FILTER_FACETS.filter((f) => ((filters as Partial<Record<BriefFilterFacet, string[]>>)[f] ?? []).length > 0);
}

/** "Years: 2015–2020", "Years: from 2015", "Years: to 2010", "Year: 2015"; null without years. */
export function yearsInWords(filters: Pick<BriefFilters, 'yearFrom' | 'yearTo'>): string | null {
  const { yearFrom: from, yearTo: to } = filters;
  if (from === undefined && to === undefined) return null;
  if (from !== undefined && to !== undefined) return from === to ? `Year: ${from}` : `Years: ${from}–${to}`;
  return from !== undefined ? `Years: from ${from}` : `Years: to ${to}`;
}

/** "Phase: Approach or Landing": a filter as it was applied. */
export function facetInWords(filters: BriefFilters, facet: BriefFilterFacet): string {
  const values = (filters as Partial<Record<BriefFilterFacet, string[]>>)[facet] ?? [];
  return `${FACET_TITLE[facet]}: ${values.map((v) => facetValueLabel(facet, v)).join(' or ')}`;
}

/**
 * Every applied filter in words, years last. With `automatic` (the page's `automaticFilters`),
 * a facet AirCase applied on its own is tagged: "Location: Texas (from your question)".
 */
export function filtersInWords(filters: BriefFilters, automatic: EvidencePage['automaticFilters'] = null): string[] {
  const words = appliedFacets(filters).map((f) => {
    const values = (filters as Partial<Record<BriefFilterFacet, string[]>>)[f] ?? [];
    const tagged = f === 'state' && automatic !== null && values.every((v) => (automatic.state as readonly string[]).includes(v));
    return tagged ? `${facetInWords(filters, f)} (${FROM_QUESTION})` : facetInWords(filters, f);
  });
  const years = yearsInWords(filters);
  return years ? [...words, years] : words;
}

/**
 * What keyword search read, in words, for the lines that sum a search up (an empty or tiny
 * result): "Your question, as asked · Also searched (added by AI): “carb icing”", or the reader's
 * own words.
 */
export function searchedInWords(search: Pick<EvidencePage, 'question' | 'query'>): string[] {
  if (search.query.source === 'edited') return [`Search words: “${search.query.terms}”`];
  const added = addedTerms(search.query);
  if (!added) return [QUESTION_AS_ASKED];
  return [QUESTION_AS_ASKED, `${added.kind === 'terms' ? KEYWORDS_SEARCHED_LABEL : ALSO_SEARCHED_LABEL} (${ADDED_BY_AI}): “${added.terms}”`];
}

/**
 * Whether the page shows an edited search ("Your edited search"): the reader's own words, an
 * undo, filters the question did not apply on its own, or added terms on a search without an undo
 * (an original question search with something added has one, available or used: `undo` is not
 * `none`). An edit that kept the question alone and has no filter left reads as the question's own
 * search, as the page cannot tell them apart.
 */
export function isEditedSearch(search: Pick<EvidencePage, 'query' | 'appliedFilters' | 'automaticFilters' | 'freeUndo' | 'undo'>): boolean {
  if (search.undo !== 'none') return false;
  return search.query.source === 'edited' || search.freeUndo || addedTerms(search.query) !== null || !sameFilters(search.appliedFilters, search.automaticFilters ?? {});
}

/**
 * The suggestion on one line, under its label (what print keeps of it): "Suggested filters and
 * terms — not applied: Phase: Approach · “carb icing”", without terms once they were searched.
 */
export function suggestionInWords(suggestion: NonNullable<EvidencePage['suggestion']>): string {
  return `${SUGGESTION_LABEL}: ${[...filtersInWords(suggestion.filters), ...(suggestion.terms !== null ? [`“${suggestion.terms}”`] : [])].join(' · ')}`;
}

/** The search's filters with the suggested ones added (Apply): what AirCase applied stays applied. */
export function withSuggestedFilters(applied: BriefFilters, suggested: BriefFilters): BriefFilters {
  const out = { ...applied } as Partial<Record<BriefFilterFacet, string[]>> & BriefFilters;
  for (const facet of BRIEF_FILTER_FACETS) {
    const values = (suggested as Partial<Record<BriefFilterFacet, string[]>>)[facet] ?? [];
    if (values.length > 0) out[facet] = [...new Set([...(out[facet] ?? []), ...values])];
  }
  if (suggested.yearFrom !== undefined) out.yearFrom = suggested.yearFrom;
  if (suggested.yearTo !== undefined) out.yearTo = suggested.yearTo;
  return out;
}

/**
 * A search the reader is changing: its filters, its words (null: the question as asked), and
 * the terms AirCase added to keyword search while they stay (null: none, or removed).
 */
export interface SearchDraft {
  filters: BriefFilters;
  terms: string | null;
  addedTerms: string | null;
}

/** True when two drafts search the same: the same filters (in any order), words and added terms. */
export function sameSearch(a: SearchDraft, b: SearchDraft): boolean {
  return (
    JSON.stringify(canonicalFilters(a.filters)) === JSON.stringify(canonicalFilters(b.filters)) &&
    (a.terms?.trim() ?? null) === (b.terms?.trim() ?? null) &&
    a.addedTerms === b.addedTerms
  );
}

// ---------------------------------------------------------------------------
// Relevance, in checkable facts only (contract `EvidenceRelevance`)

/** "once", "twice", "3 times". */
export function times(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${formatCount(n)} times`;
}

/** "a", "a and b", "a, b and c". */
export function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const CHANNEL_WORDS: Readonly<Record<EvidenceRelevance['channels'][number], string>> = {
  keyword: 'keyword',
  similarity: 'similarity',
  narrative: 'case-narrative keyword',
};
const CHANNEL_ORDER = ['keyword', 'similarity', 'narrative'] as const;

/** "found by keyword and similarity search" (never "meaning match": similarity search is all it is). */
export function channelsInWords(channels: EvidenceRelevance['channels']): string {
  return `found by ${listInWords(CHANNEL_ORDER.filter((c) => channels.includes(c)).map((c) => CHANNEL_WORDS[c]))} search`;
}

/**
 * One marked word's occurrences in the excerpts shown, literal and synonym said apart: "“carburetor”
 * appears 3 times", "synonyms of “carb” appear 9 times", "“maintenance” does not appear". Counts of
 * words, never a sign that the question is answered.
 */
export function termInWords(t: EvidenceRelevance['terms'][number]): string {
  const word = `“${t.term}”`;
  if (t.literal > 0 && t.synonym > 0) return `${word} appears ${times(t.literal)}, its synonyms ${times(t.synonym)}`;
  if (t.literal > 0) return `${word} appears ${times(t.literal)}`;
  if (t.synonym > 0) return `synonyms of ${word} appear ${times(t.synonym)}`;
  return `${word} does not appear`;
}

/**
 * Why a case is listed, as facts: the applied filters it satisfies, how often each marked word
 * occurs in the excerpts shown, said as the suggested terms, the reader's own words or the words
 * searched (nothing about words when there is no excerpt to count them in), and the searches that
 * found it.
 * "Phase: Approach · Suggested terms in these excerpts: “carburetor” appears 3 times · found by
 * keyword and similarity search".
 */
export function relevanceParts(relevance: EvidenceRelevance, context: RelevanceContext, hasExcerpts = true): string[] {
  const filters = context.appliedFilters;
  const parts: string[] = [];
  for (const facet of BRIEF_FILTER_FACETS) if (relevance.filters.includes(facet)) parts.push(facetInWords(filters, facet));
  if (relevance.filters.includes('years')) {
    const years = yearsInWords(filters);
    if (years) parts.push(years);
  }
  if (hasExcerpts && relevance.terms.length > 0) {
    parts.push(`${MARKED_IN_EXCERPTS[context.marked]} in these excerpts: ${relevance.terms.map(termInWords).join(', ')}`);
  }
  parts.push(channelsInWords(relevance.channels));
  return parts;
}

// ---------------------------------------------------------------------------
// Whose text it is (multi-aircraft events)

type AircraftRef = Pick<AircraftBrief, 'aircraftKey' | 'aircraftNtsbNo' | 'make' | 'model'>;

/** "both aircraft", "all 3 aircraft". */
const everyAircraft = (n: number): string => (n === 2 ? 'both aircraft' : `all ${n} aircraft`);

/**
 * The scope words of a text in a multi-aircraft event: the event (never one aircraft) or the
 * aircraft it names; null in a single-aircraft event, where there is nothing to tell apart.
 */
export function scopeWords(ntsbNo: string, aircraft: readonly AircraftRef[], text: Pick<EvidenceExcerpt, 'scope' | 'aircraftKey'>): string | null {
  if (aircraft.length < 2) return null;
  if (text.scope === 'event') return `Event, ${everyAircraft(aircraft.length)}`;
  const i = aircraft.findIndex((a) => a.aircraftKey === text.aircraftKey);
  if (i < 0) return 'Aircraft not identified';
  const a = aircraft[i] as AircraftRef;
  return `Aircraft ${aircraftLetter(ntsbNo, a.aircraftNtsbNo, i)} · ${aircraftName(a)}`;
}

/**
 * "NTSB · ANALYSIS", with the scope in a multi-aircraft event ("NTSB · ANALYSIS · EVENT, BOTH
 * AIRCRAFT"), and which text of its kind it is when a card shows more than one ("· TEXT 2": an
 * event can carry two factual narratives, one per aircraft's record).
 */
export function excerptLabel(
  ntsbNo: string,
  aircraft: readonly AircraftRef[],
  excerpt: Pick<EvidenceExcerpt, 'label' | 'scope' | 'aircraftKey' | 'sectionKey'>,
  numbered = false,
): string {
  const scope = scopeWords(ntsbNo, aircraft, excerpt);
  const ordinal = numbered ? /-(\d+)$/.exec(excerpt.sectionKey)?.[1] : undefined;
  return ['NTSB', excerpt.label, scope, ordinal ? `Text ${ordinal}` : null].filter((p): p is string => p !== null).join(' · ').toUpperCase();
}

/** The section kinds a card shows from more than one section: their excerpts carry "TEXT n". */
export function numberedKinds(excerpts: readonly Pick<EvidenceExcerpt, 'section' | 'sectionKey'>[]): Set<string> {
  const keys = new Map<string, Set<string>>();
  for (const e of excerpts) keys.set(e.section, (keys.get(e.section) ?? new Set()).add(e.sectionKey));
  return new Set([...keys].filter(([, k]) => k.size > 1).map(([kind]) => kind));
}

/** "NTSB · PROBABLE CAUSE", with its scope and "1 OF 2" when a case has several statements. */
export function probableCauseLabel(ntsbNo: string, aircraft: readonly AircraftRef[], variant: Pick<ProbableCauseVariant, 'scope' | 'aircraftKey'>, index: number, count: number): string {
  const scope = scopeWords(ntsbNo, aircraft, variant);
  const which = count > 1 ? `${index + 1} of ${count}` : null;
  return ['NTSB', 'Probable cause', scope, which].filter((p): p is string => p !== null).join(' · ').toUpperCase();
}

/** "Show the full analysis section". */
export function fullSectionLabel(excerpt: Pick<EvidenceExcerpt, 'label'>): string {
  return `Show the full ${excerpt.label.toLowerCase()} section`;
}

/** What a screen reader hears once a full section has been read: shown at the excerpt, changed, gone, or not loaded. */
export function fullSectionShown(excerpt: Pick<EvidenceExcerpt, 'label'>, state: 'marked' | 'changed' | 'gone' | 'failed'): string {
  if (state === 'marked') return `The full ${excerpt.label.toLowerCase()} section is shown, with the excerpt marked.`;
  if (state === 'changed') return FULL_SECTION_CHANGED;
  if (state === 'gone') return FULL_SECTION_GONE;
  return FULL_SECTION_FAILED;
}
