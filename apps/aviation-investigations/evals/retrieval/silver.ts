/**
 * The silver retrieval set (amendment A13): questions whose expected cases are derived
 * from structured fields plus explicit keyword criteria, never picked by hand.
 *
 * A question carries:
 * - the text a user would type, and the filters the scope stage would emit for it
 *   (only what the question states: years, state, aircraft category, injury);
 * - `criteria`: the derivation rule. `compileCriteria` turns it into one SQL query over
 *   the canonical corpus of a generation; `describeCriteria` into a sentence an
 *   expert can re-check. Text patterns are PostgreSQL case-insensitive regular
 *   expressions (`~*`, ARE syntax: `\y` is a word boundary) matched against one
 *   section's text at a time.
 * - `adjudication: "pending-expert"`: labels are silver until an instructor or
 *   analyst has reviewed them (DESIGN §12).
 *
 * The expected set is every answer-eligible US case (the passages index cohort) the
 * rule selects. It must hold 1 to `MAX_EXPECTED` cases, so Recall@20 can reach 100%.
 *
 * **Held out by case.** Every case is expected by one question at most: a case several
 * rules derive stays with the first question in rule order and is listed under
 * `derivation.sharedWith` in the others (`disjointExpected`). Questions are then split
 * into `dev` and `holdout`, stratified by primary tag (`assignSplits`). No case is
 * expected in both splits, so tuning on `dev` cannot leak passages of a `holdout` case.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RetrievalFiltersSchema } from '../../server/search/filters.js';

export const SILVER_VERSION = 'silver-v1';
export const MIN_EXPECTED = 1;
export const MAX_EXPECTED = 20;
export const MIN_QUESTIONS = 40;

export const TAGS = ['seed', 'negation', 'causal_uncertainty', 'maintenance_timing', 'multi_aircraft', 'mechanical', 'operational'] as const;
export type Tag = (typeof TAGS)[number];
/** Every one of these tags must be covered by several questions (A13). */
export const REQUIRED_TAGS: readonly Tag[] = ['negation', 'causal_uncertainty', 'maintenance_timing', 'multi_aircraft'];
export const MIN_PER_REQUIRED_TAG = 6;
/** The four seed cases of DATA_REVIEW.md. They may be expected cases, never the whole set. */
export const SEED_CASES = ['DFW08TA066', 'DEN08LA103', 'MIA08LA156', 'NYC08LA106'] as const;

export const SECTION_KINDS = ['factual', 'analysis', 'probable_cause'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

const Pattern = z.string().min(1).max(400);
const TextRuleSchema = z.strictObject({
  /** The sections the pattern is matched against, one section at a time. */
  in: z.array(z.enum(SECTION_KINDS)).min(1),
  pattern: Pattern,
});
export type TextRule = z.infer<typeof TextRuleSchema>;

export const CriteriaSchema = z.strictObject({
  years: z.tuple([z.number().int(), z.number().int()]).optional(),
  states: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).optional(),
  injury: z.array(z.string().regex(/^[A-Z]{3,4}$/)).min(1).optional(),
  /** At least this many aircraft in the event. */
  minAircraft: z.number().int().min(1).optional(),
  /**
   * At most this many aircraft. Questions with an aircraft filter use 1: under an
   * aircraft filter the passages of a multi-aircraft event are event-scoped and never
   * retrievable (amendment A3), so such an event cannot be an expected case.
   */
  maxAircraft: z.number().int().min(1).optional(),
  /** Some aircraft has one of these categories. */
  categoryAny: z.array(z.string().regex(/^[A-Z]{3,4}$/)).min(1).optional(),
  /** For each listed category, some aircraft has it (e.g. a helicopter and an airplane). */
  categoriesAll: z.array(z.string().regex(/^[A-Z]{3,4}$/)).min(1).optional(),
  /** Every aircraft has this category. */
  categoryEvery: z.string().regex(/^[A-Z]{3,4}$/).optional(),
  /** Some aircraft flew for one of these purposes. */
  purposeAny: z.array(z.string().regex(/^[A-Z0-9]{3,4}$/)).min(1).optional(),
  /** Some aircraft had its last inspection at most this many days before the event. */
  inspectedWithinDays: z.number().int().min(0).optional(),
  /** Some aircraft had flown at most this many airframe hours since its last inspection. */
  hoursSinceInspectionMax: z.number().min(0).optional(),
  /** Some sequence-of-events row's description matches. */
  sequence: Pattern.optional(),
  /** Some finding's description matches. */
  finding: Pattern.optional(),
  /** Every rule matches some section of its kinds. */
  text: z.array(TextRuleSchema).optional(),
  /** No rule matches any section of its kinds. */
  textNot: z.array(TextRuleSchema).optional(),
});
export type Criteria = z.infer<typeof CriteriaSchema>;

