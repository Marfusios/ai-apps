/**
 * The silver retrieval set (amendment A13; review gate G5): questions whose expected
 * cases are derived from structured fields plus explicit keyword criteria, never
 * picked by hand.
 *
 * A question carries:
 * - the text a user would type, and the filters the scope stage would emit for it
 *   (only what the question states: years, state, aircraft category, injury). An
 *   aircraft category filter goes with a rule retrieval can satisfy: a
 *   single-aircraft rule (`maxAircraft: 1`, `categoryAny` = the filter), or an
 *   every-aircraft rule (`categoryEvery` = the one filtered category). The second
 *   derives multi-aircraft events, which a passages index reaches under the filter
 *   only through the event-level aircraft qualification (`passages-v2`; tag
 *   `multi_aircraft_filtered`, `needsEventAircraftQualification`);
 * - `criteria`: the derivation rule. `compileCriteria` turns it into one SQL query over
 *   the canonical corpus of a generation; `describeCriteria` into a sentence an
 *   expert can re-check. Text patterns are PostgreSQL case-insensitive regular
 *   expressions (`~*`, ARE syntax: `\y` is a word boundary) matched against one
 *   section's text at a time;
 * - `section`: `rag` (scored by the retrieval evaluation) or `structured` (answered
 *   by structured fields such as inspection dates; kept for a structured or combined
 *   evaluation and excluded from RAG metrics);
 * - `paraphrase_of`, for an independently worded paraphrase of another question: the
 *   same rule, filters and expected set, different words;
 * - `adjudication: "pending-expert"`: labels are silver until an instructor or
 *   analyst has reviewed them (DESIGN §12).
 *
 * The expected set is every answer-eligible US case (the passages index cohort) the
 * rule selects, in full: never capped or shared out. A rule must select 1 to
 * `MAX_EXPECTED` cases, so candidate Recall@20 can reach 100%.
 *
 * **Held out by case.** Questions that share any expected case, and a question and
 * its paraphrases, form one connected group; whole groups are assigned to `dev` or
 * `holdout` (`assignSplits`) before anything is scored. No case is expected in both
 * splits, so tuning on `dev` cannot see a `holdout` case.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RetrievalFiltersSchema } from '../../server/search/filters.js';

export const SILVER_VERSION = 'silver-v1';
export const MIN_EXPECTED = 1;
export const MAX_EXPECTED = 20;
/** RAG questions (originals and paraphrases) the set must hold. */
export const MIN_QUESTIONS = 40;

export const TAGS = [
  'seed',
  'negation',
  'causal_uncertainty',
  'maintenance_timing',
  'multi_aircraft',
  'mechanical',
  'operational',
  'structured_timing',
  'paraphrase',
  /** Multi-aircraft events asked for under an aircraft filter: reachable only with the event-level qualification. */
  'multi_aircraft_filtered',
] as const;
export type Tag = (typeof TAGS)[number];
/** Every one of these tags must be covered by several RAG questions, in both splits (A13, G5). */
export const REQUIRED_TAGS: readonly Tag[] = ['negation', 'causal_uncertainty', 'maintenance_timing', 'multi_aircraft'];
export const MIN_PER_REQUIRED_TAG = 6;
/** Independently worded paraphrases (G5 ruling b). */
export const MIN_PARAPHRASES = 12;

export const SECTIONS = ['rag', 'structured'] as const;
export type Section = (typeof SECTIONS)[number];
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
   * At most this many aircraft. A question with an aircraft filter and a
   * `categoryAny` rule uses 1: an event-scoped passage of a multi-aircraft event
   * satisfies an aircraft filter only when every aircraft of the event does (the
   * event-level qualification of `passages-v2`; `passages-v1` never), so such a
   * rule's multi-aircraft events are not expected cases.
   */
  maxAircraft: z.number().int().min(1).optional(),
  /** Some aircraft has one of these categories. */
  categoryAny: z.array(z.string().regex(/^[A-Z]{3,4}$/)).min(1).optional(),
  /** For each listed category, some aircraft has it (e.g. a helicopter and an airplane). */
  categoriesAll: z.array(z.string().regex(/^[A-Z]{3,4}$/)).min(1).optional(),
  /**
   * Every aircraft has this category. With the category filter of the same value, the
   * rule's multi-aircraft events are what the event-level qualification reaches.
   */
  categoryEvery: z.string().regex(/^[A-Z]{3,4}$/).optional(),
  /** Some aircraft flew for one of these purposes. */
  purposeAny: z.array(z.string().regex(/^[A-Z0-9]{3,4}$/)).min(1).optional(),
  /** Some aircraft had its last inspection at most this many days before the event. */
  inspectedWithinDays: z.number().int().min(0).optional(),
  /** Some aircraft had flown at most this many hours since its last inspection (`afm_hrs_last_insp`). */
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

