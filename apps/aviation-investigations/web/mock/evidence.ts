/**
 * Mock AI evidence searches (shared/contracts/evidence.ts, `evidence.v3`) for the MSW handlers,
 * the component tests and the end-to-end tests of the evidence view. Everything a page shows is
 * NTSB text from the fixture cases in `cases.json` and coded data from `search-index.json`;
 * offsets are computed from those texts here, never typed by hand, so every excerpt is a verbatim
 * slice of its section at its paragraph span.
 *
 * - **Configuration**: like the server, one mock stands in for one ranking configuration
 *   (`AVIATION_EVIDENCE_RANKING`) and one automatic-filter policy (`AVIATION_EVIDENCE_AUTO_FILTERS`),
 *   the server's defaults (`er-q-v1`, `none`) unless `MockEvidenceOptions.config` names others
 *   (live runs the Haiku rerank of the top 50 with no automatic filter, `MOCK_EVIDENCE_RELEASE`;
 *   the reviewed state policy, off on live, is `MOCK_EVIDENCE_STATE_POLICY`; the attributed
 *   policy of Task 30, live's ranking with a state, years and an aircraft category applied, is
 *   `MOCK_EVIDENCE_FIELDS_POLICY`). The configuration decides what keyword search reads (the
 *   question, the suggested terms, or both: `query.keywords`), whether AI puts the leading results
 *   in order (`order`), whose words are marked (`marks`), and which filters the question names are
 *   applied (`automaticFilters`).
 * - **Retrieval**: a question search ranks every default-cohort fixture case that passes its
 *   filters (none, or those applied automatically) by how often the words keyword search read
 *   occur (probable cause counted three times), then newest first. Filters follow the mock search
 *   engine's own rules, Explore's (an aircraft filter such as the category is met when one
 *   aircraft of an event meets it), not the server's evidence search, where every aircraft of the
 *   event must (DESIGN "Evidence-view MVP"). An edited search applies exactly the filters sent
 *   and ranks by the user's words when it has them, by the question's own words when it restores
 *   them (`keywords: 'question'`), else by the earlier search's words. With a reranking
 *   configuration the leading 50 or 100 cases are put in order by a fixed stand-in for the AI's
 *   grades (the searched words each case's probable cause holds), edits included. Paging is free
 *   and reads the pinned list.
 * - **The suggestion** (a stand-in for the scope stage): a few fixed rules turn words into
 *   Explore filters ("helicopter", "on approach", "IMC", "fatal", "at night", "agricultural", a
 *   US state, "since 2015") and the rest into search words. The state policy may apply only the
 *   guarded state (the server's own guard, shared/state-eligibility.ts); an attributed policy
 *   applies the suggested values of its fields (shared/evidence-auto-filter-fields.ts: the state,
 *   years and aircraft category for `attributed.v1`), standing in for the server's candidate rules
 *   and AI check, which the mock does not run. Terms keyword search read and
 *   applied filters are not suggested again, and a suggestion with nothing left is null. With the
 *   baseline ranking the excerpts mark the suggested terms when there are any, else the words
 *   searched. The server, not the scope stage, reads an explicit counting request (the dashboard
 *   hint) or comparison request with case numbers (the compare hint) from the question; both still
 *   get results. Nothing blocks a search: a question about something else, or asking for
 *   operational advice, gets its results with one of the contract's fixed capability notes
 *   (`EVIDENCE_NOTE_TEXT`) and no suggestion.
 * - **The one free undo**, by the server's rule (server/evidence/undo.ts): an edit of an original
 *   question search the visitor owns, sending no words, that only removes what AirCase added (one
 *   or more whole automatic filters, the added terms, or both) is made without using one of the
 *   visitor's searches (`freeUndo`), once per search; every other edit uses one (`quotaExempt` on
 *   the reply).
 *   Every page read says whether it is still there, as the server computes it from its claim
 *   (`undo`: `available`, `used` once claimed, `none` for an edit or a search with nothing added).
 * - **Projection**: the probable-cause statements in section order; up to three whole
 *   paragraphs (cut as the server cuts them: hard wraps joined, a heading kept with the paragraph
 *   under it) of the factual and analysis sections with
 *   the most matches of the marked words, highlighted as `literal` (the word itself) or
 *   `synonym` (the analyzer's equivalences, shared/aviation-analysis.ts); relevance facts
 *   counted from those excerpts; the channels that would find it.
 *
 * Questions with these words get the other outcomes (as in web/mock/briefs.ts):
 * - "poem", "recipe", "stock" or "bitcoin": the scope note; "what should i do", "right now" or
 *   "should i fly": the operational-advice note; "how many", "how often" or "trend": the
 *   dashboard hint; "compare" or "versus" with case numbers: the compare hint;
 * - "scope failure": the scope stage fails, so the search has no suggestion (results still come);
 * - "nothing": no investigation retrieved;
 * - "expire": the search is created, then reads of it answer 404 (it expired);
 * - "unavailable", "lost before start", "lost response" (the first time a question is asked):
 *   a 503 that releases the admission, a response lost before the search started, and a
 *   response lost after it started (a replay of its key returns it without spending again);
 * - "undo fails": the search's first free undo is admitted, takes the one-use claim and then fails
 *   (a 503, which a replay of its key answers again): the server keeps the claim, so the search's
 *   undo is used and trying again uses one of the visitor's searches;
 * - "rating fails": the search's first rating fails (a 503), so a retry can be seen.
 *
 * Every reply that started a search says how each stage ended (`progress`, for its checklist:
 * web/mock/evidence-progress.ts times the stages), and the owner's latest rating of a search is kept
 * on it (`rate`, Task 25), without the question, for the admin overview's totals.
 */
import {
  EVIDENCE_CANDIDATE_CEILING,
  EVIDENCE_CONTRACT_VERSION,
  EVIDENCE_PAGE_SIZE,
  EVIDENCE_TTL_MS,
  MAX_EXCERPTS_PER_CASE,
  MAX_TERMS_CHARS,
  type CreateEvidenceRequest,
  type CreateEvidenceResponse,
  type EvidenceAutomaticFilters,
  type EvidenceCase,
  type EvidenceExcerpt,
  type EvidenceFeedbackRating,
  type EvidenceNote,
  type EvidencePage,
  type EvidenceRelevance,
} from '../../shared/contracts/evidence.js';
import { BRIEF_FILTER_FACETS, type BriefFilterFacet, type BriefFilters } from '../../shared/contracts/briefs.js';
import type { CaseDetail, Section } from '../../shared/contracts/cases.js';
import type { ErrorResponse } from '../../shared/contracts/common.js';
import { FACET_VALUES, SECTION_LABEL, defaultSearchRequest, type CaseRow, type SearchRequest } from '../../shared/contracts/search.js';
import { EVIDENCE_AUTO_FILTER_FIELDS, type AutomaticFilterField } from '../../shared/evidence-auto-filter-fields.js';
import { DEFAULT_EVIDENCE_AUTO_FILTERS, EVIDENCE_AUTO_FILTER_VERSIONS, type EvidenceAutoFilterVersion } from '../../shared/evidence-auto-filters.js';
import { DEFAULT_EVIDENCE_RANKING, EVIDENCE_RANKING_VERSIONS, type EvidenceRankingVersion } from '../../shared/evidence-ranking.js';
import { eligibleEmittedStates } from '../../shared/state-eligibility.js';
import { US_STATE } from '../../shared/vocab.js';
import { AVIATION_SYNONYMS } from '../../shared/aviation-analysis.js';
import { isNarrativeHeading, wholeNarrativeParagraphs } from '../../shared/narrative-paragraphs.js';
import { searchCorpus, type MockCorpus } from './engine.js';
import type { MockReader, MockReply } from './briefs.js';
import casesJson from './cases.json' with { type: 'json' };
import indexJson from './search-index.json' with { type: 'json' };

