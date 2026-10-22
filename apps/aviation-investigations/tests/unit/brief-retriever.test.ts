/**
 * The brief pipeline's binding to hybrid retrieval (server/briefs/retriever.ts) and the
 * evidence gate of the AI routes (server/briefs/services.ts `servableEvidence`), without
 * Elasticsearch: the query text cut, the failure mapping (fixed kinds, reasons and
 * messages), the bundle mapping and the servable-dataset rule. The binding against a
 * real fixture passages index is covered in tests/integration/briefs.test.ts.
 */
import { errors } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import { MAX_QUERY_INPUT_TOKENS, QueryEmbeddingError, QueryTooLongError, queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { countTokens } from '../../server/ai/tokens.js';
import { RetrievalFailure, type EvidenceRetriever } from '../../server/briefs/evidence.js';
import { fitQueryText, retrievalFailureOf, toEvidenceBundle } from '../../server/briefs/retriever.js';
import { createBriefServices, servableEvidence } from '../../server/briefs/services.js';
import { DatasetUnavailableError, type PinnedDataset } from '../../server/dataset.js';
import type { Db } from '../../server/db/client.js';
import { IncompleteSearchError, MalformedPassageError, RetrievalUnavailableError, type PackedEvidence } from '../../server/search/hybrid.js';

const SENTINEL = 'SENTINEL_UPSTREAM ai-aviation-dev-passages-v1-g1';
const live = () => new AbortController().signal;

describe('fitQueryText', () => {
  it('leaves a question within the embedding cap as it is', () => {
    const q = 'Engine power loss  shortly after\nmaintenance';
    expect(fitQueryText(q)).toBe(q);
  });

  it('cuts a longer text to its longest prefix within the cap, at a word', () => {
    const words = Array.from({ length: 3_000 }, (_, i) => `w${i}x`).join(' ');
    expect(() => queryEmbeddingInput(words)).toThrow(QueryTooLongError);
    const cut = fitQueryText(words);
    expect(words.startsWith(cut)).toBe(true);
    const tokens = countTokens(queryEmbeddingInput(cut));
    expect(tokens).toBeLessThanOrEqual(MAX_QUERY_INPUT_TOKENS);
    expect(tokens).toBeGreaterThan(MAX_QUERY_INPUT_TOKENS - 20);
    expect(words.charAt(cut.length)).toBe(' ');
  });

  it('cuts text in scripts that take several tokens per character, never splitting a code point', () => {
    const text = '発動機の出力が整備直後に失われた事例。'.repeat(200);
    const cut = fitQueryText(text);
    expect(countTokens(queryEmbeddingInput(cut))).toBeLessThanOrEqual(MAX_QUERY_INPUT_TOKENS);
    expect(text.startsWith(cut)).toBe(true);
    expect(cut.length).toBeGreaterThan(100);
  });
});

describe('retrievalFailureOf', () => {
  const cases: [string, unknown, { kind: string; reason: string }][] = [
    ['no passages index', new RetrievalUnavailableError('no_passages_index', SENTINEL), { kind: 'unavailable', reason: 'no_passages_index' }],
    ['a broken contract', new RetrievalUnavailableError('index_mismatch', SENTINEL), { kind: 'unavailable', reason: 'index_mismatch' }],
    ['a query over the cap', new QueryTooLongError(5_000), { kind: 'failed', reason: 'query_too_long' }],
    ['the embedding provider', new QueryEmbeddingError(SENTINEL, { kind: 'api', status: 500 }, 'uncertain'), { kind: 'failed', reason: 'embedding' }],
    ['an incomplete search', new IncompleteSearchError('fetch', SENTINEL), { kind: 'failed', reason: 'incomplete_search' }],
    ['a malformed passage', new MalformedPassageError(SENTINEL, 'text'), { kind: 'failed', reason: 'malformed_passage' }],
    ['an Elasticsearch error', new errors.ConnectionError(SENTINEL), { kind: 'failed', reason: 'search' }],
    ['anything else', new Error(SENTINEL), { kind: 'failed', reason: 'other' }],
  ];
  for (const [what, err, expected] of cases) {
    it(`maps ${what} to a fixed kind, reason and message`, () => {
      const f = retrievalFailureOf(err, live(), 'none');
      expect(f).toBeInstanceOf(RetrievalFailure);
      expect(f).toMatchObject({ ...expected, embedding: 'none' });
      expect(f.message).toBe(`retrieval failed: ${expected.kind} (${expected.reason})`);
      expect(f).not.toHaveProperty('cause');
    });
  }

  it('an aborted stage is a timeout, whatever the error; the embedding billing is kept', () => {
    const c = new AbortController();
    c.abort();
    expect(retrievalFailureOf(new RetrievalUnavailableError('index_mismatch', SENTINEL), c.signal, 'uncertain')).toMatchObject({
      kind: 'timeout',
      reason: 'aborted',
      embedding: 'uncertain',
    });
  });

  it('passes a RetrievalFailure through', () => {
    const f = new RetrievalFailure('failed', 'none', 'the re-packed bundle is empty');
    expect(retrievalFailureOf(f, live(), 'uncertain')).toBe(f);
  });
});

describe('toEvidenceBundle', () => {
  it('maps packed cases and passages to the port, rank by case and fused rank by passage', () => {
    const packed: PackedEvidence = {
      cases: [
        {
          ntsbNo: 'DFW08TA066',
          caseRank: 2,
          caseScore: 0.03,
          passages: [
            {
              id: 'p1',
              ntsbNo: 'DFW08TA066',
              sectionId: 'DFW08TA066:analysis/aircraft-1',
              revisionId: 'r1',
              sectionKind: 'analysis',
              scope: 'aircraft',
              aircraftSpecific: true,
              aircraftKey: 1,
              start: 10,
              end: 20,
              part: 1,
              parts: 2,
              continuation: false,
              text: 'ten chars.',
              role: 'retrieved',
              reserved: true,
              tokens: 3,
              fusedRank: 4,
              fusedScore: 0.02,
            },
            {
              id: 'p2',
              ntsbNo: 'DFW08TA066',
              sectionId: 'DFW08TA066:probable_cause/event',
              revisionId: 'r2',
              sectionKind: 'probable_cause',
              scope: 'event',
              aircraftSpecific: false,
              aircraftKey: null,
              start: 0,
              end: 5,
              part: 1,
              parts: 1,
              continuation: false,
              text: 'cause',
              role: 'probable_cause',
              reserved: true,
              tokens: 1,
              fusedRank: null,
              fusedScore: null,
            },
          ],
        },
      ],
      passages: 2,
      tokens: 4,
      skipped: [],
      trimmed: [],
      request: null,
      timingMs: 1,
    };
    expect(toEvidenceBundle(packed)).toEqual({
      cases: [
        {
          ntsbNo: 'DFW08TA066',
          rank: 2,
          passages: [
            {
              passageId: 'p1',
              ntsbNo: 'DFW08TA066',
              sectionId: 'DFW08TA066:analysis/aircraft-1',
              revisionId: 'r1',
              sectionKind: 'analysis',
              scope: 'aircraft',
              aircraftKey: 1,
              start: 10,
              end: 20,
              text: 'ten chars.',
              role: 'retrieved',
              reserved: true,
              rank: 4,
            },
            {
              passageId: 'p2',
              ntsbNo: 'DFW08TA066',
              sectionId: 'DFW08TA066:probable_cause/event',
              revisionId: 'r2',
              sectionKind: 'probable_cause',
              scope: 'event',
              aircraftKey: null,
              start: 0,
              end: 5,
              text: 'cause',
              role: 'probable_cause',
              reserved: true,
              rank: null,
            },
          ],
        },
      ],
      passages: 2,
      evidenceTokens: 4,
    });
  });
});

describe('servableEvidence', () => {
  const manifest = { generationId: 3 } as PinnedDataset['manifest'];
  const asked: unknown[] = [];
  const retriever = (accepts: boolean): EvidenceRetriever => ({
    available: async (d) => {
      asked.push(d);
      return accepts;
    },
    retrieve: async () => {
      throw new Error('not used');
    },
  });
  const services = (accepts = true) => createBriefServices({} as Db, { retriever: retriever(accepts), catalog: { summaries: async () => new Map(), passages: async () => new Map(), causePassageIds: async () => new Map() } });
  const pinned = (passages: PinnedDataset['passages']) => async () => ({ manifest, passages });

  it('is the active passages index only when the dataset reports it servable and the retriever accepts it', async () => {
    asked.length = 0;
    expect(await servableEvidence(services(), pinned({ index: 'p', servable: true }))).toEqual({ generationId: 3, passagesIndex: 'p' });
    expect(asked).toEqual([{ generationId: 3, passagesIndex: 'p' }]);
    expect(await servableEvidence(services(false), pinned({ index: 'p', servable: true }))).toBeNull();
    for (const code of ['not_configured', 'incompatible', 'unavailable'] as const) {
      expect(await servableEvidence(services(), pinned({ index: 'p', servable: false, code, reason: 'timeout' }))).toBeNull();
    }
    expect(await servableEvidence(services(), pinned(null))).toBeNull();
    expect(await servableEvidence(null, pinned({ index: 'p', servable: true }))).toBeNull();
    // The retriever is asked only about a servable index.
    expect(asked).toHaveLength(2);
  });

  it('a dataset that cannot be served is null, without its reason; other errors propagate', async () => {
    const unavailable = async () => {
      throw new DatasetUnavailableError(SENTINEL);
    };
    expect(await servableEvidence(services(), unavailable)).toBeNull();
    const broken = async () => {
      throw new errors.ConnectionError(SENTINEL);
    };
    await expect(servableEvidence(services(), broken)).rejects.toBeInstanceOf(errors.ConnectionError);
  });
});
