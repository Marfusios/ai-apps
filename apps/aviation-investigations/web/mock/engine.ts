/**
 * Mock keyword search over the fixture corpus, for the dev mock API and tests.
 * It answers `SearchRequest` with a contract-valid `SearchResponse` and keeps the
 * real counting rules (distinct events, disjunctive facets, defining-event phase,
 * multi-aircraft overlap, "remove one filter" totals). Matching is a simple
 * stand-in for the Elasticsearch analyzer: all words must match, quoted phrases
 * match as phrases, a light stemmer and a tiny synonym list. Runs in the browser
 * and in Node; no DOM or Node APIs.
 */
import type { CaseDetail } from '../../shared/contracts/cases.js';
import type { Dataset } from '../../shared/contracts/common.js';
import {
  BLANK,
  COMPLETION_FACET_VALUES,
  FACET_KEYS,
  FACET_VALUES,
  facetValueLabel,
  isUnknownFacetValue,
  type CaseRow,
  type FacetBucket,
  type FacetKey,
  type RelaxationDrop,
  type SearchRequest,
  type SearchResponse,
  type SectionKind,
  type Snippet,
} from '../../shared/contracts/search.js';
import { excerptSnippet, mergeSpans, previewSnippet } from '../../shared/snippet.js';

/** Facets whose values belong to one aircraft (the server's nested `aircraft` clause). */
export const MOCK_AIRCRAFT_FACETS = ['phase', 'category', 'engine', 'far_part', 'purpose'] as const satisfies readonly FacetKey[];
export type MockAircraftFacet = (typeof MOCK_AIRCRAFT_FACETS)[number];
/** One aircraft's facet values (`engine`: its distinct engine types, or `blank` when none is recorded). */
export type MockAircraftValues = Record<MockAircraftFacet, string[]>;

/** One searchable event: its result row (without snippet), facet values and extra text. */
export interface MockDoc {
  row: Omit<CaseRow, 'snippet'>;
  year: number | null;
  /** Distinct values per facet; aircraft facets hold the union over the aircraft. */
  facets: Record<FacetKey, string[]>;
  /**
   * Per-aircraft values of the aircraft facets. As on the server, one aircraft must
   * match every selected aircraft facet; an event without aircraft rows counts as one
   * aircraft with every value blank.
   */
  aircraft: MockAircraftValues[];
  defaultCohort: boolean;
  /** Make, model, registration, place and case number: matched, never shown as a snippet. */
  fields: string;
}

export interface MockCorpus {
  dataset: Dataset;
  docs: readonly MockDoc[];
  cases: Readonly<Record<string, CaseDetail>>;
}

// ---------------------------------------------------------------------------
// Text analysis

/** English stop words minus negations (amendment A12). */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it',
  'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to',
  'was', 'will', 'with',
]);

/** A few of the curated aviation synonyms (UI_DESIGN §4.2). */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  carb: ['carburetor'],
  wx: ['weather'],
  cfi: ['flight instructor'],
};

