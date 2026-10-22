import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client, estypes } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import { activePins, pinGeneration, pruneGenerations, unpinGeneration } from '../../server/db/generations.js';
import { streamCaseRecords, type CaseRecord } from '../../server/db/queries/case-records.js';
import { ALIAS_LOCK_NAMESPACE, AliasSwitchError, aliasTargets, switchAlias } from '../../worker/index/aliases.js';
import { INDEX_ANALYZER, SEARCH_ANALYZER } from '../../worker/index/analysis.js';
import {
  BUILD_PIN_HOURS,
  CASES_INDEX_VERSION,
  CASES_MAPPING,
  CASES_SETTINGS,
  GenerationNotIndexableError,
  buildCaseDocument,
  casesAlias,
  casesIndexName,
  rebuildCasesIndex,
  type CaseDoc,
  type IndexReport,
} from '../../worker/index/cases-index.js';
import { AVIATION_STOP_WORDS } from '../../worker/index/synonyms.js';
import { loadFromExtract } from '../../worker/ingest/load.js';
import { TABLE_NAMES } from '../../worker/ingest/tables.js';
import { fixtureCaseRecords } from '../support/case-records.js';
import { editTable, makeExtractDir, removeDir } from '../support/extract-dir.js';
import { evIdOf, loadVerified, tamper } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetCorpus, testDb, testEs, testEsReader } from './helpers.js';

/** A prefix of our own, so parallel runs and other suites never share an alias. */
const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const ALIAS = casesAlias(PREFIX);
/** US events in the fixtures (ENG08WA029 is the one foreign event). */
const US_EVENTS = 15;
/** Keeps the shared generation through the pruning tests. */
const TEST_PIN = 'cases-index-test';

let ingest: Db;
/** A second pool, for work that runs while the first one is busy. */
let ingest2: Db;
let migrator: Db;
let es: Client;
let reader: Client;
let fixtureDir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-cases-index-test-'));
const tempDirs: string[] = [];
let generationId: number;
let built: IndexReport;
let offline: Map<string, CaseRecord>;

const status = (e: unknown) => (e as { meta?: { statusCode?: number } }).meta?.statusCode;
const total = (r: estypes.SearchResponse) => (typeof r.hits.total === 'number' ? r.hits.total : (r.hits.total?.value ?? -1));
const ids = (r: estypes.SearchResponse): string[] => r.hits.hits.map((h) => h._id ?? '').sort();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function indicesLike(pattern: string): Promise<string[]> {
  const found = await es.cat.indices({ index: pattern, format: 'json', h: 'index' });
  return found.map((f) => f.index ?? '').sort();
}

async function deleteOwnIndices(): Promise<void> {
  for (const index of await indicesLike(`${PREFIX}-*`)) await es.indices.delete({ index });
}

const verified = (dir = fixtureDir): Promise<number> => loadVerified(ingest, dir, reportDir);

/** The fixtures restricted to one event. */
async function onlyEvent(ntsbNo: string): Promise<string> {
  const evId = evIdOf(fixtureDir, ntsbNo);
  const dir = await makeExtractDir({
    edit: (d) => {
      for (const table of TABLE_NAMES) {
        try {
          editTable(d, table, (rows) => rows.filter((r) => r.ev_id === evId));
        } catch {
          // Optional tables are absent from the fixtures.
        }
      }
    },
  });
  tempDirs.push(dir);
  return dir;
}

type IndicesPatch = Partial<Record<'updateAliases' | 'getAlias', (...args: never[]) => Promise<unknown>>>;

