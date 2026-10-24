/**
 * Wording of the AI evidence view (UI_DESIGN §4.9): the contract's fixed copy (the heading,
 * the notice and the unchecked labels, shared/contracts/evidence.ts) and how coded data and
 * counts are said. Nothing here is model text: labels are fixed, values come from the
 * contract's NTSB and coded fields, and the question and quotes are the reader's own words.
 * Copy marked Builder awaits the owner's review.
 */
import { aircraftLetter, aircraftName } from '../../../../shared/case-view';
import { BRIEF_FILTER_FACETS, type BriefFilterFacet, type BriefFilters } from '../../../../shared/contracts/briefs';
import {
  EVIDENCE_CANDIDATE_CEILING,
  EVIDENCE_HEADING,
  EVIDENCE_NOTICE,
  UNCHECKED_LABEL,
  type EvidenceExcerpt,
  type EvidenceInterpretation,
  type EvidenceRelevance,
  type ProbableCauseVariant,
} from '../../../../shared/contracts/evidence';
import { FACET_TITLE, facetValueLabel, type AircraftBrief } from '../../../../shared/contracts/search';
import { formatDate } from '../../../../shared/format';
import { formatCount, numberWord } from '../../lib/format';
import { canonicalFilters } from '../ai/unsettled';

export { EVIDENCE_HEADING, EVIDENCE_NOTICE, UNCHECKED_LABEL };

// ---------------------------------------------------------------------------
// Builder copy (Task 23), for the owner's review.

/** The magenta label of the interpretation the scope stage read from the question. */
export const INTERPRETATION_LABEL = 'AI reading of your question';
/** The label once the reader has changed it (blue: the reader set it). */
export const EDITED_LABEL = 'Your edited search';
export const WORDS_LABEL = 'Search words';
export const FILTERS_LABEL = 'Filters';
export const NOT_APPLIED_LABEL = 'Not applied';
export const NO_FILTERS = 'None';
export const SEARCH_AGAIN = 'Search again';
export const UNDO_CHANGES = 'Undo changes';
export const KEYWORD_SEARCH = 'Show keyword results';
export const EDIT_HINT = 'Change the words or filters to search again.';
export const EDITED_NOTE = 'You changed the words or filters of an earlier AI reading. The readings above that were not applied are from your question.';
export const EMPTY_WORDS = 'Type at least one search word.';
export const EXPIRED_TITLE = 'This AI search is no longer available.';
export const EXPIRED_TEXT = 'AirCase deletes AI searches after 24 hours, and each one opens only for the person who asked it.';
export const LOAD_FAILED = 'This AI search didn’t load.';
export const PAGE_FAILED = 'The next investigations didn’t load.';
export const EMPTY_TITLE = 'No investigations were retrieved for this search.';
export const LEGEND = { literal: 'your words', synonym: 'synonyms AirCase searched too' } as const;
export const FULL_SECTION_GONE = 'This section is no longer in the case record, so it can’t be shown here.';
export const FULL_SECTION_CHANGED = 'This section has changed since your search, so the excerpt is not marked in it.';
export const FULL_SECTION_FAILED = 'The full section didn’t load.';
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

/** "21 retrieved · best match first · not every matching investigation" (DESIGN §5: never all matches). */
export function countLine(total: number): string {
  const ceiling = total >= EVIDENCE_CANDIDATE_CEILING ? ` · the most one search ranks` : '';
  return `${formatCount(total)} retrieved · best match first${ceiling} · not every matching investigation`;
}

/** "Showing 1–10 of 21". */
export function showingLine(shown: number, total: number): string {
  return `Showing 1–${formatCount(shown)} of ${formatCount(total)}`;
}

/** "Show 10 more" (the next page's size, never past the total). */
export function showMoreLabel(shown: number, total: number, pageSize: number): string {
  return `Show ${formatCount(Math.min(pageSize, total - shown))} more`;
}

/** "That’s all 21 retrieved." */
export function allShownLine(total: number): string {
  return total === 1 ? 'That’s the one retrieved.' : `That’s all ${formatCount(total)} retrieved.`;
}

/** "Only you can open this search. AirCase deletes it on 25 Oct 2026 at 22:00 UTC." (the contract's times are UTC) */
export function expiryLine(expiresAt: string): string {
  const time = expiresAt.slice(11, 16);
  return `Only you can open this search. AirCase deletes it on ${formatDate(expiresAt.slice(0, 10))} at ${time} UTC.`;
}

// ---------------------------------------------------------------------------
// Filters and the interpretation

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

/** Every applied filter in words, years last. */
export function filtersInWords(filters: BriefFilters): string[] {
  const words = appliedFacets(filters).map((f) => facetInWords(filters, f));
  const years = yearsInWords(filters);
  return years ? [...words, years] : words;
}

/** True when two interpretations search the same: the same filters (in any order) and words. */
export function sameSearch(a: Pick<EvidenceInterpretation, 'filters' | 'terms'>, b: Pick<EvidenceInterpretation, 'filters' | 'terms'>): boolean {
  return JSON.stringify(canonicalFilters(a.filters)) === JSON.stringify(canonicalFilters(b.filters)) && a.terms.trim() === b.terms.trim();
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

/** One term's count in the excerpts shown: literal occurrences and synonym matches said apart. */
export function termInWords(t: EvidenceRelevance['terms'][number]): string | null {
  const word = `“${t.term}”`;
  if (t.literal > 0 && t.synonym > 0) return `${word} ${times(t.literal)} and a synonym ${times(t.synonym)}`;
  if (t.literal > 0) return `${word} ${times(t.literal)}`;
  if (t.synonym > 0) return `a synonym of ${word} ${times(t.synonym)}`;
  return null;
}

/**
 * Why a case is listed, as facts: the applied filters it satisfies, how often each search word
 * occurs in the excerpts shown (words that do not, named together; nothing about words when
 * there is no excerpt to count them in), and the searches that found it. "Phase: Approach ·
 * “carburetor” 3 times · found by keyword and similarity search".
 */
export function relevanceParts(relevance: EvidenceRelevance, filters: BriefFilters, hasExcerpts = true): string[] {
  const parts: string[] = [];
  for (const facet of BRIEF_FILTER_FACETS) if (relevance.filters.includes(facet)) parts.push(facetInWords(filters, facet));
  if (relevance.filters.includes('years')) {
    const years = yearsInWords(filters);
    if (years) parts.push(years);
  }
  if (hasExcerpts) {
    const counted = relevance.terms.map(termInWords).filter((p): p is string => p !== null);
    parts.push(...counted);
    const absent = relevance.terms.filter((t) => t.literal + t.synonym === 0).map((t) => `“${t.term}”`);
    if (absent.length > 0) parts.push(`not in these excerpts: ${absent.join(', ')}`);
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
