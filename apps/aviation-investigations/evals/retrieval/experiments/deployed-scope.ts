/**
 * The scope stage request as the deployed brief pipeline sends it, for E3 (task 10d,
 * phase A, amendment 1 of `PREREG.md`).
 *
 * This branch's adapter caps the scope input at 2,600 tokens, below the scope request's
 * fixed size (about 3,200 tokens counted by the provider: system prompt plus
 * structured-output schema), so it refuses every scope call before sending it. The
 * deployed branch recalibrated the caps with the provider's counter to 6,500 input and
 * 600 output tokens and a 5,500-token cached prefix. Prompt (`scope.v2`), schema,
 * renderer, model settings and request shape are the same in both branches.
 *
 * So this caller sends exactly the request the adapter builds (the production system
 * prompt with its cache marker, the rendered user turn, the production structured-output
 * format, effort `low`, the model's thinking setting, no retries), with the deployed
 * caps: it counts the request first (free) and refuses one above the input cap, then
 * generates with `max_tokens` at the output cap. Failures are mapped as the adapter maps
 * them (`StageError` with its billing: `usage` for a billed response, `none` when
 * nothing can have been billed, `uncertain` otherwise). The CLI checks, for every
 * question and for free, that this request counts exactly as many tokens as the
 * production adapter's.
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
} from '@anthropic-ai/sdk';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL_SETTINGS,
  STAGE_THINKING,
  outputFormat,
  thinkingParam,
  type AnthropicMessagesClient,
} from '../../../server/ai/anthropic.js';
import { llmPrice } from '../../../server/ai/pricing.js';
import { renderScopeUser, SCOPE_PROMPT_VERSION, SCOPE_SYSTEM } from '../../../server/ai/prompts/scope.v2.js';
import {
  ScopeInputSchema,
  ScopeOutputSchema,
  StageError,
  type ScopeInput,
  type ScopeOutput,
  type StageErrorInfo,
  type StageResult,
  type StageUsage,
} from '../../../server/ai/provider.js';
import type { ScopeCaller } from './scope.js';

/** The deployed branch's scope caps (calibrated with the provider's counter on 2026-10-22). */
export const DEPLOYED_SCOPE_CAPS = Object.freeze({ input: 6_500, output: 600 });
/** The deployed branch's largest cached prefix. */
export const DEPLOYED_CACHED_PREFIX_MAX = 5_500;

type Meta = Omit<StageErrorInfo, 'billing'>;

function isAbort(err: unknown): boolean {
  return (
    err instanceof APIUserAbortError ||
    err instanceof APIConnectionTimeoutError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  );
}

/** The adapter's mapping of a failed generation call. */
function mapError(err: unknown, meta: Meta): StageError {
  if (err instanceof StageError) return err;
  const fail = (category: StageError['category'], billing: StageErrorInfo['billing'], status?: number) => new StageError(category, { ...meta, billing, status, cause: err });
  if (isAbort(err)) return fail('timeout', { kind: 'uncertain' });
  if (err instanceof APIConnectionError) return fail('network', { kind: 'uncertain' });
  if (err instanceof RateLimitError) return fail('rate_limited', { kind: 'none' }, err.status);
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) return fail('auth', { kind: 'none' }, err.status);
  if (err instanceof BadRequestError || err instanceof NotFoundError || err instanceof UnprocessableEntityError) return fail('bad_request', { kind: 'none' }, err.status);
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 529) return fail('overloaded', { kind: 'none' }, status);
    if (status !== undefined && status < 500) return fail('provider_error', { kind: 'none' }, status);
    return fail('provider_error', { kind: 'uncertain' }, status);
  }
  return fail('unexpected', { kind: 'uncertain' });
}

function normalizeUsage(u: Anthropic.Messages.Usage): StageUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

