/**
 * Case-level retrieval (`retrieval.v2`, task 10e) on real Elasticsearch, over a fixture
 * variant indexed as passages-v2, passages-v1 and cases-v3 with fake vectors under the
 * production model name (nothing is paid). The variant makes WPR15FA010 an all-helicopter
 * two-aircraft event whose second helicopter has no purpose; DCA25MA108 stays an airliner
 * and an Army helicopter; SEA08LA057 two airplanes in different phases. A synthetic
 * answer-eligible event without aircraft rows is added to the cases index only.
 *
 * - **Filter parity** (adversarial selections, both passages contracts): the cases
 *   channel's filter on the cases index reaches exactly the cases the passages filter
 *   reaches on the passages index, and both equal an independent reference computed from
 *   the PostgreSQL case records. Keyword search's "some aircraft matches" rule would not.
 * - **Requests**: one passages filter on BM25, kNN, mapping and the fetch; the cases
 *   filter as compiled; mixed events never anywhere under a helicopter-only filter;
 *   event scope kept; every cause variant attached; passages-v1 keeps its exclusion.
 * - **Mapping**: cases only the cases channel found (forced with one passage per passage
 *   channel), a long case, several of them competing for six slots; every mapped case's
 *   passages are its own best by exact cosine, all of them considered.
 * - **The binding** with the manifest lookup: the pinned pair, availability, a bundle.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client, estypes } from '@elastic/elasticsearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { createHybridRetriever } from '../../server/briefs/retriever.js';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { manifestCasesIndex, publishManifest } from '../../server/db/generations.js';
import { streamCaseRecords, type CaseRecord, type CaseRecordAircraft } from '../../server/db/queries/case-records.js';
import { MAX_EXACT_CANDIDATES, mapCasesToPassages } from '../../server/search/case-mapping.js';
import { retrieveCaseCandidates } from '../../server/search/case-retrieval.js';
import { casesChannelFilter } from '../../server/search/cases-channel.js';
import { RetrievalFiltersSchema, aircraftSelectionOf, compileFilters, filterClauses, type AircraftSelection, type Query, type RetrievalFilters } from '../../server/search/filters.js';
import { fetchAndPack, retrievalParams } from '../../server/search/hybrid.js';
import { RETRIEVAL_V2, type RetrievalConfig } from '../../server/search/retrieval-config.js';
import { BLANK } from '../../shared/contracts/search.js';
import { CHUNKER_VERSION } from '../../worker/index/chunk.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { createFakeEmbedder, fakeVector } from '../../worker/index/embed.js';
import { EMBEDDING_INPUT_TEMPLATE_VERSION, buildCasePassages } from '../../worker/index/passages.js';
import {
  PASSAGES_EMBEDDING_DIMS,
  PASSAGES_SETTINGS,
  PASSAGES_V1_MAPPING,
  buildPassageDocument,
  loadEventAircraftSets,
  passagesIndexFingerprint,
  rebuildPassagesIndex,
} from '../../worker/index/passages-index.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { editTable, makeExtractDir, removeDir } from '../support/extract-dir.js';
import { evIdOf, loadVerified } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetCorpus, testDbUrl, testEs, testEsReader } from './helpers.js';

const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const DIMS = PASSAGES_EMBEDDING_DIMS;
const MODEL = 'text-embedding-3-small';
const embedder = createFakeEmbedder(DIMS, MODEL);
const GHOST = 'GHOST24LA001';

let ingest: Db;
let app: Db;
let es: Client;
let reader: Client;
let dir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-case-retrieval-test-'));
let generationId: number;
let passagesV2: string;
let passagesV1: string;
let casesIndex: string;
/** Every US case record of the variant generation. */
let records: CaseRecord[];

