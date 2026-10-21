import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client, estypes } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import { streamCaseRecords, type CaseRecord } from '../../server/db/queries/case-records.js';
import { aliasTargets, switchAlias } from '../../worker/index/aliases.js';
import { INDEX_ANALYZER, SEARCH_ANALYZER } from '../../worker/index/analysis.js';
import {
  CASES_INDEX_VERSION,
  CASES_MAPPING,
  CASES_SETTINGS,
  GenerationNotIndexableError,
  buildCaseDocument,
  casesAlias,
  rebuildCasesIndex,
  type CaseDoc,
  type IndexReport,
} from '../../worker/index/cases-index.js';
import { AVIATION_STOP_WORDS } from '../../worker/index/synonyms.js';
import { loadFromExtract } from '../../worker/ingest/load.js';
import { verifyCorpus } from '../../worker/ingest/verify.js';
import { fixtureCaseRecords } from '../support/case-records.js';
import { makeExtractDir, removeDir } from '../support/extract-dir.js';
import { TEST_INDEX_PREFIX, testDb, testEs, testEsReader } from './helpers.js';

/** A prefix of our own, so parallel runs and other suites never share an alias. */
const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const ALIAS = casesAlias(PREFIX);
/** US events in the fixtures (ENG08WA029 is the one foreign event). */
const US_EVENTS = 15;

let ingest: Db;
let migrator: Db;
let es: Client;
let reader: Client;
let fixtureDir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-cases-index-test-'));
let generationId: number;
let built: IndexReport;
let offline: Map<string, CaseRecord>;

const status = (e: unknown) => (e as { meta?: { statusCode?: number } }).meta?.statusCode;
const total = (r: estypes.SearchResponse) => (typeof r.hits.total === 'number' ? r.hits.total : (r.hits.total?.value ?? -1));
const ids = (r: estypes.SearchResponse): string[] => r.hits.hits.map((h) => h._id ?? '').sort();

/**
 * Load the fixtures as a new generation and verify it. aviation_test may already
 * carry the database-enforced generation lifecycle (gate G2b), which this branch's
 * verifier cannot update; the checks still run, and the outcome is then recorded
 * through the lifecycle functions as the migrator.
 */
async function loadVerifiedGeneration(): Promise<number> {
  const { generationId: id } = await loadFromExtract(ingest, fixtureDir);
  try {
    const v = await verifyCorpus(ingest, id, { outDir: reportDir, profile: null });
    expect(v.checks.filter((c) => !c.ok)).toEqual([]);
    return id;
  } catch (err) {
    const lifecycle = await migrator.execute(sql`select to_regproc('record_verification') is not null as present`);
    if (!(lifecycle.rows[0] as { present: boolean }).present) throw err;
    await migrator.execute(sql`select seal_generation(${id})`);
    await migrator.execute(sql`select record_verification(${id}, 'loaded', true, 'cases-index-test', ${'0'.repeat(64)})`);
    return id;
  }
}

async function deleteOwnIndices(): Promise<void> {
  const found = await es.cat.indices({ index: `${PREFIX}-*`, format: 'json', h: 'index' });
  for (const { index } of found) if (index) await es.indices.delete({ index });
}

beforeAll(async () => {
  ingest = testDb('ingest');
  migrator = testDb('migrator');
  es = testEs();
  reader = testEsReader();
  fixtureDir = await makeExtractDir();
  generationId = await loadVerifiedGeneration();
  offline = await fixtureCaseRecords(generationId);
  built = await rebuildCasesIndex(es, ingest, { generationId, prefix: PREFIX });
}, 120_000);

afterAll(async () => {
  await deleteOwnIndices();
  await Promise.all([closeDb(ingest), closeDb(migrator)]);
  removeDir(fixtureDir);
  removeDir(reportDir);
});

