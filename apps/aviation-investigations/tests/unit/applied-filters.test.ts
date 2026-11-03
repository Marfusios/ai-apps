import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFiltersRequest, compareNarrowR20, crossGroupShares, fallbackRates, filterMatch, isInfrastructure, questionWorstCaseMicros, rowScores, stageMicros, type RowRanking } from '../../evals/applied-filters/plan.js';
import { readJournal, TASK29 } from '../../evals/applied-filters/run.js';
import { checkTaskCap } from '../../evals/langfuse/money.js';
import { filterIdentity } from '../../evals/search-quality/ab-production.js';
import { evidenceRankingConfig } from '../../server/evidence/ranking-config.js';
import type { RankingQuestion } from '../../evals/search-quality/ab-types.js';

describe('Task 29 "Apply these filters" request', () => {
  it('sends the suggested filters the page shows', () => {
    expect(applyFiltersRequest('question', null, { filters: { state: ['HI'] }, terms: 'maintenance personnel' })).toEqual({ state: ['HI'] });
    expect(applyFiltersRequest('question', null, { filters: { yearFrom: 2023, yearTo: 2026, category: ['HELI'] }, terms: 'tail rotor' }))
      .toEqual({ yearFrom: 2023, yearTo: 2026, category: ['HELI'] });
  });
  it('offers no button without suggested filters', () => {
    expect(applyFiltersRequest('question', null, null)).toBeNull();
    expect(applyFiltersRequest('question', null, { filters: {}, terms: 'icing' })).toBeNull();
    expect(applyFiltersRequest('question', null, { filters: { state: [] }, terms: 'icing' })).toBeNull();
  });
  it('rejects a suggestion the edit request would reject', () => {
    expect(() => applyFiltersRequest('question', null, { filters: { yearFrom: 2026, yearTo: 2023 }, terms: 'icing' })).toThrow();
  });
});

describe('Task 29 answer-key match report', () => {
  it('separates exact, wider and different filters', () => {
    expect(filterMatch({ state: ['HI'] }, { state: ['HI'] })).toBe('exact');
    expect(filterMatch({ state: ['HI'], category: ['AIR'] }, { state: ['HI'] })).toBe('includes');
    expect(filterMatch({ state: ['AK'] }, { state: ['HI'] })).toBe('other');
    expect(filterMatch({ yearFrom: 2023 }, { yearFrom: 2023, yearTo: 2026 })).toBe('other');
    expect(filterMatch(null, { state: ['HI'] })).toBe('none');
    expect(filterMatch({ state: ['MN', 'HI'] }, { state: ['HI', 'MN'] })).toBe('exact');
  });
});

describe('Task 29 scores', () => {
  const qs: RankingQuestion[] = [
    { id: 'n1', question: 'q', group: 'g1', class: 'narrow', area: 'personnel', relevant: ['A', 'B'] },
    { id: 'n2', question: 'q', group: 'g2', class: 'narrow', area: 'personnel', relevant: ['C'] },
    { id: 'b1', question: 'q', group: 'g3', class: 'broad', area: 'personnel', relevant: Array.from({ length: 25 }, (_, i) => `X${i}`) },
  ];
  const rankings: RowRanking[] = [
    { row: 'QH50', questionId: 'n1', sample: 1, ranking: ['A', 'Z'] },
    { row: 'QH50', questionId: 'n1', sample: 2, ranking: ['A', 'B'] },
    { row: 'QH50', questionId: 'n2', sample: 1, ranking: ['Z'] },
    { row: 'QH50', questionId: 'b1', sample: 1, ranking: ['X0', 'X1', 'Z'] },
    { row: 'Q0', questionId: 'n1', sample: 1, ranking: [] },
    { row: 'Q0', questionId: 'n2', sample: 1, ranking: ['C'] },
    { row: 'Q0', questionId: 'b1', sample: 1, ranking: [] },
  ];
  it('averages samples within a question, then questions within a stratum', () => {
    const s = rowScores(qs, rankings, 'QH50');
    expect(s.questions.find(q => q.id === 'n1')).toMatchObject({ samples: 2, narrowR20: 0.75 });
    expect(s.narrowR20).toBeCloseTo((0.75 + 0) / 2);
    expect(s.broadP10).toBeCloseTo(0.2);
  });
  it('refuses a missing or repeated sample', () => {
    expect(() => rowScores(qs, rankings.filter(r => !(r.row === 'QH50' && r.questionId === 'n2')), 'QH50')).toThrow(/Missing/);
    expect(() => rowScores(qs, [...rankings, rankings[0]!], 'QH50')).toThrow(/repeated/);
  });
  it('compares narrow questions only, paired by question', () => {
    const d = compareNarrowR20(rowScores(qs, rankings, 'Q0'), rowScores(qs, rankings, 'QH50'));
    expect(d.questions).toBe(2);
    expect(d.delta).toBeCloseTo(((0.75 - 0) + (0 - 1)) / 2);
  });
});

