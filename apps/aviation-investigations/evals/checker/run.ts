/**
 * `pnpm eval:checker inventory|run|select`: the checker calibration's provider calls
 * (Task 16d, protocol v2, `protocol.v2.ts`).
 *
 * `inventory` is free: it counts every planned call's input with the provider's own
 * counter (`messages.countTokens`) and prints the plan (calls, tokens, expected and
 * worst-case cost) against what is left of the 16d limit. Nothing is generated.
 *
 * `run` sends the check stage exactly as production does: the Anthropic adapter, the
 * production check prompt and output schema, effort `low`, the candidate's model and
 * thinking, the production caps (`STAGE_CAPS.check`) and the production check timeout
 * (gate condition 4: calibrate what will actually run), only with `--confirm-cost` and only
 * when the code is the candidate as frozen (`candidateMismatch`). Each run has an immutable
 * manifest (`manifest.ts`); every trial row carries its id, and `--resume <manifest>`
 * continues only that manifest's missing slots, refusing any change to the code, the
 * prompt, the schema, the caps, the dataset or the inputs. Every attempt reserves its
 * worst case on the evaluation ledger (`DATABASE_INGEST_URL`, category `evaluation`) and
 * settles with the actual cost; every paid step is appended to
 * `data/work/checker/spend-16d.jsonl`, and a call whose reservation would take the logged
 * total above `BUDGET_V2_USD` stops the run before it is sent. The held-out split runs
 * once (one manifest, ever), for the candidate frozen in `selection.v2.json`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { CACHED_PREFIX_MAX, llmPrice, stageCostUsd } from '../../server/ai/pricing.js';
import { StageError, stageCtx, type LlmProvider, type StageUsage } from '../../server/ai/provider.js';
import { closeDb, createDb } from '../../server/db/client.js';
import type { AppConfig } from '../../shared/config.js';
import { APP_DIR } from '../../worker/config.js';
import { createLedgerSpendGate, type SpendGate } from '../../worker/index/spend-gate.js';
import { DATASET_V2_PATH, readDatasetV2, type CalibrationBatch, type CalibrationDataset } from './build.js';
import {
  datasetIdentity,
  identityDifferences,
  inputsSha256,
  manifestsIn,
  newManifest,
  readManifest,
  resumeState,
  runFiles,
  type RunIdentity,
  type RunManifest,
} from './manifest.js';
import { displayLines, displayReport, latencyReport, rawLines, rawReport, type Trial } from './metrics.js';
import { BUDGET_V2_USD, CANDIDATES_V2, PROTOCOL_V2, SAMPLES_V2, candidateMismatch, productionCheck, selectV2, type DevRunV2 } from './protocol.v2.js';

export const WORK_DIR = resolve(APP_DIR, 'data/work/checker');
export const SPEND_LOG_V2 = resolve(WORK_DIR, 'spend-16d.jsonl');
export const SELECTION_V2_PATH = resolve(APP_DIR, 'evals/checker/selection.v2.json');

/** The frozen choice for the held-out run and for production. */
export interface SelectionV2 {
  protocol: string;
  candidate: string;
  model: string;
  thinking: string;
  effort: 'low' | 'medium';
  prompt: { version: string; systemSha256: string };
  outputSchema: { version: string; sha256: string };
  caps: { input: number; output: number };
  timeoutMs: number;
  maxClaims: number;
  dataset: { fileSha256: string; devLabelsSha256: string; holdoutLabelsSha256: string };
  devManifest: string;
  frozenAt: string;
  reason: string;
}

const briefWithoutError = (b: CalibrationBatch) => b.kind === 'brief' && (b.brief === 'supported' || b.brief === 'unresolved');

const samplesOf = (b: CalibrationBatch) => (b.maxSize ? SAMPLES_V2.maxSize : briefWithoutError(b) ? SAMPLES_V2.briefWithoutError : SAMPLES_V2.other);

/**
 * The held-out order the protocol pre-registered (`HELDOUT_V2`): briefs without a known
 * error, then error briefs, then claim batches, so that a run the reservation limit stops
 * early is a partial pilot of the briefs first.
 */
const heldOutRank = (b: CalibrationBatch) => (b.kind === 'claims' ? 2 : briefWithoutError(b) ? 0 : 1);

