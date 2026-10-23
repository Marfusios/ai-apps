/**
 * Evaluation-only judge clients for Track N (task 10c protocol v4, section 3). They are
 * not part of the production provider path: the server's language-model adapter and its
 * stages are untouched, and nothing here is reachable from a request.
 *
 * A `JudgeCaller` sends one provider-neutral `JudgeRequest` (frozen system prompt, user
 * content blocks with cacheable prefixes, a structured output) with the judge's frozen
 * settings (`JudgeModelConfig`: model, thinking or reasoning, output cap), makes exactly
 * one attempt (no SDK retries: each attempt has its own ledger reservation), and either
 * returns the parsed output with its usage, or throws `JudgeCallError` with a category
 * and the billing of the attempt, mirroring the Anthropic adapter's classification:
 *
 * | failure | category | billing |
 * | --- | --- | --- |
 * | the caller's deadline or an abort | `timeout` | uncertain |
 * | no connection | `network` | uncertain |
 * | 429 | `rate_limited` | none |
 * | 401, 403 | `auth` | none |
 * | 400, 404, 422 | `bad_request` | none |
 * | 529 (Anthropic) | `overloaded` | none |
 * | other 4xx | `provider_error` | none |
 * | 5xx | `provider_error` | uncertain |
 * | input above the cap, before sending | `cap_exceeded` | none |
 * | a refusal | `refusal` | usage |
 * | the output cap reached | `truncated` | usage |
 * | output that does not parse into the schema | `invalid_output` | usage |
 * | anything else | `unexpected` | uncertain |
 *
 * - **Anthropic** (`createAnthropicJudge`): `messages.parse` with the structured-output
 *   format the adapter builds (`outputFormat`), effort and thinking from the config
 *   (`thinkingParam`), the system prompt and each cacheable block marked
 *   `cache_control: ephemeral`, and the provider's free token count first: a request
 *   above the input cap is refused unsent.
 * - **OpenAI** (`createOpenAIJudge`): the Responses API with a strict JSON schema
 *   (`strictJsonSchema`), the reasoning effort from the config, `store: false`, and
 *   explicit prompt caching: one breakpoint after each cacheable block, none elsewhere,
 *   so no request writes its case to the cache (gpt-5.6 bills cache writes at 1.25 times
 *   the input rate). Usage: ordinary input = `input_tokens` - `cached_tokens` -
 *   `cache_write_tokens`; reasoning tokens are part of `output_tokens` and are recorded.
 *   Whether the input-token counting endpoint is free is not documented, so the input is
 *   estimated locally (`o200k_base` with a margin) for the cap and the reservation, and
 *   the reported usage is checked against the cap afterwards.
 */
import Anthropic, {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
  APIError as AnthropicAPIError,
  APIUserAbortError as AnthropicAbortError,
  AuthenticationError as AnthropicAuthenticationError,
  BadRequestError as AnthropicBadRequestError,
  NotFoundError as AnthropicNotFoundError,
  PermissionDeniedError as AnthropicPermissionDeniedError,
  RateLimitError as AnthropicRateLimitError,
  UnprocessableEntityError as AnthropicUnprocessableEntityError,
} from '@anthropic-ai/sdk';
import OpenAI, {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIAbortError,
  AuthenticationError as OpenAIAuthenticationError,
  BadRequestError as OpenAIBadRequestError,
  NotFoundError as OpenAINotFoundError,
  PermissionDeniedError as OpenAIPermissionDeniedError,
  RateLimitError as OpenAIRateLimitError,
  UnprocessableEntityError as OpenAIUnprocessableEntityError,
} from 'openai';
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import type { z } from 'zod';
import { ANTHROPIC_BASE_URL, ANTHROPIC_MODEL_SETTINGS, outputFormat, thinkingParam, type AnthropicMessagesClient } from '../../../server/ai/anthropic.js';
import { llmPrice, stageCostUsd, stageWorstCaseUsd } from '../../../server/ai/pricing.js';
import type { JudgeRequest, OutputKind } from './prompts.js';
import { AnswerabilitySchema, ChunkVerdictSchema, VerdictSchema, strictJsonSchema } from './schemas.js';
import { canonicalJson } from './spec.js';

export type JudgeRole = 'judge-a' | 'judge-b' | 'adjudicator';

