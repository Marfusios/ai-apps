/**
 * Embeddings (DESIGN §5, §9; amendments A7, A10, A16).
 *
 * - `createOpenAIEmbedder` calls `text-embedding-3-small` through the official SDK
 *   with SDK retries off (`maxRetries: 0`). It retries only rate limits (429, except
 *   `insufficient_quota`), request timeouts (408), server errors (5xx) and connection
 *   failures/timeouts, at most `maxAttempts` (3) attempts.
 * - **Waiting.** Provider deadlines are honoured in full, after successful and failed
 *   responses alike: `Retry-After` / `retry-after-ms`, and the token and request rate
 *   limits' resets (`x-ratelimit-reset-tokens`, `x-ratelimit-reset-requests`) when the
 *   matching remaining count is too low for the next request, or missing on a 429.
 *   The latest of them applies. Only the locally generated exponential backoff (used
 *   when the provider names no deadline) is capped. A deadline further away than
 *   `maxWaitMs` (10 minutes) stops the run with `EmbeddingDeferredError`, which says
 *   when to rerun: every vector paid for so far is in the cache.
 * - **Metering per attempt (A7).** Before each attempt it reserves the batch's maximum
 *   cost (exact `cl100k_base` tokens × price × `RESERVATION_SAFETY_FACTOR`) on the
 *   spend gate; nothing is sent if the reservation is refused. The attempt then
 *   settles: at the reported usage on success, at zero when the API answered with a
 *   4xx other than 408 (the request was rejected, nothing was embedded), and
 *   `uncertain` (the full reservation stays charged) after a 408, a 5xx, a timeout, a
 *   lost connection or any other failure whose billing cannot be known.
 * - **Limits.** A request holds at most 96 inputs and 250,000 tokens; each input is
 *   at most 8,192 tokens. Larger requests are refused, never truncated.
 * - **Errors carry metadata only.** `EmbeddingRequestError` keeps the HTTP status, a
 *   provider error code and the request id when they look like identifiers, and
 *   nothing else: no provider message (a 401 message quotes part of the key), no
 *   request body, and no `cause`, so no formatter can unwrap the raw SDK error. A
 *   malformed successful response is reported by a fixed category
 *   (`ResponseProblem`), never by a value taken from it.
 * - Vectors are requested as base64 and decoded straight into `Float32Array`.
 *
 * `createFakeEmbedder` is deterministic (a hash-seeded unit vector per input) and
 * free; tests and offline runs use it.
 */
import { createHash } from 'node:crypto';
import OpenAI, { APIConnectionError, APIError } from 'openai';
import { embeddingPrice } from '../../server/ai/pricing.js';
import { MAX_INPUT_TOKENS } from './passages.js';
import { ceilUsd, type SpendGate } from './spend-gate.js';
import { countTokens } from './tokens.js';

export interface EmbedResult {
  /** One vector per input, in input order. */
  vectors: Float32Array[];
  /** Billed input tokens. */
  tokens: number;
}

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** Price per million input tokens (0 for the fake embedder). */
  readonly usdPerMillionTokens: number;
  embed(texts: string[]): Promise<EmbedResult>;
}

export const EMBEDDING_LIMITS = Object.freeze({
  maxInputs: 96,
  maxBatchTokens: 250_000,
  maxInputTokens: MAX_INPUT_TOKENS,
});

/** Input price per million tokens from the shared price table (`server/ai/pricing.ts`); throws for unpriced models. */
export function embeddingUsdPerMillion(model: string): number {
  return embeddingPrice(model).input;
}

/** Reservations cover the exact token count with this margin. */
export const RESERVATION_SAFETY_FACTOR = 1.1;

export function embeddingUsd(tokens: number, usdPerMillionTokens: number): number {
  return (tokens * usdPerMillionTokens) / 1_000_000;
}

