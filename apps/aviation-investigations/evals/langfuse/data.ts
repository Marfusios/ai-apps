/** Versioned public fixtures and Task 24's coded-reference metrics. Never used as model instructions. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { codedMetrics } from '../search-quality/ab-score.js';
import type { RankingQuestion } from '../search-quality/ab-types.js';

export const TASK_CAP_MICROS = 750_000;
export const EVALUATOR_VERSION = 'task24-coded-v1';
export const CONFIGURATIONS = ['er-q-v1', 'er-q-h50-v1'] as const;
export const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const opaqueId = (...parts: string[]) => sha256(stable(parts));
export interface EvaluationDataset {
  name: string; phase: 'selection' | 'confirmation'; questions: RankingQuestion[];
  datasetSha256: string; goldSha256: string; sourceFileSha256: string;
}
export function loadDatasets(): EvaluationDataset[] {
  return [
    { name: 'aircase-trackc-dev-v1', phase: 'selection' as const, path: 'evals/retrieval/coded/dataset.json', count: 21,
      hash: '5d1746bd04af8602c18babf2ae6cca6b3e1fd2760f6d72852df86ba240b8b3a4' },
    { name: 'aircase-task24-confirmation-v1', phase: 'confirmation' as const, path: 'evals/search-quality/frozen/confirmation.json', count: 48,
      hash: JSON.parse(readFileSync('evals/search-quality/frozen/ab-manifest.json', 'utf8')).files['evals/search-quality/frozen/confirmation.json'] as string },
  ].map(spec => {
    const bytes = readFileSync(spec.path, 'utf8');
    if (sha256(bytes) !== spec.hash) throw new Error('Frozen evaluation dataset changed');
    const data = JSON.parse(bytes) as { questions: (RankingQuestion & { split?: string })[] };
    const questions = data.questions.filter(q => spec.phase === 'confirmation' || q.split === 'dev')
      .map(({ id, question, group, class: kind, area, relevant }) => ({ id, question, group, class: kind, area, relevant }));
    if (questions.length !== spec.count || new Set(questions.map(q => q.id)).size !== spec.count) throw new Error('Unexpected dataset membership');
    for (const q of questions) codedMetrics([], q.relevant);
    return { name: spec.name, phase: spec.phase, questions, sourceFileSha256: spec.hash,
      datasetSha256: sha256(stable(questions)),
      goldSha256: sha256(stable(questions.map(q => ({ id: q.id, class: q.class, relevant: q.relevant })))) };
  });
}
export function datasetMetadata(d: EvaluationDataset) {
  return { datasetSha256: d.datasetSha256, goldSha256: d.goldSha256, sourceFileSha256: d.sourceFileSha256,
    dataPolicy: 'synthetic-public', evaluatorVersion: EVALUATOR_VERSION, questionCount: d.questions.length };
}
export function datasetItem(d: EvaluationDataset, q: RankingQuestion) {
  return { id: opaqueId(d.name, q.id), datasetName: d.name, status: 'ACTIVE', input: q.question,
    expectedOutput: { caseNumbers: q.relevant, class: q.class },
    metadata: { questionId: q.id, connectedGroup: q.group, datasetSha256: d.datasetSha256, goldSha256: d.goldSha256,
      itemSha256: sha256(stable(q)), dataPolicy: 'synthetic-public' } };
}
export const SCORE_DEFINITIONS = [
  { name: 'narrow_R20', description: 'Task 24 coded reference recall at 20, narrow questions only; full gold denominator.' },
  { name: 'narrow_R10', description: 'Task 24 coded reference recall at 10, narrow questions only; full gold denominator.' },
  { name: 'broad_P10', description: 'Task 24 coded reference precision at 10, broad questions only; denominator 10, missing slots zero.' },
  { name: 'broad_nDCG10', description: 'Task 24 coded binary-reference nDCG at 10, broad questions only; gain 3, log2 rank discount.' },
] as const;
export type ScoreName = typeof SCORE_DEFINITIONS[number]['name'];
export function itemScores(q: RankingQuestion, ranking: readonly string[]): Partial<Record<ScoreName, number>> {
  const m = codedMetrics(ranking, q.relevant);
  return q.class === 'narrow' ? { narrow_R20: m.narrowR20, narrow_R10: m.narrowR10 } : { broad_P10: m.broadP10, broad_nDCG10: m.broadNdcg10 };
}
export function meanScores(items: readonly Partial<Record<ScoreName, number>>[]) {
  return Object.fromEntries(SCORE_DEFINITIONS.map(({ name }) => {
    const values = items.flatMap(v => v[name] === undefined ? [] : [v[name]!]);
    if (!values.length) throw new Error('Missing score stratum');
    return [name, { value: values.reduce((a, b) => a + b, 0) / values.length, count: values.length }];
  })) as Record<ScoreName, { value: number; count: number }>;
}