/** The planned slots of a split (`SAMPLES_V2`), the held-out ones in the pre-registered order. */
export function plannedSlots(dataset: CalibrationDataset, split: 'dev' | 'holdout'): { batch: string; sample: number }[] {
  const batches = dataset.batches.filter((b) => b.split === split);
  const ordered = split === 'holdout' ? batches.map((b, i) => ({ b, i })).sort((x, y) => heldOutRank(x.b) - heldOutRank(y.b) || x.i - y.i).map(({ b }) => b) : batches;
  return ordered.flatMap((b) => Array.from({ length: samplesOf(b) }, (_, i) => ({ batch: b.id, sample: i + 1 })));
}

/** The figures of a run: accuracy over every batch but the maximum-size inputs, which are reported for latency and structure. */
export function runFigures(batches: readonly CalibrationBatch[], trials: readonly Trial[], timeoutMs: number) {
  const max = new Set(batches.filter((b) => b.maxSize).map((b) => b.id));
  const accuracy = batches.filter((b) => !max.has(b.id));
  const measured = trials.filter((t) => !max.has(t.batch));
  const big = trials.filter((t) => max.has(t.batch));
  return {
    raw: rawReport(accuracy, measured, timeoutMs),
    display: displayReport(accuracy, measured, { mode: 'claims' }),
    whole: displayReport(accuracy, measured, { mode: 'whole' }),
    latency: latencyReport(batches, trials, timeoutMs),
    maxSize: {
      calls: big.length,
      failed: Object.fromEntries([...new Set(big.flatMap((t) => (t.failure ? [t.failure] : [])))].map((f) => [f, big.filter((t) => t.failure === f).length])),
      structural: rawReport(batches.filter((b) => max.has(b.id)), big, timeoutMs).structuralCalls,
      latencyMs: big.map((t) => t.latencyMs),
      outputTokens: big.map((t) => t.usage?.outputTokens ?? null),
      thinkingTokens: big.map((t) => t.usage?.thinkingTokens ?? null),
    },
  };
}

/** Logged spend so far (every paid 16d step). */
export function loggedSpendUsd(path = SPEND_LOG_V2): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => sum + (JSON.parse(line) as { usd: number }).usd, 0);
}

function providerFor(config: AppConfig, candidate: string): LlmProvider {
  const c = CANDIDATES_V2[candidate]!;
  const apiKey = config.ai.anthropic.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  return createAnthropicProvider({ apiKey, models: { scope: c.model, answer: c.model, check: c.model }, thinking: { check: c.thinking } });
}

/** The run identity of a candidate on a split, from the code and the dataset as they are now. */
export function identityFor(candidate: string, split: 'dev' | 'holdout', dataset: CalibrationDataset, fileText: string): RunIdentity {
  const problems = candidateMismatch(candidate);
  if (problems.length > 0) throw new Error(`the code is not candidate ${candidate} as frozen: ${problems.join('; ')}`);
  const c = CANDIDATES_V2[candidate]!;
  const p = productionCheck();
  const slots = plannedSlots(dataset, split);
  return {
    protocol: PROTOCOL_V2,
    candidate,
    split,
    model: c.model,
    thinking: c.thinking,
    effort: c.effort,
    prompt: p.prompt,
    outputSchema: p.outputSchema,
    caps: p.caps,
    timeoutMs: p.timeoutMs,
    maxClaims: p.maxClaims,
    dataset: datasetIdentity(dataset, fileText, split),
    inputsSha256: inputsSha256(dataset.batches, slots),
    slots,
  };
}

const ctxOf = (timeoutMs: number) => stageCtx('check', AbortSignal.timeout(timeoutMs), timeoutMs);

/** Worst case of one call: the counted input, the output cap, the cache-write premium on the prefix. */
export function worstUsd(model: string, inputTokens: number, outputCap: number): number {
  const p = llmPrice(model);
  return (inputTokens * p.input + outputCap * p.output + Math.min(CACHED_PREFIX_MAX, inputTokens) * Math.max(0, p.cacheWrite - p.input)) / 1e6;
}

