/**
 * E3 (task 10d, phase A): the scope stage's keyword text as BM25 text. The scope stage
 * is the existing reviewed one, unchanged: the production adapter, prompt `scope.v2`,
 * the configured scope model, the brief pipeline's stage budget and caps. A question's
 * input is exactly what a new brief sends (`scopeInput(questionRequest(question))`),
 * and its keyword text is the effective one the pipeline would search with
 * (`resolveIntent`: the planner's text, or the question when it gives none). The
 * planner's filters are recorded but never used: the experiments keep the dataset's
 * filters, and scope filter extraction is evaluated separately.
 *
 * - `scopeInventory`: the free dry run. The provider's token counter (no generation, no
 *   charge) gives each question's input tokens; the plan prints questions × samples ×
 *   tokens × price and the reservations.
 * - `runScopeSamples`: the paid run. Every attempt reserves the stage's worst case on the
 *   evaluation ledger before it is sent and settles afterwards: the billed cost, zero
 *   when nothing was billed, or `uncertain` (charged in full). A failed attempt is retried
 *   at most `retries` times, each retry with its own reservation. The run stops before an
 *   attempt whose reservation would take its spending above `maxUsd`.
 */
import { createHash } from 'node:crypto';
import { STAGE_CAPS, llmPrice, stageCostUsd, stageWorstCaseUsd } from '../../../server/ai/pricing.js';
import { StageError, stageCtx, type LlmProvider, type StageUsage } from '../../../server/ai/provider.js';
import { questionRequest, resolveIntent, scopeInput } from '../../../server/briefs/intent.js';
import type { SpendGate } from '../../../worker/index/spend-gate.js';

/** The brief pipeline's scope stage budget (`STAGE_TIMEOUTS.scope`; a test keeps them equal). */
export const SCOPE_STAGE_TIMEOUT_MS = 10_000;

export interface ScopeItem {
  id: string;
  question: string;
}

export const questionSha = (q: string): string => createHash('sha256').update(q).digest('hex');

export interface ScopeInventoryRow {
  id: string;
  inputTokens: number;
  /** One call at this input and the output cap (an upper estimate). */
  upperUsd: number;
}

export interface ScopeInventory {
  model: string;
  samples: number;
  rows: ScopeInventoryRow[];
  calls: number;
  inputTokens: number;
  /** Every call at its counted input and the output cap. */
  upperUsd: number;
  /** One reservation per call at the stage's worst case (before retries). */
  reserveUsd: number;
  perCallReserveUsd: number;
}

/** The dry run: counted input tokens per question (free), costs and reservations. Nothing is generated. */
export async function scopeInventory(provider: LlmProvider, items: readonly ScopeItem[], samples: number, timeoutMs = SCOPE_STAGE_TIMEOUT_MS): Promise<ScopeInventory> {
  const model = provider.models.scope;
  const price = llmPrice(model);
  const perCallReserveUsd = stageWorstCaseUsd(model, STAGE_CAPS.scope);
  const rows: ScopeInventoryRow[] = [];
  for (const item of items) {
    const input = scopeInput(questionRequest(item.question, undefined));
    const inputTokens = await provider.countInputTokens('scope', input, stageCtx('scope', AbortSignal.timeout(timeoutMs), timeoutMs));
    const cacheWritePremium = Math.max(0, price.cacheWrite - price.input) * inputTokens;
    rows.push({ id: item.id, inputTokens, upperUsd: (inputTokens * price.input + cacheWritePremium + STAGE_CAPS.scope.output * price.output) / 1e6 });
  }
  return {
    model,
    samples,
    rows,
    calls: items.length * samples,
    inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0) * samples,
    upperUsd: rows.reduce((n, r) => n + r.upperUsd, 0) * samples,
    reserveUsd: perCallReserveUsd * items.length * samples,
    perCallReserveUsd,
  };
}

export interface ScopeAttempt {
  attempt: number;
  status: 'ok' | 'failed';
  category: string | null;
  billing: 'usage' | 'none' | 'uncertain';
  reservedUsd: number;
  chargedUsd: number;
  usage: StageUsage | null;
  ms: number;
}

export interface ScopeSample {
  id: string;
  questionSha256: string;
  sample: number;
  status: 'ok' | 'failed';
  intent: string | null;
  /** The planner's own keyword text. */
  plannerKeywordText: string | null;
  /** The text the pipeline would search with (`resolveIntent`); the question when the planner gave none or failed. */
  keywordText: string;
  /** Recorded only; never used by the experiments. */
  plannerFilters: unknown;
  attempts: ScopeAttempt[];
}

