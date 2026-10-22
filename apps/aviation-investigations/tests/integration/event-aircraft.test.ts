/**
 * The event-level aircraft qualification (gate G5 extension) on real Elasticsearch:
 * a `passages-v2` index of a fixture variant, and a `passages-v1` index of the same
 * generation, both with fake vectors under the production model name (the approved
 * contracts apply; nothing is paid).
 *
 * The variant edits real fixture events (synthetic values, for the cases the fixtures
 * lack):
 * - WPR15FA010 (two aircraft) becomes an all-helicopter event, and its second aircraft
 *   loses its purpose (a null on an active field);
 * - DCA25MA108 stays mixed: an airliner (AIR, Part 121) and an Army helicopter (HELI,
 *   ARMF), so a helicopter filter plus a Part 121 filter is met by different aircraft;
 * - SEA08LA057 stays two airplanes with different defining phases.
 * A separate generation gives DCA25MA108 a third aircraft row to show that a build
 * refuses an event-scoped passage whose aircraft set is incomplete.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client, estypes } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { streamCaseRecords, type CaseRecord } from '../../server/db/queries/case-records.js';
import { compileFilters, filterClauses, type AircraftSelection, type Query } from '../../server/search/filters.js';
import { fetchAndPack, retrieveCandidates, retrieveEvidence, type PassageHit, type RetrievalDataset } from '../../server/search/hybrid.js';
import { BLANK } from '../../shared/contracts/search.js';
import { CHUNKER_VERSION } from '../../worker/index/chunk.js';
import { createFakeEmbedder, fakeVector } from '../../worker/index/embed.js';
import { EMBEDDING_INPUT_TEMPLATE_VERSION, buildCasePassages, type PassageAircraft } from '../../worker/index/passages.js';
import {
  IncompleteEventAircraftError,
  PASSAGES_EMBEDDING_DIMS,
  PASSAGES_SETTINGS,
  PASSAGES_V1_MAPPING,
  buildPassageDocument,
  loadEventAircraftSets,
  passagesIndexFingerprint,
  planPassages,
  rebuildPassagesIndex,
  type PassageDoc,
} from '../../worker/index/passages-index.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { editTable, makeExtractDir, removeDir } from '../support/extract-dir.js';
import { count, evIdOf, loadVerified } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetCorpus, testDbUrl, testEs } from './helpers.js';

const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const DIMS = PASSAGES_EMBEDDING_DIMS;
const MODEL = 'text-embedding-3-small';
const embedder = createFakeEmbedder(DIMS, MODEL);

let ingest: Db;
let es: Client;
const dirs: string[] = [];
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-event-aircraft-test-'));
let generationId: number;
let v2: string;
let v1: string;
/** Answer-eligible records of the variant generation, by case number. */
let records: Map<string, CaseRecord>;

const v2Dataset = (): RetrievalDataset => ({ generationId, passagesIndex: v2 });
const v1Dataset = (): RetrievalDataset => ({ generationId, passagesIndex: v1 });

async function variantDir(edit: (dir: string, evIdOf: (ntsbNo: string) => string) => void): Promise<string> {
  const dir = await makeExtractDir({ edit: (d) => edit(d, (n) => evIdOf(d, n)) });
  dirs.push(dir);
  return dir;
}

/** The case numbers (and passage count per case) the filter matches in `index`. */
async function matches(index: string, filter: Query[]): Promise<Map<string, number>> {
  const res = await es.search({
    index,
    size: 0,
    query: { bool: { filter } },
    aggs: { cases: { terms: { field: 'ntsb_no', size: 100 } } },
  });
  const buckets = (res.aggregations?.cases as estypes.AggregationsStringTermsAggregate).buckets as estypes.AggregationsStringTermsBucket[];
  return new Map(buckets.map((b) => [String(b.key), b.doc_count]));
}

/** The passages filter compiled with the qualification on, as retrieval compiles it for a passages-v2 index. */
const qualified = (selection: AircraftSelection) => filterClauses('passages', selection, { eventAircraftQualification: true });
const casesOf = async (index: string, filter: Query[]) => [...(await matches(index, filter)).keys()].sort();

/** Reference semantics, written independently of the compiler: does one aircraft satisfy every active facet? */
function satisfies(a: PassageAircraft, selection: AircraftSelection, blankMatches: boolean): boolean {
  const scalar: Record<string, string | null> = {
    phase: a.defining_phase_group,
    category: a.category,
    far_part: a.far_part,
    purpose: a.purpose,
  };
  return Object.entries(selection).every(([facet, values]) => {
    if (!values || values.length === 0) return true;
    const codes = values.filter((v) => v !== BLANK);
    const blank = blankMatches && values.includes(BLANK);
    if (facet === 'engine') return a.eng_types.some((t) => codes.includes(t)) || (blank && a.eng_types.length === 0);
    const v = scalar[facet] ?? null;
    return (v !== null && codes.includes(v)) || (blank && v === null);
  });
}

