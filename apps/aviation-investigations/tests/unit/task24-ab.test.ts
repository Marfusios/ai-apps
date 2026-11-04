import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codedMetrics, compare, chooseWinner, optionalCandidates, armSummary } from '../../evals/search-quality/ab-score.js';
import { schedule } from '../../evals/search-quality/ab-schedule.js';
import { ARM_IDS, CORE_ARMS, type Arm, type ArmIdentity, type RankingQuestion, type SearchObservation } from '../../evals/search-quality/ab-types.js';
import { runBlock, readObservations } from '../../evals/search-quality/ab-run.js';
import { requireRankingGate } from '../../evals/search-quality/ab-manifest.js';

const identities = Object.fromEntries(Object.entries(ARM_IDS).map(([alias, version]) => [alias,
  { alias, version, sha256: 'a'.repeat(64), reservationUsd: .009, changedKnobs: alias === 'Q0' ? 0 : 1, depth: alias.includes('100') ? 100 : alias.includes('50') ? 50 : 0 }])) as Record<Arm, ArmIdentity>;
const questions: RankingQuestion[] = Array.from({ length: 24 }, (_, i) => ({ id: `q${i}`, question: 'Synthetic test', group: `g${i}`,
  class: i < 12 ? 'narrow' : 'broad', area: 'test', relevant: Array.from({ length: i < 12 ? 20 : 30 }, (_, j) => `case${i}-${j}`) }));