export interface JudgeModelConfig {
  role: JudgeRole;
  provider: 'anthropic' | 'openai';
  model: string;
  /** Anthropic: thinking off or adaptive, and the effort; OpenAI: the reasoning effort. */
  settings: { thinking?: 'off' | 'adaptive'; effort?: 'low' | 'medium' | 'high'; reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' };
  /** Output cap per call, thinking or reasoning included. */
  maxOutputTokens: number;
  /** Input cap per call (a request above it is refused unsent). */
  maxInputTokens: number;
}

/** The judge's identity in the cache key: provider, model and every frozen setting. */
export const judgeIdentity = (c: JudgeModelConfig): string =>
  `${c.provider}:${c.model}:${canonicalJson({ settings: c.settings, maxOutputTokens: c.maxOutputTokens, maxInputTokens: c.maxInputTokens })}`;

export interface JudgeUsage {
  /** Ordinary (uncached) input tokens. */
  inputTokens: number;
  /** Billed output tokens, thinking or reasoning included. */
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** The thinking or reasoning share of `outputTokens`, when reported. */
  reasoningTokens?: number;
}

export type JudgeFailureCategory =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'auth'
  | 'bad_request'
  | 'overloaded'
  | 'provider_error'
  | 'unexpected'
  | 'cap_exceeded'
  | 'count_failed'
  | 'refusal'
  | 'truncated'
  | 'invalid_output';

export type JudgeBilling = { kind: 'none' } | { kind: 'usage'; usage: JudgeUsage } | { kind: 'uncertain' };

/** A failed attempt: its category and how it is billed. Holds no provider message or content. */
export class JudgeCallError extends Error {
  constructor(
    readonly category: JudgeFailureCategory,
    readonly billing: JudgeBilling,
    readonly status?: number,
    readonly stopReason?: string,
  ) {
    super(`judge call failed: ${category}${status !== undefined ? ` (HTTP ${status})` : ''}`);
    this.name = 'JudgeCallError';
  }
}

export interface JudgeCallResult {
  output: unknown;
  usage: JudgeUsage;
  stopReason: string;
  /** Input tokens counted (Anthropic, free) or estimated (OpenAI) before sending. */
  inputTokens: number;
}

export interface JudgeCaller {
  readonly config: JudgeModelConfig;
  /** Input tokens of the request: the provider's free counter (Anthropic) or the local estimate (OpenAI). */
  inputTokens(req: JudgeRequest, timeoutMs: number): Promise<number>;
  /** Whether `inputTokens` is the provider's own count. */
  readonly countsWithProvider: boolean;
  /** One attempt; `counted` skips a second count when the caller already has it. */
  call(req: JudgeRequest, timeoutMs: number, counted?: number): Promise<JudgeCallResult>;
}

export const SCHEMAS: Readonly<Record<OutputKind, z.ZodType>> = { verdict: VerdictSchema, chunk: ChunkVerdictSchema, answerability: AnswerabilitySchema };
const SCHEMA_NAME: Readonly<Record<OutputKind, string>> = { verdict: 'verdict', chunk: 'chunk_verdict', answerability: 'answerability' };

/**
 * Claude Sonnet 5.5's published cache-read rate, USD per million tokens. The repository
 * row says 0.10 until task 16d's correction lands; costs here never use less.
 */
export const SONNET_CACHE_READ_USD = 0.2;

/** The actual cost of one call (the repository prices, with Sonnet cache reads at no less than the published rate). */
export const judgeCostUsd = (model: string, usage: JudgeUsage): number => {
  const base = stageCostUsd(model, usage);
  if (model !== 'claude-sonnet-5-5') return base;
  const row = llmPrice(model).cacheRead;
  return base + (Math.max(row, SONNET_CACHE_READ_USD) - row) * (usage.cacheReadTokens / 1e6);
};

/** The reservation of one attempt: its input tokens and the output cap at the full rates, plus the cache-write premium on its prefix. */
export const attemptReserveUsd = (c: Pick<JudgeModelConfig, 'model' | 'maxOutputTokens'>, inputTokens: number): number =>
  stageWorstCaseUsd(c.model, { input: inputTokens, output: c.maxOutputTokens }, inputTokens);

const timeoutSignal = (ms: number) => AbortSignal.timeout(ms);

// ---------------------------------------------------------------------------
// Anthropic

function anthropicFailure(err: unknown): JudgeCallError {
  if (err instanceof JudgeCallError) return err;
  if (err instanceof AnthropicAbortError || err instanceof AnthropicConnectionTimeoutError || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
    return new JudgeCallError('timeout', { kind: 'uncertain' });
  }
  if (err instanceof AnthropicConnectionError) return new JudgeCallError('network', { kind: 'uncertain' });
  if (err instanceof AnthropicRateLimitError) return new JudgeCallError('rate_limited', { kind: 'none' }, err.status);
  if (err instanceof AnthropicAuthenticationError || err instanceof AnthropicPermissionDeniedError) return new JudgeCallError('auth', { kind: 'none' }, err.status);
  if (err instanceof AnthropicBadRequestError || err instanceof AnthropicNotFoundError || err instanceof AnthropicUnprocessableEntityError) {
    return new JudgeCallError('bad_request', { kind: 'none' }, err.status);
  }
  if (err instanceof AnthropicAPIError) {
    const status = err.status;
    if (status === 529) return new JudgeCallError('overloaded', { kind: 'none' }, status);
    if (status !== undefined && status < 500) return new JudgeCallError('provider_error', { kind: 'none' }, status);
    return new JudgeCallError('provider_error', { kind: 'uncertain' }, status);
  }
  return new JudgeCallError('unexpected', { kind: 'uncertain' });
}

function anthropicUsage(u: Anthropic.Messages.Usage): JudgeUsage {
  const thinking = u.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    ...(typeof thinking === 'number' && Number.isSafeInteger(thinking) && thinking >= 0 ? { reasoningTokens: thinking } : {}),
  };
}