describe('streamCaseRecords', () => {
  it('reads the generation in case-number order, US only, in batches', async () => {
    const all: CaseRecord[] = [];
    for await (const r of streamCaseRecords(ingest, generationId, { batchSize: 4 })) all.push(r);
    expect(all.map((r) => r.ntsbNo)).toEqual([...all.map((r) => r.ntsbNo)].sort());
    expect(all).toHaveLength(US_EVENTS);
    expect(all.every((r) => r.isUs && r.country === 'USA')).toBe(true);
    // The database path assembles exactly what the loader wrote.
    for (const r of all) expect(r).toEqual(offline.get(r.ntsbNo));

    const withForeign: string[] = [];
    for await (const r of streamCaseRecords(ingest, generationId, { includeForeign: true })) withForeign.push(r.ntsbNo);
    expect(withForeign).toContain('ENG08WA029');
    expect(withForeign).toHaveLength(US_EVENTS + 1);
  });

  it('releases its connection when the consumer stops early', async () => {
    for (let i = 0; i < 4; i += 1) {
      for await (const r of streamCaseRecords(ingest, generationId, { batchSize: 2 })) {
        expect(r.ntsbNo).toBeTruthy();
        break;
      }
    }
    expect(ingest.$client.totalCount - ingest.$client.idleCount).toBe(0);
  });
});

