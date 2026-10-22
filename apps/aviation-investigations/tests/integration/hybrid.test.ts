/**
 * Hybrid retrieval against a real passages index of the fixture corpus (fake
 * embeddings under the production model name, so the approved passages contract
 * applies; no paid call): one filter on both channels and the fetch, the compulsory
 * country and answer-eligibility clauses, aircraft attribution in the two-aircraft
 * fixtures, the bundle limits, every cause variant attached, and the passages contract
 * at publication and in the API's dataset loader.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errors, type Client } from '@elastic/elasticsearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { SearchRequestSchema } from '../../shared/contracts/search.js';
import { DatasetResolver } from '../../server/dataset.js';
import { keywordSearch } from '../../server/search/keyword.js';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { getActiveManifest } from '../../server/db/generations.js';
import { RetrievalUnavailableError, fetchAndPack, rankingOf, retrieveCandidates, retrieveEvidence, type PassageHit } from '../../server/search/hybrid.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { createFakeEmbedder, fakeVector } from '../../worker/index/embed.js';
import { PASSAGES_EMBEDDING_DIMS, rebuildPassagesIndex, type PassageDoc } from '../../worker/index/passages-index.js';
import { PublishRefusedError, publishGeneration } from '../../worker/index/publish.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { makeExtractDir, removeDir } from '../support/extract-dir.js';
import { loadVerified } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetCorpus, testDbUrl, testEs } from './helpers.js';

const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const DIMS = PASSAGES_EMBEDDING_DIMS;
/** Fake vectors under the configured model's name: the index gets the approved fingerprint. */
const MODEL = 'text-embedding-3-small';
const embedder = createFakeEmbedder(DIMS, MODEL);
const MIDAIR = 'midair collision of an airliner and a helicopter route close to the runway approach path';

let ingest: Db;
let es: Client;
let fixtureDir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-hybrid-test-'));
let generationId: number;
let index: string;
let casesIndex: string;
/** Synthetic documents added to the built index (removed before the publication tests). */
const SYNTHETIC = ['foreign1', 'ineligible1', 'dca-cause-variant-2'];
const dataset = () => ({ generationId, passagesIndex: index });

/** Synthetic passages the filters must exclude: they are the best match for `MIDAIR` in both channels. */
function intruder(id: string, over: Partial<PassageDoc>): PassageDoc {
  return {
    passage_id: id,
    ntsb_no: id.toUpperCase(),
    section_id: `${id.toUpperCase()}:probable_cause/aircraft-1`,
    revision_id: 'r',
    section_kind: 'probable_cause',
    scope: 'aircraft',
    aircraft_specific: true,
    aircraft_key: 1,
    start: 0,
    end: MIDAIR.length,
    part: 1,
    parts: 1,
    continuation: false,
    text: `${MIDAIR}. ${MIDAIR}.`,
    embedding: Array.from(fakeVector(queryEmbeddingInput(MIDAIR), DIMS)),
    country: 'USA',
    ev_year: 2025,
    ev_date: '2025-01-29',
    state: 'DC',
    answer_eligible: true,
    defining_phase_groups: ['approach'],
    highest_injury: 'FATL',
    wx_cond: 'VMC',
    light: 'NITE',
    aircraft: [
      { aircraft_key: 1, category: 'AIR', make: 'X', model: 'Y', far_part: '121', purpose: 'BUS', eng_types: ['TF'], defining_phase_group: 'approach' },
    ],
    event_aircraft: [],
    ...over,
  };
}

const allPassages = (r: { cases: { passages: { ntsbNo: string; aircraftSpecific: boolean; id: string }[] }[] }) => r.cases.flatMap((c) => c.passages);

