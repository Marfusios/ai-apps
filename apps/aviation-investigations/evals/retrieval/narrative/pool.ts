/**
 * Track N judgment pools (task 10c protocol v4, section 4), built through the reviewed
 * production retrievers (task 10c-2 round 4; the gate's first item).
 *
 * **Inputs** (`inputs.ts`). Every member's cached scope-stage outputs (its keyword texts)
 * and its cached query vector, taken once and reused unchanged by every retrieval
 * version, so the versions see identical inputs; the pool file records the inputs'
 * version.
 *
 * **Rule** (`POOL_RULE`, versioned). Per question family, the pool is the union of:
 * - every compared retrieval version's first `depth` (100) unique cases, for every member
 *   of the family (the original and its paraphrases) and every scope sample. The
 *   versions are the production implementations (server/search/retrieval-config.ts):
 *   `retrieval.v1` (the rollback, phase A's `p50-kt`), `retrieval.v2` (the default) and
 *   the experimental `retrieval.v2-nf`. Each run is `retrieveCandidatesWith` (exact
 *   case-level fusion, Elasticsearch-side score-then-id cuts, individually counted and
 *   validated case-to-passage mapping) and `fetchAndPack`, with the question's fixed
 *   filters, the member's cached keyword text and its cached query vector. A run keeps its
 *   ranking (the first `keepRanks` unique cases), its delivered bundle (each case with its
 *   rank in every channel and whether its passages were mapped) and, for a case-level
 *   version, every leading case the mapping was asked for with its outcome;
 * - every case of a bounded cohort (it is judged completely);
 * - the related codes' coded positives under the filters (protocol: "all Track C coded
 *   positives for the question's cohort");
 * - **hard negatives**: the first `hardNegatives` (10) cases, in the production cases
 *   channel's order (BM25 over the cases index's narratives under the family's filters,
 *   score then case number), of the family's lure that are not already in the pool;
 *   chosen by rule, never by reading a case, and judged like every other case;
 * - the **mapping diagnostic**'s delivered cases (below);
 * - a **tail sample** outside the pool (broad questions): `near` cases drawn from the
 *   versions' unique-case ranks 101 to 300 not in the pool, and `far` cases from the rest
 *   of the cohort, each a seeded sample of fixed size. Its relevant share estimates the
 *   relevant cases the pool missed (a coverage diagnostic, never a metric bound).
 *
 * **Mapping diagnostic** (labelled; `POOL_RULE.mappingDiagnostic`). The production
 * mapping runs only for leading cases no passage channel returned, which development
 * questions rarely produce (task 10e saw none). So each run of a case-level version also
 * takes its first `casesPerRun` cases that only the cases channel returned (in fused
 * order), maps them with the production mapping (`mapCasesToPassages`, the run's own query
 * vector and passages filter, the version's mapping settings) and packs them with the
 * production packer as the leading candidates (`fetchAndPack`). The runs are kept apart
 * from the retrieval runs (`mappingDiagnostic`), never scored as a retrieval version; their
 * delivered bundles are judged for answerability and their cases for relevance, in the
 * schedule's first tier, so the diagnostic reports with stage 1.
 *
 * **Identity.** A family pool's version is sha256 over the rule and the family's complete
 * canonical payload: the judged question and rubric versions, the members and their
 * versions, every run (version, member, sample, ranking, bundle with passage text hashes,
 * mapping outcomes), the mapping diagnostic's runs, the cases with their provenance, the
 * tail and every case's complete-input fingerprint at the time the pool was built. The
 * pool file's version covers every family's version, the target index identities, the
 * inputs' version and each retrieval version's configuration identity (its sha256).
 * `verifyPoolFile` recomputes everything from the content, so no stored hash is trusted
 * on load. The identity is **frozen before judging** (`freezePools`): `pools` records it
 * in `frozen-pools.json`, which is committed, and relevance and answerability judging
 * refuse any other pool file (`frozenPoolsProblems`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Client, estypes } from '@elastic/elasticsearch';
import type { Embedder } from '../../../server/ai/embeddings.js';
import { queryEmbeddingInput } from '../../../server/ai/embeddings.js';
import { caseCandidates, orderChannel, uniqueCases } from '../../../server/search/case-fusion.js';
import { mapCasesToPassages, type CaseMappingEntry } from '../../../server/search/case-mapping.js';
import { retrieveCandidatesWith, type StageOne } from '../../../server/search/case-retrieval.js';
import { casesChannelBody, casesChannelFilter, casesOf } from '../../../server/search/cases-channel.js';
import type { PackRole } from '../../../server/search/evidence.js';
import { compileFilters, type Query } from '../../../server/search/filters.js';
import { assertCompleteResponse, fetchAndPack, type EvidenceCase, type PackedEvidence, type RetrievalDataset } from '../../../server/search/hybrid.js';
import { CASES_CHANNEL_FIELDS, retrievalConfig, retrievalConfigSha256, retrievalIdentity, type RetrievalConfig } from '../../../server/search/retrieval-config.js';
import type { RetrievalVersion } from '../../../shared/contracts/retrieval.js';
import { uniqueTop } from '../metrics.js';
import { seededSample } from './calibration.js';
import { bundleKeyOf } from './judging.js';
import { families, membersOf, type NarrativeDataset, type NarrativeItem } from './dataset.js';
import type { DeliveredPassage } from './evidence.js';
import { canonicalJson, sha256 } from './spec.js';

export const POOL_RULE = Object.freeze({
  /** v2 (round 4): the production retrievers, their configuration identities, the mapping outcomes and the mapping diagnostic; v1 ran the phase A experiment harness. */
  version: 'track-n-pool-v2',
  depth: 100,
  /** The production retrieval versions compared (server/search/retrieval-config.ts). */
  methods: Object.freeze(['retrieval.v1', 'retrieval.v2', 'retrieval.v2-nf'] as const satisfies readonly RetrievalVersion[]),
  scopeSamples: 3,
  hardNegatives: 10,
  /** How deep the lure list is read for new cases. */
  lureDepth: 200,
  tail: Object.freeze({ nearFrom: 101, nearTo: 300, near: 10, far: 10 }),
  /** Unique cases of each run kept in the pool file (the near tail reads up to here). */
  keepRanks: 300,
  /** The mapping diagnostic (module comment): the case-level versions whose runs feed it, and the cases-channel-only cases each run maps. */
  mappingDiagnostic: Object.freeze({ versions: Object.freeze(['retrieval.v2', 'retrieval.v2-nf'] as const satisfies readonly RetrievalVersion[]), casesPerRun: 2 }),
});
export type PoolRule = typeof POOL_RULE;