/** The Anthropic request for a judge request (everything but `max_tokens`). */
export function anthropicBody(c: JudgeModelConfig, req: JudgeRequest) {
  const thinking = thinkingParam(c.model, c.settings.thinking ?? 'off');
  return {
    model: c.model,
    system: [{ type: 'text' as const, text: req.system, cache_control: { type: 'ephemeral' as const } }],
    messages: [
      {
        role: 'user' as const,
        content: req.blocks.map((b) => ({ type: 'text' as const, text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}) })),
      },
    ],
    output_config: { format: outputFormat(SCHEMAS[req.output]), effort: c.settings.effort ?? 'low' },
    ...(thinking ? { thinking } : {}),
  };
}

export function createAnthropicJudge(c: JudgeModelConfig, opts: { apiKey?: string; client?: AnthropicMessagesClient }): JudgeCaller {
  if (c.provider !== 'anthropic' || !Object.hasOwn(ANTHROPIC_MODEL_SETTINGS, c.model) || llmPrice(c.model).provider !== 'anthropic') {
    throw new Error(`Model '${c.model}' is not an allowlisted Anthropic model`);
  }
  if (!opts.client && !opts.apiKey) throw new Error('ANTHROPIC_API_KEY is required');
  const client: AnthropicMessagesClient =
    opts.client ??
    new Anthropic({
      apiKey: opts.apiKey,
      authToken: null,
      baseURL: ANTHROPIC_BASE_URL,
      maxRetries: 0,
      logLevel: 'warn',
      openTelemetry: { propagation: false, traces: { contentMode: 'metadata_only' } },
    });
  const count = async (req: JudgeRequest, timeoutMs: number): Promise<number> => {
    let tokens: number;
    try {
      tokens = (await client.messages.countTokens(anthropicBody(c, req), { timeout: timeoutMs, signal: timeoutSignal(timeoutMs), maxRetries: 0 })).input_tokens;
    } catch (err) {
      const f = anthropicFailure(err);
      throw new JudgeCallError(f.category === 'timeout' ? 'timeout' : 'count_failed', { kind: 'none' }, f.status);
    }
    if (!Number.isInteger(tokens) || tokens < 0) throw new JudgeCallError('count_failed', { kind: 'none' });
    return tokens;
  };
  return {
    config: c,
    countsWithProvider: true,
    inputTokens: count,
    async call(req, timeoutMs, known) {
      const deadline = Date.now() + timeoutMs;
      const counted = known ?? (await count(req, timeoutMs));
      if (counted > c.maxInputTokens) throw new JudgeCallError('cap_exceeded', { kind: 'none' });
      const left = Math.max(1, deadline - Date.now());
      let message;
      try {
        message = await client.messages.parse({ ...anthropicBody(c, req), max_tokens: c.maxOutputTokens }, { timeout: left, signal: timeoutSignal(left), maxRetries: 0 });
      } catch (err) {
        throw anthropicFailure(err);
      }
      const usage = anthropicUsage(message.usage);
      const billed = { kind: 'usage', usage } as const;
      const stop = message.stop_reason ?? 'unknown';
      if (stop === 'refusal') throw new JudgeCallError('refusal', billed, undefined, stop);
      if (stop === 'max_tokens' || stop === 'model_context_window_exceeded') throw new JudgeCallError('truncated', billed, undefined, stop);
      if (stop !== 'end_turn') throw new JudgeCallError('invalid_output', billed, undefined, stop);
      if (usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens > c.maxInputTokens) throw new JudgeCallError('cap_exceeded', billed, undefined, stop);
      const output = message.parsed_output;
      if (output === null || output === undefined) throw new JudgeCallError('invalid_output', billed, undefined, stop);
      return { output, usage, stopReason: stop, inputTokens: counted };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI

function openAIFailure(err: unknown): JudgeCallError {
  if (err instanceof JudgeCallError) return err;
  // Before the connection error: the timeout error extends it.
  if (err instanceof OpenAIAbortError || err instanceof OpenAIConnectionTimeoutError || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))) {
    return new JudgeCallError('timeout', { kind: 'uncertain' });
  }
  if (err instanceof OpenAIConnectionError) return new JudgeCallError('network', { kind: 'uncertain' });
  if (err instanceof OpenAIRateLimitError) return new JudgeCallError('rate_limited', { kind: 'none' }, err.status);
  if (err instanceof OpenAIAuthenticationError || err instanceof OpenAIPermissionDeniedError) return new JudgeCallError('auth', { kind: 'none' }, err.status);
  if (err instanceof OpenAIBadRequestError || err instanceof OpenAINotFoundError || err instanceof OpenAIUnprocessableEntityError) {
    return new JudgeCallError('bad_request', { kind: 'none' }, err.status);
  }
  if (err instanceof OpenAIAPIError) {
    const status = err.status;
    if (status !== undefined && status < 500) return new JudgeCallError('provider_error', { kind: 'none' }, status);
    return new JudgeCallError('provider_error', { kind: 'uncertain' }, status);
  }
  return new JudgeCallError('unexpected', { kind: 'uncertain' });
}

/** The usage of a Responses API response; null when it is missing or malformed. */
export function openAIUsage(u: unknown): JudgeUsage | null {
  const r = u as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
  } | null;
  const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const input = int(r?.input_tokens);
  const output = int(r?.output_tokens);
  if (input === null || output === null) return null;
  const cached = int(r?.input_tokens_details?.cached_tokens) ?? 0;
  const written = int(r?.input_tokens_details?.cache_write_tokens) ?? 0;
  if (cached + written > input) return null;
  const reasoning = int(r?.output_tokens_details?.reasoning_tokens);
  return { inputTokens: input - cached - written, outputTokens: output, cacheWriteTokens: written, cacheReadTokens: cached, ...(reasoning !== null ? { reasoningTokens: reasoning } : {}) };
}

