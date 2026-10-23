/**
 * `pnpm eval:checker inventory|run|select` under protocol v3 (Task 16e, `protocol.v3.ts`).
 *
 * `inventory` is free: it counts every planned call's input with the provider's own
 * counter (`messages.countTokens`) and prices the plan (calls, tokens, expected and
 * worst-case cost) against the allocation `checker-16e-2026-10`. Nothing is generated.
 *
 * `run` sends the check stage exactly as production does (the Anthropic adapter, the
 * production check prompt, output schema, caps and maximum claim count) at the candidate's
 * effort, only with `--confirm-cost` and only when the code is the candidate as frozen
 * (`candidateMismatchV3`: prompt, schema, caps, claims, thinking and every frozen rule
 * version). The call's own transport timeout is the candidate's `measureTimeoutMs`, so the
 * latency past the production timeout is measured; every figure then counts a call over
 * the production timeout as a timeout (`censorTrials`), as production would. Each run has
 * an immutable manifest (`manifest.ts`, with the protocol file's sha256 and the rule
 * versions); `--resume <manifest>` continues only that manifest's missing slots.
 *
 * Money: one run at a time per allocation (a lock file next to its log); every call
 * reserves its worst case on the evaluation ledger (`DATABASE_INGEST_URL`, category
 * `evaluation`) and settles with the actual cost; every paid step is appended to the
 * allocation's log. A call whose reservation would take the allocation's logged spend and
 * open reservations over `BUDGET_V3.limitUsd`, or the ledger's remaining evaluation
 * allowance below `BUDGET_V3.protectedUsd` (Track N's allocation), is not sent: the run
 * stops there. The held-out split runs once, for the candidate frozen in
 * `selection.v3.json`, at the selection's production timeout.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { createAnthropicProvider } from '../../server/ai/anthropic.js';
import { llmPrice, stageCostUsd } from '../../server/ai/pricing.js';
import { StageError, stageCtx, type LlmProvider, type StageUsage } from '../../server/ai/provider.js';
import { closeDb, createDb } from '../../server/db/client.js';
import type { AppConfig } from '../../shared/config.js';
import { APP_DIR } from '../../worker/config.js';
import { createLedgerSpendGate, type SpendGate } from '../../worker/index/spend-gate.js';
import { DATASET_V3_PATH, readDatasetV3, type CalibrationBatch, type CalibrationDataset } from './build.js';
import { datasetIdentity, identityDifferences, inputsSha256, manifestsIn, newManifest, readManifest, resumeState, runFiles, type RunIdentity, type RunManifest } from './manifest.js';
import { censorTrials, displayLines, displayReport, latencyReport, rawLines, rawReport, type Trial } from './metrics.js';
import { BUDGET_V3, CANDIDATES_V3, PROTOCOL_V3, SAMPLES_V3, candidateMismatchV3, codeRules, derivedTimeoutMs, protocolV3Sha256, selectV3, type DevRunV3 } from './protocol.v3.js';
import { productionCheck } from './protocol.v2.js';
import { worstUsd } from './run.js';

export const WORK_DIR_V3 = resolve(APP_DIR, 'data/work/checker16e');
export const ALLOCATION_LOG = resolve(WORK_DIR_V3, `allocation-${BUDGET_V3.allocation}.jsonl`);
export const SELECTION_V3_PATH = resolve(APP_DIR, 'evals/checker/selection.v3.json');

/** The frozen choice for the held-out run and for production. */
export interface SelectionV3 {
  protocol: string;
  candidate: string;
  model: string;
  thinking: string;
  effort: 'low' | 'medium';
  prompt: { version: string; systemSha256: string };
  outputSchema: { version: string; sha256: string };
  caps: { input: number; output: number };
  /** The production check timeout derived from the development latency (`derivedTimeoutMs`). */
  timeoutMs: number;
  maxClaims: number;
  rules: Record<string, string>;
  dataset: { fileSha256: string; devLabelsSha256: string; holdoutLabelsSha256: string };
  devManifest: string;
  latency: { calls: number; p50: number | null; p95: number | null; max: number | null };
  frozenAt: string;
  reason: string;
}

const briefWithoutError = (b: CalibrationBatch) => b.kind === 'brief' && (b.brief === 'supported' || b.brief === 'unresolved');

