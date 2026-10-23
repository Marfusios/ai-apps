/**
 * The narrative-relevance question set (Track N of the task 10c protocol v4): its
 * question and rubric schemas, versions and checks. Its scores are **model-judged**:
 * two judges from different providers grade each case against the question's written
 * rubric and an adjudicator settles their disagreements. They are never expert
 * adjudicated, and no label waits for a person.
 *
 * A question carries:
 * - the text a reader would type (`question`), worded as a reader asks it; the rubric
 *   holds the precise criteria;
 * - its **tags** over the protocol's concepts (negation, maintenance chronology,
 *   causal uncertainty, pilot-versus-investigator attribution, paraphrase,
 *   multi-aircraft, aircraft filters, operational, mechanical);
 * - its structured **filters** (the retrieval filters the evaluation applies, never
 *   `blank`);
 * - its **type**: `bounded-cohort` (the filters limit the answer-eligible cohort to at
 *   most `BOUNDED_MAX` cases, all of which are judged, so Recall@20 is defined once the
 *   cohort is fully judged) or `broad` (a larger cohort, judged on a pool);
 * - a written **rubric**: what makes a case relevant (2), partially relevant (1) or
 *   not relevant (0), with explicit edge cases;
 * - a **lure**: BM25 text that shares the question's surface terms but describes the
 *   contrasting situation, from which the pool's hard negatives are drawn by rule;
 * - optionally **related codes** (a Track C code set): their coded positives under the
 *   question's filters join the pool (protocol section 4) and disagreements between
 *   them and the judged grades are logged as candidate code-narrative discrepancies.
 *   They never label anything.
 *
 * A **paraphrase** rewords another question for retrieval only: it keeps that
 * question's filters, type and rubric, and its cases are judged against the original
 * question (the family's), so a paraphrase family shares one set of judgments.
 *
 * A **diagnostic** is a question of the same shape with a frozen diagnostic definition
 * (`NarrativeDiagnosticSchema`): judged with the same judges, prompts and schedule, and
 * reported apart from the benchmark aggregate under comparison rules fixed before any
 * judging. It never counts toward the set's minimums.
 *
 * **Versions.** A judgment depends on the judged question and the rubric:
 * `questionVersion` hashes the family's question text and filters, `rubricVersion`
 * the rubric. Both enter the judgment cache key, so editing either re-judges.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BLANK } from '../../../shared/contracts/search.js';
import { RETRIEVAL_VERSIONS } from '../../../shared/contracts/retrieval.js';
import { AIRCRAFT_FACET_KEYS, RetrievalFiltersSchema, type RetrievalFilters } from '../../../server/search/filters.js';
import { CodeSetSchema, CodedFiltersSchema } from '../coded/coded.js';

export const NARRATIVE_VERSION = 'narrative-v1';
export const REFERENCE = 'model-judged';
export const CAVEAT =
  'Model-judged labels: two judges from different providers (claude-haiku-5-5, gpt-5.6-luna) grade each case 0/1/2 ' +
  "against the question's written rubric on the case's complete record, and claude-sonnet-5-5 adjudicates their " +
  'disagreements. Unjudgeable, unresolved and abstained cases are unknown and stay in every denominator. These are ' +
  'model judgments, never expert-adjudicated relevance.';

export const TAGS = [
  'negation',
  'maintenance_chronology',
  'causal_uncertainty',
  'pilot_vs_investigator',
  'paraphrase',
  'multi_aircraft',
  'aircraft_filter',
  'operational',
  'mechanical',
] as const;
export type Tag = (typeof TAGS)[number];
/** Tags an original question may carry (`paraphrase` is added to paraphrases by the builder). */
export const ORIGINAL_TAGS = TAGS.filter((t) => t !== 'paraphrase') as Exclude<Tag, 'paraphrase'>[];
/** Every tag must reach at least this many questions. */
export const MIN_PER_TAG = 3;

