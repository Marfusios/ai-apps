/** Registered Task 24 metrics and decision rules, independent of any retrieval implementation. */
import { mean, median, nearestRank, pairedGroupBootstrap, type BootstrapResult } from '../retrieval/experiments/stats.js';
import type { Arm, ArmIdentity, RankingQuestion, SearchObservation, TimingStage } from './ab-types.js';

const EPS = 1e-9;
export const ENDPOINTS = ['narrowR20', 'narrowR10', 'broadP6', 'broadNdcg6', 'broadP10', 'broadNdcg10'] as const;
export type Endpoint = typeof ENDPOINTS[number];
export function codedMetrics(ranking: readonly string[], gold: readonly string[]) {
  if (!gold.length || new Set(gold).size !== gold.length || new Set(ranking).size !== ranking.length) throw new Error('Invalid coded ranking or gold');
  const relevant = new Set(gold);
  const hits = (k: number) => ranking.slice(0, k).filter(n => relevant.has(n)).length;
  const ndcg = (k: number) => {
    const dcg = ranking.slice(0, k).reduce((s, n, i) => s + (relevant.has(n) ? 3 / Math.log2(i + 2) : 0), 0);
    const ideal = Array.from({ length: Math.min(k, gold.length) }, (_, i) => 3 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
    return dcg / ideal;
  };
  return { narrowR20: hits(20) / gold.length, narrowR10: hits(10) / gold.length,
    broadP6: hits(6) / 6, broadP10: hits(10) / 10, broadNdcg6: ndcg(6), broadNdcg10: ndcg(10) };
}
const distribution = (values: number[]) => values.length ? { count: values.length, mean: mean(values), p50: nearestRank(values, .5),
  p95: nearestRank(values, .95), max: Math.max(...values) } : { count: 0, mean: null, p50: null, p95: null, max: null };
const countBy = (xs: string[]) => Object.fromEntries([...new Set(xs)].sort().map(k => [k, xs.filter(x => x === k).length]));
const failedScope = (r: SearchObservation) => !['used', 'non_search', 'skipped'].includes(r.scopeOutcome);
const attemptedRerank = (r: SearchObservation) => r.timing.rerank.attempted;
export function assertComplete(questions: readonly RankingQuestion[], arm: Arm, rows: readonly SearchObservation[]) {
  const selected = rows.filter(r => r.arm === arm);
  if (selected.length !== questions.length * 3) throw new Error('Incomplete three-sample arm');
  for (const q of questions) {
    const found = selected.filter(r => r.questionId === q.id);
    if (found.length !== 3 || new Set(found.map(r => r.sample)).size !== 3 || found.some(r => ![1, 2, 3].includes(r.sample))) throw new Error('Missing or repeated sample');
  }
  if (new Set(selected.map(r => r.key)).size !== selected.length) throw new Error('Duplicate attempt');
  return selected;
}
function questionMeans(questions: readonly RankingQuestion[], arm: Arm, rows: readonly SearchObservation[]) {
  const selected = assertComplete(questions, arm, rows);
  return questions.map(q => {
    const samples = selected.filter(r => r.questionId === q.id);
    const scores = samples.map(r => codedMetrics(r.ranking, q.relevant));
    return { ...q, samples, metrics: Object.fromEntries(ENDPOINTS.map(m => [m, mean(scores.map(s => s[m]))])) as Record<Endpoint, number>,
      totalMedianMs: median(samples.map(r => r.totalMs)) };
  });
}
export function armSummary(questions: readonly RankingQuestion[], identity: ArmIdentity, rows: readonly SearchObservation[]) {
  const qs = questionMeans(questions, identity.alias, rows), selected = qs.flatMap(q => q.samples);
  const scopeAttempts = selected.filter(r => r.timing.scope.attempted), reranks = selected.filter(attemptedRerank);
  const stages = ['scope', 'embed', 'retrieve', 'rerank'] as TimingStage[];
  return { identity, searches: selected.length,
    metrics: Object.fromEntries(ENDPOINTS.map(m => [m, mean(qs.filter(q => q.class === (m.startsWith('narrow') ? 'narrow' : 'broad')).map(q => q.metrics[m]))])) as Record<Endpoint, number>,
    latency: { total: distribution(selected.map(r => r.totalMs)),
      stages: Object.fromEntries(stages.map(s => [s, { all: distribution(selected.map(r => r.timing[s].ms)),
        attempted: distribution(selected.filter(r => r.timing[s].attempted).map(r => r.timing[s].ms)) }])) },
    cost: { actual: distribution(selected.map(r => r.actualUsd)), reserved: distribution(selected.map(r => r.reservationUsd)),
      stageTotals: Object.fromEntries(stages.filter(s => s !== 'retrieve').map(s => [s, selected.flatMap(r => r.usage).filter(l => l.stage === s).reduce((n, l) => n + l.usd, 0)])),
      cacheReadTokens: selected.flatMap(r => r.usage).reduce((n, l) => n + (l.tokens?.cacheReadTokens ?? 0), 0),
      cacheWriteTokens: selected.flatMap(r => r.usage).reduce((n, l) => n + (l.tokens?.cacheWriteTokens ?? 0), 0),
      embeddingCacheHits: selected.filter(r => r.embeddingCacheHit).length },
    scope: { outcomes: countBy(selected.map(r => r.scopeOutcome)), attempts: scopeAttempts.length,
      failed: scopeAttempts.filter(failedScope).length, failureRate: scopeAttempts.length ? scopeAttempts.filter(failedScope).length / scopeAttempts.length : 0 },
    lexical: countBy(selected.map(r => r.lexicalSource)),
    rerank: { outcomes: countBy(selected.map(r => r.rerankOutcome)), attempts: reranks.length,
      failed: reranks.filter(r => r.rerankOutcome !== 'applied').length,
      failureRate: reranks.length ? reranks.filter(r => r.rerankOutcome !== 'applied').length / reranks.length : 0 },
    failures: selected.filter(r => r.failure).length, safetyFaults: selected.flatMap(r => r.safetyFaults),
    pool: { recall50: mean(qs.filter(q => q.class === 'narrow').map(q => mean(q.samples.map(r => r.fused.slice(0, 50).filter(n => q.relevant.includes(n)).length / q.relevant.length)))),
      recall100: mean(qs.filter(q => q.class === 'narrow').map(q => mean(q.samples.map(r => r.fused.slice(0, 100).filter(n => q.relevant.includes(n)).length / q.relevant.length)))),
      fractionNarrowAt90R20: mean(qs.filter(q => q.class === 'narrow').map(q => Number(q.metrics.narrowR20 >= .9 - EPS))) },
    samples: [1, 2, 3].map(sample => ({ sample, metrics: Object.fromEntries(ENDPOINTS.map(m => [m,
      mean(qs.filter(q => q.class === (m.startsWith('narrow') ? 'narrow' : 'broad')).map(q => codedMetrics(q.samples.find(r => r.sample === sample)!.ranking, q.relevant)[m]))])) })),
    perQuestion: qs.map(q => ({ id: q.id, group: q.group, class: q.class, metrics: q.metrics, totalMedianMs: q.totalMedianMs })) };
}
export type ArmSummary = ReturnType<typeof armSummary>;
export function compare(questions: readonly RankingQuestion[], identity: ArmIdentity, baseline: ArmIdentity, rows: readonly SearchObservation[], confirmation: boolean) {
  const a = armSummary(questions, identity, rows), b = armSummary(questions, baseline, rows);
  const metrics = Object.fromEntries(ENDPOINTS.map(m => {
    const values = a.perQuestion.filter(q => q.class === (m.startsWith('narrow') ? 'narrow' : 'broad')).map(q => ({ id: q.id, group: q.group,
      variant: q.metrics[m], base: b.perQuestion.find(v => v.id === q.id)!.metrics[m] }));
    return [m, pairedGroupBootstrap(values, 10_000, 2026102503)];
  })) as Record<Endpoint, BootstrapResult>;
  const added = distribution(a.perQuestion.map(q => q.totalMedianMs - b.perQuestion.find(v => v.id === q.id)!.totalMedianMs));
  const reasons: string[] = [];
  if (metrics.narrowR20.delta < .05 - EPS || metrics.narrowR20.lower95 <= EPS) reasons.push('primary_gain_or_lower_bound');
  for (const m of ENDPOINTS.slice(1)) {
    if (metrics[m].delta < -.02 - EPS || confirmation && metrics[m].lower95 <= -.02 + EPS) reasons.push(`noninferiority_${m}`);
  }
  if (a.latency.total.p95! > 20_000 + EPS || added.p95! > 10_000 + EPS) reasons.push('latency');
  if (a.cost.actual.mean! > .01 + EPS || identity.reservationUsd > .05 + EPS) reasons.push('cost');
  for (const summary of [a, b]) {
    if (summary.scope.failureRate > .05 + EPS) reasons.push(`${summary.identity.alias}_scope_failures`);
    if (summary.rerank.failureRate > .05 + EPS) reasons.push(`${summary.identity.alias}_rerank_fallbacks`);
    if (summary.failures || summary.safetyFaults.length) reasons.push(`${summary.identity.alias}_search_or_safety_fault`);
  }
  const groups = [...new Set(questions.map(q => q.group))].sort();
  const leaveOneGroupOut = groups.map(group => ({ omitted: group, deltas: Object.fromEntries(ENDPOINTS.map(m => {
    const values = a.perQuestion.filter(q => q.group !== group && q.class === (m.startsWith('narrow') ? 'narrow' : 'broad'));
    return [m, mean(values.map(q => q.metrics[m] - b.perQuestion.find(v => v.id === q.id)!.metrics[m]))];
  })) }));
  return { arm: identity.alias, confirmation, qualifies: reasons.length === 0, reasons, metrics, addedLatency: added, summary: a, leaveOneGroupOut };
}
export type Comparison = ReturnType<typeof compare>;
const ascii = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const numeric = (a: number, b: number) => Math.abs(a - b) <= EPS ? 0 : a - b;
export function chooseWinner(comparisons: readonly Comparison[]): Arm | null {
  const candidates = comparisons.filter(c => c.qualifies);
  if (!candidates.length) return null;
  const best = Math.max(...candidates.map(c => c.metrics.narrowR20.delta));
  return candidates.filter(c => c.metrics.narrowR20.delta >= best - .01 - EPS).sort((a, b) =>
    numeric(b.summary.metrics.broadNdcg10, a.summary.metrics.broadNdcg10) || numeric(a.summary.identity.reservationUsd, b.summary.identity.reservationUsd) ||
    numeric(a.summary.latency.total.p95!, b.summary.latency.total.p95!) || a.summary.identity.changedKnobs - b.summary.identity.changedKnobs || ascii(a.arm, b.arm))[0]!.arm;
}
/** Optional D before S, independently ranked within H50 keyword candidates; at most two each. */
export function optionalCandidates(summaries: readonly ArmSummary[], kind: 'depth' | 'sonnet'): Arm[] {
  const h = summaries.filter(s => (kind === 'depth' ? ['QH50', 'TH50', 'QTH50'] : ['TH50', 'QTH50']).includes(s.identity.alias));
  if (h.length !== (kind === 'depth' ? 3 : 2)) throw new Error('Incomplete H50 block');
  const best = Math.max(...h.map(s => s.metrics.narrowR20));
  const ranked = h.filter(s => s.metrics.narrowR20 >= best - .01 - EPS).sort((a, b) => numeric(b.metrics.narrowR20, a.metrics.narrowR20) ||
    numeric(b.metrics.narrowR10, a.metrics.narrowR10) || numeric(b.metrics.broadNdcg10, a.metrics.broadNdcg10) ||
    numeric(a.identity.reservationUsd, b.identity.reservationUsd) || ascii(a.identity.alias, b.identity.alias)).slice(0, 2);
  return ranked.map(s => (kind === 'depth' ? s.identity.alias.replace('50', '100') : s.identity.alias.replace('H50', 'S50')) as Arm);
}
