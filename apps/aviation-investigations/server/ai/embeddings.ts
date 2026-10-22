/**
 * Embeddings shared by the worker (passage vectors) and the API (query vectors)
 * (DESIGN §5, §9; amendments A7, A10).
 *
 * This module holds what both sides need, so the server never imports worker code:
 * the `Embedder` interface, the request limits, the single OpenAI request with its
 * response decoding, and the metadata-only errors. The worker's batch embedder
 * (`worker/index/embed.ts`) adds retries, rate-limit waits and per-attempt ledger
 * reservations on top.
 *
 * - **Errors carry metadata only.** `EmbeddingRequestError` keeps the HTTP status, a
 *   provider error code and the request id when they look like identifiers, and
 *   nothing else: no provider message (a 401 message quotes part of the key), no
 *   request body and no `cause`. A malformed successful response is reported by a
 *   fixed category (`ResponseProblem`), never by a value taken from it.
 * - Vectors are requested as base64 and decoded straight into `Float32Array`.
 *
 * **Query embeddings.** `createOpenAIQueryEmbedder` makes exactly one attempt per
 * call and never reserves money itself: an interactive request's admission
 * reservation (`server/quota`, Task 15) already covers one query embedding at the
 * `embed` stage cap (`STAGE_CAPS.embed`, 1,000 tokens). The caller settles that
 * reservation with the usage retrieval hands it (`RetrievalQuery.onQueryEmbedding`,
 * called as soon as the embedding succeeds, so a later failure cannot lose it), or,
 * after a `QueryEmbeddingError`, by its `billing`: `none` (the provider rejected the
 * request), `usage` (processed and billed at `billedTokens`, but unusable) or
 * `uncertain` (it may have been billed: settle in full). A successful response
 * without a usable usage report is marked `usageUncertain`. The query input is
 * `queryEmbeddingInput(text)` (template `QUERY_INPUT_TEMPLATE_VERSION`): the question
 * with whitespace runs collapsed, no header. Passage inputs carry a header
 * (`input-v1`); queries deliberately do not, and both use the same model and
 * dimensions, which the passages index records in its `_meta`.
 */
import OpenAI, { APIConnectionError, APIError } from 'openai';
import { STAGE_CAPS, embeddingPrice } from './pricing.js';
import { countTokens } from './tokens.js';

export interface EmbedResult {
  /** One vector per input, in input order. */
  vectors: Float32Array[];
  /** Billed input tokens; the counted input tokens when `usageUncertain`. */
  tokens: number;
  /**
   * The provider processed the request but reported no usable usage: `tokens` is only
   * the counted input, and the call must be settled as uncertain (in full).
   */
  usageUncertain?: boolean;
}

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** Price per million input tokens (0 for the fake embedder). */
  readonly usdPerMillionTokens: number;
  embed(texts: string[]): Promise<EmbedResult>;
}

/** Hard limit of one embedding input (`text-embedding-3-*`). */
export const MAX_EMBEDDING_INPUT_TOKENS = 8_192;

export const EMBEDDING_LIMITS = Object.freeze({
  maxInputs: 96,
  maxBatchTokens: 250_000,
  maxInputTokens: MAX_EMBEDDING_INPUT_TOKENS,
});

export function embeddingUsd(tokens: number, usdPerMillionTokens: number): number {
  return (tokens * usdPerMillionTokens) / 1_000_000;
}

