import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CheckInputSchema, CheckOutputSchema, type CheckOutput } from '../../server/ai/provider.js';
import {
  V1_LABELS_SHA256,
  V2_FILE_SHA256,
  buildCalibrationV3,
  labelsHash,
  readDataset,
  readDatasetV2,
  readDatasetV3,
  readEvidenceV3,
  v1LabelsV2,
  v1Plans,
  v2LabelsV3,
  v2Plans,
  type CalibrationBatch,
  type CalibrationDataset,
} from '../../evals/checker/build.js';
import { EvidenceFileSchema, EvidenceV2FileSchema, sha256 } from '../../evals/checker/evidence.js';
import { BRIEF_LABELS_V2, CLAIM_LABELS_V2 } from '../../evals/checker/labels.v2.js';
import { BRIEF_ERRATA, CLAIM_ERRATA, DISPUTED } from '../../evals/checker/labels.v3.js';
import { identityDifferences, inputsSha256, manifestId, newManifest, readManifest, resumeState, type RunIdentity } from '../../evals/checker/manifest.js';
import { clusteredRate, displayReport, gateOf, rate, rawReport, type Trial } from '../../evals/checker/metrics.js';
import { CANDIDATES_V2, HELDOUT_V2, PROTOCOL_V2, candidateMismatch, selectV2, type DevRunV2 } from '../../evals/checker/protocol.v2.js';
import { plannedSlots, runFigures, SELECTION_V2_PATH, type SelectionV2 } from '../../evals/checker/run.js';
import {
  BUDGET_V3,
  CANDIDATES_V3,
  FROZEN_RULES,
  HELDOUT_V3,
  PROTOCOL_V3,
  ROUNDS_V3,
  SAMPLES_V3,
  TARGETS_V3,
  candidateMismatchV3,
  codeRules,
  derivedTimeoutMs,
  productionMismatchV3,
  protocolV3Sha256,
  selectV3,
  type DevRunV3,
} from '../../evals/checker/protocol.v3.js';
import { SELECTION_V3_PATH, identityForV3, plannedSlotsV3, reservationRefusal, runFiguresV3, type SelectionV3 } from '../../evals/checker/run.v3.js';
import { STAGE_TIMEOUTS } from '../../server/briefs/pipeline.js';
import { selectConfiguration } from '../../evals/checker/v1.js';
import { STAGE_THINKING } from '../../server/ai/anthropic.js';
import { loadConfig } from '../../shared/config.js';

const DIR = resolve(import.meta.dirname, '../../evals/checker');
const evidenceText = readFileSync(resolve(DIR, 'evidence.json'), 'utf8');
const v2Text = readFileSync(resolve(DIR, 'evidence-16d.json'), 'utf8');
const v1 = readDataset();
const v2 = readDatasetV2();
const v3 = readDatasetV3();
/** The v2 batches' plans as the production code builds them now (display-deps-v2, the static rules); the frozen file keeps 16d's. */
const v2plans = v2Plans(v2).plans;
const withPlans = (bs: readonly CalibrationBatch[]) => bs.map((b) => ({ ...b, plan: v2plans.get(b.id)! }));

/** A checker that answers every claim as its label says (supported for unknown labels); `flip` inverts it. */
function oracle(b: CalibrationBatch, flip = false): CheckOutput {
  return {
    verdicts: b.input.claims.map((c) => {
      const l = b.labels.find((x) => x.claim === c.id)!;
      const bad = (l.label === 'not_supported') !== flip;
      if (bad) return { claim: c.id, verdict: l.expect ?? 'not_established', passages: c.passageIds.slice(0, 12) };
      return { claim: c.id, verdict: 'supported' as const, passages: c.absence ? [] : c.passageIds.slice(0, 12) };
    }),
    quotes: [],
  };
}

const trialsOf = (d: CalibrationDataset, split: 'dev' | 'holdout', answer: (b: CalibrationBatch) => CheckOutput | null): Trial[] =>
  plannedSlots(d, split).map((s) => {
    const b = d.batches.find((x) => x.id === s.batch)!;
    const output = answer(b);
    return { batch: s.batch, sample: s.sample, output, ...(output ? {} : { failure: 'timeout' }), latencyMs: 1_000, costUsd: 0.001 };
  });

