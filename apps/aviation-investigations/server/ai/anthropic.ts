/**
 * Anthropic adapter for the language-model stages (DESIGN §6 and §9 "Anthropic call
 * settings"): structured outputs through `messages.parse`, each stage's effort
 * (`STAGE_EFFORT`: `low`, `medium` for the check), thinking off wherever the model allows
 * it (adaptive for the check), a cached frozen system prompt, no retries, prefill, sampling
 * parameters, server tools or refusal fallbacks.
 */
import { EVIDENCE_SCOPE_CAPS } from './pricing.js';
import { EvidenceScopeInputSchema, EvidenceScopeWireOutputSchema, EVIDENCE_SCOPE_SYSTEM, EVIDENCE_SCOPE_VERSION, renderEvidenceScopeUser } from './prompts/scope.e1.js';
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
  type AutoParseableOutputFormat,
} from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { llmPrice } from './pricing.js';
import { CHECK_PROMPT_VERSION, CHECK_SYSTEM, renderCheckUser } from './prompts/check.v9.js';
import { COMPOSE_PROMPT_VERSION, COMPOSE_SYSTEM, renderComposeUser } from './prompts/compose.v8.js';
import { renderScopeUser, SCOPE_PROMPT_VERSION, SCOPE_SYSTEM } from './prompts/scope.v2.js';
import {
  CheckInputSchema,
  CheckOutputSchema,
  ComposeInputSchema,
  ComposeOutputSchema,
  isValidStageCtx,
  ScopeInputSchema,
  ScopeOutputSchema,
  STAGE_ROLE,
  StageError,
  type LlmProvider,
  type LlmStage,
  type StageCtx,
  type StageErrorInfo,
  type StageInputs,
  type StageModels,
  type StageResult,
  type StageUsage,
  usageWarnings,
} from './provider.js';

type ThinkingParam = Anthropic.Messages.ThinkingConfigParam;

/**
 * Per-model request settings; a model missing here cannot be configured. `off` is how the
 * model turns thinking off; a model without it cannot.
 * - Opus 5.5 cannot disable thinking (`disabled` is a 400), so `thinking` is omitted
 *   and effort `low` bounds it. Its default effort is `medium`, so effort is always sent.
 * - Sonnet 5.5 turns thinking off with `between_tools` (effort `high` or below).
 * - Haiku 5.5 accepts `disabled` at effort `high` or below.
 * Budgeted thinking (`budget_tokens`) is a 400 on all three: the only allowance is the
 * stage's output cap, which holds the visible output at its schema bounds plus the
 * thinking room that stage's calibration measured.
 */
export const ANTHROPIC_MODEL_SETTINGS: Readonly<Record<string, { readonly off?: ThinkingParam }>> = {
  'claude-opus-5-5': {},
  'claude-sonnet-5-5': { off: { type: 'between_tools' } },
  'claude-haiku-5-5': { off: { type: 'disabled' } },
};

/**
 * A stage's thinking: `off` where the model can turn it off, or `adaptive` (the model
 * decides how much to think, within the stage's output cap, at effort `low`).
 */
export type ThinkingMode = 'off' | 'adaptive';

/**
 * Each stage's thinking. The answer stage runs on Opus, which cannot turn thinking off:
 * it thinks at effort `low` within the answer output cap's thinking allowance. The check
 * stage thinks adaptively: Haiku 5.5 with adaptive thinking, at the effort the checker
 * calibration selected (`STAGE_EFFORT.check`: `medium` since Task 16e, selection.v3; `low`
 * in 16c and 16d, evals/checker). Without thinking, Haiku withheld 20 of 21 wholly
 * supported development briefs and passed 6 of 8 critical regressions in 16c. A change
 * needs the calibration and the check output cap's thinking allowance re-measured.
 */
export const STAGE_THINKING: Readonly<Record<LlmStage, ThinkingMode>> = {
  scope: 'off',
  compose: 'off',
  check: 'adaptive',
};

/** A stage's effort (`output_config.effort`). */
export type Effort = 'low' | 'medium';

/**
 * Each stage's effort. `low` for scope and compose; `medium` for the check, the checker
 * calibration's frozen selection (evals/checker/selection.v3.json, protocol v3.1: chosen by
 * the pre-registered fallback order over `low`; a unit test holds production to it). A
 * change needs the calibration, the caps and the timeouts re-measured. Haiku 5.5's default
 * effort is `medium`, so effort is always sent.
 */
export const STAGE_EFFORT: Readonly<Record<LlmStage, Effort>> = {
  scope: 'low',
  compose: 'low',
  check: 'medium',
};