beforeAll(async () => {
  await resetCorpus();
  ingest = createDb(testDbUrl('ingest'), { max: 4, applicationName: 'aviation-test-case-retrieval' });
  app = createDb(testDbUrl('app'), { max: 2, applicationName: 'aviation-test-case-retrieval-app' });
  es = testEs();
  reader = testEsReader();
  dir = await makeExtractDir({
    edit: (d) => {
      const wpr = evIdOf(d, 'WPR15FA010');
      editTable(d, 'aircraft', (rows) => rows.map((r) => (r.ev_id !== wpr ? r : { ...r, acft_category: 'HELI', ...(r.aircraft_key === '2' ? { type_fly: '' } : {}) })));
    },
  });
  generationId = await loadVerified(ingest, dir, reportDir);
  records = [];
  for await (const r of streamCaseRecords(ingest, generationId)) if (r.isUs) records.push(r);
  passagesV2 = (await rebuildPassagesIndex(es, ingest, embedder, { generationId, prefix: PREFIX, gate: createMemorySpendGate(1), confirmCost: true })).index;
  casesIndex = (await rebuildCasesIndex(es, ingest, { generationId, prefix: PREFIX })).index;

  // The same passages as a passages-v1 index (event aircraft flattened, v1 `_meta`).
  passagesV1 = `${PREFIX}-passages-v1-g${generationId}-manual`;
  await es.indices.create({
    index: passagesV1,
    settings: PASSAGES_SETTINGS,
    mappings: {
      ...PASSAGES_V1_MAPPING,
      _meta: {
        index_version: 'passages-v1',
        fingerprint: passagesIndexFingerprint(MODEL, 'passages-v1'),
        generation_id: generationId,
        build_id: 'manual',
        chunker_version: CHUNKER_VERSION,
        input_template_version: EMBEDDING_INPUT_TEMPLATE_VERSION,
        embedding_model: MODEL,
        embedding_dims: DIMS,
      },
    },
  });
  const sets = await loadEventAircraftSets(ingest, generationId);
  const docs = records
    .filter((r) => r.answerEligible)
    .flatMap((r) =>
      buildCasePassages(r).passages.map((p) => {
        const { event_aircraft_count: _count, event_aircraft_complete: _complete, ...doc } = buildPassageDocument(p, fakeVector(p.input, DIMS), sets);
        return doc;
      }),
    );
  const bulk = await es.bulk({ operations: docs.flatMap((d) => [{ create: { _index: passagesV1, _id: d.passage_id } }, d]), refresh: true });
  expect(bulk.errors).toBe(false);

  // An answer-eligible US event without aircraft rows, in the cases index only (it can have no passage).
  await es.index({
    index: casesIndex,
    id: GHOST,
    refresh: true,
    document: {
      ntsb_no: GHOST,
      ev_date: '2024-05-01',
      ev_year: 2024,
      country: 'USA',
      state: 'TX',
      completion_class: 'completed',
      answer_eligible: true,
      completed_with_cause: true,
      highest_injury: 'FATL',
      defining_phase_groups: [],
      sequence_phase_groups: [],
      defining_events: [],
      aircraft_count: 0,
      aircraft: [],
      probable_cause: ['zeppelin mooring mast collapse during autopilot aileron bellcrank inspection'],
      analysis: [],
      factual: [],
      findings_text: [],
    },
  });
  await publishManifest(ingest, generationId, casesIndex, passagesV2);
}, 240_000);

afterAll(async () => {
  const found = await es.indices.get({ index: `${PREFIX}-*`, expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: true });
  for (const name of Object.keys(found)) await es.indices.delete({ index: name });
  await Promise.all([closeDb(ingest), closeDb(app), reader.close()]);
  for (const d of [dir, reportDir]) removeDir(d);
});

// ---------------------------------------------------------------------------
// The reference: what the passages contract lets AI evidence reach, from PostgreSQL.

const aircraftValue = (a: CaseRecordAircraft, facet: string): string | null =>
  ({ phase: a.definingPhaseGroup, category: a.category, far_part: a.farPart, purpose: a.purpose })[facet] ?? null;

/** One aircraft meets every active facet; `blankMatches`: a missing value meets `blank`. */
function satisfies(a: CaseRecordAircraft, selection: AircraftSelection, blankMatches: boolean): boolean {
  return Object.entries(selection).every(([facet, values]) => {
    if (!values || values.length === 0) return true;
    const codes = values.filter((v) => v !== BLANK);
    const blank = blankMatches && values.includes(BLANK);
    if (facet === 'engine') {
      const types = [...new Set(a.engines.map((e) => e.engType).filter((t): t is string => t !== null))];
      return types.some((t) => codes.includes(t)) || (blank && types.length === 0);
    }
    const v = aircraftValue(a, facet);
    return (v !== null && codes.includes(v)) || (blank && v === null);
  });
}

const eventValue = (v: string | null, values: readonly string[] | undefined) =>
  !values || values.length === 0 || (v !== null && values.filter((x) => x !== BLANK).includes(v)) || (values.includes(BLANK) && v === null);

