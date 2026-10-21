/**
 * Anthropic adapter for the language-model stages (DESIGN §6 and §9 "Anthropic call
 * settings"): structured outputs through `messages.parse`, effort `low`, thinking
 * off wherever the model allows it, a cached frozen system prompt, no retries,
 * prefill, sampling parameters, server tools or refusal fallbacks.
 */
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
import { CHECK_PROMPT_VERSION, CHECK_SYSTEM, renderCheckUser } from './prompts/check.v1.js';
import { COMPOSE_PROMPT_VERSION, COMPOSE_SYSTEM, renderComposeUser } from './prompts/compose.v1.js';
import { renderScopeUser, SCOPE_PROMPT_VERSION, SCOPE_SYSTEM } from './prompts/scope.v1.js';
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
  type StageModels,
  type StageResult,
  type StageUsage,
} from './provider.js';

type ThinkingParam = Anthropic.Messages.ThinkingConfigParam;

/**
 * Per-model request settings; a model missing here cannot be configured.
 * - Opus 5.5 cannot disable thinking (`disabled` is a 400), so `thinking` is omitted
 *   and effort `low` bounds it. Its default effort is `medium`, so effort is always sent.
 * - Sonnet 5.5 turns thinking off with `between_tools` (effort `high` or below).
 * - Haiku 5.5 accepts `disabled` at effort `high` or below.
 */
export const ANTHROPIC_MODEL_SETTINGS: Readonly<Record<string, { readonly thinking?: ThinkingParam }>> = {
  'claude-opus-5-5': {},
  'claude-sonnet-5-5': { thinking: { type: 'between_tools' } },
  'claude-haiku-5-5': { thinking: { type: 'disabled' } },
};

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** The part of the SDK client the adapter uses; tests inject their own. */
export type AnthropicMessagesClient = Pick<Anthropic, 'messages'>;

export interface AnthropicProviderConfig {
  /** Required unless `client` is given. */
  apiKey?: string;
  models: StageModels;
  client?: AnthropicMessagesClient;
}

interface StageSpec<I, O> {
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
 * and the billed usage. The SDK's own Zod helper throws and loses both.
 */
function outputFormat<O>(schema: z.ZodType<O>): AutoParseableOutputFormat<O | null> {
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
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

type Meta = Omit<StageErrorInfo, 'billing'>;

/** Map an SDK failure to a stage error. Check subclasses before `APIError`. */
function mapError(err: unknown, meta: Meta): StageError {
  if (err instanceof StageError) return err;
  const fail = (category: StageError['category'], billing: StageErrorInfo['billing'], status?: number) =>
    new StageError(category, { ...meta, billing, status, cause: err });
  if (err instanceof APIUserAbortError || err instanceof APIConnectionTimeoutError) {
    return fail('timeout', { kind: 'uncertain' });
  }
  if (err instanceof Error && err.name === 'AbortError') return fail('timeout', { kind: 'uncertain' });
  if (err instanceof APIConnectionError) return fail('network', { kind: 'uncertain' });
  if (err instanceof RateLimitError) return fail('rate_limited', { kind: 'none' }, err.status);
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return fail('auth', { kind: 'none' }, err.status);
  }
  if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof UnprocessableEntityError) {
    return fail('bad_request', { kind: 'none' }, err.status);
  }
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 529) return fail('overloaded', { kind: 'none' }, status);
    if (status !== undefined && status < 500) return fail('provider_error', { kind: 'none' }, status);
    return fail('provider_error', { kind: 'uncertain' }, status);
  }
  return fail('unexpected', { kind: 'uncertain' });
}

