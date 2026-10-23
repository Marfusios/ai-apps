/**
 * Track N judgment pools (task 10c protocol v4, section 4).
 *
 * **Rule** (`POOL_RULE`, versioned). Per question family, the pool is the union of:
 * - every compared method's first `depth` (100) unique cases (event-deduplicated: the
 *   ranking is of cases), for every member of the family (the original and its
 *   paraphrases) and every scope sample. The methods are the experiment harness's
 *   `p50-kt` (today's retrieval), `c200+n-kt` (N) and `c200+nf-kt` (NF), run with the
 *   question's fixed filters, one query embedding per question and cached scope-stage
 *   keyword texts, so every method sees identical inputs;
 * - every case of a bounded cohort (it is judged completely);
 * - the related codes' coded positives under the filters (protocol: "all Track C coded
 *   positives for the question's cohort");
 * - **hard negatives**: the first `hardNegatives` (10) cases, in BM25 order, of the
 *   family's lure (its question's surface terms in the contrasting situation) searched
 *   over the cases index's narratives (the N channel's fields and filter) that are not
 *   already in the pool; chosen by rule, never by reading a case, and judged like every
 *   other case (a lure case can turn out relevant);
 * - a **tail sample** outside the pool (broad questions): `near` cases drawn from the
 *   methods' unique-case ranks 101 to 300 not in the pool, and `far` cases from the rest
 *   of the cohort, each a seeded sample of fixed size. Its relevant share estimates the
 *   relevant cases the pool missed (a coverage diagnostic, never a metric bound).
 *
 * **Identity.** A family pool's version is sha256 over the rule, the judged question and
 * rubric versions, the members, every run (method, member, sample, ranking and bundle)
 * and the cases with their provenance; the pool file's version covers every family, the
 * target index identities, the embedding and the scope stage. A method that retrieves
 * an unjudged case needs a new pool version, and every comparison is re-scored against
 * one version.
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import type { Embedder } from '../../../server/ai/embeddings.js';
import { compileFilters, type Query } from '../../../server/search/filters.js';
import { assertCompleteResponse, type RetrievalDataset } from '../../../server/search/hybrid.js';
import { uniqueTop } from '../metrics.js';
import { searchCaseChannel } from '../experiments/cases-channel.js';
import type { ExperimentConfig } from '../experiments/config.js';
import { runVariant } from '../experiments/variant.js';
import { seededSample } from './calibration.js';
import { bundleKeyOf } from './judging.js';
import { membersOf, type NarrativeDataset, type NarrativeItem } from './dataset.js';
import type { DeliveredPassage } from './evidence.js';
import { canonicalJson, sha256 } from './spec.js';

export const POOL_RULE = Object.freeze({
  version: 'track-n-pool-v1',
  depth: 100,
  methods: Object.freeze(['p50-kt', 'c200+n-kt', 'c200+nf-kt']),
  scopeSamples: 3,
  hardNegatives: 10,
  /** How deep the lure list is read for new cases. */
  lureDepth: 200,
  tail: Object.freeze({ nearFrom: 101, nearTo: 300, near: 10, far: 10 }),
  /** Unique cases of each run kept in the pool file (the near tail reads up to here). */
  keepRanks: 300,
});
export type PoolRule = typeof POOL_RULE;

export interface BundleCase {
  ntsbNo: string;
  caseRank: number;
  /** The delivered passages in delivered (reading) order; their text is the stored section text at the offsets. */
  passages: (Omit<DeliveredPassage, 'text'> & { textSha256: string })[];
}

export interface PoolRun {
  member: string;
  method: string;
  sample: number;
  /** The first `keepRanks` unique cases of the candidate ranking. */
  ranking: string[];
  /** The packed bundle (at most six cases), in rank order. */
  bundle: BundleCase[];
}

export type PoolSource = 'method' | 'cohort' | 'related' | 'hard-negative' | 'tail-near' | 'tail-far';

export interface PoolCase {
  ntsbNo: string;
  sources: PoolSource[];
  /** Best 1-based unique-case rank per method over the members and samples (only within `depth`); null when outside. */
  bestRank: Record<string, number | null>;
  /** Rank in the lure list when the case came from it. */
  lureRank: number | null;
  /** In some run's delivered bundle. */
  delivered: boolean;
}

