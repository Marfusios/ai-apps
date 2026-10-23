import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckInputSchema, CheckOutputSchema, type CheckOutput } from '../../server/ai/provider.js';
import { buildCalibration, readDataset, type CalibrationBatch } from '../../evals/checker/build.js';
import { EvidenceFileSchema } from '../../evals/checker/evidence.js';
import { rate, report, type Trial } from '../../evals/checker/metrics.js';
import { plannedTrials, selectConfiguration } from '../../evals/checker/run.js';
import { SUPPORTED_SAMPLES } from '../../evals/checker/protocol.js';
import { FAMILIES } from '../../evals/checker/types.js';

const DIR = resolve(import.meta.dirname, '../../evals/checker');
const evidenceText = readFileSync(resolve(DIR, 'evidence.json'), 'utf8');
const dataset = readDataset();

/** A checker that answers every claim as its label says (supported for unknown labels). */
function oracle(b: CalibrationBatch, flip = false): CheckOutput {
  return {
    verdicts: b.input.claims.map((c) => {
      const l = b.labels.find((x) => x.claim === c.id)!;
      const bad = (l.label === 'not_supported') !== flip;
      if (bad) return { claim: c.id, verdict: l.expect ?? 'not_established', passages: c.passageIds.slice(0, 4) };
      return { claim: c.id, verdict: 'supported' as const, passages: c.absence ? [] : c.passageIds.slice(0, 4) };
    }),
    quotes: [],
  };
}

const trialsOf = (split: 'dev' | 'holdout', answer: (b: CalibrationBatch) => CheckOutput | null): Trial[] =>
  plannedTrials(dataset, split).map((t) => ({ batch: t.batch.id, sample: t.sample, output: answer(t.batch), latencyMs: 1_000, costUsd: 0.001 }));