/** A rough expectation of one call: the input, about 40 visible tokens a verdict, and ~150 thinking tokens a claim. */
function expectedUsd(model: string, inputTokens: number, claims: number): number {
  const p = llmPrice(model);
  return (inputTokens * p.input + (200 + 190 * claims) * p.output) / 1e6;
}

/** The free input count, retried on a transient failure (it generates nothing). */
async function countWithRetry(provider: LlmProvider, batch: CalibrationBatch, timeoutMs: number): Promise<number> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await provider.countInputTokens('check', batch.input, ctxOf(Math.max(timeoutMs, 30_000)));
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

export async function inventoryCommand(config: AppConfig, opts: { candidate: string; split: 'dev' | 'holdout'; log: (m: string) => void }): Promise<number> {
  const fileText = readFileSync(DATASET_V2_PATH, 'utf8');
  const dataset = readDatasetV2();
  const identity = identityFor(opts.candidate, opts.split, dataset, fileText);
  const provider = providerFor(config, opts.candidate);
  const byId = new Map(dataset.batches.map((b) => [b.id, b]));
  const counts = new Map<string, number>();
  for (const id of new Set(identity.slots.map((s) => s.batch))) counts.set(id, await countWithRetry(provider, byId.get(id)!, identity.timeoutMs));
  let expected = 0;
  let worst = 0;
  let tokens = 0;
  for (const s of identity.slots) {
    const n = counts.get(s.batch)!;
    tokens += n;
    expected += expectedUsd(identity.model, n, byId.get(s.batch)!.input.claims.length);
    worst += worstUsd(identity.model, n, identity.caps.output);
  }
  const spent = loggedSpendUsd();
  opts.log(
    `${opts.candidate} on ${opts.split}: ${identity.slots.length} calls over ${counts.size} batches, ${tokens} input tokens (largest call ${Math.max(...counts.values())}, most claims ${Math.max(...[...byId.values()].filter((b) => b.split === opts.split).map((b) => b.input.claims.length))}); expected about $${expected.toFixed(4)}, worst case $${worst.toFixed(4)}`,
  );
  opts.log(`logged 16d spend $${spent.toFixed(6)} of $${BUDGET_V2_USD}; left $${(BUDGET_V2_USD - spent).toFixed(6)}; nothing generated (run --confirm-cost sends the calls)`);
  return 0;
}

const usageOf = (u: StageUsage) => ({
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
  cacheWriteTokens: u.cacheWriteTokens,
  cacheReadTokens: u.cacheReadTokens,
  ...(u.thinkingTokens !== undefined ? { thinkingTokens: u.thinkingTokens } : {}),
});

/** Refuse a held-out run unless it is the one, for the frozen selection. */
function heldOutGuard(candidate: string, dataset: CalibrationDataset, fileText: string): void {
  if (!existsSync(SELECTION_V2_PATH)) throw new Error('the held-out split runs only for the candidate frozen in selection.v2.json');
  const sel = JSON.parse(readFileSync(SELECTION_V2_PATH, 'utf8')) as SelectionV2;
  const id = datasetIdentity(dataset, fileText, 'holdout');
  if (sel.candidate !== candidate) throw new Error('selection.v2.json names another candidate');
  if (sel.dataset.holdoutLabelsSha256 !== id.labelsSha256) throw new Error('selection.v2.json was frozen with another held-out label set');
  if (manifestsIn(WORK_DIR).some((m) => m.split === 'holdout')) throw new Error('the held-out split has already run once (a held-out manifest exists)');
  if (existsSync(SPEND_LOG_V2) && readFileSync(SPEND_LOG_V2, 'utf8').includes('"split":"holdout"')) throw new Error('the held-out split has already run once (spend log)');
}