export interface FamilyPool {
  family: string;
  questionVersion: string;
  rubricVersion: string;
  type: NarrativeItem['type'];
  members: string[];
  cohortSize: number;
  cases: PoolCase[];
  tail: { nearSize: number; farSize: number; near: string[]; far: string[] };
  runs: PoolRun[];
  version: string;
}

export interface PoolFile {
  kind: 'track-n-pools';
  rule: PoolRule;
  datasetSpecSha256: string;
  generationId: number;
  target: Record<string, unknown>;
  methods: { id: string; config: ExperimentConfig }[];
  families: FamilyPool[];
  version: string;
  /** The code that built it (provenance only, outside the version). */
  git?: { commit: string | null; dirty: boolean | null };
}

/** Pure: one family's pool from its runs, cohort and lure list (module comment). */
export function assemblePool(input: {
  family: NarrativeItem;
  members: readonly NarrativeItem[];
  runs: readonly PoolRun[];
  /** Every case the filters reach (sorted); for a bounded cohort, its recorded cases. */
  cohort: readonly string[];
  /** The lure's BM25 case order. */
  lure: readonly string[];
  rule?: PoolRule;
}): FamilyPool {
  const rule = input.rule ?? POOL_RULE;
  const f = input.family;
  const cases = new Map<string, PoolCase>();
  const add = (n: string, source: PoolSource): PoolCase => {
    let c = cases.get(n);
    if (!c) {
      c = { ntsbNo: n, sources: [], bestRank: Object.fromEntries(rule.methods.map((m) => [m, null])), lureRank: null, delivered: false };
      cases.set(n, c);
    }
    if (!c.sources.includes(source)) c.sources.push(source);
    return c;
  };
  for (const run of input.runs) {
    uniqueTop(run.ranking, rule.depth).forEach((n, i) => {
      const c = add(n, 'method');
      const best = c.bestRank[run.method];
      c.bestRank[run.method] = best === null || best === undefined ? i + 1 : Math.min(best, i + 1);
    });
    for (const b of run.bundle) add(b.ntsbNo, 'method').delivered = true;
  }
  if (f.type === 'bounded-cohort') for (const n of f.cohort.cases ?? []) add(n, 'cohort');
  for (const n of f.relatedPositives) add(n, 'related');
  const inCohort = new Set(input.cohort);
  let taken = 0;
  input.lure.slice(0, rule.lureDepth).forEach((n, i) => {
    if (taken >= rule.hardNegatives || cases.has(n) || !inCohort.has(n)) return;
    add(n, 'hard-negative').lureRank = i + 1;
    taken += 1;
  });
  let near: string[] = [];
  let far: string[] = [];
  let nearSize = 0;
  let farSize = 0;
  if (f.type === 'broad') {
    const deep = new Set<string>();
    for (const run of input.runs) for (const n of uniqueTop(run.ranking, rule.tail.nearTo).slice(rule.tail.nearFrom - 1)) if (!cases.has(n)) deep.add(n);
    const nearPool = [...deep].sort();
    const farPool = input.cohort.filter((n) => !cases.has(n) && !deep.has(n));
    nearSize = nearPool.length;
    farSize = farPool.length;
    near = seededSample(nearPool, rule.tail.near, `${f.family}|${rule.version}|near`).sort();
    far = seededSample(farPool, rule.tail.far, `${f.family}|${rule.version}|far`).sort();
    for (const n of near) add(n, 'tail-near');
    for (const n of far) add(n, 'tail-far');
  }
  const list = [...cases.values()].sort((a, b) => (a.ntsbNo < b.ntsbNo ? -1 : 1));
  const runs = [...input.runs].sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : a.sample - b.sample));
  const pool: Omit<FamilyPool, 'version'> = {
    family: f.family,
    questionVersion: f.questionVersion,
    rubricVersion: f.rubricVersion,
    type: f.type,
    members: input.members.map((m) => m.id),
    cohortSize: f.cohort.size,
    cases: list,
    tail: { nearSize, farSize, near, far },
    runs,
  };
  return {
    ...pool,
    version: sha256(canonicalJson({ rule, ...pool, members: input.members.map((m) => [m.id, m.memberVersion]) })),
  };
}