/** The held-out order (`HELDOUT_V3`): briefs without a known error, error briefs, claim batches. */
const heldOutRank = (b: CalibrationBatch) => (b.kind === 'claims' ? 2 : briefWithoutError(b) ? 0 : 1);

/** The planned slots of a split (`SAMPLES_V3`), the held-out ones in the pre-registered order. */
export function plannedSlotsV3(dataset: CalibrationDataset, split: 'dev' | 'holdout'): { batch: string; sample: number }[] {
  const samples = SAMPLES_V3[split];
  const of = (b: CalibrationBatch) => (b.maxSize ? samples.maxSize : briefWithoutError(b) ? samples.briefWithoutError : samples.other);
  const batches = dataset.batches.filter((b) => b.split === split);
  const ordered = split === 'holdout' ? batches.map((b, i) => ({ b, i })).sort((x, y) => heldOutRank(x.b) - heldOutRank(y.b) || x.i - y.i).map(({ b }) => b) : batches;
  return ordered.flatMap((b) => Array.from({ length: of(b) }, (_, i) => ({ batch: b.id, sample: i + 1 })));
}

/**
 * The figures of a run, every call over `timeoutMs` counted as a timeout: accuracy over
 * every batch but the maximum-size inputs (latency and structure apart); the latency from
 * the measured calls, uncensored.
 */
export function runFiguresV3(batches: readonly CalibrationBatch[], trials: readonly Trial[], timeoutMs: number) {
  const max = new Set(batches.filter((b) => b.maxSize).map((b) => b.id));
  const accuracy = batches.filter((b) => !max.has(b.id));
  const censored = censorTrials(trials, timeoutMs);
  const measured = censored.filter((t) => !max.has(t.batch));
  const big = censored.filter((t) => max.has(t.batch));
  return {
    timeoutMs,
    raw: rawReport(accuracy, measured, timeoutMs),
    display: displayReport(accuracy, measured, { mode: 'claims' }),
    whole: displayReport(accuracy, measured, { mode: 'whole' }),
    latency: latencyReport(batches, trials, timeoutMs),
    maxSize: {
      calls: big.length,
      failed: Object.fromEntries([...new Set(big.flatMap((t) => (t.failure ? [t.failure] : [])))].map((f) => [f, big.filter((t) => t.failure === f).length])),
      structural: rawReport(batches.filter((b) => max.has(b.id)), big, timeoutMs).structuralCalls,
      latencyMs: trials.filter((t) => max.has(t.batch)).map((t) => t.latencyMs),
      outputTokens: big.map((t) => t.usage?.outputTokens ?? null),
      thinkingTokens: big.map((t) => t.usage?.thinkingTokens ?? null),
    },
  };
}

// ---------------------------------------------------------------------------
// The allocation

export interface AllocationEntry {
  at: string;
  allocation: string;
  step: string;
  usd: number;
  reservedUsd: number;
  uncertain?: boolean;
  manifest?: string;
  candidate?: string;
  split?: 'dev' | 'holdout';
  batch?: string;
  sample?: number;
  model?: string;
}

/** The allocation's logged spend (every paid 16e step). */
export function allocationSpentUsd(path = ALLOCATION_LOG): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .reduce((sum, line) => sum + (JSON.parse(line) as AllocationEntry).usd, 0);
}