export const QUESTION_TYPES = ['bounded-cohort', 'broad'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/** A bounded cohort holds at most this many answer-eligible cases (all judged). */
export const BOUNDED_MAX = 150;
export const MIN_BOUNDED = 4;
export const MIN_QUESTIONS = 20;
export const MIN_PARAPHRASES = 3;
/** Related codes may add at most this many coded positives to a question's pool. */
export const MAX_RELATED_POSITIVES = 80;

export const GRADES = [0, 1, 2] as const;
export type Grade = (typeof GRADES)[number];
const GradeSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const QuestionIdSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60);
export const CaseNoSchema = z.string().regex(/^[A-Z0-9]{6,16}$/);

export const EdgeCaseSchema = z.strictObject({
  /** A situation a case record could describe. */
  situation: z.string().min(10).max(400),
  grade: GradeSchema,
  why: z.string().min(5).max(300),
});
export type EdgeCase = z.infer<typeof EdgeCaseSchema>;

export const RubricSchema = z.strictObject({
  /** Grade 2: every condition the record must establish. */
  relevant: z.string().min(20).max(1200),
  /** Grade 1. */
  partial: z.string().min(20).max(1200),
  /** Grade 0. */
  notRelevant: z.string().min(20).max(1200),
  edgeCases: z.array(EdgeCaseSchema).min(3).max(12),
});
export type Rubric = z.infer<typeof RubricSchema>;

/** Retrieval filters without `blank` values (a question never asks for a missing value). */
export const NarrativeFiltersSchema = RetrievalFiltersSchema.refine(
  (f) => !Object.values(f).some((v) => Array.isArray(v) && (v as string[]).includes(BLANK)),
  { message: 'a narrative question never filters on blank values' },
);

export const NarrativeQuestionSpecSchema = z.strictObject({
  id: QuestionIdSchema,
  question: z.string().min(15).max(400),
  tags: z.array(z.enum(ORIGINAL_TAGS as [Exclude<Tag, 'paraphrase'>, ...Exclude<Tag, 'paraphrase'>[]])).min(1),
  type: z.enum(QUESTION_TYPES),
  filters: NarrativeFiltersSchema,
  rubric: RubricSchema,
  /** BM25 text for the hard negatives: the question's surface terms in the contrasting situation. */
  lure: z.string().min(10).max(300),
  /** A Track C code set whose coded positives join the pool; never a label. */
  relatedCodes: CodeSetSchema.optional(),
  /** Why these filters and this rubric, and what is deliberately left out. */
  note: z.string().min(10).max(1000),
});
export type NarrativeQuestionSpec = z.infer<typeof NarrativeQuestionSpecSchema>;

export const NarrativeParaphraseSpecSchema = z.strictObject({
  id: QuestionIdSchema,
  of: QuestionIdSchema,
  question: z.string().min(15).max(400),
  note: z.string().min(10).max(600),
});
export type NarrativeParaphraseSpec = z.infer<typeof NarrativeParaphraseSpecSchema>;

// ---------------------------------------------------------------------------
// Diagnostics

/** What a diagnostic compares (the benchmark's own metrics, `score.ts`). */
export const DIAGNOSTIC_METRICS = ['ndcg6', 'p6', 'supported'] as const;

/** One cached scope-stage output a diagnostic is frozen with: the planner's output and the keyword text the pipeline resolves from it. */
export const DiagnosticScopeSampleSchema = z.strictObject({
  sample: z.number().int().positive(),
  intent: z.string().min(1),
  plannerKeywordText: z.string().nullable(),
  plannerFilters: z.record(z.string(), z.unknown()),
  keywordText: z.string().min(1),
});
export type DiagnosticScopeSample = z.infer<typeof DiagnosticScopeSampleSchema>;

/**
 * A regression diagnostic: a question a retrieval version was seen to lose, judged like
 * every benchmark question and reported apart from the benchmark aggregate, under
 * comparison rules frozen with it before any judging (`score.ts`, `regressionDiagnostic`).
 */