/** The request's `thinking` parameter for a model and mode, or undefined to omit it. */
export function thinkingParam(model: string, mode: ThinkingMode): ThinkingParam | undefined {
  const settings = ANTHROPIC_MODEL_SETTINGS[model];
  if (!settings) return undefined;
  if (mode === 'off') return settings.off;
  // Opus thinks adaptively when `thinking` is omitted; the others are asked to.
  return settings.off ? { type: 'adaptive' } : undefined;
}

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** The check prompt production sends (version and system text): what the checker calibration ties to its frozen selection. */
export const PRODUCTION_CHECK_PROMPT = { version: CHECK_PROMPT_VERSION, system: CHECK_SYSTEM } as const;

/** The part of the SDK client the adapter uses; tests inject their own. */
export type AnthropicMessagesClient = Pick<Anthropic, 'messages'>;

export interface AnthropicProviderConfig {
  /** Required unless `client` is given. */
  apiKey?: string;
  models: StageModels;
  client?: AnthropicMessagesClient;
  /** Overrides of `STAGE_THINKING` (the checker calibration compares modes; production uses the defaults). */
  thinking?: Partial<Record<LlmStage, ThinkingMode>>;
  /** Overrides of `STAGE_EFFORT` (the checker calibration's frozen candidates; production uses the defaults). */
  effort?: Partial<Record<LlmStage, Effort>>;
}

interface StageSpec<I, O> {
  caps?: { readonly input: number; readonly output: number };
  stage: LlmStage;
  promptVersion: string;
  system: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  render: (input: I) => string;
}

type JsonNode = Record<string, unknown>;
const isNode = (v: unknown): v is JsonNode => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The SDK's schema transform moves `enum` into the description, leaving only
 * client-side validation. Structured outputs support `enum`, so put each one back
 * (walking the transformed and source schemas in parallel) and let constrained
 * decoding keep the model to the allowed codes.
 */
function restoreEnums(out: unknown, src: unknown): void {
  if (!isNode(out) || !isNode(src)) return;
  if (Array.isArray(src.enum) && out.type === 'string') {
    out.enum = src.enum;
    const note = `{enum: ${JSON.stringify(src.enum)}}`;
    if (out.description === note) delete out.description;
    else if (typeof out.description === 'string' && out.description.endsWith(`\n\n${note}`)) {
      out.description = out.description.slice(0, -note.length - 2);
    }
  }
  for (const key of ['properties', '$defs']) {
    const o = out[key];
    const s = src[key];
    if (isNode(o) && isNode(s)) for (const name of Object.keys(o)) restoreEnums(o[name], s[name]);
  }
  restoreEnums(out.items, src.items);
  for (const [o, s] of [
    [out.anyOf, src.anyOf ?? src.oneOf],
    [out.allOf, src.allOf],
  ]) {
    if (Array.isArray(o) && Array.isArray(s)) o.forEach((node, i) => restoreEnums(node, s[i]));
  }
}

/**
 * Structured-output format whose `parse` never throws: invalid JSON or a schema
 * violation yields `parsed_output: null`, so the adapter still sees `stop_reason`
 * and the billed usage. The SDK's own Zod helper throws and loses both. Exported for
 * the retrieval experiments, which send the scope request as the adapter builds it.
 */
export function outputFormat<O>(schema: z.ZodType<O>): AutoParseableOutputFormat<O | null> {
  const { type, schema: jsonSchema } = zodOutputFormat(schema);
  restoreEnums(jsonSchema, z.toJSONSchema(schema, { reused: 'ref' }));
  return {
    type,
    schema: jsonSchema,
    parse(content: string): O | null {
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch {
        return null;
      }
      const result = schema.safeParse(json);
      return result.success ? result.data : null;
    },
  };
}

function normalizeUsage(u: Anthropic.Messages.Usage): StageUsage {
  // The reasoning share of the output, when reported; `output_tokens` stays the billed total.
  const thinking = u.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    ...(typeof thinking === 'number' && Number.isSafeInteger(thinking) && thinking >= 0 ? { thinkingTokens: thinking } : {}),
  };
}

type Meta = Omit<StageErrorInfo, 'billing'>;
const NOT_BILLED = { kind: 'none' } as const;

function isAbort(err: unknown): boolean {
  return (
    err instanceof APIUserAbortError ||
    err instanceof APIConnectionTimeoutError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  );
}

