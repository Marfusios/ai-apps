/**
 * The app-owned language-model interface (DESIGN §9). Each pipeline stage takes a
 * bounded, typed input and returns a Zod-validated object with normalized usage,
 * provider, model and prompt version. Operators pick one provider per process
 * (`AI_LLM_PROVIDER`); there is no per-request routing or failover.
 */
import { z } from 'zod';
import { PHASE_GROUPS, type PhaseGroup } from '../../shared/codes.js';
import {
  ComposeOutputSchema,
  FAILURE_TYPES,
  GLYPH_KINDS,
  GROUP_KINDS,
  PassageIdSchema,
  SPEAKERS,
  type ComposeOutput,
} from '../../shared/contracts/briefs.js';
import { STAGE_CAPS } from './pricing.js';

export { ComposeOutputSchema, GLYPH_KINDS, GROUP_KINDS, type ComposeOutput };

/** `openai` is reserved for a future Responses API adapter; only `anthropic` and `fake` exist. */
export type LlmProviderName = 'anthropic' | 'openai' | 'fake';

/** Pipeline stages that call a language model. `compose` runs on the answer model. */
export type LlmStage = 'scope' | 'compose' | 'check';

export interface StageModels {
  readonly scope: string;
  readonly answer: string;
  readonly check: string;
}

/** Which model and caps each stage uses. */
export const STAGE_ROLE = { scope: 'scope', compose: 'answer', check: 'check' } as const satisfies Record<
  LlmStage,
  keyof StageModels
>;

export interface StageUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  /** All billed output, including thinking. */
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

/**
 * Non-fatal findings for logs and traces. `cache_write_over_prefix_max`: the provider
 * wrote more cache tokens than `CACHED_PREFIX_MAX`, the size the reservation assumes.
 */
export type StageWarning = 'cache_write_over_prefix_max';

export interface StageResult<T> {
  output: T;
  usage: StageUsage;
  provider: LlmProviderName;
  model: string;
  promptVersion: string;
  stopReason: string;
  warnings: StageWarning[];
}

export interface StageCtx {
  /**
   * Must be bound to the stage's deadline, e.g.
   * `AbortSignal.any([request.signal, AbortSignal.timeout(stageBudgetMs)])`. The SDK's
   * per-request `timeout` only covers waiting for response headers; this signal also
   * ends a stalled body read. Adapters add their own `timeoutMs` bound as a backstop.
   */
  signal: AbortSignal;
  /** Budget for the whole stage call in milliseconds (token count plus generation). */
  timeoutMs: number;
  /** Hard caps; never above `STAGE_CAPS` for the stage. */
  maxInputTokens: number;
  maxOutputTokens: number;
}

/** A context with the stage's hard caps from `STAGE_CAPS`. */
export function stageCtx(stage: LlmStage, signal: AbortSignal, timeoutMs: number): StageCtx {
  const caps = STAGE_CAPS[STAGE_ROLE[stage]];
  return { signal, timeoutMs, maxInputTokens: caps.input, maxOutputTokens: caps.output };
}

/** True when the context's caps are positive integers within `STAGE_CAPS` and the timeout is positive. */
export function isValidStageCtx(stage: LlmStage, ctx: StageCtx): boolean {
  const caps = STAGE_CAPS[STAGE_ROLE[stage]];
  const within = (n: number, max: number) => Number.isInteger(n) && n > 0 && n <= max;
  return (
    within(ctx.maxOutputTokens, caps.output) &&
    within(ctx.maxInputTokens, caps.input) &&
    Number.isFinite(ctx.timeoutMs) &&
    ctx.timeoutMs > 0
  );
}

// ---------------------------------------------------------------------------
// Vocabularies shared by the schemas and the prompts.

export const INTENTS = [
  'case_search',
  'case_comparison',
  'corpus_statistics',
  'needs_clarification',
  'out_of_scope',
  'operational_advice',
] as const;
export type Intent = (typeof INTENTS)[number];

export const AMBIGUITY_TYPES = ['timing_window', 'aircraft_category', 'phase', 'failure_type'] as const;
export type AmbiguityType = (typeof AMBIGUITY_TYPES)[number];