const CASES = casesJson as unknown as Record<string, CaseDetail>;
const CORPUS: MockCorpus = { dataset: indexJson.dataset, docs: indexJson.docs as unknown as MockCorpus['docs'], cases: CASES };

/** The seed question of the mock: every fixture case is ranked, three pages. */
export const MOCK_EVIDENCE_QUESTION = 'Engine power loss shortly after maintenance';

/** Sample questions for each state a page can be in (tests and the dev mock mode). */
export const MOCK_EVIDENCE_QUESTIONS = {
  /** A suggestion of words only: 21 cases, three pages. */
  seed: MOCK_EVIDENCE_QUESTION,
  /** A suggested phase filter, not applied; "carburetor" in the text is a synonym match of "carb". */
  carb: 'Carb icing on approach',
  /** Two-aircraft events, event-scoped text. */
  midair: 'Midair collision after departing',
  /** Suggested filters that leave two cases once applied. */
  tiny: 'Helicopter power loss in Texas',
  /** Suggested filters that leave none once applied. */
  empty: 'Fatal balloon accidents in Alaska',
  /** Excerpts with multi-byte characters (’) before the highlights. */
  multibyte: 'Spatial disorientation and loss of control',
  /** The scope stage failed: the question's own results, no suggestion. */
  noSuggestion: 'Bird strike damage, scope failure',
  /** About something else: its results anyway, with the scope note. */
  outOfScope: 'Write a poem about clouds',
  /** Asking for operational advice: its results anyway, with the operational-advice note. */
  operational: 'What should I do right now, my engine is running rough',
  /** An explicit counting request: results, and the dashboard hint. */
  statistics: 'How many helicopter accidents happened in Texas',
  /** An explicit comparison request: results, and the compare hint (one number is in no case). */
  comparison: 'Compare DFW08TA066 and NYC08LA106 with ZZZ99ZZ999',
  /** One case number without a comparison request: results only. */
  single: 'What happened in DFW08TA066',
  /**
   * A state the question names, a suggested phase and terms: with the guarded automatic state
   * (`state-explicit.v1.3`), Texas is applied and the phase stays a suggestion; with terms in
   * keyword search, "carb icing" is searched too and is no longer suggested.
   */
  stateTerms: 'Carb icing on approach in Texas',
  /**
   * The same in a state whose cases hold the suggested terms: with the question alone in keyword
   * search (what live runs), Missouri is applied and the excerpts mark "carb icing".
   */
  stateMarked: 'Carb icing on approach in Missouri',
  /** Two states the question names together: applied as one filter, either state. */
  twoStates: 'Engine power loss in California or Nevada',
  /**
   * A state, years and an aircraft type the question names, a suggested phase and terms: with the
   * attributed policy (`attributed.v1`), Texas, the years from 2008 and helicopters are applied
   * (two cases) and the phase and the terms stay suggestions; the state policy applies Texas alone.
   */
  fields: 'Helicopter power loss on approach in Texas since 2008',
} as const;

// ---------------------------------------------------------------------------
// The configuration the mock stands in for (server `AVIATION_EVIDENCE_RANKING` and
// `AVIATION_EVIDENCE_AUTO_FILTERS`, DESIGN "Evidence.v3")

export interface MockEvidenceConfig {
  /** What keyword search reads, and whether AI puts the leading results in order. */
  ranking: EvidenceRankingVersion;
  /**
   * Whether a state the question names is applied (`state-explicit.v1.3`), a state, years and an
   * aircraft category (`attributed.v1`), or each only suggested (`none`).
   */
  autoFilters: EvidenceAutoFilterVersion;
}

/** The server's defaults: the question alone, in match order, nothing applied automatically. */
export const MOCK_EVIDENCE_BASELINE: MockEvidenceConfig = { ranking: DEFAULT_EVIDENCE_RANKING, autoFilters: DEFAULT_EVIDENCE_AUTO_FILTERS };

/**
 * What live runs (since 31 October 2026): the question alone, the leading results put in order by
 * the Haiku rerank, the reader's words marked, and no filter applied on its own.
 */
export const MOCK_EVIDENCE_RELEASE: MockEvidenceConfig = { ranking: 'er-q-h50-v1', autoFilters: 'none' };
/**
 * The reviewed state policy, off on live: the question alone, in match order, the suggested terms
 * marked, and a state the question names applied by the guarded policy.
 */
export const MOCK_EVIDENCE_STATE_POLICY: MockEvidenceConfig = { ranking: DEFAULT_EVIDENCE_RANKING, autoFilters: 'state-explicit.v1.3' };
/**
 * The attributed policy (Task 30), not on live: live's ranking (the question alone, the leading
 * results put in order by the Haiku rerank, the reader's words marked) with the state, years and
 * aircraft category the question names applied on their own, and the rest suggested.
 */
export const MOCK_EVIDENCE_FIELDS_POLICY: MockEvidenceConfig = { ranking: 'er-q-h50-v1', autoFilters: 'attributed.v1' };

/**
 * The fields an automatic-filter policy may apply (`/api/config` `aiAutomaticFilters`, as the server
 * reports them): the policy's own list (shared/evidence-auto-filter-fields.ts), so a variant that
 * applies fewer fields needs no edit here.
 */
export function automaticFieldsOf(autoFilters: EvidenceAutoFilterVersion): AutomaticFilterField[] {
  return [...EVIDENCE_AUTO_FILTER_FIELDS[autoFilters]];
}

/**
 * Session storage (dev mock mode and end-to-end tests): the configuration the mock API stands in
 * for, as JSON `{"ranking": …, "autoFilters": …}`; anything else is the baseline.
 */
export const MOCK_EVIDENCE_CONFIG_KEY = 'casebook-mock-evidence';

/** A configuration as session storage holds it, or the baseline. */
export function parseMockEvidenceConfig(raw: string | null): MockEvidenceConfig {
  try {
    const v = JSON.parse(raw ?? 'null') as Partial<Record<keyof MockEvidenceConfig, unknown>> | null;
    const ranking = EVIDENCE_RANKING_VERSIONS.find((r) => r === v?.ranking) ?? MOCK_EVIDENCE_BASELINE.ranking;
    const autoFilters = EVIDENCE_AUTO_FILTER_VERSIONS.find((a) => a === v?.autoFilters) ?? MOCK_EVIDENCE_BASELINE.autoFilters;
    return { ranking, autoFilters };
  } catch {
    return MOCK_EVIDENCE_BASELINE;
  }
}

