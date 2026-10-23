/**
 * `pnpm eval:checker inventory|run`: the checker calibration's provider calls (Task 16c).
 *
 * `inventory` is free: it counts every planned call's input with the provider's own
 * counter (`messages.countTokens`) and prints the plan (calls, tokens, expected and
 * worst-case cost per configuration). Nothing is generated.
 *
 * `run` sends the check stage exactly as production does (the Anthropic adapter, the
 * current check prompt and schema, effort `low`, the configuration's model and thinking),
 * only with `--confirm-cost`. Every attempt reserves its worst case on the evaluation
 * ledger (`DATABASE_INGEST_URL`, category `evaluation`) and settles with the actual cost;
 * every paid step is appended to `data/work/checker/spend.jsonl`, and a call whose
 * reservation would take the logged total above `CALIBRATION_LIMIT_USD` stops the run
 * before it is sent. Trials go to `data/work/checker/<config>-<split>-<time>.jsonl` (check
 * outputs: verdicts and quotes of public NTSB passages), the figures to a `.summary.json`
 * beside it (counts only). The held-out split runs once, for the configuration frozen in
 * `selection.json`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { CACHED_PREFIX_MAX, llmPrice, stageCostUsd } from '../../server/ai/pricing.js';
import { CHECK_PROMPT_VERSION } from '../../server/ai/prompts/check.v5.js';
import { StageError, stageCtx, type LlmProvider, type StageUsage } from '../../server/ai/provider.js';
import { STAGE_TIMEOUTS } from '../../server/briefs/pipeline.js';
import { closeDb, createDb } from '../../server/db/client.js';
import type { AppConfig } from '../../shared/config.js';
import { APP_DIR } from '../../worker/config.js';
import { createLedgerSpendGate, type SpendGate } from '../../worker/index/spend-gate.js';
import { DATASET_PATH, readDataset, type CalibrationBatch, type CalibrationDataset } from './build.js';
import { report, reportLines, type Trial } from './metrics.js';
import { CALIBRATION_LIMIT_USD, CALL_TIMEOUT_MS, CONFIGS, PROTOCOL_VERSION, SUPPORTED_SAMPLES } from './protocol.js';

const WORK_DIR = resolve(APP_DIR, 'data/work/checker');
const SPEND_LOG = resolve(WORK_DIR, 'spend.jsonl');
export const SELECTION_PATH = resolve(APP_DIR, 'evals/checker/selection.json');

export interface Selection {
  protocol: string;
  config: string;
  model: string;
  thinking: string;
  checkPrompt: string;
  labelsSha256: string;
  frozenAt: string;
  reason: string;
}

/** The planned trials of a split: each claim batch and error brief once, each supported brief `SUPPORTED_SAMPLES` times. */
export function plannedTrials(dataset: CalibrationDataset, split: 'dev' | 'holdout'): { batch: CalibrationBatch; sample: number }[] {
  return dataset.batches
    .filter((b) => b.split === split)
    .flatMap((b) => Array.from({ length: b.brief === 'supported' ? SUPPORTED_SAMPLES : 1 }, (_, i) => ({ batch: b, sample: i + 1 })));
}

/** Logged spend so far (every paid calibration step). */
export function loggedSpendUsd(path = SPEND_LOG): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => sum + (JSON.parse(line) as { usd: number }).usd, 0);
}

function providerFor(config: AppConfig, name: string): { provider: LlmProvider; model: string } {
  const c = CONFIGS[name];
  if (!c) throw new Error(`unknown configuration '${name}' (${Object.keys(CONFIGS).join(', ')})`);
  const apiKey = config.ai.anthropic.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const provider = createAnthropicProvider({ apiKey, models: { scope: c.model, answer: c.model, check: c.model }, thinking: { check: c.thinking } });
  return { provider, model: c.model };
}

const ctx = () => stageCtx('check', AbortSignal.timeout(CALL_TIMEOUT_MS), CALL_TIMEOUT_MS);

/** Worst case of one call: the counted input, the output cap, the cache-write premium on the prefix. */
function worstUsd(model: string, inputTokens: number): number {
  const p = llmPrice(model);
  const cap = ctx().maxOutputTokens;
  return (inputTokens * p.input + cap * p.output + Math.min(CACHED_PREFIX_MAX, inputTokens) * Math.max(0, p.cacheWrite - p.input)) / 1e6;
}

/** A rough expectation of one call: the input, ~30 output tokens a verdict, and the thinking room for adaptive thinking. */
function expectedUsd(model: string, inputTokens: number, claims: number, adaptive: boolean): number {
  const p = llmPrice(model);
  const out = 150 + 30 * claims + (adaptive ? 2_000 : 0);
  return (inputTokens * p.input + out * p.output) / 1e6;
}

