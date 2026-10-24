/**
 * Mock AI evidence searches (shared/contracts/evidence.ts, `evidence.v1`) for the MSW
 * handlers, the component tests and the end-to-end tests of the evidence view. Everything a
 * page shows is NTSB text from the fixture cases in `cases.json` and coded data from
 * `search-index.json`; offsets are computed from those texts here, never typed by hand, so
 * every excerpt is a verbatim slice of its section at its paragraph span.
 *
 * - **Reading the question** (a stand-in for the scope stage `scope.e1`): a few fixed rules
 *   turn words into Explore filters ("helicopter", "on approach", "IMC", "fatal", "at night",
 *   "agricultural", a US state, "since 2015"), the rest into search terms, and phrases the
 *   data cannot check into unchecked readings (timing, causation, absence, sequence, a filter
 *   AirCase does not have, an unclear word), quoted verbatim from the question. The static
 *   scope replies are the server's own templates (server/briefs/static-replies.ts).
 * - **Ranking**: every default-cohort fixture case that passes the filters (the mock search
 *   engine's own filter rules), by how often the terms occur (probable cause counted three
 *   times), then newest first. Paging is free and reads the pinned list.
 * - **Projection**: the probable-cause statements in section order; up to three whole
 *   paragraphs (runs of text between line breaks) of the factual and analysis sections with
 *   the most term matches, highlighted as `literal` (the term, or its stem) or `synonym` (the
 *   analyzer's equivalences, worker/index/synonyms.ts); relevance facts counted from those
 *   excerpts; the channels that would find it.
 *
 * Questions with these words get the other outcomes (as in web/mock/briefs.ts):
 * - "poem", "recipe", "stock" or "bitcoin": out of scope; "what should i do", "right now" or
 *   "should i fly": operational advice; "how many", "how often" or "trend": counting;
 *   "compare" with case numbers: a comparison;
 * - "nothing": no investigation retrieved;
 * - "expire": the search is created, then reads of it answer 404 (it expired);
 * - "unavailable", "lost before start", "lost response" (the first time a question is asked):
 *   a 503 that releases the admission, a response lost before the search started, and a
 *   response lost after it started (a replay of its key returns it without spending again).
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
  type EvidenceCase,
  type EvidenceExcerpt,
  type EvidenceInterpretation,
  type EvidencePage,
  type EvidenceRelevance,
  type UncheckedKind,
  type UncheckedReading,
} from '../../shared/contracts/evidence.js';
import { BRIEF_FILTER_FACETS, type BriefFilterFacet, type BriefFilters, type ScopeReply } from '../../shared/contracts/briefs.js';
import type { CaseDetail, Section } from '../../shared/contracts/cases.js';
import type { ErrorResponse } from '../../shared/contracts/common.js';
import { SECTION_LABEL, defaultSearchRequest, type CaseRow, type SearchRequest } from '../../shared/contracts/search.js';
import { US_STATE } from '../../shared/vocab.js';
import { comparisonReply, operationalReply, outOfScopeReply, statisticsReply } from '../../server/briefs/static-replies.js';
import { AVIATION_SYNONYMS } from '../../shared/aviation-analysis.js';
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
  /** No filters, a timing reading: 21 cases, three pages. */
  seed: MOCK_EVIDENCE_QUESTION,
  /** A phase filter; "carburetor" in the text is a synonym match of "carb". */
  carb: 'Carb icing on approach',
  /** Two-aircraft events, event-scoped text. */
  midair: 'Midair collision after departing',
  /** Two filters that leave two cases. */
  tiny: 'Helicopter power loss in Texas',
  /** Nothing retrieved: no fixture case passes the filters. */
  empty: 'Fatal balloon accidents in Alaska',
  /** Readings of every kind, none of them applied. */
  unchecked:
    'Engine failure shortly after maintenance, caused by fuel contamination, without a mayday call, then a forced landing, for student pilots in recent years',
  /** Excerpts with multi-byte characters (’) before the highlights. */
  multibyte: 'Spatial disorientation and loss of control',
  outOfScope: 'Write a poem about clouds',
  operational: 'What should I do right now, my engine is running rough',
  statistics: 'How many helicopter accidents happened in Texas',
  comparison: 'Compare DFW08TA066 and NYC08LA106',
} as const;

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