/** The pool file's version: every family's version, the target and the methods. */
export const poolFileVersion = (p: Omit<PoolFile, 'version'>): string =>
  sha256(canonicalJson({ rule: p.rule, datasetSpecSha256: p.datasetSpecSha256, generationId: p.generationId, target: p.target, methods: p.methods, families: p.families.map((f) => f.version) }));

// ---------------------------------------------------------------------------
// Priorities and pairs

/**
 * The frozen judging schedule (`SCHEDULE`): every pair of a pool gets a priority, lower
 * first, from its tier and its rank within the tier, and pairs are judged and escalated
 * in that order (`judgePairs`). The tiers:
 *
 * 0. delivered in some run's bundle (rank: the best case rank among the bundles);
 * 1. in some method's first 20 unique cases;
 * 2. a bounded-cohort case (the cohort is judged completely for Recall@20);
 * 3. another method case (ranks 21 to 100) or a related coded positive;
 * 4. a lure (hard-negative) or tail case (rank: its lure rank).
 *
 * A stage judges a prefix of the tiers (`--stage`): stage 1 is tiers 0 to 2 (every
 * bounded-cohort case and the broad questions' delivered and first-20 cases, the pairs
 * the strict P@6, nDCG@6 and Recall@20 values rest on), stage 2 is every tier. A stage's
 * run finishes its own escalations; a later stage reuses the earlier stage's judgments
 * from the cache.
 */
export const SCHEDULE = Object.freeze({
  version: 'track-n-schedule-v1',
  tierWidth: 10_000,
  /** The last tier each stage includes. */
  stages: Object.freeze({ 1: 2, 2: 4 } as const),
});
export type Stage = keyof typeof SCHEDULE.stages;

export const tierOf = (priority: number): number => Math.floor(priority / SCHEDULE.tierWidth);

/** A pool case's priority in the frozen schedule (module comment of `SCHEDULE`). */
export function casePriority(c: PoolCase, type: FamilyPool['type']): number {
  const ranks = Object.values(c.bestRank).filter((r): r is number => r !== null);
  const best = ranks.length > 0 ? Math.min(...ranks) : 999;
  const tier = c.delivered ? 0 : best <= 20 ? 1 : type === 'bounded-cohort' ? 2 : c.sources.includes('method') || c.sources.includes('related') ? 3 : 4;
  return tier * SCHEDULE.tierWidth + (tier === 4 ? Math.min(c.lureRank ?? 999, 9_999) : best);
}