/** The scope request the adapter builds for `input` (everything but `max_tokens`). */
export function scopeRequestBody(model: string, input: ScopeInput) {
  const thinking = thinkingParam(model, STAGE_THINKING.scope);
  return {
    model,
    system: [{ type: 'text' as const, text: SCOPE_SYSTEM, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user' as const, content: renderScopeUser(input) }],
    output_config: { format: outputFormat(ScopeOutputSchema), effort: 'low' as const },
    ...(thinking ? { thinking } : {}),
  };
}

/** A scope caller with the deployed caps (module comment). `client` is for tests. */
export function createDeployedScopeCaller(cfg: { model: string; apiKey?: string; client?: AnthropicMessagesClient }): ScopeCaller {
  if (!Object.hasOwn(ANTHROPIC_MODEL_SETTINGS, cfg.model) || llmPrice(cfg.model).provider !== 'anthropic') {
    throw new Error(`Model '${cfg.model}' is not an allowlisted Anthropic model`);
  }
  if (!cfg.client && !cfg.apiKey) throw new Error('ANTHROPIC_API_KEY is required');
  const client: AnthropicMessagesClient =
    cfg.client ??
    new Anthropic({
      apiKey: cfg.apiKey,
      authToken: null,
      baseURL: ANTHROPIC_BASE_URL,
      maxRetries: 0,
      logLevel: 'warn',
      openTelemetry: { propagation: false, traces: { contentMode: 'metadata_only' } },
    });
  const meta: Meta = { stage: 'scope', provider: 'anthropic', model: cfg.model, promptVersion: SCOPE_PROMPT_VERSION };
  const fail = (category: StageError['category'], billing: StageErrorInfo['billing'], extra: Partial<Meta> = {}) => new StageError(category, { ...meta, ...extra, billing });

  function prepare(raw: ScopeInput, timeoutMs: number) {
    const parsed = ScopeInputSchema.safeParse(raw);
    if (!parsed.success || !(timeoutMs > 0)) throw fail('invalid_input', { kind: 'none' });
    const deadline = Date.now() + timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const options = () => ({ timeout: Math.max(1, deadline - Date.now()), signal, maxRetries: 0 });
    return { body: scopeRequestBody(cfg.model, parsed.data), signal, options };
  }

  async function count(p: ReturnType<typeof prepare>): Promise<number> {
    let tokens: number;
    try {
      tokens = (await client.messages.countTokens(p.body, p.options())).input_tokens;
    } catch (err) {
      throw fail(isAbort(err) ? 'timeout' : 'count_failed', { kind: 'none' }, { status: err instanceof APIError ? err.status : undefined, cause: err });
    }
    if (!Number.isInteger(tokens) || tokens < 0) throw fail('count_failed', { kind: 'none' });
    return tokens;
  }

  return {
    model: cfg.model,
    caps: DEPLOYED_SCOPE_CAPS,
    cachedPrefixMax: DEPLOYED_CACHED_PREFIX_MAX,
    count: async (input, timeoutMs) => count(prepare(input, timeoutMs)),
    async call(input, timeoutMs): Promise<StageResult<ScopeOutput>> {
      const p = prepare(input, timeoutMs);
      const counted = await count(p);
      const after: Partial<Meta> = { countedInputTokens: counted };
      if (counted > DEPLOYED_SCOPE_CAPS.input) throw fail('cap_exceeded', { kind: 'none' }, after);
      if (p.signal.aborted) throw fail('timeout', { kind: 'none' }, after);
      let message;
      try {
        message = await client.messages.parse({ ...p.body, max_tokens: DEPLOYED_SCOPE_CAPS.output }, p.options());
      } catch (err) {
        throw mapError(err, { ...meta, ...after });
      }
      const usage = normalizeUsage(message.usage);
      const billed = { kind: 'usage', usage } as const;
      const stopReason = message.stop_reason;
      if (stopReason === 'refusal') throw fail('refusal', billed, { ...after, stopReason });
      if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') throw fail('truncated', billed, { ...after, stopReason });
      if (stopReason !== 'end_turn') throw fail('invalid_output', billed, { ...after, stopReason });
      if (usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens > DEPLOYED_SCOPE_CAPS.input) throw fail('cap_exceeded', billed, { ...after, stopReason });
      const output = message.parsed_output;
      if (output === null || output === undefined) throw fail('invalid_output', billed, { ...after, stopReason });
      return { output, usage, provider: 'anthropic', model: cfg.model, promptVersion: SCOPE_PROMPT_VERSION, stopReason, warnings: [] };
    },
  };
}
