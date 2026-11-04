/**
 * Deterministic provider for tests (`AI_LLM_PROVIDER=fake`, NODE_ENV=test only).
 * It applies the same input bounds, context caps, pre-send token cap and output
 * schemas as the real adapter, so a pipeline test fails where production would.
 */
import { RerankInputSchema, RerankOutputSchema, RERANK_SYSTEM, RERANK_VERSION, renderRerankUser, type RerankInput, type RerankOutput } from './prompts/rerank.r1.js';
import { assertEvidenceRanking, type EvidenceRankingConfig } from '../evidence/ranking-config.js';
import { ATTRIBUTION_CAPS, EVIDENCE_SCOPE_CAPS } from './pricing.js';
import { AttributionInputSchema, AttributionOutputSchema, ATTRIBUTION_SYSTEM, ATTRIBUTION_VERSION, renderAttributionUser, type AttributionInput, type AttributionOutput } from './prompts/attribution.a2.js';
import { automaticCandidates, normalizedQuestion } from '../../shared/automatic-candidates.js';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { ACCIDENT_CLASS, candidateValues } from '../evidence/attribution.js';
import { EvidenceScopeInputSchema, EvidenceScopeOutputSchema, EVIDENCE_SCOPE_SYSTEM, EVIDENCE_SCOPE_VERSION, renderEvidenceScopeUser, type EvidenceScopeInput, type EvidenceScopeOutput } from './prompts/scope.e1.js';
import type { z } from 'zod';
import { CHECK_PROMPT_VERSION, CHECK_SYSTEM, renderCheckUser } from './prompts/check.v9.js';
import { COMPOSE_PROMPT_VERSION, COMPOSE_SYSTEM, renderComposeUser } from './prompts/compose.v8.js';
import { renderScopeUser, SCOPE_PROMPT_VERSION, SCOPE_SYSTEM } from './prompts/scope.v2.js';
import {
  ATTRIBUTION_MODEL,
  CheckInputSchema,
  CheckOutputSchema,
  ComposeInputSchema,
  ComposeOutputSchema,
  isValidStageCtx,
  ScopeInputSchema,
  ScopeOutputSchema,
  STAGE_ROLE,
  StageError,
  type CheckInput,
  type CheckOutput,
  type ComposeInput,
  type ComposeOutput,
  type LlmProvider,
  type LlmStage,
  type ProviderStage,
  type ScopeInput,
  type ScopeOutput,
  type StageBilling,
  type StageCtx,
  type StageErrorCategory,
  type StageInputs,
  type StageModels,
  type StageResult,
  type StageUsage,
  usageWarnings,
} from './provider.js';

export const DEFAULT_FAKE_MODELS: StageModels = Object.freeze({
  scope: 'claude-haiku-5-5',
  answer: 'claude-opus-5-5',
  check: 'claude-haiku-5-5',
});

export const DEFAULT_FAKE_USAGE: Readonly<StageUsage> = Object.freeze({
  inputTokens: 1_000,
  outputTokens: 100,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
});

/**
 * What one call produces: an output (with optional usage) or a `StageError`. A billed
 * failure's stop reason defaults to the one the adapter maps to its category.
 */
export type FakeResult<O> =
  | { output: O; usage?: Partial<StageUsage> }
  | { fail: StageErrorCategory; billing?: StageBilling; refusalCategory?: string; stopReason?: string };

/**
 * One scripted call:
 * - a `FakeResult`;
 * - `{ hang: true }`: wait until the signal aborts or `timeoutMs` passes, then fail with `timeout`;
 * - a function of the input that returns a `FakeResult`.
 */
export type FakeStep<I, O> =
  | FakeResult<O>
  | { hang: true }
  | ((input: I, ctx: StageCtx) => FakeResult<O> | Promise<FakeResult<O>>);

/** A single step repeats for every call; an array is consumed in order and must not run out. */
export type FakeSteps<I, O> = FakeStep<I, O> | FakeStep<I, O>[];