export function appendAllocation(entry: Omit<AllocationEntry, 'at' | 'allocation'>, path = ALLOCATION_LOG): void {
  mkdirSync(WORK_DIR_V3, { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), allocation: BUDGET_V3.allocation, ...entry })}\n`);
}

/** One run at a time per allocation: a lock file next to its log, released when the run ends. */
export function lockAllocation(run: string, path = ALLOCATION_LOG.replace(/\.jsonl$/, '.lock')): { release(): void } {
  mkdirSync(WORK_DIR_V3, { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify({ run, pid: process.pid, host: hostname(), at: new Date().toISOString() })}\n`, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    throw new Error(`allocation ${BUDGET_V3.allocation} is locked by another run (${path}); nothing sent. Remove the lock only when that run has ended and its reservations are settled.`);
  }
  return {
    release: () => {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * Whether a reservation may be made: the allocation's logged spend, the open reservations
 * of this run and the new one within the limit; the ledger's remaining evaluation allowance
 * after it at least the protected amount. Null: it may; otherwise why not.
 */
export function reservationRefusal(opts: { spentUsd: number; inFlightUsd: number; reserveUsd: number; ledgerRemainingUsd: number }): string | null {
  const after = opts.spentUsd + opts.inFlightUsd + opts.reserveUsd;
  if (after > BUDGET_V3.limitUsd) {
    return `the reservation ($${opts.reserveUsd.toFixed(4)}) would take allocation ${BUDGET_V3.allocation} to $${after.toFixed(4)}, over its $${BUDGET_V3.limitUsd} limit`;
  }
  if (opts.ledgerRemainingUsd - opts.reserveUsd < BUDGET_V3.protectedUsd) {
    return `the reservation ($${opts.reserveUsd.toFixed(4)}) would leave the ledger's evaluation allowance at $${(opts.ledgerRemainingUsd - opts.reserveUsd).toFixed(4)}, below the $${BUDGET_V3.protectedUsd} protected for ${BUDGET_V3.protectedFor}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runs

function providerFor(config: AppConfig, candidate: string): LlmProvider {
  const c = CANDIDATES_V3[candidate]!;
  const apiKey = config.ai.anthropic.apiKey;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  return createAnthropicProvider({ apiKey, models: { scope: c.model, answer: c.model, check: c.model }, thinking: { check: c.thinking }, effort: { check: c.effort } });
}

/** The run identity of a candidate on a split, from the code and the dataset as they are now (`timeoutMs`: the held-out run's, from the selection). */
export function identityForV3(candidate: string, split: 'dev' | 'holdout', dataset: CalibrationDataset, fileText: string, timeoutMs?: number): RunIdentity {
  const problems = candidateMismatchV3(candidate);
  if (problems.length > 0) throw new Error(`the code is not candidate ${candidate} as frozen: ${problems.join('; ')}`);
  if (dataset.version !== 'checker-cal-v3') throw new Error('protocol v3 runs on dataset v3');
  const c = CANDIDATES_V3[candidate]!;
  const p = productionCheck();
  const slots = plannedSlotsV3(dataset, split);
  if (slots.length === 0) throw new Error(`no ${split} slots in the dataset`);
  return {
    protocol: PROTOCOL_V3,
    candidate,
    split,
    model: c.model,
    thinking: c.thinking,
    effort: c.effort,
    prompt: p.prompt,
    outputSchema: p.outputSchema,
    caps: p.caps,
    timeoutMs: timeoutMs ?? c.timeoutMs,
    maxClaims: p.maxClaims,
    dataset: datasetIdentity(dataset, fileText, split),
    inputsSha256: inputsSha256(dataset.batches, slots),
    slots,
    measureTimeoutMs: c.measureTimeoutMs,
    allocation: BUDGET_V3.allocation,
    rules: codeRules(),
    protocolSha256: protocolV3Sha256(),
  };
}

const ctxOf = (timeoutMs: number) => stageCtx('check', AbortSignal.timeout(timeoutMs), timeoutMs);

/** A rough expectation of one call: the counted input and the candidate's expected output. */
export function expectedUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = llmPrice(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}

/** The free input count, retried on a transient failure (it generates nothing). */
async function countWithRetry(provider: LlmProvider, batch: CalibrationBatch): Promise<number> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await provider.countInputTokens('check', batch.input, ctxOf(30_000));
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
}

function readSelection(): SelectionV3 | null {
  return existsSync(SELECTION_V3_PATH) ? (JSON.parse(readFileSync(SELECTION_V3_PATH, 'utf8')) as SelectionV3) : null;
}

export async function inventoryV3(config: AppConfig, opts: { candidate: string; split: 'dev' | 'holdout'; log: (m: string) => void }): Promise<number> {
  const fileText = readFileSync(DATASET_V3_PATH, 'utf8');
  const dataset = readDatasetV3();
  const identity = identityForV3(opts.candidate, opts.split, dataset, fileText);
  const c = CANDIDATES_V3[opts.candidate]!;
  const provider = providerFor(config, opts.candidate);
  const byId = new Map(dataset.batches.map((b) => [b.id, b]));
  const counts = new Map<string, number>();
  for (const id of new Set(identity.slots.map((s) => s.batch))) counts.set(id, await countWithRetry(provider, byId.get(id)!));
  let expected = 0;
  let worst = 0;
  let tokens = 0;
  for (const s of identity.slots) {
    const n = counts.get(s.batch)!;
    tokens += n;
    expected += expectedUsd(identity.model, n, c.expectedOutputTokens);
    worst += worstUsd(identity.model, n, identity.caps.output);
  }
  const spent = allocationSpentUsd();
  opts.log(
    `${opts.candidate} on ${opts.split}: ${identity.slots.length} calls over ${counts.size} batches, ${tokens} input tokens (largest call ${Math.max(...counts.values())}); expected about $${expected.toFixed(4)} (at ${c.expectedOutputTokens} output tokens a call), worst case $${worst.toFixed(4)}`,
  );
  opts.log(`allocation ${BUDGET_V3.allocation}: logged $${spent.toFixed(6)} of $${BUDGET_V3.limitUsd}; left $${(BUDGET_V3.limitUsd - spent).toFixed(6)}; nothing generated (run --confirm-cost sends the calls)`);
  return 0;
}

const usageOf = (u: StageUsage) => ({
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens,
  cacheWriteTokens: u.cacheWriteTokens,
  cacheReadTokens: u.cacheReadTokens,
  ...(u.thinkingTokens !== undefined ? { thinkingTokens: u.thinkingTokens } : {}),
});

/** Refuse a held-out run unless it is the one, for the frozen selection; its production timeout. */
function heldOutGuard(candidate: string, dataset: CalibrationDataset, fileText: string): number {
  const sel = readSelection();
  if (!sel) throw new Error('the held-out split runs only for the candidate frozen in selection.v3.json');
  const id = datasetIdentity(dataset, fileText, 'holdout');
  if (sel.candidate !== candidate) throw new Error('selection.v3.json names another candidate');
  if (sel.dataset.holdoutLabelsSha256 !== id.labelsSha256 || sel.dataset.fileSha256 !== id.fileSha256) throw new Error('selection.v3.json was frozen with another dataset or held-out label set');
  if (manifestsIn(WORK_DIR_V3).some((m) => m.split === 'holdout')) throw new Error('the held-out split has already run once (a held-out manifest exists)');
  if (existsSync(ALLOCATION_LOG) && readFileSync(ALLOCATION_LOG, 'utf8').includes('"split":"holdout"')) throw new Error('the held-out split has already run once (allocation log)');
  return sel.timeoutMs;
}

export async function runV3(
  config: AppConfig,
  opts: { candidate: string; split: 'dev' | 'holdout'; confirmCost: boolean; resume?: string; concurrency?: number; log: (m: string) => void },
): Promise<number> {
  const fileText = readFileSync(DATASET_V3_PATH, 'utf8');
  const dataset = readDatasetV3();
  let manifest: RunManifest;
  let done: Trial[] = [];
  let todo: { batch: string; sample: number }[];
  if (opts.resume) {
    manifest = readManifest(resolve(opts.resume));
    const { version: _v, id: _id, createdAt: _c, ...frozen } = manifest;
    const identity = identityForV3(opts.candidate, opts.split, dataset, fileText, manifest.timeoutMs);
    const diff = identityDifferences(frozen as RunIdentity, identity);
    if (diff.length > 0) throw new Error(`--resume: the run's identity changed (${diff.join(', ')}); a changed run is a new run`);
    ({ done, todo } = resumeState(manifest, runFiles(WORK_DIR_V3, manifest).trials));
  } else {
    const timeoutMs = opts.split === 'holdout' ? heldOutGuard(opts.candidate, dataset, fileText) : undefined;
    manifest = newManifest(identityForV3(opts.candidate, opts.split, dataset, fileText, timeoutMs));
    todo = manifest.slots;
  }
  const files = runFiles(WORK_DIR_V3, manifest);
  if (!opts.confirmCost) {
    opts.log(`${todo.length} calls planned for ${opts.candidate} on ${opts.split} (manifest ${manifest.id.slice(0, 12)}); nothing sent (run inventory first, then --confirm-cost)`);
    return 0;
  }
  if (!config.databaseIngestUrl) throw new Error('DATABASE_INGEST_URL is not set (the evaluation ledger)');
  const lock = lockAllocation(manifest.id);
  const ingest = createDb(config.databaseIngestUrl, { max: 4, applicationName: 'aviation-eval-checker-ledger' });
  let stopped: string | null = null;
  try {
    mkdirSync(WORK_DIR_V3, { recursive: true });
    if (!opts.resume) {
      if (existsSync(files.manifest)) throw new Error(`a run with this identity exists (${files.manifest}): resume it`);
      writeFileSync(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(files.trials, '');
    }
    const provider = providerFor(config, opts.candidate);
    const gate: SpendGate = createLedgerSpendGate(ingest, { budgets: config.ai.budgets, provider: 'anthropic', model: manifest.model, stage: 'check' });
    const byId = new Map(dataset.batches.map((b) => [b.id, b]));
    const measureMs = manifest.measureTimeoutMs ?? manifest.timeoutMs;
    let inFlightUsd = 0;
    let next = 0;
    const one = async (slot: { batch: string; sample: number }): Promise<void> => {
      const batch = byId.get(slot.batch)!;
      const counted = await countWithRetry(provider, batch);
      const reserveUsd = worstUsd(manifest.model, counted, manifest.caps.output);
      const refusal = reservationRefusal({ spentUsd: allocationSpentUsd(), inFlightUsd, reserveUsd, ledgerRemainingUsd: await gate.remainingUsd('evaluation') });
      if (refusal) {
        stopped ??= refusal;
        return;
      }
      inFlightUsd += reserveUsd;
      const purpose = `eval-checker-v3-${manifest.id.slice(0, 12)}-${slot.batch}-${slot.sample}`;
      try {
        const reservation = await gate.reserve({ category: 'evaluation', usd: reserveUsd, purpose });
        const t0 = performance.now();
        let trial: Trial;
        let settled: number;
        let uncertain = false;
        try {
          const r = await provider.check(batch.input, ctxOf(measureMs));
          const costUsd = stageCostUsd(manifest.model, r.usage);
          await gate.settle(reservation, { usd: costUsd, tokens: r.usage.inputTokens + r.usage.outputTokens });
          settled = costUsd;
          trial = { batch: slot.batch, sample: slot.sample, output: r.output, stopReason: r.stopReason, latencyMs: Math.round(performance.now() - t0), costUsd, usage: usageOf(r.usage), manifest: manifest.id };
        } catch (err) {
          if (!(err instanceof StageError)) {
            await gate.settle(reservation, 'uncertain');
            appendAllocation({ step: 'check', usd: reserveUsd, reservedUsd: reserveUsd, uncertain: true, manifest: manifest.id, candidate: opts.candidate, split: opts.split, batch: slot.batch, sample: slot.sample, model: manifest.model });
            throw err;
          }
          const billing = err.billing;
          // A transport timeout settles uncertain and charges the whole reservation.
          const costUsd = billing.kind === 'usage' ? stageCostUsd(manifest.model, billing.usage) : billing.kind === 'none' ? 0 : reserveUsd;
          uncertain = billing.kind === 'uncertain';
          await gate.settle(reservation, uncertain ? 'uncertain' : { usd: costUsd });
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
        appendAllocation({
          step: 'check',
          usd: settled,
          reservedUsd: reserveUsd,
          ...(uncertain ? { uncertain: true } : {}),
          manifest: manifest.id,
          candidate: opts.candidate,
          split: opts.split,
          batch: slot.batch,
          sample: slot.sample,
          model: manifest.model,
        });
        appendFileSync(files.trials, `${JSON.stringify(trial)}\n`);
        done.push(trial);
        opts.log(`${slot.batch}#${slot.sample}: ${trial.output ? `${trial.output.verdicts.length} verdicts` : `failed (${trial.failure})`}, ${trial.latencyMs} ms, $${trial.costUsd.toFixed(5)}`);
      } finally {
        inFlightUsd -= reserveUsd;
      }
    };
    const worker = async () => {
      while (stopped === null && next < todo.length) {
        const slot = todo[next]!;
        next += 1;
        await one(slot);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 1, 4)) }, () => worker()));
  } finally {
    lock.release();
    await closeDb(ingest);
  }
  const batches = dataset.batches.filter((b) => b.split === opts.split);
  const complete = stopped === null && manifest.slots.every((s) => done.some((d) => d.batch === s.batch && d.sample === s.sample));
  const figures = runFiguresV3(batches, done, manifest.timeoutMs);
  const summary = {
    protocol: PROTOCOL_V3,
    candidate: opts.candidate,
    split: opts.split,
    manifest: manifest.id,
    dataset: DATASET_V3_PATH.slice(APP_DIR.length + 1),
    trials: files.trials.slice(APP_DIR.length + 1),
    complete,
    ...(stopped ? { stopped } : {}),
    concurrency: opts.concurrency ?? 1,
    ...figures,
  };
  writeFileSync(files.summary, `${JSON.stringify(summary, null, 2)}\n`);
  for (const line of [...rawLines(`${opts.candidate} ${opts.split}`, figures.raw), ...displayLines(`${opts.candidate} ${opts.split}`, figures.display)]) opts.log(line);
  const l = figures.latency;
  opts.log(`latency: p50 ${l.p50} ms, p95 ${l.p95} ms, max ${l.max} ms, ${l.overTimeout} over the ${manifest.timeoutMs} ms production timeout (counted as timeouts), ${l.timeouts} transport timeouts`);
  if (stopped) opts.log(`stopped: ${stopped}`);
  opts.log(`allocation ${BUDGET_V3.allocation} now $${allocationSpentUsd().toFixed(6)} of $${BUDGET_V3.limitUsd}; summary ${files.summary}`);
  return stopped ? 1 : 0;
}

/** Apply the frozen selection rule (`selectV3`) to development run summaries, derive the production timeout and freeze the choice. */
export function selectV3Command(files: readonly string[], log: (m: string) => void): number {
  const fileText = readFileSync(DATASET_V3_PATH, 'utf8');
  const dataset = readDatasetV3();
  const runs = files.map((f) => JSON.parse(readFileSync(resolve(f), 'utf8')) as DevRunV3 & { dataset: string; trials: string });
  const manifests = manifestsIn(WORK_DIR_V3);
  for (const r of runs) {
    const m = manifests.find((x) => x.id === r.manifest);
    if (!m) throw new Error(`${r.candidate}: no manifest ${r.manifest}`);
    if (m.dataset.fileSha256 !== datasetIdentity(dataset, fileText, 'dev').fileSha256) throw new Error(`${r.candidate}: run on another dataset file`);
    if (m.protocolSha256 !== protocolV3Sha256()) throw new Error(`${r.candidate}: run under another protocol file`);
  }
  const choice = selectV3(runs);
  const devRun = runs.find((r) => r.candidate === choice.candidate)!;
  const identity = manifests.find((x) => x.id === devRun.manifest)!;
  const trials = readFileSync(resolve(APP_DIR, devRun.trials), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Trial);
  // Every call's latency, failed ones included (the slowest call bounds the timeout).
  const latencies = trials.map((t) => t.latencyMs);
  const timeoutMs = derivedTimeoutMs(latencies);
  const all = latencyReport(dataset.batches, trials, timeoutMs);
  const selection: SelectionV3 = {
    protocol: PROTOCOL_V3,
    candidate: choice.candidate,
    model: identity.model,
    thinking: identity.thinking,
    effort: identity.effort,
    prompt: identity.prompt,
    outputSchema: identity.outputSchema,
    caps: identity.caps,
    timeoutMs,
    maxClaims: identity.maxClaims,
    rules: identity.rules ?? {},
    dataset: {
      fileSha256: identity.dataset.fileSha256,
      devLabelsSha256: datasetIdentity(dataset, fileText, 'dev').labelsSha256,
      holdoutLabelsSha256: datasetIdentity(dataset, fileText, 'holdout').labelsSha256,
    },
    devManifest: devRun.manifest,
    latency: { calls: all.calls, p50: all.p50, p95: all.p95, max: all.max },
    frozenAt: new Date().toISOString(),
    reason: choice.reason,
  };
  writeFileSync(SELECTION_V3_PATH, `${JSON.stringify(selection, null, 2)}\n`);
  log(`selected ${choice.candidate}: ${choice.reason}`);
  log(`production check timeout from the development latency (max ${all.max} ms): ${timeoutMs} ms`);
  log(`wrote ${SELECTION_V3_PATH}`);
  return 0;
}