/** Map an SDK failure of the generation call to a stage error. Check subclasses before `APIError`. */
function mapError(err: unknown, meta: Meta): StageError {
  if (err instanceof StageError) return err;
  const fail = (category: StageError['category'], billing: StageErrorInfo['billing'], status?: number) =>
    new StageError(category, { ...meta, billing, status, cause: err });
  if (isAbort(err)) return fail('timeout', { kind: 'uncertain' });
  if (err instanceof APIConnectionError) return fail('network', { kind: 'uncertain' });
  if (err instanceof RateLimitError) return fail('rate_limited', NOT_BILLED, err.status);
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return fail('auth', NOT_BILLED, err.status);
  }
  if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof UnprocessableEntityError) {
    return fail('bad_request', NOT_BILLED, err.status);
  }
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 529) return fail('overloaded', NOT_BILLED, status);
    if (status !== undefined && status < 500) return fail('provider_error', NOT_BILLED, status);
    return fail('provider_error', { kind: 'uncertain' }, status);
  }
  return fail('unexpected', { kind: 'uncertain' });
}

/** A failed token count generated nothing: `timeout` when the deadline ended it, else `count_failed`. */
function mapCountError(err: unknown, meta: Meta): StageError {
  if (err instanceof StageError) return err;
  const status = err instanceof APIError ? err.status : undefined;
  const category = isAbort(err) ? 'timeout' : 'count_failed';
  return new StageError(category, { ...meta, billing: NOT_BILLED, status, cause: err });
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts. The SDK also stops on
 * abort; this makes the deadline hold even if a body read ignores it.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new APIUserAbortError());
    if (signal.aborted) {
      promise.catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * The SDK client the adapter uses. `maxRetries` is 0 by default and for every client
 * that may generate: the SDK would retry a generation on its own, and each attempt could
 * be billed under the one reservation the request holds. Only a client that never
 * generates may pass retries: the count-only client of `pnpm worker ai-preflight`. The
 * adapter's own requests override the client either way (`maxRetries: 0` per request), so
 * a stage's count and generation are never retried; the client's setting reaches only
 * calls made outside the adapter, such as the preflight's plain text counts.
 */
export function createAnthropicClient(apiKey: string, opts: { maxRetries?: number } = {}): Anthropic {
  return new Anthropic({
    apiKey,
    // Explicit values so ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and ANTHROPIC_LOG
    // in the environment cannot add credentials, redirect requests or log bodies.
    authToken: null,
    baseURL: ANTHROPIC_BASE_URL,
    maxRetries: opts.maxRetries ?? 0,
    logLevel: 'warn',
    // Spans never carry prompt or output text; tracing is wired by the app.
    openTelemetry: { propagation: false, traces: { contentMode: 'metadata_only' } },
  });
}

/** The JSON schema the adapter sends as a stage's structured-output format. */
export function outputJsonSchema(schema: z.ZodType): unknown {
  return outputFormat(schema).schema;
}

export function createAnthropicProvider(cfg: AnthropicProviderConfig): LlmProvider {
  for (const role of ['scope', 'answer', 'check'] as const) {
    const model = cfg.models[role];
    if (!Object.hasOwn(ANTHROPIC_MODEL_SETTINGS, model) || llmPrice(model).provider !== 'anthropic') {
      throw new Error(`Model '${model}' is not an allowlisted Anthropic model`);
    }
  }
  if (!cfg.client && !cfg.apiKey) throw new Error('ANTHROPIC_API_KEY is required');

  const client: AnthropicMessagesClient = cfg.client ?? createAnthropicClient(cfg.apiKey!);

  function stage<I, O>(spec: StageSpec<I, O>) {
    const format = outputFormat(spec.output);
    const role = STAGE_ROLE[spec.stage];
    const model = cfg.models[role];
    const thinking = thinkingParam(model, cfg.thinking?.[spec.stage] ?? STAGE_THINKING[spec.stage]);
    const effort = cfg.effort?.[spec.stage] ?? STAGE_EFFORT[spec.stage];
    const meta: Meta = { stage: spec.stage, provider: 'anthropic', model, promptVersion: spec.promptVersion };
    const fail = (category: StageError['category'], billing: StageErrorInfo['billing'], extra?: Partial<Meta>) =>
      new StageError(category, { ...meta, ...extra, billing });
    const system = [{ type: 'text' as const, text: spec.system, cache_control: { type: 'ephemeral' as const } }];

    /** Everything but `max_tokens`; the token count and the generation send the same request. */
    const request = (input: I) => ({
      model,
      system,
      messages: [{ role: 'user' as const, content: spec.render(input) }],
      output_config: { format, effort },
      ...(thinking ? { thinking } : {}),
    });

    /** Validate, then bound the whole stage call by the caller's signal and `timeoutMs`. */
    function prepare(rawInput: I, ctx: StageCtx) {
      if (!isValidStageCtx(spec.stage, ctx, spec.caps)) throw fail('invalid_input', NOT_BILLED);
      const parsed = spec.input.safeParse(rawInput);
      if (!parsed.success) throw fail('invalid_input', NOT_BILLED);
      if (ctx.signal.aborted) throw fail('timeout', NOT_BILLED);
      const deadline = Date.now() + ctx.timeoutMs;
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]);
      // Every stage request, the free count included, passes `maxRetries: 0`, which overrides
      // the client's setting: a stage never retries (a generation attempt would need its own
      // reservation), whatever client was injected.
      const options = () => ({ timeout: Math.max(1, deadline - Date.now()), signal, maxRetries: 0 });
      return { body: request(parsed.data), signal, options };
    }

    async function count({ body, signal, options }: ReturnType<typeof prepare>): Promise<number> {
      let tokens: number;
      try {
        tokens = (await untilAborted(client.messages.countTokens(body, options()), signal)).input_tokens;
      } catch (err) {
        throw mapCountError(err, meta);
      }
      if (!Number.isInteger(tokens) || tokens < 0) throw fail('count_failed', NOT_BILLED);
      return tokens;
    }

    async function run(rawInput: I, ctx: StageCtx): Promise<StageResult<O>> {
      const prepared = prepare(rawInput, ctx);
      const counted = await count(prepared);
      const after: Partial<Meta> = { countedInputTokens: counted };
      if (counted > ctx.maxInputTokens) throw fail('cap_exceeded', NOT_BILLED, after);
      // Stopped while counting (cancel, shutdown or the deadline): the paid call is never sent.
      if (prepared.signal.aborted) throw fail('timeout', NOT_BILLED, after);

      let message;
      try {
        message = await untilAborted(
          client.messages.parse({ ...prepared.body, max_tokens: ctx.maxOutputTokens }, prepared.options()),
          prepared.signal,
        );
      } catch (err) {
        throw mapError(err, { ...meta, ...after });
      }

      const usage = normalizeUsage(message.usage);
      const billed = { kind: 'usage', usage } as const;
      const stopReason = message.stop_reason;
      const warnings = usageWarnings(usage);
      const responded = { ...after, stopReason, warnings };
      if (stopReason === 'refusal') {
        const refusalCategory = message.stop_details?.category ?? null;
        throw fail('refusal', billed, { ...responded, refusalCategory });
      }
      if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
        throw fail('truncated', billed, responded);
      }
      if (stopReason !== 'end_turn') throw fail('invalid_output', billed, responded);
      // Backstop: the count should already have stopped this.
      if (usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens > ctx.maxInputTokens) {
        throw fail('cap_exceeded', billed, responded);
      }
      const output = message.parsed_output;
      if (output === null || output === undefined) throw fail('invalid_output', billed, responded);

      return { output, usage, provider: 'anthropic', model, promptVersion: spec.promptVersion, stopReason, warnings };
    }

    return { run, countInputTokens: async (rawInput: I, ctx: StageCtx) => count(prepare(rawInput, ctx)) };
  }

  const evidenceScope = stage({
    caps: EVIDENCE_SCOPE_CAPS,
    stage: 'scope', promptVersion: EVIDENCE_SCOPE_VERSION, system: EVIDENCE_SCOPE_SYSTEM,
    input: EvidenceScopeInputSchema, output: EvidenceScopeWireOutputSchema, render: renderEvidenceScopeUser,
  });
  const scope = stage({
    stage: 'scope',
    promptVersion: SCOPE_PROMPT_VERSION,
    system: SCOPE_SYSTEM,
    input: ScopeInputSchema,
    output: ScopeOutputSchema,
    render: renderScopeUser,
  });
  const compose = stage({
    stage: 'compose',
    promptVersion: COMPOSE_PROMPT_VERSION,
    system: COMPOSE_SYSTEM,
    input: ComposeInputSchema,
    output: ComposeOutputSchema,
    render: renderComposeUser,
  });
  const check = stage({
    stage: 'check',
    promptVersion: CHECK_PROMPT_VERSION,
    system: CHECK_SYSTEM,
    input: CheckInputSchema,
    output: CheckOutputSchema,
    render: renderCheckUser,
  });
  const counters = {
    scope: scope.countInputTokens,
    compose: compose.countInputTokens,
    check: check.countInputTokens,
  };

  return {
    name: 'anthropic',
    models: { ...cfg.models },
    countInputTokens<S extends LlmStage>(name: S, input: StageInputs[S], ctx: StageCtx): Promise<number> {
      return (counters[name] as (i: StageInputs[S], c: StageCtx) => Promise<number>)(input, ctx);
    },
    evidenceScope: async (input, ctx) => {
      const result = await evidenceScope.run(input, ctx);
      return { ...result, output: result.output.result };
    },
    countEvidenceScopeTokens: evidenceScope.countInputTokens,
    scope: scope.run,
    compose: compose.run,
    check: check.run,
  };
}
