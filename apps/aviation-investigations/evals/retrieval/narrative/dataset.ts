/**
 * The narrative-relevance dataset (Track N): every question with its versions, its
 * cohort and the coded positives of its related codes, derived from one generation.
 *
 * **Cohort.** A question's cohort is every answer-eligible US case its filters can
 * reach, with the semantics of the passages index (`passages-v2`, the filter AI
 * retrieval compiles): values within a facet are alternatives, facets and the year range
 * all apply; an event facet (state, injury, conditions, light) reads the event's value;
 * with an aircraft facet (category, phase group, engine, FAR part, purpose) a
 * single-aircraft event qualifies when its aircraft meets every active facet, and an
 * event with several aircraft qualifies only when every aircraft meets every active
 * facet (the event-level qualification). A missing value fails its facet (a question
 * never asks for `blank`). The pool builder checks the derivation against the passages
 * index itself before anything is paid.
 *
 * A bounded cohort records every case (it is judged completely); a broad question
 * records only its size. Related-code positives come from the Track C derivation
 * (`deriveQuestion`) under the question's filters, and must lie in the cohort.
 */
import { z } from 'zod';
import type { RetrievalFilters } from '../../../server/search/filters.js';
import { CodeSetSchema } from '../coded/coded.js';
import { GENERATION_IDENTITY_FIELDS, type GenerationSource } from '../generation.js';
import {
  BOUNDED_MAX,
  CAVEAT,
  CaseNoSchema,
  MAX_RELATED_POSITIVES,
  MIN_BOUNDED,
  MIN_PARAPHRASES,
  MIN_PER_TAG,
  MIN_QUESTIONS,
  NARRATIVE_VERSION,
  NarrativeFiltersSchema,
  QUESTION_TYPES,
  QuestionIdSchema,
  REFERENCE,
  RubricSchema,
  TAGS,
  narrativeSpecProblems,
  questionVersion,
  rubricVersion,
  specSha256,
  type NarrativeParaphraseSpec,
  type NarrativeQuestionSpec,
} from './spec.js';

// ---------------------------------------------------------------------------
// Cohorts

export interface CohortAircraft {
  aircraftKey: number;
  category: string | null;
  /** The aircraft's defining-event phase group (what the phase filter reads). */
  phase: string | null;
  farPart: string | null;
  purpose: string | null;
  /** Distinct engine types recorded for the aircraft. */
  engines: readonly string[];
}

export interface CohortCase {
  ntsbNo: string;
  evYear: number | null;
  state: string | null;
  injury: string | null;
  /** `wx_cond_basic`. */
  conditions: string | null;
  light: string | null;
  aircraft: readonly CohortAircraft[];
}

const EVENT_FACET = {
  state: (c: CohortCase) => c.state,
  injury: (c: CohortCase) => c.injury,
  conditions: (c: CohortCase) => c.conditions,
  light: (c: CohortCase) => c.light,
} as const;

const AIRCRAFT_FACET = {
  category: (a: CohortAircraft) => [a.category],
  phase: (a: CohortAircraft) => [a.phase],
  far_part: (a: CohortAircraft) => [a.farPart],
  purpose: (a: CohortAircraft) => [a.purpose],
  engine: (a: CohortAircraft) => [...a.engines],
} as const;

/** The aircraft meets every active aircraft facet (a missing value fails). */
function aircraftMeets(a: CohortAircraft, f: RetrievalFilters): boolean {
  for (const [facet, of] of Object.entries(AIRCRAFT_FACET) as [keyof typeof AIRCRAFT_FACET, (a: CohortAircraft) => (string | null)[]][]) {
    const wanted = f[facet] ?? [];
    if (wanted.length === 0) continue;
    if (!of(a).some((v) => v !== null && (wanted as readonly string[]).includes(v))) return false;
  }
  return true;
}

const aircraftFacetActive = (f: RetrievalFilters): boolean => Object.keys(AIRCRAFT_FACET).some((k) => (f[k as keyof typeof AIRCRAFT_FACET] ?? []).length > 0);

