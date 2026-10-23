/**
 * Validation of the case-level retrieval version before adoption (task 10e; the gate's
 * condition 6). Coded-reference (Track C) scores on the development split only: no
 * holdout question is run, and nothing here is a release evaluation.
 *
 * **Arms** are frozen retrieval configurations run through the production code
 * (`retrieveCandidatesWith`, then `fetchAndPack`), never through the experiment harness:
 * `p50-kt` is `retrieval.v1`, what the brief pipeline retrieves today (50 passages a
 * channel, the scope stage's keyword text); `N` is `retrieval.v2`; `NF` is the
 * experimental `retrieval.v2-nf`, reported for reference only. Every arm of a question
 * and scope sample sees the identical cached scope output (keyword text and filters)
 * and the identical query vector (embedded once per question, up front).
 *
 * **Filters.** `fixed`: the dataset's evaluation filters (as phase A ran). `inferred`:
 * the scope stage's own filters of that sample, as the brief pipeline derives them
 * (`resolveIntent` on a new question), so the end-to-end pipeline is measured; the coded
 * labels stay those of the question's evaluation filters.
 *
 * **Scores** (`metrics.ts`): narrow Recall@20 on the candidate ranking, broad strict P@6
 * and nDCG@6 on the delivered bundle; a question's value is its mean over the scope
 * samples; N against p50-kt by paired group bootstrap (`stats.ts`).
 *
 * **Delivered evidence** is measured apart from candidate recall: coded cases in each
 * bundle (at most 6), and for every delivered case the channels that returned it, so
 * the cases only the cases channel found (their passages mapped by the query vector) are
 * listed with what was delivered for them.
 */
import type { Client } from '@elastic/elasticsearch';
import type { Embedder } from '../../../server/ai/embeddings.js';
import { questionRequest, resolveIntent } from '../../../server/briefs/intent.js';
import { ScopeOutputSchema } from '../../../server/ai/provider.js';
import { retrieveCandidatesWith, type StageOne } from '../../../server/search/case-retrieval.js';
import { uniqueCases } from '../../../server/search/case-fusion.js';
import type { RetrievalFilters } from '../../../server/search/filters.js';
import { fetchAndPack, type PackedEvidence, type RetrievalDataset } from '../../../server/search/hybrid.js';
import { RETRIEVAL_V1, RETRIEVAL_V2, RETRIEVAL_V2_NF, retrievalIdentity, type RetrievalConfig } from '../../../server/search/retrieval-config.js';
import { codedReference, scoreQuestion, type ProtocolScore } from '../metrics.js';
import { CLASS_OF, metricValue, type ExperimentItem } from '../experiments/experiment.js';
import { GATE_METRICS, mean, pairedGroupBootstrap, type BootstrapResult, type GateMetric } from '../experiments/stats.js';

export const ARMS = { 'p50-kt': RETRIEVAL_V1, N: RETRIEVAL_V2, NF: RETRIEVAL_V2_NF } as const satisfies Record<string, RetrievalConfig>;
export type Arm = keyof typeof ARMS;
/** The comparison the gate asked for, and the arm reported for reference only. */
export const COMPARISON = { base: 'p50-kt', variant: 'N' } as const;
export const FILTER_MODES = ['fixed', 'inferred'] as const;
export type FilterMode = (typeof FILTER_MODES)[number];

/**
 * Questions kept as regression cases: reported by name on every run, never routed
 * differently (the gate's condition 6).
 */
export const REGRESSION_CASES = [
  {
    id: 'per-pilot-decision-cause-weight-shift',
    metric: 'broadNdcg6' as GateMetric,
    why: 'phase A: every cases-channel variant lost it (p50-kt 65.8 to 25.9 nDCG@6 for c200+nf-kt); the explanation is recorded in the task 10e report',
  },
] as const;

/** One cached scope sample of a question, as the pipeline would use it. */
export interface ScopeSampleUse {
  sample: number;
  intent: string;
  /** The keyword text the pipeline searches with (`resolveIntent`). */
  keywordText: string;
  /** The scope stage's own filters, as the pipeline applies them to a new question. */
  inferredFilters: RetrievalFilters;
  plannerFilters: unknown;
}

/** The sample's effective intent exactly as the brief pipeline resolves it for a new question. */
export function pipelineIntent(question: string, sample: { intent: string | null; plannerKeywordText: string | null; plannerFilters: unknown }): { intent: string; keywordText: string; filters: RetrievalFilters } {
  const scope = ScopeOutputSchema.parse({ intent: sample.intent, mechanicalCause: false, filters: sample.plannerFilters ?? {}, keywordText: sample.plannerKeywordText ?? '' });
  const r = resolveIntent(questionRequest(question, undefined), scope);
  return { intent: r.intent, keywordText: r.keywordText, filters: r.filters as RetrievalFilters };
}

