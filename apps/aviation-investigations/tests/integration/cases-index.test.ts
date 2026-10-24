import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client, estypes } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import { activePins, pinGeneration, pruneGenerations, publishManifest, unpinGeneration } from '../../server/db/generations.js';
import { streamCaseRecords, type CaseRecord } from '../../server/db/queries/case-records.js';
import { ALIAS_LOCK_NAMESPACE, AliasSwitchError, aliasTargets, switchAlias } from '../../worker/index/aliases.js';
import {
  BUILD_LOCK_NAMESPACE,
  buildPinReason,
  cleanupStalePins,
  declareAbandoned,
  deleteUnusedIndices,
  reconcileAlias,
} from '../../worker/index/publications.js';
import { INDEX_ANALYZER, SEARCH_ANALYZER } from '../../worker/index/analysis.js';
import {
  CASES_INDEX_VERSION,
  CASES_MAPPING,
  CASES_SETTINGS,
  GenerationNotIndexableError,
  UnresolvedAliasError,
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
import { TEST_INDEX_PREFIX, resetControls, resetCorpus, testDb, testEs, testEsReader } from './helpers.js';

/** A prefix of our own, so parallel runs and other suites never share an alias. */
const RUN = randomBytes(4).toString('hex');
const PREFIX = `${TEST_INDEX_PREFIX}${RUN}`;
/** A build id unique to this run (`index_publications` keeps every build ever recorded). */
const bid = (tag: string) => `${RUN}${tag}`;
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
  // Index-level API: the writer key has no cluster privilege, so `_cat/indices` is refused.
  const found = await es.indices.get({ index: pattern, expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: true });
  return Object.keys(found).sort();
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
const rejected = () => Object.assign(new Error('illegal_argument_exception (simulated)'), { name: 'ResponseError', meta: { statusCode: 400 } });

/** Outcomes of every switch attempt for an index, oldest first. */
async function outcomes(index: string): Promise<string[]> {
  const r = await ingest.execute(sql`select outcome from index_switch_attempts where index_name = ${index} order by id`);
  return (r.rows as { outcome: string }[]).map((x) => x.outcome);
}

/** Whether the build's index is recorded as deleted (undefined: no build row). */
async function recordedDeleted(index: string): Promise<boolean | undefined> {
  const r = await ingest.execute(sql`select deleted_at is not null as deleted from index_builds where index_name = ${index}`);
  return (r.rows[0] as { deleted: boolean } | undefined)?.deleted;
}

const realUpdateAliases = (real: Client['indices']) => (real.updateAliases as (...a: never[]) => Promise<unknown>).bind(real);

beforeAll(async () => {
  await resetCorpus();
  // Briefs another test file left behind would cite these generation ids and keep them from pruning.
  await resetControls();
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
      aliasVerified: true,
    });
    expect(CASES_INDEX_VERSION).toBe('cases-v3');
    expect(built.index).toMatch(new RegExp(`^${PREFIX}-cases-v3-g${generationId}-\\d{17}-${built.buildId}$`));
    expect(await outcomes(built.index)).toEqual(['committed']);
    expect(await recordedDeleted(built.index)).toBe(false);
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

  it('pins the generation for the build, without expiry, and releases only its own pin', async () => {
    const prefix = `${PREFIX}-pin`;
    let pins: Awaited<ReturnType<typeof activePins>> = [];
    const report = await rebuildCasesIndex(es, ingest, {
      generationId,
      prefix,
      afterPin: async () => {
        pins = await activePins(migrator, generationId);
      },
    });
    expect(pins).toEqual(expect.arrayContaining([{ reason: buildPinReason(report.buildId), pinnedUntil: null }]));
    expect((await activePins(ingest, generationId)).map((p) => p.reason)).toEqual([TEST_PIN]);
  });

  it('gives simultaneous builds their own index and pin, even at the same instant', async () => {
    const prefix = `${PREFIX}-same`;
    const at = () => new Date('2026-05-05T05:05:05.005Z');
    let bPinned!: () => void;
    const bHasPin = new Promise<void>((r) => (bPinned = r));
    let aSettled!: () => void;
    const aDone = new Promise<void>((r) => (aSettled = r));
    let bPinsAfterA: string[] = [];

    const a = rebuildCasesIndex(es, ingest, {
      generationId,
      prefix,
      now: at,
      afterPin: async () => {
        await bHasPin;
        throw new Error('build A fails after pinning');
      },
    })
      .catch((e: unknown) => e)
      .finally(() => aSettled());
    const b = rebuildCasesIndex(es, ingest2, {
      generationId,
      prefix,
      now: at,
      afterPin: async () => {
        bPinned();
        await aDone;
        bPinsAfterA = (await activePins(migrator, generationId)).map((p) => p.reason);
      },
    });
    const [errA, reportB] = await Promise.all([a, b]);
    expect(String(errA)).toMatch(/build A fails/);
    // A's failure removed only A's pin: B still held its own while it built.
    expect(bPinsAfterA).toContain(buildPinReason(reportB.buildId));
    expect(bPinsAfterA.filter((r) => r.startsWith('index-build:'))).toEqual([buildPinReason(reportB.buildId)]);
    expect(reportB.index).toContain('-20260505050505005-');
    expect(await aliasTargets(es, casesAlias(prefix))).toEqual([reportB.index]);
    expect((await activePins(ingest, generationId)).map((p) => p.reason)).toEqual([TEST_PIN]);
  });

  it('fails closed before publishing when its pin disappears during the build', async () => {
    const prefix = `${PREFIX}-unpinned`;
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const buildId = bid('unpin');
    const index = casesIndexName(prefix, generationId, new Date('2026-06-06T06:06:06.006Z'), buildId);
    const err = await rebuildCasesIndex(es, ingest, {
      generationId,
      prefix,
      buildId,
      now: () => new Date('2026-06-06T06:06:06.006Z'),
      afterPin: async () => {
        expect(await unpinGeneration(ingest2, generationId, buildPinReason(buildId))).toBe(true);
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliasSwitchError);
    expect((err as AliasSwitchError).outcome).toBe('not_submitted');
    expect(String(err)).toMatch(new RegExp(`pin index-build:${buildId} .* is gone; refusing to publish`));
    // Never part of an alias request: the build deleted its own index.
    expect(await es.indices.exists({ index })).toBe(false);
    expect(await outcomes(index)).toEqual([]);
    expect(await recordedDeleted(index)).toBe(true);
    expect(await aliasTargets(es, casesAlias(prefix))).toEqual([before.index]);
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

  it('splits headings glued to their text, and leaves case numbers, acronyms and plurals alone', async () => {
    for (const analyzer of [INDEX_ANALYZER, SEARCH_ANALYZER]) {
      const t = await tokens(analyzer, 'AIRCRAFT INFORMATIONThe airplane');
      expect(t).toContain('information');
      expect(t).toContain('airplane');
      expect(t).not.toContain('informationthe');
      expect(await tokens(analyzer, 'HISTORY OF FLIGHTOn December 14')).toEqual(['history', 'flight', 'december', '14']);
      expect(await tokens(analyzer, 'SEA08LA057')).toEqual(['sea08la057']);
      expect(await tokens(analyzer, 'NOTAMs and METARs')).toEqual(['notam', 'metar']);
    }
    expect(await tokens(INDEX_ANALYZER, 'IMC VMC')).toEqual(['imc', 'vmc']);
    // Offsets still point into the stored text.
    const r = await es.indices.analyze({ index: ANALYSIS_INDEX, analyzer: INDEX_ANALYZER, text: 'WRECKAGE INFORMATIONThe airplane' });
    const word = r.tokens?.find((x) => x.token === 'airplane');
    expect([word?.start_offset, word?.end_offset]).toEqual([24, 32]);
    const info = r.tokens?.find((x) => x.token === 'information');
    expect([info?.start_offset, info?.end_offset]).toEqual([9, 20]);
  });

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
    expect(await outcomes(first as string)).toEqual(['committed', 'committed']);
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

    // Two whole builds publishing the same new alias at the same instant.
    const prefix = `${PREFIX}-both`;
    const at = () => new Date('2026-01-01T00:00:00.001Z');
    const [x, y] = await Promise.all([
      rebuildCasesIndex(es, ingest, { generationId, prefix, now: at }),
      rebuildCasesIndex(es, ingest2, { generationId, prefix, now: at }),
    ]);
    expect(x.index).not.toBe(y.index);
    const targets = await aliasTargets(es, casesAlias(prefix));
    expect(targets).toHaveLength(1);
    expect([x.index, y.index]).toContain(targets[0]);
    expect((await reader.count({ index: casesAlias(prefix) })).count).toBe(US_EVENTS);
  });

  it('treats a lost response as unknown and blocks the alias until a read-back shows it', async () => {
    const prefix = `${PREFIX}-lost`;
    const alias = casesAlias(prefix);
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const faulty = patched((real) => ({
      updateAliases: async (...args: never[]) => {
        await realUpdateAliases(real)(...args);
        throw lostResponse();
      },
    }));
    const buildId = bid('lost');
    const index = casesIndexName(prefix, generationId, new Date('2026-07-07T07:07:07.007Z'), buildId);
    const err = await rebuildCasesIndex(faulty, ingest, {
      generationId,
      prefix,
      buildId,
      now: () => new Date('2026-07-07T07:07:07.007Z'),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliasSwitchError);
    expect((err as AliasSwitchError).outcome).toBe('unknown');
    expect(String(err)).toContain(`${index} is kept`);
    // The request did commit: the alias serves the kept index, never nothing.
    expect(await aliasTargets(es, alias)).toEqual([index]);
    expect(await es.indices.exists({ index })).toBe(true);
    expect(await es.indices.exists({ index: before.index })).toBe(true);
    expect(await outcomes(index)).toEqual(['unknown']);

    // No further switch until reconciled: the next build stops before creating anything.
    const blocked = await rebuildCasesIndex(es, ingest, { generationId, prefix }).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(UnresolvedAliasError);
    expect(String(blocked)).toContain(`pnpm worker index reconcile --alias ${alias}`);
    expect(await indicesLike(`${prefix}-*`)).toEqual([before.index, index].sort());

    const settled = await reconcileAlias(es, ingest, alias);
    expect(settled).toMatchObject({ targets: [index], committed: [{ indexName: index }], unresolved: [], blocked: false });
    expect(await outcomes(index)).toEqual(['committed']);
    const after = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    expect(after.previousIndices).toEqual([index]);
  });

  it('keeps an unknown attempt blocked, whatever the delay, until a read-back includes its index', async () => {
    const pending: Promise<unknown>[] = [];
    /** The request times out at once; Elasticsearch completes it `ms` later. */
    const delayedCommit = (ms: number) =>
      patched((real) => ({
        updateAliases: async (...args: never[]) => {
          pending.push(sleep(ms).then(() => realUpdateAliases(real)(...args)));
          throw Object.assign(new Error('request timed out (simulated)'), { name: 'TimeoutError' });
        },
      }));

    const prefix = `${PREFIX}-delayed`;
    const alias = casesAlias(prefix);
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const buildId = bid('delay');
    const index = casesIndexName(prefix, generationId, new Date('2026-08-08T08:08:08.008Z'), buildId);
    const err = await rebuildCasesIndex(delayedCommit(1500), ingest, {
      generationId,
      prefix,
      buildId,
      now: () => new Date('2026-08-08T08:08:08.008Z'),
    }).catch((e: unknown) => e);
    expect((err as AliasSwitchError).outcome).toBe('unknown');

    // Reconciling before completion proves nothing: the attempt stays unknown and blocking.
    for (let i = 0; i < 2; i += 1) {
      const early = await reconcileAlias(es, ingest, alias);
      expect(early).toMatchObject({ targets: [before.index], committed: [], blocked: true });
      expect(early.unresolved.map((u) => u.indexName)).toEqual([index]);
      expect(await rebuildCasesIndex(es, ingest, { generationId, prefix }).catch((e: unknown) => e)).toBeInstanceOf(UnresolvedAliasError);
      await sleep(300);
    }
    expect(await outcomes(index)).toEqual(['unknown']);
    await Promise.all(pending.splice(0));
    // Completed after the reconciles: it landed on an index that still exists.
    expect(await aliasTargets(es, alias)).toEqual([index]);
    expect(await es.indices.exists({ index })).toBe(true);
    const late = await reconcileAlias(es, ingest, alias);
    expect(late).toMatchObject({ committed: [{ indexName: index }], unresolved: [], blocked: false });

    // Simultaneous first publication of a fresh alias, one request delayed.
    const fresh = `${PREFIX}-delayedfirst`;
    const freshAlias = casesAlias(fresh);
    const [x, y] = await Promise.all([
      rebuildCasesIndex(delayedCommit(800), ingest, { generationId, prefix: fresh }).catch((e: unknown) => e),
      rebuildCasesIndex(es, ingest2, { generationId, prefix: fresh }).catch((e: unknown) => e),
    ]);
    expect((x as AliasSwitchError).outcome).toBe('unknown');
    await Promise.all(pending.splice(0));
    const targets = await aliasTargets(es, freshAlias);
    expect(targets).toHaveLength(1);
    expect(await es.indices.exists({ index: targets[0] as string })).toBe(true);
    // y either published first (then x replaced it) or was refused while x was unresolved.
    if (y instanceof Error) expect(String(y)).toMatch(/blocked by an unresolved switch/);
    const settled = await reconcileAlias(es, ingest, freshAlias);
    expect(settled).toMatchObject({ targets, unresolved: [], blocked: false });
    expect(await outcomes(targets[0] as string)).toContain('committed');
  });

  it('unblocks a never-applied unknown attempt only by an explicit declaration, deleting nothing', async () => {
    const prefix = `${PREFIX}-neverapplied`;
    const alias = casesAlias(prefix);
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const faulty = patched(() => ({
      updateAliases: async () => {
        throw lostResponse();
      },
    }));
    const buildId = bid('never');
    const index = casesIndexName(prefix, generationId, new Date('2026-09-09T09:09:09.009Z'), buildId);
    const err = await rebuildCasesIndex(faulty, ingest, {
      generationId,
      prefix,
      buildId,
      now: () => new Date('2026-09-09T09:09:09.009Z'),
    }).catch((e: unknown) => e);
    expect((err as AliasSwitchError).outcome).toBe('unknown');
    const attemptId = (err as AliasSwitchError).attemptId as number;
    expect(await es.indices.exists({ index })).toBe(true);

    const r = await reconcileAlias(es, ingest, alias);
    expect(r).toMatchObject({ committed: [], unresolved: [{ id: attemptId, indexName: index, declared: false }], blocked: true });
    await expect(declareAbandoned(ingest, alias, attemptId, '  ')).rejects.toThrow(/reason/);
    await declareAbandoned(ingest, alias, attemptId, 'cluster restarted before the request was processed');
    await expect(declareAbandoned(ingest, alias, attemptId, 'twice')).rejects.toThrow(/not an undeclared unknown/);
    expect((await reconcileAlias(es, ingest, alias)).blocked).toBe(false);

    // Unblocked: the next build publishes. The declared index still exists and stays unknown.
    const next = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    expect(next.previousIndices).toEqual([before.index]);
    expect(await outcomes(index)).toEqual(['unknown']);
    expect(await es.indices.exists({ index })).toBe(true);
    const declared = await ingest.execute(sql`select declared_reason from index_switch_attempts where id = ${attemptId}`);
    expect(declared.rows).toEqual([{ declared_reason: 'cluster restarted before the request was processed' }]);
    // And delete-unused never touches an index with an unknown attempt.
    const del = await deleteUnusedIndices(es, ingest, { olderThanHours: 0, yes: true, aliases: [alias] });
    expect(del.refused).toEqual(expect.arrayContaining([{ indexName: index, reason: 'has a switch attempt that is unknown' }]));
    expect(await es.indices.exists({ index })).toBe(true);
  });

  it('keeps the index after Elasticsearch rejects the switch; only delete-unused removes it', async () => {
    const prefix = `${PREFIX}-rejected`;
    const alias = casesAlias(prefix);
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const buildId = bid('reject');
    const index = casesIndexName(prefix, generationId, new Date('2026-03-03T03:03:03.003Z'), buildId);
    const faulty = patched(() => ({
      updateAliases: async () => {
        throw rejected();
      },
    }));
    const err = await rebuildCasesIndex(faulty, ingest, {
      generationId,
      prefix,
      buildId,
      now: () => new Date('2026-03-03T03:03:03.003Z'),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliasSwitchError);
    expect((err as AliasSwitchError).outcome).toBe('rejected');
    // Submitted, so the build does not delete it.
    expect(await es.indices.exists({ index })).toBe(true);
    expect(await outcomes(index)).toEqual(['rejected']);
    expect(await aliasTargets(es, alias)).toEqual([before.index]);
    // A rejection settles the outcome: the alias is not blocked.
    const next = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    expect(next.previousIndices).toEqual([before.index]);

    // Dry run by default; deletes only with yes: the rejected-only index and the one the alias
    // moved away from, never the current target.
    const dry = await deleteUnusedIndices(es, ingest, { olderThanHours: 0, aliases: [alias] });
    expect(dry).toMatchObject({ dryRun: true, deleted: [] });
    expect(dry.wouldDelete.sort()).toEqual([before.index, index].sort());
    expect(await es.indices.exists({ index })).toBe(true);
    const done = await deleteUnusedIndices(es, ingest, { olderThanHours: 0, yes: true, aliases: [alias] });
    expect(done.deleted.sort()).toEqual([before.index, index].sort());
    expect(done.refused).toEqual([{ indexName: next.index, reason: `is a target of ${alias}` }]);
    expect(await es.indices.exists({ index })).toBe(false);
    expect(await recordedDeleted(index)).toBe(true);
    expect(await aliasTargets(es, alias)).toEqual([next.index]);
  });

  it('a rejected rollback to an older committed index changes nothing: the alias stays, the older index is unused', async () => {
    const prefix = `${PREFIX}-rollback`;
    const alias = casesAlias(prefix);
    const older = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const newer = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const faulty = patched(() => ({
      updateAliases: async () => {
        throw rejected();
      },
    }));
    const err = await switchAlias(faulty, ingest, alias, older.index).catch((e: unknown) => e);
    expect((err as AliasSwitchError).outcome).toBe('rejected');
    // The rejected request was never applied: the alias still targets the newer index, and the
    // older one, committed once but no target and in no manifest, is unused (a dry run says so).
    expect(await outcomes(older.index)).toEqual(['committed', 'rejected']);
    const del = await deleteUnusedIndices(es, ingest, { olderThanHours: 0, aliases: [alias] });
    expect(del.wouldDelete).toEqual([older.index]);
    expect(del.refused).toEqual(expect.arrayContaining([{ indexName: newer.index, reason: `is a target of ${alias}` }]));
    expect(await es.indices.exists({ index: older.index })).toBe(true);
    expect(await aliasTargets(es, alias)).toEqual([newer.index]);
    // The database refuses rewriting the committed attempt itself.
    const rewrite = await ingest
      .execute(sql`update index_switch_attempts set outcome = 'rejected' where index_name = ${older.index} and outcome = 'committed'`)
      .catch((e: unknown) => e);
    expect(String((rewrite as { cause?: unknown }).cause ?? rewrite)).toMatch(/cannot go from committed to rejected/);
  });

  it('treats a committed switch as done even when reading the alias back fails', async () => {
    const prefix = `${PREFIX}-readback`;
    const alias = casesAlias(prefix);
    await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const failingReads = (failures: number) => {
      let sent = false;
      let failed = 0;
      return patched((real) => ({
        updateAliases: async (...args: never[]) => {
          sent = true;
          return realUpdateAliases(real)(...args);
        },
        getAlias: async (...args: never[]) => {
          if (sent && failed < failures) {
            failed += 1;
            throw lostResponse();
          }
          return (real.getAlias as (...a: never[]) => Promise<unknown>).call(real, ...args);
        },
      }));
    };
    const transient = await rebuildCasesIndex(failingReads(1), ingest, {
      generationId,
      prefix,
      alias: { readAttempts: 3, readRetryDelayMs: 10 },
    });
    expect(transient.aliasVerified).toBe(true);
    const unreadable = await rebuildCasesIndex(failingReads(99), ingest, {
      generationId,
      prefix,
      alias: { readAttempts: 2, readRetryDelayMs: 10 },
    });
    expect(unreadable.aliasVerified).toBe(false);
    expect(await aliasTargets(es, alias)).toEqual([unreadable.index]);
    expect(await outcomes(unreadable.index)).toEqual(['committed']);
  });

  it('fails cleanly while another worker holds the alias lock', async () => {
    const prefix = `${PREFIX}-locked`;
    const alias = casesAlias(prefix);
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const holder = await ingest2.$client.connect();
    try {
      await holder.query('select pg_advisory_lock($1, hashtext($2))', [ALIAS_LOCK_NAMESPACE, alias]);
      const at = new Date('2026-04-04T04:04:04.004Z');
      const buildId = bid('locked');
      const err = await rebuildCasesIndex(es, ingest, {
        generationId,
        prefix,
        buildId,
        now: () => at,
        alias: { lockTimeoutMs: 300 },
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AliasSwitchError);
      expect((err as AliasSwitchError).outcome).toBe('not_submitted');
      expect(String(err)).toMatch(/timed out waiting/);
      const index = casesIndexName(prefix, generationId, at, buildId);
      expect(await es.indices.exists({ index })).toBe(false);
      expect(await recordedDeleted(index)).toBe(true);
      expect(await aliasTargets(es, alias)).toEqual([before.index]);
    } finally {
      await holder.query('select pg_advisory_unlock($1, hashtext($2))', [ALIAS_LOCK_NAMESPACE, alias]);
      holder.release();
    }
  });

  it('reasserting the current sole target sends no alias request and records no attempt', async () => {
    const prefix = `${PREFIX}-current`;
    const alias = casesAlias(prefix);
    const a = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    // A client whose alias requests would all fail in transport, counting them.
    let sent = 0;
    const failing = patched(() => ({
      updateAliases: async () => {
        sent += 1;
        throw lostResponse();
      },
    }));
    const again = await switchAlias(failing, ingest, alias, a.index);
    expect(again).toMatchObject({ status: 'already_current', attemptId: null, previous: [a.index] });
    expect(sent).toBe(0);
    expect(await outcomes(a.index)).toEqual(['committed']);
    // Nothing unknown was recorded, so the alias is not blocked and the next build publishes alone.
    expect((await reconcileAlias(es, ingest, alias)).blocked).toBe(false);
    const b = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    expect(b.previousIndices).toEqual([a.index]);
    expect(await aliasTargets(es, alias)).toEqual([b.index]);

    // A switch to an index that is not the sole target is a real request.
    const back = await switchAlias(failing, ingest, alias, a.index).catch((e: unknown) => e);
    expect(sent).toBe(1);
    expect((back as AliasSwitchError).outcome).toBe('unknown');
    expect(await outcomes(a.index)).toEqual(['committed', 'unknown']);
    // A read-back without the index keeps that attempt blocking.
    expect((await reconcileAlias(es, ingest, alias)).blocked).toBe(true);
    const r = await reconcileAlias(es, ingest, alias);
    await declareAbandoned(ingest, alias, r.unresolved[0]?.id as number, 'test: simulated transport failure, never sent');
  });

  it('refuses to shadow a concrete index', async () => {
    const concrete = `${PREFIX}-concrete`;
    await es.indices.create({ index: concrete });
    const err = await switchAlias(es, ingest, concrete, built.index).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AliasSwitchError);
    expect((err as AliasSwitchError).outcome).toBe('not_submitted');
    expect(String(err)).toMatch(/concrete index/);
  });
});

describe('explicit cleanup', () => {
  it('delete-unused rechecks after selection: a publication finishing in between makes the index ineligible', async () => {
    const prefix = `${PREFIX}-between`;
    const alias = casesAlias(prefix);
    const before = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const buildId = bid('between');
    const index = casesIndexName(prefix, generationId, new Date('2026-11-11T11:11:11.011Z'), buildId);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let recorded!: () => void;
    const isRecorded = new Promise<void>((r) => (recorded = r));
    const build = rebuildCasesIndex(es, ingest2, {
      generationId,
      prefix,
      buildId,
      now: () => new Date('2026-11-11T11:11:11.011Z'),
      afterPin: async () => {
        recorded();
        await gate;
      },
    });
    await isRecorded;

    // While the build waits, it is a candidate but still running.
    const running = await deleteUnusedIndices(es, ingest, { olderThanHours: 0, yes: true, aliases: [alias] });
    expect(running.refused).toEqual(expect.arrayContaining([{ indexName: index, reason: 'its build is still running' }]));

    // Selected while running; the build publishes before the locks are taken.
    let selected: string[] = [];
    const report = await deleteUnusedIndices(es, ingest, {
      olderThanHours: 0,
      yes: true,
      aliases: [alias],
      afterSelect: async (candidates) => {
        selected = candidates;
        release();
        await build;
      },
    });
    expect(selected).toContain(index);
    // The index the build switched the alias to in between is kept; the one it replaced is no
    // longer used and goes.
    expect(report.refused).toEqual(expect.arrayContaining([{ indexName: index, reason: `is a target of ${alias}` }]));
    expect(report.deleted).toEqual([before.index]);
    expect(await es.indices.exists({ index })).toBe(true);
    expect(await aliasTargets(es, alias)).toEqual([index]);
    expect(await es.indices.exists({ index: before.index })).toBe(false);
  });

  it('delete-unused deletes a committed index once the alias has moved away from it, and keeps the current target', async () => {
    const prefix = `${PREFIX}-retired`;
    const alias = casesAlias(prefix);
    const first = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    const second = await rebuildCasesIndex(es, ingest, { generationId, prefix });
    expect(await outcomes(first.index)).toEqual(['committed']);
    expect(await aliasTargets(es, alias)).toEqual([second.index]);
    // Younger than the threshold: not even a candidate.
    expect((await deleteUnusedIndices(es, ingest, { olderThanHours: 1, aliases: [alias] })).wouldDelete).toEqual([]);
    const dry = await deleteUnusedIndices(es, ingest, { olderThanHours: 0, aliases: [alias] });
    expect(dry.wouldDelete).toEqual([first.index]);
    expect(dry.refused).toEqual([{ indexName: second.index, reason: `is a target of ${alias}` }]);
    const done = await deleteUnusedIndices(es, ingest, { olderThanHours: 0, yes: true, aliases: [alias] });
    expect(done.deleted).toEqual([first.index]);
    expect(await recordedDeleted(first.index)).toBe(true);
    expect(await es.indices.exists({ index: first.index })).toBe(false);
    expect(await es.indices.exists({ index: second.index })).toBe(true);
    expect(await aliasTargets(es, alias)).toEqual([second.index]);
  });

  it('delete-unused refuses indices referenced by a dataset manifest, active or retained', async () => {
    const g = await verified();
    await pinGeneration(ingest, g, TEST_PIN);
    const prefix = `${PREFIX}-manifest`;
    const alias = casesAlias(prefix);
    const faulty = patched(() => ({
      updateAliases: async () => {
        throw rejected();
      },
    }));
    // Two indices that were never alias targets (their switches were rejected).
    const make = async (tag: string) => {
      const buildId = bid(tag);
      const at = new Date('2026-12-12T12:12:12.012Z');
      await rebuildCasesIndex(faulty, ingest, { generationId: g, prefix, buildId, now: () => at }).catch((e: unknown) => e);
      return casesIndexName(prefix, g, at, buildId);
    };
    const [m1, m2] = [await make('man1'), await make('man2')];
    expect((await deleteUnusedIndices(es, ingest, { olderThanHours: 0, aliases: [alias] })).wouldDelete.sort()).toEqual([m1, m2].sort());

    await publishManifest(ingest, g, m1, `${PREFIX}-passages-a`);
    let r = await deleteUnusedIndices(es, ingest, { olderThanHours: 0, yes: true, aliases: [alias] });
    expect(r.refused).toEqual([{ indexName: m1, reason: 'referenced by a dataset manifest' }]);
    expect(r.deleted).toEqual([m2]);

    // Retained (inactive) manifests protect their indices too.
    const g2 = await verified();
    await publishManifest(ingest, g2, built.index, `${PREFIX}-passages-b`);
    r = await deleteUnusedIndices(es, ingest, { olderThanHours: 0, yes: true, aliases: [alias] });
    expect(r.refused).toEqual([{ indexName: m1, reason: 'referenced by a dataset manifest' }]);
    expect(await es.indices.exists({ index: m1 })).toBe(true);
    await unpinGeneration(ingest, g, TEST_PIN);
  });

  it('delete-unused keeps young indices, and cleanup-builds removes only stale pins', async () => {
    const prefix = `${PREFIX}-stale`;
    const alias = casesAlias(prefix);
    const faulty = patched(() => ({
      updateAliases: async () => {
        throw rejected();
      },
    }));
    const buildId = bid('young');
    const at = new Date('2026-12-01T00:00:00.000Z');
    await rebuildCasesIndex(faulty, ingest, { generationId, prefix, buildId, now: () => at }).catch((e: unknown) => e);
    const young = casesIndexName(prefix, generationId, at, buildId);
    const r = await deleteUnusedIndices(es, ingest, { olderThanHours: 1, yes: true, aliases: [alias] });
    expect(r.deleted).toEqual([]);
    expect(await es.indices.exists({ index: young })).toBe(true);

    // A build that died left its pin; another build is still running.
    const dead = bid('dead');
    const running = bid('running');
    for (const b of [dead, running]) await pinGeneration(ingest, generationId, buildPinReason(b));
    const holder = await ingest2.$client.connect();
    try {
      await holder.query('select pg_advisory_lock($1, hashtext($2))', [BUILD_LOCK_NAMESPACE, running]);
      const cleaned = await cleanupStalePins(ingest, { olderThanHours: 0 });
      expect(cleaned.pinsRemoved).toEqual(expect.arrayContaining([{ generationId, buildId: dead }]));
      expect(cleaned.pinsRemoved.map((p) => p.buildId)).not.toContain(running);
      expect(cleaned.skippedRunning).toContain(running);
      const reasons = (await activePins(ingest, generationId)).map((p) => p.reason);
      expect(reasons).toContain(buildPinReason(running));
      expect(reasons).not.toContain(buildPinReason(dead));
      expect(reasons).toContain(TEST_PIN);
      // No index is touched by pin cleanup.
      expect(await es.indices.exists({ index: young })).toBe(true);
    } finally {
      await holder.query('select pg_advisory_unlock($1, hashtext($2))', [BUILD_LOCK_NAMESPACE, running]);
      holder.release();
    }
    const later = await cleanupStalePins(ingest, { olderThanHours: 0 });
    expect(later.pinsRemoved.map((p) => p.buildId)).toContain(running);
    expect((await cleanupStalePins(ingest, { olderThanHours: 1 })).pinsRemoved).toEqual([]);
  });
});