const QuestionId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60);

export const QuestionSpecSchema = z.strictObject({
  id: QuestionId,
  question: z.string().min(10).max(1500),
  tags: z.array(z.enum(TAGS)).min(1),
  /** Default `rag`. */
  section: z.enum(SECTIONS).optional(),
  filters: RetrievalFiltersSchema,
  criteria: CriteriaSchema,
  /** Why the rule stands for the question, and what an expert should check first. */
  note: z.string().min(1).max(600),
});
export type QuestionSpec = z.infer<typeof QuestionSpecSchema>;

/** A paraphrase: another question's rule, filters and expected set, in other words. */
export const ParaphraseSpecSchema = z.strictObject({
  id: QuestionId,
  of: QuestionId,
  question: z.string().min(10).max(1500),
  /** The label words the paraphrase avoids. */
  avoids: z.array(z.string().min(1)).min(1),
});
export type ParaphraseSpec = z.infer<typeof ParaphraseSpecSchema>;

export const DatasetItemSchema = z.strictObject({
  id: QuestionId,
  question: QuestionSpecSchema.shape.question,
  tags: QuestionSpecSchema.shape.tags,
  section: z.enum(SECTIONS),
  /** Set on an independently worded paraphrase: the question it rewords. */
  paraphrase_of: QuestionId.optional(),
  filters: RetrievalFiltersSchema,
  /** Every case the rule derives: the full positive set. */
  expected: z.array(z.string().regex(/^[A-Z0-9]{6,16}$/)).min(MIN_EXPECTED).max(MAX_EXPECTED),
  derivation: z.strictObject({ rule: z.string().min(1), criteria: CriteriaSchema, note: z.string() }),
  /** The connected group (shared cases, paraphrases) the question was split with. */
  group: z.string().regex(/^g[0-9]+$/),
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
    // `afm_hrs_last_insp` already is the hours since the last inspection (data dictionary).
    where.push(aircraft(`a.afm_hrs_last_insp between 0 and ${v(c.hoursSinceInspectionMax)}`));
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
  if (c.hoursSinceInspectionMax !== undefined) {
    parts.push(`with an aircraft at most ${c.hoursSinceInspectionMax} hours since its last inspection (afm_hrs_last_insp)`);
  }
  if (c.sequence) parts.push(`with a sequence-of-events entry matching /${c.sequence}/`);
  if (c.finding) parts.push(`with a finding matching /${c.finding}/`);
  const matches = (c.text ?? []).map((r) => `the ${kinds(r.in)} matches /${r.pattern}/`);
  const not = (c.textNot ?? []).map((r) => `no ${kinds(r.in)} matches /${r.pattern}/`);
  const text = [...matches, ...not];
  if (text.length === 0) return `${parts.join(' ')}.`;
  return `${parts.join(' ')}, where ${text.join(' and ')} (case-insensitive PostgreSQL regular expressions, one section at a time).`;
}

/** sha256 over the question and paraphrase specs: changes whenever a question or rule does. */
export function rulesSha256(specs: readonly QuestionSpec[], paraphrases: readonly ParaphraseSpec[] = []): string {
  return createHash('sha256').update(JSON.stringify({ specs, paraphrases })).digest('hex');
}

// ---------------------------------------------------------------------------
// Evidence criterion (question-specific evidence coverage)

/**
 * A PostgreSQL ARE pattern of the rules as a JavaScript regular expression: `\y`
 * (word boundary) becomes `\b`; the rules use no other ARE-only syntax.
 */
export function jsPattern(pattern: string): RegExp {
  return new RegExp(pattern.replace(/\\y/g, '\\b'), 'iu');
}

/**
 * True when `passages` (one case's bundle passages) satisfy every text rule of the
 * question: each rule matched by some passage of its section kinds. Null when the rule
 * has no text part (structured-only rules).
 */
export function satisfiesTextCriterion(criteria: Criteria, passages: readonly { sectionKind: string; text: string }[]): boolean | null {
  const rules = criteria.text ?? [];
  if (rules.length === 0) return null;
  return rules.every((rule) => {
    const re = jsPattern(rule.pattern);
    return passages.some((p) => (rule.in as readonly string[]).includes(p.sectionKind) && re.test(p.text));
  });
}

// ---------------------------------------------------------------------------
// Held out by case

export interface GroupedSplits {
  /** Split per question id. */
  split: Map<string, 'dev' | 'holdout'>;
  /** Group label per question id (`g1`, `g2`, …, numbered in assignment order). */
  group: Map<string, string>;
  /** Question ids per group, in assignment order. */
  groups: { id: string; questions: string[]; split: 'dev' | 'holdout' }[];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Split questions into `dev` and `holdout` by connected group. Questions that share an
 * expected case, and a paraphrase and its original (`links`), are joined with a
 * union-find into one group, so every case lies in one split. Groups are placed in
 * sha256 order of their question ids, each into the split that
 * 1. still lacks more of the required tags the group's RAG questions carry (so a
 *    required tag spread over several groups reaches both splits);
 * 2. then has fewer questions of the group's primary tag (the first tag of its first
 *    question);
 * 3. then has fewer questions overall; ties go to `dev`.
 */