export const QuestionSpecSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60),
  question: z.string().min(10).max(1500),
  tags: z.array(z.enum(TAGS)).min(1),
  filters: RetrievalFiltersSchema,
  criteria: CriteriaSchema,
  /** Why the rule stands for the question, and what an expert should check first. */
  note: z.string().min(1).max(600),
});
export type QuestionSpec = z.infer<typeof QuestionSpecSchema>;

export const DatasetItemSchema = z.strictObject({
  id: QuestionSpecSchema.shape.id,
  question: QuestionSpecSchema.shape.question,
  tags: QuestionSpecSchema.shape.tags,
  filters: RetrievalFiltersSchema,
  expected: z.array(z.string().regex(/^[A-Z0-9]{6,16}$/)).min(MIN_EXPECTED).max(MAX_EXPECTED),
  derivation: z.strictObject({
    rule: z.string().min(1),
    criteria: CriteriaSchema,
    note: z.string(),
    /** Cases the rule also derives that an earlier question keeps (held out by case). */
    sharedWith: z.array(z.strictObject({ ntsbNo: z.string(), keptIn: z.string() })),
  }),
  split: z.enum(['dev', 'holdout']),
  adjudication: z.literal('pending-expert'),
});
export type DatasetItem = z.infer<typeof DatasetItemSchema>;