export type FakeCounts = { [S in LlmStage]?: number | ((input: StageInputs[S]) => number) };

export interface FakeScript {
  rerank?: FakeSteps<RerankInput, RerankOutput>;
  rerankCounts?: number | ((input: RerankInput) => number);
  /** Unscripted, every candidate is approved: its accident class and the question's words for it (`approveCandidates`). */
  evidenceAttribution?: FakeSteps<AttributionInput, AttributionOutput>;
  attributionCounts?: number | ((input: AttributionInput) => number);
  models?: StageModels;
  /** Token counts per stage; the default is ceil(characters / 4) of system prompt plus user turn. */
  counts?: FakeCounts;
  scope?: FakeSteps<ScopeInput, ScopeOutput>;
  evidenceScope?: FakeSteps<EvidenceScopeInput, EvidenceScopeOutput>;
  compose?: FakeSteps<ComposeInput, ComposeOutput>;
  check?: FakeSteps<CheckInput, CheckOutput>;
}

export interface FakeCall {
  stage: ProviderStage;
  input: unknown;
}

export interface FakeProvider extends LlmProvider {
  /** Every stage call that passed input validation and the token cap, in order. */
  readonly calls: readonly FakeCall[];
}

const BILLED_ON_FAILURE: readonly StageErrorCategory[] = ['refusal', 'truncated', 'invalid_output', 'cap_exceeded'];
const UNCERTAIN_ON_FAILURE: readonly StageErrorCategory[] = ['timeout', 'network', 'provider_error', 'unexpected'];

const freshUsage = (over?: Partial<StageUsage>): StageUsage => ({ ...DEFAULT_FAKE_USAGE, ...over });

/** The stop reason of a billed failure, as the Anthropic adapter reads it. */
const FAILURE_STOP_REASON: Partial<Record<StageErrorCategory, string>> = {
  refusal: 'refusal',
  truncated: 'max_tokens',
  invalid_output: 'end_turn',
  cap_exceeded: 'end_turn',
};