beforeAll(async () => {
  await resetCorpus();
  ingest = createDb(testDbUrl('ingest'), { max: 4, applicationName: 'aviation-test-hybrid' });
  es = testEs();
  fixtureDir = await makeExtractDir();
  generationId = await loadVerified(ingest, fixtureDir, reportDir);
  const built = await rebuildPassagesIndex(es, ingest, embedder, {
    generationId,
    prefix: PREFIX,
    gate: createMemorySpendGate(1),
    confirmCost: true,
  });
  index = built.index;
  casesIndex = (await rebuildCasesIndex(es, ingest, { generationId, prefix: PREFIX })).index;
  // A second, distinct event-scoped cause variant of the two-aircraft fixture DCA25MA108
  // (the fixture's own causes are identical, so it holds one variant).
  const [dcaCause] = (
    await es.search<PassageDoc>({ index, size: 1, query: { bool: { filter: [{ term: { ntsb_no: 'DCA25MA108' } }, { term: { section_kind: 'probable_cause' } }] } } })
  ).hits.hits;
  const variant: PassageDoc = {
    ...(dcaCause?._source as PassageDoc),
    passage_id: 'dca-cause-variant-2',
    section_id: 'DCA25MA108:probable_cause/event-2',
    revision_id: 'r2',
    text: 'The helicopter crew’s failure to maintain visual separation from the airplane.',
    embedding: Array.from(fakeVector('variant', DIMS)),
  };
  const operations = [
    intruder('foreign1', { country: 'CAN', state: null }),
    intruder('ineligible1', { answer_eligible: false }),
    variant,
  ].flatMap((d) => [{ create: { _index: index, _id: d.passage_id } }, d]);
  const res = await es.bulk({ operations, refresh: true });
  expect(res.errors).toBe(false);
}, 180_000);

afterAll(async () => {
  const found = await es.indices.get({ index: `${PREFIX}-*`, expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: true });
  for (const name of Object.keys(found)) await es.indices.delete({ index: name });
  await closeDb(ingest);
  for (const d of [fixtureDir, reportDir]) removeDir(d);
});