/** A delivered passage by identity and text hash, with the role packing gave it. */
export interface BundlePassage extends Omit<DeliveredPassage, 'text'> {
  textSha256: string;
  /** `probable_cause` for every cause passage (retrieved or attached), `retrieved` or `fill` otherwise. */
  role: PackRole;
  reserved: boolean;
  /** 1-based rank in the passage ranking the bundle was packed from; null for an attached cause. */
  fusedRank: number | null;
}

/** A case's rank in each channel's unique cases (null: the channel did not return it; `cases` is null for `retrieval.v1`). */
export interface ChannelRanks {
  keyword: number | null;
  vector: number | null;
  cases: number | null;
}

export interface BundleCase {
  ntsbNo: string;
  caseRank: number;
  /** Its passages came from the mapping (no passage channel returned the case). */
  mapped: boolean;
  channels: ChannelRanks;
  /** The delivered passages in delivered (reading) order; their text is the stored section text at the offsets. */
  passages: BundlePassage[];
}

/** One case the mapping was asked for, and its outcome (server/search/case-mapping.ts). */
export type MappingEntry = Pick<CaseMappingEntry, 'ntsbNo' | 'status' | 'reason' | 'passagesUnderFilter' | 'returned'>;

export interface PoolRun {
  member: string;
  /** The retrieval version. */
  method: string;
  sample: number;
  /** The first `keepRanks` unique cases of the candidate ranking. */
  ranking: string[];
  /** The packed bundle (at most six cases), in rank order. */
  bundle: BundleCase[];
  /** Case-level versions: every leading case without a passage the mapping was asked for, with its outcome; null for `retrieval.v1`. */
  mapping: MappingEntry[] | null;
}

