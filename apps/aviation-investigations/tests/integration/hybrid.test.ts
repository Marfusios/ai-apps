/**
 * Hybrid retrieval against a real passages index of the fixture corpus (fake
 * embeddings, no paid call): one filter on both channels and the fetch, the
 * compulsory country and answer-eligibility clauses, aircraft attribution in the
 * two-aircraft fixtures, the bundle limits and the probable-cause attachment.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { RetrievalUnavailableError, fetchAndPack, rankingOf, retrieveCandidates, retrieveEvidence, type PassageHit } from '../../server/search/hybrid.js';
import { createFakeEmbedder, fakeVector } from '../../worker/index/embed.js';
import { PASSAGES_EMBEDDING_DIMS, rebuildPassagesIndex, type PassageDoc } from '../../worker/index/passages-index.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { makeExtractDir, removeDir } from '../support/extract-dir.js';
import { loadVerified } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetCorpus, testDbUrl, testEs } from './helpers.js';

const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const DIMS = PASSAGES_EMBEDDING_DIMS;
const embedder = createFakeEmbedder(DIMS);
const MIDAIR = 'midair collision of an airliner and a helicopter route close to the runway approach path';

let ingest: Db;
let es: Client;
let fixtureDir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-hybrid-test-'));
let generationId: number;
let index: string;
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
  const operations = [
    intruder('foreign1', { country: 'CAN', state: null }),
    intruder('ineligible1', { answer_eligible: false }),
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
    await expect(
      retrieveEvidence(es, createFakeEmbedder(DIMS, 'text-embedding-3-small'), { dataset: dataset(), text: 'x' }),
    ).rejects.toThrow(/embedding model fake-embedding-v1/);
  });
});
