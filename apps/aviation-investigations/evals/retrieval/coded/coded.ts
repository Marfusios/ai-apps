/**
 * The coded-reference retrieval set (Track C of the task 10c protocol v4): questions
 * whose relevant cases are exact membership in a frozen code set, derived over every
 * answer-eligible US case of a generation. Its scores are **coded-reference**: they
 * measure retrieval of coded facts, never adjudicated relevance.
 *
 * A question carries:
 * - the text a user would type, worded as the codes read ("conditions conducive to
 *   carburetor icing", never "confirmed carburetor icing"). `wording` lists the exact
 *   code phrases an original question contains; a paraphrase avoids the code
 *   vocabulary (`avoids`) and keeps its original's labels;
 * - its filters, as the scope stage would emit them: years, state, aircraft category
 *   and phase group only, never `blank`;
 * - its **code set**: one or more clauses, each a frozen list of code identifiers of
 *   one kind. A finding clause lists `case_findings.code` values (ten digits:
 *   category, subcategory, section, subsection and modifier, so the modifier is always
 *   explicit) and states whether the code must be cited in the probable cause
 *   (`in_probable_cause`, which does not distinguish cause from contributing factor)
 *   or may appear anywhere. An event clause lists `case_sequence.event_code` values
 *   (the three-digit occurrence of the sequence of events, `eventsoe_no`, in any
 *   phase). Description strings are never matched;
 * - its **attribution rule**: `same-aircraft` (one aircraft carries every clause) or
 *   `any-aircraft` (each clause is carried by some aircraft of the event). Under an
 *   aircraft facet (category, phase group: the aircraft's defining-event phase, as the
 *   retrieval filter reads it), every carrying aircraft must meet every active facet;
 * - its **class**, declared and checked against the count: `narrow` (1 to 20 relevant
 *   cases; gated on Recall@20) or `broad` (more than 20; gated on strict P@6 and
 *   nDCG@6).
 *
 * A case is relevant when its event fields meet the filters, the attribution rule
 * holds, and the retrieval filter can reach it: with an aircraft facet, a
 * multi-aircraft event (all of whose sections are event-scoped) qualifies only when
 * every aircraft meets the facets (the `passages-v2` event-level qualification). A
 * coded case the filter cannot reach is recorded under `unreachable`, never as a
 * label; a question whose relevant cases include a multi-aircraft event under an
 * aircraft facet needs the event-level qualification (`passages-v2`).
 *
 * Absence of a code is not a negative relevance judgement: an uncoded case is "not
 * coded", so precision is reported as coded precision. `cause_factor` and the " - C" /
 * " - F" description suffixes are never labels; descriptions are recorded only as the
 * text seen for each code.
 *
 * **Held out by case**, as the silver set: questions sharing a relevant case, and a
 * paraphrase with its original, form one group assigned whole to `dev` or `holdout`
 * (`assignSplits`); its required tags are every area, both classes and every area and
 * class pair, and the set is refused unless each of them reaches both splits.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BLANK } from '../../../shared/contracts/search.js';
import { RetrievalFiltersSchema } from '../../../server/search/filters.js';
import { RECALL_GATE_MAX_RELEVANT } from '../metrics.js';
import { assignSplits, type GroupedSplits } from '../silver.js';

export const CODED_VERSION = 'coded-v1';
export const REFERENCE = 'coded-reference';
export const CAVEAT =
  'Coded-reference labels: exact membership in each question\'s frozen code set over the answer-eligible cohort. ' +
  'Absence of a code is not a negative relevance judgement: uncoded cases are "not coded", neither credited nor ' +
  'penalised in recall, and precision is coded precision. These scores measure retrieval of coded facts, not adjudicated relevance.';

export const AREAS = ['environment', 'aircraft_systems', 'personnel', 'occurrence'] as const;
export type Area = (typeof AREAS)[number];
export const CLASSES = ['narrow', 'broad'] as const;
export type QuestionClass = (typeof CLASSES)[number];
/** A narrow question has 1 to this many relevant cases (the Recall@20 gate's limit). */
export const NARROW_MAX = RECALL_GATE_MAX_RELEVANT;