function rows(arms: Arm[] = ['Q0', 'TH50']): SearchObservation[] {
  return schedule(questions, arms).map(s => {
    const q = questions.find(q => q.id === s.questionId)!;
    const relevant = q.relevant.slice(0, q.class === 'narrow' ? s.arm === 'Q0' ? 10 : 12 : 10);
    return { ...s, configuration: identities[s.arm], ranking: relevant, fused: q.relevant, scopeOutcome: 'used', lexicalSource: 'question', rerankOutcome: s.arm === 'Q0' ? 'disabled' : 'applied',
      executed: { lexical: q.question, vector: q.question }, usage: [], actualUsd: .001, reservationUsd: .009, reservationIds: [],
      timing: { scope: { ms: 10, attempted: true }, embed: { ms: 1, attempted: true }, retrieve: { ms: 5, attempted: true }, rerank: { ms: s.arm === 'Q0' ? 0 : 10, attempted: s.arm !== 'Q0' } },
      totalMs: 100, embeddingCacheHit: false, failure: null, safetyFaults: [] };
  });
}
describe('Task 24 registered A/B construction', () => {
  it('keeps the full gold denominator at 10 and scores missing positions as zero', () => {
    const gold = Array.from({ length: 20 }, (_, i) => `${i}`);
    expect(codedMetrics(gold.slice(0, 10), gold).narrowR10).toBe(.5);
    expect(codedMetrics(['0'], gold).broadP6).toBe(1 / 6);
    expect(codedMetrics([], gold)).toEqual({ narrowR20: 0, narrowR10: 0, broadP6: 0, broadP10: 0, broadNdcg6: 0, broadNdcg10: 0 });
    expect(() => codedMetrics(['0', '0'], gold)).toThrow();
  });
  it('schedules all independent samples once, in three whole blocks', () => {
    const a = schedule(questions, CORE_ARMS);
    expect(a).toEqual(schedule(questions, CORE_ARMS));
    expect(a).toHaveLength(24 * 6 * 3); expect(new Set(a.map(r => r.key)).size).toBe(a.length);
    expect(a.slice(0, 24 * 6).every(r => r.sample === 1)).toBe(true);
  });
  it('passes a complete paired improvement, using question means and group bootstrap', () => {
    const c = compare(questions, identities.TH50, identities.Q0, rows(), true);
    expect(c.qualifies).toBe(true); expect(c.metrics.narrowR20.delta).toBeCloseTo(.1);
    expect(c.metrics.narrowR20.groups).toBe(12); expect(c.metrics.narrowR20.questions).toBe(12);
    expect(c.metrics.narrowR10.delta).toBe(0); expect(c.leaveOneGroupOut).toHaveLength(24);
  });
  it('never selects from incomplete samples or full-search failures', () => {
    expect(() => compare(questions, identities.TH50, identities.Q0, rows().slice(1), false)).toThrow();
    const r = rows(); r.find(r => r.arm === 'TH50')!.failure = 'retrieve';
    expect(compare(questions, identities.TH50, identities.Q0, r, false).qualifies).toBe(false);
  });
  it('requires secondary lower bounds at confirmation, beyond the development point margin', () => {
    const r = rows();
    for (const v of r.filter(r => r.arm === 'TH50' && r.questionId === 'q12')) v.ranking = v.ranking.slice(0, 8);
    expect(compare(questions, identities.TH50, identities.Q0, r, false).qualifies).toBe(true);
    const confirmation = compare(questions, identities.TH50, identities.Q0, r, true);
    expect(confirmation.qualifies).toBe(false);
    expect(confirmation.reasons).toContain('noninferiority_broadP10');
  });
  it('enforces latency, cost and exact five-percent fallback thresholds', () => {
    const r = rows();
    for (const v of r.filter(r => r.arm === 'TH50')) { v.totalMs = 21_000; v.actualUsd = .02; }
    const c = compare(questions, identities.TH50, identities.Q0, r, false);
    expect(c.reasons).toContain('latency'); expect(c.reasons).toContain('cost');
    for (const v of r.filter(r => r.arm === 'TH50').slice(0, 4)) v.rerankOutcome = 'invalid_output';
    expect(compare(questions, identities.TH50, identities.Q0, r, false).reasons).toContain('TH50_rerank_fallbacks');
  });
  it('does not rescue a failed primary with broad metrics', () => {
    const r = rows(); for (const v of r.filter(r => r.arm === 'TH50')) v.ranking = questions.find(q => q.id === v.questionId)!.relevant.slice(0, 10);
    expect(chooseWinner([compare(questions, identities.TH50, identities.Q0, r, false)])).toBeNull();
  });
  it('ranks optional depth and Sonnet variants only from complete H50 arms', () => {
    const r = rows(['QH50', 'TH50', 'QTH50']);
    const s = (['QH50', 'TH50', 'QTH50'] as Arm[]).map(a => armSummary(questions, identities[a], r));
    expect(optionalCandidates(s, 'depth')).toHaveLength(2);
    expect(optionalCandidates(s, 'sonnet').sort()).toEqual(['QTS50', 'TS50']);
    expect(() => optionalCandidates(s.slice(1), 'depth')).toThrow();
  });
  it('resumes a complete durable block without another model attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task24-offline-'));
    try {
      const samples = rows(['Q0']), run = vi.fn(async attempt => samples.find(r => r.key === attempt.key)!);
      const admission = { assertBlock: vi.fn(async () => {}), canFit: vi.fn(async () => true) };
      const first = await runBlock(dir, 'synthetic', questions.slice(0, 1), ['Q0'], identities, { run }, admission);
      expect(first).toHaveLength(3); expect(run).toHaveBeenCalledTimes(3);
      expect(await runBlock(dir, 'synthetic', questions.slice(0, 1), ['Q0'], identities, { run }, admission)).toEqual(first);
      expect(run).toHaveBeenCalledTimes(3); expect(admission.assertBlock).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('never retries a dispatched search whose durable result is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task24-offline-'));
    try {
      const run = vi.fn(async () => { throw new Error('simulated process loss'); });
      const admission = { assertBlock: async () => {}, canFit: async () => true };
      await expect(runBlock(dir, 'synthetic', questions.slice(0, 1), ['Q0'], identities, { run }, admission)).rejects.toThrow();
      expect(() => readObservations(dir)).toThrow('reconcile without repeating');
      await expect(runBlock(dir, 'synthetic', questions.slice(0, 1), ['Q0'], identities, { run }, admission)).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses the whole block before dispatch when its allowance is insufficient', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task24-offline-'));
    try {
      const run = vi.fn(), admission = { assertBlock: async () => { throw new Error('cap'); }, canFit: async () => false };
      await expect(runBlock(dir, 'synthetic', questions.slice(0, 1), ['Q0'], identities, { run }, admission)).rejects.toThrow('cap');
      expect(run).not.toHaveBeenCalled(); expect(readObservations(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not treat a construction manifest as controller clearance', () => {
    expect(() => requireRankingGate(undefined, undefined, {} as never, 'a'.repeat(64))).toThrow('waits for the controller');
  });
});