/** One run's mapping diagnostic (module comment). */
export interface MappingDiagnosticRun {
  member: string;
  method: string;
  sample: number;
  /** The run's first cases that only the cases channel returned, in fused order. */
  cases: { ntsbNo: string; fusedRank: number; casesRank: number }[];
  /** The production mapping's outcome for each. */
  mapping: MappingEntry[];
  /** The mapped cases packed as the leading candidates. */
  bundle: BundleCase[];
  /** Cases the packer passed over (an unmapped case has no passage to pack). */
  skipped: PackedEvidence['skipped'];
}

export type PoolSource = 'method' | 'cohort' | 'related' | 'hard-negative' | 'mapping-diagnostic' | 'tail-near' | 'tail-far';

export interface PoolCase {
  ntsbNo: string;
  sources: PoolSource[];
  /** Best 1-based unique-case rank per version over the members and samples (only within `depth`); null when outside. */
  bestRank: Record<string, number | null>;
  /** Rank in the lure list when the case came from it. */
  lureRank: number | null;
  /** In some retrieval run's delivered bundle. */
  delivered: boolean;
}

export interface FamilyPool {
  family: string;
  questionVersion: string;
  rubricVersion: string;
  type: NarrativeItem['type'];
  members: string[];
  /** Each member's question version (the paraphrases' texts are part of the pool's identity). */
  memberVersions: Record<string, string>;
  /** Each pool case's complete-input fingerprint when the pool was built; a case whose record changes needs a new pool. */
  fingerprints: Record<string, string>;
  cohortSize: number;
  cases: PoolCase[];
  tail: { nearSize: number; farSize: number; near: string[]; far: string[] };
  runs: PoolRun[];
  /** The mapping diagnostic's runs (never scored as a retrieval version). */
  mappingDiagnostic: MappingDiagnosticRun[];
  version: string;
}

/** A compared retrieval version with its configuration identity. */
export interface PoolMethod {
  id: string;
  retrieval: { version: RetrievalVersion; status: RetrievalConfig['status']; sha256: string };
  config: RetrievalConfig;
}

/** The compared retrieval versions as the current code defines them. */
export const poolMethods = (rule: PoolRule = POOL_RULE): PoolMethod[] =>
  rule.methods.map((v) => {
    const config = retrievalConfig(v);
    return { id: v, retrieval: retrievalIdentity(config), config };
  });

export interface PoolFile {
  kind: 'track-n-pools';
  rule: PoolRule;
  datasetSpecSha256: string;
  generationId: number;
  target: Record<string, unknown>;
  /** The cached inputs every version ran with (`inputs.ts`): their version, scope model and embedding. */
  inputs: { version: string; scope: { model: string; promptVersion: string | null }; embedding: { model: string; dims: number; inputTemplate: string } };
  methods: PoolMethod[];
  families: FamilyPool[];
  version: string;
  /** The code that built it (provenance only, outside the version). */
  git?: { commit: string | null; dirty: boolean | null };
}

const byRun = <T extends { member: string; method: string; sample: number }>(a: T, b: T) =>
  a.member < b.member ? -1 : a.member > b.member ? 1 : a.method < b.method ? -1 : a.method > b.method ? 1 : a.sample - b.sample;