const UNCHECKED_RULES: readonly { kind: UncheckedKind; pattern: RegExp }[] = [
  {
    kind: 'timing',
    pattern: /\b(?:(?:shortly|soon|right|just|immediately|days?|hours?|weeks?)\s+)?after\s+(?:an?\s+|the\s+)?(?:maintenance|inspection|annual|oil change|overhaul|repair|engine change)\b/i,
  },
  { kind: 'timing', pattern: /\bwithin\s+\d+\s+(?:flight\s+)?(?:days?|hours?|weeks?|months?)\b/i },
  { kind: 'causation', pattern: /\b(?:caused\s+by|because\s+of|due\s+to|led\s+to|resulted\s+in)\s+[\w-]+(?:\s+[\w-]+)?/i },
  { kind: 'absence', pattern: /\b(?:without|no\s+sign\s+of|never)\s+(?:an?\s+|the\s+)?[\w-]+(?:\s+[\w-]+)?/i },
  { kind: 'sequence', pattern: /\b(?:then|followed\s+by|before)\s+(?:an?\s+|the\s+)?[\w-]+(?:\s+[\w-]+)?/i },
  { kind: 'unsupported_filter', pattern: /\b(?:student|low[- ]time|new|older)\s+pilots?\b/i },
  { kind: 'ambiguous', pattern: /\brecent\s+years\b|\brecently\b/i },
];

/** Words a question is made of that are never search terms. */
const NOT_TERMS = new Set([
  ...'a an and are as at be but by for if in into is it of on or such that the their then there these they this to was will with'.split(' '),
  ...'what which how where when why who did does do show find me any all were from about during since between within after before'.split(' '),
  ...'accident accidents incident incidents crash crashes case cases investigation investigations event events happened involving my i should'.split(' '),
  ...'shortly soon right just immediately caused because due led resulted without never sign followed recent recently years year found'.split(' '),
]);

const STATES = Object.entries(US_STATE) as [string, string][];

/** The question's own words in `[start, end)`, verbatim: a substring of the question. */
const quote = (question: string, start: number, end: number): string => question.slice(start, end).trim();