/** Expected cases: a single aircraft satisfies the facets itself; in a multi-aircraft event every aircraft does, and a missing value fails. */
function expectedCases(selection: AircraftSelection): string[] {
  return [...records.values()]
    .filter((r) => {
      const aircraft = buildCasePassages(r).passages[0]?.aircraft ?? [];
      if (r.aircraft.length === 1) return satisfies(aircraft[0] as PassageAircraft, selection, true);
      return aircraft.length >= 2 && aircraft.every((a) => satisfies(a, selection, false));
    })
    .map((r) => r.ntsbNo)
    .sort();
}

beforeAll(async () => {
  await resetCorpus();
  ingest = createDb(testDbUrl('ingest'), { max: 4, applicationName: 'aviation-test-event-aircraft' });
  es = testEs();
  const dir = await variantDir((d, ev) => {
    const wpr = ev('WPR15FA010');
    editTable(d, 'aircraft', (rows) =>
      rows.map((r) =>
        r.ev_id !== wpr ? r : { ...r, acft_category: 'HELI', ...(r.aircraft_key === '2' ? { type_fly: '' } : {}) },
      ),
    );
  });
  generationId = await loadVerified(ingest, dir, reportDir);
  records = new Map();
  for await (const r of streamCaseRecords(ingest, generationId)) if (r.answerEligible) records.set(r.ntsbNo, r);
  expect(records.get('WPR15FA010')?.aircraft.map((a) => [a.category, a.purpose])).toEqual([
    ['HELI', 'PERS'],
    ['HELI', null],
  ]);

  v2 = (await rebuildPassagesIndex(es, ingest, embedder, { generationId, prefix: PREFIX, gate: createMemorySpendGate(1), confirmCost: true })).index;

  // The same passages as a passages-v1 index: event aircraft as a flattened object, v1 `_meta`.
  v1 = `${PREFIX}-passages-v1-g${generationId}-manual`;
  await es.indices.create({
    index: v1,
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
  const docs = [...records.values()].flatMap((r) =>
    buildCasePassages(r).passages.map((p) => {
      const { event_aircraft_count: _count, event_aircraft_complete: _complete, ...doc } = buildPassageDocument(p, fakeVector(p.input, DIMS), sets);
      return doc;
    }),
  );
  const res = await es.bulk({ operations: docs.flatMap((d) => [{ create: { _index: v1, _id: d.passage_id } }, d]), refresh: true });
  expect(res.errors).toBe(false);
}, 180_000);

afterAll(async () => {
  const found = await es.indices.get({ index: `${PREFIX}-*`, expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: true });
  for (const name of Object.keys(found)) await es.indices.delete({ index: name });
  await closeDb(ingest);
  for (const d of [...dirs, reportDir]) removeDir(d);
});

describe('passages-v2: an event qualifies when every aircraft satisfies every aircraft facet', () => {
  it('stores each event-scoped passage with its event’s complete, nested aircraft set', async () => {
    const res = await es.search<PassageDoc>({ index: v2, size: 50, query: { term: { ntsb_no: 'WPR15FA010' } } });
    expect(res.hits.hits.length).toBeGreaterThan(0);
    for (const h of res.hits.hits) {
      expect(h._source).toMatchObject({ scope: 'event', aircraft_specific: false, aircraft_key: null, aircraft: [], event_aircraft_count: 2, event_aircraft_complete: true });
      expect(h._source?.event_aircraft.map((a) => [a.aircraft_key, a.category, a.purpose])).toEqual([
        [1, 'HELI', 'PERS'],
        [2, 'HELI', null],
      ]);
    }
  });

  it('an all-helicopter two-aircraft event matches a HELI filter, as a whole and event-scoped', async () => {
    const found = await matches(v2, qualified({ category: ['HELI'] }));
    expect([...found.keys()].sort()).toEqual(['CEN19FA024', 'DFW08TA066', 'WPR15FA010']);
    // Every passage of the event qualifies, none of them as an aircraft's own.
    expect(found.get('WPR15FA010')).toBe((await es.count({ index: v2, query: { term: { ntsb_no: 'WPR15FA010' } } })).count);
    const c = await retrieveCandidates(es, embedder, { dataset: v2Dataset(), text: 'join up maneuver midair collision', filters: { category: ['HELI'] } });
    const wpr = [...c.keyword, ...c.vector].filter((h) => h.ntsbNo === 'WPR15FA010');
    expect(wpr.length).toBeGreaterThan(0);
    for (const h of wpr) expect(h).toMatchObject({ scope: 'event', aircraftSpecific: false, aircraftKey: null });
    expect(c).toMatchObject({ indexVersion: 'passages-v2', chunkerVersion: 'chunk-v2', eventAircraftQualification: true });
  });

  it('a mixed helicopter/airplane event matches neither a HELI-only nor an AIR-only filter', async () => {
    expect(await casesOf(v2, qualified({ category: ['HELI'] }))).not.toContain('DCA25MA108');
    const air = await casesOf(v2, qualified({ category: ['AIR'] }));
    expect(air).not.toContain('DCA25MA108');
    // Two airplanes qualify under AIR.
    expect(air).toContain('SEA08LA057');
    // Only a selection that admits each of its aircraft does.
    expect(await casesOf(v2, qualified({ category: ['AIR', 'HELI'] }))).toContain('DCA25MA108');
  });

  it('two facets each met by a different aircraft, but not both by one aircraft, do not match', async () => {
    // DCA25MA108: the helicopter is ARMF, the Part 121 aircraft is the airliner.
    expect(await casesOf(v2, qualified({ category: ['HELI'], far_part: ['121'] }))).toEqual([]);
    expect(await casesOf(v2, qualified({ category: ['AIR', 'HELI'], far_part: ['121'] }))).not.toContain('DCA25MA108');
    // SEA08LA057: one airplane was landing, the other in its initial climb.
    expect(await casesOf(v2, qualified({ phase: ['landing'] }))).not.toContain('SEA08LA057');
    expect(await casesOf(v2, qualified({ phase: ['landing', 'initial_climb'] }))).toContain('SEA08LA057');
    // A flattened object (passages-v1) cannot tell: the same two facets "match" there.
    const flattened = await es.count({
      index: v1,
      query: { bool: { filter: [{ term: { aircraft_specific: false } }, { term: { 'event_aircraft.category': 'HELI' } }, { term: { 'event_aircraft.far_part': '121' } }] } },
    });
    expect(flattened.count).toBeGreaterThan(0);
  });

  it('an aircraft with a null value on an active field fails, even when blank is selected', async () => {
    // WPR15FA010's second helicopter has no purpose.
    expect(await casesOf(v2, qualified({ category: ['HELI'] }))).toContain('WPR15FA010');
    expect(await casesOf(v2, qualified({ category: ['HELI'], purpose: ['PERS'] }))).toEqual(['CEN19FA024']);
    expect(await casesOf(v2, qualified({ category: ['HELI'], purpose: ['PERS', 'blank'] }))).toEqual(['CEN19FA024']);
    expect(await casesOf(v2, qualified({ purpose: ['blank'] }))).not.toContain('WPR15FA010');
    // DCA25MA108: both purposes are null.
    expect(await casesOf(v2, qualified({ category: ['AIR', 'HELI'], purpose: ['blank'] }))).toEqual([]);
  });

  it('matches the reference semantics on every selection tried, case by case and passage by passage', async () => {
    const selections: AircraftSelection[] = [
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
    for (const selection of selections) {
      const found = await matches(v2, qualified(selection));
      expect([...found.keys()].sort(), JSON.stringify(selection)).toEqual(expectedCases(selection));
      // A qualifying event qualifies with every passage it has.
      for (const [ntsbNo, n] of found) {
        expect(n, `${ntsbNo} ${JSON.stringify(selection)}`).toBe((await es.count({ index: v2, query: { term: { ntsb_no: ntsbNo } } })).count);
      }
    }
  });

  it('uses the identical clause in the keyword body, the kNN prefilter and the cause fetch, and attaches every cause variant event-scoped', async () => {
    const filters = { category: ['HELI'] };
    const r = await retrieveEvidence(es, embedder, { dataset: v2Dataset(), text: 'join up maneuver midair collision', filters });
    const filter = qualified(filters);
    const keyword = (r.requests.keyword as { query: { bool: { filter: Query[] } } }).query.bool.filter;
    const vector = (r.requests.vector as { knn: { filter: { bool: { filter: Query[] } } } }).knn.filter.bool.filter;
    const fetch = (r.requests.fetch as { query: { bool: { filter: Query[] } } }).query.bool.filter.slice(0, -1);
    expect(keyword).toEqual(filter);
    expect(vector).toEqual(filter);
    expect(fetch).toEqual(filter);
    const wpr = r.cases.find((c) => c.ntsbNo === 'WPR15FA010');
    expect(wpr).toBeDefined();
    const causes = await es.search({ index: v2, size: 20, _source: false, query: { bool: { filter: [{ term: { ntsb_no: 'WPR15FA010' } }, { term: { section_kind: 'probable_cause' } }] } } });
    const variants = causes.hits.hits.map((h) => h._id).sort();
    expect(variants.length).toBeGreaterThan(0);
    expect(wpr?.passages.filter((p) => p.sectionKind === 'probable_cause').map((p) => p.id).sort()).toEqual(variants);
    // Event scope is kept: no passage of the event is labelled as one aircraft's.
    for (const p of wpr?.passages ?? []) expect(p).toMatchObject({ scope: 'event', aircraftSpecific: false, aircraftKey: null });
    // No mixed or partially matching event reaches the bundle.
    expect(r.cases.map((c) => c.ntsbNo).sort()).toEqual(['CEN19FA024', 'DFW08TA066', 'WPR15FA010']);
  });
});

describe('cause variants of a qualifying event', () => {
  it('attaches every event-scoped cause variant stored for the event, never a filtered subset', async () => {
    // A second, distinct cause variant of WPR15FA010 (a multi-aircraft event can hold several);
    // it is built like the stored one: same event, same complete nested aircraft set.
    const [stored] = (
      await es.search<PassageDoc>({ index: v2, size: 1, query: { bool: { filter: [{ term: { ntsb_no: 'WPR15FA010' } }, { term: { section_kind: 'probable_cause' } }] } } })
    ).hits.hits;
    const variant: PassageDoc = {
      ...(stored?._source as PassageDoc),
      passage_id: 'wpr-cause-variant-2',
      section_id: 'WPR15FA010:probable_cause/event-2',
      revision_id: 'r2',
      text: 'The failure of both pilots to maintain visual separation during the join up.',
      embedding: Array.from(fakeVector('variant', DIMS)),
    };
    await es.index({ index: v2, id: variant.passage_id, document: variant, refresh: true });
    try {
      const all = await es.search({ index: v2, size: 20, _source: false, query: { bool: { filter: [{ term: { ntsb_no: 'WPR15FA010' } }, { term: { section_kind: 'probable_cause' } }] } } });
      const variants = all.hits.hits.map((h) => String(h._id)).sort();
      expect(variants).toHaveLength(2);
      for (const selection of [{ category: ['HELI'] }, { category: ['HELI'], phase: ['en_route', 'initial_climb'] }, { category: ['HELI'], far_part: ['091'] }]) {
        // The fetch filter keeps every variant: the qualification is a property of the event, which they share.
        const kept = await es.search({ index: v2, size: 20, _source: false, query: { bool: { filter: [...qualified(selection), { term: { ntsb_no: 'WPR15FA010' } }, { term: { section_kind: 'probable_cause' } }] } } });
        expect(kept.hits.hits.map((h) => String(h._id)).sort(), JSON.stringify(selection)).toEqual(variants);
        const r = await retrieveEvidence(es, embedder, { dataset: v2Dataset(), text: 'join up maneuver midair collision', filters: selection });
        const wpr = r.cases.find((c) => c.ntsbNo === 'WPR15FA010');
        expect(wpr?.passages.filter((p) => p.sectionKind === 'probable_cause').map((p) => p.id).sort(), JSON.stringify(selection)).toEqual(variants);
        for (const p of wpr?.passages ?? []) expect(p).toMatchObject({ scope: 'event', aircraftKey: null, reserved: p.sectionKind === 'probable_cause' ? true : p.reserved });
      }
      // A selection the event does not meet drops the event with all its variants, never some of them.
      const none = await es.count({ index: v2, query: { bool: { filter: [...qualified({ category: ['HELI'], purpose: ['PERS'] }), { term: { ntsb_no: 'WPR15FA010' } }] } } });
      expect(none.count).toBe(0);
    } finally {
      await es.delete({ index: v2, id: variant.passage_id, refresh: true });
    }
  });
});

describe('passages-v1 keeps the exclusion', () => {
  it('never returns an event-scoped passage under an aircraft filter, however the event’s aircraft look', async () => {
    for (const category of [['HELI'], ['AIR'], ['AIR', 'HELI']]) {
      const c = await retrieveCandidates(es, embedder, { dataset: v1Dataset(), text: 'join up maneuver midair collision', filters: { category }, params: { perChannel: 100 } });
      expect(c).toMatchObject({ indexVersion: 'passages-v1', chunkerVersion: 'chunk-v2', eventAircraftQualification: false });
      const hits: PassageHit[] = [...c.keyword, ...c.vector];
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.filter((h) => !h.aircraftSpecific)).toEqual([]);
      expect(c.filter).toEqual(compileFilters({ category }).bool.filter);
      const packed = await fetchAndPack(es, c.index, c.filter, c.cases, c.params);
      expect(packed.cases.flatMap((x) => x.passages).every((p) => p.aircraftSpecific)).toBe(true);
    }
    // The same request on the v2 index reaches the all-helicopter event.
    const two = await retrieveCandidates(es, embedder, { dataset: v2Dataset(), text: 'join up maneuver midair collision', filters: { category: ['HELI'] }, params: { perChannel: 100 } });
    expect([...two.keyword, ...two.vector].some((h) => h.ntsbNo === 'WPR15FA010' && !h.aircraftSpecific)).toBe(true);
  });

  it('qualifies nothing even if the v2 clause reached it: a v1 index has no completeness flag', async () => {
    for (const selection of [{ category: ['HELI'] }, { category: ['AIR'] }, { category: ['AIR', 'HELI'] }]) {
      const res = await es.search({ index: v1, size: 100, _source: ['ntsb_no', 'aircraft_specific'], query: { bool: { filter: qualified(selection) } } });
      expect(res.hits.hits.length).toBeGreaterThan(0);
      expect(res.hits.hits.filter((h) => (h._source as { aircraft_specific: boolean }).aircraft_specific !== true)).toEqual([]);
      expect(await casesOf(v1, qualified(selection))).toEqual(await casesOf(v1, filterClauses('passages', selection)));
    }
  });
});

describe('the build refuses an incomplete event aircraft set', () => {
  it('stops before any index, row or embedding when an event-scoped passage lacks one of the event’s aircraft', async () => {
    // DCA25MA108 gets a third aircraft row in PostgreSQL; the seam drops it from the record
    // the passages are built from (a projection fault the build must catch).
    const dir = await variantDir((d, ev) => {
      const dca = ev('DCA25MA108');
      editTable(d, 'aircraft', (rows) => {
        const second = rows.find((r) => r.ev_id === dca && r.aircraft_key === '2');
        if (!second) throw new Error('DCA25MA108 aircraft 2 missing');
        return [...rows, { ...second, aircraft_key: '3', ntsb_no: 'DCA25MA108C', regis_no: 'UNREG3' }];
      });
    });
    const third = await loadVerified(ingest, dir, reportDir);
    const dropThird = (r: CaseRecord): CaseRecord => (r.ntsbNo === 'DCA25MA108' ? { ...r, aircraft: r.aircraft.filter((a) => a.aircraftKey !== 3) } : r);
    expect((await loadEventAircraftSets(ingest, third)).get('DCA25MA108')).toEqual([1, 2, 3]);

    const plan = await planPassages(ingest, {
      generationId: third,
      embedding: { model: MODEL, dims: DIMS, usdPerMillionTokens: 0 },
      mapRecord: dropThird,
    }).catch((e: unknown) => e);
    expect(plan).toBeInstanceOf(IncompleteEventAircraftError);
    expect((plan as IncompleteEventAircraftError).cases).toEqual(['DCA25MA108']);

    const fake = createFakeEmbedder(DIMS, MODEL);
    const before = Object.keys(await es.indices.get({ index: `${PREFIX}-*`, allow_no_indices: true }));
    const err = await rebuildPassagesIndex(es, ingest, fake, {
      generationId: third,
      prefix: PREFIX,
      gate: createMemorySpendGate(1),
      confirmCost: true,
      mapRecord: dropThird,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteEventAircraftError);
    expect(String(err)).toMatch(/DCA25MA108.*complete aircraft set/);
    expect(fake.calls).toEqual([]);
    expect(Object.keys(await es.indices.get({ index: `${PREFIX}-*`, allow_no_indices: true }))).toEqual(before);
    expect(await count(ingest, sql`select count(*) from passages where generation_id = ${third}`)).toBe(0);

    // Without the fault the stored set is complete: three events checked, one of them with three aircraft.
    const ok = await planPassages(ingest, { generationId: third, embedding: { model: MODEL, dims: DIMS, usdPerMillionTokens: 0 } });
    expect(ok.eventAircraft.events).toBe(3);
    expect(ok.eventAircraft.aircraft).toBeGreaterThan(ok.eventAircraft.passages * 2);
  });
});