function reference(f: RetrievalFilters, qualification: boolean): string[] {
  const s = RetrievalFiltersSchema.parse(f);
  const aircraft = aircraftSelectionOf(s);
  const anyAircraftFacet = Object.keys(aircraft).length > 0;
  return records
    .filter((r) => {
      if (r.country !== 'USA' || !r.answerEligible || r.aircraft.length === 0) return false;
      if (!eventValue(r.highestInjury, s.injury) || !eventValue(r.wxCondBasic, s.conditions) || !eventValue(r.lightCond, s.light) || !eventValue(r.state, s.state)) return false;
      if (s.yearFrom !== undefined && (r.evYear === null || r.evYear < s.yearFrom)) return false;
      if (s.yearTo !== undefined && (r.evYear === null || r.evYear > s.yearTo)) return false;
      if (!anyAircraftFacet) return true;
      if (r.aircraft.length === 1) return satisfies(r.aircraft[0] as CaseRecordAircraft, aircraft, true);
      return qualification && r.aircraft.every((a) => satisfies(a, aircraft, false));
    })
    .map((r) => r.ntsbNo)
    .sort();
}

async function caseSet(index: string, filter: Query[]): Promise<string[]> {
  const res = await es.search({ index, size: 0, query: { bool: { filter } }, aggs: { n: { terms: { field: 'ntsb_no', size: 1_000 } } } });
  const buckets = (res.aggregations?.n as estypes.AggregationsStringTermsAggregate).buckets as estypes.AggregationsStringTermsBucket[];
  return buckets.map((b) => String(b.key)).sort();
}

const AIRCRAFT_SELECTIONS: AircraftSelection[] = [
  { category: ['HELI'] },
  { category: ['AIR'] },
  { category: ['AIR', 'HELI'] },
  { category: ['blank'] },
  { category: ['HELI', 'blank'] },
  { category: ['HELI'], far_part: ['121'] },
  { category: ['HELI'], far_part: ['ARMF'] },
  { category: ['AIR', 'HELI'], far_part: ['121', 'ARMF'] },
  { category: ['HELI'], purpose: ['PERS'] },
  { purpose: ['PERS'] },
  { purpose: ['PERS', 'blank'] },
  { phase: ['landing'] },
  { phase: ['landing', 'initial_climb'] },
  { phase: ['en_route', 'initial_climb'], category: ['HELI'] },
  { engine: ['TF'] },
  { engine: ['TF', 'TS'] },
  { engine: ['REC'], far_part: ['091'] },
  { far_part: ['091'], purpose: ['PERS'], phase: ['en_route', 'initial_climb', 'landing'] },
];

const SELECTIONS: RetrievalFilters[] = [
  {},
  { yearFrom: 2008, yearTo: 2015 },
  { yearFrom: 2020 },
  { yearTo: 2010 },
  { state: ['TX', 'NV'] },
  { state: ['blank'] },
  { injury: ['FATL'] },
  { injury: ['FATL', 'blank'] },
  { conditions: ['IMC'] },
  { light: ['NITE', 'blank'] },
  ...(AIRCRAFT_SELECTIONS as RetrievalFilters[]),
  // Adversarial combinations: event facets with aircraft facets, blank-only facets, facets met by different aircraft.
  { category: ['HELI'], yearFrom: 2015 },
  { category: ['HELI'], state: ['NV', 'DC'] },
  { category: ['AIR'], injury: ['FATL'] },
  { phase: ['landing'], injury: ['FATL', 'SERS', 'MINR', 'NONE', 'blank'] },
  { category: ['HELI'], purpose: ['blank'] },
  { category: ['blank'], far_part: ['091'] },
  { engine: ['blank'] },
  { purpose: ['blank'], engine: ['blank'] },
  { category: ['AIR', 'HELI'], far_part: ['121', 'ARMF'], purpose: ['PERS', 'blank'] },
  { category: ['AIR', 'HELI'], state: ['DC'], yearFrom: 2025, yearTo: 2025 },
];

