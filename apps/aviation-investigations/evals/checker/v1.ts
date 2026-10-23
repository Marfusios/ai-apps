/**
 * Task 16c's run plan and selection code (protocol `checker-cal-protocol-v1`), kept as the
 * record. The selection code below is the version 530da00 wrote after every 16c
 * development run had finished; the code frozen with the protocol in 6e06f1e admitted only
 * runs of the current prompt version and would have chosen haiku-think with check.v6. The
 * gate recorded the rewrite as a procedural deviation (16c review I1); Task 16d freezes its
 * candidates and selection code before any paid run (`protocol.v2.ts`).
 */
import type { CalibrationBatch, CalibrationDataset } from './build.js';
import { SUPPORTED_SAMPLES } from './protocol.js';

/** The 16c figures the v1 selection read (its summaries' `report`). */
export interface V1Report {
  wholeBriefFalseWithholding: { rate: number | null; n: number; k: number };
  detection: Record<'timing' | 'attribution' | 'contradiction' | 'unsupported_addition', { rate: number | null }>;
  critical: { items: number; passedEveryTrial: number };
  cost: { perBriefUsd: number | null };
  latencyMs: { p95: number | null };
}

/** The planned trials of a v1 split: each claim batch and error brief once, each supported brief `SUPPORTED_SAMPLES` times. */
export function plannedTrials(dataset: CalibrationDataset, split: 'dev' | 'holdout'): { batch: CalibrationBatch; sample: number }[] {
  return dataset.batches
    .filter((b) => b.split === split)
    .flatMap((b) => Array.from({ length: b.brief === 'supported' ? SUPPORTED_SAMPLES : 1 }, (_, i) => ({ batch: b, sample: i + 1 })));
}

/** The figures the selection rule reads from a development run's summary. */
interface DevSummary {
  config: string;
  model: string;
  thinking: string;
  split: string;
  checkPrompt: string;
  labelsSha256: string;
  complete: boolean;
  report: V1Report;
}

/**
 * Apply the selection rule (protocol.ts) to complete development runs: one per
 * configuration and check prompt version (the tuning rounds' runs included), all on the
 * frozen labels. The choice is a configuration with its prompt version.
 */
export function selectConfiguration(runs: readonly DevSummary[]): { config: string; checkPrompt: string; reason: string; eligible: string[] } {
  const ok = runs.filter((r) => r.split === 'dev' && r.complete);
  if (ok.length === 0) throw new Error('no complete development run');
  const name = (r: DevSummary) => `${r.config} with ${r.checkPrompt}`;
  const families = (r: DevSummary) => (['timing', 'attribution', 'contradiction', 'unsupported_addition'] as const).map((f) => r.report.detection[f].rate ?? 0);
  const fw = (r: DevSummary) => r.report.wholeBriefFalseWithholding.rate ?? 1;
  const criticalOk = (r: DevSummary) => r.report.critical.passedEveryTrial === r.report.critical.items;
  const eligible = ok.filter((r) => criticalOk(r) && Math.min(...families(r)) >= 0.95 && fw(r) <= 0.1);
  if (eligible.length > 0) {
    const best = Math.min(...eligible.map(fw));
    const n = eligible[0]!.report.wholeBriefFalseWithholding.n;
    const near = eligible.filter((r) => fw(r) <= best + 1 / Math.max(1, n) + 1e-9);
    near.sort((a, b) => (a.report.cost.perBriefUsd ?? 0) - (b.report.cost.perBriefUsd ?? 0) || (a.report.latencyMs.p95 ?? 0) - (b.report.latencyMs.p95 ?? 0));
    const pick = near[0]!;
    return {
      config: pick.config,
      checkPrompt: pick.checkPrompt,
      eligible: eligible.map(name),
      reason: `eligible: ${eligible.map(name).join(', ')}; lowest whole-brief false withholding ${(100 * best).toFixed(1)}%${near.length > 1 ? `; within one trial of it: ${near.map(name).join(', ')}, the cheapest per brief` : ''}`,
    };
  }
  const ranked = [...ok].sort(
    (a, b) =>
      b.report.critical.passedEveryTrial - a.report.critical.passedEveryTrial ||
      Math.min(...families(b)) - Math.min(...families(a)) ||
      fw(a) - fw(b),
  );
  const pick = ranked[0]!;
  const missed = [
    ...(criticalOk(pick) ? [] : ['critical regressions']),
    ...(Math.min(...families(pick)) >= 0.95 ? [] : ['family detection ≥ 95%']),
    ...(fw(pick) <= 0.1 ? [] : ['whole-brief false withholding ≤ 10%']),
  ];
  const r = pick.report;
  return {
    config: pick.config,
    checkPrompt: pick.checkPrompt,
    eligible: [],
    reason:
      `no run eligible (${ok.length} development runs); by the fallback order (critical regressions withheld in every trial, then the lowest family detection, then whole-brief false withholding): ` +
      `${name(pick)}, critical ${r.critical.passedEveryTrial}/${r.critical.items}, lowest family ${(100 * Math.min(...families(pick))).toFixed(1)}%, ` +
      `whole-brief false withholding ${r.wholeBriefFalseWithholding.k}/${r.wholeBriefFalseWithholding.n}; missing ${missed.join(', ') || 'nothing'}`,
  };
}

