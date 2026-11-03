/** Task 29's pure parts: the rows, the "Apply these filters" request, worst-case sizing, fallbacks and the scores. */
import { BriefFiltersSchema, type BriefFilters } from '../../shared/contracts/briefs.js';
import type { EvidenceScopeSuggestion } from '../../shared/contracts/evidence.js';
import { questionQuery, remainingSuggestion } from '../../server/evidence/disclosure.js';
import type { LexicalSource } from '../../server/evidence/pipeline.js';
import { embeddingWorstCaseUsd, stageWorstCaseUsd } from '../../server/ai/pricing.js';
import type { EvidenceRankingConfig } from '../../server/evidence/ranking-config.js';
import { codedMetrics } from '../search-quality/ab-score.js';
import type { RankingQuestion, SearchObservation } from '../search-quality/ab-types.js';
import { mean, pairedGroupBootstrap, type BootstrapResult } from '../retrieval/experiments/stats.js';
import { hasFilters, withSuggestedFilters } from './filters.js';

/**
 * - `Q0`: Elasticsearch alone, the question as typed (no AI stage; scope skipped, it cannot change this ranking).
 * - `QH50`: the live search: the same, then the AI orders the top 50; its filters are only suggested.
 * - `QH50+F`: that search after one click on "Apply these filters": an edit with the suggestion's filters.
 * - `Q0+F`: the same filters without the AI ordering (diagnostic).
 */
export const ROWS = ['Q0', 'QH50', 'QH50+F', 'Q0+F'] as const;
export type Row = typeof ROWS[number];
export type Sample = 1 | 2 | 3;

/**
 * The filters "Apply these filters" sends after a search, or null when the page shows no such
 * button: the suggestion the page keeps (`remainingSuggestion`), added to the search's own filters
 * (none here), validated as the edit request is.
 */
export function applyFiltersRequest(lexicalSource: LexicalSource, addedTerms: string | null,
  suggestion: EvidenceScopeSuggestion | null): BriefFilters | null {
  const visible = remainingSuggestion(questionQuery(lexicalSource, addedTerms), suggestion);
  if (!visible || !hasFilters(visible.filters)) return null;
  return BriefFiltersSchema.parse(withSuggestedFilters({}, visible.filters));
}

/** Worst-case microdollars of each stage, as `rankEvidence` reserves them. */
export interface StageMicros { embed: number; scope: number; rerank: number }
export function stageMicros(q0: EvidenceRankingConfig, qh50: EvidenceRankingConfig): StageMicros {
  if (q0.rerank || !qh50.rerank || q0.embedding.model !== qh50.embedding.model) throw new Error('Unexpected Task 29 configurations');
  const micros = (usd: number) => Math.ceil(usd * 1e6);
  return { embed: micros(embeddingWorstCaseUsd(qh50.embedding.model)),
    scope: micros(stageWorstCaseUsd(qh50.scope.model, qh50.scope.caps, qh50.scope.cachePrefixTokens)),
    rerank: micros(stageWorstCaseUsd(qh50.rerank.model, qh50.rerank.caps, qh50.rerank.cachePrefixTokens)) };
}
/** Worst-case microdollars of one question: Q0 once, then per sample QH50 and its two edits. */
export const questionWorstCaseMicros = (s: StageMicros, samples: number): number =>
  s.embed + samples * ((s.scope + s.embed + s.rerank) + (s.embed + s.rerank) + s.embed);

/** Task 24's infrastructure outcomes: three in a row stop a run. */
export const INFRASTRUCTURE = new Set(['count_failed', 'rate_limited', 'overloaded', 'timeout', 'provider_error', 'unbilled_provider_error']);
export const isInfrastructure = (o: Pick<SearchObservation, 'scopeOutcome' | 'rerankOutcome'>) => INFRASTRUCTURE.has(o.scopeOutcome) || INFRASTRUCTURE.has(o.rerankOutcome);
/**
 * The run's consecutive infrastructure count. Only searches that call the AI (the QH50 configuration:
 * a scope or a rerank) count or reset it; Elasticsearch-only searches leave it as it is.
 */
export const nextStreak = (streak: number, configArm: 'Q0' | 'QH50', o: Pick<SearchObservation, 'scopeOutcome' | 'rerankOutcome'>): number =>
  configArm !== 'QH50' ? streak : isInfrastructure(o) ? streak + 1 : 0;