export const MIN_QUESTIONS = 36;
export const MIN_NARROW = 16;
export const MIN_BROAD = 10;
export const MIN_PARAPHRASES = 6;
/** An area and class pair (`environment/narrow`): each must reach both splits. */
export const areaClass = (q: { area: Area; class: QuestionClass }): string => `${q.area}/${q.class}`;
/** Tags `assignSplits` spreads over both splits: every area, both classes, and every area and class pair. */
export const REQUIRED_SPLIT_TAGS: readonly string[] = [...AREAS, 'narrow', 'broad', ...AREAS.flatMap((area) => [`${area}/narrow`, `${area}/broad`])];

const QuestionId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60);
const CaseNo = z.string().regex(/^[A-Z0-9]{6,16}$/);
export const FindingCode = z.string().regex(/^\d{10}$/);
export const EventCode = z.string().regex(/^\d{3}$/);

export const ClauseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('finding'), codes: z.array(FindingCode).min(1), inProbableCause: z.boolean() }),
  z.strictObject({ kind: z.literal('event'), codes: z.array(EventCode).min(1) }),
]);
export type Clause = z.infer<typeof ClauseSchema>;

export const CodeSetSchema = z.strictObject({
  clauses: z.array(ClauseSchema).min(1),
  attribution: z.enum(['same-aircraft', 'any-aircraft']),
});
export type CodeSet = z.infer<typeof CodeSetSchema>;

const FILTER_KEYS: readonly string[] = ['yearFrom', 'yearTo', 'state', 'category', 'phase'];
/** Retrieval filters restricted to years, state, aircraft category and phase group, without `blank`. */
export const CodedFiltersSchema = RetrievalFiltersSchema.refine((f) => Object.keys(f).every((k) => FILTER_KEYS.includes(k)), {
  message: 'a coded question filters only by years, state, aircraft category and phase group',
}).refine((f) => ![...(f.state ?? []), ...(f.category ?? []), ...(f.phase ?? [])].includes(BLANK), {
  message: 'a coded question never filters on blank values',
});
export type CodedFilters = z.infer<typeof CodedFiltersSchema>;

export const CodedQuestionSpecSchema = z.strictObject({
  id: QuestionId,
  question: z.string().min(10).max(600),
  area: z.enum(AREAS),
  class: z.enum(CLASSES),
  filters: CodedFiltersSchema,
  codeSet: CodeSetSchema,
  /** The code phrases the question contains verbatim (case-insensitive). */
  wording: z.array(z.string().min(3)).min(1),
  /** Why these codes and filters stand for the question, and what is deliberately left out. */
  note: z.string().min(1).max(800),
});
export type CodedQuestionSpec = z.infer<typeof CodedQuestionSpecSchema>;

/** A paraphrase: another question's code set, filters and labels, without the code vocabulary. */
export const CodedParaphraseSpecSchema = z.strictObject({
  id: QuestionId,
  of: QuestionId,
  question: z.string().min(10).max(600),
  /** The code words the paraphrase avoids (case-insensitive). */
  avoids: z.array(z.string().min(1)).min(1),
});
export type CodedParaphraseSpec = z.infer<typeof CodedParaphraseSpecSchema>;

export const CodeRecordSchema = z.strictObject({
  kind: z.enum(['finding', 'event']),
  code: z.string(),
  /**
   * The text seen for the code in the cohort. Finding: every distinct description, its
   * deprecated " - C"/" - F" suffix and outer whitespace removed. Event: the occurrence
   * text its sequence descriptions share after their phase.
   */
  descriptions: z.array(z.string().min(1)).min(1),
  /** Cohort cases with the code on any aircraft, anywhere. */
  cohortCases: z.number().int().nonnegative(),
  /** Finding codes: cohort cases where the code is cited in the probable cause. */
  cohortCasesInProbableCause: z.number().int().nonnegative().optional(),
  /** This question's relevant cases where the code meets its clause on a carrying aircraft. */
  relevantCases: z.number().int().nonnegative(),
});
export type CodeRecord = z.infer<typeof CodeRecordSchema>;