describe('the cases channel reaches exactly the passages contract’s cohort', () => {
  it('passages-v2: every selection, against the passages filter and an independent reference', async () => {
    for (const f of SELECTIONS) {
      const expected = reference(f, true);
      expect(await caseSet(casesIndex, casesChannelFilter(f, { eventAircraftQualification: true })), JSON.stringify(f)).toEqual(expected);
      expect(await caseSet(passagesV2, compileFilters(f, { eventAircraftQualification: true }).bool.filter), JSON.stringify(f)).toEqual(expected);
    }
    // Not a vacuous comparison: the qualifying all-helicopter event and the mixed one.
    expect(reference({ category: ['HELI'] }, true)).toContain('WPR15FA010');
    expect(reference({ category: ['HELI'] }, true)).not.toContain('DCA25MA108');
    expect(reference({}, true).length).toBeGreaterThan(8);
  });

  it('passages-v1: the exclusion, multi-aircraft events never under an aircraft filter', async () => {
    for (const f of SELECTIONS) {
      const expected = reference(f, false);
      expect(await caseSet(casesIndex, casesChannelFilter(f, { eventAircraftQualification: false })), JSON.stringify(f)).toEqual(expected);
      expect(await caseSet(passagesV1, compileFilters(f).bool.filter), JSON.stringify(f)).toEqual(expected);
    }
    expect(reference({ category: ['HELI'] }, false)).not.toContain('WPR15FA010');
  });

  it('keyword search’s "some aircraft matches" rule would reach what AI evidence cannot', async () => {
    const keywordRule = await caseSet(casesIndex, [...filterClauses('cases', { category: ['HELI'] }), { term: { answer_eligible: true } }]);
    expect(keywordRule).toContain('DCA25MA108');
    expect(await caseSet(casesIndex, casesChannelFilter({ category: ['HELI'] }, { eventAircraftQualification: true }))).not.toContain('DCA25MA108');
    // The event without aircraft rows is in the cases index but never nominated.
    expect(await caseSet(casesIndex, [{ term: { answer_eligible: true } }])).toContain(GHOST);
    expect(await caseSet(casesIndex, casesChannelFilter({}, { eventAircraftQualification: true }))).not.toContain(GHOST);
  });
});

const QUESTION = 'join up maneuver midair collision';
const HELI = { category: ['HELI'] } as RetrievalFilters;