describe('hybrid retrieval on the fixture corpus', () => {
  it('finds a US case by its words and its meaning, with its probable cause attached', async () => {
    const r = await retrieveEvidence(es, embedder, {
      dataset: dataset(),
      text: 'helicopter engine stopped: castellated nut came loose and the cotter pin was missing after the engine was replaced',
    });
    const dfw = r.cases.find((c) => c.ntsbNo === 'DFW08TA066');
    expect(dfw).toBeDefined();
    expect(r.cases[0]?.ntsbNo).toBe('DFW08TA066');
    expect(dfw?.passages.some((p) => p.sectionKind === 'probable_cause' && p.role === 'probable_cause')).toBe(true);
    expect(dfw?.passages.find((p) => p.sectionKind === 'probable_cause')?.text).toMatch(/castellated nut/);
    expect(r.candidates.keyword).toBeGreaterThan(0);
    expect(r.candidates.vector).toBe(50);
    expect(r.queryEmbedding.tokens).toBeGreaterThan(0);
  });

  it('never returns a foreign or non-answer-eligible passage, even when it is the best match in both channels', async () => {
    const c = await retrieveCandidates(es, embedder, { dataset: dataset(), text: MIDAIR, params: { perChannel: 100 } });
    const ids = [...c.keyword, ...c.vector].map((h) => h.id);
    expect(ids).not.toContain('foreign1');
    expect(ids).not.toContain('ineligible1');
    // Without the compulsory clauses both would rank first (this proves the fixture works).
    const raw = await es.search({ index, size: 2, query: { match: { text: MIDAIR } }, _source: ['passage_id'] });
    expect(raw.hits.hits.map((h) => h._id).sort()).toEqual(['foreign1', 'ineligible1']);
    const r = await retrieveEvidence(es, embedder, { dataset: dataset(), text: MIDAIR });
    expect(allPassages(r).map((p) => p.id)).not.toContain('foreign1');
    // The US midair case is found through its event-scoped passages when no aircraft filter is set
    // (fake vectors are noise, so this looks at the BM25 channel).
    expect(c.keyword[0]).toMatchObject({ ntsbNo: 'DCA25MA108', aircraftSpecific: false, scope: 'event' });
    expect(rankingOf(c, 'keyword')[0]?.ntsbNo).toBe('DCA25MA108');
  });

  it('two-aircraft fixture: airplane filter never returns helicopter-scoped passage', async () => {
    for (const category of [['AIR'], ['HELI'], ['blank'], ['AIR', 'HELI']]) {
      const c = await retrieveCandidates(es, embedder, { dataset: dataset(), text: MIDAIR, filters: { category }, params: { perChannel: 100 } });
      const hits: PassageHit[] = [...c.keyword, ...c.vector];
      // DCA25MA108 (airliner and Army helicopter) and SEA08LA057 (two airplanes) have only
      // event-scoped passages: no aircraft filter can be satisfied by them.
      expect(hits.filter((h) => !h.aircraftSpecific)).toEqual([]);
      expect(hits.map((h) => h.ntsbNo)).not.toContain('DCA25MA108');
      expect(hits.map((h) => h.ntsbNo)).not.toContain('SEA08LA057');
      const packed = await fetchAndPack(es, c.index, c.filter, c.cases, c.params);
      expect(packed.cases.flatMap((x) => x.passages).every((p) => p.aircraftSpecific)).toBe(true);
    }
    // The helicopter filter only finds single-helicopter cases, the airplane filter only airplanes.
    const heli = await retrieveEvidence(es, embedder, { dataset: dataset(), text: MIDAIR, filters: { category: ['HELI'] } });
    expect(new Set(heli.cases.map((x) => x.ntsbNo))).toEqual(new Set(['DFW08TA066', 'CEN19FA024']));
    const air = await retrieveEvidence(es, embedder, { dataset: dataset(), text: MIDAIR, filters: { category: ['AIR'] } });
    expect(air.cases.map((x) => x.ntsbNo)).not.toContain('DFW08TA066');
    expect(air.cases.length).toBeGreaterThan(0);
    // An event filter alone keeps the event-scoped passages of a multi-aircraft event.
    const fatal = await retrieveCandidates(es, embedder, { dataset: dataset(), text: MIDAIR, filters: { injury: ['FATL'] } });
    expect(fatal.keyword[0]).toMatchObject({ ntsbNo: 'DCA25MA108', aircraftSpecific: false });
  });

  it('never more than 6 cases / 12 passages, each case with its probable cause', async () => {
    for (const perChannel of [50, 100]) {
      const r = await retrieveEvidence(es, embedder, { dataset: dataset(), text: 'loss of engine power during cruise flight', params: { perChannel } });
      expect(r.cases.length).toBe(6);
      expect(r.passages).toBeLessThanOrEqual(12);
      expect(allPassages(r)).toHaveLength(r.passages);
      expect(new Set(allPassages(r).map((p) => p.id)).size).toBe(r.passages);
      for (const c of r.cases) {
        expect(c.passages.length).toBeLessThanOrEqual(3);
        expect(c.passages.every((p) => p.ntsbNo === c.ntsbNo)).toBe(true);
        expect(c.passages.some((p) => p.sectionKind === 'probable_cause')).toBe(true);
      }
      expect(r.tokens).toBeLessThanOrEqual(r.params.maxEvidenceTokens);
    }
  });

  it('ranks cases from either channel alone or fused', async () => {
    const c = await retrieveCandidates(es, embedder, { dataset: dataset(), text: 'carburetor icing', params: { perChannel: 100 } });
    for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
      const ranking = rankingOf(c, mode);
      expect(new Set(ranking.map((x) => x.ntsbNo)).size).toBe(ranking.length);
      expect(ranking.map((x) => x.rank)).toEqual(ranking.map((_, i) => i + 1));
    }
    expect(rankingOf(c, 'hybrid').length).toBeGreaterThanOrEqual(rankingOf(c, 'keyword').length);
  });

  it('refuses a keyword-only dataset and an index of another generation', async () => {
    await expect(retrieveEvidence(es, embedder, { dataset: { generationId, passagesIndex: null }, text: 'x' })).rejects.toBeInstanceOf(
      RetrievalUnavailableError,
    );
    await expect(retrieveEvidence(es, embedder, { dataset: { generationId: generationId + 1, passagesIndex: index }, text: 'x' })).rejects.toThrow(
      /generation/,
    );
    await expect(retrieveEvidence(es, createFakeEmbedder(DIMS), { dataset: dataset(), text: 'x' })).rejects.toThrow(
      /embedding model text-embedding-3-small \(expected fake-embedding-v1\)/,
    );
  });

  it('attaches every event-scoped cause variant of an unfiltered two-aircraft case, with the passage that ranked it', async () => {
    const c = await retrieveCandidates(es, embedder, { dataset: dataset(), text: MIDAIR });
    const ranking = rankingOf(c, 'keyword');
    expect(ranking[0]?.ntsbNo).toBe('DCA25MA108');
    const packed = await fetchAndPack(es, c.index, c.filter, ranking, c.params);
    const dca = packed.cases.find((x) => x.ntsbNo === 'DCA25MA108');
    const causes = await es.search({
      index,
      size: 20,
      _source: false,
      query: { bool: { filter: [{ term: { ntsb_no: 'DCA25MA108' } }, { term: { section_kind: 'probable_cause' } }] } },
    });
    const variants = causes.hits.hits.map((h) => h._id).sort();
    expect(variants).toHaveLength(2);
    expect(dca?.passages.filter((p) => p.sectionKind === 'probable_cause').map((p) => p.id).sort()).toEqual(variants);
    expect(dca?.passages.every((p) => p.scope === 'event' && !p.aircraftSpecific)).toBe(true);
    expect(dca?.passages.every((p) => p.reserved || p.role !== 'probable_cause')).toBe(true);
    // The case keeps a retrieved passage: the best one that ranked it.
    expect(dca?.passages.some((p) => p.reserved && p.fusedRank === 1)).toBe(true);
  });
});