describe('the checker calibration set (evals/checker)', () => {
  it('is the deterministic build of evidence.json and the items, labels frozen by their hash', () => {
    const built = buildCalibration(EvidenceFileSchema.parse(JSON.parse(evidenceText)), evidenceText);
    expect(built.labels.sha256).toBe(dataset.labels.sha256);
    expect(`${JSON.stringify(built, null, 2)}\n`).toBe(readFileSync(resolve(DIR, 'dataset.json'), 'utf8'));
  });

  it('gives the checker production inputs and bounded outputs', () => {
    for (const b of dataset.batches) {
      expect(CheckInputSchema.safeParse(b.input).success, b.id).toBe(true);
      expect(b.labels.map((l) => l.claim)).toEqual(b.input.claims.map((c) => c.id));
      expect(CheckOutputSchema.safeParse(oracle(b)).success, b.id).toBe(true);
    }
  });

  it('keeps the splits apart by case and covers every family in both', () => {
    const splitOf = new Map<string, string>();
    for (const b of dataset.batches) {
      for (const p of b.input.passages) {
        expect(splitOf.get(p.ntsbNo) ?? b.split, p.ntsbNo).toBe(b.split);
        splitOf.set(p.ntsbNo, b.split);
      }
    }
    for (const split of ['dev', 'holdout'] as const) {
      const labels = dataset.batches.filter((b) => b.split === split).flatMap((b) => b.labels);
      for (const f of FAMILIES.filter((x) => x !== 'control')) {
        expect(labels.filter((l) => l.label === 'not_supported' && l.family === f).length, `${split} ${f}`).toBeGreaterThanOrEqual(10);
      }
      const briefs = dataset.batches.filter((b) => b.split === split && b.kind === 'brief');
      expect(briefs.filter((b) => b.brief === 'supported').length, split).toBeGreaterThanOrEqual(6);
      // A supported brief is wholly supported; an error brief has exactly one known error.
      for (const b of briefs) {
        const bad = b.labels.filter((l) => l.label !== 'supported');
        expect(bad.length, b.id).toBe(b.brief === 'supported' ? 0 : 1);
      }
    }
    expect(new Set([...splitOf.keys()]).size).toBeGreaterThanOrEqual(10);
  });

  it('keeps the paid run’s 35 claims as regressions, with its six critical errors', () => {
    const paid = dataset.batches.find((b) => b.id === 'dev.paid')!;
    expect(paid.labels.map((l) => l.paidIndex)).toEqual([...Array(35).keys()]);
    expect(paid.labels.filter((l) => l.critical).map((l) => l.paidIndex)).toEqual([0, 9, 10, 14, 17, 30]);
    expect(paid.labels.filter((l) => l.label === 'unknown').map((l) => l.paidIndex)).toEqual([12, 21]);
  });

  it('scores a perfect checker at no false withholding and full detection', () => {
    for (const split of ['dev', 'holdout'] as const) {
      const r = report(dataset.batches, trialsOf(split, (b) => oracle(b)), 12_000);
      expect(r.wholeBriefFalseWithholding.k).toBe(0);
      expect(r.wholeBriefFalseWithholding.n).toBe(dataset.batches.filter((b) => b.split === split && b.brief === 'supported').length * SUPPORTED_SAMPLES);
      expect(r.detection.all.rate).toBe(1);
      expect(r.critical.passedEveryTrial).toBe(r.critical.items);
      expect(r.falseFlags.k).toBe(0);
      expect(r.errorBriefs.errorClaimWithheld.rate).toBe(1);
    }
  });

  it('scores an inverted checker, and failed calls, as withholding', () => {
    const inverted = report(dataset.batches, trialsOf('dev', (b) => oracle(b, true)), 12_000);
    expect(inverted.wholeBriefFalseWithholding.rate).toBe(1);
    expect(inverted.detection.all.k).toBe(0);
    expect(inverted.critical.passedEveryTrial).toBe(0);
    const failed = report(dataset.batches, trialsOf('dev', () => null), 12_000);
    expect(failed.wholeBriefFalseWithholding.rate).toBe(1);
    expect(failed.detection.all.rate).toBe(1);
    expect(failed.failedCalls).toEqual({ failed: failed.calls });
  });

  it('counts a missing verdict as withholding that claim', () => {
    const b = dataset.batches.find((x) => x.brief === 'supported' && x.split === 'dev')!;
    const out = oracle(b);
    out.verdicts.pop();
    const r = report(dataset.batches, [{ batch: b.id, sample: 1, output: out, latencyMs: 1, costUsd: 0 }], 12_000);
    expect(r.wholeBriefFalseWithholding).toMatchObject({ k: 1, n: 1 });
    expect(r.falseFlags.k).toBe(1);
  });

  it('reports Wilson intervals', () => {
    expect(rate(0, 0).rate).toBeNull();
    const r = rate(2, 20);
    expect(r.rate).toBeCloseTo(0.1);
    expect(r.low).toBeCloseTo(0.0279, 3);
    expect(r.high).toBeCloseTo(0.3010, 3);
    expect(rate(0, 30).high).toBeCloseTo(0.1135, 3);
  });

  it('applies the frozen selection rule', () => {
    const summary = (config: string, fw: number, family: number, critical: boolean, perBriefUsd: number) => {
      const r = report(dataset.batches, trialsOf('dev', (b) => oracle(b)), 12_000);
      return {
        config,
        model: 'm',
        thinking: 'off',
        split: 'dev',
        checkPrompt: 'check.v6',
        labelsSha256: dataset.labels.sha256,
        complete: true,
        report: {
          ...r,
          wholeBriefFalseWithholding: { ...r.wholeBriefFalseWithholding, rate: fw },
          detection: { ...r.detection, timing: { ...r.detection.timing, rate: family } },
          critical: { ...r.critical, passedEveryTrial: critical ? r.critical.items : r.critical.items - 1 },
          cost: { ...r.cost, perBriefUsd },
        },
      };
    };
    // Eligible: the lowest false withholding wins; within one trial, the cheaper one.
    expect(selectConfiguration([summary('a', 0.05, 1, true, 0.03), summary('b', 0, 1, true, 0.002)]).config).toBe('b');
    expect(selectConfiguration([summary('a', 0.0476, 1, true, 0.03), summary('b', 0.0952, 1, true, 0.002)]).config).toBe('b');
    expect(selectConfiguration([summary('a', 0, 1, true, 0.03), summary('b', 0.1, 1, true, 0.002)]).config).toBe('a');
    // Not eligible: a missed critical regression or a family under 95%.
    expect(selectConfiguration([summary('a', 0.5, 1, true, 0.03), summary('b', 0, 1, false, 0.002)]).config).toBe('a');
    const none = selectConfiguration([summary('a', 0.3, 0.9, true, 0.03), summary('b', 0, 0.8, true, 0.002)]);
    expect(none).toMatchObject({ config: 'a', eligible: [] });
    expect(none.reason).toContain('missing family detection');
  });
});