/** Validate a batch against `EMBEDDING_LIMITS`; returns its exact token count. */
export function checkBatch(texts: readonly string[]): number {
  if (texts.length === 0 || texts.length > EMBEDDING_LIMITS.maxInputs) {
    throw new Error(`an embedding request holds 1..${EMBEDDING_LIMITS.maxInputs} inputs, not ${texts.length}`);
  }
  let total = 0;
  texts.forEach((t, i) => {
    const n = countTokens(t);
    if (n === 0) throw new Error(`embedding input ${i} is empty`);
    if (n > EMBEDDING_LIMITS.maxInputTokens) {
      throw new Error(`embedding input ${i} has ${n} tokens; the limit is ${EMBEDDING_LIMITS.maxInputTokens}`);
    }
    total += n;
  });
  if (total > EMBEDDING_LIMITS.maxBatchTokens) {
    throw new Error(`an embedding request holds at most ${EMBEDDING_LIMITS.maxBatchTokens} tokens, not ${total}`);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Errors (metadata only)

/** What is kept of a provider failure: values that look like identifiers, nothing else. */
export interface ProviderErrorInfo {
  /** HTTP status, when the provider answered. */
  status?: number;
  /** Provider error code such as `rate_limit_exceeded`. */
  code?: string;
  requestId?: string;
  /** `connection` (no response), `api` (an HTTP error response) or `other`. */
  kind: 'connection' | 'api' | 'other';
}

const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/i;
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function providerErrorInfo(err: unknown): ProviderErrorInfo {
  if (err instanceof APIConnectionError) return { kind: 'connection' };
  if (err instanceof APIError) {
    const info: ProviderErrorInfo = { kind: 'api' };
    if (typeof err.status === 'number') info.status = err.status;
    if (typeof err.code === 'string' && SAFE_CODE.test(err.code)) info.code = err.code;
    if (typeof err.requestID === 'string' && SAFE_REQUEST_ID.test(err.requestID)) info.requestId = err.requestID;
    return info;
  }
  return { kind: 'other' };
}

export function describeProviderError(i: ProviderErrorInfo): string {
  if (i.kind === 'connection') return 'connection failed or timed out';
  if (i.kind === 'other') return 'unexpected client error';
  return `HTTP ${i.status ?? 'error'}${i.code ? ` ${i.code}` : ''}${i.requestId ? ` (request ${i.requestId})` : ''}`;
}

/** A failed embedding request. Holds sanitized metadata and deliberately no `cause`. */
export class EmbeddingRequestError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  constructor(
    message: string,
    readonly attempts: number,
    info: ProviderErrorInfo,
  ) {
    super(message);
    this.name = 'EmbeddingRequestError';
    this.status = info.status;
    this.code = info.code;
    this.requestId = info.requestId;
  }
}

/** Fixed categories of a malformed successful response; messages never quote the response. */
export type ResponseProblem = 'invalid_response_shape' | 'count_mismatch' | 'index_out_of_range' | 'dimension_mismatch' | 'invalid_vector';

export class ResponseShapeError extends Error {
  constructor(readonly problem: ResponseProblem) {
    super(problem);
    this.name = 'ResponseShapeError';
  }
}

/** How a failed attempt is billed and whether another attempt may help. */
export interface Failure {
  /** `rejected`: certainly not processed (settle at 0); `uncertain`: may have been billed. */
  kind: 'rejected' | 'uncertain';
  retryable: boolean;
  info: ProviderErrorInfo;
}

export function classifyFailure(err: unknown): Failure {
  const info = providerErrorInfo(err);
  if (info.kind === 'connection') return { kind: 'uncertain', retryable: true, info };
  if (info.kind === 'api' && info.status !== undefined) {
    const s = info.status;
    if (s === 408) return { kind: 'uncertain', retryable: true, info };
    if (s === 429) return { kind: 'rejected', retryable: info.code !== 'insufficient_quota', info };
    if (s >= 500) return { kind: 'uncertain', retryable: true, info };
    if (s >= 400) return { kind: 'rejected', retryable: false, info };
  }
  return { kind: 'uncertain', retryable: false, info };
}

// ---------------------------------------------------------------------------
// One OpenAI request

function decodeVector(b64: unknown, dims: number): Float32Array {
  if (typeof b64 !== 'string') throw new ResponseShapeError('invalid_response_shape');
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength !== dims * 4) throw new ResponseShapeError('dimension_mismatch');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i += 1) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) throw new ResponseShapeError('invalid_vector');
    out[i] = v;
    norm += v * v;
  }
  if (!(norm > 0)) throw new ResponseShapeError('invalid_vector');
  return out;
}

/** Vectors of a successful response in input order; throws `ResponseShapeError` for anything unexpected. */
export function decodeEmbeddingResponse(body: unknown, count: number, dims: number): Float32Array[] {
  const items = (body as { data?: unknown } | null)?.data;
  if (typeof body !== 'object' || body === null || !Array.isArray(items)) throw new ResponseShapeError('invalid_response_shape');
  if (items.length !== count) throw new ResponseShapeError('count_mismatch');
  const vectors = new Array<Float32Array>(count);
  for (const item of items as unknown[]) {
    if (typeof item !== 'object' || item === null) throw new ResponseShapeError('invalid_response_shape');
    const index = (item as { index?: unknown }).index;
    if (typeof index !== 'number' || !Number.isInteger(index)) throw new ResponseShapeError('invalid_response_shape');
    if (index < 0 || index >= count || vectors[index]) throw new ResponseShapeError('index_out_of_range');
    vectors[index] = decodeVector((item as { embedding?: unknown }).embedding, dims);
  }
  return vectors;
}

/** Billed prompt tokens, when the response reports them as a non-negative integer. */
export function billedTokens(body: unknown): number | undefined {
  const t = (body as { usage?: { prompt_tokens?: unknown } } | null)?.usage?.prompt_tokens;
  return typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 ? t : undefined;
}

/** One embeddings request (base64 vectors), with the response headers. */
export async function requestEmbeddings(client: OpenAI, model: string, dims: number, texts: string[], signal?: AbortSignal) {
  const { data, response } = await client.embeddings
    .create({ model, input: texts, dimensions: dims, encoding_format: 'base64' }, signal ? { signal } : undefined)
    .withResponse();
  return { data, headers: response.headers };
}