/** Every distinct delivered bundle case of a family (answerability pairs), with the runs that delivered it. */
export function bundlePairs(p: FamilyPool): { ntsbNo: string; passages: BundleCase['passages']; runs: { member: string; method: string; sample: number; caseRank: number }[] }[] {
  const out = new Map<string, { ntsbNo: string; passages: BundleCase['passages']; runs: { member: string; method: string; sample: number; caseRank: number }[] }>();
  for (const run of p.runs) {
    for (const b of run.bundle) {
      const key = `${b.ntsbNo}|${bundleKeyOf(b.passages)}`;
      const entry = out.get(key) ?? { ntsbNo: b.ntsbNo, passages: b.passages, runs: [] };
      entry.runs.push({ member: run.member, method: run.method, sample: run.sample, caseRank: b.caseRank });
      out.set(key, entry);
    }
  }
  return [...out.values()].sort((a, b) => (a.ntsbNo < b.ntsbNo ? -1 : a.ntsbNo > b.ntsbNo ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Elasticsearch (read-only)

/** Every case number under `filter` in `index` (composite aggregation, paged). */
export async function caseSet(es: Client, index: string, filter: Query[]): Promise<string[]> {
  const out: string[] = [];
  let after: Record<string, estypes.FieldValue> | undefined;
  for (;;) {
    const res = await es.search(
      {
        index,
        size: 0,
        allow_partial_search_results: false,
        query: { bool: { filter } },
        aggs: { cases: { composite: { size: 5_000, sources: [{ n: { terms: { field: 'ntsb_no' } } }], ...(after ? { after } : {}) } } },
      },
      { requestTimeout: 60_000 },
    );
    assertCompleteResponse(res, 'fetch');
    const agg = res.aggregations?.cases as estypes.AggregationsCompositeAggregate;
    const buckets = agg.buckets as estypes.AggregationsCompositeBucket[];
    for (const b of buckets) out.push(String(b.key.n));
    if (!agg.after_key || buckets.length === 0) break;
    after = agg.after_key as Record<string, estypes.FieldValue>;
  }
  return out.sort();
}

/** The passages index's cohort of a question: the cases its compiled filter reaches. */
export const indexCohort = (es: Client, passagesIndex: string, item: Pick<NarrativeItem, 'filters'>, eventAircraftQualification: boolean): Promise<string[]> =>
  caseSet(es, passagesIndex, compileFilters(item.filters, { eventAircraftQualification }).bool.filter);

/** The lure's case order: BM25 over the cases index's narratives under the question's filters (the N channel). */
export async function lureCases(es: Client, casesIndex: string, item: Pick<NarrativeItem, 'lure' | 'filters'>, depth = POOL_RULE.lureDepth): Promise<string[]> {
  const r = await searchCaseChannel(es, casesIndex, item.lure, { fields: 'narratives', depth, role: 'third' }, item.filters, { timeoutMs: 30_000 });
  return r.cases;
}

export interface PoolContext {
  es: Client;
  dataset: RetrievalDataset;
  passagesIndex: string;
  casesIndex: string;
  eventAircraftQualification: boolean;
}

/** One method run of one member and scope sample, as a pool run (the bundle's passages by identity and text hash). */
export async function poolRun(ctx: PoolContext, embedder: Embedder, member: NarrativeItem, method: { id: string; config: ExperimentConfig }, sample: number, keywordText: string | undefined): Promise<PoolRun> {
  const r = await runVariant(
    ctx.es,
    embedder,
    { dataset: ctx.dataset, casesIndex: ctx.casesIndex, question: member.question, ...(keywordText !== undefined ? { scopeKeywordText: keywordText } : {}), filters: member.filters },
    method.config,
  );
  return {
    member: member.id,
    method: method.id,
    sample,
    ranking: uniqueTop(r.ranking, POOL_RULE.keepRanks),
    bundle: r.packed.cases.map((c) => ({
      ntsbNo: c.ntsbNo,
      caseRank: c.caseRank,
      passages: c.passages.map((p) => ({
        passageId: p.id,
        sectionId: p.sectionId,
        revisionId: p.revisionId,
        kind: p.sectionKind,
        scope: p.scope,
        aircraftKey: p.aircraftKey,
        start: p.start,
        end: p.end,
        textSha256: sha256(p.text),
      })),
    })),
  };
}

/** Every family's pool on the target (Elasticsearch reads only; the embedder answers from vectors already paid for). */
export async function buildPools(
  ctx: PoolContext,
  d: NarrativeDataset,
  embedder: Embedder,
  methods: readonly { id: string; config: ExperimentConfig }[],
  scopeTexts: ReadonlyMap<string, readonly string[]>,
  log: (m: string) => void = () => undefined,
): Promise<FamilyPool[]> {
  const out: FamilyPool[] = [];
  for (const family of d.questions.filter((q) => q.paraphrase_of === undefined)) {
    const members = membersOf(d, family.id);
    const runs: PoolRun[] = [];
    for (const member of members) {
      for (const method of methods) {
        const texts = method.config.keywordText === 'scope' ? scopeTexts.get(member.id) : undefined;
        if (method.config.keywordText === 'scope' && (!texts || texts.length === 0)) throw new Error(`no scope keyword text for ${member.id}`);
        const samples = texts ? texts.map((t, i) => [i + 1, t] as const) : [[1, undefined] as const];
        for (const [sample, text] of samples) runs.push(await poolRun(ctx, embedder, member, method, sample, text));
      }
    }
    const cohort = family.type === 'bounded-cohort' ? (family.cohort.cases ?? []) : await indexCohort(ctx.es, ctx.passagesIndex, family, ctx.eventAircraftQualification);
    const lure = await lureCases(ctx.es, ctx.casesIndex, family);
    const pool = assemblePool({ family, members, runs, cohort, lure });
    out.push(pool);
    log(`pool ${family.id}: ${pool.cases.length} cases (${runs.length} runs)`);
  }
  return out;
}