/** What keyword search reads under a ranking configuration (server/evidence/ranking-config.ts). */
function lexicalText(ranking: EvidenceRankingVersion): 'question' | 'terms' | 'question+terms' {
  return ranking.startsWith('er-qt-') ? 'question+terms' : ranking.startsWith('er-t-') ? 'terms' : 'question';
}

/** How many leading results the configuration's reranker orders, or null without one. */
function rerankDepth(ranking: EvidenceRankingVersion): number | null {
  return ranking.includes('-h100-') ? 100 : ranking.includes('-h50-') || ranking.includes('-s50-') ? 50 : null;
}

/** The configuration's reranker (server/evidence/ranking-config.ts): Haiku on the top 50 or 100, Sonnet on the top 50; null without one. */
export function rerankerOf(ranking: EvidenceRankingVersion): { model: 'haiku' | 'sonnet'; depth: 50 | 100 } | null {
  if (ranking.includes('-h50-')) return { model: 'haiku', depth: 50 };
  if (ranking.includes('-h100-')) return { model: 'haiku', depth: 100 };
  if (ranking.includes('-s50-')) return { model: 'sonnet', depth: 50 };
  return null;
}

// ---------------------------------------------------------------------------
// Reading the question (a stand-in for the scope stage)

interface FilterRule {
  pattern: RegExp;
  facet: BriefFilterFacet;
  values: readonly string[];
}

const FILTER_RULES: readonly FilterRule[] = [
  { pattern: /\bhelicopters?\b/i, facet: 'category', values: ['HELI'] },
  { pattern: /\bballoons?\b/i, facet: 'category', values: ['BALL'] },
  { pattern: /\b(?:airplanes?|aeroplanes?)\b/i, facet: 'category', values: ['AIR'] },
  { pattern: /\b(?:on|during)\s+(?:an?\s+|the\s+)?approach\b/i, facet: 'phase', values: ['approach'] },
  { pattern: /\b(?:on|during)\s+(?:the\s+)?landing\b/i, facet: 'phase', values: ['landing'] },
  { pattern: /\b(?:on|during)\s+(?:the\s+)?(?:takeoff|take-off)\b/i, facet: 'phase', values: ['takeoff'] },
  { pattern: /\bclimb-?out\b/i, facet: 'phase', values: ['initial_climb'] },
  { pattern: /\b(?:IMC|instrument(?:\s+meteorological)?\s+conditions)\b/i, facet: 'conditions', values: ['IMC'] },
  { pattern: /\bfatal\b/i, facet: 'injury', values: ['FATL'] },
  { pattern: /\b(?:at\s+)?night\b/i, facet: 'light', values: ['NITE', 'NDRK', 'NBRT'] },
  { pattern: /\b(?:agricultural|crop[- ]dusting)\b/i, facet: 'purpose', values: ['AAPL'] },
];

/** Words a question is made of that are never search words. */
const NOT_TERMS = new Set([
  ...'a an and are as at be but by for if in into is it of on or such that the their then there these they this to was will with'.split(' '),
  ...'what which how where when why who did does do show find me any all were from about during since between within after before'.split(' '),
  ...'accident accidents incident incidents crash crashes case cases investigation investigations event events happened involving my i should'.split(' '),
  ...'shortly soon right just immediately caused because due led resulted without never sign followed recent recently years year found'.split(' '),
  ...'many often compare comparing versus vs'.split(' '),
]);