/** The case is in the filters' cohort (module comment). The caller passes answer-eligible US cases only. */
export function inCohort(c: CohortCase, f: RetrievalFilters): boolean {
  if (f.yearFrom !== undefined && (c.evYear === null || c.evYear < f.yearFrom)) return false;
  if (f.yearTo !== undefined && (c.evYear === null || c.evYear > f.yearTo)) return false;
  for (const [facet, of] of Object.entries(EVENT_FACET) as [keyof typeof EVENT_FACET, (c: CohortCase) => string | null][]) {
    const wanted = f[facet] ?? [];
    if (wanted.length === 0) continue;
    const v = of(c);
    if (v === null || !(wanted as readonly string[]).includes(v)) return false;
  }
  if (!aircraftFacetActive(f)) return true;
  if (c.aircraft.length === 0) return false;
  return c.aircraft.every((a) => aircraftMeets(a, f));
}

/** Sorted case numbers of the cohort. */
export function deriveCohort(cases: readonly CohortCase[], f: RetrievalFilters): string[] {
  return cases
    .filter((c) => inCohort(c, f))
    .map((c) => c.ntsbNo)
    .sort();
}

// ---------------------------------------------------------------------------
// Dataset

export const NarrativeItemSchema = z.strictObject({
  id: QuestionIdSchema,
  question: z.string().min(15).max(400),
  /** The original question whose rubric and judgments this question shares (itself for an original). */
  family: QuestionIdSchema,
  paraphrase_of: QuestionIdSchema.optional(),
  tags: z.array(z.enum(TAGS)).min(1),
  type: z.enum(QUESTION_TYPES),
  filters: NarrativeFiltersSchema,
  /** The judged question's version: the family original's text and filters. */
  questionVersion: z.string().regex(/^q-[0-9a-f]{16}$/),
  /** This question's own text and filters (pool identity). */
  memberVersion: z.string().regex(/^q-[0-9a-f]{16}$/),
  rubric: RubricSchema,
  rubricVersion: z.string().regex(/^r-[0-9a-f]{16}$/),
  lure: z.string().min(10).max(300),
  relatedCodes: CodeSetSchema.optional(),
  cohort: z.strictObject({
    /** Answer-eligible US cases the filters reach. */
    size: z.number().int().nonnegative(),
    /** Bounded cohorts: every case, sorted; broad questions: null. */
    cases: z.array(CaseNoSchema).nullable(),
  }),
  /** Coded positives of the related codes under the filters, sorted (empty without related codes). */
  relatedPositives: z.array(CaseNoSchema),
  note: z.string(),
});
export type NarrativeItem = z.infer<typeof NarrativeItemSchema>;