export interface DeliveredCase {
  ntsbNo: string;
  caseRank: number;
  coded: boolean;
  /** The case's rank in each channel's unique cases (null: not returned). */
  channels: { keyword: number | null; vector: number | null; cases: number | null };
  /** Its passages came from the mapping (no passage channel returned it). */
  mapped: boolean;
  passages: { id: string; sectionKind: string; role: string; reserved: boolean; fusedRank: number | null; tokens: number; text: string }[];
}

export interface AdoptionRun {
  arm: Arm;
  version: string;
  question: string;
  sample: number;
  filters: FilterMode;
  applied: RetrievalFilters;
  keywordText: string;
  /** The first 100 candidate cases. */
  ranking: string[];
  score: ProtocolScore;
  bundle: DeliveredCase[];
  skipped: PackedEvidence['skipped'];
  /** Case-level arms: the mapping of the leading cases no passage channel returned. */
  mapping: { ntsbNo: string; status: string; reason: string | null; passagesUnderFilter: number; returned: number }[] | null;
  timingsMs: { stage1: number; fetch: number };
  error: string | null;
}

function channelRanks(s: StageOne): (n: string) => DeliveredCase['channels'] {
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

/** One arm for one question, sample and filter mode, through the production stages. */
export async function runArm(
  es: Client,
  embedder: Embedder,
  target: { dataset: RetrievalDataset; casesIndex: string },
  item: ExperimentItem,
  use: ScopeSampleUse,
  arm: Arm,
  mode: FilterMode,
): Promise<AdoptionRun> {
  const config = ARMS[arm];
  const applied = mode === 'fixed' ? item.filters : use.inferredFilters;
  const base = { arm, version: config.version, question: item.id, sample: use.sample, filters: mode, applied, keywordText: use.keywordText };
  const t0 = performance.now();
  try {
    const s = await retrieveCandidatesWith(es, embedder, config, {
      dataset: target.dataset,
      text: item.question,
      keywordText: use.keywordText,
      filters: applied,
      ...(config.channels.cases ? { casesIndex: target.casesIndex } : {}),
    });
    const t1 = performance.now();
    const packed = await fetchAndPack(es, s.index, s.filter, s.cases, s.params);
    const t2 = performance.now();
    const ranking = s.cases.map((c) => c.ntsbNo);
    const relevant = new Set(item.relevant);
    const ranks = channelRanks(s);
    const mappedCases = new Set(s.detail.level === 'case' ? s.detail.result.mapping.filter((m) => m.status === 'mapped').map((m) => m.ntsbNo) : []);
    return {
      ...base,
      ranking: ranking.slice(0, 100),
      score: scoreQuestion(ranking, packed.cases.map((c) => c.ntsbNo), codedReference(item.relevant)),
      bundle: packed.cases.map((c) => ({
        ntsbNo: c.ntsbNo,
        caseRank: c.caseRank,
        coded: relevant.has(c.ntsbNo),
        channels: ranks(c.ntsbNo),
        mapped: mappedCases.has(c.ntsbNo),
        passages: c.passages.map((p) => ({ id: p.id, sectionKind: p.sectionKind, role: p.role, reserved: p.reserved, fusedRank: p.fusedRank, tokens: p.tokens, text: p.text })),
      })),
      skipped: packed.skipped,
      mapping: s.detail.level === 'case' ? s.detail.result.mapping.map((m) => ({ ...m })) : null,
      timingsMs: { stage1: Math.round(t1 - t0), fetch: Math.round(t2 - t1) },
      error: null,
    };
  } catch (err) {
    const empty = scoreQuestion([], [], codedReference(item.relevant));
    return { ...base, ranking: [], score: empty, bundle: [], skipped: [], mapping: null, timingsMs: { stage1: Math.round(performance.now() - t0), fetch: 0 }, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

export const runKey = (arm: Arm, mode: FilterMode, question: string, sample: number): string => `${arm}|${mode}|${question}|${sample}`;

/** Every arm × filter mode × scope sample of every question. */
export async function runAdoption(
  es: Client,
  embedder: Embedder,
  target: { dataset: RetrievalDataset; casesIndex: string },
  items: readonly ExperimentItem[],
  samples: ReadonlyMap<string, readonly ScopeSampleUse[]>,
  opts: { arms?: readonly Arm[]; log?: (m: string) => void } = {},
): Promise<Map<string, AdoptionRun>> {
  const arms = opts.arms ?? (Object.keys(ARMS) as Arm[]);
  const out = new Map<string, AdoptionRun>();
  for (const [i, item] of items.entries()) {
    for (const use of samples.get(item.id) ?? []) {
      for (const mode of FILTER_MODES) {
        // Interleaved: each arm runs right after the others on the same sample and filters.
        for (const arm of arms) out.set(runKey(arm, mode, item.id, use.sample), await runArm(es, embedder, target, item, use, arm, mode));
      }
    }
    opts.log?.(`${i + 1}/${items.length} ${item.id}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scores

/** A question's value under an arm and filter mode: the mean over its scope samples. */
export function questionValue(runs: ReadonlyMap<string, AdoptionRun>, arm: Arm, mode: FilterMode, item: ExperimentItem, metric: GateMetric): number {
  const rs = [...runs.values()].filter((r) => r.arm === arm && r.filters === mode && r.question === item.id);
  if (rs.length === 0) throw new Error(`no run of ${item.id} under ${arm}/${mode}`);
  return mean(rs.map((r) => metricValue(metric, r.score)));
}

export interface ArmScores {
  narrowRecall20: number;
  narrowAtTarget: number;
  broadStrictP6: number;
  broadNdcg6: number;
  /** Mean coded cases delivered per bundle (all questions), and mean bundle size. */
  deliveredCoded: number;
  deliveredCases: number;
  failures: number;
}

export function armScores(runs: ReadonlyMap<string, AdoptionRun>, arm: Arm, mode: FilterMode, items: readonly ExperimentItem[]): ArmScores {
  const narrow = items.filter((q) => q.class === 'narrow');
  const broad = items.filter((q) => q.class === 'broad');
  const avg = (qs: readonly ExperimentItem[], m: GateMetric) => mean(qs.map((q) => questionValue(runs, arm, mode, q, m)));
  const mine = [...runs.values()].filter((r) => r.arm === arm && r.filters === mode);
  return {
    narrowRecall20: avg(narrow, 'narrowRecall20'),
    narrowAtTarget: narrow.length === 0 ? Number.NaN : narrow.filter((q) => questionValue(runs, arm, mode, q, 'narrowRecall20') >= 0.9).length / narrow.length,
    broadStrictP6: avg(broad, 'broadStrictP6'),
    broadNdcg6: avg(broad, 'broadNdcg6'),
    deliveredCoded: mean(mine.map((r) => r.bundle.filter((c) => c.coded).length)),
    deliveredCases: mean(mine.map((r) => r.bundle.length)),
    failures: mine.filter((r) => r.error !== null).length,
  };
}

/** Paired group bootstrap of every gate metric, `variant` against `base` (same filter mode). */
export function pairedArms(
  runs: ReadonlyMap<string, AdoptionRun>,
  base: Arm,
  variant: Arm,
  mode: FilterMode,
  items: readonly ExperimentItem[],
  boot: { resamples: number; seed: number },
): Record<GateMetric, BootstrapResult> {
  const out = {} as Record<GateMetric, BootstrapResult>;
  for (const metric of GATE_METRICS) {
    const qs = items.filter((q) => q.class === CLASS_OF[metric]);
    out[metric] = pairedGroupBootstrap(
      qs.map((q) => ({ id: q.id, group: q.group, base: questionValue(runs, base, mode, q, metric), variant: questionValue(runs, variant, mode, q, metric) })),
      boot.resamples,
      boot.seed,
    );
  }
  return out;
}

export interface QuestionChange {
  id: string;
  class: 'narrow' | 'broad';
  group: string;
  metric: GateMetric;
  base: number;
  variant: number;
  change: number;
  perSample: { sample: number; base: number; variant: number }[];
}

export function questionChanges(runs: ReadonlyMap<string, AdoptionRun>, base: Arm, variant: Arm, mode: FilterMode, items: readonly ExperimentItem[]): QuestionChange[] {
  return items.map((q) => {
    const metric: GateMetric = q.class === 'narrow' ? 'narrowRecall20' : 'broadNdcg6';
    const samples = [...runs.values()].filter((r) => r.arm === base && r.filters === mode && r.question === q.id).map((r) => r.sample).sort((a, b) => a - b);
    const value = (arm: Arm, s: number) => metricValue(metric, (runs.get(runKey(arm, mode, q.id, s)) as AdoptionRun).score);
    const b = questionValue(runs, base, mode, q, metric);
    const v = questionValue(runs, variant, mode, q, metric);
    return { id: q.id, class: q.class, group: q.group, metric, base: b, variant: v, change: v - b, perSample: samples.map((s) => ({ sample: s, base: value(base, s), variant: value(variant, s) })) };
  });
}

// ---------------------------------------------------------------------------
// Delivered evidence

export type Provenance = 'keyword' | 'vector' | 'cases' | 'keyword+vector' | 'keyword+cases' | 'vector+cases' | 'all';

export function provenanceOf(c: DeliveredCase['channels']): Provenance {
  const k = c.keyword !== null;
  const v = c.vector !== null;
  const s = c.cases !== null;
  if (k && v && s) return 'all';
  if (k && v) return 'keyword+vector';
  if (k && s) return 'keyword+cases';
  if (v && s) return 'vector+cases';
  if (k) return 'keyword';
  if (v) return 'vector';
  return 'cases';
}

export interface DeliveredEvidence {
  runs: number;
  /** Delivered cases by the channels that returned them, and how many of them are coded. */
  byProvenance: Record<string, { cases: number; coded: number }>;
  /** Every delivered case only the cases channel returned, with what was delivered for it. */
  casesOnly: { question: string; sample: number; ntsbNo: string; caseRank: number; coded: boolean; mapped: boolean; passages: DeliveredCase['passages'] }[];
  /** Mapping over every run: leading cases mapped, and unmapped by reason. */
  mapping: { mapped: number; unmapped: Record<string, number> };
}

export function deliveredEvidence(runs: ReadonlyMap<string, AdoptionRun>, arm: Arm, mode: FilterMode): DeliveredEvidence {
  const mine = [...runs.values()].filter((r) => r.arm === arm && r.filters === mode && r.error === null);
  const byProvenance: DeliveredEvidence['byProvenance'] = {};
  const casesOnly: DeliveredEvidence['casesOnly'] = [];
  const mapping: DeliveredEvidence['mapping'] = { mapped: 0, unmapped: {} };
  for (const r of mine) {
    for (const c of r.bundle) {
      const p = provenanceOf(c.channels);
      const e = (byProvenance[p] ??= { cases: 0, coded: 0 });
      e.cases += 1;
      if (c.coded) e.coded += 1;
      if (p === 'cases') casesOnly.push({ question: r.question, sample: r.sample, ntsbNo: c.ntsbNo, caseRank: c.caseRank, coded: c.coded, mapped: c.mapped, passages: c.passages });
    }
    for (const m of r.mapping ?? []) {
      if (m.status === 'mapped') mapping.mapped += 1;
      else mapping.unmapped[m.reason ?? 'unknown'] = (mapping.unmapped[m.reason ?? 'unknown'] ?? 0) + 1;
    }
  }
  return { runs: mine.length, byProvenance, casesOnly, mapping };
}

// ---------------------------------------------------------------------------
// A regression case, run by run

export interface RegressionRun {
  sample: number;
  base: { ndcg6: number; p6: number; bundle: { ntsbNo: string; coded: boolean; channels: DeliveredCase['channels'] }[] };
  variant: { ndcg6: number; p6: number; bundle: { ntsbNo: string; coded: boolean; channels: DeliveredCase['channels'] }[] };
  /** In the base bundle, not in the variant's (with whether each is coded). */
  displaced: { ntsbNo: string; coded: boolean }[];
  /** In the variant bundle, not in the base's, with the channels that brought them. */
  entered: { ntsbNo: string; coded: boolean; channels: DeliveredCase['channels'] }[];
}

export function regressionRuns(runs: ReadonlyMap<string, AdoptionRun>, base: Arm, variant: Arm, mode: FilterMode, question: string): RegressionRun[] {
  const samples = [...runs.values()].filter((r) => r.arm === base && r.filters === mode && r.question === question).map((r) => r.sample).sort((a, b) => a - b);
  const view = (r: AdoptionRun) => ({
    ndcg6: metricValue('broadNdcg6', r.score),
    p6: metricValue('broadStrictP6', r.score),
    bundle: r.bundle.map((c) => ({ ntsbNo: c.ntsbNo, coded: c.coded, channels: c.channels })),
  });
  return samples.map((s) => {
    const b = runs.get(runKey(base, mode, question, s)) as AdoptionRun;
    const v = runs.get(runKey(variant, mode, question, s)) as AdoptionRun;
    const inB = new Set(b.bundle.map((c) => c.ntsbNo));
    const inV = new Set(v.bundle.map((c) => c.ntsbNo));
    return {
      sample: s,
      base: view(b),
      variant: view(v),
      displaced: b.bundle.filter((c) => !inV.has(c.ntsbNo)).map((c) => ({ ntsbNo: c.ntsbNo, coded: c.coded })),
      entered: v.bundle.filter((c) => !inB.has(c.ntsbNo)).map((c) => ({ ntsbNo: c.ntsbNo, coded: c.coded, channels: c.channels })),
    };
  });
}

/** What a report records about each arm. */
export const armIdentities = () => Object.fromEntries(Object.entries(ARMS).map(([arm, c]) => [arm, retrievalIdentity(c)]));
