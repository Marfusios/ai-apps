import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_LIMITS,
  EmbeddingRequestError,
  RESERVATION_SAFETY_FACTOR,
  batchByLimits,
  checkBatch,
  createFakeEmbedder,
  createOpenAIEmbedder,
  fakeVector,
  parseResetDuration,
  reservationUsd,
} from '../../worker/index/embed.js';
import { bytesToVector, vectorToBytes } from '../../worker/index/embedding-cache.js';
import {
  SpendRefusedError,
  ceilUsd,
  createDryRunSpendGate,
  createLedgerSpendGate,
  createMemorySpendGate,
  type SpendGate,
} from '../../worker/index/spend-gate.js';
import { countTokens } from '../../worker/index/tokens.js';
import type { Db } from '../../server/db/client.js';

const DIMS = 8;
const PRICE = 0.02;
const API_KEY = 'sk-test-not-a-real-key';

type Step = { status: number; body?: unknown; headers?: Record<string, string> } | { throw: Error };

function vectorB64(seed: number): string {
  const v = new Float32Array(DIMS).map((_, i) => (i + seed) / 10);
  return Buffer.from(v.buffer).toString('base64');
}

function okBody(n: number, promptTokens: number) {
  return {
    object: 'list',
    model: 'text-embedding-3-small',
    data: Array.from({ length: n }, (_, i) => ({ object: 'embedding', index: n - 1 - i, embedding: vectorB64(n - 1 - i) })),
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

/** A fake `fetch` that plays `steps` in order and logs each call into `events`. */
function scriptedFetch(steps: Step[], events: string[]) {
  const requests: { body: Record<string, unknown>; auth: string | null }[] = [];
  const impl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const step = steps.shift();
    events.push('fetch');
    const headers = new Headers(init?.headers);
    requests.push({ body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, auth: headers.get('authorization') });
    if (!step) throw new Error('unexpected request');
    if ('throw' in step) throw step.throw;
    return new Response(JSON.stringify(step.body ?? { error: { message: 'failure', type: 'server_error', code: null } }), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...step.headers },
    });
  };
  return { fetch: impl as typeof fetch, requests };
}

/** Wrap a gate so reservations and settlements land in the same event log as requests. */
function logged(gate: SpendGate, events: string[]): SpendGate {
  return {
    reserve: async (req) => {
      const r = await gate.reserve(req);
      events.push(`reserve ${req.usd.toFixed(6)}`);
      return r;
    },
    settle: async (res, outcome) => {
      await gate.settle(res, outcome);
      events.push(outcome === 'uncertain' ? 'settle uncertain' : `settle ${outcome.usd.toFixed(6)}`);
    },
    remainingUsd: (c) => gate.remainingUsd(c),
  };
}