/** Task 24's fallback rates: failed scope among scope attempts (any outcome but `skipped`), unapplied reranks among rerank attempts. */
export function fallbackRates(rows: readonly SearchObservation[]) {
  const scope = rows.filter(r => r.scopeOutcome !== 'skipped'), rerank = rows.filter(r => r.timing.rerank.attempted);
  const failedScope = scope.filter(r => !['used', 'non_search', 'skipped'].includes(r.scopeOutcome)).length;
  const fallbacks = rerank.filter(r => r.rerankOutcome !== 'applied').length;
  return { scopeAttempts: scope.length, scopeFailures: failedScope, scopeRate: scope.length ? failedScope / scope.length : 0,
    rerankAttempts: rerank.length, rerankFallbacks: fallbacks, rerankRate: rerank.length ? fallbacks / rerank.length : 0 };
}

/** How a sample's applied filters relate to the question's answer-key filters (reported only, never dispatched). */
export type FilterMatch = 'exact' | 'includes' | 'other' | 'none';
export function filterMatch(applied: BriefFilters | null, key: BriefFilters): FilterMatch {
  if (!applied) return 'none';
  const norm = (f: BriefFilters) => Object.fromEntries(Object.entries(f).filter(([, v]) => Array.isArray(v) ? v.length > 0 : v !== undefined)
    .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort().join(',') : String(v)]));
  const a = norm(applied), k = norm(key);
  if (!Object.entries(k).every(([name, v]) => a[name] === v)) return 'other';
  return Object.keys(a).length === Object.keys(k).length ? 'exact' : 'includes';
}

export interface RowRanking { row: Row; questionId: string; sample: number; ranking: readonly string[] }
export interface QuestionScore { id: string; group: string; class: 'narrow' | 'broad'; samples: number;
  narrowR20: number; narrowR10: number; broadP10: number; broadNdcg10: number }

/** Task 24's coded metrics: a question's value is the mean over its samples; a row's, the mean over its stratum. */
export function rowScores(questions: readonly RankingQuestion[], rankings: readonly RowRanking[], row: Row) {
  const per: QuestionScore[] = questions.map(q => {
    const found = rankings.filter(r => r.row === row && r.questionId === q.id);
    if (!found.length || new Set(found.map(r => r.sample)).size !== found.length) throw new Error(`Missing or repeated ${row} sample for ${q.id}`);
    const m = found.map(r => codedMetrics(r.ranking, q.relevant));
    return { id: q.id, group: q.group, class: q.class, samples: found.length,
      narrowR20: mean(m.map(x => x.narrowR20)), narrowR10: mean(m.map(x => x.narrowR10)),
      broadP10: mean(m.map(x => x.broadP10)), broadNdcg10: mean(m.map(x => x.broadNdcg10)) };
  });
  const narrow = per.filter(p => p.class === 'narrow'), broad = per.filter(p => p.class === 'broad');
  return { row, questions: per, narrowR20: mean(narrow.map(p => p.narrowR20)), narrowR10: mean(narrow.map(p => p.narrowR10)),
    broadP10: mean(broad.map(p => p.broadP10)), broadNdcg10: mean(broad.map(p => p.broadNdcg10)) };
}

/** Paired group bootstrap of a narrow Recall@20 difference (connected questions resampled together). Quote `ci95`, not `lower95`. */
export function compareNarrowR20(base: ReturnType<typeof rowScores>, variant: ReturnType<typeof rowScores>, seed = 29): BootstrapResult {
  const values = base.questions.filter(q => q.class === 'narrow').map(b => {
    const v = variant.questions.find(x => x.id === b.id);
    if (!v) throw new Error(`Missing ${b.id} in ${variant.row}`);
    return { id: b.id, group: b.group, base: b.narrowR20, variant: v.narrowR20 };
  });
  return pairedGroupBootstrap(values, 10_000, seed);
}

/** Pairs of questions in different connected groups that now share a coded case (the bootstrap assumes none). */
export function crossGroupShares(questions: readonly RankingQuestion[]): number {
  let shared = 0;
  for (const [i, a] of questions.entries()) for (const b of questions.slice(i + 1)) {
    if (a.group !== b.group && a.relevant.some(n => b.relevant.includes(n))) shared += 1;
  }
  return shared;
}