// ---------------------------------------------------------------------------
// Query embeddings (the API)

/** Bump whenever `queryEmbeddingInput` changes. */
export const QUERY_INPUT_TEMPLATE_VERSION = 'query-v1';

/** Largest query embedding input: the reservation covers `STAGE_CAPS.embed.input` tokens. */
export const MAX_QUERY_INPUT_TOKENS = STAGE_CAPS.embed.input;

export class QueryTooLongError extends Error {
  constructor(readonly tokens: number) {
    super(`the query has ${tokens} tokens; at most ${MAX_QUERY_INPUT_TOKENS} are embedded`);
    this.name = 'QueryTooLongError';
  }
}

/** The text sent to the embedding model for a query: whitespace runs collapsed, trimmed, no header. */
export function queryEmbeddingInput(text: string): string {
  const input = text.replace(/\s+/gu, ' ').trim();
  if (input === '') throw new Error('the query is empty');
  const tokens = countTokens(input);
  if (tokens > MAX_QUERY_INPUT_TOKENS) throw new QueryTooLongError(tokens);
  return input;
}

/**
 * How a failed query embedding is billed: `none` (rejected by the provider), `usage`
 * (processed and billed at `billedTokens`) or `uncertain` (settle in full).
 */
export type QueryEmbeddingBilling = 'none' | 'usage' | 'uncertain';

/** A failed query embedding; `billing` tells the caller how to settle its reservation. */
export class QueryEmbeddingError extends EmbeddingRequestError {
  constructor(
    message: string,
    info: ProviderErrorInfo,
    readonly billing: QueryEmbeddingBilling,
    /** Provider-reported tokens when `billing` is `usage`; null otherwise. */
    readonly billedTokens: number | null = null,
  ) {
    super(message, 1, info);
    this.name = 'QueryEmbeddingError';
  }
}

export interface OpenAIQueryEmbedderConfig {
  apiKey: string;
  model: string;
  dims: number;
  /** Per-request timeout (default 5 s: the retrieve stage has 8 s in all). */
  timeoutMs?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  baseURL?: string;
}

/** An embedder for retrieval queries that knows the abort signal of its request. */
export interface QueryEmbedder extends Embedder {
  /** Like `embed`, bounded by `signal` as well as the configured timeout. */
  embedWithSignal(texts: string[], signal?: AbortSignal): Promise<EmbedResult>;
}

/**
 * The API's query embedder: exactly one input of at most `MAX_QUERY_INPUT_TOKENS`
 * tokens per call, one attempt, no retries, no reservation of its own (see the module
 * comment). A failure throws `QueryEmbeddingError` with its billing; a successful
 * response without a usable usage report returns `usageUncertain: true`.
 */
export function createOpenAIQueryEmbedder(cfg: OpenAIQueryEmbedderConfig): QueryEmbedder {
  const price = embeddingPrice(cfg.model).input;
  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY is not set');
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    maxRetries: 0,
    timeout: cfg.timeoutMs ?? 5_000,
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
  });
  const embedWithSignal = async (texts: string[], signal?: AbortSignal): Promise<EmbedResult> => {
    if (texts.length !== 1) throw new Error(`the query embedder takes exactly one input, not ${texts.length}`);
    const counted = checkBatch(texts);
    if (counted > MAX_QUERY_INPUT_TOKENS) throw new QueryTooLongError(counted);
    let response: Awaited<ReturnType<typeof requestEmbeddings>>;
    try {
      response = await requestEmbeddings(client, cfg.model, cfg.dims, texts, signal);
    } catch (err) {
      const f = classifyFailure(err);
      throw new QueryEmbeddingError(
        `query embedding failed: ${describeProviderError(f.info)}`,
        f.info,
        f.kind === 'rejected' ? 'none' : 'uncertain',
      );
    }
    const billed = billedTokens(response.data);
    let vectors: Float32Array[];
    try {
      vectors = decodeEmbeddingResponse(response.data, texts.length, cfg.dims);
    } catch (err) {
      const problem: ResponseProblem = err instanceof ResponseShapeError ? err.problem : 'invalid_response_shape';
      // Processed, so billed: at the reported usage when there is one, otherwise in full.
      throw new QueryEmbeddingError(
        `invalid query embedding response: ${problem}`,
        { kind: 'api', status: 200 },
        billed === undefined ? 'uncertain' : 'usage',
        billed ?? null,
      );
    }
    return billed === undefined ? { vectors, tokens: counted, usageUncertain: true } : { vectors, tokens: billed };
  };
  return {
    model: cfg.model,
    dims: cfg.dims,
    usdPerMillionTokens: price,
    embed: (texts) => embedWithSignal(texts),
    embedWithSignal,
  };
}