export async function inventoryCommand(config: AppConfig, opts: { configs: string[]; split: 'dev' | 'holdout'; log: (m: string) => void }): Promise<number> {
  const dataset = readDataset();
  const trials = plannedTrials(dataset, opts.split);
  const batches = [...new Set(trials.map((t) => t.batch))];
  opts.log(
    `${opts.split}: ${batches.length} batches, ${trials.length} trials (${dataset.batches.filter((b) => b.split === opts.split).reduce((n, b) => n + b.input.claims.length, 0)} claims per pass); logged spend so far $${loggedSpendUsd().toFixed(6)} of $${CALIBRATION_LIMIT_USD}`,
  );
  for (const name of opts.configs) {
    const { provider, model } = providerFor(config, name);
    const counts = new Map<string, number>();
    for (const b of batches) counts.set(b.id, await provider.countInputTokens('check', b.input, ctx()));
    const adaptive = CONFIGS[name]!.thinking === 'adaptive';
    let expected = 0;
    let worst = 0;
    let tokens = 0;
    for (const t of trials) {
      const n = counts.get(t.batch.id)!;
      tokens += n;
      expected += expectedUsd(model, n, t.batch.input.claims.length, adaptive);
      worst += worstUsd(model, n);
    }
    const max = Math.max(...counts.values());
    opts.log(
      `${name} (${model}, thinking ${CONFIGS[name]!.thinking}): ${trials.length} calls, ${tokens} input tokens (largest call ${max}); expected about $${expected.toFixed(4)}, worst case $${worst.toFixed(4)}`,
    );
  }
  opts.log('nothing generated: `run --confirm-cost` sends the calls');
  return 0;
}

const usageOf = (u: StageUsage) => ({
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
  cacheWriteTokens: u.cacheWriteTokens,
  cacheReadTokens: u.cacheReadTokens,
  ...(u.thinkingTokens !== undefined ? { thinkingTokens: u.thinkingTokens } : {}),
});