/** Pure: one family's pool from its runs, mapping diagnostic, cohort and lure list (module comment). */
export function assemblePool(input: {
  family: NarrativeItem;
  members: readonly NarrativeItem[];
  runs: readonly PoolRun[];
  /** The mapping diagnostic's runs. */
  mapping?: readonly MappingDiagnosticRun[];
  /** Every case the filters reach (sorted); for a bounded cohort, its recorded cases. */
  cohort: readonly string[];
  /** The lure's case order. */
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
  for (const m of input.mapping ?? []) for (const b of m.bundle) add(b.ntsbNo, 'mapping-diagnostic');
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
  const pool: Omit<FamilyPool, 'version'> = {
    family: f.family,
    questionVersion: f.questionVersion,
    rubricVersion: f.rubricVersion,
    type: f.type,
    members: input.members.map((m) => m.id),
    memberVersions: Object.fromEntries(input.members.map((m) => [m.id, m.memberVersion])),
    fingerprints: {},
    cohortSize: f.cohort.size,
    cases: list,
    tail: { nearSize, farSize, near, far },
    runs: [...input.runs].sort(byRun),
    mappingDiagnostic: [...(input.mapping ?? [])].sort(byRun),
  };
  return { ...pool, version: familyVersion(rule, pool) };
}

/** A family pool's version: the rule and its complete canonical payload (everything but the version itself). */
export const familyVersion = (rule: PoolRule, pool: Omit<FamilyPool, 'version'> & { version?: string }): string => {
  const { version: _version, ...payload } = pool;
  return sha256(canonicalJson({ rule, ...payload }));
};

/** The pool with each case's complete-input fingerprint recorded (sorted keys), its version recomputed. */
export function withFingerprints(rule: PoolRule, pool: FamilyPool, fingerprints: ReadonlyMap<string, string>): FamilyPool {
  const recorded: Record<string, string> = {};
  for (const c of [...pool.cases].sort((a, b) => (a.ntsbNo < b.ntsbNo ? -1 : 1))) {
    const fp = fingerprints.get(c.ntsbNo);
    if (fp !== undefined) recorded[c.ntsbNo] = fp;
  }
  const next = { ...pool, fingerprints: recorded };
  return { ...next, version: familyVersion(rule, next) };
}

/** The pool file's version: every family's version, the target, the inputs and the retrieval versions' identities. */
export const poolFileVersion = (p: Omit<PoolFile, 'version' | 'git'>): string =>
  sha256(
    canonicalJson({
      rule: p.rule,
      datasetSpecSha256: p.datasetSpecSha256,
      generationId: p.generationId,
      target: p.target,
      inputs: p.inputs,
      methods: p.methods,
      families: p.families.map((f) => f.version),
    }),
  );

/**
 * Problems of a pool file: each retrieval version's recorded identity against its recorded
 * configuration, every family's version recomputed from its payload, then the file's
 * version from those.
 */
export function verifyPoolFile(p: PoolFile): string[] {
  const problems: string[] = [];
  for (const m of p.methods) {
    if (m.id !== m.retrieval.version || m.config.version !== m.retrieval.version || retrievalConfigSha256(m.config) !== m.retrieval.sha256) problems.push(`method ${m.id}: its configuration identity does not match its configuration`);
  }
  for (const f of p.families) {
    if (familyVersion(p.rule, f) !== f.version) problems.push(`family ${f.family}: its version does not match its content`);
  }
  const { version, git: _git, ...body } = p;
  if (poolFileVersion(body) !== version) problems.push('the pool file version does not match its families');
  return problems;
}

// ---------------------------------------------------------------------------
// Priorities and pairs

/**
 * The frozen judging schedule (`SCHEDULE`): every pair of a pool gets a priority, lower
 * first, from its tier and its rank within the tier, and pairs are judged and escalated
 * in that order (`judgePairs`). The tiers:
 *
 * 0. delivered in some run's bundle, or in a mapping diagnostic bundle (rank: the best
 *    case rank among the versions' first 100, 999 when none);
 * 1. in some version's first 20 unique cases;
 * 2. a bounded-cohort case (the cohort is judged completely for Recall@20);
 * 3. another version's case (ranks 21 to 100) or a related coded positive;
 * 4. a lure (hard-negative) or tail case (rank: its lure rank).
 *
 * A stage judges a prefix of the tiers (`--stage`): stage 1 is tiers 0 to 2 (every
 * bounded-cohort case, the broad questions' delivered and first-20 cases and the mapping
 * diagnostic's cases: the pairs the strict P@6, nDCG@6 and Recall@20 values and the
 * diagnostics rest on), stage 2 is every tier. A stage's run finishes its own escalations;
 * a later stage reuses the earlier stage's judgments from the cache. v2 (round 4): tier 0
 * also holds the mapping diagnostic's delivered cases.
 */
export const SCHEDULE = Object.freeze({
  version: 'track-n-schedule-v2',
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
  const tier =
    c.delivered || c.sources.includes('mapping-diagnostic') ? 0 : best <= 20 ? 1 : type === 'bounded-cohort' ? 2 : c.sources.includes('method') || c.sources.includes('related') ? 3 : 4;
  return tier * SCHEDULE.tierWidth + (tier === 4 ? Math.min(c.lureRank ?? 999, 9_999) : best);
}

export interface BundlePair {
  ntsbNo: string;
  passages: BundlePassage[];
  /** The runs that delivered it: retrieval runs, and the mapping diagnostic's (`source`). */
  runs: { member: string; method: string; sample: number; caseRank: number; source: 'run' | 'mapping-diagnostic' }[];
}

/** Every distinct delivered bundle case of a family (answerability pairs), retrieval runs and mapping diagnostic alike, with the runs that delivered it. */
export function bundlePairs(p: Pick<FamilyPool, 'runs' | 'mappingDiagnostic'>): BundlePair[] {
  const out = new Map<string, BundlePair>();
  const take = (run: { member: string; method: string; sample: number; bundle: readonly BundleCase[] }, source: BundlePair['runs'][number]['source']) => {
    for (const b of run.bundle) {
      const key = `${b.ntsbNo}|${bundleKeyOf(b.passages)}`;
      const entry = out.get(key) ?? { ntsbNo: b.ntsbNo, passages: b.passages, runs: [] };
      entry.runs.push({ member: run.member, method: run.method, sample: run.sample, caseRank: b.caseRank, source });
      out.set(key, entry);
    }
  };
  for (const run of p.runs) take(run, 'run');
  for (const run of p.mappingDiagnostic ?? []) take(run, 'mapping-diagnostic');
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

/**
 * The lure's case order: the production cases channel (`retrieval.v2`'s narratives
 * fields, its filter and its score-then-case-number cut) searching the lure text.
 */
export async function lureCases(es: Client, casesIndex: string, item: Pick<NarrativeItem, 'lure' | 'filters'>, eventAircraftQualification: boolean, depth = POOL_RULE.lureDepth): Promise<string[]> {
  const body = casesChannelBody(casesIndex, item.lure.replace(/\s+/gu, ' ').trim(), CASES_CHANNEL_FIELDS.narratives, casesChannelFilter(item.filters, { eventAircraftQualification }), depth);
  const res = await es.search<Record<string, unknown>>(body, { requestTimeout: 30_000 });
  return orderChannel(casesOf(res), (h) => h.ntsbNo, (h) => h.score).map((h) => h.ntsbNo);
}

export interface PoolContext {
  es: Client;
  dataset: RetrievalDataset;
  passagesIndex: string;
  casesIndex: string;
  eventAircraftQualification: boolean;
}

/** Each case's rank in each channel's unique cases (adoption's provenance). */
function channelRanks(s: StageOne): (n: string) => ChannelRanks {
  if (s.detail.level === 'case') {
    const ranks = new Map(s.detail.result.fusedCases.map((c) => [c.id, c.ranks]));
    return (n) => {
      const r = ranks.get(n) ?? [null, null, null];
      return { keyword: r[0] ?? null, vector: r[1] ?? null, cases: r[2] ?? null };
    };
  }
  const kw = new Map(uniqueCases(s.detail.result.keyword).map((x, i) => [x, i + 1]));
  const vec = new Map(uniqueCases(s.detail.result.vector).map((x, i) => [x, i + 1]));
  return (n) => ({ keyword: kw.get(n) ?? null, vector: vec.get(n) ?? null, cases: null });
}

const mappingEntry = (m: CaseMappingEntry): MappingEntry => ({ ntsbNo: m.ntsbNo, status: m.status, reason: m.reason, passagesUnderFilter: m.passagesUnderFilter, returned: m.returned });

const bundleCase = (c: EvidenceCase, mapped: boolean, channels: ChannelRanks): BundleCase => ({
  ntsbNo: c.ntsbNo,
  caseRank: c.caseRank,
  mapped,
  channels,
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
    role: p.role,
    reserved: p.reserved,
    fusedRank: p.fusedRank,
  })),
});