describe('rebuildCasesIndex', () => {
  it('indexes every US case of the generation as built offline, and points the alias at it', async () => {
    expect(built).toMatchObject({
      alias: ALIAS,
      generationId,
      version: CASES_INDEX_VERSION,
      documents: US_EVENTS,
      aircraft: 18,
      multiAircraftEvents: 3,
      eventsWithSeveralDefiningPhases: 3,
      eventsWithoutDefiningPhase: 1,
      unparsedEventLabels: 0,
      previousIndices: [],
    });
    expect(built.index).toMatch(new RegExp(`^${PREFIX}-cases-v1-g${generationId}-\\d{17}$`));
    expect(await aliasTargets(es, ALIAS)).toEqual([built.index]);

    const mapping = await es.indices.getMapping({ index: built.index });
    expect(mapping[built.index]?.mappings._meta).toMatchObject({ index_version: CASES_INDEX_VERSION, generation_id: generationId });
    const settings = await es.indices.getSettings({ index: built.index });
    expect(settings[built.index]?.settings?.index).toMatchObject({ number_of_shards: '1', number_of_replicas: '0', refresh_interval: '1s' });

    for (const r of offline.values()) {
      if (!r.isUs) continue;
      const got = await reader.get<CaseDoc>({ index: ALIAS, id: r.ntsbNo });
      expect(got._source).toEqual(JSON.parse(JSON.stringify(buildCaseDocument(r))));
    }
    const dfw = await reader.get<CaseDoc>({ index: ALIAS, id: 'DFW08TA066' });
    expect(dfw._source?.aircraft[0]).toMatchObject({ category: 'HELI', defining_phase_group: 'maneuvering' });
  });

  it('never indexes a foreign event', async () => {
    const inDb = await ingest.execute(
      sql`select country from cases where generation_id = ${generationId} and ntsb_no = 'ENG08WA029'`,
    );
    expect(inDb.rows).toEqual([{ country: 'PE' }]);
    expect(status(await reader.get({ index: ALIAS, id: 'ENG08WA029' }).catch((e: unknown) => e))).toBe(404);
    const byNo = await reader.search({ index: ALIAS, query: { term: { ntsb_no: 'ENG08WA029' } } });
    expect(total(byNo)).toBe(0);
    const foreign = await reader.count({ index: ALIAS, query: { bool: { must_not: { term: { country: 'USA' } } } } });
    expect(foreign.count).toBe(0);
  });

  it('refuses a generation that is not verified', async () => {
    const { generationId: unverified } = await loadFromExtract(ingest, fixtureDir);
    const err = await rebuildCasesIndex(es, ingest, { generationId: unverified, prefix: PREFIX }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GenerationNotIndexableError);
    expect(String(err)).toMatch(/only a verified generation/);
    const missing = await rebuildCasesIndex(es, ingest, { generationId: 999_999, prefix: PREFIX }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(GenerationNotIndexableError);
    const created = await es.cat.indices({ index: `${PREFIX}-cases-v1-g${unverified}-*`, format: 'json', h: 'index' });
    expect(created).toEqual([]);
    expect(await aliasTargets(es, ALIAS)).toEqual([built.index]);
  });
});

describe('nested aircraft', () => {
  const nestedAll = (...terms: Record<string, string>[]): estypes.QueryDslQueryContainer => ({
    nested: { path: 'aircraft', query: { bool: { filter: terms.map((t) => ({ term: t })) } } },
  });

  it('nested query: category=airplane AND make=Hughes on two-aircraft fixture does not match across aircraft', async () => {
    // DCA25MA108: a Bombardier airplane and a Sikorsky helicopter.
    const same = await reader.search({
      index: ALIAS,
      query: nestedAll({ 'aircraft.category': 'AIR' }, { 'aircraft.make': 'SIKORSKY' }),
    });
    expect(ids(same)).toEqual([]);
    const across = await reader.search({
      index: ALIAS,
      query: {
        bool: {
          filter: [nestedAll({ 'aircraft.category': 'AIR' }), nestedAll({ 'aircraft.make': 'SIKORSKY' })],
        },
      },
    });
    expect(ids(across)).toEqual(['DCA25MA108']);
    // The Hughes is the DFW08TA066 helicopter: never an airplane.
    const hughes = await reader.search({ index: ALIAS, query: nestedAll({ 'aircraft.category': 'AIR' }, { 'aircraft.make': 'Hughes' }) });
    expect(ids(hughes)).toEqual([]);
    const hughesHeli = await reader.search({ index: ALIAS, query: nestedAll({ 'aircraft.category': 'HELI' }, { 'aircraft.make': 'hughes' }) });
    expect(ids(hughesHeli)).toEqual(['DFW08TA066']);
  });
});

describe('facet counts are distinct events', () => {
  type Buckets = Map<string, number>;

  async function sqlCounts(query: ReturnType<typeof sql>): Promise<Buckets> {
    const r = await ingest.execute(query);
    return new Map((r.rows as { value: string | null; n: number }[]).map((x) => [String(x.value), Number(x.n)]));
  }

  /** Terms (and missing) buckets of a nested aircraft field, counted as events via reverse_nested. */
  async function aircraftFacet(field: string): Promise<{ events: Buckets; aircraft: Buckets }> {
    const r = await reader.search({
      index: ALIAS,
      size: 0,
      aggs: {
        ac: {
          nested: { path: 'aircraft' },
          aggs: {
            values: { terms: { field: `aircraft.${field}`, size: 100 }, aggs: { events: { reverse_nested: {} } } },
            blank: { missing: { field: `aircraft.${field}` }, aggs: { events: { reverse_nested: {} } } },
          },
        },
      },
    });
    const ac = r.aggregations?.ac as unknown as {
      values: { buckets: { key: string | number; key_as_string?: string; doc_count: number; events: { doc_count: number } }[] };
      blank: { doc_count: number; events: { doc_count: number } };
    };
    const events: Buckets = new Map();
    const aircraft: Buckets = new Map();
    for (const b of ac.values.buckets) {
      const key = b.key_as_string ?? String(b.key);
      events.set(key, b.events.doc_count);
      aircraft.set(key, b.doc_count);
    }
    if (ac.blank.doc_count > 0) {
      events.set('null', ac.blank.events.doc_count);
      aircraft.set('null', ac.blank.doc_count);
    }
    return { events, aircraft };
  }

  async function eventFacet(field: string): Promise<Buckets> {
    const r = await reader.search({
      index: ALIAS,
      size: 0,
      aggs: { values: { terms: { field, size: 100 } }, blank: { missing: { field } } },
    });
    const aggs = r.aggregations as unknown as { values: { buckets: { key: string; doc_count: number }[] }; blank: { doc_count: number } };
    const out: Buckets = new Map(aggs.values.buckets.map((b) => [b.key, b.doc_count]));
    if (aggs.blank.doc_count > 0) out.set('null', aggs.blank.doc_count);
    return out;
  }

  const aircraftSql = (column: string) => sql`
    select ${sql.raw(column)} as value, count(distinct a.ntsb_no)::int as n
      from case_aircraft a join cases c on c.generation_id = a.generation_id and c.ntsb_no = a.ntsb_no
     where a.generation_id = ${generationId} and c.is_us
     group by 1`;

  it('counts events, not aircraft, for an aircraft facet on the multi-aircraft fixtures', async () => {
    const { events, aircraft } = await aircraftFacet('category');
    // 14 airplanes in 12 events; SEA08LA057 and WPR15FA010 have two airplanes each.
    expect(aircraft.get('AIR')).toBe(14);
    expect(events.get('AIR')).toBe(12);
    // DCA25MA108 (airplane + helicopter) counts once in each bucket, so the buckets
    // (12 + 3 + 1 blank) sum to more than the 15 events: the overlap the UI states.
    expect(events.get('HELI')).toBe(3);
    expect(events.get('null')).toBe(1);
    expect([...events.values()].reduce((a, b) => a + b, 0)).toBe(US_EVENTS + 1);
    expect(events).toEqual(await sqlCounts(aircraftSql('a.category')));
  });

  it('matches distinct-event counts from the database for every aircraft facet', async () => {
    const columns: Record<string, string> = {
      far_part: 'a.far_part',
      purpose: 'a.purpose',
      damage: 'a.damage',
      homebuilt: 'a.homebuilt::text',
      defining_phase_group: 'a.defining_phase_group',
      make: `upper(btrim(regexp_replace(a.make, '\\s+', ' ', 'g')))`,
      model: `upper(btrim(regexp_replace(a.model, '\\s+', ' ', 'g')))`,
    };
    for (const [field, column] of Object.entries(columns)) {
      expect((await aircraftFacet(field)).events, field).toEqual(await sqlCounts(aircraftSql(column)));
    }
    const engines = await sqlCounts(sql`
      select e.eng_type as value, count(distinct e.ntsb_no)::int as n
        from case_engines e join cases c on c.generation_id = e.generation_id and c.ntsb_no = e.ntsb_no
       where e.generation_id = ${generationId} and c.is_us and e.eng_type is not null
       group by 1`);
    const engineFacet = (await aircraftFacet('eng_types')).events;
    engineFacet.delete('null');
    expect(engineFacet).toEqual(engines);
  });

  it('matches the database for event facets, including the defining-phase groups', async () => {
    const eventSql = (column: string) => sql`
      select ${sql.raw(column)} as value, count(*)::int as n from cases
       where generation_id = ${generationId} and is_us group by 1`;
    for (const [field, column] of Object.entries({
      highest_injury: 'highest_injury',
      light: 'light_cond',
      wx_cond: 'wx_cond_basic',
      completion_class: 'completion_class',
      raw_status: 'raw_status',
      state: 'state',
    })) {
      expect(await eventFacet(field), field).toEqual(await sqlCounts(eventSql(column)));
    }
    for (const field of ['defining_phase_groups', 'sequence_phase_groups']) {
      const db = await sqlCounts(sql`
        select g as value, count(distinct ntsb_no)::int as n
          from cases, unnest(${sql.raw(field)}) as g
         where generation_id = ${generationId} and is_us group by 1`);
      const empty = await ingest.execute(
        sql`select count(*)::int as n from cases where generation_id = ${generationId} and is_us and cardinality(${sql.raw(field)}) = 0`,
      );
      const blank = Number((empty.rows[0] as { n: number }).n);
      if (blank > 0) db.set('null', blank);
      expect(await eventFacet(field), field).toEqual(db);
    }
    // SEA08LA057 counts under both of its defining phases (landing, initial climb), so
    // the phase buckets sum to more than the events that have a defining phase.
    const phases = await eventFacet('defining_phase_groups');
    expect(phases.get('landing')).toBe(3);
    expect(phases.get('initial_climb')).toBe(2);
    const sum = [...phases.entries()].filter(([k]) => k !== 'null').reduce((a, [, n]) => a + n, 0);
    expect(sum).toBe(US_EVENTS - 1 + 3);
  });
});

describe('text analysis', () => {
  const ANALYSIS_INDEX = `${PREFIX}-analysis`;
  const docs: Record<string, string> = {
    carburetor: 'The pilot did not apply carburetor heat before the descent.',
    carb: 'The pilot reported that the carb heat control was stiff.',
    british: 'The carburettor float was stuck.',
    icing: 'Atmospheric conditions were conducive to serious carburetor icing at glide power.',
    apart: 'The carburetor was intact. Ice later formed on the wing.',
    cfit: 'The airplane experienced controlled flight into terrain at night.',
    imc: 'Instrument meteorological conditions prevailed at the time of the accident.',
    atc: 'The pilot contacted air traffic control for flight following.',
    cfi: 'The flight instructor stated that the student flared high.',
    stallspin: 'The airplane entered a stall/spin at low altitude.',
    spin: 'The glider entered a spin during the turn.',
    noanomalies: 'Examination of the engine revealed no anomalies that would have precluded normal operation.',
    anomalies: 'Several anomalies were noted; no repairs had been made.',
    notdetermined: 'The reason for the loss of engine power was not determined.',
    possessive: "The pilot’s logbook was not recovered.",
  };

  beforeAll(async () => {
    await es.indices.create({ index: ANALYSIS_INDEX, settings: CASES_SETTINGS, mappings: CASES_MAPPING });
    await es.bulk({
      refresh: true,
      operations: Object.entries(docs).flatMap(([id, text]) => [
        { create: { _index: ANALYSIS_INDEX, _id: id } },
        { ntsb_no: id, country: 'USA', probable_cause: text } satisfies Partial<CaseDoc>,
      ]),
    });
  });

  async function tokens(analyzer: string, text: string): Promise<string[]> {
    const r = await es.indices.analyze({ index: ANALYSIS_INDEX, analyzer, text });
    return (r.tokens ?? []).map((t) => t.token);
  }

  /** Tokens with positions; a token spanning several positions shows its length. */
  async function graph(analyzer: string, text: string): Promise<string[]> {
    const r = await es.indices.analyze({ index: ANALYSIS_INDEX, analyzer, text });
    return (r.tokens ?? []).map((t) => {
      const length = (t as { positionLength?: number }).positionLength;
      return `${t.token}@${t.position}${length && length > 1 ? `+${length}` : ''}`;
    });
  }

  async function match(query: string): Promise<string[]> {
    return ids(await reader.search({ index: ANALYSIS_INDEX, size: 50, query: { match: { probable_cause: { query, operator: 'and' } } } }));
  }

  async function phrase(query: string): Promise<string[]> {
    return ids(await reader.search({ index: ANALYSIS_INDEX, size: 50, query: { match_phrase: { probable_cause: query } } }));
  }

  it('keeps negation tokens', async () => {
    expect(await tokens(INDEX_ANALYZER, 'no anomalies')).toEqual(['no', 'anomali']);
    expect(await tokens(INDEX_ANALYZER, 'not determined')).toEqual(['not', 'determin']);
    expect(await tokens(SEARCH_ANALYZER, 'not determined')).toEqual(['not', 'determin']);
    expect(await tokens(INDEX_ANALYZER, 'none never without nor')).toEqual(['none', 'never', 'without', 'nor']);
    // Every other English stop word is dropped.
    expect(await tokens(INDEX_ANALYZER, AVIATION_STOP_WORDS.join(' '))).toEqual([]);
    expect(await phrase('no anomalies')).toEqual(['noanomalies']);
    expect(await phrase('not determined')).toEqual(['notdetermined']);
  });

  it('stems and strips possessives', async () => {
    expect(await tokens(INDEX_ANALYZER, 'icing')).toEqual(await tokens(INDEX_ANALYZER, 'ice'));
    expect(await tokens(INDEX_ANALYZER, 'carburetors')).toEqual(['carburetor']);
    expect(await tokens(INDEX_ANALYZER, "pilot's pilot’s")).toEqual(['pilot', 'pilot']);
    expect(await match('pilots logbooks')).toEqual(['possessive']);
  });

  it('carb matches carburetor via synonyms', async () => {
    expect(await match('carb')).toEqual(['british', 'carb', 'carburetor', 'icing', 'apart'].sort());
    expect(await match('carburetor heat')).toEqual(['carb', 'carburetor']);
    // Synonyms are search-time only: the index keeps the words as written.
    expect(await tokens(INDEX_ANALYZER, 'carb')).toEqual(['carb']);
  });

  it('expands multi-word synonyms as phrases', async () => {
    expect(await graph(SEARCH_ANALYZER, 'cfit')).toEqual(['cfit@0+4', 'control@0', 'flight@1', 'terrain@3']);
    expect(await match('cfit')).toEqual(['cfit']);
    expect(await match('imc')).toEqual(['imc']);
    expect(await match('atc')).toEqual(['atc']);
    expect(await match('cfi')).toEqual(['cfi']);
    // "carb ice" is carburetor icing as a phrase, not the two words anywhere.
    expect(await tokens(SEARCH_ANALYZER, 'carb ice')).toEqual(expect.arrayContaining(['carburetor', 'ic']));
    expect(await match('carb ice')).toEqual(['icing']);
    // Spelled-out words keep their own meaning (all words, any position).
    expect(await match('carburetor ice')).toEqual(['apart', 'icing']);
  });

  it('never treats stall and spin as synonyms', async () => {
    expect(await tokens(SEARCH_ANALYZER, 'stall')).toEqual(['stall']);
    expect(await tokens(SEARCH_ANALYZER, 'spin')).toEqual(['spin']);
    expect(await tokens(INDEX_ANALYZER, 'stall/spin')).toEqual(['stall', 'spin']);
    expect(await match('stall')).toEqual(['stallspin']);
    expect(await match('spin')).toEqual(['spin', 'stallspin']);
  });

  it('matches quoted phrases as written, with stop-word gaps and without synonyms', async () => {
    // Quotes are not tokens.
    expect(await tokens(SEARCH_ANALYZER, '"no anomalies"')).toEqual(['no', 'anomali']);
    expect(await phrase('loss of engine power')).toEqual(['notdetermined']);
    expect(await phrase('controlled flight into terrain')).toEqual(['cfit']);
    expect(await phrase('carb ice')).toEqual([]);
    expect(await phrase('carburetor ice')).toEqual(['icing']);
    const quoted = await reader.search({
      index: ANALYSIS_INDEX,
      query: { simple_query_string: { query: '"no anomalies" engine', fields: ['probable_cause'], default_operator: 'and' } },
    });
    expect(ids(quoted)).toEqual(['noanomalies']);
  });
});

describe('alias', () => {
  it('alias switch is atomic', async () => {
    const first = (await aliasTargets(es, ALIAS))[0];
    expect(first).toBeDefined();
    const totals: number[] = [];
    const errors: unknown[] = [];
    let stop = false;
    const searching = (async () => {
      while (!stop) {
        try {
          totals.push(total(await reader.search({ index: ALIAS, size: 0, track_total_hits: true })));
        } catch (e) {
          errors.push(e);
        }
      }
    })();
    const second = await rebuildCasesIndex(es, ingest, { generationId, prefix: PREFIX });
    const switchedAt = totals.length;
    while (totals.length < switchedAt + 10 && errors.length === 0) await new Promise((r) => setTimeout(r, 5));
    stop = true;
    await searching;

    expect(errors).toEqual([]);
    expect(switchedAt).toBeGreaterThan(5);
    expect(totals.every((t) => t === US_EVENTS)).toBe(true);
    expect(second.previousIndices).toEqual([first]);
    expect(await aliasTargets(es, ALIAS)).toEqual([second.index]);
    // The previous index is kept.
    expect(await es.indices.exists({ index: first as string })).toBe(true);
    // Rolling back is another switch.
    await switchAlias(es, ALIAS, first as string);
    expect(await aliasTargets(es, ALIAS)).toEqual([first]);
  });

  it('refuses to shadow a concrete index', async () => {
    const concrete = `${PREFIX}-concrete`;
    await es.indices.create({ index: concrete });
    await expect(switchAlias(es, concrete, built.index)).rejects.toThrow(/concrete index/);
  });
});