function defaultBilling(category: StageErrorCategory): StageBilling {
  if (BILLED_ON_FAILURE.includes(category)) return { kind: 'usage', usage: freshUsage() };
  if (UNCERTAIN_ON_FAILURE.includes(category)) return { kind: 'uncertain' };
  return { kind: 'none' };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

interface FakeStageSpec<I, O> {
  caps?: { readonly input: number; readonly output: number };
  name: ProviderStage;
  model?: string;
  promptVersion: string;
  system: string;
  render: (input: I) => string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  steps: FakeSteps<I, O> | undefined;
  count: number | ((input: I) => number) | undefined;
}

/** The suggestion the candidate values came from (server/evidence/attribution.ts `candidateValues`). */
function suggestedFilters(input: AttributionInput): BriefFilters {
  const filters: BriefFilters = {};
  for (const c of input.candidates) {
    const code = c.id.slice(c.id.indexOf(':') + 1);
    if (c.field === 'state') (filters.state ??= []).push(code);
    else if (c.field === 'category') (filters.category ??= []).push(code);
    else {
      const v = c.value;
      const range = /^(\d{4}) to (\d{4})$/.exec(v), later = /^(\d{4}) or later$/.exec(v), earlier = /^(\d{4}) or earlier$/.exec(v), year = /^(\d{4})$/.exec(v);
      if (range) Object.assign(filters, { yearFrom: Number(range[1]), yearTo: Number(range[2]) });
      else if (later) filters.yearFrom = Number(later[1]);
      else if (earlier) filters.yearTo = Number(earlier[1]);
      else if (year) Object.assign(filters, { yearFrom: Number(year[1]), yearTo: Number(year[1]) });
    }
  }
  return filters;
}

/**
 * The default attribution answer: every value is about the accident itself, quoted as exactly its
 * witness in the question ("" when the candidate builder finds none).
 */
export function approveCandidates(input: AttributionInput): { output: AttributionOutput } {
  const text = normalizedQuestion(input.question);
  const values = automaticCandidates(input.question, suggestedFilters(input), {}).candidates.flatMap(candidateValues);
  return { output: { checks: input.candidates.map(c => {
    const w = values.find(v => v.id === c.id)?.witness;
    return { id: c.id, about: ACCIDENT_CLASS[c.field], quote: w ? text.slice(w.start, w.end).slice(0, 160) : '' };
  }) } };
}

export function createFakeProvider(script: FakeScript = {}): FakeProvider {
  const models = { ...(script.models ?? DEFAULT_FAKE_MODELS) };
  const calls: FakeCall[] = [];

  function stage<I, O>(spec: FakeStageSpec<I, O>) {
    const queue = Array.isArray(spec.steps) ? [...spec.steps] : undefined;
    const model = spec.name === 'rerank' || spec.name === 'attribution' ? spec.model! : models[STAGE_ROLE[spec.name]];
    const meta = { stage: spec.name, provider: 'fake', model, promptVersion: spec.promptVersion } as const;
    const fail = (
      category: StageErrorCategory,
      billing: StageBilling,
      extra?: { refusalCategory?: string; countedInputTokens?: number; stopReason?: string },
    ) =>
      new StageError(category, {
        ...meta,
        billing,
        ...extra,
        // A billed failure had a response: its stop reason and warnings, as the adapter reports them.
        ...(billing.kind === 'usage'
          ? { stopReason: extra?.stopReason ?? FAILURE_STOP_REASON[category] ?? null, warnings: usageWarnings(billing.usage) }
          : {}),
      });

    function prepare(rawInput: I, ctx: StageCtx): { input: I; tokens: number } {
      if (!isValidStageCtx(spec.name, ctx, spec.caps)) throw fail('invalid_input', { kind: 'none' });
      const parsed = spec.input.safeParse(rawInput);
      if (!parsed.success) throw fail('invalid_input', { kind: 'none' });
      if (ctx.signal.aborted) throw fail('timeout', { kind: 'none' });
      const c = spec.count;
      const tokens =
        typeof c === 'number'
          ? c
          : typeof c === 'function'
            ? c(parsed.data)
            : Math.ceil((spec.system.length + spec.render(parsed.data).length) / 4);
      return { input: parsed.data, tokens };
    }

    function nextStep(): FakeStep<I, O> {
      if (queue) {
        const step = queue.shift();
        if (step === undefined) throw new Error(`Fake provider: no scripted ${spec.name} step left`);
        return step;
      }
      if (spec.steps === undefined) throw new Error(`Fake provider: no ${spec.name} step scripted`);
      return spec.steps as FakeStep<I, O>;
    }

    async function run(rawInput: I, ctx: StageCtx): Promise<StageResult<O>> {
      const { input, tokens } = prepare(rawInput, ctx);
      const counted = { countedInputTokens: tokens };
      if (tokens > ctx.maxInputTokens) throw fail('cap_exceeded', { kind: 'none' }, counted);
      const step = nextStep();
      calls.push({ stage: spec.name, input });
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]);

      if ('hang' in step) {
        await waitForAbort(signal);
        throw fail('timeout', { kind: 'uncertain' }, counted);
      }
      const result = typeof step === 'function' ? await step(input, ctx) : step;
      if (signal.aborted) throw fail('timeout', { kind: 'uncertain' }, counted);
      if ('fail' in result) {
        const billing = result.billing ?? defaultBilling(result.fail);
        throw fail(result.fail, billing, {
          ...counted,
          ...(result.refusalCategory !== undefined ? { refusalCategory: result.refusalCategory } : {}),
          ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        });
      }

      const usage = freshUsage(result.usage);
      const valid = spec.output.safeParse(result.output);
      if (!valid.success) throw fail('invalid_output', { kind: 'usage', usage }, counted);
      return {
        output: valid.data,
        usage,
        provider: 'fake',
        model,
        promptVersion: spec.promptVersion,
        stopReason: 'end_turn',
        warnings: usageWarnings(usage),
      };
    }

    return { run, countInputTokens: async (rawInput: I, ctx: StageCtx) => prepare(rawInput, ctx).tokens };
  }

  const evidenceScope = stage({
    caps: EVIDENCE_SCOPE_CAPS,
    name: 'scope', promptVersion: EVIDENCE_SCOPE_VERSION, system: EVIDENCE_SCOPE_SYSTEM,
    input: EvidenceScopeInputSchema, output: EvidenceScopeOutputSchema, render: renderEvidenceScopeUser,
    steps: script.evidenceScope, count: undefined,
  });
  const attribution = stage({
    name: 'attribution', model: ATTRIBUTION_MODEL, caps: ATTRIBUTION_CAPS, promptVersion: ATTRIBUTION_VERSION,
    system: ATTRIBUTION_SYSTEM, render: renderAttributionUser, input: AttributionInputSchema, output: AttributionOutputSchema,
    steps: script.evidenceAttribution ?? approveCandidates, count: script.attributionCounts,
  });
  const scope = stage({
    name: 'scope',
    promptVersion: SCOPE_PROMPT_VERSION,
    system: SCOPE_SYSTEM,
    render: renderScopeUser,
    input: ScopeInputSchema,
    output: ScopeOutputSchema,
    steps: script.scope,
    count: script.counts?.scope,
  });
  const compose = stage({
    name: 'compose',
    promptVersion: COMPOSE_PROMPT_VERSION,
    system: COMPOSE_SYSTEM,
    render: renderComposeUser,
    input: ComposeInputSchema,
    output: ComposeOutputSchema,
    steps: script.compose,
    count: script.counts?.compose,
  });
  const check = stage({
    name: 'check',
    promptVersion: CHECK_PROMPT_VERSION,
    system: CHECK_SYSTEM,
    render: renderCheckUser,
    input: CheckInputSchema,
    output: CheckOutputSchema,
    steps: script.check,
    count: script.counts?.check,
  });
  const rerankers = new Map<string, ReturnType<typeof stage<RerankInput, RerankOutput>>>();
  function reranker(ranking: EvidenceRankingConfig) {
    assertEvidenceRanking(ranking);
    const c = ranking.rerank;
    if (!c) throw new Error('reranking is disabled in this configuration');
    const key = JSON.stringify(c);
    let r = rerankers.get(key);
    if (!r) {
      r = stage({ name: 'rerank', model: c.model, caps: c.caps, promptVersion: RERANK_VERSION,
        system: RERANK_SYSTEM, render: renderRerankUser, input: RerankInputSchema, output: RerankOutputSchema,
        steps: script.rerank, count: script.rerankCounts });
      rerankers.set(key, r);
    }
    return r;
  }
  const counters = {
    scope: scope.countInputTokens,
    compose: compose.countInputTokens,
    check: check.countInputTokens,
  };

  return {
    name: 'fake',
    rerank: (input, ctx, config) => reranker(config).run(input, ctx),
    countRerankTokens: (input, ctx, config) => reranker(config).countInputTokens(input, ctx),
    models,
    calls,
    countInputTokens<S extends LlmStage>(name: S, input: StageInputs[S], ctx: StageCtx): Promise<number> {
      return (counters[name] as (i: StageInputs[S], c: StageCtx) => Promise<number>)(input, ctx);
    },
    evidenceScope: evidenceScope.run,
    countEvidenceScopeTokens: evidenceScope.countInputTokens,
    evidenceAttribution: attribution.run,
    countEvidenceAttributionTokens: attribution.countInputTokens,
    scope: scope.run,
    compose: compose.run,
    check: check.run,
  };
}