export interface PoolRunResult {
  run: PoolRun;
  /** The run's mapping diagnostic, when asked for and the version is case-level. */
  diagnostic: MappingDiagnosticRun | null;
}

/**
 * One retrieval version's run for one member and scope sample, through the production
 * stages (module comment); with `mappingDiagnostic` > 0 and a case-level version, also the
 * run's mapping diagnostic. The embedder answers from the cached vectors (nothing paid).
 */
export async function poolRun(
  ctx: PoolContext,
  embedder: Embedder,
  member: Pick<NarrativeItem, 'id' | 'question' | 'filters'>,
  config: RetrievalConfig,
  sample: number,
  keywordText: string,
  opts: { mappingDiagnostic?: number } = {},
): Promise<PoolRunResult> {
  const s = await retrieveCandidatesWith(ctx.es, embedder, config, {
    dataset: ctx.dataset,
    text: member.question,
    keywordText,
    filters: member.filters,
    ...(config.channels.cases ? { casesIndex: ctx.casesIndex } : {}),
  });
  const packed = await fetchAndPack(ctx.es, s.index, s.filter, s.cases, s.params);
  const ranks = channelRanks(s);
  const mapping = s.detail.level === 'case' ? s.detail.result.mapping.map(mappingEntry) : null;
  const mapped = new Set((mapping ?? []).filter((m) => m.status === 'mapped').map((m) => m.ntsbNo));
  const run: PoolRun = {
    member: member.id,
    method: config.version,
    sample,
    ranking: uniqueTop(
      s.cases.map((c) => c.ntsbNo),
      POOL_RULE.keepRanks,
    ),
    bundle: packed.cases.map((c) => bundleCase(c, mapped.has(c.ntsbNo), ranks(c.ntsbNo))),
    mapping,
  };
  const n = opts.mappingDiagnostic ?? 0;
  if (n <= 0 || s.detail.level !== 'case' || !config.mapping) return { run, diagnostic: null };
  const r = s.detail.result;
  const forced = r.fusedCases.filter((c) => c.ranks[0] === null && c.ranks[1] === null).slice(0, n);
  const vector = (await embedder.embed([queryEmbeddingInput(member.question)])).vectors[0];
  if (!vector || vector.length !== embedder.dims) throw new Error(`no cached query vector for ${member.id}`);
  const m = await mapCasesToPassages(
    ctx.es,
    s.index,
    s.filter,
    Array.from(vector),
    forced.map((c) => c.id),
    s.params,
    { passagesPerCase: config.mapping.passagesPerCase, maxMappablePassages: config.mapping.maxPassagesPerCase, maxCases: s.params.packCandidates },
  );
  // Mapped passages rank after every fused passage, as the production ranking places them.
  const candidates = caseCandidates(forced, new Map(), m.passages, r.fusedPassages.length, 2);
  const forcedPack = await fetchAndPack(ctx.es, s.index, s.filter, candidates, s.params);
  return {
    run,
    diagnostic: {
      member: member.id,
      method: config.version,
      sample,
      cases: forced.map((c) => ({ ntsbNo: c.id, fusedRank: c.rank, casesRank: c.ranks[2] as number })),
      mapping: m.cases.map(mappingEntry),
      bundle: forcedPack.cases.map((c) => bundleCase(c, m.passages.has(c.ntsbNo), ranks(c.ntsbNo))),
      skipped: forcedPack.skipped,
    },
  };
}