/** The Responses API request for a judge request (everything but the output cap). */
export function openAIBody(c: JudgeModelConfig, req: JudgeRequest) {
  return {
    model: c.model,
    input: [
      { role: 'developer' as const, content: [{ type: 'input_text' as const, text: req.system }] },
      {
        role: 'user' as const,
        content: req.blocks.map((b) => ({ type: 'input_text' as const, text: b.text, ...(b.cache ? { prompt_cache_breakpoint: { mode: 'explicit' as const } } : {}) })),
      },
    ],
    text: { format: { type: 'json_schema' as const, name: SCHEMA_NAME[req.output], strict: true, schema: strictJsonSchema(SCHEMAS[req.output]) } },
    reasoning: { effort: c.settings.reasoning ?? 'low' },
    prompt_cache_options: { mode: 'explicit' as const },
    store: false,
  };
}

let o200k: Tiktoken | undefined;
/** `o200k_base` tokens of a text (a local estimate; not the provider's count). */
export function o200kTokens(text: string): number {
  o200k ??= new Tiktoken(o200kBase);
  return o200k.encode(text, [], []).length;
}

/** Margin on the local estimate of an OpenAI request: 25% plus 300 tokens for the message structure and the schema. */
export const OPENAI_ESTIMATE = Object.freeze({ factor: 1.25, overhead: 300 });

export function estimateOpenAIInput(req: JudgeRequest): number {
  const text = [req.system, ...req.blocks.map((b) => b.text), JSON.stringify(strictJsonSchema(SCHEMAS[req.output]))].join('\n');
  return Math.ceil(o200kTokens(text) * OPENAI_ESTIMATE.factor) + OPENAI_ESTIMATE.overhead;
}