describe('the checker calibration sets (evals/checker)', () => {
  it('v1 (16c) stays frozen, and the production code still renders exactly its claims', () => {
    expect(v1.labels.sha256).toBe(V1_LABELS_SHA256);
    expect(labelsHash(v1.batches)).toBe(V1_LABELS_SHA256);
    const { plans, textChanged } = v1Plans(v1);
    expect(textChanged).toEqual([]);
    expect(plans.size).toBe(v1.batches.length);
    for (const b of v1.batches) expect(plans.get(b.id)!.claims.length, b.id).toBe(b.input.claims.length);
  });

  it('v2 (16d) stays frozen, and the production code still renders exactly its claims', () => {
    expect(sha256(readFileSync(resolve(DIR, 'dataset.v2.json'), 'utf8'))).toBe(V2_FILE_SHA256);
    expect(labelsHash(v2.batches)).toBe(v2.labels.sha256);
    const { plans, textChanged } = v2Plans(v2);
    expect(textChanged).toEqual([]);
    expect(plans.size).toBe(v2.batches.length);
    for (const b of v2.batches) expect(plans.get(b.id)!.claims.length, b.id).toBe(b.input.claims.length);
  });

  it('v3 is the deterministic build of the evidence and the items: every earlier item is development, labels v3 hashed per split', () => {
    const built = buildCalibrationV3(EvidenceFileSchema.parse(JSON.parse(evidenceText)), evidenceText, EvidenceV2FileSchema.parse(JSON.parse(v2Text)), v2Text, readEvidenceV3());
    expect(`${JSON.stringify(built, null, 2)}\n`).toBe(readFileSync(resolve(DIR, 'dataset.v3.json'), 'utf8'));
    expect(built.labels).toMatchObject({ version: 'checker-labels-v3', errata: 'checker-errata-v1' });
    for (const s of ['dev', 'holdout'] as const) expect(built.labels.splits![s].sha256).toBe(labelsHash(built.batches.filter((b) => b.split === s)));
    // Every v2 batch, the 16d held-out pilot included, is development with the same inputs.
    for (const b of v2.batches) {
      const x = built.batches.find((y) => y.id === b.id)!;
      expect(x.split, b.id).toBe('dev');
      expect(x.input, b.id).toEqual(b.input);
    }
    expect(built).toMatchObject({ displayRules: 'display-deps-v2', excerptRules: 'excerpt-context-v1', ordinalRules: 'ordinal-evidence-v1', chronologyRules: 'chronology-rules-v3' });
  });

  it('labels v3: the errata overlay changes exactly its claims, each with a source and a reason; disputed labels stay, flagged', () => {
    for (const e of [...CLAIM_ERRATA, ...BRIEF_ERRATA]) {
      expect(e.reason.length).toBeGreaterThan(60);
      expect(e.source.length).toBeGreaterThan(5);
    }
    const changed = v3.batches.flatMap((b) => {
      const old = v2.batches.find((x) => x.id === b.id)!;
      return b.labels.flatMap((l, i) => (l.label !== old.labels[i]!.label ? [`${b.id}/${l.item}:${old.labels[i]!.label}>${l.label}`] : []));
    });
    // 5 claim-batch items, 3 "third flight" claims in dev.b1, its error variants and its reading variant, the b5 timing claim in
    // holdout.b5, its variants and holdout.b5-week, the throttle excerpt in each throttle variant, and the copies in the maximum-size inputs.
    expect(changed.length).toBe(43);
    expect(changed).toContain('dev.paid/c01:supported>not_supported');
    expect(changed).toContain('dev.b1-hours/dev.b1-hours.C13:supported>not_supported');
    expect(changed).toContain('holdout.b5-week/holdout.b5-week.C8:supported>unknown');
    expect(changed).toContain('holdout16d.throttle/holdout16d.throttle.C35:supported>not_supported');
    expect(v3.batches.find((b) => b.id === 'holdout16d.throttle')!.brief).toBe('one_error');
    // The frozen results' labels do not change on disk: the overlay reaches the 16d inputs only through v2LabelsV3.
    expect(v2.batches.find((b) => b.id === 'dev.paid')!.labels[1]!.label).toBe('supported');
    expect(v2LabelsV3(v2).batches.find((b) => b.id === 'dev.paid')!.labels[1]!.label).toBe('not_supported');
    expect(v3.labels.disputed).toBe(v3.batches.flatMap((b) => b.labels).filter((l) => l.disputed).length);
    expect(new Set(v3.batches.flatMap((b) => b.labels.filter((l) => l.disputed).map((l) => l.key)))).toEqual(new Set(DISPUTED.map((d) => d.key)));
  });

  it('gives the checker production inputs (case headers, no criteria) and every batch a display plan', () => {
    for (const b of v2.batches) {
      expect(CheckInputSchema.safeParse(b.input).success, b.id).toBe(true);
      expect(b.input).not.toHaveProperty('criteria');
      expect(b.labels.map((l) => l.claim)).toEqual(b.input.claims.map((c) => c.id));
      expect(CheckOutputSchema.safeParse(oracle(b)).success, b.id).toBe(true);
      expect(b.plan, b.id).toBeDefined();
      expect(b.plan!.claims.length).toBe(b.input.claims.length);
      for (const c of b.input.cases) expect(c.header, b.id).not.toMatch(/loss of engine power|collision|contamination|starvation/i);
    }
  });

  it('keeps the splits apart by case: the 16d held-out set shares no case with either 16c split', () => {
    const splitOf = new Map<string, string>();
    for (const b of v2.batches) {
      for (const p of b.input.passages) {
        expect(splitOf.get(p.ntsbNo) ?? b.split, p.ntsbNo).toBe(b.split);
        splitOf.set(p.ntsbNo, b.split);
      }
    }
    const v1Cases = new Set(v1.batches.flatMap((b) => b.input.passages.map((p) => p.ntsbNo)));
    for (const b of v2.batches.filter((x) => x.split === 'holdout')) for (const p of b.input.passages) expect(v1Cases.has(p.ntsbNo), p.ntsbNo).toBe(false);
    // Both 16c splits are development now.
    for (const b of v2.batches.filter((x) => v1.batches.some((y) => y.id === x.id))) expect(b.split).toBe('dev');
  });

  it('labels v2: each correction has its reason; a brief with an unknown claim is never wholly supported', () => {
    for (const c of [...BRIEF_LABELS_V2, ...CLAIM_LABELS_V2]) expect(c.reason.length).toBeGreaterThan(40);
    const b6 = v2.batches.find((b) => b.id === 'holdout.b6')!;
    const engine = b6.labels.filter((l) => l.key === 'case.CEN17LA292.timing.0' || l.key === 'case.ERA15LA377.timing.0');
    expect(engine.map((l) => [l.label, l.mutation])).toEqual([
      ['not_supported', 'operating_hours_as_flight_hours'],
      ['not_supported', 'operating_hours_as_flight_hours'],
    ]);
    expect(b6.brief).toBe('mixed_error');
    // The 16c inputs had no header: "Cessna 150M" was unsupported there; with the header it is the paraphrase that stays unresolved.
    const v1b8 = v1LabelsV2(v1).batches.find((b) => b.id === 'holdout.b8')!;
    expect(v1b8.labels[0]).toMatchObject({ label: 'not_supported', family: 'unsupported_addition' });
    expect(v2.batches.find((b) => b.id === 'holdout.b8')!.labels[0]).toMatchObject({ label: 'unknown' });
    for (const b of v2.batches.filter((x) => x.kind === 'brief')) {
      const errors = b.labels.filter((l) => l.label === 'not_supported').length;
      const unknown = b.labels.some((l) => l.label === 'unknown');
      expect(b.brief, b.id).toBe(errors >= 2 ? 'mixed_error' : errors === 1 ? 'one_error' : unknown ? 'unresolved' : 'supported');
    }
    // v1's own labels stay as they were.
    expect(v1.batches.find((b) => b.id === 'holdout.b6')!.labels.every((l) => l.label === 'supported')).toBe(true);
  });

  it('a perfect checker displays every supported claim the static rules allow, and no error', () => {
    const d = displayReport(v3.batches.filter((b) => b.split === 'dev'), trialsOf(v3, 'dev', (b) => oracle(b)));
    // Answer retention: everything the deterministic rules leave is shown.
    expect(d.m1.rate).toBe(1);
    expect(d.m2.rate).toBe(1);
    expect(d.m3.all.k).toBe(0);
    expect(d.m4.k).toBe(0);
    expect(d.m5.violations).toBe(0);
    expect(d.e1.k).toBe(0);
    expect(d.critical.neverDisplayed).toBe(d.critical.items);
    const r = rawReport(v3.batches.filter((b) => b.split === 'dev'), trialsOf(v3, 'dev', (b) => oracle(b)), 45_000);
    expect(r.semanticDetection.all.rate).toBe(1);
    expect(r.falseFlags.k).toBe(0);
  });

  it('failed calls block output but never count as detected errors (16c review I2)', () => {
    const batches = v3.batches.filter((b) => b.split === 'dev');
    const failed = trialsOf(v3, 'dev', () => null);
    const r = rawReport(batches, failed, 45_000);
    // Nothing answered: no detection at all, and the error claims of failed calls are counted apart.
    expect(r.semanticDetection.all).toMatchObject({ k: 0, n: 0, rate: null });
    const errorsIn = (t: Trial) => batches.find((b) => b.id === t.batch)!.labels.filter((l) => l.label === 'not_supported').length;
    expect(r.failedErrorClaims).toBe(failed.reduce((n, t) => n + errorsIn(t), 0));
    expect(r.failedCalls).toEqual({ timeout: failed.length });
    // Production withholding is a separate figure, from the projection.
    expect(r.productionWithholding.whole.all.rate).toBe(1);
    expect(r.productionWithholding.claims.all.rate).toBe(1);
    const d = displayReport(batches, failed);
    expect(d.m2.k).toBe(0);
    expect(d.m3.all.k).toBe(0);
    expect(Object.keys(d.withheld.blocked)).toEqual(['check_failed:timeout']);
    expect(d.withheld.rules).toEqual({});
  });

  it('an inverted checker: no answer shown (an abstention without its gap notes is not a shown brief: 16d review m5), no error detected', () => {
    const batches = v3.batches.filter((b) => b.split === 'dev');
    const inverted = trialsOf(v3, 'dev', (b) => oracle(b, true));
    const abstentions = batches.filter((b) => b.brief === 'supported' && b.plan?.shape === 'abstention');
    expect(abstentions.length).toBeGreaterThan(0);
    expect(displayReport(batches, inverted).m2.k).toBe(0);
    expect(rawReport(batches, inverted, 45_000).semanticDetection.all.k).toBe(0);
  });

  it('the gate\'s probe (16d finding 4): a missing verdict is blocked output, never a detection or a flagged critical regression', () => {
    const b = v3.batches.find((x) => x.id === 'holdout16d.helicopter.context')!;
    const critical = b.labels.find((l) => l.critical && l.label === 'not_supported')!;
    const out = oracle(b);
    out.verdicts = out.verdicts.filter((v) => v.claim !== critical.claim);
    const t: Trial[] = [{ batch: b.id, sample: 1, output: out, latencyMs: 1, costUsd: 0 }];
    const r = rawReport([b], t, 45_000);
    expect(r.semanticDetection.all).toMatchObject({ k: 0, n: 1 });
    expect(r.blockedErrorClaims.all).toBe(1);
    expect(r.critical).toMatchObject({ items: 1, flaggedEveryTrial: 0, failures: [], blocked: [{ item: critical.item, batch: b.id, sample: 1 }] });
    // Production withheld everything: the display figures, from the projection, say so.
    const d = displayReport([b], t);
    expect(d.m3.all.k).toBe(0);
    expect(r.productionWithholding.whole.all).toMatchObject({ k: 1, n: 1 });
    // The same probe with the verdict present: an actual detection.
    expect(rawReport([b], [{ ...t[0]!, output: oracle(b) }], 45_000).critical.flaggedEveryTrial).toBe(1);
  });

  it('a missing verdict makes the output structurally unusable: the whole brief is withheld', () => {
    const b = v3.batches.find((x) => x.brief === 'supported' && x.split === 'dev')!;
    const out = oracle(b);
    out.verdicts.pop();
    const t: Trial[] = [{ batch: b.id, sample: 1, output: out, latencyMs: 1, costUsd: 0 }];
    const d = displayReport([b], t);
    expect(d.m2).toMatchObject({ k: 0, n: 1 });
    expect(d.m1.k).toBe(0);
    expect(Object.keys(d.withheld.blocked)).toEqual(['check_structural:check_missing_verdict']);
    expect(rawReport([b], t, 45_000).structuralCalls).toEqual({ check_missing_verdict: 1 });
  });

  it('reports Wilson and clustered intervals, and gates are inconclusive while an interval straddles the threshold', () => {
    expect(rate(0, 0).rate).toBeNull();
    const r = rate(2, 20);
    expect(r.rate).toBeCloseTo(0.1);
    expect(r.low).toBeCloseTo(0.0279, 3);
    expect(r.high).toBeCloseTo(0.301, 3);
    // About 73 independent zero-miss trials put the upper bound under 5% (HELDOUT_V2); 12 leave it near 24%.
    expect(rate(0, HELDOUT_V2.independentTrialsFor5pct).high).toBeLessThan(0.05);
    expect(rate(0, 72).high).toBeGreaterThan(0.05);
    expect(rate(0, 12).high).toBeCloseTo(0.2425, 3);
    // Many trials from few bundles: the clustered interval is no narrower than one observation per bundle.
    const units = Array.from({ length: 60 }, (_, i) => ({ cluster: `b${i % 4}`, k: 0, n: 1 }));
    const c = clusteredRate(units);
    expect(c).toMatchObject({ k: 0, n: 60, clusters: 4, clusterLow: 0 });
    expect(c.clusterHigh!).toBeCloseTo(rate(0, 4).high!, 6);
    expect(c.high!).toBeLessThan(c.clusterHigh!);
    expect(gateOf(c, 0.05, 'at_most')).toBe('inconclusive');
    expect(gateOf(clusteredRate(Array.from({ length: 100 }, (_, i) => ({ cluster: `b${i}`, k: 0, n: 1 }))), 0.05, 'at_most')).toBe('pass');
    expect(gateOf(clusteredRate(Array.from({ length: 100 }, (_, i) => ({ cluster: `b${i}`, k: 1, n: 1 }))), 0.05, 'at_most')).toBe('fail');
    // Deterministic.
    expect(clusteredRate(units)).toEqual(c);
  });
});