export async function runCommand(
  config: AppConfig,
  opts: { candidate: string; split: 'dev' | 'holdout'; confirmCost: boolean; resume?: string; log: (m: string) => void },
): Promise<number> {
  const fileText = readFileSync(DATASET_V2_PATH, 'utf8');
  const dataset = readDatasetV2();
  const identity = identityFor(opts.candidate, opts.split, dataset, fileText);
  let manifest: RunManifest;
  let done: Trial[] = [];
  let todo = identity.slots;
  if (opts.resume) {
    manifest = readManifest(resolve(opts.resume));
    const { version: _v, id: _id, createdAt: _c, ...frozen } = manifest;
    const diff = identityDifferences(frozen as RunIdentity, identity);
    if (diff.length > 0) throw new Error(`--resume: the run's identity changed (${diff.join(', ')}); a changed run is a new run`);
    ({ done, todo } = resumeState(manifest, runFiles(WORK_DIR, manifest).trials));
  } else {
    if (opts.split === 'holdout') heldOutGuard(opts.candidate, dataset, fileText);
    manifest = newManifest(identity);
  }
  const files = runFiles(WORK_DIR, manifest);
  if (!opts.confirmCost) {
    opts.log(`${todo.length} calls planned for ${opts.candidate} on ${opts.split} (manifest ${manifest.id.slice(0, 12)}); nothing sent (run inventory first, then --confirm-cost)`);
    return 0;
  }
  if (!config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
  mkdirSync(WORK_DIR, { recursive: true });
  if (!opts.resume) {
    if (existsSync(files.manifest)) throw new Error(`a run with this identity exists (${files.manifest}): resume it`);
    writeFileSync(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(files.trials, '');
  }
  const provider = providerFor(config, opts.candidate);
  const ingest = createDb(config.databaseIngestUrl, { max: 2, applicationName: 'aviation-eval-checker-ledger' });
  const gate: SpendGate = createLedgerSpendGate(ingest, { budgets: config.ai.budgets, provider: 'anthropic', model: manifest.model, stage: 'check' });
  const byId = new Map(dataset.batches.map((b) => [b.id, b]));
  let stopped: string | null = null;
  try {
    for (const slot of todo) {
      const batch = byId.get(slot.batch)!;
      const counted = await countWithRetry(provider, batch, manifest.timeoutMs);
      const reserveUsd = worstUsd(manifest.model, counted, manifest.caps.output);
      const spent = loggedSpendUsd();
      if (spent + reserveUsd > BUDGET_V2_USD) {
        stopped = `the next call's reservation ($${reserveUsd.toFixed(4)}) would take the logged 16d spend ($${spent.toFixed(4)}) above $${BUDGET_V2_USD}`;
        break;
      }
      const purpose = `eval-checker-v2-${manifest.id.slice(0, 12)}-${slot.batch}-${slot.sample}`;
      const reservation = await gate.reserve({ category: 'evaluation', usd: reserveUsd, purpose });
      const t0 = performance.now();
      let trial: Trial;
      let settled: number;
      try {
        // The production timeout: a call that runs out of time is a failed call, as in production.
        const r = await provider.check(batch.input, ctxOf(manifest.timeoutMs));
        const costUsd = stageCostUsd(manifest.model, r.usage);
        await gate.settle(reservation, { usd: costUsd, tokens: r.usage.inputTokens + r.usage.outputTokens });
        settled = costUsd;
        trial = { batch: slot.batch, sample: slot.sample, output: r.output, stopReason: r.stopReason, latencyMs: Math.round(performance.now() - t0), costUsd, usage: usageOf(r.usage), manifest: manifest.id };
      } catch (err) {
        if (!(err instanceof StageError)) {
          await gate.settle(reservation, 'uncertain');
          appendFileSync(SPEND_LOG_V2, `${JSON.stringify({ at: new Date().toISOString(), manifest: manifest.id, candidate: opts.candidate, split: opts.split, batch: slot.batch, sample: slot.sample, model: manifest.model, usd: reserveUsd, uncertain: true })}\n`);
          throw err;
        }
        const billing = err.billing;
        // A timeout settles uncertain and charges the whole reservation, as production does.
        const costUsd = billing.kind === 'usage' ? stageCostUsd(manifest.model, billing.usage) : billing.kind === 'none' ? 0 : reserveUsd;
        await gate.settle(reservation, billing.kind === 'uncertain' ? 'uncertain' : { usd: costUsd });
        settled = costUsd;
        trial = {
          batch: slot.batch,
          sample: slot.sample,
          output: null,
          failure: err.category,
          stopReason: err.stopReason,
          latencyMs: Math.round(performance.now() - t0),
          costUsd,
          ...(billing.kind === 'usage' ? { usage: usageOf(billing.usage) } : {}),
          manifest: manifest.id,
        };
      }
      appendFileSync(SPEND_LOG_V2, `${JSON.stringify({ at: new Date().toISOString(), manifest: manifest.id, candidate: opts.candidate, split: opts.split, batch: slot.batch, sample: slot.sample, model: manifest.model, usd: settled })}\n`);
      appendFileSync(files.trials, `${JSON.stringify(trial)}\n`);
      done.push(trial);
      opts.log(`${slot.batch}#${slot.sample}: ${trial.output ? `${trial.output.verdicts.length} verdicts` : `failed (${trial.failure})`}, ${trial.latencyMs} ms, $${trial.costUsd.toFixed(5)}`);
    }
  } finally {
    await closeDb(ingest);
  }
  const batches = dataset.batches.filter((b) => b.split === opts.split);
  const complete = stopped === null && manifest.slots.every((s) => done.some((d) => d.batch === s.batch && d.sample === s.sample));
  const { raw, display, whole, latency, maxSize } = runFigures(batches, done, manifest.timeoutMs);
  const summary = {
    protocol: PROTOCOL_V2,
    candidate: opts.candidate,
    split: opts.split,
    manifest: manifest.id,
    dataset: DATASET_V2_PATH.slice(APP_DIR.length + 1),
    trials: files.trials.slice(APP_DIR.length + 1),
    complete,
    ...(stopped ? { stopped } : {}),
    raw,
    display,
    whole,
    latency,
    maxSize,
  };
  writeFileSync(files.summary, `${JSON.stringify(summary, null, 2)}\n`);
  for (const line of [...rawLines(`${opts.candidate} ${opts.split}`, raw), ...displayLines(`${opts.candidate} ${opts.split}`, display)]) opts.log(line);
  opts.log(`latency: p50 ${latency.p50} ms, p95 ${latency.p95} ms, max ${latency.max} ms, ${latency.timeouts} timeouts; maximum-size inputs ${JSON.stringify(maxSize)}`);
  if (stopped) opts.log(`stopped: ${stopped}`);
  opts.log(`logged 16d spend now $${loggedSpendUsd().toFixed(6)}; summary ${files.summary}`);
  return stopped ? 1 : 0;
}

/** Apply the frozen selection rule (`selectV2`) to development run summaries and freeze the choice. */
export function selectCommand(files: readonly string[], log: (m: string) => void): number {
  const fileText = readFileSync(DATASET_V2_PATH, 'utf8');
  const dataset = readDatasetV2();
  const runs = files.map((f) => JSON.parse(readFileSync(resolve(f), 'utf8')) as DevRunV2 & { dataset: string });
  for (const r of runs) {
    const m = manifestsIn(WORK_DIR).find((x) => x.id === r.manifest);
    if (!m) throw new Error(`${r.candidate}: no manifest ${r.manifest}`);
    if (m.dataset.fileSha256 !== datasetIdentity(dataset, fileText, 'dev').fileSha256) throw new Error(`${r.candidate}: run on another dataset file`);
  }
  const choice = selectV2(runs);
  const devRun = runs.find((r) => r.candidate === choice.candidate)!;
  // The selection is the configuration that was measured: its development run's manifest.
  const identity = manifestsIn(WORK_DIR).find((x) => x.id === devRun.manifest)!;
  const selection: SelectionV2 = {
    protocol: PROTOCOL_V2,
    candidate: choice.candidate,
    model: identity.model,
    thinking: identity.thinking,
    effort: identity.effort,
    prompt: identity.prompt,
    outputSchema: identity.outputSchema,
    caps: identity.caps,
    timeoutMs: identity.timeoutMs,
    maxClaims: identity.maxClaims,
    dataset: {
      fileSha256: identity.dataset.fileSha256,
      devLabelsSha256: datasetIdentity(dataset, fileText, 'dev').labelsSha256,
      holdoutLabelsSha256: datasetIdentity(dataset, fileText, 'holdout').labelsSha256,
    },
    devManifest: devRun.manifest,
    frozenAt: new Date().toISOString(),
    reason: choice.reason,
  };
  writeFileSync(SELECTION_V2_PATH, `${JSON.stringify(selection, null, 2)}\n`);
  log(`selected ${choice.candidate}: ${choice.reason}`);
  log(`wrote ${SELECTION_V2_PATH}`);
  return 0;
}