/** The words of a question, with their offsets: letters, never a piece of a case number ("DFW08TA066"). */
function plainWords(question: string): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  for (const m of question.matchAll(/[A-Za-z][A-Za-z'-]*/g)) {
    const end = m.index + m[0].length;
    if (/\d/.test(question[m.index - 1] ?? '') || /\d/.test(question[end] ?? '')) continue;
    out.push({ word: m[0].toLowerCase().replace(/['’]s$/, ''), start: m.index, end });
  }
  return out;
}

const STATES = Object.entries(US_STATE) as [string, string][];

/** The scope stage's suggestion for a case-search question: filters and words, never applied. */
type Suggestion = NonNullable<EvidencePage['suggestion']>;
type ScopeSuggestion = { filters: BriefFilters; terms: string };
type Query = EvidencePage['query'];
type Keywords = Extract<Query, { source: 'question' }>['keywords'];
type Hint = NonNullable<EvidencePage['hint']>;

/** Filters and search words suggested for a question (a stand-in for the scope stage). */
export function suggestFor(question: string): ScopeSuggestion {
  const filters: Record<string, string[] | number> = {};
  const consumed: [number, number][] = [];
  const addValues = (facet: BriefFilterFacet, values: readonly string[]): void => {
    const current = (filters[facet] as string[] | undefined) ?? [];
    filters[facet] = [...new Set([...current, ...values])];
  };
  for (const rule of FILTER_RULES) {
    const m = rule.pattern.exec(question);
    if (!m) continue;
    addValues(rule.facet, rule.values);
    consumed.push([m.index, m.index + m[0].length]);
  }
  for (const [code, name] of STATES) {
    const m = new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`).exec(question);
    if (!m) continue;
    addValues('state', [code]);
    consumed.push([m.index, m.index + m[0].length]);
  }
  const since = /\bsince\s+((?:19|20)\d{2})\b/i.exec(question);
  if (since) {
    filters.yearFrom = Number(since[1]);
    consumed.push([since.index, since.index + since[0].length]);
  }
  const free = (start: number, end: number): boolean => consumed.every(([s, e]) => end <= s || start >= e);
  const words: string[] = [];
  // When every word became a filter ("fatal balloon accidents in Alaska"), the filter words are the terms.
  const filterWords: string[] = [];
  for (const { word, start, end } of plainWords(question)) {
    if (NOT_TERMS.has(word)) continue;
    const list = free(start, end) ? words : filterWords;
    if (!list.includes(word)) list.push(word);
  }
  let terms = (words.length > 0 ? words : filterWords).join(' ').slice(0, MAX_TERMS_CHARS).trim();
  if (terms === '') terms = question.trim().slice(0, MAX_TERMS_CHARS);
  // Filters in the contract's facet order, years last.
  const ordered: Record<string, unknown> = {};
  for (const facet of BRIEF_FILTER_FACETS) if (filters[facet]) ordered[facet] = filters[facet];
  if (filters.yearFrom !== undefined) ordered.yearFrom = filters.yearFrom;
  return { filters: ordered as BriefFilters, terms };
}

/** The question's own words, as retrieval reads them: never the suggestion. */
export function questionWords(question: string): string {
  const words: string[] = [];
  for (const { word } of plainWords(question)) if (!NOT_TERMS.has(word) && !words.includes(word)) words.push(word);
  return words.join(' ').slice(0, MAX_TERMS_CHARS).trim() || question.trim().slice(0, MAX_TERMS_CHARS);
}

/**
 * The capability note a question's intent selects (a stand-in for the validated scope intent):
 * a fixed reminder of what AirCase is, shown above the results, which still come. Null for a case
 * search.
 */
export function noteFor(question: string): EvidenceNote | null {
  const q = question.toLowerCase();
  if (/\b(poem|recipe|stock|bitcoin)\b/.test(q)) return 'scope';
  if (/what should i do|right now|should i fly/.test(q)) return 'operational_advice';
  return null;
}

/**
 * The non-blocking hint of an explicit counting or comparison request (results still come), read
 * from the question by the server, never from the scope stage; a case number alone, without a
 * comparison request, is no comparison.
 */
export function hintFor(question: string): Hint | null {
  const q = question.toLowerCase();
  if (/how many|how often|\btrend/.test(q)) return { kind: 'corpus_statistics' };
  const numbers = [...new Set(question.toUpperCase().match(/\b[A-Z]{3}\d{2}[A-Z]{2}\d{3}\b/g) ?? [])].slice(0, 4);
  if (/\b(compare|comparing|versus|vs)\b/.test(q) && numbers.length > 0) {
    return { kind: 'case_comparison', found: numbers.filter((n) => n in CASES), notFound: numbers.filter((n) => !(n in CASES)) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching terms in the fixture texts

interface Span {
  start: number;
  end: number;
}

/** One search word, and the word sequences of the synonyms the analyzer expands it to. */
interface Term {
  word: string;
  synonyms: string[][];
}

/** The analyzer's rules (shared/aviation-analysis.ts): equivalences, and one-way rules from their left side only. */
const SYNONYM_RULES = AVIATION_SYNONYMS.map((line) => {
  const [left, right] = line.split('=>').map((part) => part.split(',').map((w) => w.trim()).filter(Boolean));
  return { from: left ?? [], to: right ?? left ?? [] };
});

/** Words of a text, as the server matches them: Unicode letters and digits, case-insensitive, with their UTF-16 offsets. */
function wordsOf(text: string): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu)) out.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length });
  return out;
}

function termOf(word: string): Term {
  const synonyms: string[][] = [];
  for (const rule of SYNONYM_RULES) {
    if (!rule.from.includes(word)) continue;
    for (const alternative of rule.to) {
      const seq = wordsOf(alternative).map((w) => w.word);
      if (seq.length > 0 && seq.join(' ') !== word && !synonyms.some((x) => x.join(' ') === seq.join(' '))) synonyms.push(seq);
    }
  }
  return { word, synonyms };
}

export function termsOf(terms: string): Term[] {
  const out: Term[] = [];
  for (const { word } of wordsOf(terms)) {
    if (out.some((t) => t.word === word)) continue;
    out.push(termOf(word));
  }
  return out.slice(0, 20);
}

type Hit = Span & { match: 'literal' | 'synonym'; term: string };

/**
 * Every occurrence of the terms in `text` (as the server marks them, Task 23): a literal is the
 * word itself, case-insensitive and word-bounded, never a stem; a synonym is one of the
 * analyzer's expansions of it. Sorted; an overlap keeps the literal, then the longer match.
 */
function hitsIn(text: string, terms: readonly Term[]): Hit[] {
  const words = wordsOf(text);
  const all: Hit[] = [];
  for (const term of terms) {
    words.forEach((w, i) => {
      if (w.word === term.word) all.push({ start: w.start, end: w.end, match: 'literal', term: term.word });
      for (const seq of term.synonyms) {
        if (seq.every((x, k) => words[i + k]?.word === x)) {
          all.push({ start: w.start, end: (words[i + seq.length - 1] as { end: number }).end, match: 'synonym', term: term.word });
        }
      }
    });
  }
  const order = (h: Hit): number => (h.match === 'literal' ? 0 : 1);
  all.sort((a, b) => a.start - b.start || order(a) - order(b) || b.end - a.end);
  const out: Hit[] = [];
  for (const h of all) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) continue;
    out.push(h);
  }
  return out;
}

/**
 * Paragraphs of a section as the server cuts them (shared/narrative-paragraphs.ts, used by the
 * projection and the chunker): hard-wrapped lines joined, and a heading line kept with the
 * paragraph under it, so an excerpt can hold line breaks and start with its heading.
 */
export function paragraphsOf(text: string): Span[] {
  return wholeNarrativeParagraphs(text);
}

// ---------------------------------------------------------------------------
// Ranking and projection

interface Ranked {
  row: Omit<CaseRow, 'snippet'>;
  detail: CaseDetail;
  score: number;
}

/** The fixture cases of the default cohort that pass `filters` (the mock search engine's rules). */
function filtered(filters: BriefFilters): { row: Omit<CaseRow, 'snippet'>; detail: CaseDetail }[] {
  const request: SearchRequest = { ...defaultSearchRequest(), q: '', pageSize: 50, sort: 'newest' };
  const lists = request as unknown as Record<string, string[]>;
  for (const facet of BRIEF_FILTER_FACETS) {
    const values = (filters as Partial<Record<BriefFilterFacet, string[]>>)[facet];
    if (values && values.length > 0) lists[facet] = [...values];
  }
  if (filters.yearFrom !== undefined) request.yearFrom = filters.yearFrom;
  if (filters.yearTo !== undefined) request.yearTo = filters.yearTo;
  return searchCorpus(CORPUS, request).rows.map(({ snippet: _snippet, ...row }) => ({ row, detail: CASES[row.ntsbNo] as CaseDetail }));
}

const narratives = (detail: CaseDetail): Section[] => detail.sections.filter((s) => s.kind !== 'probable_cause');

/** Retrieval: the cases that pass the applied filters, ranked by the query's words alone. */
function rank(filters: BriefFilters, words: string): Ranked[] {
  const terms = termsOf(words);
  const ranked = filtered(filters).map(({ row, detail }) => {
    let score = 0;
    for (const s of detail.sections) score += hitsIn(s.text, terms).length * (s.kind === 'probable_cause' ? 3 : 1);
    return { row, detail, score };
  });
  ranked.sort((a, b) => b.score - a.score || (b.row.date ?? '').localeCompare(a.row.date ?? '') || a.row.ntsbNo.localeCompare(b.row.ntsbNo));
  return ranked.slice(0, EVIDENCE_CANDIDATE_CEILING);
}

/** One whole paragraph as an excerpt, its highlights (of the marked words) relative to the paragraph. */
function excerptOf(section: Section, paragraph: Span, marked: readonly Term[]): EvidenceExcerpt {
  const text = section.text.slice(paragraph.start, paragraph.end);
  const highlights = hitsIn(text, marked).map(({ start, end, match }) => ({ start, end, match }));
  // The retrieved passage: the whole section when it is short (one passage), else the paragraph.
  const seed = section.text.length <= 3_000 ? { start: 0, end: section.text.length } : paragraph;
  return {
    sectionKey: section.key,
    section: section.kind,
    label: SECTION_LABEL[section.kind],
    scope: section.scope,
    aircraftKey: section.aircraftKey,
    revision: section.revision,
    paragraph,
    seed,
    text,
    highlights,
  };
}

/**
 * Up to three paragraphs, chosen by the query's words (never the suggestion's), marked with `marked`.
 * Any section can give one, the probable cause included, as on the server: its previews are the
 * paragraphs of the passages retrieval found, and probable-cause statements are passages too.
 */
function excerptsOf(detail: CaseDetail, terms: readonly Term[], marked: readonly Term[]): EvidenceExcerpt[] {
  const order = { analysis: 0, factual: 1, probable_cause: 2 } as const;
  const candidates = detail.sections.flatMap((section) =>
    paragraphsOf(section.text)
      // A heading with nothing under it (the section's last line) is never an excerpt on its own.
      .filter((p) => p.end - p.start <= 20_000 && !isNarrativeHeading(section.text.slice(p.start, p.end)))
      .map((p) => ({ section, paragraph: p, hits: hitsIn(section.text.slice(p.start, p.end), terms).length })),
  );
  const matching = candidates
    .filter((c) => c.hits > 0)
    .sort((a, b) => b.hits - a.hits || order[a.section.kind] - order[b.section.kind] || a.paragraph.start - b.paragraph.start)
    .slice(0, MAX_EXCERPTS_PER_CASE);
  // Found by similarity alone: the first analysis paragraph stands for the passage it retrieved;
  // a multi-aircraft event whose narratives the words miss has none to show (a case with no
  // mappable passage keeps its facts and probable causes, with no excerpt).
  if (detail.aircraft.length > 1 && !matching.some((c) => c.section.kind !== 'probable_cause')) return [];
  const chosen = matching.length > 0 ? matching : candidates.sort((a, b) => order[a.section.kind] - order[b.section.kind]).slice(0, 1);
  return chosen.map((c) => excerptOf(c.section, c.paragraph, marked));
}

/** The facts of a listing: the applied filters (every case passed them), the marked words counted in the excerpts, the channels. */
function relevanceOf(filters: BriefFilters, detail: CaseDetail, excerpts: readonly EvidenceExcerpt[], terms: readonly Term[], marked: readonly Term[]): EvidenceRelevance {
  const applied: EvidenceRelevance['filters'] = BRIEF_FILTER_FACETS.filter((f) => ((filters as Partial<Record<BriefFilterFacet, string[]>>)[f] ?? []).length > 0);
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) applied.push('years');
  const counted = marked.map((term) => {
    let literal = 0;
    let synonym = 0;
    for (const e of excerpts) {
      for (const h of hitsIn(e.text, [term])) {
        if (h.match === 'literal') literal += 1;
        else synonym += 1;
      }
    }
    return { term: term.word.slice(0, 80), literal, synonym };
  });
  // The channels are the query's: its words in the passages (keyword), every word in the narrative (case-narrative keyword).
  const everywhere = narratives(detail);
  const inPassages = terms.some((t) => everywhere.some((s) => hitsIn(s.text, [t]).length > 0));
  const inNarrative = terms.length > 0 && terms.every((t) => everywhere.some((s) => hitsIn(s.text, [t]).length > 0));
  const channels: EvidenceRelevance['channels'] = [];
  if (inPassages) channels.push('keyword');
  channels.push('similarity');
  if (inNarrative) channels.push('narrative');
  // Only the words that occur, as the server lists them (server/evidence/project.ts).
  return { filters: applied, terms: counted.filter((t) => t.literal + t.synonym > 0), channels };
}

/**
 * The pinned ranking of a search, projected: what every page of it shows. `words` is what
 * retrieval reads (the question's own words, or the user's); `marked`, the words the excerpts
 * mark and the relevance counts (the suggestion's when there is one, else `words`).
 */
export function evidenceCases(filters: BriefFilters, words: string, marked: string = words): EvidenceCase[] {
  const terms = termsOf(words);
  const marks = termsOf(marked);
  return rank(filters, words).map(({ row, detail }, i) => {
    const excerpts = excerptsOf(detail, terms, marks);
    return {
      rank: i + 1,
      case: row,
      report: detail.report,
      probableCauses: detail.sections
        .filter((s) => s.kind === 'probable_cause')
        .map((s) => ({ sectionKey: s.key, scope: s.scope, aircraftKey: s.aircraftKey, revision: s.revision, text: s.text })),
      excerpts,
      relevance: relevanceOf(filters, detail, excerpts, terms, marks),
    };
  });
}

/**
 * The leading `depth` cases put in order as a reranker's grades would (a fixed stand-in: how many
 * of the searched words, up to three, each case's probable cause holds), the match order breaking
 * ties; the cases after them keep their places. Ranks are numbered again.
 */
export function aiOrder(cases: readonly EvidenceCase[], words: string, depth: number): EvidenceCase[] {
  const terms = termsOf(words);
  const grade = (c: EvidenceCase): number => Math.min(3, terms.filter((t) => c.probableCauses.some((p) => hitsIn(p.text, [t]).length > 0)).length);
  const head = cases
    .slice(0, depth)
    .map((c, i) => ({ c, i, g: grade(c) }))
    .sort((a, b) => b.g - a.g || a.i - b.i)
    .map((x) => x.c);
  return [...head, ...cases.slice(depth)].map((c, i) => ({ ...c, rank: i + 1 }));
}

/** Filters as the server compares them: facets as sets in vocabulary order, empty facets left out, years kept. */
function sameFilters(a: BriefFilters, b: BriefFilters): boolean {
  const canonical = (f: BriefFilters): string => {
    const out: Record<string, unknown> = {};
    for (const facet of BRIEF_FILTER_FACETS) {
      const values = (f as Partial<Record<BriefFilterFacet, string[]>>)[facet] ?? [];
      if (values.length > 0) out[facet] = (FACET_VALUES[facet] as readonly string[]).filter((v) => values.includes(v));
    }
    if (f.yearFrom !== undefined) out.yearFrom = f.yearFrom;
    if (f.yearTo !== undefined) out.yearTo = f.yearTo;
    return JSON.stringify(out);
  };
  return canonical(a) === canonical(b);
}

/**
 * What an attributed policy applies of a suggestion: the suggested values of its fields (the state,
 * the years, the aircraft category: all three for `attributed.v1`), as automatic filters, the rest
 * left suggested; null when it suggests none of them. The suggestion loses exactly the applied
 * facets, as on the server (server/evidence/pipeline.ts). The server applies only those its
 * candidate rules and AI check pass; the mock's stand-in for the scope stage suggests only what its
 * question names.
 */
export function attributedOf(filters: BriefFilters, fields: readonly AutomaticFilterField[]): { automatic: EvidenceAutomaticFilters; rest: BriefFilters } | null {
  const { state, yearFrom, yearTo, category } = filters;
  const years = fields.includes('years');
  const automatic: EvidenceAutomaticFilters = {
    ...(fields.includes('state') && state?.length ? { state: [...state] as EvidenceAutomaticFilters['state'] } : {}),
    ...(years && yearFrom !== undefined ? { yearFrom } : {}),
    ...(years && yearTo !== undefined ? { yearTo } : {}),
    ...(fields.includes('category') && category?.length ? { category: [...category] } : {}),
  };
  if (Object.keys(automatic).length === 0) return null;
  const rest = Object.fromEntries(Object.entries(filters).filter(([key]) => !Object.hasOwn(automatic, key))) as BriefFilters;
  return { automatic, rest };
}

/** What the guarded state policy (`state-explicit.v1.3`) applies: the suggested states the server's own guard passes. */
function guardedStateOf(question: string, filters: BriefFilters): { automatic: EvidenceAutomaticFilters; rest: BriefFilters } | null {
  const { states } = eligibleEmittedStates(question, filters.state ?? []);
  if (states.length === 0) return null;
  const { state: _applied, ...rest } = filters;
  return { automatic: { state: states as EvidenceAutomaticFilters['state'] }, rest };
}

/** A question search's applied filters: what its policy applied on its own (the question request carries none). */
function appliedOf(automatic: EvidenceAutomaticFilters | null): BriefFilters {
  if (!automatic) return {};
  const { state, yearFrom, yearTo, category } = automatic;
  return {
    ...(category ? { category: [...category] } : {}),
    ...(state ? { state: [...state] } : {}),
    ...(yearFrom !== undefined ? { yearFrom } : {}),
    ...(yearTo !== undefined ? { yearTo } : {}),
  };
}

/** The keys of the applied filters each automatic filter is: the state set, the years (both bounds, one filter), the aircraft category set. */
const AUTOMATIC_KEYS = { state: ['state'], years: ['yearFrom', 'yearTo'], category: ['category'] } as const satisfies Record<string, readonly (keyof BriefFilters)[]>;

/**
 * The automatic filters an undo may remove whole: those the applied filters still hold as the
 * policy applied them (the applied value is the automatic one), in a fixed order.
 */
function removableAutomatic(applied: BriefFilters, automatic: EvidenceAutomaticFilters | null): (keyof typeof AUTOMATIC_KEYS)[] {
  if (!automatic) return [];
  const out: (keyof typeof AUTOMATIC_KEYS)[] = [];
  if (automatic.state?.length && sameFilters({ state: automatic.state }, { state: applied.state ?? [] })) out.push('state');
  if ((automatic.yearFrom !== undefined || automatic.yearTo !== undefined) && applied.yearFrom === automatic.yearFrom && applied.yearTo === automatic.yearTo) out.push('years');
  if (automatic.category?.length && sameFilters({ category: automatic.category }, { category: applied.category ?? [] })) out.push('category');
  return out;
}

/** What is left of a suggestion once keyword search read its terms: nothing left is no suggestion (server/evidence/disclosure.ts). */
function remainingSuggestion(keywords: Keywords, suggestion: ScopeSuggestion | null): Suggestion | null {
  if (!suggestion) return null;
  const terms = keywords.kind === 'question' ? suggestion.terms : null;
  const hasFilters = Object.values(suggestion.filters).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined));
  return terms === null && !hasFilters ? null : { filters: suggestion.filters, terms };
}

// ---------------------------------------------------------------------------
// The in-memory server

/** The dataset generation pinned searches name (the fixture dataset's revision). */
const GENERATION = indexJson.dataset.revision;

interface MockSearch {
  id: string;
  question: string;
  query: Query;
  appliedFilters: BriefFilters;
  automaticFilters: EvidenceAutomaticFilters | null;
  suggestion: Suggestion | null;
  hint: Hint | null;
  note: EvidenceNote | null;
  order: EvidencePage['order'];
  marks: EvidencePage['marks'];
  /** Made as the one free undo of the search it edits. */
  freeUndo: boolean;
  /** The words keyword search read; an edit that sends no words reads them again. */
  lexical: string;
  /** Made by an edit: never the parent of a free undo. */
  edited: boolean;
  /** Its one free undo is used. */
  undoClaimed: boolean;
  cases: EvidenceCase[];
  createdAt: Date;
  owner: MockReader;
  /** Reads answer 404 from now on ("expire" in the question). */
  expired: boolean;
  /** The owner's latest rating of it (`POST /api/evidence/:id/feedback`), kept without the question. */
  rating: EvidenceFeedbackRating | null;
}

/** A UTC instant, as the contract writes the search's times (`2026-10-25T22:13:00.000Z`). */
const stamp = (d: Date): string => d.toISOString();

const error = (status: number, code: ErrorResponse['error'], message: string): MockReply<never> => ({ status, body: { error: code, message } });
const NOT_FOUND = (): MockReply<never> => error(404, 'not_found', 'No AI search with that link is available. AI searches expire after 24 hours.');

/**
 * How each stage of a search ended, for its checklist (web/mock/evidence-progress.ts times them):
 * what the question stage gave (`skipped` for an edit), how many cases retrieval found (null when
 * the search failed there) and the order (`skipped` without a reranker); `failedAt`: the stage a
 * search admitted and then lost failed at (a 503 after admission).
 */
export interface MockStageOutcome {
  question: 'suggestions' | 'note' | 'nothing_to_suggest' | 'unavailable' | 'skipped';
  cases: number | null;
  order: 'ai_relevance' | 'match' | 'skipped';
  failedAt?: 'search';
}

/**
 * A reply to `POST /api/evidence`; `quotaExempt`: the search is the one free undo, so it uses none
 * of the visitor's searches; `progress`: how its stages ended, when it started any (a refusal or a
 * replay starts none).
 */
export type MockEvidenceReply = MockReply<CreateEvidenceResponse> & { quotaExempt?: boolean; progress?: MockStageOutcome };

type EditRequest = Extract<CreateEvidenceRequest, { kind: 'edited' }>;

export interface MockEvidenceOptions {
  now?: () => Date;
  /** Who is asking now (default: the trial): a search is read only by its owner, like the server. */
  visitor?: () => MockReader;
  /** The ranking configuration and automatic-filter policy the mock stands in for (default: the server's defaults). */
  config?: MockEvidenceConfig;
}

export class MockEvidence {
  private readonly searches = new Map<string, MockSearch>();
  /** Requests by idempotency key, with the request they were sent for. */
  private readonly keys = new Map<string, { request: string; id: string }>();
  /** Keys the server took that made no search (a released admission, a start that failed): a retry is a 409. */
  private readonly unfinished = new Set<string>();
  /** Keys of free undos that failed after admission ("undo fails"): a replay answers the same 503. */
  private readonly failed = new Set<string>();
  private readonly played = new Set<string>();
  private seq = 0;
  private readonly now: () => Date;
  private readonly visitor: () => MockReader;
  readonly config: MockEvidenceConfig;

  constructor(opts: MockEvidenceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.visitor = opts.visitor ?? (() => 'trial');
    this.config = opts.config ?? MOCK_EVIDENCE_BASELINE;
  }

  /** True the first time `what` happens to `question`. */
  private once(what: string, question: string): boolean {
    const key = `${what}:${question}`;
    if (this.played.has(key)) return false;
    this.played.add(key);
    return true;
  }

  private newId(): string {
    this.seq += 1;
    return `00000000-0000-4000-9000-${String(this.seq).padStart(12, '0')}`;
  }

  /** The search when the visitor now asking may read it, and it has not expired. */
  private own(id: string): MockSearch | undefined {
    const search = this.searches.get(id);
    if (!search || search.owner !== this.visitor() || search.expired) return undefined;
    if (this.now().getTime() - search.createdAt.getTime() >= EVIDENCE_TTL_MS) return undefined;
    return search;
  }

  /**
   * Test hook: a search of the given shape, owned by the visitor now asking, as if asked or edited
   * earlier (no cases, so its page reads empty), with its undo claimed when `undoClaimed`, gone when
   * `expired`. Returns its id.
   */
  seedForTests(fields: Pick<MockSearch, 'question' | 'query' | 'appliedFilters' | 'automaticFilters' | 'edited'> & Partial<Pick<MockSearch, 'undoClaimed' | 'freeUndo' | 'expired'>>): string {
    const search: MockSearch = {
      id: this.newId(),
      suggestion: null,
      hint: null,
      note: null,
      order: 'match',
      marks: 'search_words',
      freeUndo: false,
      lexical: fields.question,
      undoClaimed: false,
      cases: [],
      createdAt: this.now(),
      owner: this.visitor(),
      expired: false,
      rating: null,
      ...fields,
    };
    this.searches.set(search.id, search);
    return search.id;
  }

  /** Signing in from a search's page moves it from the trial to the account (the handover). */
  handOver(id: string): void {
    const search = this.searches.get(id);
    if (search?.owner === 'trial') search.owner = 'account';
  }

  /** Deleting the account deletes the searches it reads. */
  dropAccountSearches(): void {
    for (const [id, search] of this.searches) if (search.owner === 'account') this.searches.delete(id);
  }

  /**
   * The search's undo hint at this read (server/evidence/store.ts `pageOf`): an original question
   * search with an automatic filter or added terms has its one free undo until it is claimed; an
   * edit, or a search with nothing added, has none.
   */
  private undoHint(search: MockSearch): EvidencePage['undo'] {
    if (search.edited || search.query.source !== 'question') return 'none';
    if (!search.automaticFilters && search.query.keywords.kind === 'question') return 'none';
    return search.undoClaimed ? 'used' : 'available';
  }

  private page(search: MockSearch, n: number): EvidencePage {
    const total = search.cases.length;
    const first = (n - 1) * EVIDENCE_PAGE_SIZE;
    return {
      version: EVIDENCE_CONTRACT_VERSION,
      id: search.id,
      question: search.question,
      query: search.query,
      appliedFilters: search.appliedFilters,
      automaticFilters: search.automaticFilters,
      order: search.order,
      marks: search.marks,
      freeUndo: search.freeUndo,
      undo: this.undoHint(search),
      suggestion: search.suggestion,
      hint: search.hint,
      note: search.note,
      generation: GENERATION,
      createdAt: stamp(search.createdAt),
      expiresAt: stamp(new Date(search.createdAt.getTime() + EVIDENCE_TTL_MS)),
      total,
      page: n,
      pages: Math.ceil(total / EVIDENCE_PAGE_SIZE),
      cases: search.cases.slice(first, first + EVIDENCE_PAGE_SIZE),
    };
  }

  /**
   * Retrieval and projection: the cases that pass the applied filters, ranked by the words keyword
   * search reads (`lexical`), marking `marked`; with a reranker, the leading ones in AI order.
   */
  private start(
    fields: Omit<MockSearch, 'id' | 'cases' | 'order' | 'createdAt' | 'owner' | 'expired' | 'undoClaimed' | 'rating'>,
    marked: string,
  ): MockSearch {
    const ranked = /\bnothing\b/i.test(fields.question) && !fields.edited ? [] : evidenceCases(fields.appliedFilters, fields.lexical, marked);
    const depth = rerankDepth(this.config.ranking);
    // The server reorders only when the reranker's grades were applied; with no case to grade it keeps the match order.
    const ai = depth !== null && ranked.length > 0;
    const search: MockSearch = {
      id: this.newId(),
      ...fields,
      cases: ai ? aiOrder(ranked, fields.lexical, depth) : ranked,
      order: ai ? 'ai_relevance' : 'match',
      undoClaimed: false,
      createdAt: this.now(),
      owner: this.visitor(),
      expired: false,
      rating: null,
    };
    this.searches.set(search.id, search);
    return search;
  }

  /** How the stages of a search that returned results ended (web/mock/evidence-progress.ts times them). */
  private outcomeOf(search: MockSearch, scopeFailed: boolean): MockStageOutcome {
    const question: MockStageOutcome['question'] = search.edited
      ? 'skipped'
      : search.note !== null
        ? 'note'
        : scopeFailed
          ? 'unavailable'
          : search.suggestion !== null
            ? 'suggestions'
            : 'nothing_to_suggest';
    return { question, cases: search.cases.length, order: rerankDepth(this.config.ranking) === null ? 'skipped' : search.order };
  }

  /** The stages of a search admitted and then lost at retrieval (a 503 after admission). */
  private failedOutcome(edited: boolean): MockStageOutcome {
    return { question: edited ? 'skipped' : 'nothing_to_suggest', cases: null, order: rerankDepth(this.config.ranking) === null ? 'skipped' : 'match', failedAt: 'search' };
  }

  /**
   * The one free undo (server/evidence/undo.ts `canUndo`): `parent` is an original question
   * search whose undo is not used yet; the edit sends no words, and it removes one or more of the
   * parent's whole automatic filters (the state set, both year bounds, the aircraft category set,
   * each still as applied), its added terms (`keywords: 'question'`), or both, and changes nothing
   * else. Removing one state or category of several narrows the search, so it is an ordinary edit.
   */
  private undoable(parent: MockSearch, edit: EditRequest): boolean {
    if (parent.edited || parent.undoClaimed || edit.terms !== undefined || parent.query.source !== 'question') return false;
    const removedTerms = edit.keywords === 'question' && parent.query.keywords.kind !== 'question';
    if (edit.keywords !== undefined && !removedTerms) return false;
    if (sameFilters(edit.filters, parent.appliedFilters)) return removedTerms;
    const removable = removableAutomatic(parent.appliedFilters, parent.automaticFilters);
    for (let removed = 1; removed < 1 << removable.length; removed++) {
      const rest: Record<string, unknown> = { ...parent.appliedFilters };
      removable.forEach((f, i) => {
        if (removed & (1 << i)) for (const key of AUTOMATIC_KEYS[f]) delete rest[key];
      });
      if (sameFilters(edit.filters, rest as BriefFilters)) return true;
    }
    return false;
  }

  /**
   * Whether a request is exempt from the visitor's own search quota before admission (the
   * server's gate and admission): a replay of a known key, or an edit that would be its search's
   * one free undo. Turnstile and every other check still apply.
   */
  quotaExempt(body: CreateEvidenceRequest): boolean {
    if (this.keys.has(body.idempotencyKey) || this.failed.has(body.idempotencyKey)) return true;
    if (body.kind !== 'edited') return false;
    const from = this.own(body.from);
    return from !== undefined && this.undoable(from, body);
  }

  /** `POST /api/evidence`: 201 with page 1 of a new search (nothing blocks a search). */
  create(body: CreateEvidenceRequest): MockEvidenceReply {
    const request = body.kind === 'question' ? `q:${body.question}` : `e:${body.from}:${JSON.stringify(body.filters)}:${body.terms ?? ''}:${body.keywords ?? ''}`;
    if (this.unfinished.has(body.idempotencyKey)) return error(409, 'conflict', 'This request was accepted earlier but did not start. Ask again.');
    if (this.failed.has(body.idempotencyKey)) return error(503, 'unavailable', 'AI search is temporarily unavailable.');
    const earlier = this.keys.get(body.idempotencyKey);
    if (earlier) {
      if (earlier.request !== request) return error(409, 'conflict', 'This request key was used for another search.');
      const search = this.searches.get(earlier.id);
      if (search && search.owner === this.visitor()) return { status: 201, body: { kind: 'results', search: this.page(search, 1) }, replayed: true };
      return NOT_FOUND();
    }
    if (body.kind === 'edited') {
      const from = this.own(body.from);
      if (!from) return NOT_FOUND();
      const free = this.undoable(from, body);
      if (free && /\bundo fails\b/i.test(from.question) && this.once('undo-fails', from.id)) {
        // Admitted as the free undo, its claim taken, then failed: the server keeps the claim.
        from.undoClaimed = true;
        this.failed.add(body.idempotencyKey);
        return { ...error(503, 'unavailable', 'AI search is temporarily unavailable.'), progress: this.failedOutcome(true) };
      }
      // Exactly the filters sent; the user's words when sent, the question's own when restored,
      // else the earlier search's query and words. No scope stage, so no suggestion and nothing
      // applied automatically. One search per edit.
      const query: Query = body.terms !== undefined ? { source: 'edited', terms: body.terms } : body.keywords === 'question' ? { source: 'question', keywords: { kind: 'question' } } : from.query;
      const lexical = body.terms ?? (body.keywords === 'question' ? questionWords(from.question) : from.lexical);
      const search = this.start(
        {
          question: from.question,
          query,
          appliedFilters: body.filters,
          automaticFilters: null,
          suggestion: null,
          hint: null,
          note: null,
          marks: 'search_words',
          freeUndo: free,
          lexical,
          edited: true,
        },
        lexical,
      );
      // The parent's one free undo is used by this search, whatever happens next.
      if (free) from.undoClaimed = true;
      this.keys.set(body.idempotencyKey, { request, id: search.id });
      return { status: 201, body: { kind: 'results', search: this.page(search, 1) }, quotaExempt: free, progress: this.outcomeOf(search, false) };
    }
    const q = body.question.toLowerCase();
    if (/\bunavailable\b/.test(q) && this.once('unavailable', q)) {
      this.unfinished.add(body.idempotencyKey);
      return { ...error(503, 'unavailable', 'AI search is temporarily unavailable.'), progress: this.failedOutcome(false) };
    }
    if (/\blost before start\b/.test(q) && this.once('lost-before-start', q)) {
      this.unfinished.add(body.idempotencyKey);
      return { status: 0, body: null, lost: true };
    }
    // Nothing blocks a search: a policy intent only selects a note (and suggests nothing); a failed
    // scope stage costs only the suggestion. The hint is the server's own reading of the question.
    const note = noteFor(body.question);
    const scope = note !== null || /\bscope failure\b/.test(q) ? null : suggestFor(body.question);
    const hint = hintFor(body.question);
    // What keyword search reads: the question's own words, and the suggested terms when the configuration searches them.
    const words = questionWords(body.question);
    const mode = lexicalText(this.config.ranking);
    const keywords: Keywords = scope && mode !== 'question' ? { kind: mode, terms: scope.terms } : { kind: 'question' };
    const lexical = keywords.kind === 'terms' ? keywords.terms : keywords.kind === 'question+terms' ? `${words} ${keywords.terms}` : words;
    // What the policy applies on its own, only ever of its fields: the guarded policy a state the
    // question names that the server's own guard passes; an attributed policy the suggested values
    // of its fields (the state, years and aircraft category for attributed.v1).
    let suggested = scope;
    let automaticFilters: EvidenceAutomaticFilters | null = null;
    const fields = automaticFieldsOf(this.config.autoFilters);
    const applied = !scope || fields.length === 0 ? null
      : this.config.autoFilters === 'state-explicit.v1.3' ? guardedStateOf(body.question, scope.filters) : attributedOf(scope.filters, fields);
    if (scope && applied) {
      automaticFilters = applied.automatic;
      suggested = { ...scope, filters: applied.rest };
    }
    const suggestion = remainingSuggestion(keywords, suggested);
    // The baseline marks the suggested terms while it suggests some; every other configuration marks the words searched.
    const marks: EvidencePage['marks'] = this.config.ranking === DEFAULT_EVIDENCE_RANKING && suggestion?.terms ? 'suggested_terms' : 'search_words';
    const search = this.start(
      {
        question: body.question,
        query: { source: 'question', keywords },
        appliedFilters: appliedOf(automaticFilters),
        automaticFilters,
        suggestion,
        hint,
        note,
        marks,
        freeUndo: false,
        lexical,
        edited: false,
      },
      marks === 'suggested_terms' && suggestion?.terms ? suggestion.terms : lexical,
    );
    this.keys.set(body.idempotencyKey, { request, id: search.id });
    const created: MockEvidenceReply = { status: 201, body: { kind: 'results', search: this.page(search, 1) }, progress: this.outcomeOf(search, scope === null && note === null) };
    if (/\bexpire/.test(q)) search.expired = true;
    return /\blost response\b/.test(q) && this.once('lost-response', q) ? { ...created, lost: true } : created;
  }

  /** `GET /api/evidence/:id?page=n`: free; reads the pinned ranking. Past the last page is a 404, like a search that is gone. */
  read(id: string, n: number): MockReply<EvidencePage> {
    const search = this.own(id);
    if (!search) return NOT_FOUND();
    const pages = Math.ceil(search.cases.length / EVIDENCE_PAGE_SIZE);
    if (!Number.isInteger(n) || n < 1) return error(400, 'bad_request', 'The page is not valid.');
    if (n > Math.max(1, pages)) return NOT_FOUND();
    return { status: 200, body: this.page(search, n) };
  }

  /**
   * `GET /api/evidence/:id/cases/:ntsbNo`: the full case at the search's own generation, for "Show
   * the full section" (its sections' revisions are the excerpts'); only a case the search ranked,
   * only for its owner. The mock's one generation is the fixture corpus.
   */
  caseOf(id: string, ntsbNo: string): MockReply<CaseDetail> {
    const search = this.own(id);
    if (!search || !search.cases.some((c) => c.case.ntsbNo === ntsbNo)) return NOT_FOUND();
    return { status: 200, body: CASES[ntsbNo] as CaseDetail };
  }

  /**
   * `POST /api/evidence/:id/feedback` → 204: the owner's rating of their search, the latest
   * counting; only for its owner while it lives (404 otherwise). No quota and no provider call.
   * "rating fails" in the question fails the search's first rating (a 503), so a retry can be seen.
   */
  rate(id: string, rating: EvidenceFeedbackRating): MockReply<null> {
    const search = this.own(id);
    if (!search) return NOT_FOUND();
    if (/\brating fails\b/i.test(search.question) && this.once('rating-fails', search.id)) return error(503, 'unavailable', 'AI search is temporarily unavailable.');
    search.rating = rating;
    return { status: 204, body: null };
  }

  /** The ratings this mock was given, each search's latest (for the admin overview's totals). */
  ratingCounts(): { useful: number; notUseful: number } {
    let useful = 0;
    let notUseful = 0;
    for (const search of this.searches.values()) {
      if (search.rating === 'useful') useful += 1;
      else if (search.rating === 'not_useful') notUseful += 1;
    }
    return { useful, notUseful };
  }
}