/** The part of the OpenAI client the judge uses; tests inject their own. */
export interface OpenAIResponsesClient {
  responses: { create(body: Record<string, unknown>, options?: { timeout?: number; signal?: AbortSignal; maxRetries?: number }): Promise<unknown> };
}

interface ResponseLike {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: { type?: string; text?: string; refusal?: string }[] }[];
  usage?: unknown;
}

export function createOpenAIJudge(c: JudgeModelConfig, opts: { apiKey?: string; client?: OpenAIResponsesClient }): JudgeCaller {
  if (c.provider !== 'openai' || llmPrice(c.model).provider !== 'openai') throw new Error(`Model '${c.model}' is not a priced OpenAI model`);
  if (!opts.client && !opts.apiKey) throw new Error('OPENAI_API_KEY is required');
  const client: OpenAIResponsesClient = opts.client ?? (new OpenAI({ apiKey: opts.apiKey, maxRetries: 0 }) as unknown as OpenAIResponsesClient);
  return {
    config: c,
    countsWithProvider: false,
    inputTokens: async (req) => estimateOpenAIInput(req),
    async call(req, timeoutMs) {
      const estimated = estimateOpenAIInput(req);
      if (estimated > c.maxInputTokens) throw new JudgeCallError('cap_exceeded', { kind: 'none' });
      let raw: unknown;
      try {
        raw = await client.responses.create({ ...openAIBody(c, req), max_output_tokens: c.maxOutputTokens }, { timeout: timeoutMs, signal: timeoutSignal(timeoutMs), maxRetries: 0 });
      } catch (err) {
        throw openAIFailure(err);
      }
      const res = raw as ResponseLike;
      const usage = openAIUsage(res.usage);
      const billed: JudgeBilling = usage ? { kind: 'usage', usage } : { kind: 'uncertain' };
      const status = res.status ?? 'unknown';
      const parts = (res.output ?? []).flatMap((o) => (o.type === 'message' ? (o.content ?? []) : []));
      if (parts.some((p) => p.type === 'refusal')) throw new JudgeCallError('refusal', billed, undefined, status);
      if (status === 'incomplete') {
        const reason = res.incomplete_details?.reason ?? 'unknown';
        throw new JudgeCallError(reason === 'content_filter' ? 'refusal' : 'truncated', billed, undefined, `incomplete:${reason}`);
      }
      if (status !== 'completed') throw new JudgeCallError('provider_error', billed, undefined, status);
      if (!usage) throw new JudgeCallError('invalid_output', billed, undefined, status);
      if (usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens > c.maxInputTokens) throw new JudgeCallError('cap_exceeded', billed, undefined, status);
      const text = parts.filter((p) => p.type === 'output_text').map((p) => p.text ?? '').join('');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new JudgeCallError('invalid_output', billed, undefined, status);
      }
      const parsed = SCHEMAS[req.output].safeParse(json);
      if (!parsed.success) throw new JudgeCallError('invalid_output', billed, undefined, status);
      return { output: parsed.data, usage, stopReason: status, inputTokens: estimated };
    },
  };
}

// ---------------------------------------------------------------------------
// Fakes (tests and free pipeline checks)

/** A judge answering from `respond` (its output, or a thrown `JudgeCallError`), with fixed usage. */
export function createFakeJudge(c: JudgeModelConfig, respond: (req: JudgeRequest, n: number) => unknown, usage: JudgeUsage = { inputTokens: 1_000, outputTokens: 200, cacheWriteTokens: 0, cacheReadTokens: 0 }): JudgeCaller & { calls: JudgeRequest[] } {
  const calls: JudgeRequest[] = [];
  return {
    config: c,
    countsWithProvider: false,
    calls,
    inputTokens: async (req) => Math.ceil(req.blocks.reduce((n, b) => n + b.text.length, req.system.length) / 4),
    async call(req) {
      calls.push(req);
      const out = respond(req, calls.length);
      if (out instanceof Error) throw out;
      const parsed = SCHEMAS[req.output].safeParse(out);
      if (!parsed.success) throw new JudgeCallError('invalid_output', { kind: 'usage', usage });
      return { output: parsed.data, usage, stopReason: 'end_turn', inputTokens: usage.inputTokens };
    },
  };
}