export function assignSplits(
  items: readonly { id: string; tags: readonly Tag[]; expected: readonly string[]; section?: Section }[],
  links: readonly [string, string][] = [],
): GroupedSplits {
  const parent = new Map<string, string>(items.map((q) => [q.id, q.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) throw new Error(`unknown question in a split link: ${a} / ${b}`);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const owner = new Map<string, string>();
  for (const q of items) {
    for (const ntsbNo of q.expected) {
      const other = owner.get(ntsbNo);
      if (other === undefined) owner.set(ntsbNo, q.id);
      else union(q.id, other);
    }
  }
  for (const [a, b] of links) union(a, b);
  const byId = new Map(items.map((q) => [q.id, q]));
  const members = new Map<string, string[]>();
  for (const q of items) members.set(find(q.id), [...(members.get(find(q.id)) ?? []), q.id]);
  const ordered = [...members.values()]
    .map((ids) => [...ids].sort())
    .map((ids) => ({ ids, key: sha(ids.join('\n')), tag: byId.get(ids[0] as string)?.tags[0] ?? 'none' }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out: GroupedSplits = { split: new Map(), group: new Map(), groups: [] };
  const total = { dev: 0, holdout: 0 };
  const perTag = new Map<string, { dev: number; holdout: number }>();
  /** RAG questions per required tag and split. */
  const required = new Map<Tag, { dev: number; holdout: number }>(REQUIRED_TAGS.map((t) => [t, { dev: 0, holdout: 0 }]));
  ordered.forEach((g, i) => {
    const rag = g.ids.map((id) => byId.get(id)).filter((q) => q !== undefined && (q.section ?? 'rag') === 'rag');
    const tags = REQUIRED_TAGS.filter((tag) => rag.some((q) => q?.tags.includes(tag)));
    const lacking = (s: 'dev' | 'holdout') => tags.filter((tag) => (required.get(tag) as { dev: number; holdout: number })[s] === 0).length;
    const t = perTag.get(g.tag) ?? { dev: 0, holdout: 0 };
    const gap = lacking('holdout') - lacking('dev');
    const split =
      gap < 0 ? 'dev' : gap > 0 ? 'holdout' : t.dev < t.holdout ? 'dev' : t.holdout < t.dev ? 'holdout' : total.dev <= total.holdout ? 'dev' : 'holdout';
    t[split] += g.ids.length;
    total[split] += g.ids.length;
    perTag.set(g.tag, t);
    for (const tag of tags) (required.get(tag) as { dev: number; holdout: number })[split] += rag.filter((q) => q?.tags.includes(tag)).length;
    const label = `g${i + 1}`;
    out.groups.push({ id: label, questions: g.ids, split });
    for (const id of g.ids) {
      out.split.set(id, split);
      out.group.set(id, label);
    }
  });
  return out;
}

const sameSet = (a: readonly (string | number)[] | undefined, b: readonly (string | number)[] | undefined) =>
  JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

/**
 * True when a question's expected cases can include multi-aircraft events that only
 * the event-level aircraft qualification (`passages-v2`) reaches: it filters by an
 * aircraft facet and its rule is not single-aircraft. A passages index without the
 * qualification can never retrieve those events under the filter.
 */
export function needsEventAircraftQualification(q: { filters: DatasetItem['filters']; criteria: Criteria }): boolean {
  const f = q.filters;
  const aircraftFilter = (['phase', 'category', 'engine', 'far_part', 'purpose'] as const).some((k) => (f[k] ?? []).length > 0);
  return aircraftFilter && q.criteria.maxAircraft !== 1;
}

/**
 * A question's filters must say what its rule says: the same years, states and
 * injury, and an aircraft category filter only with a rule retrieval can satisfy
 * under it: a single-aircraft rule of the same categories (amendment A3), or an
 * every-aircraft rule of the one filtered category (the event-level qualification).
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
    if (c.categoryEvery !== undefined) {
      // Every aircraft of a derived event has the one filtered category: each derived event satisfies the filter.
      if (!sameSet(f.category, [c.categoryEvery])) out.push(`${q.id}: filter category differs from the rule's categoryEvery`);
      // An event without aircraft rows passes "every aircraft" vacuously but never an aircraft filter.
      if ((c.minAircraft ?? 0) < 1) out.push(`${q.id}: an every-aircraft rule under an aircraft filter needs minAircraft`);
      if (c.categoryAny || c.categoriesAll) out.push(`${q.id}: an every-aircraft rule states its category once (categoryEvery)`);
    } else {
      if (!sameSet(f.category, c.categoryAny)) out.push(`${q.id}: filter category differs from the rule's categoryAny`);
      if (c.maxAircraft !== 1) out.push(`${q.id}: an aircraft filter needs a single-aircraft rule (maxAircraft 1) or an every-aircraft rule (categoryEvery)`);
    }
  }
  return out;
}

/** Problems with a dataset beyond its schema: coverage, seeds, splits, filters, paraphrases. Empty when it is usable. */
export function datasetProblems(d: Dataset): string[] {
  const problems: string[] = [];
  const byId = new Map<string, DatasetItem>();
  for (const q of d.questions) {
    if (byId.has(q.id)) problems.push(`duplicate question id ${q.id}`);
    byId.set(q.id, q);
    if (new Set(q.expected).size !== q.expected.length) problems.push(`${q.id}: duplicate expected case`);
    problems.push(...filterProblems({ id: q.id, filters: q.filters, criteria: q.derivation.criteria }));
    const needs = needsEventAircraftQualification({ filters: q.filters, criteria: q.derivation.criteria });
    if (needs !== q.tags.includes('multi_aircraft_filtered')) {
      problems.push(`${q.id}: the multi_aircraft_filtered tag marks exactly the questions that need the event-level aircraft qualification`);
    }
    if ((q.section === 'structured') !== q.tags.includes('structured_timing')) {
      problems.push(`${q.id}: only structured questions carry the structured_timing tag`);
    }
  }
  const rag = d.questions.filter((q) => q.section === 'rag');
  for (const tag of REQUIRED_TAGS) {
    const n = rag.filter((q) => q.tags.includes(tag) && q.paraphrase_of === undefined).length;
    if (n < MIN_PER_REQUIRED_TAG) problems.push(`only ${n} original RAG ${tag} questions (at least ${MIN_PER_REQUIRED_TAG})`);
    for (const split of ['dev', 'holdout'] as const) {
      if (!rag.some((q) => q.split === split && q.tags.includes(tag))) problems.push(`no ${split} RAG question tagged ${tag}`);
    }
  }
  const paraphrases = d.questions.filter((q) => q.paraphrase_of !== undefined);
  if (paraphrases.length < MIN_PARAPHRASES) problems.push(`only ${paraphrases.length} paraphrases (at least ${MIN_PARAPHRASES})`);
  for (const q of paraphrases) {
    const of = byId.get(q.paraphrase_of as string);
    if (!of) problems.push(`${q.id}: paraphrase of unknown question ${q.paraphrase_of}`);
    else {
      if (of.paraphrase_of !== undefined) problems.push(`${q.id}: paraphrase of a paraphrase`);
      if (JSON.stringify(of.expected) !== JSON.stringify(q.expected)) problems.push(`${q.id}: expected set differs from ${of.id}`);
      if (of.group !== q.group || of.split !== q.split) problems.push(`${q.id}: not in the group of ${of.id}`);
      if (!q.tags.includes('paraphrase')) problems.push(`${q.id}: a paraphrase carries the paraphrase tag`);
    }
  }
  const seeds = new Set<string>(SEED_CASES);
  if (rag.filter((q) => q.expected.some((n) => !seeds.has(n))).length < MIN_QUESTIONS) {
    problems.push('the set leans on the seed cases: too few RAG questions expect other cases');
  }
  for (const q of d.questions) {
    if (q.expected.every((n) => seeds.has(n))) problems.push(`${q.id} expects seed cases only`);
  }
  const splitOf = new Map<string, string>();
  const groupOf = new Map<string, string>();
  for (const q of d.questions) {
    for (const n of q.expected) {
      const s = splitOf.get(n);
      if (s !== undefined && s !== q.split) problems.push(`case ${n} is expected in both splits`);
      const g = groupOf.get(n);
      if (g !== undefined && g !== q.group) problems.push(`case ${n} is expected in groups ${g} and ${q.group}`);
      splitOf.set(n, q.split);
      groupOf.set(n, q.group);
    }
  }
  return problems;
}
