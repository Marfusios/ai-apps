/**
 * The binding's settlement guards (server/briefs/retriever.ts), with hybrid retrieval's
 * two stages replaced: a usage callback arriving after `retrieve` returned or threw is
 * ignored, the callback is handed on once, an already aborted signal stops the embedder
 * before anything is sent (so the failure bills nothing), and the bundle carries the
 * chunker of the served index's contract.
 */
import type { Client } from '@elastic/elasticsearch';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Embedder } from '../../server/ai/embeddings.js';
import { RetrievalFailure, type EmbeddingUsage, type EvidenceQuery } from '../../server/briefs/evidence.js';
import type * as Hybrid from '../../server/search/hybrid.js';

const stages = vi.hoisted(() => ({ retrieveCandidates: vi.fn(), fetchAndPack: vi.fn() }));
vi.mock('../../server/search/hybrid.js', async (importOriginal) => ({ ...(await importOriginal<typeof Hybrid>()), ...stages }));

const { createHybridRetriever } = await import('../../server/briefs/retriever.js');
const { retrievalParams } = await import('../../server/search/hybrid.js');
const { RETRIEVAL_V1 } = await import('../../server/search/retrieval-config.js');

type Callback = NonNullable<Hybrid.RetrievalQuery['onQueryEmbedding']>;

const QUERY: EvidenceQuery = {
  dataset: { generationId: 1, passagesIndex: 'passages-test' },
  text: 'engine power loss after maintenance',
  keywordText: 'engine power loss',
  filters: {},
};

const USAGE: Hybrid.QueryEmbeddingUsage = {
  model: 'text-embedding-3-small',
  dims: 4,
  inputTemplate: 'q1',
  tokens: 12,
  usd: 0.00000024,
  billing: 'reported',
};

const PACKED: Hybrid.PackedEvidence = { cases: [], passages: 0, tokens: 0, skipped: [], trimmed: [], request: null, timingMs: 0 };

/** Candidates as retrieval returns them; only the fields the binding reads matter. */
const candidates = (chunkerVersion: string) =>
  ({ index: 'passages-test', indexVersion: 'passages-v1', chunkerVersion, filter: [], cases: [], params: retrievalParams() }) as unknown as Hybrid.CandidateResult;

function embedder(): Embedder & { embed: ReturnType<typeof vi.fn> } {
  return {
    model: 'text-embedding-3-small',
    dims: 4,
    usdPerMillionTokens: 0.02,
    embed: vi.fn(async () => ({ vectors: [[0, 0, 0, 1]], usage: { promptTokens: 12, totalTokens: 12 } })),
  } as unknown as Embedder & { embed: ReturnType<typeof vi.fn> };
}

const live = () => new AbortController().signal;

beforeEach(() => {
  stages.retrieveCandidates.mockReset();
  stages.fetchAndPack.mockReset();
});

describe('the hybrid binding’s settlement guards', () => {
  it('hands the usage on once, and ignores a callback after retrieve returned', async () => {
    let late: Callback | undefined;
    stages.retrieveCandidates.mockImplementation(async (_es: Client, _e: Embedder, q: Hybrid.RetrievalQuery) => {
      late = q.onQueryEmbedding;
      q.onQueryEmbedding?.(USAGE);
      q.onQueryEmbedding?.(USAGE);
      return candidates('chunk-v2');
    });
    stages.fetchAndPack.mockResolvedValue(PACKED);
    const seen: EmbeddingUsage[] = [];
    const out = await createHybridRetriever({ es: {} as Client, embedder: embedder(), retrieval: RETRIEVAL_V1 }).retrieve(QUERY, live(), (u) => seen.push(u));
    late!(USAGE);
    expect(seen).toEqual([{ provider: 'openai', model: USAGE.model, tokens: 12, usd: USAGE.usd, billing: 'reported' }]);
    // The chunker of the served index's contract, as retrieval reports it.
    expect(out.chunkerVersion).toBe('chunk-v2');
  });

  it('ignores a callback that arrives after retrieve threw', async () => {
    let late: Callback | undefined;
    stages.retrieveCandidates.mockImplementation(async (_es: Client, _e: Embedder, q: Hybrid.RetrievalQuery) => {
      late = q.onQueryEmbedding;
      throw new Error('search failed');
    });
    const seen: EmbeddingUsage[] = [];
    await expect(createHybridRetriever({ es: {} as Client, embedder: embedder(), retrieval: RETRIEVAL_V1 }).retrieve(QUERY, live(), (u) => seen.push(u))).rejects.toBeInstanceOf(
      RetrievalFailure,
    );
    late!(USAGE);
    expect(seen).toEqual([]);
  });

  it('an already aborted signal stops the embedder before anything is sent: nothing billed', async () => {
    stages.retrieveCandidates.mockImplementation(async (_es: Client, e: Embedder) => {
      await e.embed(['query']);
      return candidates('chunk-v2');
    });
    const e = embedder();
    const c = new AbortController();
    c.abort();
    const err = await createHybridRetriever({ es: {} as Client, embedder: e, retrieval: RETRIEVAL_V1 })
      .retrieve(QUERY, c.signal, () => undefined)
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(RetrievalFailure);
    expect(err).toMatchObject({ kind: 'timeout', reason: 'aborted', embedding: 'none' });
    expect(e.embed).not.toHaveBeenCalled();
  });

  it('an error after the embedder was called, with no usage reported, is uncertain', async () => {
    stages.retrieveCandidates.mockImplementation(async (_es: Client, e: Embedder) => {
      await e.embed(['query']);
      throw new Error('lost the response');
    });
    const e = embedder();
    const err = await createHybridRetriever({ es: {} as Client, embedder: e, retrieval: RETRIEVAL_V1 })
      .retrieve(QUERY, live(), () => undefined)
      .catch((x: unknown) => x);
    expect(err).toMatchObject({ kind: 'failed', embedding: 'uncertain' });
    expect(e.embed).toHaveBeenCalledOnce();
  });

  it('a v1 index is checked under its own contract’s chunker, and a re-pack keeps it', async () => {
    stages.retrieveCandidates.mockResolvedValue(candidates('chunk-v1-test'));
    stages.fetchAndPack.mockResolvedValue(PACKED);
    const out = await createHybridRetriever({ es: {} as Client, embedder: embedder(), retrieval: RETRIEVAL_V1 }).retrieve(QUERY, live(), () => undefined);
    expect(out.chunkerVersion).toBe('chunk-v1-test');
    await out.repack(500, live());
    expect(stages.fetchAndPack).toHaveBeenCalledTimes(2);
    expect(out.chunkerVersion).toBe('chunk-v1-test');
  });
});