export function createAnthropicProvider(cfg: AnthropicProviderConfig): LlmProvider {
  for (const role of ['scope', 'answer', 'check'] as const) {
    const model = cfg.models[role];
    if (!Object.hasOwn(ANTHROPIC_MODEL_SETTINGS, model) || llmPrice(model).provider !== 'anthropic') {
      throw new Error(`Model '${model}' is not an allowlisted Anthropic model`);
    }
  }
  if (!cfg.client && !cfg.apiKey) throw new Error('ANTHROPIC_API_KEY is required');

  const client: AnthropicMessagesClient =
    cfg.client ??
    new Anthropic({
      apiKey: cfg.apiKey,
      // Explicit values so ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and ANTHROPIC_LOG
      // in the environment cannot add credentials, redirect requests or log bodies.
      authToken: null,
      baseURL: ANTHROPIC_BASE_URL,
      maxRetries: 0,
      logLevel: 'warn',
      // Spans never carry prompt or output text; tracing is wired by the app.
      openTelemetry: { propagation: false, traces: { contentMode: 'metadata_only' } },
    });

  function stage<I, O>(spec: StageSpec<I, O>) {
    const format = outputFormat(spec.output);
    const role = STAGE_ROLE[spec.stage];
    const model = cfg.models[role];
    const { thinking } = ANTHROPIC_MODEL_SETTINGS[model] ?? {};
    const meta: Meta = { stage: spec.stage, provider: 'anthropic', model, promptVersion: spec.promptVersion };
    const fail = (category: StageError['category'], billing: StageErrorInfo['billing'], extra?: Partial<Meta>) =>
      new StageError(category, { ...meta, ...extra, billing });

    return async (rawInput: I, ctx: StageCtx): Promise<StageResult<O>> => {
      if (!isValidStageCtx(spec.stage, ctx)) throw fail('invalid_input', { kind: 'none' });
      const parsedInput = spec.input.safeParse(rawInput);
      if (!parsedInput.success) throw fail('invalid_input', { kind: 'none' });
      if (ctx.signal.aborted) throw fail('timeout', { kind: 'none' });

      let message;
      try {
        message = await client.messages.parse(
          {
            model,
            max_tokens: ctx.maxOutputTokens,
            system: [{ type: 'text', text: spec.system, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: spec.render(parsedInput.data) }],
            output_config: { format, effort: 'low' },
            ...(thinking ? { thinking } : {}),
          },
          // Retries stay off even for an injected client: each attempt would need its own reservation.
          { timeout: ctx.timeoutMs, signal: ctx.signal, maxRetries: 0 },
        );
      } catch (err) {
        throw mapError(err, meta);
      }

      const usage = normalizeUsage(message.usage);
      const billed = { kind: 'usage', usage } as const;
      const stopReason = message.stop_reason;
      if (stopReason === 'refusal') {
        throw fail('refusal', billed, { stopReason, refusalCategory: message.stop_details?.category ?? null });
      }
      if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
        throw fail('truncated', billed, { stopReason });
      }
      if (stopReason !== 'end_turn') throw fail('invalid_output', billed, { stopReason });
      if (usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens > ctx.maxInputTokens) {
        throw fail('cap_exceeded', billed, { stopReason });
      }
      const output = message.parsed_output;
      if (output === null || output === undefined) throw fail('invalid_output', billed, { stopReason });

      return { output, usage, provider: 'anthropic', model, promptVersion: spec.promptVersion, stopReason };
    };
  }

  return {
    name: 'anthropic',
    models: { ...cfg.models },
    scope: stage({
      stage: 'scope',
      promptVersion: SCOPE_PROMPT_VERSION,
      system: SCOPE_SYSTEM,
      input: ScopeInputSchema,
      output: ScopeOutputSchema,
      render: renderScopeUser,
    }),
    compose: stage({
      stage: 'compose',
      promptVersion: COMPOSE_PROMPT_VERSION,
      system: COMPOSE_SYSTEM,
      input: ComposeInputSchema,
      output: ComposeOutputSchema,
      render: renderComposeUser,
    }),
    check: stage({
      stage: 'check',
      promptVersion: CHECK_PROMPT_VERSION,
      system: CHECK_SYSTEM,
      input: CheckInputSchema,
      output: CheckOutputSchema,
      render: renderCheckUser,
    }),
  };
}