describe('Task 29 money and journal', () => {
  it('sizes a question from the production stage worst cases', () => {
    const stages = stageMicros(evidenceRankingConfig('er-q-v1'), evidenceRankingConfig('er-q-h50-v1'));
    const micros = questionWorstCaseMicros(stages, 3);
    expect(micros).toBe(stages.embed + 3 * (stages.scope + 3 * stages.embed + 2 * stages.rerank));
    expect(micros).toBeLessThan(TASK29.capMicros / 10);
    expect(questionWorstCaseMicros(stages, 1)).toBeLessThan(micros);
    expect(() => stageMicros(evidenceRankingConfig('er-q-h50-v1'), evidenceRankingConfig('er-q-h50-v1'))).toThrow();
  });
  it('has its own ledger prefix, lock and hard cap', () => {
    expect(TASK29).toMatchObject({ allocation: 'eval-task29', lockKey: 732900029, capMicros: 800_000 });
    const t = { chargedMicros: 790_000, ledgerMicros: 790_000, openMicros: 0, open: 0, reservations: 3 };
    expect(() => checkTaskCap(t, 10_000, TASK29)).not.toThrow();
    expect(() => checkTaskCap(t, 10_001, TASK29)).toThrow('Task 29 hard $0.80 cap would be exceeded');
    expect(() => checkTaskCap({ ...t, open: 1, openMicros: 5 }, 1, TASK29)).toThrow(/Task 29 has unresolved/);
  });
  it('stops on an attempt without a durable result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task29-journal-'));
    try {
      const path = join(dir, 'results.jsonl');
      writeFileSync(path, JSON.stringify({ event: 'started', key: 'k1' }) + '\n');
      expect(() => readJournal(path)).toThrow(/no durable result/);
      writeFileSync(path, [{ event: 'started', key: 'k1' }, { event: 'result', key: 'k1', observation: {} }].map(r => JSON.stringify(r)).join('\n') + '\n');
      expect(readJournal(path).size).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('compares filter objects regardless of key order', () => {
    expect(filterIdentity({ state: ['HI'], yearFrom: 2023 })).toBe(filterIdentity({ yearFrom: 2023, state: ['HI'] }));
    expect(filterIdentity({ state: ['HI'] })).not.toBe(filterIdentity({}));
  });
});

describe('Task 29 fallbacks and groups', () => {
  const obs = (scopeOutcome: string, rerankOutcome: string, scope = true, rerank = true) => ({ scopeOutcome, rerankOutcome,
    timing: { scope: { attempted: scope, ms: 1 }, embed: { attempted: true, ms: 1 }, retrieve: { attempted: true, ms: 1 }, rerank: { attempted: rerank, ms: 1 } } }) as any;
  it('counts Task 24 infrastructure outcomes and fallback rates', () => {
    expect(isInfrastructure(obs('timeout', 'applied'))).toBe(true);
    expect(isInfrastructure(obs('used', 'overloaded'))).toBe(true);
    expect(isInfrastructure(obs('non_search', 'applied'))).toBe(false);
    const r = fallbackRates([obs('used', 'applied'), obs('timeout', 'applied'), obs('skipped', 'invalid_output', false), obs('skipped', 'disabled', false, false)]);
    expect(r).toMatchObject({ scopeAttempts: 2, scopeFailures: 1, rerankAttempts: 3, rerankFallbacks: 1 });
  });
  it('finds questions in different groups that share a coded case', () => {
    const q = (id: string, group: string, relevant: string[]) => ({ id, question: id, group, class: 'narrow' as const, area: 'personnel', relevant });
    expect(crossGroupShares([q('a', 'g1', ['X']), q('b', 'g1', ['X']), q('c', 'g2', ['Y'])])).toBe(0);
    expect(crossGroupShares([q('a', 'g1', ['X']), q('c', 'g2', ['X', 'Y'])])).toBe(1);
  });
});