export async function runCommand(
  config: AppConfig,
  opts: { config: string; split: 'dev' | 'holdout'; samples: number; confirmCost: boolean; log: (m: string) => void },
): Promise<number> {
  const dataset = readDataset();
  if (opts.split === 'holdout') {
    if (!existsSync(SELECTION_PATH)) throw new Error('the held-out split runs only for the configuration frozen in selection.json');
    const sel = JSON.parse(readFileSync(SELECTION_PATH, 'utf8')) as Selection;
    if (sel.config !== opts.config || sel.checkPrompt !== CHECK_PROMPT_VERSION || sel.labelsSha256 !== dataset.labels.sha256) {
      throw new Error('selection.json names another configuration, prompt version or label set');
    }
    if (existsSync(SPEND_LOG) && readFileSync(SPEND_LOG, 'utf8').includes('"split":"holdout"')) throw new Error('the held-out split has already run once');
  }
  const trials = plannedTrials(dataset, opts.split).filter((t) => t.batch.brief !== 'supported' || t.sample <= opts.samples);
  if (!opts.confirmCost) {
    opts.log(`${trials.length} calls planned for ${opts.config} on ${opts.split}; nothing sent (run inventory first, then --confirm-cost)`);
    return 0;
  }
  if (!config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
  const { provider, model } = providerFor(config, opts.config);
  const ingest = createDb(config.databaseIngestUrl, { max: 2, applicationName: 'aviation-eval-checker-ledger' });
  const gate: SpendGate = createLedgerSpendGate(ingest, { budgets: config.ai.budgets, provider: 'anthropic', model, stage: 'check' });
  mkdirSync(WORK_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(WORK_DIR, `${opts.config}-${opts.split}-${stamp}.jsonl`);
  const done: Trial[] = [];
  let stopped: string | null = null;
  try {
    for (const t of trials) {
      const counted = await provider.countInputTokens('check', t.batch.input, ctx());
      const reserveUsd = worstUsd(model, counted);
      const spent = loggedSpendUsd();
      if (spent + reserveUsd > CALIBRATION_LIMIT_USD) {
        stopped = `the next call's reservation ($${reserveUsd.toFixed(4)}) would take the logged spend ($${spent.toFixed(4)}) above $${CALIBRATION_LIMIT_USD}`;
        break;
      }
      const purpose = `eval-checker-${opts.config}-${opts.split}-${t.batch.id}-${t.sample}`;
      const reservation = await gate.reserve({ category: 'evaluation', usd: reserveUsd, purpose });
      const t0 = performance.now();
      let trial: Trial;
      let settled: number;
      try {
        const r = await provider.check(t.batch.input, ctx());
        const costUsd = stageCostUsd(model, r.usage);
        await gate.settle(reservation, { usd: costUsd, tokens: r.usage.inputTokens + r.usage.outputTokens });
        settled = costUsd;
        trial = { batch: t.batch.id, sample: t.sample, output: r.output, stopReason: r.stopReason, latencyMs: Math.round(performance.now() - t0), costUsd, usage: usageOf(r.usage) };
      } catch (err) {
        if (!(err instanceof StageError)) {
          await gate.settle(reservation, 'uncertain');
          throw err;
        }
        const billing = err.billing;
        const costUsd = billing.kind === 'usage' ? stageCostUsd(model, billing.usage) : billing.kind === 'none' ? 0 : reserveUsd;
        await gate.settle(reservation, billing.kind === 'uncertain' ? 'uncertain' : { usd: costUsd });
        settled = costUsd;
        trial = {
          batch: t.batch.id,
          sample: t.sample,
          output: null,
          failure: err.category,
          stopReason: err.stopReason,
          latencyMs: Math.round(performance.now() - t0),
          costUsd,
          ...(billing.kind === 'usage' ? { usage: usageOf(billing.usage) } : {}),
        };
      }
      appendFileSync(SPEND_LOG, `${JSON.stringify({ at: new Date().toISOString(), config: opts.config, split: opts.split, batch: t.batch.id, sample: t.sample, model, usd: settled })}\n`);
      appendFileSync(out, `${JSON.stringify(trial)}\n`);
      done.push(trial);
      const judged = trial.output ? `${trial.output.verdicts.length} verdicts` : `failed (${trial.failure})`;
      opts.log(`${t.batch.id}#${t.sample}: ${judged}, ${trial.latencyMs} ms, $${trial.costUsd.toFixed(5)}`);
    }
  } finally {
    await closeDb(ingest);
  }
  const r = report(dataset.batches, done, STAGE_TIMEOUTS.check);
  const summary = {
    protocol: PROTOCOL_VERSION,
    config: opts.config,
    ...CONFIGS[opts.config],
    split: opts.split,
    checkPrompt: CHECK_PROMPT_VERSION,
    labelsSha256: dataset.labels.sha256,
    dataset: DATASET_PATH.slice(APP_DIR.length + 1),
    trials: out.slice(APP_DIR.length + 1),
    complete: stopped === null && done.length === trials.length,
    ...(stopped ? { stopped } : {}),
    report: r,
  };
  writeFileSync(out.replace(/\.jsonl$/, '.summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const line of reportLines(`${opts.config} ${opts.split}`, r)) opts.log(line);
  if (stopped) opts.log(`stopped: ${stopped}`);
  opts.log(`logged spend now $${loggedSpendUsd().toFixed(6)}; trials ${out}`);
  return stopped ? 1 : 0;
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
  report: ReturnType<typeof report>;
}

/**
 * Apply the selection rule (protocol.ts) to complete development runs, one per
 * configuration, all with the current prompt version and labels.
 */
export function selectConfiguration(runs: readonly DevSummary[]): { config: string; reason: string; eligible: string[] } {
  const ok = runs.filter((r) => r.split === 'dev' && r.complete);
  if (ok.length === 0) throw new Error('no complete development run');
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
      eligible: eligible.map((r) => r.config),
      reason: `eligible: ${eligible.map((r) => r.config).join(', ')}; lowest whole-brief false withholding ${(100 * best).toFixed(1)}%${near.length > 1 ? `; within one trial of it: ${near.map((r) => r.config).join(', ')}, the cheapest per brief` : ''}`,
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
  return { config: pick.config, eligible: [], reason: `no configuration eligible; by the fallback order: ${pick.config}, missing ${missed.join(', ')}` };
}

export function selectCommand(files: readonly string[], log: (m: string) => void): number {
  const dataset = readDataset();
  const runs = files.map((f) => JSON.parse(readFileSync(resolve(f), 'utf8')) as DevSummary);
  for (const r of runs) {
    if (r.checkPrompt !== CHECK_PROMPT_VERSION || r.labelsSha256 !== dataset.labels.sha256) throw new Error(`${r.config}: another prompt version or label set`);
  }
  if (new Set(runs.map((r) => r.config)).size !== runs.length) throw new Error('one development run per configuration');
  const choice = selectConfiguration(runs);
  const c = CONFIGS[choice.config]!;
  const selection: Selection = {
    protocol: PROTOCOL_VERSION,
    config: choice.config,
    model: c.model,
    thinking: c.thinking,
    checkPrompt: CHECK_PROMPT_VERSION,
    labelsSha256: dataset.labels.sha256,
    frozenAt: new Date().toISOString(),
    reason: choice.reason,
  };
  writeFileSync(SELECTION_PATH, `${JSON.stringify(selection, null, 2)}\n`);
  log(`selected ${choice.config}: ${choice.reason}`);
  log(`wrote ${SELECTION_PATH}`);
  return 0;
}