/** The reservation for one attempt at a batch of `tokens` tokens. */
export function reservationUsd(tokens: number, usdPerMillionTokens: number): number {
  return ceilUsd(embeddingUsd(tokens, usdPerMillionTokens) * RESERVATION_SAFETY_FACTOR);
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

/**
 * Group items into requests of at most `maxInputs` inputs and `maxBatchTokens`
 * tokens, in order. Every item must already be within the per-input limit.
 */
export function batchByLimits<T>(items: readonly T[], tokensOf: (item: T) => number): T[][] {
  const out: T[][] = [];
  let batch: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const n = tokensOf(item);
    if (n > EMBEDDING_LIMITS.maxInputTokens) throw new Error(`an embedding input of ${n} tokens exceeds the limit`);
    if (batch.length > 0 && (batch.length >= EMBEDDING_LIMITS.maxInputs || tokens + n > EMBEDDING_LIMITS.maxBatchTokens)) {
      out.push(batch);
      batch = [];
      tokens = 0;
    }
    batch.push(item);
    tokens += n;
  }
  if (batch.length > 0) out.push(batch);
  return out;
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

function describeInfo(i: ProviderErrorInfo): string {
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

class ResponseShapeError extends Error {
  constructor(readonly problem: ResponseProblem) {
    super(problem);
    this.name = 'ResponseShapeError';
  }
}

/** The provider asked for a wait longer than the run may sleep: rerun after `retryAt`. */
export class EmbeddingDeferredError extends Error {
  constructor(
    readonly retryAt: Date,
    reason: string,
  ) {
    super(
      `${reason}: stopped; rerun after ${retryAt.toISOString()}. Embeddings paid for so far are cached and will not be paid for again`,
    );
    this.name = 'EmbeddingDeferredError';
  }
}

// ---------------------------------------------------------------------------
// OpenAI

export interface OpenAIEmbedderConfig {
  apiKey: string;
  model: string;
  dims: number;
  gate: SpendGate;
  /** Reservation purpose recorded with every attempt (an id, no content). */
  purpose: string;
  maxAttempts?: number;
  /** First local backoff delay; doubled per attempt (default 1 s). */
  baseDelayMs?: number;
  /** Cap of the local exponential backoff only (default 30 s). Provider deadlines are never shortened. */
  maxBackoffMs?: number;
  /** Longest provider deadline the run waits for; a longer one stops it resumably (default 10 minutes). */
  maxWaitMs?: number;
  /** Per-request timeout (default 60 s). */
  timeoutMs?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  baseURL?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

interface Failure {
  /** `rejected`: certainly not processed (settle at 0); `uncertain`: may have been billed. */
  kind: 'rejected' | 'uncertain';
  retryable: boolean;
  info: ProviderErrorInfo;
}

function classify(err: unknown): Failure {
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

/** A provider-requested wait (`retry-after-ms`, or `Retry-After` in seconds or as an HTTP date), in ms. */
export function retryAfterMs(headers: Headers | undefined, now: number): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const s = Number(raw);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** `6m0s`, `1.5s`, `120ms` → milliseconds. */
export function parseResetDuration(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/gu;
  let total = 0;
  let matched = '';
  for (const m of raw.matchAll(re)) {
    const v = Number(m[1]);
    total += v * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[m[2] as 'ms' | 's' | 'm' | 'h'];
    matched += m[0];
  }
  return matched === raw.trim() && matched !== '' ? total : undefined;
}

/** Rate-limit headers of a response (successful or not) that set the earliest next request, in ms from now. */
export function rateLimitWaitMs(headers: Headers | undefined, batchTokens: number, now: number, rejected: boolean): number | undefined {
  if (!headers) return undefined;
  const waits: number[] = [];
  const retryAfter = retryAfterMs(headers, now);
  if (retryAfter !== undefined) waits.push(retryAfter);
  /** A reset applies when its remaining count is below `need`, or is not reported on a rejected request. */
  const reset = (remainingHeader: string, resetHeader: string, need: number) => {
    const ms = parseResetDuration(headers.get(resetHeader));
    if (ms === undefined) return;
    const raw = headers.get(remainingHeader);
    const remaining = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(remaining) ? remaining < need : rejected) waits.push(ms);
  };
  reset('x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens', 2 * batchTokens);
  reset('x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 1);
  return waits.length > 0 ? Math.max(...waits) : undefined;
}

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
function decodeResponse(body: unknown, count: number, dims: number): Float32Array[] {
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
function billedTokens(body: unknown): number | undefined {
  const t = (body as { usage?: { prompt_tokens?: unknown } } | null)?.usage?.prompt_tokens;
  return typeof t === 'number' && Number.isSafeInteger(t) && t >= 0 ? t : undefined;
}

export function createOpenAIEmbedder(cfg: OpenAIEmbedderConfig): Embedder {
  const price = embeddingUsdPerMillion(cfg.model);
  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY is not set');
  const maxAttempts = cfg.maxAttempts ?? 3;
  const baseDelayMs = cfg.baseDelayMs ?? 1000;
  const maxBackoffMs = cfg.maxBackoffMs ?? 30_000;
  const maxWaitMs = cfg.maxWaitMs ?? 10 * 60_000;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = cfg.now ?? Date.now;
  const log = cfg.log ?? (() => undefined);
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    maxRetries: 0,
    timeout: cfg.timeoutMs ?? 60_000,
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
  });
  /** No request before this time: a provider deadline (rate-limit reset or `Retry-After`). */
  let notBefore = 0;
  let notBeforeReason = 'the provider rate limit';
  const deferUntil = (at: number, reason: string) => {
    if (at > notBefore) {
      notBefore = at;
      notBeforeReason = reason;
    }
  };

  /** Wait for a provider deadline in full, or stop resumably when it is too far away. */
  const waitUntil = async (at: number, reason: string) => {
    const ms = at - now();
    if (ms <= 0) return;
    if (ms > maxWaitMs) throw new EmbeddingDeferredError(new Date(at), `${reason} asks for a ${Math.ceil(ms / 1000)} s wait`);
    log(`${reason}: waiting ${Math.ceil(ms / 1000)} s`);
    await sleep(ms);
  };

  return {
    model: cfg.model,
    dims: cfg.dims,
    usdPerMillionTokens: price,
    async embed(texts) {
      const tokens = checkBatch(texts);
      const reserve = reservationUsd(tokens, price);
      for (let attempt = 1; ; attempt += 1) {
        await waitUntil(notBefore, notBeforeReason);
        const reservation = await cfg.gate.reserve({ category: 'indexing', usd: reserve, purpose: cfg.purpose });
        let response: Awaited<ReturnType<typeof requestEmbeddings>>;
        try {
          response = await requestEmbeddings(client, cfg.model, cfg.dims, texts);
        } catch (err) {
          const f = classify(err);
          await cfg.gate.settle(reservation, f.kind === 'rejected' ? { usd: 0 } : 'uncertain');
          const what = describeInfo(f.info);
          if (!f.retryable || attempt >= maxAttempts) {
            throw new EmbeddingRequestError(`embedding request failed after ${attempt} attempt(s): ${what}`, attempt, f.info);
          }
          const headers = err instanceof APIError ? err.headers : undefined;
          const provider = rateLimitWaitMs(headers, tokens, now(), f.info.status === 429);
          if (provider !== undefined) {
            // Waited out (or deferred) at the top of the loop, before anything is reserved.
            deferUntil(now() + provider, `the provider (${what})`);
          } else {
            const delay = Math.min(maxBackoffMs, baseDelayMs * 2 ** (attempt - 1));
            log(`embedding attempt ${attempt} failed (${what}); retrying in ${delay} ms`);
            await sleep(delay);
          }
          continue;
        }

        // The request was processed: it is billed whatever its content. Without a usable
        // usage report the attempt is charged in full.
        const { data, headers } = response;
        const billed = billedTokens(data);
        const outcome = billed === undefined ? ('uncertain' as const) : { usd: embeddingUsd(billed, price), tokens: billed };
        if (billed === undefined) log('embedding response without a usable usage report: charged at the full reservation');
        const wait = rateLimitWaitMs(headers, tokens, now(), false);
        if (wait !== undefined) deferUntil(now() + wait, 'the provider rate limit');
        let vectors: Float32Array[];
        try {
          vectors = decodeResponse(data, texts.length, cfg.dims);
        } catch (err) {
          await cfg.gate.settle(reservation, outcome);
          // A fixed category only: never a value from the response or a decoder message.
          const problem: ResponseProblem = err instanceof ResponseShapeError ? err.problem : 'invalid_response_shape';
          throw new EmbeddingRequestError(`invalid embedding response: ${problem}`, attempt, { kind: 'api', status: 200 });
        }
        await cfg.gate.settle(reservation, outcome);
        return { vectors, tokens: billed ?? tokens };
      }
    },
  };
}

async function requestEmbeddings(client: OpenAI, model: string, dims: number, texts: string[]) {
  const { data, response } = await client.embeddings
    .create({ model, input: texts, dimensions: dims, encoding_format: 'base64' })
    .withResponse();
  return { data, headers: response.headers };
}

// ---------------------------------------------------------------------------
// Fake

export interface FakeEmbedder extends Embedder {
  /** Batches embedded so far (tests). */
  readonly calls: string[][];
}

/** A deterministic unit vector per input, seeded by its sha256; free and offline. */
export function createFakeEmbedder(dims: number, model = 'fake-embedding-v1'): FakeEmbedder {
  const calls: string[][] = [];
  return {
    model,
    dims,
    usdPerMillionTokens: 0,
    calls,
    async embed(texts) {
      const tokens = checkBatch(texts);
      calls.push([...texts]);
      return { vectors: texts.map((t) => fakeVector(t, dims)), tokens };
    },
  };
}

export function fakeVector(text: string, dims: number): Float32Array {
  const out = new Float32Array(dims);
  let norm = 0;
  for (let block = 0; block * 8 < dims; block += 1) {
    const digest = createHash('sha256').update(`${block}\u0000${text}`).digest();
    for (let i = 0; i < 8 && block * 8 + i < dims; i += 1) {
      const v = digest.readInt32LE(i * 4) / 2 ** 31;
      out[block * 8 + i] = v;
      norm += v * v;
    }
  }
  const scale = 1 / Math.sqrt(norm || 1);
  for (let i = 0; i < dims; i += 1) out[i] = (out[i] as number) * scale;
  return out;
}