describe('the passages contract at publication and in the API', () => {
  const embedding = { model: MODEL, dims: DIMS };
  const publish = (over: { embedding?: { model: string; dims: number } } = {}) =>
    publishGeneration(es, ingest, { generationId, casesIndex, passagesIndex: index, embedding, ...over });

  it('refuses an index whose documents do not match the stored passages', async () => {
    // The synthetic documents make the index larger than the generation's passages rows.
    await expect(publish()).rejects.toThrow(/holds \d+ documents; generation \d+ has \d+ chunk-v2 passages/);
  });

  it('refuses a wrong fingerprint, an unknown chunker or template, other dimensions and no embedding', async () => {
    const original = (await es.indices.getMapping({ index }))[index]?.mappings?._meta as Record<string, unknown>;
    const withMeta = async (change: Record<string, unknown>, message: RegExp) => {
      await es.indices.putMapping({ index, _meta: { ...original, ...change } });
      await expect(publish()).rejects.toThrow(message);
    };
    try {
      await withMeta({ fingerprint: 'e'.repeat(64) }, /fingerprint eeeeeeeeeeee \(expected 57d731b28445\)/);
      await withMeta({ chunker_version: 'chunk-v9' }, /chunker chunk-v9 \(expected chunk-v2\)/);
      await withMeta({ input_template_version: 'input-v9' }, /input template input-v9 \(expected input-v1\)/);
      await withMeta({ embedding_dims: 512 }, /512 dimensions \(expected 1536\)/);
      await withMeta({ index_version: 'passages-v2' }, /index version passages-v2/);
    } finally {
      await es.indices.putMapping({ index, _meta: original });
    }
    await expect(publish({ embedding: { model: MODEL, dims: 512 } })).rejects.toThrow(/no approved fingerprint for text-embedding-3-small\/512/);
    await expect(publishGeneration(es, ingest, { generationId, casesIndex, passagesIndex: index })).rejects.toThrow(
      /needs the configured embedding model/,
    );
    await expect(publish()).rejects.toBeInstanceOf(PublishRefusedError);
  });

  it('publishes a matching index, and the API marks it servable only for the configured embedding', async () => {
    for (const id of SYNTHETIC) await es.delete({ index, id, refresh: true });
    const r = await publish();
    expect(r.passagesDocuments).toBeGreaterThan(0);
    const app = createDb(testDbUrl('app'), { max: 2, applicationName: 'aviation-test-hybrid-app' });
    try {
      expect((await getActiveManifest(app))?.passagesIndex).toBe(index);
      const servable = await new DatasetResolver(app, es, { embedding }).current();
      expect(servable.passages).toEqual({ index, servable: true });
      const other = await new DatasetResolver(app, es, { embedding: { model: MODEL, dims: 512 } }).current();
      expect(other.passages).toEqual({ index, servable: false, code: 'incompatible', reason: 'incompatible:embedding_dims,fingerprint' });
      const unconfigured = await new DatasetResolver(app, es).current();
      expect(unconfigured.passages).toEqual({ index, servable: false, code: 'not_configured', reason: 'embedding_not_configured' });
      // Keyword search keeps working either way: the dataset itself resolves.
      expect(other.dataset.revision).toBe(servable.dataset.revision);
    } finally {
      await closeDb(app);
    }
  });

  /**
   * The real client, except that reading the passages index mapping follows `mode()`:
   * pass through, throw, or never answer. Counts the reads of each index's mapping.
   */
  type Mode = 'ok' | 'throws' | 'hangs' | 'upstream';
  /** An Elasticsearch error whose server reason carries a sentinel (G5 sanitising regression). */
  const upstreamError = () =>
    new errors.ResponseError({
      body: { error: { root_cause: [{ type: 'x', reason: 'SENTINEL_UPSTREAM' }], type: 'search_phase_execution_exception', reason: 'SENTINEL_UPSTREAM' }, status: 503 },
      statusCode: 503,
      headers: {},
      warnings: null,
      meta: { context: null, name: 'es', request: { params: { method: 'GET', path: '/' }, options: {}, id: 1 }, connection: null, attempts: 0, aborted: false },
    } as never);

  function flakyClient(mode: () => Mode): { client: Client; reads: Map<string, number> } {
    const reads = new Map<string, number>();
    const client = new Proxy(es, {
      get(target, prop) {
        if (prop === 'indices') {
          const indices = target.indices;
          return new Proxy(indices, {
            get(t, p) {
              if (p === 'getMapping') {
                return (params: { index: string }, opts?: unknown) => {
                  reads.set(params.index, (reads.get(params.index) ?? 0) + 1);
                  const m = params.index === index ? mode() : 'ok';
                  if (m === 'throws') return Promise.reject(new Error('connection reset SENTINEL_UPSTREAM'));
                  if (m === 'upstream') return Promise.reject(upstreamError());
                  if (m === 'hangs') return new Promise(() => undefined);
                  return t.getMapping(params, opts as never);
                };
              }
              const v = Reflect.get(t, p) as unknown;
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
            },
          });
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return { client, reads };
  }

  it('degrades to unservable passages when their check fails or hangs, and keyword search still answers', async () => {
    const app = createDb(testDbUrl('app'), { max: 2, applicationName: 'aviation-test-hybrid-app' });
    try {
      const expected = { throws: 'unexpected', upstream: 'http_503', hangs: 'timeout' } as const;
      for (const mode of ['throws', 'upstream', 'hangs'] as const) {
        const { client: flaky } = flakyClient(() => mode);
        const logged: unknown[][] = [];
        const resolver = new DatasetResolver(app, flaky, {
          embedding,
          passagesCheckTimeoutMs: 300,
          onPassagesUnservable: (...args) => logged.push(args),
        });
        const started = Date.now();
        const pinned = await resolver.current();
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(pinned.passages).toEqual({ index, servable: false, code: 'unavailable', reason: expected[mode] });
        expect(logged).toEqual([[index, 'unavailable', expected[mode]]]);
        // No upstream text in the stored status or in what is logged.
        expect(JSON.stringify(pinned.passages)).not.toContain('SENTINEL_UPSTREAM');
        expect(JSON.stringify(logged)).not.toContain('SENTINEL_UPSTREAM');
        const r = await keywordSearch({ es: flaky, db: app }, pinned, SearchRequestSchema.parse({ q: 'engine' }));
        expect(r.total).toBeGreaterThan(0);
      }
    } finally {
      await closeDb(app);
    }
  });

  it('checks a transient passages failure again after the retry delay, once for all callers, without reloading keyword facts', async () => {
    const app = createDb(testDbUrl('app'), { max: 2, applicationName: 'aviation-test-hybrid-app' });
    try {
      let mode: Mode = 'upstream';
      const { client: flaky, reads } = flakyClient(() => mode);
      let clock = 1_000_000;
      const resolver = new DatasetResolver(app, flaky, { embedding, passagesRetryMs: 30_000, now: () => clock });

      // First load: a transient error. AI evidence is off, keyword search works.
      const first = await resolver.current();
      expect(first.passages).toEqual({ index, servable: false, code: 'unavailable', reason: 'http_503' });
      expect((await keywordSearch({ es: flaky, db: app }, first, SearchRequestSchema.parse({ q: 'engine' }))).total).toBeGreaterThan(0);
      expect(reads.get(index)).toBe(1);
      const casesReads = reads.get(casesIndex);

      // Elasticsearch recovers, but within the retry delay the failure is not re-checked.
      mode = 'ok';
      clock += 29_000;
      expect((await resolver.current()).passages).toMatchObject({ servable: false, code: 'unavailable' });
      expect(reads.get(index)).toBe(1);

      // After the delay, concurrent callers start one shared re-check and get the last status meanwhile.
      clock += 2_000;
      const during = await Promise.all(Array.from({ length: 5 }, () => resolver.current()));
      for (const d of during) expect(d.passages).toMatchObject({ servable: false });
      for (let i = 0; i < 50 && (await resolver.current()).passages?.servable !== true; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(reads.get(index)).toBe(2);
      const recovered = await resolver.current();
      expect(recovered.passages).toEqual({ index, servable: true });
      // The same resolver instance and the same manifest: no publication in between.
      expect(recovered.manifest).toEqual(first.manifest);
      // Same manifest, same keyword facts: the cases index was not read again.
      expect(recovered.dataset.revision).toBe(first.dataset.revision);
      expect(reads.get(casesIndex)).toBe(casesReads);

      // A servable answer is kept for the manifest: no further reads.
      clock += 120_000;
      expect((await resolver.current()).passages).toEqual({ index, servable: true });
      expect(reads.get(index)).toBe(2);
    } finally {
      await closeDb(app);
    }
  });

  it('keeps a definitive incompatibility for the manifest and never re-checks it', async () => {
    const app = createDb(testDbUrl('app'), { max: 2, applicationName: 'aviation-test-hybrid-app' });
    try {
      const { client, reads } = flakyClient(() => 'ok');
      let clock = 1_000_000;
      const resolver = new DatasetResolver(app, client, { embedding: { model: MODEL, dims: 512 }, passagesRetryMs: 30_000, now: () => clock });
      expect((await resolver.current()).passages).toMatchObject({ servable: false, code: 'incompatible' });
      clock += 300_000;
      expect((await resolver.current()).passages).toMatchObject({ servable: false, code: 'incompatible' });
      expect(reads.get(index)).toBe(1);
    } finally {
      await closeDb(app);
    }
  });
});