describe('case-level retrieval on real Elasticsearch', () => {
  it('one passages filter on every passages request, the cases filter as compiled, no mixed event anywhere, event scope kept', async () => {
    const r = await retrieveCaseCandidates(reader, embedder, RETRIEVAL_V2, { dataset: { generationId, passagesIndex: passagesV2 }, casesIndex, text: QUESTION, keywordText: 'midair collision helicopter formation', filters: HELI });
    const filter = compileFilters(HELI, { eventAircraftQualification: true }).bool.filter;
    expect(r.filter).toEqual(filter);
    expect((r.requests.keyword as { query: { bool: { filter: Query[] } } }).query.bool.filter).toEqual(filter);
    expect((r.requests.vector as { knn: { filter: { bool: { filter: Query[] } } } }).knn.filter.bool.filter).toEqual(filter);
    for (const m of r.requests.mapping) {
      const f = ((m.knn as { filter?: { bool: { filter: Query[] } } } | undefined)?.filter?.bool.filter ?? (m.query as { bool: { filter: Query[] } }).bool.filter) as Query[];
      expect(f.slice(0, -1)).toEqual(filter);
    }
    expect(r.casesFilter).toEqual(casesChannelFilter(HELI, { eventAircraftQualification: true }));
    expect((r.requests.cases as { query: { bool: { filter: Query[] } } }).query.bool.filter).toEqual(r.casesFilter);
    const allowed = new Set(reference(HELI, true));
    for (const n of [...r.channelCases.keyword, ...r.channelCases.vector, ...r.channelCases.cases, ...r.cases.map((c) => c.ntsbNo)]) expect(allowed.has(n), n).toBe(true);
    const packed = await fetchAndPack(reader, r.index, r.filter, r.cases, r.params);
    const fetch = (packed.request as { query: { bool: { filter: Query[] } } }).query.bool.filter.slice(0, -1);
    expect(fetch).toEqual(filter);
    expect(packed.cases.map((c) => c.ntsbNo).sort()).toEqual([...allowed].sort());
    const wpr = packed.cases.find((c) => c.ntsbNo === 'WPR15FA010')!;
    for (const p of wpr.passages) expect(p).toMatchObject({ scope: 'event', aircraftSpecific: false, aircraftKey: null });
    const causes = await reader.search({ index: passagesV2, size: 20, _source: false, query: { bool: { filter: [{ term: { ntsb_no: 'WPR15FA010' } }, { term: { section_kind: 'probable_cause' } }] } } });
    expect(wpr.passages.filter((p) => p.sectionKind === 'probable_cause').map((p) => p.id).sort()).toEqual(causes.hits.hits.map((h) => String(h._id)).sort());
  });

  it('on a passages-v1 index the cases channel keeps the exclusion, and no event-scoped passage reaches the bundle', async () => {
    const r = await retrieveCaseCandidates(reader, embedder, RETRIEVAL_V2, { dataset: { generationId, passagesIndex: passagesV1 }, casesIndex, text: QUESTION, keywordText: 'midair collision helicopter formation', filters: HELI });
    expect(r).toMatchObject({ indexVersion: 'passages-v1', eventAircraftQualification: false });
    expect(r.casesFilter).toEqual(casesChannelFilter(HELI, { eventAircraftQualification: false }));
    expect(r.channelCases.cases).not.toContain('WPR15FA010');
    expect(r.cases.map((c) => c.ntsbNo)).not.toContain('WPR15FA010');
    const packed = await fetchAndPack(reader, r.index, r.filter, r.cases, r.params);
    expect(packed.cases.flatMap((c) => c.passages).every((p) => p.aircraftSpecific)).toBe(true);
  });

  it('maps cases only the cases channel found, a long case among them, each to its own best passages by exact cosine', async () => {
    // One passage per passage channel: nearly every candidate comes from the cases channel alone.
    const narrow: RetrievalConfig = { ...RETRIEVAL_V2, params: retrievalParams({ ...RETRIEVAL_V2.params, perChannel: 1 }) };
    const text = 'Which airplane accidents involved an autopilot or aileron bellcrank problem?';
    const r = await retrieveCaseCandidates(reader, embedder, narrow, { dataset: { generationId, passagesIndex: passagesV2 }, casesIndex, text, keywordText: 'autopilot aileron bellcrank annunciator airplane pilot engine landing', filters: {} });
    expect(r.channelCases.keyword.length + r.channelCases.vector.length).toBeLessThanOrEqual(2);
    const mapped = r.mapping.filter((m) => m.status === 'mapped');
    expect(mapped.length).toBeGreaterThanOrEqual(6);
    expect(r.mapping.filter((m) => m.status === 'unmapped')).toEqual([]);
    expect(r.mapping.map((m) => m.ntsbNo)).toEqual(r.fusedCases.slice(0, 12).map((c) => c.id).filter((n) => !r.channelCases.keyword.includes(n) && !r.channelCases.vector.includes(n)));
    // Some of them hold more passages than they get: each is cut to its own best, never by another case.
    expect(mapped.some((m) => m.passagesUnderFilter > 3)).toBe(true);

    // Every mapped case: all of its passages considered (count verified), its best by exact cosine returned.
    const q = fakeVector(queryEmbeddingInput(text), DIMS);
    const cos = (v: Float32Array) => v.reduce((s, x, i) => s + x * (q[i] as number), 0);
    for (const m of mapped) {
      const record = records.find((x) => x.ntsbNo === m.ntsbNo)!;
      const own = buildCasePassages(record).passages;
      expect(m.passagesUnderFilter).toBe(own.length);
      expect(m.returned).toBe(Math.min(3, own.length));
      const scores = new Map(own.map((p) => [p.passageId, cos(fakeVector(p.input, DIMS))]));
      const returned = r.cases.find((c) => c.ntsbNo === m.ntsbNo)!.passages.map((p) => p.id);
      const worstReturned = Math.min(...returned.map((id) => scores.get(id) as number));
      const bestLeft = Math.max(-1, ...own.filter((p) => !returned.includes(p.passageId)).map((p) => scores.get(p.passageId) as number));
      // int8 quantization may swap near ties only.
      expect(worstReturned, m.ntsbNo).toBeGreaterThanOrEqual(bestLeft - 0.01);
    }

    // They compete for six slots in fused order, each with its best mapped passage reserved and every cause.
    const packed = await fetchAndPack(reader, r.index, r.filter, r.cases, r.params);
    expect(packed.cases.map((c) => c.ntsbNo)).toEqual(r.cases.slice(0, 6).map((c) => c.ntsbNo));
    expect(packed.passages).toBeLessThanOrEqual(12);
    for (const c of packed.cases) {
      const best = r.cases.find((x) => x.ntsbNo === c.ntsbNo)!.passages[0]!;
      expect(c.passages.find((p) => p.id === best.id)).toMatchObject({ reserved: true });
      const causes = (await reader.search({ index: passagesV2, size: 20, _source: false, query: { bool: { filter: [{ term: { ntsb_no: c.ntsbNo } }, { term: { section_kind: 'probable_cause' } }] } } })).hits.hits;
      expect(c.passages.filter((p) => p.sectionKind === 'probable_cause').map((p) => p.id).sort()).toEqual(causes.map((h) => String(h._id)).sort());
    }
  });

  it('mapping reports a case with no passage under the filter, and considers every passage of a long case', async () => {
    const filter = compileFilters(HELI, { eventAircraftQualification: true }).bool.filter;
    const vector = Array.from(fakeVector('anything', DIMS));
    const m = await mapCasesToPassages(reader, passagesV2, filter, vector, ['CEN24FA064', 'DCA25MA108', 'WPR15FA010', GHOST], retrievalParams(), { passagesPerCase: 3, maxCases: 12 });
    expect(m.cases.map((c) => [c.ntsbNo, c.status, c.reason])).toEqual([
      ['CEN24FA064', 'unmapped', 'no_passages'],
      ['DCA25MA108', 'unmapped', 'no_passages'],
      ['WPR15FA010', 'mapped', null],
      [GHOST, 'unmapped', 'no_passages'],
    ]);
    // The long case: every one of its passages considered, its best three by exact cosine returned.
    const all = compileFilters({}, { eventAircraftQualification: true }).bool.filter;
    const long = await mapCasesToPassages(reader, passagesV2, all, vector, ['CEN24FA064'], retrievalParams(), { passagesPerCase: 3, maxCases: 12 });
    const knn = long.requests.find((b) => b.knn)?.knn as estypes.KnnSearch;
    const own = buildCasePassages(records.find((x) => x.ntsbNo === 'CEN24FA064')!).passages;
    expect(long.cases[0]).toMatchObject({ status: 'mapped', passagesUnderFilter: own.length, returned: 3 });
    expect(knn.num_candidates).toBe(own.length);
    expect(own.length).toBeGreaterThan(6);
    expect(knn.num_candidates).toBeLessThanOrEqual(MAX_EXACT_CANDIDATES);
    const q = Float32Array.from(vector);
    const cos = (p: (typeof own)[number]) => fakeVector(p.input, DIMS).reduce((sum, x, i) => sum + x * (q[i] as number), 0);
    const exact = [...own].sort((a, b) => cos(b) - cos(a));
    const returned = long.passages.get('CEN24FA064')!.map((p) => p.id);
    const fourth = cos(exact[3]!);
    for (const id of returned) expect(cos(own.find((p) => p.passageId === id)!)).toBeGreaterThanOrEqual(fourth - 0.01);
  });
});