export const NarrativeDiagnosticSchema = z.strictObject({
  kind: z.literal('regression'),
  /** Where the regression was seen, and its size there. */
  origin: z.string().min(20).max(600),
  /**
   * The cached scope outputs the diagnostic runs with, the same for every retrieval
   * version (the runs that showed the regression); null: the pool's own scope samples.
   */
  scope: z.strictObject({ source: z.string().min(10).max(400), samples: z.array(DiagnosticScopeSampleSchema).min(1) }).nullable(),
  comparison: z.strictObject({
    /** The retrieval version the variants are compared with. */
    base: z.string().min(1),
    variants: z.array(z.string().min(1)).min(1),
    /** The metric the conclusion rests on; the others are reported only. */
    primary: z.enum(DIAGNOSTIC_METRICS),
    reported: z.array(z.enum(DIAGNOSTIC_METRICS)).min(1),
    rule: z.string().min(40).max(1200),
    /** The coded-reference values the runs should reproduce (the regression as first measured). */
    reproduction: z.strictObject({
      metric: z.literal('coded-ndcg6'),
      expected: z.record(z.string(), z.number().min(0).max(1)),
      tolerance: z.number().positive(),
      source: z.string().min(10).max(300),
    }),
  }),
});
export type NarrativeDiagnostic = z.infer<typeof NarrativeDiagnosticSchema>;

/** A diagnostic question: a question spec with its frozen diagnostic definition. */
export const NarrativeDiagnosticSpecSchema = z.strictObject({ ...NarrativeQuestionSpecSchema.shape, diagnostic: NarrativeDiagnosticSchema });
export type NarrativeDiagnosticSpec = z.infer<typeof NarrativeDiagnosticSpecSchema>;

// ---------------------------------------------------------------------------
// Versions

/** JSON with object keys sorted at every level (stable hashing). */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
            .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
        )
      : Array.isArray(v)
        ? v.map(sort)
        : v;
  return JSON.stringify(sort(value));
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The judged question's identity: its text and filters. */
export const questionVersion = (q: { question: string; filters: RetrievalFilters }): string =>
  `q-${sha256(canonicalJson({ question: q.question, filters: q.filters })).slice(0, 16)}`;

/** The rubric's identity. */
export const rubricVersion = (r: Rubric): string => `r-${sha256(canonicalJson(r)).slice(0, 16)}`;

/**
 * sha256 over the question, paraphrase and diagnostic specs: changes whenever a question,
 * rubric, filter, lure or diagnostic definition does (a set without diagnostics hashes as
 * it did before diagnostics existed).
 */
export const specSha256 = (specs: readonly NarrativeQuestionSpec[], paraphrases: readonly NarrativeParaphraseSpec[], diagnostics: readonly NarrativeDiagnosticSpec[] = []): string =>
  sha256(canonicalJson({ specs, paraphrases, diagnostics: diagnostics.length > 0 ? diagnostics : undefined }));

export const hasAircraftFacet = (f: RetrievalFilters): boolean => AIRCRAFT_FACET_KEYS.some((k) => (f[k] ?? []).length > 0);

// ---------------------------------------------------------------------------
// Checks

/** Problems of a diagnostic's own definition (its question is checked as every question is). */
function diagnosticProblems(d: NarrativeDiagnosticSpec): string[] {
  const problems: string[] = [];
  const parsed = NarrativeDiagnosticSchema.safeParse(d.diagnostic);
  if (!parsed.success) return parsed.error.issues.map((i) => `${d.id}: diagnostic.${i.path.join('.')}: ${i.message}`);
  const c = d.diagnostic.comparison;
  const versions = RETRIEVAL_VERSIONS as readonly string[];
  for (const v of [c.base, ...c.variants]) if (!versions.includes(v)) problems.push(`${d.id}: ${v} is not a retrieval version`);
  if (c.variants.includes(c.base) || new Set(c.variants).size !== c.variants.length) problems.push(`${d.id}: the variants are distinct and exclude the base`);
  if (!c.reported.includes(c.primary)) problems.push(`${d.id}: the primary metric is among the reported ones`);
  for (const k of Object.keys(c.reproduction.expected)) if (k !== c.base && !c.variants.includes(k)) problems.push(`${d.id}: the reproduction names ${k}, which is not compared`);
  if (d.diagnostic.scope && d.diagnostic.scope.samples.some((s, i) => s.sample !== i + 1)) problems.push(`${d.id}: the frozen scope samples are numbered 1, 2, ...`);
  return problems;
}