describe('run manifests (16d reply §6 High 2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'checker-manifest-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const slots = plannedSlots(v2, 'dev').slice(0, 3);
  const identity = (over: Partial<RunIdentity> = {}): RunIdentity => ({
    protocol: PROTOCOL_V2,
    candidate: 'haiku-think-v7',
    split: 'dev',
    model: 'claude-haiku-5-5',
    thinking: 'adaptive',
    effort: 'low',
    prompt: { version: 'check.v7', systemSha256: 'a'.repeat(64) },
    outputSchema: { version: 'check-output-v2', sha256: 'b'.repeat(64) },
    caps: { input: 40_000, output: 24_500 },
    timeoutMs: 45_000,
    maxClaims: 60,
    dataset: { version: 'checker-cal-v2', fileSha256: 'c'.repeat(64), evidenceSha256: 'd'.repeat(64), evidenceV2Sha256: 'e'.repeat(64), labelsSha256: 'f'.repeat(64) },
    inputsSha256: inputsSha256(v2.batches, slots),
    slots,
    ...over,
  });

  it('binds every part of the run into its id', () => {
    const base = manifestId(identity());
    expect(manifestId(identity())).toBe(base);
    for (const over of [
      { prompt: { version: 'check.v7', systemSha256: '0'.repeat(64) } },
      { caps: { input: 40_000, output: 24_000 } },
      { timeoutMs: 120_000 },
      { thinking: 'off' as const },
      { inputsSha256: '1'.repeat(64) },
      { dataset: { ...identity().dataset, labelsSha256: '2'.repeat(64) } },
    ]) {
      expect(manifestId(identity(over))).not.toBe(base);
      expect(identityDifferences(identity(), identity(over)).length).toBe(1);
    }
    // Any change to a planned input changes the inputs hash.
    const changed = structuredClone(v2.batches);
    changed.find((b) => b.id === slots[0]!.batch)!.input.claims[0]!.text += ' (changed)';
    expect(inputsSha256(changed, slots)).not.toBe(inputsSha256(v2.batches, slots));
  });

  it('resume needs the manifest and its trials file, and continues only the slots it planned and has not run', () => {
    const m = newManifest(identity());
    const path = join(tmp, 'm.manifest.json');
    writeFileSync(path, JSON.stringify(m));
    expect(readManifest(path).id).toBe(m.id);
    expect(() => readManifest(join(tmp, 'missing.manifest.json'))).toThrow(/no manifest/);
    // A manifest edited by hand no longer hashes to its id.
    writeFileSync(join(tmp, 'edited.manifest.json'), JSON.stringify({ ...m, timeoutMs: 1 }));
    expect(() => readManifest(join(tmp, 'edited.manifest.json'))).toThrow(/does not hash/);
    const trials = join(tmp, 'm.jsonl');
    expect(() => resumeState(m, trials)).toThrow(/no trials file/);
    const row = (s: { batch: string; sample: number }, manifest = m.id) => JSON.stringify({ batch: s.batch, sample: s.sample, output: null, latencyMs: 1, costUsd: 0, manifest });
    writeFileSync(trials, `${row(slots[0]!)}\n`);
    expect(resumeState(m, trials)).toMatchObject({ done: [{ batch: slots[0]!.batch }], todo: slots.slice(1) });
    writeFileSync(trials, `${row(slots[0]!, 'other')}\n`);
    expect(() => resumeState(m, trials)).toThrow(/another manifest/);
    writeFileSync(trials, `${row({ batch: 'nope', sample: 9 })}\n`);
    expect(() => resumeState(m, trials)).toThrow(/unplanned/);
    writeFileSync(trials, `${row(slots[0]!)}\n${row(slots[0]!)}\n`);
    expect(() => resumeState(m, trials)).toThrow(/twice/);
  });

  it('plans three trials of a brief without a known error, two of a maximum-size input, one of anything else', () => {
    const slotsAll = plannedSlots(v2, 'dev');
    for (const b of v2.batches.filter((x) => x.split === 'dev')) {
      const n = slotsAll.filter((s) => s.batch === b.id).length;
      expect(n, b.id).toBe(b.maxSize ? 2 : b.kind === 'brief' && (b.brief === 'supported' || b.brief === 'unresolved') ? 3 : 1);
    }
    // The held-out pilot runs in the pre-registered order: briefs without a known error, error briefs, claim batches.
    const rank = (id: string) => {
      const b = v2.batches.find((x) => x.id === id)!;
      return b.kind === 'claims' ? 2 : b.brief === 'supported' || b.brief === 'unresolved' ? 0 : 1;
    };
    const held = plannedSlots(v2, 'holdout').map((s) => rank(s.batch));
    expect(held.length).toBeGreaterThan(0);
    expect(held).toEqual([...held].sort((a, b) => a - b));
    expect(new Set(held)).toEqual(new Set([0, 1, 2]));
    // The maximum-size inputs are at the claim limit, with real bundles' passages.
    const max = v2.batches.filter((b) => b.maxSize);
    expect(max.map((b) => b.input.claims.length)).toEqual([60, 60, 60]);
    for (const b of max) expect(b.input.passages.length).toBeGreaterThanOrEqual(8);
  });

  it('keeps the maximum-size inputs out of the accuracy figures (their claims are their sources\' claims)', () => {
    const batches = withPlans(v2.batches.filter((b) => b.split === 'dev'));
    const f = runFigures(batches, trialsOf(v2, 'dev', (b) => oracle(b)), 45_000);
    expect(f.maxSize.calls).toBe(6);
    expect(f.display.trials.claims).toBe(batches.filter((b) => b.kind === 'claims' && !b.maxSize).length);
    expect(f.latency.calls).toBe(plannedSlots(v2, 'dev').length);
  });
});

