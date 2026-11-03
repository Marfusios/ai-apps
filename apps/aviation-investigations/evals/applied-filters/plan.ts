/** Task 29's pure parts: the rows, the "Apply these filters" request, worst-case sizing and the scores. */
import { BriefFiltersSchema, type BriefFilters } from '../../shared/contracts/briefs.js';
import type { EvidenceScopeSuggestion } from '../../shared/contracts/evidence.js';
import { questionQuery, remainingSuggestion } from '../../server/evidence/disclosure.js';
import type { LexicalSource } from '../../server/evidence/pipeline.js';
import { embeddingWorstCaseUsd, stageWorstCaseUsd } from '../../server/ai/pricing.js';
import type { EvidenceRankingConfig } from '../../server/evidence/ranking-config.js';
import { codedMetrics } from '../search-quality/ab-score.js';
import type { RankingQuestion } from '../search-quality/ab-types.js';
import { mean, pairedGroupBootstrap, type BootstrapResult } from '../retrieval/experiments/stats.js';
import { withSuggestedFilters } from './filters.js';

/**
 * - `Q0`: Elasticsearch alone, the question as typed (no AI stage; scope skipped, it cannot change this ranking).
 * - `QH50`: the live search: the same, then the AI orders the top 50; its filters are only suggested.
 * - `QH50+F`: that search after one click on "Apply these filters": an edit with the suggestion's filters.
 * - `Q0+F`: the same filters without the AI ordering (diagnostic).
 */
export const ROWS = ['Q0', 'QH50', 'QH50+F', 'Q0+F'] as const;
export type Row = typeof ROWS[number];
export const SAMPLES = [1, 2, 3] as const;

const hasFilters = (f: BriefFilters) => Object.values(f).some(v => Array.isArray(v) ? v.length > 0 : v !== undefined);

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

/** Worst-case microdollars of one question's searches: Q0 once, then per sample QH50 and its two edits. */
export function questionWorstCaseMicros(q0: EvidenceRankingConfig, qh50: EvidenceRankingConfig): number {
  const micros = (usd: number) => Math.ceil(usd * 1e6);
  const embed = micros(embeddingWorstCaseUsd(qh50.embedding.model));
  const scope = micros(stageWorstCaseUsd(qh50.scope.model, qh50.scope.caps, qh50.scope.cachePrefixTokens));
  const rerank = micros(stageWorstCaseUsd(qh50.rerank!.model, qh50.rerank!.caps, qh50.rerank!.cachePrefixTokens));
  if (q0.rerank || q0.embedding.model !== qh50.embedding.model) throw new Error('Unexpected Task 29 configurations');
  return embed + SAMPLES.length * ((scope + embed + rerank) + (embed + rerank) + embed);
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

/** Paired group bootstrap of a narrow Recall@20 difference (connected questions resampled together). */
export function compareNarrowR20(base: ReturnType<typeof rowScores>, variant: ReturnType<typeof rowScores>, seed = 29): BootstrapResult {
  const values = base.questions.filter(q => q.class === 'narrow').map(b => {
    const v = variant.questions.find(x => x.id === b.id);
    if (!v) throw new Error(`Missing ${b.id} in ${variant.row}`);
    return { id: b.id, group: b.group, base: b.narrowR20, variant: v.narrowR20 };
  });
  return pairedGroupBootstrap(values, 10_000, seed);
}
