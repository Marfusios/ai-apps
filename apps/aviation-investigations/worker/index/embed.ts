/**
 * Embeddings (DESIGN §5, §9; amendments A7, A10, A16).
 *
 * - `createOpenAIEmbedder` calls `text-embedding-3-small` through the official SDK
 *   with SDK retries off (`maxRetries: 0`). It retries only rate limits (429, except
 *   `insufficient_quota`), server errors (5xx) and connection failures/timeouts, with
 *   exponential backoff (or `Retry-After`), at most `maxAttempts` (3) attempts.
 * - **Metering per attempt (A7).** Before each attempt it reserves the batch's maximum
 *   cost (exact `cl100k_base` tokens × price × `RESERVATION_SAFETY_FACTOR`) on the
 *   spend gate; nothing is sent if the reservation is refused. The attempt then
 *   settles: at the reported usage on success, at zero when the API answered with a
 *   4xx (the request was rejected, nothing was embedded), and `uncertain` (the full
 *   reservation stays charged) after a 5xx, a timeout, a lost connection or any other
 *   failure whose billing cannot be known.
 * - **Limits.** A request holds at most 96 inputs and 250,000 tokens; each input is
 *   at most 8,192 tokens. Larger requests are refused, never truncated.
 * - Vectors are requested as base64 and decoded straight into `Float32Array`.
 * - The API key is passed to the SDK only; it never appears in errors or logs.
 *
 * `createFakeEmbedder` is deterministic (a hash-seeded unit vector per input) and
 * free; tests and offline runs use it.
 */
import { createHash } from 'node:crypto';
import OpenAI, { APIConnectionError, APIError } from 'openai';
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

/** Published input prices, USD per million tokens (checked 2026-10-21; DESIGN §9). */
export const EMBEDDING_PRICES: Readonly<Record<string, number>> = {
  'text-embedding-3-small': 0.02,
};

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
// OpenAI

export class EmbeddingRequestError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly status: number | undefined,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'EmbeddingRequestError';
  }
}

export interface OpenAIEmbedderConfig {
  apiKey: string;
  model: string;
  dims: number;
  gate: SpendGate;
  /** Reservation purpose recorded with every attempt. */
  purpose: string;
  maxAttempts?: number;
  /** First backoff delay; doubled per attempt (default 1 s). */
  baseDelayMs?: number;
  /** Cap for backoff and `Retry-After` waits (default 30 s). */
  maxDelayMs?: number;
  /** Per-request timeout (default 60 s). */
  timeoutMs?: number;
  /** Test seams. */
  fetch?: typeof fetch;
  baseURL?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

type AttemptFailure = { kind: 'rejected' | 'uncertain'; retryable: boolean; status: number | undefined; error: unknown };

function classify(err: unknown): AttemptFailure {
  if (err instanceof APIConnectionError) return { kind: 'uncertain', retryable: true, status: undefined, error: err };
  if (err instanceof APIError && typeof err.status === 'number') {
    const status = err.status;
    if (status === 429) return { kind: 'rejected', retryable: err.code !== 'insufficient_quota', status, error: err };
    if (status >= 500) return { kind: 'uncertain', retryable: true, status, error: err };
    if (status >= 400) return { kind: 'rejected', retryable: false, status, error: err };
  }
  return { kind: 'uncertain', retryable: false, status: undefined, error: err };
}

/** `Retry-After` (seconds or HTTP date) or `retry-after-ms`, in milliseconds. */
function retryAfterMs(err: unknown): number | undefined {
  const headers = err instanceof APIError ? err.headers : undefined;
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const s = Number(raw);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
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

function describe(err: unknown): string {
  if (err instanceof APIError) {
    return `${err.status ?? 'no status'}${err.code ? ` ${err.code}` : ''}${err.requestID ? ` (request ${err.requestID})` : ''}`;
  }
  return err instanceof Error ? err.name : 'unknown error';
}

function decodeVector(b64: string, dims: number): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength !== dims * 4) throw new Error(`embedding has ${buf.byteLength / 4} dimensions, expected ${dims}`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i += 1) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) throw new Error('embedding contains a non-finite value');
    out[i] = v;
    norm += v * v;
  }
  if (!(norm > 0)) throw new Error('embedding is the zero vector');
  return out;
}

export function createOpenAIEmbedder(cfg: OpenAIEmbedderConfig): Embedder {
  const price = EMBEDDING_PRICES[cfg.model];
  if (price === undefined) throw new Error(`no price for embedding model ${cfg.model}; refusing to meter it`);
  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY is not set');
  const maxAttempts = cfg.maxAttempts ?? 3;
  const baseDelayMs = cfg.baseDelayMs ?? 1000;
  const maxDelayMs = cfg.maxDelayMs ?? 30_000;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = cfg.log ?? (() => undefined);
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    maxRetries: 0,
    timeout: cfg.timeoutMs ?? 60_000,
    ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
    ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
  });
  /** Wait before the next request when the token rate limit is nearly used up. */
  let pauseUntil = 0;

  return {
    model: cfg.model,
    dims: cfg.dims,
    usdPerMillionTokens: price,
    async embed(texts) {
      const tokens = checkBatch(texts);
      const reserve = reservationUsd(tokens, price);
      for (let attempt = 1; ; attempt += 1) {
        const wait = pauseUntil - Date.now();
        if (wait > 0) await sleep(Math.min(wait, maxDelayMs));
        const reservation = await cfg.gate.reserve({ category: 'indexing', usd: reserve, purpose: cfg.purpose });
        let response: Awaited<ReturnType<typeof requestEmbeddings>>;
        try {
          response = await requestEmbeddings(client, cfg.model, cfg.dims, texts);
        } catch (err) {
          const f = classify(err);
          await cfg.gate.settle(reservation, f.kind === 'rejected' ? { usd: 0 } : 'uncertain');
          if (!f.retryable || attempt >= maxAttempts) {
            throw new EmbeddingRequestError(
              `embedding request failed after ${attempt} attempt(s): ${describe(err)}`,
              attempt,
              f.status,
              err,
            );
          }
          const delay = Math.min(maxDelayMs, retryAfterMs(err) ?? baseDelayMs * 2 ** (attempt - 1));
          log(`embedding attempt ${attempt} failed (${describe(err)}); retrying in ${delay} ms`);
          await sleep(delay);
          continue;
        }

        // The request was processed: it is billed whatever its content.
        const { data, headers } = response;
        const billed = data.usage?.prompt_tokens;
        const usd = typeof billed === 'number' && billed >= 0 ? embeddingUsd(billed, price) : undefined;
        let vectors: Float32Array[];
        try {
          if (data.data.length !== texts.length) throw new Error(`${data.data.length} embeddings for ${texts.length} inputs`);
          vectors = new Array<Float32Array>(texts.length);
          for (const item of data.data) {
            if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || vectors[item.index]) {
              throw new Error(`unexpected embedding index ${item.index}`);
            }
            vectors[item.index] = decodeVector(item.embedding, cfg.dims);
          }
        } catch (err) {
          await cfg.gate.settle(reservation, usd === undefined ? 'uncertain' : { usd });
          throw new EmbeddingRequestError(`invalid embedding response: ${err instanceof Error ? err.message : String(err)}`, attempt, 200, err);
        }
        await cfg.gate.settle(reservation, usd === undefined ? 'uncertain' : { usd });
        const remaining = Number(headers.get('x-ratelimit-remaining-tokens'));
        const reset = parseResetDuration(headers.get('x-ratelimit-reset-tokens'));
        if (Number.isFinite(remaining) && reset !== undefined && remaining < 2 * tokens) pauseUntil = Date.now() + reset;
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