/** A member's cached keyword texts, one per scope sample (`inputs.ts`). */
export type KeywordTexts = ReadonlyMap<string, readonly { sample: number; keywordText: string }[]>;

/** Every family's pool on the target (Elasticsearch reads only; the embedder answers from the cached vectors). */
export async function buildPools(ctx: PoolContext, d: NarrativeDataset, embedder: Embedder, keywordTexts: KeywordTexts, log: (m: string) => void = () => undefined): Promise<FamilyPool[]> {
  const out: FamilyPool[] = [];
  const diagnostic = POOL_RULE.mappingDiagnostic.versions as readonly string[];
  for (const family of families(d)) {
    const members = membersOf(d, family.id);
    const runs: PoolRun[] = [];
    const mapping: MappingDiagnosticRun[] = [];
    for (const member of members) {
      const samples = keywordTexts.get(member.id);
      if (!samples || samples.length === 0) throw new Error(`no cached scope sample for ${member.id}`);
      for (const s of samples) {
        // Interleaved: every version runs on the same sample before the next one.
        for (const version of POOL_RULE.methods) {
          const r = await poolRun(ctx, embedder, member, retrievalConfig(version), s.sample, s.keywordText, {
            mappingDiagnostic: diagnostic.includes(version) ? POOL_RULE.mappingDiagnostic.casesPerRun : 0,
          });
          runs.push(r.run);
          if (r.diagnostic) mapping.push(r.diagnostic);
        }
      }
    }
    const cohort = family.type === 'bounded-cohort' ? (family.cohort.cases ?? []) : await indexCohort(ctx.es, ctx.passagesIndex, family, ctx.eventAircraftQualification);
    const lure = await lureCases(ctx.es, ctx.casesIndex, family, ctx.eventAircraftQualification);
    const pool = assemblePool({ family, members, runs, mapping, cohort, lure });
    out.push(pool);
    const mappedRuns = runs.filter((r) => (r.mapping ?? []).length > 0).length;
    log(`pool ${family.id}${family.role === 'diagnostic' ? ' (diagnostic)' : ''}: ${pool.cases.length} cases (${runs.length} runs, ${mappedRuns} with a mapping; mapping diagnostic ${mapping.reduce((n, x) => n + x.bundle.length, 0)} delivered)`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary

export interface VersionSummary {
  /** Pool cases in the version's first `depth` unique cases (any member and sample). */
  cases: number;
  /** Distinct cases its bundles delivered. */
  delivered: number;
  runs: number;
  /** Runs whose leading cases included one no passage channel returned (the mapping was asked for). */
  runsWithMapping: number;
  /** Distinct cases the mapping mapped, and could not map. */
  mapped: number;
  unmapped: number;
}

export interface FamilySummary {
  family: string;
  role: 'benchmark' | 'diagnostic';
  cases: number;
  /** Relevance pairs in stage 1 of the schedule (tiers 0 to 2). */
  stage1: number;
  bundlePairs: number;
  versions: Record<string, VersionSummary>;
  /** Distinct cases the mapping diagnostic forced through the mapping, mapped, and delivered (case and passages). */
  mappingDiagnostic: { forced: number; mapped: number; delivered: number };
}

/** Per family and retrieval version: pool cases, deliveries and the mapping, natural and forced. */
export function poolSummary(p: Pick<PoolFile, 'rule' | 'families'>, roles: ReadonlyMap<string, 'benchmark' | 'diagnostic'> = new Map()): {
  families: FamilySummary[];
  total: { cases: number; benchmarkCases: number; stage1: number; bundlePairs: number; versions: Record<string, VersionSummary>; mappingDiagnostic: FamilySummary['mappingDiagnostic'] };
} {
  const versionOf = (f: FamilyPool, m: string): VersionSummary => {
    const runs = f.runs.filter((r) => r.method === m);
    const entries = runs.flatMap((r) => r.mapping ?? []);
    return {
      cases: f.cases.filter((c) => c.bestRank[m] !== null && c.bestRank[m] !== undefined).length,
      delivered: new Set(runs.flatMap((r) => r.bundle.map((b) => b.ntsbNo))).size,
      runs: runs.length,
      runsWithMapping: runs.filter((r) => (r.mapping ?? []).length > 0).length,
      mapped: new Set(entries.filter((e) => e.status === 'mapped').map((e) => e.ntsbNo)).size,
      unmapped: new Set(entries.filter((e) => e.status !== 'mapped').map((e) => e.ntsbNo)).size,
    };
  };
  const families = p.families.map((f): FamilySummary => {
    const entries = f.mappingDiagnostic.flatMap((r) => r.mapping);
    return {
      family: f.family,
      role: roles.get(f.family) ?? 'benchmark',
      cases: f.cases.length,
      stage1: f.cases.filter((c) => tierOf(casePriority(c, f.type)) <= SCHEDULE.stages[1]).length,
      bundlePairs: bundlePairs(f).length,
      versions: Object.fromEntries(p.rule.methods.map((m) => [m, versionOf(f, m)])),
      mappingDiagnostic: {
        forced: new Set(f.mappingDiagnostic.flatMap((r) => r.cases.map((c) => c.ntsbNo))).size,
        mapped: new Set(entries.filter((e) => e.status === 'mapped').map((e) => e.ntsbNo)).size,
        delivered: bundlePairs({ runs: [], mappingDiagnostic: f.mappingDiagnostic }).length,
      },
    };
  });
  const add = (xs: readonly number[]) => xs.reduce((n, x) => n + x, 0);
  return {
    families,
    total: {
      cases: add(families.map((f) => f.cases)),
      benchmarkCases: add(families.filter((f) => f.role === 'benchmark').map((f) => f.cases)),
      stage1: add(families.map((f) => f.stage1)),
      bundlePairs: add(families.map((f) => f.bundlePairs)),
      versions: Object.fromEntries(
        p.rule.methods.map((m) => [
          m,
          {
            cases: add(families.map((f) => f.versions[m]?.cases ?? 0)),
            delivered: add(families.map((f) => f.versions[m]?.delivered ?? 0)),
            runs: add(families.map((f) => f.versions[m]?.runs ?? 0)),
            runsWithMapping: add(families.map((f) => f.versions[m]?.runsWithMapping ?? 0)),
            mapped: add(families.map((f) => f.versions[m]?.mapped ?? 0)),
            unmapped: add(families.map((f) => f.versions[m]?.unmapped ?? 0)),
          },
        ]),
      ),
      mappingDiagnostic: {
        forced: add(families.map((f) => f.mappingDiagnostic.forced)),
        mapped: add(families.map((f) => f.mappingDiagnostic.mapped)),
        delivered: add(families.map((f) => f.mappingDiagnostic.delivered)),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The frozen pool identity

/** What `frozen-pools.json` records: the pool identity judging is bound to. */
export interface FrozenPools {
  kind: 'track-n-frozen-pools';
  frozenAt: string;
  poolVersion: string;
  rule: string;
  schedule: string;
  datasetSpecSha256: string;
  generationId: number;
  inputsVersion: string;
  /** Each retrieval version's configuration sha256. */
  retrieval: Record<string, string>;
  /** Each family's pool version. */
  families: Record<string, string>;
  counts: { cases: number; bundlePairs: number; runs: number; mappingDiagnosticBundles: number };
}

export function frozenRecord(p: PoolFile, at: Date): FrozenPools {
  return {
    kind: 'track-n-frozen-pools',
    frozenAt: at.toISOString(),
    poolVersion: p.version,
    rule: p.rule.version,
    schedule: SCHEDULE.version,
    datasetSpecSha256: p.datasetSpecSha256,
    generationId: p.generationId,
    inputsVersion: p.inputs.version,
    retrieval: Object.fromEntries(p.methods.map((m) => [m.id, m.retrieval.sha256])),
    families: Object.fromEntries(p.families.map((f) => [f.family, f.version])),
    counts: {
      cases: p.families.reduce((n, f) => n + f.cases.length, 0),
      bundlePairs: p.families.reduce((n, f) => n + bundlePairs(f).length, 0),
      runs: p.families.reduce((n, f) => n + f.runs.length, 0),
      mappingDiagnosticBundles: p.families.reduce((n, f) => n + f.mappingDiagnostic.reduce((k, r) => k + r.bundle.length, 0), 0),
    },
  };
}

const readFrozen = (file: string): FrozenPools => JSON.parse(readFileSync(file, 'utf8')) as FrozenPools;

/**
 * Freeze a pool file's identity before judging: record it in `file` when nothing is
 * frozen yet ('recorded': commit the file), accept the same identity again ('unchanged');
 * refuse another identity, which is a deliberate change (remove the file in a reviewed
 * commit first).
 */
export function freezePools(file: string, p: PoolFile, at = new Date()): 'recorded' | 'unchanged' {
  if (existsSync(file)) {
    const frozen = readFrozen(file);
    if (frozen.poolVersion === p.version) return 'unchanged';
    throw new Error(
      `the pool identity ${p.version.slice(0, 12)} differs from the frozen one ${frozen.poolVersion.slice(0, 12)} (frozen ${frozen.frozenAt}); it is not frozen and judging refuses it. A new pool identity is a deliberate change: remove ${file} in a reviewed commit first`,
    );
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(frozenRecord(p, at), null, 2)}\n`);
  return 'recorded';
}

/** Why relevance or answerability judging must refuse a pool file (empty: it is the frozen, committed identity). */
export function frozenPoolsProblems(file: string, p: Pick<PoolFile, 'version'>, committed: (file: string) => boolean): string[] {
  if (!existsSync(file)) return [`no pool identity is frozen (${file}): build the pools with \`pools\`, which records it, and commit it before judging`];
  const frozen = readFrozen(file);
  const problems: string[] = [];
  if (frozen.kind !== 'track-n-frozen-pools') problems.push(`${file} is not a frozen pool identity`);
  if (frozen.poolVersion !== p.version) problems.push(`the pool file (${p.version.slice(0, 12)}) is not the frozen pool identity (${String(frozen.poolVersion).slice(0, 12)})`);
  if (!committed(file)) problems.push(`${file} is not committed (tracked and unchanged): commit the frozen identity before judging`);
  return problems;
}