/** The write client with some `indices` methods replaced (fault injection). */
function patched(patch: (real: Client['indices']) => IndicesPatch): Client {
  const real = es.indices;
  const replacements = patch(real) as Record<PropertyKey, unknown>;
  const indices = new Proxy(real, {
    get(target, prop) {
      if (prop in replacements) return replacements[prop];
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(es, {
    get(target, prop) {
      if (prop === 'indices') return indices;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const lostResponse = () => Object.assign(new Error('socket hang up (simulated lost response)'), { name: 'ConnectionError' });

beforeAll(async () => {
  await resetCorpus();
  ingest = testDb('ingest');
  ingest2 = testDb('ingest');
  migrator = testDb('migrator');
  es = testEs();
  reader = testEsReader();
  fixtureDir = await makeExtractDir();
  generationId = await verified();
  await pinGeneration(ingest, generationId, TEST_PIN);
  offline = await fixtureCaseRecords(generationId);
  built = await rebuildCasesIndex(es, ingest, { generationId, prefix: PREFIX });
}, 120_000);

afterAll(async () => {
  await unpinGeneration(ingest, generationId, TEST_PIN).catch(() => undefined);
  await deleteOwnIndices();
  await Promise.all([closeDb(ingest), closeDb(ingest2), closeDb(migrator)]);
  for (const d of [fixtureDir, reportDir, ...tempDirs]) removeDir(d);
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
      aliasReconciled: false,
    });
    expect(CASES_INDEX_VERSION).toBe('cases-v2');
    expect(built.index).toMatch(new RegExp(`^${PREFIX}-cases-v2-g${generationId}-\\d{17}$`));
    expect(await aliasTargets(es, ALIAS)).toEqual([built.index]);
    // The build's pin is released; only the test's own pin remains.
    expect((await activePins(ingest, generationId)).map((p) => p.reason)).toEqual([TEST_PIN]);

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

  it('refuses unverified, stale-verifier, missing and empty generations', async () => {
    const prefix = `${PREFIX}-refused`;
    const refused = async (id: number, reason: RegExp) => {
      const err = await rebuildCasesIndex(es, ingest, { generationId: id, prefix }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GenerationNotIndexableError);
      expect(String(err)).toMatch(reason);
      expect(await indicesLike(`${prefix}-*`)).toEqual([]);
      expect(await activePins(ingest, id)).toEqual([]);
    };

    const { generationId: unverified } = await loadFromExtract(ingest, fixtureDir);
    await refused(unverified, /is loaded; only a verified generation/);

    const stale = await verified();
    await tamper(migrator, ['dataset_generations'], sql`update dataset_generations set verifier_version = 'verify-v0' where id = ${stale}`);
    await refused(stale, /latest verification is ok by verify-v0/);

    await refused(999_999, /does not exist/);

    // A verified generation whose only event is foreign: nothing to index.
    const empty = await verified(await onlyEvent('ENG08WA029'));
    await refused(empty, /no US cases; an empty index is never built/);
    expect(await aliasTargets(es, casesAlias(prefix))).toEqual([]);
  });

  it('pins the generation while it builds and releases the pin afterwards', async () => {
    const prefix = `${PREFIX}-pin`;
    let pins: Awaited<ReturnType<typeof activePins>> = [];
    const report = await rebuildCasesIndex(es, ingest, {
      generationId,
      prefix,
      afterPin: async () => {
        pins = await activePins(ingest2, generationId);
      },
    });
    const own = pins.find((p) => p.reason === `index:${report.index}`);
    expect(own).toBeDefined();
    const hours = ((own?.pinnedUntil?.getTime() ?? 0) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(BUILD_PIN_HOURS - 0.1);
    expect(hours).toBeLessThanOrEqual(BUILD_PIN_HOURS);
    expect((await activePins(ingest, generationId)).map((p) => p.reason)).toEqual([TEST_PIN]);
  });

  it('pruning during a build skips the pinned generation, and the build completes', async () => {
    const g = await verified();
    const prefix = `${PREFIX}-prune`;
    let prune: Awaited<ReturnType<typeof pruneGenerations>> | undefined;
    const report = await rebuildCasesIndex(es, ingest, {
      generationId: g,
      prefix,
      afterPin: async () => {
        // Every unpinned, never-published generation is past a zero grace period.
        prune = await pruneGenerations(ingest2, { graceHours: 0 });
      },
    });
    expect(prune?.skippedPinned).toEqual(expect.arrayContaining([g, generationId]));
    expect(prune?.deleted).not.toContain(g);
    expect(report.documents).toBe(US_EVENTS);
    expect((await reader.count({ index: casesAlias(prefix) })).count).toBe(US_EVENTS);
  });

  it('a build waits for a running prune and refuses the generation it removed', async () => {
    const g = await verified();
    const prefix = `${PREFIX}-pruned`;
    let build: Promise<unknown> | undefined;
    const prune = await pruneGenerations(ingest2, {
      graceHours: 0,
      afterPlan: async (candidates) => {
        expect(candidates).toContain(g);
        build = rebuildCasesIndex(es, ingest, { generationId: g, prefix }).catch((e: unknown) => e);
        await sleep(300);
        // Still waiting for the lifecycle lock: nothing created yet.
        expect(await indicesLike(`${prefix}-*`)).toEqual([]);
      },
    });
    expect(prune.deleted).toContain(g);
    const err = await build;
    expect(err).toBeInstanceOf(GenerationNotIndexableError);
    expect(String(err)).toMatch(/does not exist/);
    expect(await indicesLike(`${prefix}-*`)).toEqual([]);
    expect(await aliasTargets(es, casesAlias(prefix))).toEqual([]);
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
  const docs: Record<string, string | string[]> = {
    carburetor: 'The pilot did not apply carburetor heat before the descent.',
    carb: 'The pilot reported that the carb heat control was stiff.',
    british: 'The carburettor float was stuck.',
    icing: 'Atmospheric conditions were conducive to serious carburetor icing at glide power.',
    apart: 'The carburetor was intact. Ice later formed on the wing.',
    cfit: 'The airplane experienced controlled flight into terrain at night.',
    imc: 'Instrument meteorological conditions prevailed at the time of the accident.',
    imcabbr: 'The flight continued into IMC.',
    atc: 'The pilot contacted air traffic control for flight following.',
    atcabbr: 'The pilot contacted ATC for a clearance.',
    cfi: 'The flight instructor stated that the student flared high.',
    cfiabbr: 'The CFI demonstrated a slow flight maneuver.',
    wxabbr: 'Wx was reported as clear.',
    stallspin: 'The airplane entered a stall/spin at low altitude.',
    spin: 'The glider entered a spin during the turn.',
    noanomalies: 'Examination of the engine revealed no anomalies that would have precluded normal operation.',
    anomalies: 'Several anomalies were noted; no repairs had been made.',
    notdetermined: 'The reason for the loss of engine power was not determined.',
    possessive: 'The pilot’s logbook was not recovered.',
    generator: 'The generator warning light illuminated.',
    general: 'The airplane was in general good repair.',
    engineer: 'The flight engineer completed the checklist.',
    sections: ['The left engine lost power', 'Fuel was found in both tanks'],
    joined: ['The right engine lost power. Fuel was found in both tanks'],
  };

  beforeAll(async () => {
    await es.indices.create({ index: ANALYSIS_INDEX, settings: CASES_SETTINGS, mappings: CASES_MAPPING });
    await es.bulk({
      refresh: true,
      operations: Object.entries(docs).flatMap(([id, text]) => [
        { create: { _index: ANALYSIS_INDEX, _id: id } },
        { ntsb_no: id, country: 'USA', probable_cause: Array.isArray(text) ? text : [text] } satisfies Partial<CaseDoc>,
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

  async function phrase(query: string, index = ANALYSIS_INDEX, field = 'probable_cause'): Promise<string[]> {
    return ids(await reader.search({ index, size: 50, query: { match_phrase: { [field]: query } } }));
  }

  async function quoted(query: string): Promise<string[]> {
    return ids(
      await reader.search({
        index: ANALYSIS_INDEX,
        size: 50,
        query: { simple_query_string: { query, fields: ['probable_cause'], default_operator: 'and' } },
      }),
    );
  }

  it('keeps negation tokens', async () => {
    expect(await tokens(INDEX_ANALYZER, 'no anomalies')).toEqual(['no', 'anomaly']);
    expect(await tokens(INDEX_ANALYZER, 'not determined')).toEqual(['not', 'determine']);
    expect(await tokens(SEARCH_ANALYZER, 'not determined')).toEqual(['not', 'determine']);
    expect(await tokens(INDEX_ANALYZER, 'none never without nor')).toEqual(['none', 'never', 'without', 'nor']);
    // Every other English stop word is dropped.
    expect(await tokens(INDEX_ANALYZER, AVIATION_STOP_WORDS.join(' '))).toEqual([]);
    expect(await phrase('no anomalies')).toEqual(['noanomalies']);
    expect(await phrase('not determined')).toEqual(['notdetermined']);
  });

  it('stems conservatively (light English) and strips possessives', async () => {
    const same = async (a: string, b: string) => expect(await tokens(INDEX_ANALYZER, a), `${a} ~ ${b}`).toEqual(await tokens(INDEX_ANALYZER, b));
    const apart = async (a: string, b: string) => expect(await tokens(INDEX_ANALYZER, a), `${a} != ${b}`).not.toEqual(await tokens(INDEX_ANALYZER, b));
    await apart('generator', 'general');
    await apart('generation', 'general');
    await apart('generator', 'generation');
    await apart('engine', 'engineer');
    await apart('experience', 'experiment');
    for (const w of ['icing', 'iced', 'ices']) await same(w, 'ice');
    await same('conditions', 'condition');
    await same('carburetors', 'carburetor');
    await same('engines', 'engine');
    expect(await tokens(INDEX_ANALYZER, "pilot's pilot’s")).toEqual(['pilot', 'pilot']);
    expect(await match('pilots logbooks')).toEqual(['possessive']);
    expect(await match('generator')).toEqual(['generator']);
    expect(await match('engineer')).toEqual(['engineer']);
    expect(await match('engine')).not.toContain('engineer');
    expect(await match('ice')).toEqual(['apart', 'icing']);
  });

  it('carb matches carburetor via synonyms', async () => {
    expect(await match('carb')).toEqual(['apart', 'british', 'carb', 'carburetor', 'icing']);
    expect(await match('carbs')).toEqual(await match('carb'));
    expect(await match('carburetors')).toEqual(await match('carb'));
    expect(await match('carburetor heat')).toEqual(['carb', 'carburetor']);
    // Synonyms are search-time only: the index keeps the words as written.
    expect(await tokens(INDEX_ANALYZER, 'carb')).toEqual(['carb']);
  });

  it('expands multi-word synonyms as phrases, both ways for unambiguous abbreviations', async () => {
    expect(await graph(SEARCH_ANALYZER, 'cfit')).toEqual(expect.arrayContaining(['cfit@0+4', 'control@0', 'flight@1', 'terrain@3']));
    expect(await match('cfit')).toEqual(['cfit']);
    expect(await match('controlled flight into terrain')).toEqual(['cfit']);
    expect(await match('imc')).toEqual(['imc', 'imcabbr']);
    expect(await match('instrument meteorological conditions')).toEqual(['imc', 'imcabbr']);
    expect(await match('atc')).toEqual(['atc', 'atcabbr']);
    expect(await match('air traffic control')).toEqual(['atc', 'atcabbr']);
    expect(await match('cfi')).toEqual(['cfi', 'cfiabbr']);
    expect(await match('flight instructors')).toEqual(['cfi', 'cfiabbr']);
    expect(await match('cfis')).toEqual(['cfi', 'cfiabbr']);
    // One-way: "wx" finds weather, but the ordinary word "weather" does not pull in "wx".
    expect(await match('wx')).toEqual(['wxabbr']);
    expect(await match('weather')).toEqual([]);
    // "carb ice" is carburetor icing as a phrase, not the two words anywhere.
    expect(await tokens(SEARCH_ANALYZER, 'carb ice')).toEqual(expect.arrayContaining(['carburetor', 'ice']));
    expect(await match('carb ice')).toEqual(['icing']);
    // Spelled-out words without a rule keep their own meaning (all words, any position).
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
    expect(await tokens(SEARCH_ANALYZER, '"no anomalies"')).toEqual(['no', 'anomaly']);
    expect(await phrase('loss of engine power')).toEqual(['notdetermined']);
    expect(await phrase('controlled flight into terrain')).toEqual(['cfit']);
    expect(await phrase('carb ice')).toEqual([]);
    expect(await phrase('carburetor ice')).toEqual(['icing']);
    expect(await quoted('"no anomalies" engine')).toEqual(['noanomalies']);
    // A quoted abbreviation is not expanded.
    expect(await quoted('"atc"')).toEqual(['atcabbr']);
    expect(await quoted('atc')).toEqual(['atc', 'atcabbr']);
  });

  it('never matches a phrase across two sections', async () => {
    expect(await phrase('lost power')).toEqual(['joined', 'sections']);
    expect(await phrase('fuel was found')).toEqual(['joined', 'sections']);
    // Only the single-value document has these words next to each other.
    expect(await phrase('power fuel')).toEqual(['joined']);
    expect(await phrase('engine lost power fuel was found')).toEqual(['joined']);
    expect(await quoted('"power fuel"')).toEqual(['joined']);
    // Unquoted words still match anywhere in the field.
    expect(await match('power fuel')).toEqual(['joined', 'sections']);

    // Real fixture: SEA08LA057 has two analysis sections; one ends "...on final
    // approach." and the next begins "The pilots were attending...".
    expect(await phrase('final approach', ALIAS, 'analysis')).toContain('SEA08LA057');
    expect(await phrase('pilots were attending a fly-in', ALIAS, 'analysis')).toEqual(['SEA08LA057']);
    expect(await phrase('final approach the pilots were attending', ALIAS, 'analysis')).toEqual([]);
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
    while (totals.length < switchedAt + 10 && errors.length === 0) await sleep(5);
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
    await switchAlias(es, ingest, ALIAS, first as string);
    expect(await aliasTargets(es, ALIAS)).toEqual([first]);
  });

  it('serializes simultaneous first publications: exactly one target', async () => {
    for (let round = 0; round < 5; round += 1) {
      const alias = `${PREFIX}-race${round}`;
      const [a, b] = [`${alias}-a`, `${alias}-b`];
      await es.indices.create({ index: a });
      await es.indices.create({ index: b });
      const [ra, rb] = await Promise.all([switchAlias(es, ingest, alias, a), switchAlias(es, ingest2, alias, b)]);
      const targets = await aliasTargets(es, alias);
      expect(targets).toHaveLength(1);
      // One switch created the alias, the other replaced it.
      const [firstSwitch, lastSwitch] = ra.previous.length === 0 ? [ra, rb] : [rb, ra];
      expect(firstSwitch.previous).toEqual([]);
      expect(lastSwitch.previous).toEqual([firstSwitch.index]);
      expect(targets).toEqual([lastSwitch.index]);
    }

    // Two whole builds publishing the same new alias at once.
    const prefix = `${PREFIX}-both`;
    const [x, y] = await Promise.all([
      rebuildCasesIndex(es, ingest, { generationId, prefix, now: () => new Date('2026-01-01T00:00:00.001Z') }),
      rebuildCasesIndex(es, ingest2, { generationId, prefix, now: () => new Date('2026-01-01T00:00:00.002Z') }),
    ]);
    const targets = await aliasTargets(es, casesAlias(prefix));
    expect(targets).toHaveLength(1);
    expect([x.index, y.index]).toContain(targets[0]);
    expect((await reader.count({ index: casesAlias(prefix) })).count).toBe(US_EVENTS);
  });

  it('keeps the new index when the switch response is lost', async () => {
    const prefix = `${PREFIX}-lost`;
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const faulty = patched((real) => ({
      updateAliases: async (...args: never[]) => {
        await (real.updateAliases as (...a: never[]) => Promise<unknown>)(...args);
        throw lostResponse();
      },
    }));
    const report = await rebuildCasesIndex(faulty, ingest, { generationId, prefix });
    expect(report.aliasReconciled).toBe(true);
    expect(report.previousIndices).toEqual([before.index]);
    expect(await aliasTargets(es, casesAlias(prefix))).toEqual([report.index]);
    expect(await es.indices.exists({ index: report.index })).toBe(true);
    expect(await es.indices.exists({ index: before.index })).toBe(true);
  });

  it('keeps the new index when reading the alias back fails after the switch', async () => {
    const prefix = `${PREFIX}-readback`;
    const alias = casesAlias(prefix);
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });

    // Reads after the request fail; the switch itself commits.
    const failingReads = (failures: number) => {
      let sent = false;
      let failed = 0;
      return patched((real) => ({
        updateAliases: async (...args: never[]) => {
          sent = true;
          return (real.updateAliases as (...a: never[]) => Promise<unknown>)(...args);
        },
        getAlias: async (...args: never[]) => {
          if (sent && failed < failures) {
            failed += 1;
            throw lostResponse();
          }
          return (real.getAlias as (...a: never[]) => Promise<unknown>)(...args);
        },
      }));
    };

    // A transient failure: the next read-back confirms the switch.
    const transient = await rebuildCasesIndex(failingReads(1), ingest, {
      generationId,
      prefix,
      alias: { readAttempts: 3, readRetryDelayMs: 10 },
    });
    expect(transient.aliasReconciled).toBe(true);
    expect(await aliasTargets(es, alias)).toEqual([transient.index]);

    // Unreadable outcome: the build fails but never deletes the index the alias may serve.
    const at = new Date('2026-02-02T02:02:02.002Z');
    const index = casesIndexName(prefix, generationId, at);
    const err = await rebuildCasesIndex(failingReads(99), ingest, {
      generationId,
      prefix,
      now: () => at,
      alias: { readAttempts: 2, readRetryDelayMs: 10 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliasSwitchError);
    expect((err as AliasSwitchError).outcome).toBe('unknown');
    expect(String(err)).toContain(`${index} is kept`);
    expect(await es.indices.exists({ index })).toBe(true);
    const targets = await aliasTargets(es, alias);
    expect(targets).toEqual([index]);
    expect((await reader.count({ index: alias })).count).toBe(US_EVENTS);
    expect(await es.indices.exists({ index: before.index })).toBe(true);
    expect((await activePins(ingest, generationId)).map((p) => p.reason)).toEqual([TEST_PIN]);
  });

  it('deletes the new index only when the alias certainly does not include it', async () => {
    const prefix = `${PREFIX}-refusedswitch`;
    const alias = casesAlias(prefix);
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const at = new Date('2026-03-03T03:03:03.003Z');
    const index = casesIndexName(prefix, generationId, at);
    const faulty = patched(() => ({
      updateAliases: async () => {
        throw lostResponse();
      },
    }));
    const err = await rebuildCasesIndex(faulty, ingest, { generationId, prefix, now: () => at }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliasSwitchError);
    expect((err as AliasSwitchError).outcome).toBe('not_switched');
    expect(await es.indices.exists({ index })).toBe(false);
    expect(await aliasTargets(es, alias)).toEqual([before.index]);
  });

  it('fails cleanly while another worker holds the alias lock', async () => {
    const prefix = `${PREFIX}-locked`;
    const alias = casesAlias(prefix);
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const holder = await ingest2.$client.connect();
    try {
      await holder.query('select pg_advisory_lock($1, hashtext($2))', [ALIAS_LOCK_NAMESPACE, alias]);
      const at = new Date('2026-04-04T04:04:04.004Z');
      const err = await rebuildCasesIndex(es, ingest, { generationId, prefix, now: () => at, alias: { lockTimeoutMs: 300 } }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AliasSwitchError);
      expect((err as AliasSwitchError).outcome).toBe('not_switched');
      expect(String(err)).toMatch(/timed out waiting/);
      expect(await es.indices.exists({ index: casesIndexName(prefix, generationId, at) })).toBe(false);
      expect(await aliasTargets(es, alias)).toEqual([before.index]);
    } finally {
      await holder.query('select pg_advisory_unlock($1, hashtext($2))', [ALIAS_LOCK_NAMESPACE, alias]);
      holder.release();
    }
  });

  it('refuses to shadow a concrete index', async () => {
    const concrete = `${PREFIX}-concrete`;
    await es.indices.create({ index: concrete });
    const err = await switchAlias(es, ingest, concrete, built.index).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliasSwitchError);
    expect((err as AliasSwitchError).outcome).toBe('not_switched');
    expect(String(err)).toMatch(/concrete index/);
  });
});