export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, '').replace(/['’]/g, '');
  if (w.length >= 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length >= 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length >= 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length >= 5 && /(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length >= 4 && /([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length >= 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

interface Token {
  stem: string;
  start: number;
  end: number;
}

const WORD = /[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    const s = stem(m[0]);
    if (s !== '' && !STOP_WORDS.has(m[0].toLowerCase())) out.push({ stem: s, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** A query clause: any one alternative must match; an alternative is a stem sequence. */
type Clause = readonly (readonly string[])[];

export function parseQuery(q: string): Clause[] {
  const clauses: Clause[] = [];
  const phrase = /"([^"]*)"/g;
  let rest = q;
  for (const m of q.matchAll(phrase)) {
    const stems = tokenize(m[1] ?? '').map((t) => t.stem);
    if (stems.length > 0) clauses.push([stems]);
    rest = rest.replace(m[0], ' ');
  }
  for (const m of rest.matchAll(WORD)) {
    const word = m[0].toLowerCase();
    if (STOP_WORDS.has(word)) continue;
    const alternatives: string[][] = [[stem(word)]];
    for (const synonym of SYNONYMS[word] ?? []) alternatives.push(tokenize(synonym).map((t) => t.stem));
    clauses.push(alternatives);
  }
  return clauses;
}

function matchPositions(tokens: readonly Token[], alternative: readonly string[]): number[] {
  const hits: number[] = [];
  for (let i = 0; i + alternative.length <= tokens.length; i++) {
    if (alternative.every((s, k) => tokens[i + k]?.stem === s)) hits.push(i);
  }
  return hits;
}

function clauseMatches(tokens: readonly Token[], clause: Clause): boolean {
  return clause.some((alt) => matchPositions(tokens, alt).length > 0);
}

/**
 * Token spans in `tokens` that match any clause, sorted; spans that overlap or are
 * separated only by spaces in `text` merge, so "carburetor icing" is one mark.
 */
function highlightSpans(tokens: readonly Token[], clauses: readonly Clause[], text = ''): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const clause of clauses) {
    for (const alt of clause) {
      for (const i of matchPositions(tokens, alt)) {
        spans.push({ start: (tokens[i] as Token).start, end: (tokens[i + alt.length - 1] as Token).end });
      }
    }
  }
  return mergeSpans(spans, text);
}

// ---------------------------------------------------------------------------
// Per-case analysis (cached)

interface AnalyzedSection {
  kind: SectionKind;
  text: string;
  tokens: Token[];
}

interface Analyzed {
  sections: AnalyzedSection[];
  fields: Token[];
}

const analysisCache = new WeakMap<MockCorpus, Map<string, Analyzed>>();

function analyze(corpus: MockCorpus, doc: MockDoc): Analyzed {
  let cache = analysisCache.get(corpus);
  if (!cache) {
    cache = new Map();
    analysisCache.set(corpus, cache);
  }
  const hit = cache.get(doc.row.ntsbNo);
  if (hit) return hit;
  const detail = corpus.cases[doc.row.ntsbNo];
  const sections = (detail?.sections ?? []).map((s) => ({ kind: s.kind, text: s.text, tokens: tokenize(s.text) }));
  const analyzed = { sections, fields: tokenize(doc.fields) };
  cache.set(doc.row.ntsbNo, analyzed);
  return analyzed;
}

interface Matched {
  doc: MockDoc;
  anywhere: boolean;
  probableCause: boolean;
  score: number;
}

function matchDoc(corpus: MockCorpus, doc: MockDoc, clauses: readonly Clause[]): Matched {
  if (clauses.length === 0) return { doc, anywhere: true, probableCause: true, score: 0 };
  const a = analyze(corpus, doc);
  const all = [...a.sections.map((s) => s.tokens), a.fields];
  const causes = a.sections.filter((s) => s.kind === 'probable_cause').map((s) => s.tokens);
  const anywhere = clauses.every((c) => all.some((tokens) => clauseMatches(tokens, c)));
  const probableCause = clauses.every((c) => causes.some((tokens) => clauseMatches(tokens, c)));
  let score = 0;
  if (anywhere) {
    for (const s of a.sections) score += highlightSpans(s.tokens, clauses).length * (s.kind === 'probable_cause' ? 3 : 1);
  }
  return { doc, anywhere, probableCause, score };
}

// ---------------------------------------------------------------------------
// Filters

type Except = FacetKey | 'years' | 'mentionedIn' | null;

const isAircraftFacet = (facet: FacetKey): facet is MockAircraftFacet => (MOCK_AIRCRAFT_FACETS as readonly string[]).includes(facet);

const BLANK_AIRCRAFT: MockAircraftValues = { phase: [BLANK], category: [BLANK], engine: [BLANK], far_part: [BLANK], purpose: [BLANK] };

/** The event's aircraft that satisfy every selected aircraft facet other than `except`. */
function qualifyingAircraft(doc: MockDoc, req: SearchRequest, except: Except): MockAircraftValues[] {
  const aircraft = doc.aircraft.length > 0 ? doc.aircraft : [BLANK_AIRCRAFT];
  return aircraft.filter((a) =>
    MOCK_AIRCRAFT_FACETS.every((facet) => {
      const selected = req[facet] as readonly string[];
      return facet === except || selected.length === 0 || a[facet].some((v) => selected.includes(v));
    }),
  );
}

function passes(m: Matched, req: SearchRequest, except: Except): boolean {
  if (except !== 'mentionedIn' && !(req.mentionedIn === 'probable_cause' ? m.probableCause : m.anywhere)) return false;
  if (except === 'mentionedIn' && !m.anywhere) return false;
  for (const facet of FACET_KEYS) {
    if (facet === except || isAircraftFacet(facet)) continue;
    const selected = req[facet] as readonly string[];
    if (selected.length === 0) continue;
    if (!m.doc.facets[facet].some((v) => selected.includes(v))) return false;
  }
  if (qualifyingAircraft(m.doc, req, except).length === 0) return false;
  if (except !== 'years') {
    const y = m.doc.year;
    if (req.yearFrom !== undefined && (y === null || y < req.yearFrom)) return false;
    if (req.yearTo !== undefined && (y === null || y > req.yearTo)) return false;
  }
  return true;
}

/** A facet's values for one matched event; aircraft facets count only the aircraft that satisfy the other aircraft facets. */
function valuesFor(doc: MockDoc, facet: FacetKey, req: SearchRequest): string[] {
  if (!isAircraftFacet(facet)) return doc.facets[facet];
  return [...new Set(qualifyingAircraft(doc, req, facet).flatMap((a) => a[facet]))];
}

function buckets(facet: FacetKey, matched: readonly Matched[], req: SearchRequest): FacetBucket[] {
  const selected = req[facet] as readonly string[];
  const counts = new Map<string, number>();
  for (const m of matched) for (const v of valuesFor(m.doc, facet, req)) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const v of selected) if (!counts.has(v)) counts.set(v, 0);
  const order = FACET_VALUES[facet] as readonly string[];
  const rank = (v: string): number => (order.includes(v) ? order.indexOf(v) : order.length);
  const list = [...counts.entries()].map(([value, count]) => ({ value, label: facetValueLabel(facet, value), count }));
  if (facet === 'completion') return list.sort((a, b) => rank(a.value) - rank(b.value));
  return list.sort(
    (a, b) =>
      Number(isUnknownFacetValue(a.value)) - Number(isUnknownFacetValue(b.value)) ||
      b.count - a.count ||
      rank(a.value) - rank(b.value),
  );
}

// ---------------------------------------------------------------------------
// Snippets (shared/snippet.ts)

function snippetFor(corpus: MockCorpus, doc: MockDoc, clauses: readonly Clause[]): Snippet | null {
  const a = analyze(corpus, doc);
  const causes = a.sections.filter((s) => s.kind === 'probable_cause');
  if (clauses.length === 0) {
    const cause = causes[0];
    return cause ? previewSnippet(cause.text) : null;
  }
  for (const cause of causes) {
    const spans = highlightSpans(cause.tokens, clauses, cause.text);
    if (spans.length > 0) return excerptSnippet(cause.kind, cause.text, spans, true);
  }
  const rank: Record<SectionKind, number> = { probable_cause: 0, analysis: 1, factual: 2 };
  let best: { section: AnalyzedSection; spans: { start: number; end: number }[] } | null = null;
  for (const section of [...a.sections].sort((x, y) => rank[x.kind] - rank[y.kind])) {
    const spans = highlightSpans(section.tokens, clauses, section.text);
    if (spans.length > 0 && (!best || spans.length > best.spans.length)) best = { section, spans };
  }
  return best ? excerptSnippet(best.section.kind, best.section.text, best.spans, false) : null;
}

// ---------------------------------------------------------------------------
// Search

function compareRows(sort: SearchRequest['sort']) {
  return (a: Matched, b: Matched): number => {
    const da = a.doc.row.date ?? '';
    const db = b.doc.row.date ?? '';
    if (sort === 'relevance' && a.score !== b.score) return b.score - a.score;
    if (sort === 'oldest') return da.localeCompare(db) || a.doc.row.ntsbNo.localeCompare(b.doc.row.ntsbNo);
    return db.localeCompare(da) || a.doc.row.ntsbNo.localeCompare(b.doc.row.ntsbNo);
  };
}

function yearRange(docs: readonly MockDoc[]): [number, number] | null {
  const years = docs.map((d) => d.year).filter((y): y is number => y !== null);
  return years.length === 0 ? null : [Math.min(...years), Math.max(...years)];
}

export function searchCorpus(corpus: MockCorpus, req: SearchRequest): SearchResponse {
  const clauses = parseQuery(req.q);
  const matched = corpus.docs.map((doc) => matchDoc(corpus, doc, clauses));
  const hits = matched.filter((m) => passes(m, req, null)).sort(compareRows(req.sort));

  const facets = Object.fromEntries(
    FACET_KEYS.map((facet) => [
      facet,
      buckets(
        facet,
        matched.filter((m) => passes(m, req, facet)),
        req,
      ),
    ]),
  ) as SearchResponse['facets'];

  const forMentioned = matched.filter((m) => passes(m, req, 'mentionedIn'));
  const mentionedIn = {
    anywhere: forMentioned.length,
    probable_cause: forMentioned.filter((m) => m.probableCause).length,
  };

  const range = yearRange(corpus.docs);
  const forYears = matched.filter((m) => passes(m, { ...req, completion: [] }, 'years'));
  const years: SearchResponse['years'] = [];
  if (range) {
    for (let year = range[0]; year <= range[1]; year++) {
      const inYear = forYears.filter((m) => m.doc.year === year);
      years.push({ year, completed: inYear.filter((m) => m.doc.defaultCohort).length, other: inYear.filter((m) => !m.doc.defaultCohort).length });
    }
  }

  const relaxations: SearchResponse['relaxations'] = [];
  if (hits.length === 0) {
    const tryDrop = (drop: RelaxationDrop, relaxed: SearchRequest): void => {
      relaxations.push({ drop, count: matched.filter((m) => passes(m, relaxed, null)).length });
    };
    if (req.mentionedIn === 'probable_cause') tryDrop('mentionedIn', { ...req, mentionedIn: 'anywhere' });
    for (const facet of FACET_KEYS) {
      if ((req[facet] as readonly string[]).length > 0) tryDrop(facet, { ...req, [facet]: [] });
    }
    if (req.yearFrom !== undefined || req.yearTo !== undefined) {
      const { yearFrom: _from, yearTo: _to, ...rest } = req;
      tryDrop('years', rest as SearchRequest);
    }
  }

  const first = (req.page - 1) * req.pageSize;
  const rows: CaseRow[] = hits.slice(first, first + req.pageSize).map((m) => ({
    ...m.doc.row,
    snippet: snippetFor(corpus, m.doc, clauses),
  }));

  return {
    dataset: corpus.dataset,
    total: hits.length,
    page: req.page,
    pageSize: req.pageSize,
    rows,
    facets,
    mentionedIn,
    years,
    multiAircraft: hits.filter((m) => m.doc.row.aircraft.length > 1).length,
    relaxations,
  };
}

/** Facet value of a completion class crossed with probable-cause availability. */
export function completionFacetValue(cls: CaseRow['completion']['class'], hasProbableCause: boolean): string {
  if (cls === 'completed') return hasProbableCause ? 'completed_with_cause' : 'completed_without_cause';
  return COMPLETION_FACET_VALUES.includes(cls) ? cls : BLANK;
}
