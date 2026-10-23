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
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { createHybridRetriever } from '../../server/briefs/retriever.js';
import { BoundedReadTimeoutError, boundedRead } from '../../server/db/bounded-read.js';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { manifestCasesIndex, publishManifest } from '../../server/db/generations.js';
import { streamCaseRecords, type CaseRecord, type CaseRecordAircraft } from '../../server/db/queries/case-records.js';
import { MAX_EXACT_CANDIDATES, mapCasesToPassages } from '../../server/search/case-mapping.js';
import { retrieveCaseCandidates } from '../../server/search/case-retrieval.js';
import { casesChannelBody, casesChannelFilter } from '../../server/search/cases-channel.js';
import { RetrievalFiltersSchema, aircraftSelectionOf, compileFilters, filterClauses, type AircraftSelection, type Query, type RetrievalFilters } from '../../server/search/filters.js';
import { fetchAndPack, keywordChannelBody, retrievalParams } from '../../server/search/hybrid.js';
import { MAX_MAPPED_PASSAGES, RETRIEVAL_V2, type RetrievalConfig } from '../../server/search/retrieval-config.js';
import { BLANK } from '../../shared/contracts/search.js';
import { CHUNKER_VERSION } from '../../worker/index/chunk.js';
import { CASES_MAPPING, CASES_SETTINGS, rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { createFakeEmbedder, fakeVector } from '../../worker/index/embed.js';
import { EMBEDDING_INPUT_TEMPLATE_VERSION, buildCasePassages } from '../../worker/index/passages.js';
import {
  PASSAGES_EMBEDDING_DIMS,
  PASSAGES_MAPPING,
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
      // Every passage of the case came back and was verified; the best 3 were kept.
      expect(m.returned).toBe(own.length);
      expect(r.cases.find((c) => c.ntsbNo === m.ntsbNo)!.passages).toHaveLength(Math.min(3, own.length));
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
    const opts = { passagesPerCase: 3, maxPassagesPerCase: MAX_MAPPED_PASSAGES, maxCases: 12 };
    const m = await mapCasesToPassages(reader, passagesV2, filter, vector, ['CEN24FA064', 'DCA25MA108', 'WPR15FA010', GHOST], retrievalParams(), opts);
    expect(m.cases.map((c) => [c.ntsbNo, c.status, c.reason])).toEqual([
      ['CEN24FA064', 'unmapped', 'no_passages'],
      ['DCA25MA108', 'unmapped', 'no_passages'],
      ['WPR15FA010', 'mapped', null],
      [GHOST, 'unmapped', 'no_passages'],
    ]);
    // The long case: every one of its passages considered, its best three by exact cosine returned.
    const all = compileFilters({}, { eventAircraftQualification: true }).bool.filter;
    const long = await mapCasesToPassages(reader, passagesV2, all, vector, ['CEN24FA064'], retrievalParams(), opts);
    const knn = long.requests.find((b) => b.knn)?.knn as estypes.KnnSearch;
    const own = buildCasePassages(records.find((x) => x.ntsbNo === 'CEN24FA064')!).passages;
    expect(long.cases[0]).toMatchObject({ status: 'mapped', passagesUnderFilter: own.length, returned: own.length });
    expect(long.passages.get('CEN24FA064')).toHaveLength(3);
    expect(knn.num_candidates).toBe(own.length);
    expect(knn.k).toBe(own.length);
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
  const hybrid = () =>
    createHybridRetriever({ es: reader, embedder, retrieval: RETRIEVAL_V2, casesIndexOf: (d, signal) => manifestCasesIndex(app, d.generationId, d.passagesIndex, { timeoutMs: 2_000, signal }) });
  const bound = { timeoutMs: 2_000 };

  it('serves only the pair the generation’s manifest publishes', async () => {
    expect(await manifestCasesIndex(app, generationId, passagesV2, bound)).toBe(casesIndex);
    expect(await manifestCasesIndex(app, generationId, passagesV1, bound)).toBeNull();
    expect(await manifestCasesIndex(app, generationId + 1, passagesV2, bound)).toBeNull();
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

describe('the manifest lookup is bounded on real PostgreSQL', () => {
  const NAME = 'aviation-test-bounded-read';
  /** A pool of one connection, so the test controls exhaustion exactly. */
  const smallDb = () => createDb(testDbUrl('app'), { max: 1, applicationName: NAME });
  const settledPool = (db: Db) => ({ total: db.$client.totalCount, idle: db.$client.idleCount, waiting: db.$client.waitingCount });
  const activeSleeps = async () =>
    Number(((await app.execute(sql`select count(*)::int as n from pg_stat_activity where application_name = ${NAME} and state = 'active' and query like '%pg_sleep%'`)).rows[0] as { n: number }).n);

  it('ends a lookup that cannot get a connection within its bound, and leaks no connection', async () => {
    const small = smallDb();
    try {
      const held = await small.$client.connect();
      const t0 = performance.now();
      const err = await manifestCasesIndex(small, generationId, passagesV2, { timeoutMs: 200 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BoundedReadTimeoutError);
      expect(performance.now() - t0).toBeLessThan(1_000);
      // A cancel while waiting for a connection ends it too, with the caller's reason.
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('cancelled by the reader')), 50);
      await expect(manifestCasesIndex(small, generationId, passagesV2, { timeoutMs: 5_000, signal: controller.signal })).rejects.toThrow('cancelled by the reader');
      // The late acquisitions go straight back: once the held connection is free, nothing waits and nothing is stranded.
      held.release();
      await new Promise((r) => setTimeout(r, 50));
      expect(settledPool(small)).toEqual({ total: 1, idle: 1, waiting: 0 });
      expect(await manifestCasesIndex(small, generationId, passagesV2, { timeoutMs: 2_000 })).toBe(casesIndex);
    } finally {
      await closeDb(small);
    }
  });

  it('ends a statement that runs too long: the connection is destroyed, the server stops it, and the slot is free', async () => {
    const small = smallDb();
    try {
      const t0 = performance.now();
      const err = await boundedRead(small.$client, 'select pg_sleep(5)', [], { timeoutMs: 300 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BoundedReadTimeoutError);
      expect(performance.now() - t0).toBeLessThan(1_500);
      // Destroyed, not returned busy: the pool holds no connection now.
      expect(small.$client.totalCount).toBe(0);
      // On the server the statement ends within its own timeout.
      await new Promise((r) => setTimeout(r, 700));
      expect(await activeSleeps()).toBe(0);
      // Cancelled by the caller mid-statement: the same.
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('cancelled by the reader')), 100);
      await expect(boundedRead(small.$client, 'select pg_sleep(5)', [], { timeoutMs: 2_000, signal: controller.signal })).rejects.toThrow('cancelled by the reader');
      expect(small.$client.totalCount).toBe(0);
      await new Promise((r) => setTimeout(r, 2_500));
      expect(await activeSleeps()).toBe(0);
      // The statement timeout never outlives its transaction: the pooled connection keeps the default.
      expect(await boundedRead<{ t: string }>(small.$client, "select current_setting('statement_timeout') as t", [], { timeoutMs: 2_000 })).toEqual([{ t: expect.stringMatching(/^\d+ms$/) }]);
      const plain = await small.$client.query<{ t: string }>("select current_setting('statement_timeout') as t");
      expect(plain.rows[0]?.t).toBe('0');
    } finally {
      await closeDb(small);
    }
  }, 30_000);
});

describe('the lexical cut is by score, then id, inside Elasticsearch', () => {
  /** 201 documents that score exactly alike, indexed in ascending or descending id order. */
  const ids = Array.from({ length: 201 }, (_, i) => `TIE${String(i).padStart(4, '0')}`);
  const TEXT = 'carburetor icing partial loss of engine power during cruise flight';

  async function casesTwin(order: 'asc' | 'desc'): Promise<string> {
    const index = `${PREFIX}-tie-cases-${order}`;
    await es.indices.create({ index, settings: CASES_SETTINGS, mappings: CASES_MAPPING });
    const docs = (order === 'asc' ? ids : [...ids].reverse()).map((n) => ({
      ntsb_no: n,
      country: 'USA',
      answer_eligible: true,
      completed_with_cause: true,
      completion_class: 'completed',
      aircraft_count: 1,
      aircraft: [{ aircraft_key: 1, category: 'AIR', eng_types: ['REC'] }],
      defining_phase_groups: [],
      sequence_phase_groups: [],
      defining_events: [],
      probable_cause: [TEXT],
      analysis: [],
      factual: [],
      findings_text: [],
    }));
    const res = await es.bulk({ operations: docs.flatMap((d) => [{ create: { _index: index, _id: d.ntsb_no } }, d]), refresh: true });
    expect(res.errors).toBe(false);
    return index;
  }

  async function passagesTwin(order: 'asc' | 'desc'): Promise<string> {
    const index = `${PREFIX}-tie-passages-${order}`;
    await es.indices.create({ index, settings: PASSAGES_SETTINGS, mappings: PASSAGES_MAPPING });
    const docs = (order === 'asc' ? ids : [...ids].reverse()).map((n) => ({
      passage_id: n.toLowerCase(),
      ntsb_no: n,
      section_id: `${n}:probable_cause/aircraft-1`,
      revision_id: 'r',
      section_kind: 'probable_cause',
      scope: 'aircraft',
      aircraft_specific: true,
      aircraft_key: 1,
      start: 0,
      end: TEXT.length,
      part: 1,
      parts: 1,
      continuation: false,
      text: TEXT,
      country: 'USA',
      answer_eligible: true,
      defining_phase_groups: [],
      aircraft: [{ aircraft_key: 1, category: 'AIR', eng_types: ['REC'] }],
      event_aircraft: [],
      event_aircraft_complete: false,
    }));
    const res = await es.bulk({ operations: docs.flatMap((d) => [{ create: { _index: index, _id: d.passage_id } }, d]), refresh: true });
    expect(res.errors).toBe(false);
    return index;
  }

  const idsOf = async (body: estypes.SearchRequest) => {
    const res = await es.search<Record<string, unknown>>(body);
    const scores = new Set(res.hits.hits.map((h) => h._score));
    return { ids: res.hits.hits.map((h) => String(h._id)), distinctScores: scores.size };
  };

  it('cases channel: 201 equal scores and size 200 give the same 200 cases whatever the document order', async () => {
    const [asc, desc] = [await casesTwin('asc'), await casesTwin('desc')];
    const filter = casesChannelFilter({}, { eventAircraftQualification: true });
    const body = (index: string) => casesChannelBody(index, TEXT, ['probable_cause', 'analysis', 'factual'], filter, 200);
    const a = await idsOf(body(asc));
    const b = await idsOf(body(desc));
    expect(a.distinctScores).toBe(1);
    expect(a.ids).toHaveLength(200);
    // The cut goes by case number: the same 200, the largest number left out, on both copies.
    expect(a.ids).toEqual(ids.slice(0, 200));
    expect(b.ids).toEqual(a.ids);
    // Without the sort, Lucene's document order decides which case is left out.
    const { sort: _sort, ...unsorted } = body(asc);
    const ua = await idsOf(unsorted as estypes.SearchRequest);
    const ub = await idsOf({ ...(unsorted as estypes.SearchRequest), index: desc });
    expect(new Set(ua.ids)).not.toEqual(new Set(ub.ids));
  });

  it('passage BM25 (retrieval.v2): the same, by passage id; retrieval.v1 keeps Elasticsearch’s own cut', async () => {
    const [asc, desc] = [await passagesTwin('asc'), await passagesTwin('desc')];
    const filter = compileFilters({}, { eventAircraftQualification: true }).bool.filter;
    const a = await idsOf(keywordChannelBody(asc, TEXT, filter, 200, { tiebreak: true }));
    const b = await idsOf(keywordChannelBody(desc, TEXT, filter, 200, { tiebreak: true }));
    expect(a.distinctScores).toBe(1);
    expect(a.ids).toEqual(ids.slice(0, 200).map((n) => n.toLowerCase()));
    expect(b.ids).toEqual(a.ids);
    const v1a = await idsOf(keywordChannelBody(asc, TEXT, filter, 200));
    const v1b = await idsOf(keywordChannelBody(desc, TEXT, filter, 200));
    expect(keywordChannelBody(asc, TEXT, filter, 200).sort).toBeUndefined();
    expect(new Set(v1a.ids)).not.toEqual(new Set(v1b.ids));
  });
});