/** Whose words a quote gives; the compose output's `speaker`. */
export const ATTRIBUTIONS = SPEAKERS;

/**
 * Claim kinds the check stage judges (amendment A4: every claim type). `classification`
 * is the case's mechanical-evidence group; `maintenance`, `symptom` and `timing` are
 * its other DESIGN §3 dimensions; `attribution` is one quote's speaker and context;
 * `criterion` is a reader's criterion the case must meet (server template); `gap` is
 * a note on what a case's supplied passages do not show.
 */
export const CLAIM_KINDS = [
  'summary',
  'why',
  'classification',
  'maintenance',
  'symptom',
  'timing',
  'attribution',
  'criterion',
  'gap',
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CHECK_REASONS = [
  'not_supported',
  'contradicted',
  'overstated_certainty',
  'wrong_attribution',
  'wrong_aircraft',
  'timing_unsupported',
  'out_of_context',
  'out_of_scope',
] as const;

export const INJURY_CODES = ['FATL', 'SERS', 'MINR', 'NONE'] as const;
export const WEATHER_CODES = ['VMC', 'IMC'] as const;
export const LIGHT_CODES = ['DAYL', 'DAWN', 'DUSK', 'NITE', 'NDRK', 'NBRT'] as const;
/** NTSB `acft_category` codes offered to the planner; the server revalidates against facet values. */
export const AIRCRAFT_CATEGORY_CODES = [
  'AIR',
  'HELI',
  'GLI',
  'BALL',
  'GYRO',
  'PPAR',
  'WSFT',
  'PLFT',
  'ULTR',
  'BLIM',
  'RCKT',
] as const;
const PHASES = PHASE_GROUPS as readonly [PhaseGroup, ...PhaseGroup[]];

export const QUESTION_MAX_CHARS = 1_500;
export const MAX_CASES = 6;
export const MAX_PASSAGES = 12;

/** Shape bound only; the server's allowlist decides which numbers are valid. */
const CaseNumber = z.string().regex(/^[A-Z0-9]{6,16}$/);
const PassageId = PassageIdSchema;
/** A single token, so an ambiguity value can never carry free text. */
const ValueToken = z.string().regex(/^[A-Za-z0-9_]{1,40}$/);
const Question = z.string().min(1).max(QUESTION_MAX_CHARS);

// ---------------------------------------------------------------------------
// Stage outputs. Strict objects: unknown fields fail validation.

export const ScopeFiltersSchema = z.strictObject({
  phase: z.array(z.enum(PHASES)).max(PHASES.length).optional(),
  injury: z.array(z.enum(INJURY_CODES)).max(INJURY_CODES.length).optional(),
  conditions: z.array(z.enum(WEATHER_CODES)).max(WEATHER_CODES.length).optional(),
  light: z.array(z.enum(LIGHT_CODES)).max(LIGHT_CODES.length).optional(),
  category: z.array(z.enum(AIRCRAFT_CATEGORY_CODES)).max(AIRCRAFT_CATEGORY_CODES.length).optional(),
  state: z
    .array(z.string().regex(/^[A-Z]{2}$/))
    .max(10)
    .optional(),
  yearFrom: z.number().int().min(2008).max(2100).optional(),
  yearTo: z.number().int().min(2008).max(2100).optional(),
});
export type ScopeFilters = z.infer<typeof ScopeFiltersSchema>;

export const AmbiguitySchema = z.strictObject({
  type: z.enum(AMBIGUITY_TYPES),
  values: z.array(ValueToken).min(1).max(3),
});
export type Ambiguity = z.infer<typeof AmbiguitySchema>;

/**
 * Keyword text for the BM25 channel: plain words and short phrases separated by
 * spaces (letters, digits, spaces, apostrophes, hyphens, periods and slashes). Empty
 * for replies that search nothing.
 */
export const KeywordTextSchema = z
  .string()
  .max(200)
  .regex(/^(?:[\p{L}\p{N}][\p{L}\p{N} '\-./]*)?$/u, 'plain words only');

export const ScopeOutputSchema = z.strictObject({
  intent: z.enum(INTENTS),
  /** True when the question is about a mechanical, maintenance or equipment cause. */
  mechanicalCause: z.boolean(),
  filters: ScopeFiltersSchema,
  /** Search terms for the keyword channel: the question's key aviation terms and close synonyms. */
  keywordText: KeywordTextSchema,
  ambiguity: AmbiguitySchema.optional(),
  caseNumbers: z.array(CaseNumber).max(4).optional(),
});
export type ScopeOutput = z.infer<typeof ScopeOutputSchema>;

/** Failure-type readings the planner may offer (`ambiguity.type = failure_type`). */
export const FAILURE_TYPE_VALUES = FAILURE_TYPES;

export const CheckOutputSchema = z.strictObject({
  supported: z.boolean(),
  problems: z
    .array(z.strictObject({ claimIndex: z.number().int().min(0).max(99), reason: z.enum(CHECK_REASONS) }))
    .max(100),
});
export type CheckOutput = z.infer<typeof CheckOutputSchema>;

// ---------------------------------------------------------------------------
// Stage inputs, built by the server. Bounded so a stage never sends unbounded text.

/** A reading in effect: the planner's default, or one the reader chose (`pinned`). */
export const PriorReadingSchema = z.strictObject({
  type: z.enum(AMBIGUITY_TYPES),
  value: ValueToken,
  pinned: z.boolean(),
});
export type PriorReading = z.infer<typeof PriorReadingSchema>;

export const ScopeInputSchema = z.strictObject({
  /** The question, or for a text refinement the refinement text. */
  question: Question,
  /**
   * The server-owned state of the brief before this step (refinements only); never an
   * earlier answer. `question` is the brief's question and `refinement` the text
   * refinement in effect, if any.
   */
  prior: z
    .strictObject({
      question: Question,
      refinement: Question.optional(),
      intent: z.enum(INTENTS),
      filters: ScopeFiltersSchema,
      readings: z.array(PriorReadingSchema).max(AMBIGUITY_TYPES.length),
      caseNumbers: z.array(CaseNumber).max(MAX_CASES),
    })
    .optional(),
});
export type ScopeInput = z.infer<typeof ScopeInputSchema>;

const EvidencePassage = z.strictObject({
  passageId: PassageId,
  /** Section label, e.g. "Analysis" or "Probable cause". */
  section: z.string().min(1).max(60),
  scope: z.enum(['aircraft', 'event']),
  /** Server-built aircraft label for aircraft-scoped passages. */
  aircraft: z.string().min(1).max(120).optional(),
  text: z.string().min(1).max(8_000),
});
export type EvidencePassage = z.infer<typeof EvidencePassage>;

export const ComposeInputSchema = z
  .strictObject({
    question: Question,
    /** The refinement text of a text refinement step; the question stays the brief's question. */
    refinement: Question.optional(),
    mechanicalCause: z.boolean(),
    /** Server-rendered readings in effect, e.g. "Shortly = within 30 calendar days or 10 flight hours". */
    interpretations: z.array(z.string().min(1).max(200)).max(4),
    cases: z
      .array(
        z.strictObject({
          ntsbNo: CaseNumber,
          /** Server-built line: aircraft, place, date, phase. */
          header: z.string().min(1).max(400),
          passages: z.array(EvidencePassage).min(1).max(MAX_PASSAGES),
        }),
      )
      .min(1)
      .max(MAX_CASES),
  })
  .superRefine((input, ctx) => {
    const passages = input.cases.flatMap((c) => c.passages);
    if (passages.length > MAX_PASSAGES) ctx.addIssue({ code: 'custom', message: 'too many passages' });
    if (new Set(passages.map((p) => p.passageId)).size !== passages.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate passage id' });
    }
    if (new Set(input.cases.map((c) => c.ntsbNo)).size !== input.cases.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate case number' });
    }
  });
export type ComposeInput = z.infer<typeof ComposeInputSchema>;

/**
 * Bounded claim/citation pairs, every verified passage of every case the claims are
 * about, and the reader's criteria as server templates; never the question, the
 * planner output or earlier answers.
 */
export const CheckInputSchema = z
  .strictObject({
    criteria: z.array(z.string().min(1).max(200)).max(4),
    passages: z
      .array(EvidencePassage.extend({ ntsbNo: CaseNumber }))
      .min(1)
      .max(MAX_PASSAGES),
    claims: z
      .array(
        z.strictObject({
          kind: z.enum(CLAIM_KINDS),
          ntsbNo: CaseNumber.optional(),
          text: z.string().min(1).max(2_000),
          passageIds: z.array(PassageId).min(1).max(MAX_PASSAGES),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((input, ctx) => {
    const ids = new Set(input.passages.map((p) => p.passageId));
    if (ids.size !== input.passages.length) ctx.addIssue({ code: 'custom', message: 'duplicate passage id' });
    for (const claim of input.claims) {
      if (claim.passageIds.some((id) => !ids.has(id))) {
        ctx.addIssue({ code: 'custom', message: 'claim cites a passage that is not provided' });
        break;
      }
    }
  });
export type CheckInput = z.infer<typeof CheckInputSchema>;

// ---------------------------------------------------------------------------

export interface StageInputs {
  scope: ScopeInput;
  compose: ComposeInput;
  check: CheckInput;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly models: StageModels;
  /**
   * Input tokens the stage call would be billed for, counted with exactly the request
   * the stage would send (system prompt, user turn, output schema, thinking). Free but
   * rate-limited. Every stage call also counts first and refuses input above its cap.
   */
  countInputTokens<S extends LlmStage>(stage: S, input: StageInputs[S], ctx: StageCtx): Promise<number>;
  scope(input: ScopeInput, ctx: StageCtx): Promise<StageResult<ScopeOutput>>;
  compose(input: ComposeInput, ctx: StageCtx): Promise<StageResult<ComposeOutput>>;
  check(input: CheckInput, ctx: StageCtx): Promise<StageResult<CheckOutput>>;
}

export type StageErrorCategory =
  /** The per-request timeout fired or the caller aborted. */
  | 'timeout'
  | 'refusal'
  /** `max_tokens` or the context window ended the output. */
  | 'truncated'
  /** Missing, unparseable or schema-invalid output, or an unexpected stop reason. */
  | 'invalid_output'
  /** The counted (before sending; billing `none`) or reported (after; billed) input is above the stage cap. */
  | 'cap_exceeded'
  /** The pre-send token count failed; nothing was generated. */
  | 'count_failed'
  /** The server-built input or context broke a bound; nothing was sent. */
  | 'invalid_input'
  | 'rate_limited'
  | 'overloaded'
  | 'auth'
  | 'bad_request'
  | 'network'
  | 'provider_error'
  | 'unexpected';

/**
 * What a failed stage cost. `usage`: the provider returned a billed response.
 * `none`: nothing was billed. `uncertain`: the request may have been processed,
 * so settlement keeps the full reservation.
 */
export type StageBilling = { kind: 'usage'; usage: StageUsage } | { kind: 'none' } | { kind: 'uncertain' };

export interface StageErrorInfo {
  stage: LlmStage;
  provider: LlmProviderName;
  model: string;
  promptVersion: string;
  billing: StageBilling;
  stopReason?: string | null;
  /** Refusal category from `stop_details`; the explanation text is not kept. */
  refusalCategory?: string | null;
  status?: number;
  /** The pre-send token count, when one was made. */
  countedInputTokens?: number;
  cause?: unknown;
}

/** A failed stage. Messages name the stage and category only, never model or user text. */
export class StageError extends Error {
  override readonly name = 'StageError';
  readonly stage: LlmStage;
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly promptVersion: string;
  readonly billing: StageBilling;
  readonly stopReason: string | null;
  readonly refusalCategory: string | null;
  readonly status: number | null;
  readonly countedInputTokens: number | null;

  constructor(
    readonly category: StageErrorCategory,
    info: StageErrorInfo,
  ) {
    super(`${info.stage} stage failed: ${category}`, info.cause === undefined ? undefined : { cause: info.cause });
    this.stage = info.stage;
    this.provider = info.provider;
    this.model = info.model;
    this.promptVersion = info.promptVersion;
    this.billing = info.billing;
    this.stopReason = info.stopReason ?? null;
    this.refusalCategory = info.refusalCategory ?? null;
    this.status = info.status ?? null;
    this.countedInputTokens = info.countedInputTokens ?? null;
  }
}