/**
 * Problems with the committed specs (beyond their cohorts). Empty when usable. Diagnostics
 * are checked as questions (and for their definition), but the set's minimums (questions,
 * paraphrases, bounded cohorts, tags) count benchmark questions only.
 */
export function narrativeSpecProblems(specs: readonly NarrativeQuestionSpec[], paraphrases: readonly NarrativeParaphraseSpec[], diagnostics: readonly NarrativeDiagnosticSpec[] = []): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const d of diagnostics) problems.push(...diagnosticProblems(d));
  for (const s of [...specs, ...diagnostics.map(({ diagnostic: _d, ...q }) => q)]) {
    const parsed = NarrativeQuestionSpecSchema.safeParse(s);
    if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${s.id}: ${i.path.join('.')}: ${i.message}`));
    if (ids.has(s.id)) problems.push(`duplicate question id ${s.id}`);
    ids.add(s.id);
    if (new Set(s.tags).size !== s.tags.length) problems.push(`${s.id}: a tag is listed twice`);
    if (s.tags.includes('aircraft_filter') !== hasAircraftFacet(s.filters)) {
      problems.push(`${s.id}: tagged aircraft_filter exactly when it filters on an aircraft facet`);
    }
    const grades = new Set(s.rubric.edgeCases.map((e) => e.grade));
    if (!grades.has(0) || (!grades.has(1) && !grades.has(2))) problems.push(`${s.id}: the edge cases need a not-relevant case and a (partially) relevant one`);
    if (s.relatedCodes) {
      if (!CodedFiltersSchema.safeParse(s.filters).success) {
        problems.push(`${s.id}: related codes need Track C filters only (years, state, aircraft category, phase group)`);
      }
      for (const c of s.relatedCodes.clauses) if (new Set(c.codes).size !== c.codes.length) problems.push(`${s.id}: a related-code clause lists a code twice`);
      if (s.relatedCodes.clauses.length === 1 && s.relatedCodes.attribution !== 'same-aircraft') problems.push(`${s.id}: a single clause is attributed to one aircraft (same-aircraft)`);
    }
    if (s.lure.trim().toLowerCase() === s.question.trim().toLowerCase()) problems.push(`${s.id}: the lure repeats the question`);
  }
  const byId = new Map(specs.map((s) => [s.id, s]));
  for (const p of paraphrases) {
    const parsed = NarrativeParaphraseSpecSchema.safeParse(p);
    if (!parsed.success) problems.push(...parsed.error.issues.map((i) => `${p.id}: ${i.path.join('.')}: ${i.message}`));
    if (ids.has(p.id)) problems.push(`duplicate question id ${p.id}`);
    ids.add(p.id);
    const of = byId.get(p.of);
    if (!of) problems.push(`${p.id}: paraphrase of unknown question ${p.of}`);
    else if (of.question.trim().toLowerCase() === p.question.trim().toLowerCase()) problems.push(`${p.id}: the paraphrase repeats its original`);
  }
  const all = [...specs.map((s) => s.tags as readonly string[]), ...paraphrases.map((p) => [...(byId.get(p.of)?.tags ?? []), 'paraphrase'])];
  for (const tag of TAGS) {
    const n = all.filter((tags) => tags.includes(tag)).length;
    if (n < MIN_PER_TAG) problems.push(`only ${n} question(s) tagged ${tag} (at least ${MIN_PER_TAG})`);
  }
  if (specs.length + paraphrases.length < MIN_QUESTIONS) problems.push(`only ${specs.length + paraphrases.length} questions (at least ${MIN_QUESTIONS})`);
  if (paraphrases.length < MIN_PARAPHRASES) problems.push(`only ${paraphrases.length} paraphrases (at least ${MIN_PARAPHRASES})`);
  const bounded = specs.filter((s) => s.type === 'bounded-cohort').length;
  if (bounded < MIN_BOUNDED) problems.push(`only ${bounded} bounded cohorts (at least ${MIN_BOUNDED})`);
  return [...new Set(problems)];
}
