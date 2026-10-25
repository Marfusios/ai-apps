import { mulberry32 } from '../retrieval/experiments/stats.js';
import type { Arm, RankingQuestion, ScheduledSearch } from './ab-types.js';

/** Three whole sample blocks, deterministic question and within-question arm order. */
export function schedule(questions: readonly RankingQuestion[], arms: readonly Arm[]): ScheduledSearch[] {
  if (new Set(questions.map(q => q.id)).size !== questions.length || new Set(arms).size !== arms.length || !arms.length) throw new Error('Duplicate or empty schedule');
  const random = mulberry32(2026102502);
  const shuffled = <T>(values: readonly T[]) => {
    const a = [...values]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a;
  };
  const rows: ScheduledSearch[] = [];
  for (const sample of [1, 2, 3] as const) {
    for (const q of shuffled(questions)) for (const arm of shuffled(arms)) rows.push({ key: `${q.id}:${arm}:${sample}`, questionId: q.id, arm, sample });
  }
  return rows;
}