describe('protocol v2: frozen candidates, selection and production', () => {
  const run = (candidate: string, m1: number, m2: number, family: number, criticalOk: boolean): DevRunV2 => {
    const d = displayReport(v3.batches.filter((b) => b.split === 'dev'), trialsOf(v3, 'dev', (b) => oracle(b)));
    const r = rawReport(v3.batches.filter((b) => b.split === 'dev'), trialsOf(v3, 'dev', (b) => oracle(b)), 45_000);
    return {
      protocol: PROTOCOL_V2,
      candidate,
      split: 'dev',
      complete: true,
      manifest: 'm',
      raw: r,
      display: {
        ...d,
        m1: { ...d.m1, rate: m1 },
        m2: { ...d.m2, rate: m2 },
        m3: { ...d.m3, timing: { ...d.m3.timing, rate: family } },
        critical: { ...d.critical, neverDisplayed: criticalOk ? d.critical.items : d.critical.items - 1 },
      },
    };
  };

  it('selects by the frozen rule', () => {
    // Eligible: the highest M2 wins; then M1.
    expect(selectV2([run('haiku-think-v7', 0.95, 0.92, 0, true), run('haiku-think-v8', 0.93, 0.95, 0, true)]).candidate).toBe('haiku-think-v8');
    expect(selectV2([run('haiku-think-v7', 0.95, 0.95, 0, true), run('haiku-think-v8', 0.93, 0.95, 0, true)]).candidate).toBe('haiku-think-v7');
    // A critical regression displayed, or a family over 5%, is not eligible.
    expect(selectV2([run('haiku-think-v7', 0.95, 0.95, 0, false), run('haiku-think-v8', 0.91, 0.91, 0, true)]).candidate).toBe('haiku-think-v8');
    const none = selectV2([run('haiku-think-v7', 0.8, 0.7, 0.06, true), run('haiku-think-v8', 0.85, 0.8, 0.1, true)]);
    expect(none).toMatchObject({ candidate: 'haiku-think-v7', eligible: [] });
    expect(none.reason).toContain('missing M3');
    // Only frozen candidates and complete development runs count.
    expect(() => selectV2([{ ...run('haiku-think-v7', 1, 1, 0, true), complete: false }])).toThrow(/no complete/);
    expect(() => selectV2([run('sonnet', 1, 1, 0, true)])).toThrow(/no complete/);
  });

  it('the 16d candidate set stays the record: complete configurations, none of them production since check.v9', () => {
    for (const c of Object.values(CANDIDATES_V2)) {
      expect(c).toMatchObject({ model: 'claude-haiku-5-5', thinking: 'adaptive', effort: 'low', caps: { input: 40_000, output: 24_500 }, timeoutMs: 45_000, maxClaims: 60 });
      expect(c.outputSchema.version).toBe('check-output-v2');
    }
    // Task 16e moved production to check.v9 (protocol v3); the 16d candidates are the record.
    expect(Object.keys(CANDIDATES_V2).filter((name) => candidateMismatch(name).length === 0)).toEqual([]);
    expect(STAGE_THINKING.check).toBe('adaptive');
    expect(loadConfig({ env: {}, files: [] }).ai.anthropic.checkModel).toBe('claude-haiku-5-5');
  });

  it('the 16d selection stays the record', () => {
    if (!existsSync(SELECTION_V2_PATH)) return;
    const sel = JSON.parse(readFileSync(SELECTION_V2_PATH, 'utf8')) as SelectionV2;
    expect(sel).toMatchObject({ protocol: PROTOCOL_V2, candidate: 'haiku-think-v8' });
  });

  it('keeps the 16c selection code as the record (applied across prompt versions after the runs: a procedural deviation)', () => {
    const summary = (config: string, fw: number, family: number, critical: boolean, checkPrompt: string) => ({
      config,
      model: 'm',
      thinking: 'off',
      split: 'dev',
      checkPrompt,
      labelsSha256: v1.labels.sha256,
      complete: true,
      report: {
        wholeBriefFalseWithholding: { rate: fw, n: 21, k: Math.round(fw * 21) },
        detection: { timing: { rate: family }, attribution: { rate: 1 }, contradiction: { rate: 1 }, unsupported_addition: { rate: 1 } },
        critical: { items: 8, passedEveryTrial: critical ? 8 : 6 },
        cost: { perBriefUsd: 0.002 },
        latencyMs: { p95: 20_000 },
      },
    });
    expect(selectConfiguration([summary('haiku-think', 7 / 21, 1, true, 'check.v5'), summary('haiku-think', 6 / 21, 0.87, false, 'check.v6')])).toMatchObject({
      config: 'haiku-think',
      checkPrompt: 'check.v5',
    });
  });
});