export const CodedItemSchema = z.strictObject({
  id: QuestionId,
  question: z.string().min(10).max(600),
  tags: z.array(z.string().min(1)).min(1),
  area: z.enum(AREAS),
  class: z.enum(CLASSES),
  /** Set on a paraphrase: the question it rewords. */
  paraphrase_of: QuestionId.optional(),
  /** Original: the code phrases it contains. Paraphrase: the code words it avoids. */
  wording: z.array(z.string().min(1)).min(1),
  filters: CodedFiltersSchema,
  codeSet: CodeSetSchema,
  /** The label rule as a sentence (`describeCodeSet`). */
  rule: z.string().min(1),
  codes: z.array(CodeRecordSchema).min(1),
  /** Every relevant case, sorted: the full coded positive set. */
  relevant: z.array(CaseNo).min(1),
  /** Coded cases (carrying aircraft meeting the facets) the filter cannot reach: multi-aircraft events with an aircraft that does not meet them. */
  unreachable: z.array(CaseNo),
  /** Some relevant case is a multi-aircraft event under an aircraft facet: only `passages-v2` reaches it. */
  needsEventAircraftQualification: z.boolean(),
  group: z.string().regex(/^g[0-9]+$/),
  split: z.enum(['dev', 'holdout']),
  note: z.string(),
});
export type CodedItem = z.infer<typeof CodedItemSchema>;