export const DatasetSchema = z.strictObject({
  version: z.literal(SILVER_VERSION),
  description: z.string(),
  adjudication: z.literal('pending-expert'),
  source: z.strictObject({
    generationId: z.number().int().positive(),
    answerEligibleCases: z.number().int().nonnegative(),
    builder: z.string(),
    rulesSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  limits: z.strictObject({ minExpected: z.number().int(), maxExpected: z.number().int() }),
  questions: z.array(DatasetItemSchema).min(MIN_QUESTIONS),
});
export type Dataset = z.infer<typeof DatasetSchema>;

// ---------------------------------------------------------------------------
// Criteria → SQL

export interface CompiledQuery {
  text: string;
  values: unknown[];
}

/**
 * One SQL query selecting the case numbers a rule derives from generation `$1`,
 * answer-eligible US cases only, sorted. Every value is a bind parameter.
 */
export function compileCriteria(criteria: Criteria): CompiledQuery {
  const c = CriteriaSchema.parse(criteria);
  const values: unknown[] = [];
  const v = (x: unknown) => {
    values.push(x);
    return `$${values.length + 1}`;
  };
  const aircraft = (cond: string) =>
    `exists (select 1 from case_aircraft a where a.generation_id = c.generation_id and a.ntsb_no = c.ntsb_no and ${cond})`;
  const section = (rule: TextRule) =>
    `exists (select 1 from case_sections s where s.generation_id = c.generation_id and s.ntsb_no = c.ntsb_no and s.kind = any(${v(rule.in)}::text[]) and s.text ~* ${v(rule.pattern)})`;
  const where: string[] = ['c.generation_id = $1', 'c.answer_eligible', 'c.is_us'];
  if (c.years) where.push(`c.ev_year between ${v(c.years[0])} and ${v(c.years[1])}`);
  if (c.states) where.push(`c.state = any(${v(c.states)}::text[])`);
  if (c.injury) where.push(`c.highest_injury = any(${v(c.injury)}::text[])`);
  const aircraftCount = '(select count(*) from case_aircraft a where a.generation_id = c.generation_id and a.ntsb_no = c.ntsb_no)';
  if (c.minAircraft !== undefined) where.push(`${aircraftCount} >= ${v(c.minAircraft)}`);
  if (c.maxAircraft !== undefined) where.push(`${aircraftCount} <= ${v(c.maxAircraft)}`);
  if (c.categoryAny) where.push(aircraft(`a.category = any(${v(c.categoryAny)}::text[])`));
  for (const category of c.categoriesAll ?? []) where.push(aircraft(`a.category = ${v(category)}`));
  if (c.categoryEvery) where.push(`not ${aircraft(`a.category is distinct from ${v(c.categoryEvery)}`)}`);
  if (c.purposeAny) where.push(aircraft(`a.purpose = any(${v(c.purposeAny)}::text[])`));
  if (c.inspectedWithinDays !== undefined) {
    where.push(aircraft(`a.date_last_insp <= c.ev_date and c.ev_date - a.date_last_insp <= ${v(c.inspectedWithinDays)}`));
  }
  if (c.hoursSinceInspectionMax !== undefined) {
    where.push(aircraft(`a.afm_hrs >= a.afm_hrs_last_insp and a.afm_hrs - a.afm_hrs_last_insp <= ${v(c.hoursSinceInspectionMax)}`));
  }
  if (c.sequence) {
    where.push(`exists (select 1 from case_sequence q where q.generation_id = c.generation_id and q.ntsb_no = c.ntsb_no and q.description ~* ${v(c.sequence)})`);
  }
  if (c.finding) {
    where.push(`exists (select 1 from case_findings f where f.generation_id = c.generation_id and f.ntsb_no = c.ntsb_no and f.description ~* ${v(c.finding)})`);
  }
  for (const rule of c.text ?? []) where.push(section(rule));
  for (const rule of c.textNot ?? []) where.push(`not ${section(rule)}`);
  return { text: `select c.ntsb_no from cases c where ${where.join('\n  and ')}\norder by c.ntsb_no`, values };
}

const KIND_LABEL: Readonly<Record<SectionKind, string>> = { factual: 'factual narrative', analysis: 'analysis', probable_cause: 'probable cause' };
const kinds = (list: readonly SectionKind[]) => list.map((k) => KIND_LABEL[k]).join(' or ');
const list = (xs: readonly (string | number)[]) => xs.join(', ');

/** The rule as a sentence: what an expert re-checks. */
export function describeCriteria(criteria: Criteria): string {
  const c = CriteriaSchema.parse(criteria);
  const parts: string[] = ['Answer-eligible US cases'];
  if (c.years) parts.push(c.years[0] === c.years[1] ? `from ${c.years[0]}` : `from ${c.years[0]} to ${c.years[1]}`);
  if (c.states) parts.push(`in ${list(c.states)}`);
  if (c.injury) parts.push(`with highest injury ${list(c.injury)}`);
  if (c.minAircraft !== undefined) parts.push(`with at least ${c.minAircraft} aircraft`);
  if (c.maxAircraft !== undefined) parts.push(c.maxAircraft === 1 ? 'with a single aircraft' : `with at most ${c.maxAircraft} aircraft`);
  if (c.categoryAny) parts.push(`with an aircraft of category ${list(c.categoryAny)}`);
  if (c.categoriesAll) parts.push(`with aircraft of every category ${list(c.categoriesAll)}`);
  if (c.categoryEvery) parts.push(`where every aircraft is ${c.categoryEvery}`);
  if (c.purposeAny) parts.push(`with an aircraft flying for purpose ${list(c.purposeAny)}`);
  if (c.inspectedWithinDays !== undefined) parts.push(`with an aircraft inspected at most ${c.inspectedWithinDays} days before the event`);
  if (c.hoursSinceInspectionMax !== undefined) parts.push(`with an aircraft at most ${c.hoursSinceInspectionMax} airframe hours past its last inspection`);
  if (c.sequence) parts.push(`with a sequence-of-events entry matching /${c.sequence}/`);
  if (c.finding) parts.push(`with a finding matching /${c.finding}/`);
  const matches = (c.text ?? []).map((r) => `the ${kinds(r.in)} matches /${r.pattern}/`);
  const not = (c.textNot ?? []).map((r) => `no ${kinds(r.in)} matches /${r.pattern}/`);
  const text = [...matches, ...not];
  if (text.length === 0) return `${parts.join(' ')}.`;
  return `${parts.join(' ')}, where ${text.join(' and ')} (case-insensitive PostgreSQL regular expressions, one section at a time).`;
}

/** sha256 over the question specs: changes whenever a question or rule does. */
export function rulesSha256(specs: readonly QuestionSpec[]): string {
  return createHash('sha256').update(JSON.stringify(specs)).digest('hex');
}

// ---------------------------------------------------------------------------
// Held out by case

export interface Derived {
  id: string;
  tags: readonly Tag[];
  /** Every case the rule derives, sorted. */
  derived: readonly string[];
}

export interface Disjoint extends Derived {
  /** The derived cases this question keeps. */
  expected: string[];
  /** Derived cases kept by an earlier question instead. */
  sharedWith: { ntsbNo: string; keptIn: string }[];
}

/**
 * Make expected sets disjoint: a case several rules derive stays with the first
 * question (in rule order) and is recorded as shared in the later ones. Recall of a
 * later question neither credits nor penalizes that case.
 */
export function disjointExpected(items: readonly Derived[]): Disjoint[] {
  const owner = new Map<string, string>();
  return items.map((q) => {
    const expected: string[] = [];
    const sharedWith: Disjoint['sharedWith'] = [];
    for (const ntsbNo of q.derived) {
      const keptIn = owner.get(ntsbNo);
      if (keptIn === undefined) {
        owner.set(ntsbNo, q.id);
        expected.push(ntsbNo);
      } else sharedWith.push({ ntsbNo, keptIn });
    }
    return { ...q, expected, sharedWith };
  });
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * `dev` / `holdout` per question id, held out by case and stratified by primary tag.
 * Questions sharing an expected case form one component and share a split (none do
 * after `disjointExpected`). Components are placed in sha256 order of their ids, each
 * into the split with fewer questions of its primary tag (the first tag of its first
 * question), then with fewer questions overall; ties go to `dev`.
 */
export function assignSplits(items: readonly { id: string; tags: readonly Tag[]; expected: readonly string[] }[]): Map<string, 'dev' | 'holdout'> {
  const parent = new Map<string, string>(items.map((q) => [q.id, q.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  const owner = new Map<string, string>();
  for (const q of items) {
    for (const ntsbNo of q.expected) {
      const other = owner.get(ntsbNo);
      if (other === undefined) owner.set(ntsbNo, q.id);
      else parent.set(find(q.id), find(other));
    }
  }
  const byId = new Map(items.map((q) => [q.id, q]));
  const components = new Map<string, string[]>();
  for (const q of items) components.set(find(q.id), [...(components.get(find(q.id)) ?? []), q.id]);
  const ordered = [...components.values()]
    .map((ids) => [...ids].sort())
    .map((ids) => ({ ids, key: sha(ids.join('\n')), tag: byId.get(ids[0] as string)?.tags[0] ?? 'none' }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out = new Map<string, 'dev' | 'holdout'>();
  const total = { dev: 0, holdout: 0 };
  const perTag = new Map<string, { dev: number; holdout: number }>();
  for (const c of ordered) {
    const t = perTag.get(c.tag) ?? { dev: 0, holdout: 0 };
    const split = t.dev < t.holdout ? 'dev' : t.holdout < t.dev ? 'holdout' : total.dev <= total.holdout ? 'dev' : 'holdout';
    t[split] += c.ids.length;
    total[split] += c.ids.length;
    perTag.set(c.tag, t);
    for (const id of c.ids) out.set(id, split);
  }
  return out;
}

const sameSet = (a: readonly (string | number)[] | undefined, b: readonly (string | number)[] | undefined) =>
  JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/**
 * A question's filters must say what its rule says: the same years, states and
 * injury, and an aircraft category filter only with a single-aircraft rule of the
 * same categories (amendment A3).
 */
export function filterProblems(q: Pick<DatasetItem, 'id' | 'filters'> & { criteria: Criteria }): string[] {
  const f = q.filters;
  const c = q.criteria;
  const out: string[] = [];
  const years = f.yearFrom !== undefined || f.yearTo !== undefined ? [f.yearFrom, f.yearTo] : undefined;
  if (JSON.stringify(years) !== JSON.stringify(c.years)) out.push(`${q.id}: filter years differ from the rule's years`);
  if (!sameSet(f.state, c.states)) out.push(`${q.id}: filter states differ from the rule's states`);
  if (!sameSet(f.injury, c.injury)) out.push(`${q.id}: filter injury differs from the rule's injury`);
  for (const facet of ['phase', 'conditions', 'light', 'engine', 'far_part', 'purpose'] as const) {
    if ((f[facet] ?? []).length > 0) out.push(`${q.id}: the silver set does not use the ${facet} filter`);
  }
  if ((f.category ?? []).length > 0) {
    if (!sameSet(f.category, c.categoryAny)) out.push(`${q.id}: filter category differs from the rule's categoryAny`);
    if (c.maxAircraft !== 1) out.push(`${q.id}: an aircraft filter needs a single-aircraft rule (maxAircraft 1)`);
  }
  return out;
}

/** Problems with a dataset beyond its schema: coverage, seeds, splits, filters. Empty when it is usable. */
export function datasetProblems(d: Dataset): string[] {
  const problems: string[] = [];
  for (const q of d.questions) problems.push(...filterProblems({ id: q.id, filters: q.filters, criteria: q.derivation.criteria }));
  const ids = new Set<string>();
  const expectedBy = new Map<string, string>();
  for (const q of d.questions) {
    if (ids.has(q.id)) problems.push(`duplicate question id ${q.id}`);
    ids.add(q.id);
    if (new Set(q.expected).size !== q.expected.length) problems.push(`${q.id}: duplicate expected case`);
    for (const n of q.expected) {
      const other = expectedBy.get(n);
      if (other !== undefined) problems.push(`case ${n} is expected by ${other} and ${q.id}`);
      expectedBy.set(n, q.id);
    }
  }
  for (const tag of REQUIRED_TAGS) {
    const n = d.questions.filter((q) => q.tags.includes(tag)).length;
    if (n < MIN_PER_REQUIRED_TAG) problems.push(`only ${n} ${tag} questions (at least ${MIN_PER_REQUIRED_TAG})`);
  }
  const seeds = new Set<string>(SEED_CASES);
  const nonSeed = d.questions.filter((q) => q.expected.some((n) => !seeds.has(n)));
  if (nonSeed.length < MIN_QUESTIONS) problems.push('the set leans on the seed cases: too few questions expect other cases');
  for (const q of d.questions) {
    if (q.expected.every((n) => seeds.has(n))) problems.push(`${q.id} expects seed cases only`);
  }
  const splitOf = new Map<string, string>();
  for (const q of d.questions) {
    for (const n of q.expected) {
      const s = splitOf.get(n);
      if (s !== undefined && s !== q.split) problems.push(`case ${n} is expected in both splits`);
      splitOf.set(n, q.split);
    }
  }
  for (const split of ['dev', 'holdout'] as const) {
    for (const tag of REQUIRED_TAGS) {
      if (!d.questions.some((q) => q.split === split && q.tags.includes(tag))) problems.push(`no ${split} question tagged ${tag}`);
    }
  }
  return problems;
}