describe('the binding with the manifest’s cases index', () => {
  const hybrid = () => createHybridRetriever({ es: reader, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: (d) => manifestCasesIndex(app, d.generationId, d.passagesIndex) });

  it('serves only the pair the generation’s manifest publishes', async () => {
    expect(await manifestCasesIndex(app, generationId, passagesV2)).toBe(casesIndex);
    expect(await manifestCasesIndex(app, generationId, passagesV1)).toBeNull();
    expect(await manifestCasesIndex(app, generationId + 1, passagesV2)).toBeNull();
    expect(await hybrid().available({ generationId, passagesIndex: passagesV2 })).toBe(true);
    // A brief pinned to a passages index its generation's manifest no longer names: no cases index, no v2 evidence.
    expect(await hybrid().available({ generationId, passagesIndex: passagesV1 })).toBe(false);
    const refused = await hybrid()
      .retrieve({ dataset: { generationId, passagesIndex: passagesV1 }, text: QUESTION, keywordText: 'midair', filters: {} }, new AbortController().signal, () => undefined)
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ kind: 'unavailable', reason: 'no_cases_index', embedding: 'none' });
  });

  it('retrieves a checked bundle under the brief’s filters, with its mapping counts, and never the aircraft-less event', async () => {
    const usages: unknown[] = [];
    const out = await hybrid().retrieve(
      { dataset: { generationId, passagesIndex: passagesV2 }, text: 'autopilot aileron bellcrank failure', keywordText: 'zeppelin mooring mast autopilot aileron bellcrank', filters: {} },
      new AbortController().signal,
      (u) => usages.push(u),
    );
    expect(usages).toHaveLength(1);
    expect(out.mapping).toEqual({ mapped: expect.any(Number), unmapped: 0 });
    expect(out.bundle.cases.map((c) => c.ntsbNo)).toContain('CEN24FA064');
    expect(out.bundle.cases.map((c) => c.ntsbNo)).not.toContain(GHOST);
    for (const c of out.bundle.cases) {
      expect(c.passages.some((p) => p.reserved && p.rank !== null)).toBe(true);
      expect(c.passages.some((p) => p.role === 'probable_cause')).toBe(true);
    }
  });
});