describe('protocol v3 (Task 16e): frozen candidates, rules, money, selection and production', () => {
  const v3Text = readFileSync(resolve(DIR, 'dataset.v3.json'), 'utf8');
  const trialsV3 = (split: 'dev' | 'holdout', answer: (b: CalibrationBatch) => CheckOutput | null, latencyMs = 1_000): Trial[] =>
    plannedSlotsV3(v3, split).map((s) => {
      const b = v3.batches.find((x) => x.id === s.batch)!;
      const output = answer(b);
      return { batch: s.batch, sample: s.sample, output, ...(output ? {} : { failure: 'timeout' }), latencyMs, costUsd: 0.001 };
    });
  const run = (candidate: string, over: { m1?: number; m2?: number; family?: number; m4?: number; criticalOk?: boolean }): DevRunV3 => {
    const f = runFiguresV3(v3.batches.filter((b) => b.split === 'dev'), trialsV3('dev', (b) => oracle(b)), 45_000);
    const d = f.display;
    return {
      protocol: PROTOCOL_V3,
      candidate,
      split: 'dev',
      complete: true,
      manifest: 'm',
      raw: f.raw,
      display: {
        ...d,
        m1: { ...d.m1, rate: over.m1 ?? 0.95 },
        m2: { ...d.m2, rate: over.m2 ?? 0.95 },
        m3: { ...d.m3, timing: { ...d.m3.timing, rate: over.family ?? 0 } },
        m4: { ...d.m4, rate: over.m4 ?? 0 },
        critical: { ...d.critical, neverDisplayed: over.criticalOk === false ? d.critical.items - 1 : d.critical.items },
      },
    };
  };

  it('two complete candidates, the same prompt at effort low and medium; the code is each as frozen', () => {
    expect(ROUNDS_V3).toEqual(['haiku-think-v9-low', 'haiku-think-v9-medium']);
    for (const name of ROUNDS_V3) {
      const c = CANDIDATES_V3[name]!;
      expect(c).toMatchObject({ model: 'claude-haiku-5-5', thinking: 'adaptive', caps: { input: 40_000, output: 24_500 }, timeoutMs: 45_000, maxClaims: 60, prompt: { version: 'check.v9' } });
      expect(c.measureTimeoutMs).toBeGreaterThan(c.timeoutMs);
      expect(candidateMismatchV3(name)).toEqual([]);
    }
    expect(CANDIDATES_V3['haiku-think-v9-low']!.effort).toBe('low');
    expect(CANDIDATES_V3['haiku-think-v9-medium']!.effort).toBe('medium');
    expect(codeRules()).toEqual(FROZEN_RULES);
    expect(protocolV3Sha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('production runs the frozen selection once there is one, and the low-effort candidate before', () => {
    const sel = existsSync(SELECTION_V3_PATH) ? (JSON.parse(readFileSync(SELECTION_V3_PATH, 'utf8')) as SelectionV3) : null;
    if (sel) {
      expect(sel.protocol).toBe(PROTOCOL_V3);
      expect(productionMismatchV3(sel.candidate, sel.timeoutMs)).toEqual([]);
    } else {
      expect(productionMismatchV3('haiku-think-v9-low', STAGE_TIMEOUTS.check)).toEqual([]);
    }
  });

  it('samples and orders the slots as pre-registered; both candidates on the same development slots', () => {
    const dev = plannedSlotsV3(v3, 'dev');
    const batches = v3.batches.filter((b) => b.split === 'dev');
    const wo = batches.filter((b) => !b.maxSize && b.kind === 'brief' && (b.brief === 'supported' || b.brief === 'unresolved')).length;
    const max = batches.filter((b) => b.maxSize).length;
    expect(dev.length).toBe(wo * SAMPLES_V3.dev.briefWithoutError + max * SAMPLES_V3.dev.maxSize + (batches.length - wo - max) * SAMPLES_V3.dev.other);
    const low = identityForV3('haiku-think-v9-low', 'dev', v3, v3Text);
    const medium = identityForV3('haiku-think-v9-medium', 'dev', v3, v3Text);
    expect(low.slots).toEqual(medium.slots);
    expect(low.inputsSha256).toBe(medium.inputsSha256);
    expect(identityDifferences(low, medium).sort()).toEqual(['candidate', 'effort']);
    expect(low).toMatchObject({ protocol: PROTOCOL_V3, allocation: BUDGET_V3.allocation, measureTimeoutMs: 90_000, timeoutMs: 45_000, rules: FROZEN_RULES, protocolSha256: protocolV3Sha256() });
  });

  it('counts a call over the production timeout as a timeout in every figure, and keeps its latency', () => {
    const batches = v3.batches.filter((b) => b.split === 'dev');
    const slow = trialsV3('dev', (b) => oracle(b), 50_000);
    const f = runFiguresV3(batches, slow, 45_000);
    expect(f.raw.failedCalls.timeout).toBe(slow.filter((t) => !batches.find((b) => b.id === t.batch)!.maxSize).length);
    expect(f.display.m2.k).toBe(0);
    expect(f.latency).toMatchObject({ max: 50_000, overTimeout: slow.length });
    const fast = runFiguresV3(batches, trialsV3('dev', (b) => oracle(b)), 45_000);
    expect(fast.raw.failedCalls.timeout ?? 0).toBe(0);
  });

  it('selects by the frozen rule, M4 included in the eligibility', () => {
    expect(TARGETS_V3.m4).toEqual({ threshold: 0.05, direction: 'at_most' });
    // Eligible: the highest M2, then M1; a tie goes to effort low.
    expect(selectV3([run('haiku-think-v9-low', { m2: 0.92 }), run('haiku-think-v9-medium', { m2: 0.95 })]).candidate).toBe('haiku-think-v9-medium');
    expect(selectV3([run('haiku-think-v9-low', {}), run('haiku-think-v9-medium', {})]).candidate).toBe('haiku-think-v9-low');
    // An error brief shown with its error (M4 over 5%) is not eligible.
    const m4 = selectV3([run('haiku-think-v9-low', { m4: 0.06 }), run('haiku-think-v9-medium', { m2: 0.91 })]);
    expect(m4).toMatchObject({ candidate: 'haiku-think-v9-medium', eligible: ['haiku-think-v9-medium'] });
    // None eligible: critical first, then M4.
    const none = selectV3([run('haiku-think-v9-low', { m1: 0.5, m4: 0.1 }), run('haiku-think-v9-medium', { m1: 0.5, m4: 0.02 })]);
    expect(none).toMatchObject({ candidate: 'haiku-think-v9-medium', eligible: [] });
    expect(none.reason).toContain('M1 ≥ 90%');
    expect(selectV3([run('haiku-think-v9-low', { m1: 0.5, criticalOk: false }), run('haiku-think-v9-medium', { m1: 0.5, m4: 0.5 })]).candidate).toBe('haiku-think-v9-medium');
    expect(() => selectV3([{ ...run('haiku-think-v9-low', {}), complete: false }])).toThrow(/no complete/);
    expect(() => selectV3([{ ...run('haiku-think-v9-low', {}), protocol: PROTOCOL_V2 }])).toThrow(/no complete/);
  });

  it('derives the production timeout from the measured latency, within the step deadline', () => {
    expect(derivedTimeoutMs([10_000, 20_000])).toBe(30_000);
    expect(derivedTimeoutMs([10_000, 30_000])).toBe(40_000);
    expect(derivedTimeoutMs([39_400])).toBe(45_000);
    expect(derivedTimeoutMs([80_000])).toBe(45_000);
    expect(derivedTimeoutMs([])).toBe(45_000);
  });

  it('refuses a reservation over the allocation or into the amount protected for Track N', () => {
    expect(BUDGET_V3).toMatchObject({ allocation: 'checker-16e-2026-10', limitUsd: 2.5, protectedUsd: 12, protectedFor: 'track-n-2026-10' });
    expect(reservationRefusal({ spentUsd: 1, inFlightUsd: 0.02, reserveUsd: 0.015, ledgerRemainingUsd: 16 })).toBeNull();
    expect(reservationRefusal({ spentUsd: 2.49, inFlightUsd: 0, reserveUsd: 0.015, ledgerRemainingUsd: 16 })).toMatch(/over its \$2.5 limit/);
    expect(reservationRefusal({ spentUsd: 2.47, inFlightUsd: 0.02, reserveUsd: 0.015, ledgerRemainingUsd: 16 })).toMatch(/limit/);
    expect(reservationRefusal({ spentUsd: 0, inFlightUsd: 0, reserveUsd: 0.015, ledgerRemainingUsd: 12.01 })).toMatch(/protected for track-n-2026-10/);
  });

  it('pre-registers the held-out rules: new retrieval.v2 bundles, run once, an inconclusive pilot', () => {
    expect(HELDOUT_V3).toMatchObject({ bundles: 9, retrievalVersion: 'retrieval.v2', runs: 1, cluster: 'bundle', independentTrialsFor5pct: 73, minimumBundlesPerTimingMutation: 2 });
    expect(HELDOUT_V3.criticalTimingMutations).toEqual(HELDOUT_V2.criticalTimingMutations);
    const held = plannedSlotsV3(v3, 'holdout').map((s) => v3.batches.find((b) => b.id === s.batch)!);
    const rank = (b: CalibrationBatch) => (b.kind === 'claims' ? 2 : b.brief === 'supported' || b.brief === 'unresolved' ? 0 : 1);
    for (let i = 1; i < held.length; i += 1) expect(rank(held[i - 1]!)).toBeLessThanOrEqual(rank(held[i]!));
  });
});