export const CodedDatasetSchema = z.strictObject({
  version: z.literal(CODED_VERSION),
  reference: z.literal(REFERENCE),
  description: z.string(),
  caveat: z.literal(CAVEAT),
  source: z.strictObject({
    generationId: z.number().int().positive(),
    answerEligibleCases: z.number().int().positive(),
    builder: z.string(),
    specSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  limits: z.strictObject({ narrowMax: z.number().int() }),
  questions: z.array(CodedItemSchema).min(1),
});
export type CodedDataset = z.infer<typeof CodedDatasetSchema>;

/** sha256 over the question and paraphrase specs: changes whenever a question, code set or filter does. */
export function specSha256(specs: readonly CodedQuestionSpec[], paraphrases: readonly CodedParaphraseSpec[]): string {
  return createHash('sha256').update(JSON.stringify({ specs, paraphrases })).digest('hex');
}

// ---------------------------------------------------------------------------
// The corpus a derivation reads (the builder loads it in one snapshot)

export interface CorpusCase {
  ntsbNo: string;
  evYear: number | null;
  state: string | null;
}
export interface CorpusAircraft {
  ntsbNo: string;
  aircraftKey: number;
  category: string | null;
  /** The aircraft's defining-event phase group (what the phase filter reads); null without one. */
  definingPhaseGroup: string | null;
}
export interface CorpusFinding {
  ntsbNo: string;
  aircraftKey: number;
  code: string | null;
  /** Recorded as the text seen, never matched. */
  description: string | null;
  inProbableCause: boolean | null;
}
export interface CorpusSequence {
  ntsbNo: string;
  aircraftKey: number;
  eventCode: string | null;
  /** Recorded as the text seen, never matched. */
  description: string | null;
}
/** The answer-eligible US cohort of one generation, with its aircraft, findings and sequence rows. */
export interface CodedCorpus {
  cases: readonly CorpusCase[];
  aircraft: readonly CorpusAircraft[];
  findings: readonly CorpusFinding[];
  sequence: readonly CorpusSequence[];
}

interface IndexedAircraft {
  key: number;
  category: string | null;
  phase: string | null;
  /** Finding code → cited in the probable cause by some row of this aircraft. */
  findings: Map<string, boolean>;
  events: Set<string>;
}
interface IndexedCase {
  ntsbNo: string;
  evYear: number | null;
  state: string | null;
  aircraft: IndexedAircraft[];
}
export type CorpusIndex = ReadonlyMap<string, IndexedCase>;

/** Index the corpus by case and aircraft; rows of unknown cases or aircraft are an error. */
export function indexCorpus(corpus: CodedCorpus): CorpusIndex {
  const out = new Map<string, IndexedCase>();
  for (const c of corpus.cases) {
    if (out.has(c.ntsbNo)) throw new Error(`case ${c.ntsbNo} appears twice in the corpus`);
    out.set(c.ntsbNo, { ntsbNo: c.ntsbNo, evYear: c.evYear, state: c.state, aircraft: [] });
  }
  const aircraft = new Map<string, IndexedAircraft>();
  for (const a of corpus.aircraft) {
    const c = out.get(a.ntsbNo);
    if (!c) throw new Error(`aircraft ${a.ntsbNo}/${a.aircraftKey} of a case outside the corpus`);
    const key = `${a.ntsbNo}/${a.aircraftKey}`;
    if (aircraft.has(key)) throw new Error(`aircraft ${key} appears twice in the corpus`);
    const indexed: IndexedAircraft = { key: a.aircraftKey, category: a.category, phase: a.definingPhaseGroup, findings: new Map(), events: new Set() };
    aircraft.set(key, indexed);
    c.aircraft.push(indexed);
  }
  const of = (row: { ntsbNo: string; aircraftKey: number }, what: string) => {
    const a = aircraft.get(`${row.ntsbNo}/${row.aircraftKey}`);
    if (!a) throw new Error(`${what} of unknown aircraft ${row.ntsbNo}/${row.aircraftKey}`);
    return a;
  };
  for (const f of corpus.findings) {
    const a = of(f, 'finding');
    if (f.code === null) continue;
    a.findings.set(f.code, (a.findings.get(f.code) ?? false) || f.inProbableCause === true);
  }
  for (const q of corpus.sequence) {
    const a = of(q, 'sequence row');
    if (q.eventCode !== null) a.events.add(q.eventCode);
  }
  return out;
}

const facetActive = (f: CodedFilters) => (f.category ?? []).length > 0 || (f.phase ?? []).length > 0;

/** The aircraft meets every active aircraft facet; a missing value fails its facet. */
function meetsFacets(a: IndexedAircraft, f: CodedFilters): boolean {
  if ((f.category ?? []).length > 0 && (a.category === null || !(f.category as string[]).includes(a.category))) return false;
  if ((f.phase ?? []).length > 0 && (a.phase === null || !(f.phase as string[]).includes(a.phase))) return false;
  return true;
}

function meetsEventFilters(c: IndexedCase, f: CodedFilters): boolean {
  if (f.yearFrom !== undefined && (c.evYear === null || c.evYear < f.yearFrom)) return false;
  if (f.yearTo !== undefined && (c.evYear === null || c.evYear > f.yearTo)) return false;
  if ((f.state ?? []).length > 0 && (c.state === null || !(f.state as string[]).includes(c.state))) return false;
  return true;
}

/** The codes of `clause` the aircraft carries, as its clause reads them. */
function carried(a: IndexedAircraft, clause: Clause): string[] {
  if (clause.kind === 'event') return clause.codes.filter((code) => a.events.has(code));
  return clause.codes.filter((code) => {
    const inCause = a.findings.get(code);
    return inCause !== undefined && (!clause.inProbableCause || inCause);
  });
}

export interface Derivation {
  /** Sorted relevant cases. */
  relevant: string[];
  /** Sorted coded cases the filter cannot reach. */
  unreachable: string[];
  /** Relevant multi-aircraft events under an aircraft facet. */
  multiAircraftRelevant: number;
  /** Relevant cases per `kind:code`. */
  perCode: Map<string, number>;
}

export const codeKey = (kind: Clause['kind'], code: string) => `${kind}:${code}`;

/** Exact membership of every corpus case in a question's code set (module comment). */
export function deriveQuestion(index: CorpusIndex, q: { filters: CodedFilters; codeSet: CodeSet }): Derivation {
  const f = q.filters;
  const relevant: string[] = [];
  const unreachable: string[] = [];
  const perCode = new Map<string, number>();
  let multiAircraftRelevant = 0;
  for (const c of index.values()) {
    if (!meetsEventFilters(c, f)) continue;
    const carriers = c.aircraft.filter((a) => meetsFacets(a, f));
    if (carriers.length === 0) continue;
    // The codes each carrying aircraft holds for each clause.
    const held = carriers.map((a) => q.codeSet.clauses.map((clause) => carried(a, clause)));
    let coded: boolean;
    let credited: number[];
    if (q.codeSet.attribution === 'same-aircraft') {
      credited = held.flatMap((perClause, i) => (perClause.every((codes) => codes.length > 0) ? [i] : []));
      coded = credited.length > 0;
    } else {
      coded = q.codeSet.clauses.every((_, j) => held.some((perClause) => (perClause[j] as string[]).length > 0));
      credited = held.map((_, i) => i);
    }
    if (!coded) continue;
    const reachable = !facetActive(f) || c.aircraft.length === 1 || c.aircraft.every((a) => meetsFacets(a, f));
    if (!reachable) {
      unreachable.push(c.ntsbNo);
      continue;
    }
    relevant.push(c.ntsbNo);
    if (facetActive(f) && c.aircraft.length > 1) multiAircraftRelevant += 1;
    const codes = new Set<string>();
    for (const i of credited) {
      q.codeSet.clauses.forEach((clause, j) => {
        for (const code of (held[i] as string[][])[j] as string[]) codes.add(codeKey(clause.kind, code));
      });
    }
    for (const k of codes) perCode.set(k, (perCode.get(k) ?? 0) + 1);
  }
  relevant.sort();
  unreachable.sort();
  return { relevant, unreachable, multiAircraftRelevant, perCode };
}

/** A finding description without its deprecated " - C"/" - F" suffix and outer whitespace. */
export const normalizeFindingDescription = (d: string): string => d.replace(/\s+-\s+[CF]\s*$/u, '').replace(/\s+/gu, ' ').trim();

/** The longest run of whole words every text ends with; the whole text when there is one. */
export function commonWordSuffix(texts: readonly string[]): string {
  const words = texts.map((t) => t.replace(/\s+/gu, ' ').trim().split(' '));
  if (words.length === 0) return '';
  const out: string[] = [];
  for (let i = 1; ; i += 1) {
    const w = (words[0] as string[])[(words[0] as string[]).length - i];
    if (w === undefined || words.some((ws) => ws[ws.length - i] !== w)) break;
    out.unshift(w);
  }
  return out.length > 0 ? out.join(' ') : (texts[0] as string);
}

export interface CodeStats {
  descriptions: string[];
  cohortCases: number;
  cohortCasesInProbableCause?: number;
}

/** Text seen and cohort counts of each requested code. */
export function codeStats(corpus: CodedCorpus, codes: readonly { kind: Clause['kind']; code: string }[]): Map<string, CodeStats> {
  const wanted = new Set(codes.map((c) => codeKey(c.kind, c.code)));
  const texts = new Map<string, Set<string>>();
  const cases = new Map<string, Set<string>>();
  const inCause = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => m.set(k, (m.get(k) ?? new Set()).add(v));
  for (const f of corpus.findings) {
    if (f.code === null) continue;
    const k = codeKey('finding', f.code);
    if (!wanted.has(k)) continue;
    add(cases, k, f.ntsbNo);
    if (f.inProbableCause === true) add(inCause, k, f.ntsbNo);
    if (f.description !== null && f.description.trim() !== '') add(texts, k, normalizeFindingDescription(f.description));
  }
  for (const q of corpus.sequence) {
    if (q.eventCode === null) continue;
    const k = codeKey('event', q.eventCode);
    if (!wanted.has(k)) continue;
    add(cases, k, q.ntsbNo);
    if (q.description !== null && q.description.trim() !== '') add(texts, k, q.description.replace(/\s+/gu, ' ').trim());
  }
  const out = new Map<string, CodeStats>();
  for (const c of codes) {
    const k = codeKey(c.kind, c.code);
    const seen = [...(texts.get(k) ?? [])].sort();
    out.set(k, {
      descriptions: c.kind === 'event' ? (seen.length > 0 ? [commonWordSuffix(seen)] : []) : seen,
      cohortCases: cases.get(k)?.size ?? 0,
      ...(c.kind === 'finding' ? { cohortCasesInProbableCause: inCause.get(k)?.size ?? 0 } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Descriptions and checks

const list = (xs: readonly (string | number)[]) => xs.join(', ');

/** The label rule as a sentence. */
export function describeCodeSet(q: { filters: CodedFilters; codeSet: CodeSet }): string {
  const f = q.filters;
  const scope: string[] = ['Answer-eligible US cases'];
  if (f.yearFrom !== undefined || f.yearTo !== undefined) {
    scope.push(f.yearFrom === f.yearTo ? `from ${f.yearFrom}` : `from ${f.yearFrom ?? 'the first year'} to ${f.yearTo ?? 'the last year'}`);
  }
  if ((f.state ?? []).length > 0) scope.push(`in ${list(f.state as string[])}`);
  const facets: string[] = [];
  if ((f.category ?? []).length > 0) facets.push(`of category ${list(f.category as string[])}`);
  if ((f.phase ?? []).length > 0) facets.push(`whose defining event is in phase group ${list(f.phase as string[])}`);
  const carrier = (one: boolean) => `${one ? 'one aircraft' : 'some aircraft'}${facets.length > 0 ? ` ${facets.join(' and ')}` : ''}`;
  const clause = (c: Clause) =>
    c.kind === 'finding'
      ? `a finding coded ${list(c.codes)}${c.inProbableCause ? ' cited in the probable cause' : ' (anywhere)'}`
      : `a sequence-of-events occurrence coded ${list(c.codes)} (any phase)`;
  const clauses = q.codeSet.clauses.map(clause);
  const body =
    q.codeSet.attribution === 'same-aircraft'
      ? `where ${carrier(true)} carries ${clauses.join(' and ')}`
      : `where ${clauses.map((c) => `${c} is carried by ${carrier(false)}`).join(', and ')}`;
  const reach = facets.length > 0 ? ' A multi-aircraft event counts only when every aircraft meets the aircraft filter (the passages-v2 event-level qualification).' : '';
  return `${scope.join(' ')} ${body}.${reach}`;
}

const lower = (s: string) => s.toLowerCase();

/** Problems with the committed specs: ids, wording, probable-cause phrasing, paraphrases. Empty when usable. */
export function specProblems(specs: readonly CodedQuestionSpec[], paraphrases: readonly CodedParaphraseSpec[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of specs) {
    const parsed = CodedQuestionSpecSchema.safeParse(s);
    if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${s.id}: ${i.path.join('.')}: ${i.message}`));
    if (ids.has(s.id)) problems.push(`duplicate question id ${s.id}`);
    ids.add(s.id);
    for (const phrase of s.wording) if (!lower(s.question).includes(lower(phrase))) problems.push(`${s.id}: the question does not contain the code phrase "${phrase}"`);
    const cause = s.codeSet.clauses.some((c) => c.kind === 'finding' && c.inProbableCause);
    if (cause !== lower(s.question).includes('probable cause')) {
      problems.push(`${s.id}: a question says "probable cause" exactly when a clause must be cited in the probable cause`);
    }
    for (const c of s.codeSet.clauses) if (new Set(c.codes).size !== c.codes.length) problems.push(`${s.id}: a clause lists a code twice`);
    if (s.codeSet.clauses.length === 1 && s.codeSet.attribution !== 'same-aircraft') problems.push(`${s.id}: a single clause is attributed to one aircraft (same-aircraft)`);
  }
  const byId = new Map(specs.map((s) => [s.id, s]));
  for (const p of paraphrases) {
    const parsed = CodedParaphraseSpecSchema.safeParse(p);
    if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${p.id}: ${i.path.join('.')}: ${i.message}`));
    if (ids.has(p.id)) problems.push(`duplicate question id ${p.id}`);
    ids.add(p.id);
    if (!byId.has(p.of)) problems.push(`${p.id}: paraphrase of unknown question ${p.of}`);
    for (const word of p.avoids) if (lower(p.question).includes(lower(word))) problems.push(`${p.id}: the paraphrase uses the code word "${word}"`);
  }
  return problems;
}

/** Problems with a dataset beyond its schema: classes, codes, paraphrases, coverage, splits. Empty when usable. */
export function codedDatasetProblems(d: CodedDataset): string[] {
  const problems: string[] = [];
  const byId = new Map<string, CodedItem>();
  for (const q of d.questions) {
    if (byId.has(q.id)) problems.push(`duplicate question id ${q.id}`);
    byId.set(q.id, q);
    const n = q.relevant.length;
    if (new Set(q.relevant).size !== n) problems.push(`${q.id}: duplicate relevant case`);
    if (JSON.stringify([...q.relevant].sort()) !== JSON.stringify(q.relevant)) problems.push(`${q.id}: relevant cases are not sorted`);
    if (q.class === 'narrow' ? n < 1 || n > NARROW_MAX : n <= NARROW_MAX) {
      problems.push(`${q.id}: a ${q.class} question cannot have ${n} relevant cases (narrow 1..${NARROW_MAX}, broad more)`);
    }
    if (!q.tags.includes(q.area) || !q.tags.includes(q.class)) problems.push(`${q.id}: tags must carry the area and the class`);
    const listed = q.codeSet.clauses.flatMap((c) => c.codes.map((code) => codeKey(c.kind, code)));
    const recorded = q.codes.map((c) => codeKey(c.kind, c.code));
    if (JSON.stringify([...new Set(listed)].sort()) !== JSON.stringify([...recorded].sort())) problems.push(`${q.id}: code records differ from the code set`);
    for (const c of q.codes) if (c.cohortCases === 0) problems.push(`${q.id}: code ${c.code} never occurs in the cohort`);
    if (q.relevant.some((r) => q.unreachable.includes(r))) problems.push(`${q.id}: a case is both relevant and unreachable`);
    if (q.needsEventAircraftQualification && !facetActive(q.filters)) problems.push(`${q.id}: only an aircraft facet needs the event-level qualification`);
    if (q.rule !== describeCodeSet(q)) problems.push(`${q.id}: rule text differs from its code set`);
  }
  const originals = d.questions.filter((q) => q.paraphrase_of === undefined);
  const paraphrases = d.questions.filter((q) => q.paraphrase_of !== undefined);
  for (const q of paraphrases) {
    const of = byId.get(q.paraphrase_of as string);
    if (!of) {
      problems.push(`${q.id}: paraphrase of unknown question ${q.paraphrase_of}`);
      continue;
    }
    if (of.paraphrase_of !== undefined) problems.push(`${q.id}: paraphrase of a paraphrase`);
    for (const field of ['relevant', 'filters', 'codeSet', 'class', 'area', 'codes', 'unreachable'] as const) {
      if (JSON.stringify(of[field]) !== JSON.stringify(q[field])) problems.push(`${q.id}: ${field} differs from ${of.id}`);
    }
    if (of.group !== q.group || of.split !== q.split) problems.push(`${q.id}: not in the group of ${of.id}`);
    if (!q.tags.includes('paraphrase')) problems.push(`${q.id}: a paraphrase carries the paraphrase tag`);
    for (const word of q.wording) if (lower(q.question).includes(lower(word))) problems.push(`${q.id}: the paraphrase uses the code word "${word}"`);
  }
  for (const q of originals) for (const phrase of q.wording) if (!lower(q.question).includes(lower(phrase))) problems.push(`${q.id}: the question does not contain "${phrase}"`);
  if (d.questions.length < MIN_QUESTIONS) problems.push(`only ${d.questions.length} questions (at least ${MIN_QUESTIONS})`);
  const narrow = d.questions.filter((q) => q.class === 'narrow').length;
  const broad = d.questions.filter((q) => q.class === 'broad').length;
  if (narrow < MIN_NARROW) problems.push(`only ${narrow} narrow questions (at least ${MIN_NARROW})`);
  if (broad < MIN_BROAD) problems.push(`only ${broad} broad questions (at least ${MIN_BROAD})`);
  if (paraphrases.length < MIN_PARAPHRASES) problems.push(`only ${paraphrases.length} paraphrases (at least ${MIN_PARAPHRASES})`);
  for (const area of AREAS) {
    for (const cls of CLASSES) {
      if (!originals.some((q) => q.area === area && q.class === cls)) problems.push(`no ${cls} ${area} question`);
    }
  }
  for (const split of ['dev', 'holdout'] as const) {
    for (const tag of REQUIRED_SPLIT_TAGS) {
      if (!d.questions.some((q) => q.split === split && [...q.tags, areaClass(q)].includes(tag))) problems.push(`no ${split} question tagged ${tag}`);
    }
  }
  const splitOf = new Map<string, string>();
  const groupOf = new Map<string, string>();
  for (const q of d.questions) {
    for (const n of q.relevant) {
      const s = splitOf.get(n);
      if (s !== undefined && s !== q.split) problems.push(`case ${n} is relevant in both splits`);
      const g = groupOf.get(n);
      if (g !== undefined && g !== q.group) problems.push(`case ${n} is relevant in groups ${g} and ${q.group}`);
      splitOf.set(n, q.split);
      groupOf.set(n, q.group);
    }
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------
// Assembly

export interface CodedBuild {
  dataset: CodedDataset;
  /** Questions whose count does not fit their class (or derive nothing), with their counts. */
  rejected: { id: string; class: QuestionClass; count: number }[];
  groups: GroupedSplits['groups'];
  problems: string[];
}

export const DESCRIPTION =
  'Coded-reference retrieval set (Track C, task 10c protocol v4): public NTSB case numbers whose relevance is exact ' +
  'membership in each question\'s frozen code set (case_findings codes with explicit modifiers, case_sequence ' +
  'occurrence codes), aircraft attribution and filters, over every answer-eligible US case of the generation. ' +
  'Questions sharing a case, and paraphrases with their originals, are split together by group. Rebuild with ' +
  'pnpm eval:retrieval:coded.';

type Draft = Omit<CodedItem, 'group' | 'split'>;

export const tagsOf = (q: { area: Area; class: QuestionClass; filters: CodedFilters; codeSet: CodeSet }, paraphrase = false): string[] => [
  q.area,
  q.class,
  ...(q.codeSet.clauses.some((c) => c.kind === 'finding' && c.inProbableCause) ? ['probable_cause'] : []),
  ...(facetActive(q.filters) ? ['aircraft_filter'] : []),
  ...(q.codeSet.clauses.length > 1 ? ['multi_clause'] : []),
  ...(paraphrase ? ['paraphrase'] : []),
];

/** Pure: the dataset from every question's derivation and the code statistics of the cohort. */
export function assembleCoded(
  source: { generationId: number; answerEligibleCases: number; builder: string },
  specs: readonly CodedQuestionSpec[],
  paraphrases: readonly CodedParaphraseSpec[],
  derived: ReadonlyMap<string, Derivation>,
  stats: ReadonlyMap<string, CodeStats>,
): CodedBuild {
  const problems = specProblems(specs, paraphrases);
  const rejected: CodedBuild['rejected'] = [];
  const drafts: Draft[] = [];
  const byId = new Map<string, Draft>();
  for (const spec of specs) {
    const d = derived.get(spec.id);
    if (!d) throw new Error(`no derivation for ${spec.id}`);
    const n = d.relevant.length;
    if (n === 0 || (spec.class === 'narrow' ? n > NARROW_MAX : n <= NARROW_MAX)) {
      rejected.push({ id: spec.id, class: spec.class, count: n });
      continue;
    }
    const codes = spec.codeSet.clauses.flatMap((c) =>
      c.codes.map((code): CodeRecord => {
        const s = stats.get(codeKey(c.kind, code));
        return {
          kind: c.kind,
          code,
          descriptions: s?.descriptions.length ? s.descriptions : ['(not seen in the cohort)'],
          cohortCases: s?.cohortCases ?? 0,
          ...(s?.cohortCasesInProbableCause !== undefined ? { cohortCasesInProbableCause: s.cohortCasesInProbableCause } : {}),
          relevantCases: d.perCode.get(codeKey(c.kind, code)) ?? 0,
        };
      }),
    );
    const draft: Draft = {
      id: spec.id,
      question: spec.question,
      tags: tagsOf(spec),
      area: spec.area,
      class: spec.class,
      wording: spec.wording,
      filters: spec.filters,
      codeSet: spec.codeSet,
      rule: describeCodeSet(spec),
      codes,
      relevant: d.relevant,
      unreachable: d.unreachable,
      needsEventAircraftQualification: d.multiAircraftRelevant > 0,
      note: spec.note,
    };
    drafts.push(draft);
    byId.set(draft.id, draft);
  }
  const links: [string, string][] = [];
  for (const p of paraphrases) {
    const of = byId.get(p.of);
    if (!of) {
      problems.push(`${p.id}: paraphrase of ${p.of}, which is unknown or rejected`);
      continue;
    }
    drafts.push({
      ...of,
      id: p.id,
      question: p.question,
      tags: tagsOf(of, true),
      paraphrase_of: of.id,
      wording: p.avoids,
      note: `Paraphrase of ${of.id}, avoiding: ${p.avoids.join(', ')}. ${of.note}`,
    });
    links.push([p.id, of.id]);
  }
  const grouped = assignSplits(
    drafts.map((q) => ({ id: q.id, tags: [...q.tags, areaClass(q)], expected: q.relevant })),
    links,
    REQUIRED_SPLIT_TAGS,
  );
  const dataset: CodedDataset = {
    version: CODED_VERSION,
    reference: REFERENCE,
    description: DESCRIPTION,
    caveat: CAVEAT,
    source: { ...source, specSha256: specSha256(specs, paraphrases) },
    limits: { narrowMax: NARROW_MAX },
    questions: drafts.map((q) => ({ ...q, group: grouped.group.get(q.id) as string, split: grouped.split.get(q.id) as 'dev' | 'holdout' })),
  };
  const parsed = CodedDatasetSchema.safeParse(dataset);
  problems.push(
    ...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
    ...codedDatasetProblems(dataset),
    ...rejected.map((r) =>
      r.count === 0
        ? `${r.id}: the code set derives no case`
        : `${r.id}: a ${r.class} question cannot have ${r.count} relevant cases (narrow 1..${NARROW_MAX}, broad more; never capped)`,
    ),
  );
  return { dataset, rejected, groups: grouped.groups, problems: [...new Set(problems)] };
}