export const NarrativeDatasetSchema = z.strictObject({
  version: z.literal(NARRATIVE_VERSION),
  reference: z.literal(REFERENCE),
  description: z.string(),
  caveat: z.literal(CAVEAT),
  source: z.strictObject({
    generationId: z.number().int().positive(),
    ...GENERATION_IDENTITY_FIELDS,
    answerEligibleCases: z.number().int().positive(),
    builder: z.string(),
    specSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  limits: z.strictObject({ boundedMax: z.number().int(), maxRelatedPositives: z.number().int() }),
  questions: z.array(NarrativeItemSchema).min(1),
});
export type NarrativeDataset = z.infer<typeof NarrativeDatasetSchema>;

export const DESCRIPTION =
  'Narrative-relevance retrieval set (Track N, task 10c protocol v4): development questions over negation, maintenance ' +
  'chronology, causal uncertainty, pilot-versus-investigator attribution, paraphrase, multi-aircraft and aircraft ' +
  'filters, operational and mechanical concepts, each with a written rubric (2/1/0 with edge cases). Bounded cohorts ' +
  'list every answer-eligible case their filters reach (all judged); broad questions are judged on a pool. Labels ' +
  'are model-judged, never expert-adjudicated. Rebuild with pnpm eval:retrieval:narrative build.';

const sortedUnique = (xs: readonly string[]): boolean => xs.every((x, i) => i === 0 || (xs[i - 1] as string) < x);

/** Problems with a dataset beyond its schema. Empty when usable. */
export function narrativeDatasetProblems(d: NarrativeDataset): string[] {
  const problems: string[] = [];
  const byId = new Map<string, NarrativeItem>();
  for (const q of d.questions) {
    if (byId.has(q.id)) problems.push(`duplicate question id ${q.id}`);
    byId.set(q.id, q);
  }
  for (const q of d.questions) {
    if (q.rubricVersion !== rubricVersion(q.rubric)) problems.push(`${q.id}: rubric version differs from its rubric`);
    if (q.memberVersion !== questionVersion(q)) problems.push(`${q.id}: member version differs from its text and filters`);
    const family = byId.get(q.family);
    if (!family) {
      problems.push(`${q.id}: unknown family ${q.family}`);
      continue;
    }
    if (q.paraphrase_of === undefined) {
      if (q.family !== q.id) problems.push(`${q.id}: an original is its own family`);
      if (q.questionVersion !== q.memberVersion) problems.push(`${q.id}: an original is judged under its own version`);
      if (q.tags.includes('paraphrase')) problems.push(`${q.id}: an original is not tagged paraphrase`);
    } else {
      if (q.paraphrase_of !== q.family) problems.push(`${q.id}: a paraphrase's family is its original`);
      if (family.paraphrase_of !== undefined) problems.push(`${q.id}: paraphrase of a paraphrase`);
      if (!q.tags.includes('paraphrase')) problems.push(`${q.id}: a paraphrase carries the paraphrase tag`);
      for (const field of ['filters', 'type', 'rubric', 'rubricVersion', 'questionVersion', 'cohort', 'relatedPositives', 'relatedCodes', 'lure'] as const) {
        if (JSON.stringify(q[field]) !== JSON.stringify(family[field])) problems.push(`${q.id}: ${field} differs from ${family.id}`);
      }
    }
    if (q.type === 'bounded-cohort') {
      if (q.cohort.size < 1 || q.cohort.size > d.limits.boundedMax) problems.push(`${q.id}: a bounded cohort holds 1..${d.limits.boundedMax} cases, not ${q.cohort.size}`);
      if (!q.cohort.cases || q.cohort.cases.length !== q.cohort.size) problems.push(`${q.id}: a bounded cohort lists every case`);
      else if (!sortedUnique(q.cohort.cases)) problems.push(`${q.id}: cohort cases are not sorted and unique`);
      if (q.cohort.cases && q.relatedPositives.some((n) => !(q.cohort.cases as string[]).includes(n))) problems.push(`${q.id}: a related positive is outside the cohort`);
    } else {
      if (q.cohort.size <= d.limits.boundedMax) problems.push(`${q.id}: a broad question's cohort is larger than ${d.limits.boundedMax} (it holds ${q.cohort.size}); make it a bounded cohort`);
      if (q.cohort.cases !== null) problems.push(`${q.id}: a broad question does not list its cohort`);
    }
    if (!sortedUnique(q.relatedPositives)) problems.push(`${q.id}: related positives are not sorted and unique`);
    if (q.relatedPositives.length > d.limits.maxRelatedPositives) problems.push(`${q.id}: ${q.relatedPositives.length} related positives (at most ${d.limits.maxRelatedPositives}); narrow the related codes`);
    if (q.relatedCodes === undefined && q.relatedPositives.length > 0) problems.push(`${q.id}: related positives without related codes`);
  }
  const originals = d.questions.filter((q) => q.paraphrase_of === undefined);
  const paraphrases = d.questions.filter((q) => q.paraphrase_of !== undefined);
  if (d.questions.length < MIN_QUESTIONS) problems.push(`only ${d.questions.length} questions (at least ${MIN_QUESTIONS})`);
  if (paraphrases.length < MIN_PARAPHRASES) problems.push(`only ${paraphrases.length} paraphrases (at least ${MIN_PARAPHRASES})`);
  const bounded = originals.filter((q) => q.type === 'bounded-cohort').length;
  if (bounded < MIN_BOUNDED) problems.push(`only ${bounded} bounded cohorts (at least ${MIN_BOUNDED})`);
  for (const tag of TAGS) {
    const n = d.questions.filter((q) => q.tags.includes(tag)).length;
    if (n < MIN_PER_TAG) problems.push(`only ${n} question(s) tagged ${tag} (at least ${MIN_PER_TAG})`);
  }
  return [...new Set(problems)];
}

export interface NarrativeBuild {
  dataset: NarrativeDataset;
  problems: string[];
}

/**
 * Pure: the dataset from the specs, each family's cohort (sorted case numbers) and
 * related-code positives (Track C derivation under the family's filters).
 */
export function assembleNarrative(
  source: GenerationSource & { answerEligibleCases: number; builder: string },
  specs: readonly NarrativeQuestionSpec[],
  paraphrases: readonly NarrativeParaphraseSpec[],
  cohorts: ReadonlyMap<string, readonly string[]>,
  related: ReadonlyMap<string, readonly string[]>,
): NarrativeBuild {
  const problems = narrativeSpecProblems(specs, paraphrases);
  const items: NarrativeItem[] = [];
  const byId = new Map<string, NarrativeItem>();
  for (const s of specs) {
    const cohort = cohorts.get(s.id);
    if (!cohort) throw new Error(`no cohort for ${s.id}`);
    const positives = [...(related.get(s.id) ?? [])].sort();
    if (s.relatedCodes === undefined && positives.length > 0) throw new Error(`${s.id}: related positives without related codes`);
    if (s.relatedCodes !== undefined && positives.length === 0) problems.push(`${s.id}: the related codes derive no case under the filters`);
    const inCohortSet = new Set(cohort);
    const outside = positives.filter((n) => !inCohortSet.has(n));
    if (outside.length > 0) problems.push(`${s.id}: ${outside.length} related positive(s) outside the cohort (${outside.slice(0, 3).join(', ')}): the derivations disagree`);
    const v = questionVersion(s);
    const item: NarrativeItem = {
      id: s.id,
      question: s.question,
      family: s.id,
      tags: [...s.tags],
      type: s.type,
      filters: s.filters,
      questionVersion: v,
      memberVersion: v,
      rubric: s.rubric,
      rubricVersion: rubricVersion(s.rubric),
      lure: s.lure,
      ...(s.relatedCodes ? { relatedCodes: s.relatedCodes } : {}),
      cohort: { size: cohort.length, cases: s.type === 'bounded-cohort' ? [...cohort] : null },
      relatedPositives: positives,
      note: s.note,
    };
    if (s.type === 'bounded-cohort' && cohort.length > BOUNDED_MAX) problems.push(`${s.id}: a bounded cohort reaches ${cohort.length} cases (at most ${BOUNDED_MAX})`);
    items.push(item);
    byId.set(item.id, item);
  }
  for (const p of paraphrases) {
    const of = byId.get(p.of);
    if (!of) continue; // reported by the spec check
    items.push({
      ...of,
      id: p.id,
      question: p.question,
      family: of.id,
      paraphrase_of: of.id,
      tags: [...of.tags, 'paraphrase'],
      memberVersion: questionVersion({ question: p.question, filters: of.filters }),
      note: `Paraphrase of ${of.id}. ${p.note}`,
    });
  }
  const dataset: NarrativeDataset = {
    version: NARRATIVE_VERSION,
    reference: REFERENCE,
    description: DESCRIPTION,
    caveat: CAVEAT,
    source: {
      generationId: source.generationId,
      archiveSha256: source.archiveSha256,
      mappingVersion: source.mappingVersion,
      fieldNormalizationVersion: source.fieldNormalizationVersion,
      citationTextVersion: source.citationTextVersion,
      answerEligibleCases: source.answerEligibleCases,
      builder: source.builder,
      specSha256: specSha256(specs, paraphrases),
    },
    limits: { boundedMax: BOUNDED_MAX, maxRelatedPositives: MAX_RELATED_POSITIVES },
    questions: items,
  };
  const parsed = NarrativeDatasetSchema.safeParse(dataset);
  problems.push(...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)), ...narrativeDatasetProblems(dataset));
  return { dataset, problems: [...new Set(problems)] };
}

/** Each family's judged question and rubric (one entry per original). */
export const families = (d: NarrativeDataset): NarrativeItem[] => d.questions.filter((q) => q.paraphrase_of === undefined);

/** The members of a family (the original first, then its paraphrases). */
export const membersOf = (d: NarrativeDataset, family: string): NarrativeItem[] => d.questions.filter((q) => q.family === family);