/** Filters, terms and unchecked readings for a question that is a case search. */
export function readQuestion(question: string): EvidenceInterpretation {
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
  const unchecked: UncheckedReading[] = [];
  for (const rule of UNCHECKED_RULES) {
    const m = rule.pattern.exec(question);
    if (!m || unchecked.length >= 8) continue;
    unchecked.push({ kind: rule.kind, quote: quote(question, m.index, m.index + m[0].length) });
    if (rule.kind === 'unsupported_filter' || rule.kind === 'ambiguous') consumed.push([m.index, m.index + m[0].length]);
  }
  const free = (start: number, end: number): boolean => consumed.every(([s, e]) => end <= s || start >= e);
  const words: string[] = [];
  // When every word became a filter ("fatal balloon accidents in Alaska"), the filter words are the terms.
  const filterWords: string[] = [];
  for (const m of question.matchAll(/[A-Za-z][A-Za-z'-]*/g)) {
    const word = m[0].toLowerCase().replace(/['’]s$/, '');
    if (NOT_TERMS.has(word)) continue;
    const list = free(m.index, m.index + m[0].length) ? words : filterWords;
    if (!list.includes(word)) list.push(word);
  }
  let terms = (words.length > 0 ? words : filterWords).join(' ').slice(0, MAX_TERMS_CHARS).trim();
  if (terms === '') terms = question.trim().slice(0, MAX_TERMS_CHARS);
  // Filters in the contract's facet order, years last.
  const ordered: Record<string, unknown> = {};
  for (const facet of BRIEF_FILTER_FACETS) if (filters[facet]) ordered[facet] = filters[facet];
  if (filters.yearFrom !== undefined) ordered.yearFrom = filters.yearFrom;
  return { filters: ordered as BriefFilters, terms, unchecked };
}

/** The static replies an evidence search can get (never a clarification round). */
export type EvidenceScopeReply = Exclude<ScopeReply, { kind: 'needs_clarification' }>;

/** A static reply instead of a search (the server's own templates), or null for a case search. */
export function scopeReplyFor(question: string): EvidenceScopeReply | null {
  const q = question.toLowerCase();
  const reply = ((): ScopeReply | null => {
    if (/\b(poem|recipe|stock|bitcoin)\b/.test(q)) return outOfScopeReply();
    if (/what should i do|right now|should i fly/.test(q)) return operationalReply();
    if (/how many|how often|\btrend/.test(q)) return statisticsReply(readQuestion(question).filters);
    const numbers = question.toUpperCase().match(/\b[A-Z]{3}\d{2}[A-Z]{2}\d{3}\b/g) ?? [];
    if (/\bcompare\b/.test(q) && numbers.length > 0) return comparisonReply(numbers.slice(0, 4), new Set(Object.keys(CASES)));
    return null;
  })();
  return reply === null || reply.kind === 'needs_clarification' ? null : reply;
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

/** Paragraphs of a section: maximal runs of text between line breaks, without surrounding spaces. */
export function paragraphsOf(text: string): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/[^\n]+/g)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body === '') continue;
    out.push({ start: m.index + lead, end: m.index + lead + body.length });
  }
  return out;
}

/** A line that is only a heading ("HISTORY OF FLIGHT"): never an excerpt on its own. */
const HEADING = /^[A-Z0-9 ,.'’&/()-]{4,60}$/;

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

function rank(interpretation: EvidenceInterpretation): Ranked[] {
  const terms = termsOf(interpretation.terms);
  const ranked = filtered(interpretation.filters).map(({ row, detail }) => {
    let score = 0;
    for (const s of detail.sections) score += hitsIn(s.text, terms).length * (s.kind === 'probable_cause' ? 3 : 1);
    return { row, detail, score };
  });
  ranked.sort((a, b) => b.score - a.score || (b.row.date ?? '').localeCompare(a.row.date ?? '') || a.row.ntsbNo.localeCompare(b.row.ntsbNo));
  return ranked.slice(0, EVIDENCE_CANDIDATE_CEILING);
}

/** One whole paragraph as an excerpt, its highlights relative to the paragraph. */
function excerptOf(section: Section, paragraph: Span, terms: readonly Term[]): EvidenceExcerpt {
  const text = section.text.slice(paragraph.start, paragraph.end);
  const highlights = hitsIn(text, terms).map(({ start, end, match }) => ({ start, end, match }));
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

function excerptsOf(detail: CaseDetail, terms: readonly Term[]): EvidenceExcerpt[] {
  const order = { analysis: 0, factual: 1, probable_cause: 2 } as const;
  const candidates = narratives(detail).flatMap((section) =>
    paragraphsOf(section.text)
      .filter((p) => p.end - p.start <= 20_000 && !HEADING.test(section.text.slice(p.start, p.end)))
      .map((p) => ({ section, paragraph: p, hits: hitsIn(section.text.slice(p.start, p.end), terms).length })),
  );
  const matching = candidates
    .filter((c) => c.hits > 0)
    .sort((a, b) => b.hits - a.hits || order[a.section.kind] - order[b.section.kind] || a.paragraph.start - b.paragraph.start)
    .slice(0, MAX_EXCERPTS_PER_CASE);
  // Found by similarity alone: the first analysis paragraph stands for the passage it retrieved;
  // a multi-aircraft event found that way has none to show (a case with no mappable passage keeps
  // its facts and probable causes, with no excerpt).
  if (matching.length === 0 && detail.aircraft.length > 1) return [];
  const chosen = matching.length > 0 ? matching : candidates.sort((a, b) => order[a.section.kind] - order[b.section.kind]).slice(0, 1);
  return chosen.map((c) => excerptOf(c.section, c.paragraph, terms));
}

function relevanceOf(interpretation: EvidenceInterpretation, detail: CaseDetail, excerpts: readonly EvidenceExcerpt[]): EvidenceRelevance {
  const terms = termsOf(interpretation.terms);
  const applied: EvidenceRelevance['filters'] = BRIEF_FILTER_FACETS.filter((f) => ((interpretation.filters as Partial<Record<BriefFilterFacet, string[]>>)[f] ?? []).length > 0);
  if (interpretation.filters.yearFrom !== undefined || interpretation.filters.yearTo !== undefined) applied.push('years');
  const counted = terms.map((term) => {
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
  const inExcerpts = counted.some((t) => t.literal + t.synonym > 0);
  const everywhere = narratives(detail);
  const inNarrative = terms.length > 0 && terms.every((t) => everywhere.some((s) => hitsIn(s.text, [t]).length > 0));
  const channels: EvidenceRelevance['channels'] = [];
  if (inExcerpts) channels.push('keyword');
  channels.push('similarity');
  if (inNarrative) channels.push('narrative');
  return { filters: applied, terms: counted, channels };
}

/** The pinned ranking of a search, projected: what every page of it shows. */
export function evidenceCases(interpretation: EvidenceInterpretation): EvidenceCase[] {
  const terms = termsOf(interpretation.terms);
  return rank(interpretation).map(({ row, detail }, i) => {
    const excerpts = excerptsOf(detail, terms);
    return {
      rank: i + 1,
      case: row,
      report: detail.report,
      probableCauses: detail.sections
        .filter((s) => s.kind === 'probable_cause')
        .map((s) => ({ sectionKey: s.key, scope: s.scope, aircraftKey: s.aircraftKey, revision: s.revision, text: s.text })),
      excerpts,
      relevance: relevanceOf(interpretation, detail, excerpts),
    };
  });
}

// ---------------------------------------------------------------------------
// The in-memory server

/** The dataset generation pinned searches name (the fixture dataset's revision). */
const GENERATION = indexJson.dataset.revision;

interface MockSearch {
  id: string;
  question: string;
  interpretation: EvidenceInterpretation;
  edited: boolean;
  cases: EvidenceCase[];
  createdAt: Date;
  owner: MockReader;
  /** Reads answer 404 from now on ("expire" in the question). */
  expired: boolean;
}

/** A UTC instant, as the contract writes the search's times (`2026-10-25T22:13:00.000Z`). */
const stamp = (d: Date): string => d.toISOString();

const error = (status: number, code: ErrorResponse['error'], message: string): MockReply<never> => ({ status, body: { error: code, message } });
const NOT_FOUND = (): MockReply<never> => error(404, 'not_found', 'No AI search with that link is available. AI searches expire after 24 hours.');

export interface MockEvidenceOptions {
  now?: () => Date;
  /** Who is asking now (default: the trial): a search is read only by its owner, like the server. */
  visitor?: () => MockReader;
}

export class MockEvidence {
  private readonly searches = new Map<string, MockSearch>();
  /** Requests by idempotency key, with the request they were sent for. */
  private readonly keys = new Map<string, { request: string; id: string }>();
  /** Keys the server took that made no search (a released admission, a start that failed): a retry is a 409. */
  private readonly unfinished = new Set<string>();
  private readonly played = new Set<string>();
  private seq = 0;
  private readonly now: () => Date;
  private readonly visitor: () => MockReader;

  constructor(opts: MockEvidenceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.visitor = opts.visitor ?? (() => 'trial');
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

  /** Signing in from a search's page moves it from the trial to the account (the handover). */
  handOver(id: string): void {
    const search = this.searches.get(id);
    if (search?.owner === 'trial') search.owner = 'account';
  }

  /** Deleting the account deletes the searches it reads. */
  dropAccountSearches(): void {
    for (const [id, search] of this.searches) if (search.owner === 'account') this.searches.delete(id);
  }

  private page(search: MockSearch, n: number): EvidencePage {
    const total = search.cases.length;
    const first = (n - 1) * EVIDENCE_PAGE_SIZE;
    return {
      version: EVIDENCE_CONTRACT_VERSION,
      id: search.id,
      question: search.question,
      interpretation: search.interpretation,
      edited: search.edited,
      generation: GENERATION,
      createdAt: stamp(search.createdAt),
      expiresAt: stamp(new Date(search.createdAt.getTime() + EVIDENCE_TTL_MS)),
      total,
      page: n,
      pages: Math.ceil(total / EVIDENCE_PAGE_SIZE),
      cases: search.cases.slice(first, first + EVIDENCE_PAGE_SIZE),
    };
  }

  private start(question: string, interpretation: EvidenceInterpretation, edited: boolean): MockSearch {
    const cases = /\bnothing\b/i.test(question) && !edited ? [] : evidenceCases(interpretation);
    const search: MockSearch = {
      id: this.newId(),
      question,
      interpretation,
      edited,
      cases,
      createdAt: this.now(),
      owner: this.visitor(),
      expired: false,
    };
    this.searches.set(search.id, search);
    return search;
  }

  /** `POST /api/evidence`: 201 with page 1 of a new search, or 200 with a static reply. */
  create(body: CreateEvidenceRequest): MockReply<CreateEvidenceResponse> {
    const request = body.kind === 'question' ? `q:${body.question}` : `e:${body.from}:${JSON.stringify(body.filters)}:${body.terms}`;
    if (this.unfinished.has(body.idempotencyKey)) return error(409, 'conflict', 'This request was accepted earlier but did not start. Ask again.');
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
      const interpretation = { filters: body.filters, terms: body.terms, unchecked: from.interpretation.unchecked };
      const search = this.start(from.question, interpretation, true);
      this.keys.set(body.idempotencyKey, { request, id: search.id });
      return { status: 201, body: { kind: 'results', search: this.page(search, 1) } };
    }
    const q = body.question.toLowerCase();
    if (/\bunavailable\b/.test(q) && this.once('unavailable', q)) {
      this.unfinished.add(body.idempotencyKey);
      return error(503, 'unavailable', 'AI search is temporarily unavailable.');
    }
    if (/\blost before start\b/.test(q) && this.once('lost-before-start', q)) {
      this.unfinished.add(body.idempotencyKey);
      return { status: 0, body: null, lost: true };
    }
    const reply = scopeReplyFor(body.question);
    if (reply) return { status: 200, body: { kind: 'scope_reply', reply } };
    const search = this.start(body.question, readQuestion(body.question), false);
    this.keys.set(body.idempotencyKey, { request, id: search.id });
    const created: MockReply<CreateEvidenceResponse> = { status: 201, body: { kind: 'results', search: this.page(search, 1) } };
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
}