export interface ScopeRun {
  model: string;
  promptVersion: string | null;
  samples: ScopeSample[];
  reservedUsd: number;
  chargedUsd: number;
  attempts: number;
}

export interface ScopeRunOptions {
  samples: number;
  retries: number;
  /** Stop before an attempt whose reservation would take this run above it. */
  maxUsd: number;
  /** Ledger purpose prefix (no content). */
  purpose: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

export class ScopeBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeBudgetError';
  }
}

/** The paid run (module comment). */
export async function runScopeSamples(provider: LlmProvider, gate: SpendGate, items: readonly ScopeItem[], opts: ScopeRunOptions): Promise<ScopeRun> {
  const model = provider.models.scope;
  const worst = stageWorstCaseUsd(model, STAGE_CAPS.scope);
  const timeoutMs = opts.timeoutMs ?? SCOPE_STAGE_TIMEOUT_MS;
  const log = opts.log ?? (() => undefined);
  const out: ScopeSample[] = [];
  let reservedUsd = 0;
  let chargedUsd = 0;
  let attempts = 0;
  let promptVersion: string | null = null;
  for (let sample = 1; sample <= opts.samples; sample += 1) {
    for (const item of items) {
      const req = questionRequest(item.question, undefined);
      const record: ScopeSample = {
        id: item.id,
        questionSha256: questionSha(item.question),
        sample,
        status: 'failed',
        intent: null,
        plannerKeywordText: null,
        keywordText: item.question,
        plannerFilters: null,
        attempts: [],
      };
      for (let attempt = 1; attempt <= 1 + opts.retries; attempt += 1) {
        if (chargedUsd + worst > opts.maxUsd + 1e-12) {
          throw new ScopeBudgetError(`the next scope attempt would take this run above $${opts.maxUsd} (charged $${chargedUsd.toFixed(6)}); stopped`);
        }
        const reservation = await gate.reserve({ category: 'evaluation', usd: worst, purpose: `${opts.purpose}-${item.id}-s${sample}-a${attempt}` });
        attempts += 1;
        reservedUsd += worst;
        const t0 = Date.now();
        let result: Awaited<ReturnType<LlmProvider['scope']>> | null = null;
        let failure: unknown = null;
        try {
          result = await provider.scope(scopeInput(req), stageCtx('scope', AbortSignal.timeout(timeoutMs), timeoutMs));
        } catch (err) {
          failure = err;
        }
        const ms = Date.now() - t0;
        const tokens = (u: StageUsage) => u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens;
        if (result) {
          const cost = stageCostUsd(model, result.usage);
          await gate.settle(reservation, { usd: cost, tokens: tokens(result.usage) });
          chargedUsd += cost;
          promptVersion = result.promptVersion;
          const intent = resolveIntent(req, result.output);
          record.status = 'ok';
          record.intent = result.output.intent;
          record.plannerKeywordText = result.output.keywordText;
          record.keywordText = intent.keywordText;
          record.plannerFilters = result.output.filters;
          record.attempts.push({ attempt, status: 'ok', category: null, billing: 'usage', reservedUsd: worst, chargedUsd: cost, usage: result.usage, ms });
          break;
        }
        let billing: ScopeAttempt['billing'] = 'uncertain';
        let charged = worst;
        let usage: StageUsage | null = null;
        if (failure instanceof StageError && failure.billing.kind === 'usage') {
          billing = 'usage';
          usage = failure.billing.usage;
          charged = stageCostUsd(model, usage);
          await gate.settle(reservation, { usd: charged, tokens: tokens(usage) });
        } else if (failure instanceof StageError && failure.billing.kind === 'none') {
          billing = 'none';
          charged = 0;
          await gate.settle(reservation, { usd: 0 });
        } else {
          await gate.settle(reservation, 'uncertain');
        }
        chargedUsd += charged;
        const category = failure instanceof StageError ? failure.category : 'unexpected';
        record.attempts.push({ attempt, status: 'failed', category, billing, reservedUsd: worst, chargedUsd: charged, usage, ms });
        log(`scope ${item.id} sample ${sample} attempt ${attempt} failed: ${category}`);
      }
      out.push(record);
      log(`scope ${item.id} sample ${sample}: ${record.status}`);
    }
  }
  return { model, promptVersion, samples: out, reservedUsd, chargedUsd, attempts };
}