function embedderWith(steps: Step[], allowance = 1) {
  const events: string[] = [];
  const memory = createMemorySpendGate(allowance);
  const sleeps: number[] = [];
  const { fetch, requests } = scriptedFetch(steps, events);
  const embedder = createOpenAIEmbedder({
    apiKey: API_KEY,
    model: 'text-embedding-3-small',
    dims: DIMS,
    gate: logged(memory, events),
    purpose: 'test',
    fetch,
    baseURL: 'http://embeddings.test/v1',
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { embedder, events, memory, sleeps, requests };
}

const TEXTS = ['Probable cause · CESSNA 172S · Landing\nThe pilot’s failure to flare.', 'Analysis · PIPER PA-28\nFuel exhaustion.'];
const TOKENS = TEXTS.reduce((n, t) => n + countTokens(t), 0);
const RESERVE = reservationUsd(TOKENS, PRICE);

describe('OpenAI embedder', () => {
  it('reserves before dispatch, settles at the reported usage and decodes vectors in input order', async () => {
    const { embedder, events, memory, requests } = embedderWith([{ status: 200, body: okBody(2, TOKENS) }]);
    const res = await embedder.embed(TEXTS);
    expect(events).toEqual([`reserve ${RESERVE.toFixed(6)}`, 'fetch', `settle ${ceilUsd((TOKENS * PRICE) / 1e6).toFixed(6)}`]);
    expect(res.tokens).toBe(TOKENS);
    expect(Array.from(res.vectors[0] as Float32Array)).toEqual(Array.from(new Float32Array(DIMS).map((_, i) => i / 10)));
    expect(Array.from(res.vectors[1] as Float32Array)).toEqual(Array.from(new Float32Array(DIMS).map((_, i) => (i + 1) / 10)));
    expect(requests[0]?.body).toMatchObject({ model: 'text-embedding-3-small', input: TEXTS, dimensions: DIMS, encoding_format: 'base64' });
    expect(memory.records).toEqual([expect.objectContaining({ category: 'indexing', status: 'settled', reservedUsd: RESERVE })]);
    expect(RESERVE).toBeGreaterThanOrEqual((TOKENS * PRICE * RESERVATION_SAFETY_FACTOR) / 1e6);
  });

  it('reserves and settles every attempt separately: 429 at zero, 5xx and lost connections in full', async () => {
    const { embedder, events, memory, sleeps } = embedderWith([
      { status: 429, body: { error: { message: 'slow down', type: 'requests', code: 'rate_limit_exceeded' } } },
      { status: 503 },
      { status: 200, body: okBody(2, TOKENS) },
    ]);
    await embedder.embed(TEXTS);
    const reserve = `reserve ${RESERVE.toFixed(6)}`;
    expect(events).toEqual([
      reserve, 'fetch', 'settle 0.000000',
      reserve, 'fetch', 'settle uncertain',
      reserve, 'fetch', `settle ${ceilUsd((TOKENS * PRICE) / 1e6).toFixed(6)}`,
    ]);
    expect(memory.records.map((r) => [r.status, r.chargedUsd])).toEqual([
      ['settled', 0],
      ['uncertain', RESERVE],
      ['settled', ceilUsd((TOKENS * PRICE) / 1e6)],
    ]);
    expect(memory.chargedUsd('indexing')).toBeCloseTo(RESERVE + ceilUsd((TOKENS * PRICE) / 1e6), 9);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('gives up after three attempts, leaving uncertain attempts charged at their reservation', async () => {
    const lost = () => ({ throw: Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') }) });
    const { embedder, events, memory } = embedderWith([lost(), lost(), lost(), { status: 200, body: okBody(2, TOKENS) }]);
    const err = await embedder.embed(TEXTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingRequestError);
    expect((err as EmbeddingRequestError).attempts).toBe(3);
    expect(events.filter((e) => e === 'fetch')).toHaveLength(3);
    expect(memory.records.map((r) => r.status)).toEqual(['uncertain', 'uncertain', 'uncertain']);
    expect(memory.chargedUsd('indexing')).toBeCloseTo(3 * RESERVE, 9);
  });

  it('does not retry client errors or an exhausted quota, and never puts the key in the error', async () => {
    for (const step of [
      { status: 400, body: { error: { message: 'bad input', type: 'invalid_request_error', code: null } } },
      { status: 401, body: { error: { message: 'bad key', type: 'invalid_request_error', code: 'invalid_api_key' } } },
      { status: 429, body: { error: { message: 'quota', type: 'insufficient_quota', code: 'insufficient_quota' } } },
    ]) {
      const { embedder, events, memory } = embedderWith([step, { status: 200, body: okBody(2, TOKENS) }]);
      const err = (await embedder.embed(TEXTS).catch((e: unknown) => e)) as EmbeddingRequestError;
      expect(err).toBeInstanceOf(EmbeddingRequestError);
      expect(err.status).toBe(step.status);
      expect(events.filter((e) => e === 'fetch')).toHaveLength(1);
      expect(memory.records.map((r) => [r.status, r.chargedUsd])).toEqual([['settled', 0]]);
      expect(String(err.message)).not.toContain(API_KEY);
    }
  });

  it('honours Retry-After within the delay cap', async () => {
    const { embedder, sleeps } = embedderWith([
      { status: 429, headers: { 'retry-after': '7' }, body: { error: { message: 'slow', type: 'requests', code: 'rate_limit_exceeded' } } },
      { status: 200, body: okBody(2, TOKENS) },
    ]);
    await embedder.embed(TEXTS);
    expect(sleeps).toEqual([7000]);
  });

  it('sends nothing when the reservation is refused', async () => {
    const { embedder, events } = embedderWith([{ status: 200, body: okBody(2, TOKENS) }], 0);
    await expect(embedder.embed(TEXTS)).rejects.toBeInstanceOf(SpendRefusedError);
    expect(events).toEqual([]);
  });

  it('settles a malformed response at its usage and fails without retrying', async () => {
    const { embedder, memory, events } = embedderWith([{ status: 200, body: okBody(1, TOKENS) }, { status: 200, body: okBody(2, TOKENS) }]);
    await expect(embedder.embed(TEXTS)).rejects.toThrow(/invalid embedding response/);
    expect(events.filter((e) => e === 'fetch')).toHaveLength(1);
    expect(memory.records.map((r) => [r.status, r.chargedUsd])).toEqual([['settled', ceilUsd((TOKENS * PRICE) / 1e6)]]);
  });

  it('refuses batches over the request limits before reserving anything', async () => {
    const { embedder, events } = embedderWith([]);
    await expect(embedder.embed([])).rejects.toThrow(/1\.\.96 inputs/);
    await expect(embedder.embed(Array.from({ length: 97 }, () => 'x'))).rejects.toThrow(/1\.\.96 inputs/);
    await expect(embedder.embed(['word '.repeat(8200)])).rejects.toThrow(/limit is 8192/);
    expect(events).toEqual([]);
  });

  it('refuses a model without a known price', () => {
    expect(() =>
      createOpenAIEmbedder({ apiKey: API_KEY, model: 'text-embedding-9', dims: DIMS, gate: createMemorySpendGate(1), purpose: 't' }),
    ).toThrow(/no price/);
  });
});

describe('batching', () => {
  it('groups at most 96 inputs and 250,000 tokens per request', () => {
    const many = Array.from({ length: 200 }, (_, i) => i);
    expect(batchByLimits(many, () => 10).map((b) => b.length)).toEqual([96, 96, 8]);
    const heavy = Array.from({ length: 70 }, (_, i) => i);
    const batches = batchByLimits(heavy, () => 8000);
    expect(batches.map((b) => b.length)).toEqual([31, 31, 8]);
    for (const b of batches) expect(b.length * 8000).toBeLessThanOrEqual(EMBEDDING_LIMITS.maxBatchTokens);
    expect(() => batchByLimits([1], () => 9000)).toThrow(/exceeds the limit/);
    expect(checkBatch(['a b c', 'd'])).toBe(countTokens('a b c') + countTokens('d'));
  });

  it('parses rate-limit reset durations', () => {
    expect(parseResetDuration('6m0s')).toBe(360_000);
    expect(parseResetDuration('1.5s')).toBe(1500);
    expect(parseResetDuration('120ms')).toBe(120);
    expect(parseResetDuration('soon')).toBeUndefined();
    expect(parseResetDuration(null)).toBeUndefined();
  });
});

describe('fake embedder and vector bytes', () => {
  it('is deterministic, unit-length and free', async () => {
    const fake = createFakeEmbedder(32);
    const a = await fake.embed(['one', 'two']);
    const b = await fake.embed(['one']);
    expect(Array.from(a.vectors[0] as Float32Array)).toEqual(Array.from(b.vectors[0] as Float32Array));
    expect(Array.from(a.vectors[0] as Float32Array)).not.toEqual(Array.from(a.vectors[1] as Float32Array));
    const norm = Math.sqrt((a.vectors[1] as Float32Array).reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(fake.usdPerMillionTokens).toBe(0);
    expect(fake.calls).toEqual([['one', 'two'], ['one']]);
  });

  it('round-trips float32 vectors through cache bytes', () => {
    const v = fakeVector('x', 1536);
    expect(Array.from(bytesToVector(vectorToBytes(v), 1536))).toEqual(Array.from(v));
    expect(() => bytesToVector(Buffer.alloc(12), 4)).toThrow();
  });
});

describe('spend gates', () => {
  it('shares one allowance and charges open and uncertain reservations in full', async () => {
    const gate = createMemorySpendGate(0.01);
    const a = await gate.reserve({ category: 'indexing', usd: 0.004, purpose: 'a' });
    const b = await gate.reserve({ category: 'evaluation', usd: 0.004, purpose: 'b' });
    await expect(gate.reserve({ category: 'indexing', usd: 0.004, purpose: 'c' })).rejects.toBeInstanceOf(SpendRefusedError);
    await gate.settle(a, { usd: 0.001 });
    await gate.settle(b, 'uncertain');
    expect(await gate.remainingUsd('indexing')).toBeCloseTo(0.005, 9);
    await expect(gate.settle(a, { usd: 0 })).rejects.toThrow(/already settled/);
    await expect(gate.settle({ reservationId: 'nope', fencingToken: 'x' }, { usd: 0 })).rejects.toThrow(/unknown/);
  });

  it('never lets a dry run reserve, and fails closed until the ledger is wired', async () => {
    const dry = createDryRunSpendGate(createMemorySpendGate(20));
    await expect(dry.reserve({ category: 'indexing', usd: 0.001, purpose: 'x' })).rejects.toBeInstanceOf(SpendRefusedError);
    expect(await dry.remainingUsd('indexing')).toBe(20);
    expect(() => createLedgerSpendGate({} as Db)).toThrow(/wired at merge/);
  });
});
