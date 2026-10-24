/**
 * The HTTP API against the fixture corpus in the local `test` environment: both
 * fixture sets loaded into aviation_test, verified, indexed under this run's own
 * prefix and published as a keyword-only manifest (tests/support/api-dataset.ts).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type AppDeps } from '../../server/app.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { getActiveManifest } from '../../server/db/generations.js';
import { CaseDetailSchema, type CaseDetail } from '../../shared/contracts/cases.js';
import { ErrorResponseSchema } from '../../shared/contracts/common.js';
import { ConfigResponseSchema } from '../../shared/contracts/config.js';
import { DashboardResponseSchema, type DashboardResponse } from '../../shared/contracts/dashboard.js';
import {
  FACET_KEYS,
  MAX_QUERY_LENGTH,
  SearchRequestSchema,
  SearchResponseSchema,
  searchRequestToParams,
  type FacetKey,
  type SearchResponse,
} from '../../shared/contracts/search.js';
import { HOME_EXAMPLES } from '../../shared/examples.js';
import { THEME_SCRIPT_HASH } from '../../web/src/csp-hashes.js';
import {
  CASES_INDEX_VERSION,
  CASES_MAPPING,
  CASES_SETTINGS,
  EARLIER_SERVABLE_CASES_VERSIONS,
  casesIndexFingerprint,
} from '../../worker/index/cases-index.js';
import { PublishRefusedError, publishGeneration } from '../../worker/index/publish.js';
import { normalizeCorpus } from '../../worker/ingest/normalize.js';
import { SAMPLE_SEARCHES, buildMockCorpus, readFixtureTables } from '../../scripts/mock-api/build.js';
import { searchCorpus } from '../../web/mock/engine.js';
import { deleteIndices, publishFixtureDataset, type FixtureDataset } from '../support/api-dataset.js';
import { parseHtml, parseXml, type MarkupDocument } from '../support/markup.js';
import { APP_DIR, FIXTURES_DIR, UI_FIXTURES_DIR, readCsv } from '../support/extract-dir.js';
import { testDb, testEs, testEsReader } from './helpers.js';

const RUN = randomBytes(4).toString('hex');
const PREFIX = `aviation-test-api${RUN}`;
const LOCAL = '127.0.0.1';

let ingest: Db;
let appDb: Db;
let es: Client;
let reader: Client;
let dataset: FixtureDataset;
let app: FastifyInstance;
let webRoot: string;
const apps: FastifyInstance[] = [];

const fixtureEvIds = [FIXTURES_DIR, UI_FIXTURES_DIR].flatMap((d) => readCsv(join(d, 'events.csv')).map((r) => r.ev_id as string));

function makeApp(overrides: Partial<AppDeps> = {}): FastifyInstance {
  const built = buildApp({
    config: { appUrl: 'http://localhost:3000', trustedProxyCidrs: [] },
    db: appDb,
    es: reader,
    webRoot,
    rateLimit: { limit: 100_000, windowMs: 60_000 },
    ...overrides,
  });
  apps.push(built);
  return built;
}

interface Got {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json: unknown;
}

async function get(url: string, opts: { app?: FastifyInstance; from?: string; headers?: Record<string, string> } = {}): Promise<Got> {
  const r = await (opts.app ?? app).inject({ method: 'GET', url, remoteAddress: opts.from ?? LOCAL, headers: opts.headers ?? {} });
  let json: unknown = null;
  try {
    json = JSON.parse(r.body);
  } catch {
    json = null;
  }
  return { status: r.statusCode, headers: r.headers, body: r.body, json };
}

async function search(params: Record<string, string>): Promise<SearchResponse> {
  const r = await get(`/api/search?${new URLSearchParams(params).toString()}`);
  expect(r.status, r.body).toBe(200);
  return SearchResponseSchema.parse(r.json);
}

async function dashboard(cohort: 'default' | 'all'): Promise<DashboardResponse> {
  const r = await get(`/api/dashboard?cohort=${cohort}`);
  expect(r.status, r.body).toBe(200);
  return DashboardResponseSchema.parse(r.json);
}

const counts = (buckets: readonly { value: string; count: number }[]): Record<string, number> =>
  Object.fromEntries(buckets.filter((b) => b.count > 0).map((b) => [b.value, b.count]));

async function sqlCounts(query: ReturnType<typeof sql>): Promise<Record<string, number>> {
  const rows = (await appDb.execute(query)).rows as { v: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.v, Number(r.n)]));
}

beforeAll(async () => {
  ingest = testDb('ingest');
  appDb = testDb('app');
  es = testEs();
  reader = testEsReader();
  dataset = await publishFixtureDataset(ingest, es, PREFIX);
  webRoot = mkdtempSync(join(tmpdir(), 'aviation-api-web-'));
  mkdirSync(join(webRoot, 'assets'));
  writeFileSync(
    join(webRoot, 'index.html'),
    '<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="description" content="Find and compare NTSB aviation investigations by their evidence, findings and probable causes." /><title>AirCase · aviation casebook</title></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(webRoot, 'assets', 'app-0123abcd.js'), 'console.log(1);\n');
  app = makeApp();
}, 180_000);

afterAll(async () => {
  for (const a of apps) await a.close();
  if (es) await deleteIndices(es, PREFIX);
  if (ingest) await closeDb(ingest);
  if (appDb) await closeDb(appDb);
  if (webRoot) rmSync(webRoot, { recursive: true, force: true });
});

describe('manifest', () => {
  it('is keyword-only (no passages index) and names this run’s cases index', async () => {
    const active = await getActiveManifest(appDb);
    expect(active).toMatchObject({ generationId: dataset.generationId, casesIndex: dataset.casesIndex, passagesIndex: null });
  });

  it('serves from the manifest’s index, never the alias', async () => {
    await es.indices.deleteAlias({ index: dataset.casesIndex, name: `${PREFIX}-cases` });
    expect((await search({ q: 'carburetor icing' })).total).toBe(7);
  });

  it('publish refuses an alias, another generation’s index and a count mismatch', async () => {
    const other = `${PREFIX}-cases-other`;
    const meta = (generation: number) => ({ index_version: CASES_INDEX_VERSION, fingerprint: casesIndexFingerprint(), generation_id: generation });
    await es.indices.create({ index: other, settings: CASES_SETTINGS, mappings: { ...CASES_MAPPING, _meta: meta(dataset.generationId + 100) } });
    await es.indices.putAlias({ index: dataset.casesIndex, name: `${PREFIX}-pointer` });
    const publish = (casesIndex: string, passagesIndex: string | null = null) =>
      publishGeneration(es, ingest, { generationId: dataset.generationId, casesIndex, passagesIndex });
    await expect(publish(`${PREFIX}-pointer`)).rejects.toThrow(/not a concrete index/);
    await expect(publish(other)).rejects.toThrow(/built for generation/);
    await expect(publish(`${PREFIX}-missing`)).rejects.toThrow(/does not exist/);
    await es.indices.putMapping({ index: other, _meta: meta(dataset.generationId) });
    await expect(publish(other)).rejects.toThrow(/holds 0 documents/);
    // An earlier version with the same fields passes the version checks with its own
    // fingerprint only; unknown versions are refused.
    const v2 = { ...meta(dataset.generationId), index_version: 'cases-v2', fingerprint: EARLIER_SERVABLE_CASES_VERSIONS['cases-v2'] };
    await es.indices.putMapping({ index: other, _meta: v2 });
    await expect(publish(other)).rejects.toThrow(/holds 0 documents/);
    await es.indices.putMapping({ index: other, _meta: { ...v2, fingerprint: casesIndexFingerprint() } });
    await expect(publish(other)).rejects.toThrow(/different mapping fingerprint than cases-v2/);
    await es.indices.putMapping({ index: other, _meta: { ...v2, index_version: 'cases-v1' } });
    await expect(publish(other)).rejects.toThrow(/is cases-v1; this code serves cases-v3 or cases-v2/);
    await expect(publish(dataset.casesIndex, other)).rejects.toThrow(PublishRefusedError);
    // Nothing changed: the fixture manifest is still active.
    expect((await getActiveManifest(appDb))?.casesIndex).toBe(dataset.casesIndex);
  });
});

describe('search', () => {
  it('q "carburetor icing" mentionedIn probable_cause on fixture returns expected ids', async () => {
    const r = await search({ q: 'carburetor icing', mentionedIn: 'probable_cause' });
    expect(r.rows.map((row) => row.ntsbNo)).toEqual(['ERA25LA016', 'WPR24FA190', 'WPR24LA154', 'CEN19FA009', 'ANC15LA005', 'CEN13FA030', 'CEN12LA175']);
    for (const row of r.rows) {
      expect(row.snippet?.section).toBe('probable_cause');
      const marks = row.snippet?.highlights.map((h) => row.snippet?.text.slice(h.start, h.end).toLowerCase()) ?? [];
      expect(marks.some((m) => m?.includes('carburetor'))).toBe(true);
    }
    // Over every record, two more mention it outside the probable cause only.
    const all = await search({ q: 'carburetor icing', completion: 'any' });
    expect(all.mentionedIn).toEqual({ anywhere: 9, probable_cause: 7 });
  });

  it('Lucene syntax is literal', async () => {
    const plain = await search({ q: 'carb icing' });
    expect((await search({ q: 'carb* AND (icing' })).total).toBe(plain.total);
    for (const q of ['title:x OR y~2', '/re.*gex/ \\', '"unbalanced', '[1 TO 5] {x} ^2 !-+&&||', '*', '?']) {
      const r = await get(`/api/search?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
      SearchResponseSchema.parse(r.json);
    }
  });

  it('1,501-char q is 400; 1,500 is answered', async () => {
    const tooLong = await get(`/api/search?q=${'a'.repeat(MAX_QUERY_LENGTH + 1)}`);
    expect(tooLong.status).toBe(400);
    const body = ErrorResponseSchema.parse(tooLong.json);
    expect(body).toMatchObject({ error: 'bad_request' });
    expect(body.issues?.[0]?.path).toBe('q');
    expect(tooLong.headers['cache-control']).toBe('no-store');
    const words = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ').slice(0, MAX_QUERY_LENGTH);
    expect((await get(`/api/search?q=${encodeURIComponent(words)}`)).status).toBe(200);
    const phrases = Array.from({ length: 200 }, (_, i) => `"p${i} q"`).join(' ').slice(0, MAX_QUERY_LENGTH);
    expect((await get(`/api/search?q=${encodeURIComponent(phrases)}`)).status).toBe(200);
  });

  it('unknown facet value is 400', async () => {
    for (const query of ['phase=cruising', 'injury=XYZ', 'state=ZZ', 'completion=done', 'sort=best', 'page=51', 'pageSize=0', 'yearFrom=2020&yearTo=2010']) {
      const r = await get(`/api/search?${query}`);
      expect(r.status, query).toBe(400);
      ErrorResponseSchema.parse(r.json);
    }
    // Unknown parameters are ignored (the web URL also carries case, cases, brief, step).
    expect((await get('/api/search?case=DFW08TA066&brief=x')).status).toBe(200);
  });

  it('disjunctive phase counts ignore phase selection', async () => {
    const base = await search({ q: 'carburetor icing' });
    const selected = await search({ q: 'carburetor icing', phase: 'initial_climb' });
    expect(selected.total).toBe(3);
    expect(counts(selected.facets.phase)).toEqual(counts(base.facets.phase));
    expect(counts(base.facets.phase)).toMatchObject({ initial_climb: 3, approach: 2 });
    // Other facets narrow to the selection; each phase count is that phase's total.
    expect(selected.facets.injury.reduce((n, b) => n + b.count, 0)).toBe(3);
    for (const bucket of base.facets.phase) {
      expect((await search({ q: 'carburetor icing', phase: bucket.value })).total, bucket.value).toBe(bucket.count);
    }
  });

  it('marks an analysis or factual snippet truncated only on a side where its section goes on (task 22 S-M7)', async () => {
    const seen = { start: 0, end: 0, inner: 0 };
    for (const q of ['pilot', 'engine', 'airplane', 'landing', 'fuel', 'reported', 'the airplane']) {
      const r = await search({ q, completion: 'any', mentionedIn: 'anywhere', pageSize: '50' });
      for (const row of r.rows) {
        const snip = row.snippet;
        if (!snip || snip.section === 'probable_cause') continue;
        const texts = (
          await appDb.execute(sql`SELECT text FROM case_sections WHERE generation_id = ${dataset.generationId} AND ntsb_no = ${row.ntsbNo}
            AND kind = ${snip.section}`)
        ).rows.map((x) => (x as { text: string }).text.replace(/[\r\n\t]/g, ' ').trim());
        // Not truncated at a side: some section of that kind begins (ends) with the snippet's text.
        if (!snip.truncatedStart) {
          seen.start += 1;
          expect(texts.some((t) => t.startsWith(snip.text)), `${q} ${row.ntsbNo} start`).toBe(true);
        }
        if (!snip.truncatedEnd) {
          seen.end += 1;
          expect(texts.some((t) => t.endsWith(snip.text)), `${q} ${row.ntsbNo} end`).toBe(true);
        }
        if (snip.truncatedStart && snip.truncatedEnd) seen.inner += 1;
      }
    }
    // The section edges came back from Elasticsearch: some snippets begin or end their section.
    expect(seen.start + seen.end).toBeGreaterThan(0);
  });

  it('home examples return results on the index', async () => {
    for (const example of HOME_EXAMPLES) {
      const r = await search({ q: example });
      expect(r.total, example).toBeGreaterThan(0);
      expect(r.rows[0]?.snippet?.highlights.length, example).toBeGreaterThan(0);
    }
  });

  it('answers the mock API’s sample searches with the same cases', async () => {
    const corpus = buildMockCorpus(normalizeCorpus(await readFixtureTables(APP_DIR)));
    expect(corpus.docs.length).toBe((await search({ completion: 'any' })).total);
    for (const [name, query] of Object.entries(SAMPLE_SEARCHES)) {
      const real = await search(query);
      const mock = searchCorpus(corpus, SearchRequestSchema.parse(query));
      expect(real.rows.map((r) => r.ntsbNo), name).toEqual(mock.rows.map((r) => r.ntsbNo));
      expect(real.total, name).toBe(mock.total);
      expect(real.relaxations, name).toEqual(mock.relaxations);
      // Rows are the same projection (snippets aside: the analyzer is real here).
      expect(real.rows.map(({ snippet: _s, ...row }) => row), name).toEqual(mock.rows.map(({ snippet: _s, ...row }) => row));
    }
  });

  it('no results lists "remove one filter" totals', async () => {
    const r = await search({ q: 'carburetor icing', phase: 'landing', injury: 'FATL' });
    expect(r.total).toBe(0);
    expect(r.relaxations).toEqual([
      { drop: 'completion', count: 0 },
      { drop: 'phase', count: 3 },
      { drop: 'injury', count: 0 },
    ]);
    // Selected values stay listed with a zero count.
    expect(r.facets.phase.find((b) => b.value === 'landing')).toMatchObject({ count: 0 });
  });

  it('pages, sorts and returns the year chart and multi-aircraft count', async () => {
    const first = await search({ completion: 'any', pageSize: '5' });
    const second = await search({ completion: 'any', pageSize: '5', page: '2' });
    expect(second.rows.map((r) => r.ntsbNo)).not.toContain(first.rows[0]?.ntsbNo);
    const dates = (await search({ completion: 'any', sort: 'oldest', pageSize: '50' })).rows.map((r) => r.date ?? '');
    expect(dates).toEqual([...dates].sort());
    const all = await search({ completion: 'any', pageSize: '50' });
    expect(all.years[0]?.year).toBe(2008);
    expect(all.years.reduce((n, y) => n + y.completed + y.other, 0)).toBe(all.total);
    expect(all.multiAircraft).toBe(3);
    expect(all.rows.every((r) => r.snippet === null || (r.snippet.section === 'probable_cause' && r.snippet.highlights.length === 0))).toBe(true);
  });

  it('facet counts equal count(distinct) in SQL for the fixture generation', async () => {
    const g = dataset.generationId;
    const r = await search({ completion: 'any' });
    const us = sql`c.generation_id = ${g} and c.is_us`;
    const event = (column: string) =>
      sqlCounts(sql`select coalesce(${sql.raw(`c.${column}`)}, 'blank') as v, count(*)::int as n from cases c where ${us} group by 1`);
    const aircraft = (column: string, where = sql`true`) =>
      sqlCounts(sql`select coalesce(${sql.raw(`a.${column}`)}, 'blank') as v, count(distinct a.ntsb_no)::int as n
        from case_aircraft a join cases c on c.generation_id = a.generation_id and c.ntsb_no = a.ntsb_no
        where ${us} and ${where} group by 1`);
    const expected: Record<FacetKey, Record<string, number>> = {
      completion: await sqlCounts(sql`select case when c.completion_class = 'completed'
          then case when c.has_probable_cause then 'completed_with_cause' else 'completed_without_cause' end
          else c.completion_class end as v, count(*)::int as n from cases c where ${us} group by 1`),
      injury: await event('highest_injury'),
      conditions: await event('wx_cond_basic'),
      light: await event('light_cond'),
      state: await event('state'),
      phase: await aircraft('defining_phase_group'),
      category: await aircraft('category'),
      far_part: await aircraft('far_part'),
      purpose: await aircraft('purpose'),
      engine: await sqlCounts(sql`select coalesce(e.eng_type, 'blank') as v, count(distinct a.ntsb_no)::int as n
        from case_aircraft a join cases c on c.generation_id = a.generation_id and c.ntsb_no = a.ntsb_no
        left join case_engines e on e.generation_id = a.generation_id and e.ntsb_no = a.ntsb_no
          and e.aircraft_key = a.aircraft_key and e.eng_type is not null
        where ${us} group by 1`),
    };
    for (const facet of FACET_KEYS) expect(counts(r.facets[facet]), facet).toEqual(expected[facet]);
    // Aircraft facets combine per aircraft: phase counts among airplanes only.
    const airplanes = await search({ completion: 'any', category: 'AIR' });
    expect(counts(airplanes.facets.phase)).toEqual(await aircraft('defining_phase_group', sql`a.category = 'AIR'`));
    // Overlap: aircraft buckets can sum to more than the total in multi-aircraft events.
    expect(r.facets.category.reduce((n, b) => n + b.count, 0)).toBeGreaterThan(r.total);
  });
});

describe('dashboard', () => {
  it('a bar count equals the Explore total for the same filter, in both cohorts', async () => {
    for (const cohort of ['default', 'all'] as const) {
      const d = await dashboard(cohort);
      const scope: Record<string, string> = cohort === 'all' ? { completion: 'any' } : {};
      expect((await search(scope)).total).toBe(d.total);
      for (const bar of [...d.phase, ...d.injury, ...d.weather, ...d.category]) {
        const r = await search({ ...scope, [bar.facet]: bar.value });
        expect(r.total, `${cohort} ${bar.facet}=${bar.value}`).toBe(bar.count);
      }
      for (const y of d.years.filter((x) => x.completed + x.other > 0)) {
        const r = await search({ ...scope, yearFrom: String(y.year), yearTo: String(y.year) });
        expect(r.total, `${cohort} ${y.year}`).toBe(cohort === 'all' ? y.completed + y.other : y.completed);
      }
    }
  });

  it('covers the cohort and projects points into the lower-48 frame', async () => {
    const d = await dashboard('all');
    const g = dataset.generationId;
    const [row] = (
      await appDb.execute(sql`select count(*)::int as total, count(metar)::int as metar, count(latitude)::int as located,
        count(*) filter (where has_probable_cause)::int as cause from cases where generation_id = ${g} and is_us`)
    ).rows as { total: number; metar: number; located: number; cause: number }[];
    expect(d.total).toBe(row?.total);
    expect(d.coverage).toEqual({
      probableCause: { count: row?.cause, of: row?.total },
      metar: { count: row?.metar, of: row?.total },
      coordinates: { count: row?.located, of: row?.total },
      multiAircraft: 3,
    });
    expect(d.map.points.length + d.map.outsideFrame + d.map.withoutCoordinates).toBe(d.total);
    expect(d.map.outsideFrame).toBeGreaterThanOrEqual(1); // the Alaska fixture
    const again = await get('/api/dashboard?cohort=all');
    expect(again.headers['cache-control']).toBe('public, max-age=300');
    expect(String(again.headers.etag)).toContain(d.dataset.revision);
  });
});

describe('cases', () => {
  it('equal the reference projection of the fixtures, with resolved report links', async () => {
    const corpus = buildMockCorpus(normalizeCorpus(await readFixtureTables(APP_DIR)));
    const config = ConfigResponseSchema.parse((await get('/api/config')).json);
    for (const [ntsbNo, reference] of Object.entries(corpus.cases)) {
      const r = await get(`/api/cases/${ntsbNo}`);
      expect(r.status, ntsbNo).toBe(200);
      const detail = CaseDetailSchema.parse(r.json);
      const expected: CaseDetail = {
        ...reference,
        provenance: { ...reference.provenance, snapshotDate: config.snapshotDate, datasetRevision: config.datasetRevision },
        report: detail.report,
      };
      expect(detail, ntsbNo).toEqual(expected);
    }
    const seeded = CaseDetailSchema.parse((await get('/api/cases/DFW08TA066')).json);
    expect(seeded.report).toEqual({
      kind: 'report',
      url: 'https://data.ntsb.gov/carol-repgen/api/Aviation/ReportMain/GenerateNewestReport/67493/pdf',
      label: 'NTSB report',
      capturedOn: '2026-10-16',
    });
    expect(CaseDetailSchema.parse((await get('/api/cases/SEA08LA057')).json).report.kind).toBe('search');
  });

  it('case endpoint never contains AI fields or ev_id', async () => {
    // `ai` followed by a capital or underscore (aiSummary, ai_note), never "aircraft".
    const forbidden = /^(ev_?id|evId|EV_ID|ai[A-Z_]\w*|AI\w*|verdict|why|brief\w*|summary|citations?|passages?|interpretations?)$/;
    const keys = (value: unknown, out: string[] = []): string[] => {
      if (Array.isArray(value)) for (const v of value) keys(v, out);
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          out.push(k);
          keys(v, out);
        }
      }
      return out;
    };
    for (const ntsbNo of ['DFW08TA066', 'SEA08LA057', 'DCA25MA108', 'ENG08WA029', 'CEN12LA175']) {
      const r = await get(`/api/cases/${ntsbNo}`);
      expect(r.status, ntsbNo).toBe(200);
      expect(keys(r.json).filter((k) => forbidden.test(k)), ntsbNo).toEqual([]);
      for (const evId of fixtureEvIds) expect(r.body.includes(evId), `${ntsbNo} contains an ev_id`).toBe(false);
    }
    const s = await get('/api/search?completion=any&pageSize=50');
    for (const evId of fixtureEvIds) expect(s.body.includes(evId)).toBe(false);
  });

  it('is publicly cacheable with a revision ETag, 304 on match, 404 for unknown numbers', async () => {
    const r = await get('/api/cases/DFW08TA066');
    const config = ConfigResponseSchema.parse((await get('/api/config')).json);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    const etag = String(r.headers.etag);
    expect(etag).toMatch(new RegExp(`^"${config.datasetRevision}-[0-9a-f]{16}"$`));
    expect(config.datasetRevision).toMatch(new RegExp(`^g${dataset.generationId}-${CASES_INDEX_VERSION}-[0-9a-f]{8}$`));
    expect((await get('/api/cases/DFW08TA066', { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await get('/api/cases/dfw08ta066')).status).toBe(200);
    for (const unknown of ['ZZZ99ZZ999', 'not-a-number', '%3Cscript%3E']) {
      const nf = await get(`/api/cases/${unknown}`);
      expect(nf.status, unknown).toBe(404);
      expect(ErrorResponseSchema.parse(nf.json).error).toBe('not_found');
    }
  });
});

describe('config and health', () => {
  it('config reports the dataset and its coverage', async () => {
    const r = await get('/api/config');
    expect(r.status).toBe(200);
    const config = ConfigResponseSchema.parse(r.json);
    const g = dataset.generationId;
    const [row] = (
      await appDb.execute(sql`select count(*) filter (where answer_eligible)::int as cohort, count(*)::int as total,
        min(ev_year) as first, max(ev_year) as last from cases where generation_id = ${g} and is_us`)
    ).rows as { cohort: number; total: number; first: number; last: number }[];
    expect(config).toMatchObject({
      turnstileSiteKey: null,
      googleEnabled: false,
      coverage: { defaultCohort: row?.cohort, otherRecords: (row?.total ?? 0) - (row?.cohort ?? 0), yearFrom: row?.first, yearTo: row?.last, provisional: true },
    });
    expect(config.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await search({})).dataset).toEqual({ revision: config.datasetRevision, snapshotDate: config.snapshotDate });
  });

  it('health reports reachability only', async () => {
    const r = await get('/api/health');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ status: 'ok', database: 'ok', search: 'ok' });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('errors are redacted when a dependency is down', async () => {
    const { Client: EsClient } = await import('@elastic/elasticsearch');
    const down = new EsClient({ node: 'http://127.0.0.1:9', maxRetries: 0, requestTimeout: 2_000 });
    const broken = makeApp({ es: down });
    for (const url of ['/api/search?q=carburetor', '/api/config', '/api/dashboard']) {
      const r = await get(url, { app: broken });
      expect(r.status, url).toBe(503);
      expect(ErrorResponseSchema.parse(r.json)).toEqual({ error: 'unavailable', message: 'The service is temporarily unavailable. Try again shortly.' });
      expect(r.body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|9200|stack/i);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    const health = await get('/api/health', { app: broken });
    expect(health.status).toBe(503);
    expect(health.json).toEqual({ status: 'unavailable', database: 'ok', search: 'error' });
    await down.close();
  });
});

describe('http', () => {
  it('security headers present (CSP without unsafe-inline scripts)', async () => {
    for (const url of ['/api/config', '/api/search?phase=bogus', '/api/nope', '/explore', '/assets/app-0123abcd.js', '/missing.js']) {
      const r = await get(url, { headers: { accept: 'text/html' } });
      const csp = String(r.headers['content-security-policy']);
      expect(csp, url).toContain(`script-src 'self' '${THEME_SCRIPT_HASH}'`);
      expect(csp, url).toContain("frame-ancestors 'none'");
      expect(csp, url).not.toContain('unsafe-inline');
      // No anonymous AI here, so no Turnstile sources.
      expect(csp, url).not.toContain('challenges.cloudflare.com');
      expect(csp, url).not.toContain('frame-src');
      expect(r.headers['x-content-type-options'], url).toBe('nosniff');
      expect(r.headers['referrer-policy'], url).toBe('same-origin');
      expect(r.headers['permissions-policy'], url).toContain('camera=()');
      expect(r.headers['strict-transport-security'], url).toBeUndefined();
    }
    const https = makeApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: [] } });
    expect((await get('/api/config', { app: https })).headers['strict-transport-security']).toBe('max-age=31536000');
  });

  it('serves the web client with an SPA fallback on the same origin', async () => {
    const asset = await get('/assets/app-0123abcd.js');
    const home = await get('/', { headers: { accept: 'text/html' } });
    expect(home.status).toBe(200);
    expect(home.body).toContain('<div id="root">');
    expect(home.headers['cache-control']).toBe('no-cache');
    const page = await get('/explore?q=carb', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div id="root">');
    expect(page.headers['cache-control']).toBe('no-cache');
    // Each page has its own style nonce (the dialogs' scroll-lock style), in the CSP and in a meta tag.
    const nonceOf = (r: Got) => {
      const header = /style-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/.exec(String(r.headers['content-security-policy']))?.[1];
      const meta = /<meta property="csp-nonce" nonce="([^"]+)">/.exec(r.body)?.[1];
      expect(header).toBeDefined();
      expect(meta).toBe(header);
      return header;
    };
    expect(nonceOf(page)).not.toBe(nonceOf(home));
    expect(String(page.headers['content-security-policy'])).toMatch(/script-src 'self' 'sha256-[^']+'; style-src/);
    expect(String(asset.headers?.['content-security-policy'] ?? '')).not.toContain('nonce');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/missing.js', { headers: { accept: 'text/html' } })).status).toBe(404);
    const api404 = await get('/api/nope', { headers: { accept: 'text/html' } });
    expect(api404.status).toBe(404);
    expect(ErrorResponseSchema.parse(api404.json).error).toBe('not_found');
  });

  it('forged CF-Connecting-IP from non-connector peer rejected', async () => {
    const tunnel = makeApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: ['203.0.113.0/28'] } });
    for (const url of ['/api/config', '/', '/assets/app-0123abcd.js', '/api/health']) {
      const r = await get(url, { app: tunnel, from: '192.0.2.5', headers: { 'cf-connecting-ip': '198.51.100.1', accept: 'text/html' } });
      expect(r.status, url).toBe(403);
      expect(ErrorResponseSchema.parse(r.json), url).toEqual({ error: 'forbidden', message: 'This request is not allowed.' });
      expect(r.headers['content-security-policy'], url).toBeDefined();
    }
    // Loopback is not the connector either, except for the container's health check.
    expect((await get('/api/config', { app: tunnel, from: LOCAL, headers: { 'cf-connecting-ip': '198.51.100.1' } })).status).toBe(403);
    expect((await get('/api/health', { app: tunnel, from: LOCAL })).status).toBe(200);
  });

  it('tunnel mode: a missing or invalid client address is 400 on the API, never a shared bucket', async () => {
    const tunnel = makeApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: ['203.0.113.0/28'] }, rateLimit: { limit: 2, windowMs: 60_000 } });
    const connector = '203.0.113.2';
    const missing = await get('/api/config', { app: tunnel, from: connector });
    expect(missing.status).toBe(400);
    expect(ErrorResponseSchema.parse(missing.json).error).toBe('bad_request');
    expect((await get('/api/config', { app: tunnel, from: connector, headers: { 'cf-connecting-ip': 'unknown' } })).status).toBe(400);
    expect((await get('/api/config', { app: tunnel, from: connector, headers: { 'cf-connecting-ip': '198.51.100.1, 198.51.100.2' } })).status).toBe(400);
    // Static files need no client address.
    expect((await get('/assets/app-0123abcd.js', { app: tunnel, from: connector })).status).toBe(200);
    // Each client has its own bucket behind the one connector.
    const as = (ip: string) => get('/api/config', { app: tunnel, from: connector, headers: { 'cf-connecting-ip': ip } });
    expect((await as('198.51.100.1')).status).toBe(200);
    expect((await as('198.51.100.1')).status).toBe(200);
    expect((await as('198.51.100.1')).status).toBe(429);
    expect((await as('198.51.100.2')).status).toBe(200);
    expect((await as('2001:db8:5:6::1')).status).toBe(200);
    expect((await as('2001:db8:5:6::2')).status).toBe(200);
    expect((await as('2001:db8:5:6:ffff::3')).status).toBe(429);
  });

  it('61st request in a minute is 429 with retryAfter', async () => {
    const limited = makeApp({ rateLimit: { limit: 60, windowMs: 60_000 } });
    for (let i = 0; i < 60; i++) expect((await get('/api/config', { app: limited })).status).toBe(200);
    const r = await get('/api/config', { app: limited });
    expect(r.status).toBe(429);
    const body = ErrorResponseSchema.parse(r.json);
    expect(body.error).toBe('rate_limited');
    expect(body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(r.headers['retry-after']).toBe(String(body.retryAfter));
    // Health checks and other clients are not limited.
    expect((await get('/api/health', { app: limited })).status).toBe(200);
    expect((await get('/api/config', { app: limited, from: '127.0.0.2' })).status).toBe(200);
  });

  it('no-store on /api/briefs', async () => {
    // A test-only route: the real /api/briefs arrives with the briefs task. The prefix rule covers it already.
    const a = makeApp();
    for (const route of ['/api/briefs/probe', '/api/auth/probe', '/api/account/probe', '/api/ai/probe']) {
      a.get(route, async (_request, reply) => reply.header('cache-control', 'public, max-age=600').send({ ok: true }));
    }
    for (const route of ['/api/briefs/probe', '/api/auth/probe', '/api/account/probe', '/api/ai/probe', '/api/ai/status']) {
      const r = await get(route, { app: a });
      expect(r.status, route).toBe(200);
      expect(r.headers['cache-control'], route).toBe('private, no-store');
    }
    // Refusals on those routes are never stored either.
    const limited = makeApp({ rateLimit: { limit: 1, windowMs: 60_000 } });
    limited.get('/api/briefs/probe', async () => ({ ok: true }));
    expect((await get('/api/briefs/probe', { app: limited })).status).toBe(200);
    const refused = await get('/api/briefs/probe', { app: limited });
    expect(refused.status).toBe(429);
    expect(refused.headers['cache-control']).toBe('private, no-store');
    // A public data route is not affected.
    expect((await get('/api/config')).headers['cache-control']).toBe('public, max-age=300');
  });

  it('public cache on /api/cases', async () => {
    for (const url of ['/api/cases/DFW08TA066', '/api/config', '/api/dashboard?cohort=default']) {
      const r = await get(url);
      expect(r.status, url).toBe(200);
      expect(r.headers['cache-control'], url).toBe('public, max-age=300');
      expect(String(r.headers.etag), url).toMatch(/^"g\d+-/);
    }
    expect((await get('/api/search?q=carburetor')).headers['cache-control']).toBe('public, max-age=60');
  });

  it('error responses are never cacheable and carry only the fixed message', async () => {
    for (const [url, status] of [
      ['/api/cases/ZZZ99ZZ999', 404],
      ['/api/search?phase=bogus', 400],
      ['/api/nope', 404],
      ['/api/%ZZ', 400],
    ] as const) {
      const r = await get(url);
      expect(r.status, url).toBe(status);
      expect(r.headers['cache-control'], url).toBe('no-store');
      ErrorResponseSchema.parse(r.json);
    }
  });

  it('HTTPS in any letter case turns on HSTS', async () => {
    const upper = makeApp({ config: { appUrl: 'HTTPS://casebook.example', trustedProxyCidrs: [] } });
    expect((await get('/api/config', { app: upper })).headers['strict-transport-security']).toBe('max-age=31536000');
    const plain = makeApp({ config: { appUrl: 'http://casebook.example/https://', trustedProxyCidrs: [] } });
    expect((await get('/api/config', { app: plain })).headers['strict-transport-security']).toBeUndefined();
  });

  it('tunnel mode: a non-connector peer sending a malformed URL gets 403, not 400', async () => {
    const tunnel = makeApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: ['203.0.113.0/28'] } });
    // A parser-level refusal gets the same peer check.
    await tunnel.listen({ host: LOCAL, port: 0 });
    const { port } = tunnel.server.address() as { port: number };
    const parserAnswer = await new Promise<string>((resolve) => {
      const s = connect(port, LOCAL, () => s.write('BAD\r\n\r\n'));
      let d = '';
      s.setEncoding('utf8');
      s.on('data', (c: string) => (d += c));
      s.on('close', () => resolve(d));
      s.on('error', () => resolve(d));
    });
    expect(parserAnswer).toMatch(/^HTTP\/1\.1 403 /);
    for (const url of ['/%E0%A4%A', '/api/%ZZ']) {
      const stranger = await get(url, { app: tunnel, from: '192.0.2.5' });
      expect(stranger.status, url).toBe(403);
      expect(ErrorResponseSchema.parse(stranger.json).error).toBe('forbidden');
      expect(stranger.headers['content-security-policy']).toContain("default-src 'self'");
      // The connector itself still gets the router's 400.
      const connector = await get(url, { app: tunnel, from: '203.0.113.2', headers: { 'cf-connecting-ip': '198.51.100.1' } });
      expect(connector.status, url).toBe(400);
    }
  });

  it('logs one line per API request, unmatched paths included, without the raw URL', async () => {
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, done) {
        for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>);
        done();
      },
    });
    const logged = makeApp({ logger: { level: 'info', stream } });
    expect((await get('/api/nope-secret-path?q=private+text', { app: logged })).status).toBe(404);
    expect((await get('/%61pi/also-nope', { app: logged })).status).toBe(404);
    expect((await get('/api/config', { app: logged })).status).toBe(200);
    expect((await get('/some-page', { app: logged, headers: { accept: 'text/html' } })).status).toBe(404);
    const api = lines.filter((l) => l.msg === 'api request');
    expect(api.map((l) => [l.route, l.status])).toEqual([
      ['unmatched', 404],
      ['unmatched', 404],
      ['/api/config', 200],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/nope-secret-path|private|also-nope/);
  });

  it('every search response validates against its contract', async () => {
    const requests: Record<string, string>[] = [
      {},
      { q: 'midair', completion: 'any' },
      { q: '"loss of engine power"', mentionedIn: 'probable_cause' },
      { category: 'HELI', phase: 'maneuvering' },
      { state: 'blank', completion: 'any' },
      { purpose: 'blank', engine: 'REC', light: 'NITE', conditions: 'IMC', yearFrom: '2010', yearTo: '2020', sort: 'relevance' },
    ];
    for (const params of requests) {
      const canonical = searchRequestToParams(SearchRequestSchema.parse(params)).toString();
      const r = await get(`/api/search?${canonical}`);
      expect(r.status, canonical).toBe(200);
      SearchResponseSchema.parse(r.json);
      expect(r.headers['cache-control']).toBe('public, max-age=60');
    }
  });
});

// Access control follows the route the router matched, never the raw request target.
describe('request targets the router decodes', () => {
  /** One HTTP/1.1 request over a socket, so the target is sent exactly as written. */
  async function raw(a: FastifyInstance, target: string, headers: Record<string, string> = {}): Promise<Got> {
    if (!a.server.listening) await a.listen({ host: LOCAL, port: 0 });
    const { port } = a.server.address() as { port: number };
    const text = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, LOCAL, () => {
        const lines = [`GET ${target} HTTP/1.1`, 'Host: casebook.test', 'Connection: close', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      });
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    const [head = '', body = ''] = text.split('\r\n\r\n');
    const [statusLine = '', ...headerLines] = head.split('\r\n');
    const parsed: Record<string, string> = {};
    for (const line of headerLines) {
      const i = line.indexOf(':');
      parsed[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
    let json: unknown = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return { status: Number(statusLine.split(' ')[1]), headers: parsed, body, json };
  }

  it('/%61pi/search shares /api/search’s rate limit: the 61st request in the window is 429', async () => {
    const limited = makeApp({ rateLimit: { limit: 60, windowMs: 60_000 } });
    for (let i = 0; i < 60; i++) {
      const url = i % 2 === 0 ? '/api/search?q=carb' : '/%61pi/search?q=carb';
      expect((await get(url, { app: limited })).status, `${i} ${url}`).toBe(200);
    }
    for (const url of ['/%61pi/search?q=carb', '/api/search?q=carb', '/%61%70%69/%73earch']) {
      const r = await get(url, { app: limited });
      expect(r.status, url).toBe(429);
      expect(ErrorResponseSchema.parse(r.json).error).toBe('rate_limited');
    }
  });

  it('tunnel mode: /%61pi/search without the client address is 400, like /api/search', async () => {
    const tunnel = makeApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: ['203.0.113.0/28'] } });
    for (const url of ['/api/search', '/%61pi/search', '/%61pi/cases/DFW08TA066', '/%61pi/dashboard', '/api/health']) {
      const r = await get(url, { app: tunnel, from: '203.0.113.2' });
      expect(r.status, url).toBe(400);
      expect(ErrorResponseSchema.parse(r.json).error, url).toBe('bad_request');
    }
    expect((await get('/%61pi/search', { app: tunnel, from: '203.0.113.2', headers: { 'cf-connecting-ip': '198.51.100.7' } })).status).toBe(200);
  });

  it('an absolute-form target to /api/search gets the same identity and rate-limit checks', async () => {
    const limited = makeApp({ rateLimit: { limit: 3, windowMs: 60_000 } });
    expect((await raw(limited, 'http://evil.example/api/search?q=carb')).status).toBe(200);
    expect((await raw(limited, 'HTTP://evil.example/%61pi/search?q=carb')).status).toBe(200);
    expect((await raw(limited, '/api/search?q=carb')).status).toBe(200);
    const fourth = await raw(limited, 'http://evil.example/api/search?q=carb');
    expect(fourth.status).toBe(429);
    expect(ErrorResponseSchema.parse(fourth.json).error).toBe('rate_limited');
    expect(fourth.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // Tunnel mode, the loopback socket as the connector: the API still needs the client address.
    const tunnel = makeApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: ['127.0.0.0/8'] } });
    expect((await raw(tunnel, 'http://evil.example/api/search')).status).toBe(400);
    expect((await raw(tunnel, 'http://evil.example/api/search', { 'CF-Connecting-IP': '198.51.100.8' })).status).toBe(200);
  });

  it('/%61pi/nope is a JSON 404, not the page', async () => {
    for (const url of ['/%61pi/nope', '/api/nope', '/%61pi']) {
      const r = await get(url, { headers: { accept: 'text/html' } });
      expect(r.status, url).toBe(404);
      expect(ErrorResponseSchema.parse(r.json), url).toEqual({ error: 'not_found', message: 'Not found.' });
    }
    expect((await raw(app, 'http://evil.example/%61pi/nope', { Accept: 'text/html' })).json).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('a malformed URL gets the security headers and a JSON 400', async () => {
    for (const url of ['/%E0%A4%A', '/api/%ZZ', '/api/search?q=%']) {
      const r = await get(url);
      expect(r.status, url).toBe(url.includes('?') ? 200 : 400);
      if (r.status === 400) {
        expect(ErrorResponseSchema.parse(r.json), url).toEqual({ error: 'bad_request', message: 'The request URL is not valid.' });
        expect(r.headers['content-security-policy'], url).toContain("default-src 'self'");
        expect(r.headers['cache-control'], url).toBe('no-store');
      }
    }
  });

  it('static-file refusals are 404 or 400, never 500', async () => {
    for (const url of ['/assets/app%00.js', '//api/search', '/assets/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json']) {
      const r = await get(url);
      expect(r.status, url).toBe(404);
      // The router's refusal (JSON), the 404 page (a path without an extension) or the plain 404
      // of a missing file; never a file outside the root.
      if (r.json !== null) expect(ErrorResponseSchema.parse(r.json).error, url).toBe('not_found');
      else if (!url.includes('.')) expect(r.body, url).toContain('<meta name="robots" content="noindex" />');
      else expect(r.body, url).toBe('Not found');
    }
  });

  it('static 412 and 416 pass through (416 keeps Content-Range); other refusals stay 400 or 404', async () => {
    const range = await get('/assets/app-0123abcd.js', { headers: { range: 'bytes=100-200' } });
    expect(range.status).toBe(416);
    expect(range.headers['content-range']).toBe('bytes */16');
    expect(ErrorResponseSchema.parse(range.json).error).toBe('bad_request');
    expect(range.headers['content-security-policy']).toContain("default-src 'self'");
    expect(range.headers['cache-control']).toBe('no-store');
    const precondition = await get('/assets/app-0123abcd.js', { headers: { 'if-match': '"never"' } });
    expect(precondition.status).toBe(412);
    expect(ErrorResponseSchema.parse(precondition.json).error).toBe('bad_request');
  });

  it('a silent half-open client does not outlive its parse error, and close() is not held up', async () => {
    const a = makeApp();
    await a.listen({ host: LOCAL, port: 0 });
    const { port } = a.server.address() as { port: number };
    const client = connect({ port, host: LOCAL, allowHalfOpen: true }, () => client.write('BAD\r\n\r\n'));
    client.on('error', () => undefined);
    client.resume();
    // The server closes the connection although the client never does.
    const closed = new Promise<void>((resolve) => client.on('end', () => resolve()));
    expect(await Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 3_000))])).toBe('closed');
    const started = Date.now();
    await a.close();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a request the HTTP parser refuses gets a JSON 400 with the security headers and Connection: close', async () => {
    const a = makeApp();
    await a.listen({ host: LOCAL, port: 0 });
    const { port } = a.server.address() as { port: number };
    for (const garbage of ['GET / HTTP/1.1\r\nBad Header Line\r\n\r\n', 'GET /\u0000 HTTP/1.1\r\n\r\n', '\x16\x03\x01 not http\r\n\r\n']) {
      const text = await new Promise<string>((resolve, reject) => {
        const socket = connect(port, LOCAL, () => socket.write(garbage, 'latin1'));
        let data = '';
        socket.setEncoding('utf8');
        socket.on('data', (c: string) => (data += c));
        socket.on('end', () => resolve(data));
        socket.on('close', () => resolve(data));
        socket.on('error', reject);
      });
      const [head = '', body = ''] = text.split('\r\n\r\n');
      expect(head, JSON.stringify(garbage)).toMatch(/^HTTP\/1\.1 400 /);
      expect(head.toLowerCase()).toContain('connection: close');
      expect(head.toLowerCase()).toContain("content-security-policy: default-src 'self'");
      expect(head.toLowerCase()).toContain('x-content-type-options: nosniff');
      expect(head.toLowerCase()).toContain('cache-control: no-store');
      expect(ErrorResponseSchema.parse(JSON.parse(body)).error).toBe('bad_request');
    }
  });

  it('health is rate limited for everyone but loopback, and its probe is shared for a moment', async () => {
    const limited = makeApp({ rateLimit: { limit: 2, windowMs: 60_000 } });
    const from = '192.0.2.10';
    expect((await get('/api/health', { app: limited, from })).status).toBe(200);
    expect((await get('/api/health', { app: limited, from })).status).toBe(200);
    expect((await get('/api/health', { app: limited, from })).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await get('/api/health', { app: limited })).status).toBe(200);
    // Concurrent and repeated calls within the cache window run one probe.
    let counts = 0;
    const counting = new Proxy(reader, {
      get(target, prop) {
        if (prop === 'count') {
          return (...args: Parameters<Client['count']>) => {
            counts++;
            return target.count(...args);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const probed = makeApp({ es: counting, healthCacheMs: 60_000 });
    await Promise.all(Array.from({ length: 5 }, () => get('/api/health', { app: probed })));
    for (let i = 0; i < 5; i++) await get('/api/health', { app: probed });
    expect(counts).toBe(1);
  });

  it('a search that timed out is a 503, never partial counts', async () => {
    const timingOut = new Proxy(reader, {
      get(target, prop) {
        if (prop === 'search') {
          return async (params: Parameters<Client['search']>[0]) => {
            const res = await target.search(params);
            // Only the API's limited searches (not the dataset's own stats query).
            return params && 'timeout' in params ? { ...res, timed_out: true } : res;
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const slow = makeApp({ es: timingOut as Client });
    for (const url of ['/api/search?q=carburetor', '/api/dashboard']) {
      const r = await get(url, { app: slow });
      expect(r.status, url).toBe(503);
      expect(ErrorResponseSchema.parse(r.json).error, url).toBe('unavailable');
    }
  });

  it('cross-aircraft filters match the mock API (one aircraft must satisfy every aircraft facet)', async () => {
    const corpus = buildMockCorpus(normalizeCorpus(await readFixtureTables(APP_DIR)));
    const requests: Record<string, string>[] = [
      { completion: 'any', category: 'HELI', phase: 'approach' },
      { completion: 'any', category: 'HELI', phase: 'en_route' },
      { completion: 'any', category: 'AIR', far_part: 'ARMF' },
      { completion: 'any', category: 'HELI' },
      { completion: 'any', engine: 'TS', phase: 'en_route,approach' },
    ];
    for (const query of requests) {
      const real = await search(query);
      const mock = searchCorpus(corpus, SearchRequestSchema.parse(query));
      const label = JSON.stringify(query);
      expect(real.rows.map((r) => r.ntsbNo), label).toEqual(mock.rows.map((r) => r.ntsbNo));
      expect(real.relaxations, label).toEqual(mock.relaxations);
      for (const facet of FACET_KEYS) expect(counts(real.facets[facet]), `${label} ${facet}`).toEqual(counts(mock.facets[facet]));
    }
    expect((await search({ completion: 'any', category: 'HELI', phase: 'approach' })).rows.map((r) => r.ntsbNo)).not.toContain('DCA25MA108');
  });
});

// The pages search engines and link previews read (server/routes/pages.ts, server/seo/).
describe('pages for search engines and link previews', () => {
  const ORIGIN = 'http://localhost:3000';
  const BRIEF_ID = '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f';
  const VALENTINE_TITLE =
    'Hughes OH-6 helicopter, total loss of engine power while maneuvering near Valentine, Texas (2008) · NTSB DFW08TA066 · AirCase';

  const page = (url: string, opts: { app?: FastifyInstance; from?: string; headers?: Record<string, string> } = {}) =>
    get(url, { ...opts, headers: { accept: 'text/html', ...opts.headers } });

  function headOf(r: Got) {
    const doc = parseHtml(r.body);
    const meta = (attr: 'name' | 'property', key: string) => doc.head.querySelector(`meta[${attr}="${key}"]`)?.getAttribute('content') ?? null;
    return {
      title: doc.title,
      titles: doc.querySelectorAll('title').length,
      descriptions: doc.querySelectorAll('meta[name="description"]').length,
      description: meta('name', 'description'),
      robots: meta('name', 'robots'),
      canonical: doc.head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
      ogUrl: meta('property', 'og:url'),
      ogImage: meta('property', 'og:image'),
      ld: [...doc.querySelectorAll('script[type="application/ld+json"]')].map((el) => JSON.parse(el.textContent ?? '') as unknown),
    };
  }

  const locs = (doc: MarkupDocument): string[] => [...doc.getElementsByTagName('loc')].map((l) => l.textContent ?? '');

  it('a served case page is 200 with its own head in the page HTML', async () => {
    const r = await page('/cases/DFW08TA066');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(String(r.headers['content-security-policy'])).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(r.body).toContain('<div id="root">');
    const head = headOf(r);
    expect(head).toMatchObject({
      title: VALENTINE_TITLE,
      titles: 1,
      descriptions: 1,
      description:
        "NTSB accident investigation DFW08TA066, 8 Feb 2008: N66372 (Hughes OH-6), minor injuries. Probable cause: The contract mechanic's failure to properly secure the castellated nut that attached the…",
      robots: 'index, follow',
      canonical: `${ORIGIN}/cases/DFW08TA066`,
      ogUrl: `${ORIGIN}/cases/DFW08TA066`,
      ogImage: `${ORIGIN}/social/card.png`,
    });
    expect(head.ld).toEqual([
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'AirCase', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: 'Explore', item: `${ORIGIN}/explore` },
          { '@type': 'ListItem', position: 3, name: 'DFW08TA066', item: `${ORIGIN}/cases/DFW08TA066` },
        ],
      },
    ]);
  });

  it('a number no case has is 404 with the page HTML, noindex and no canonical', async () => {
    for (const n of ['ZZZ99ZZ999', 'not-a-number', '%3Cscript%3E']) {
      const r = await page(`/cases/${n}`);
      expect(r.status, n).toBe(404);
      expect(r.body, n).toContain('<div id="root">');
      expect(headOf(r), n).toMatchObject({ robots: 'noindex', canonical: null, ogUrl: null, ld: [], description: 'No investigation has that number.' });
    }
    const hostile = await page('/cases/%3Cscript%3E');
    expect(headOf(hostile).title).toBe('NTSB <SCRIPT> · AirCase');
    expect(hostile.body).not.toContain('<SCRIPT>');
    // A record outside the default cohort keeps its indexable page.
    const other = await page('/cases/CEN23LA137');
    expect(other.status).toBe(200);
    expect(headOf(other)).toMatchObject({ robots: 'index, follow', description: expect.stringMatching(/\. Status: P$/) });
  });

  it('statuses, robots and canonicals of the other pages', async () => {
    const table: ReadonlyArray<readonly [string, number, string, string | null, string]> = [
      ['/', 200, 'index, follow', '/', 'AirCase · aviation casebook'],
      ['/explore', 200, 'index, follow', '/explore', 'Explore · AirCase'],
      ['/explore?q=carburetor+icing', 200, 'noindex, follow', '/explore', '“carburetor icing” · Explore · AirCase'],
      ['/dashboard?cohort=all', 200, 'index, follow', '/dashboard', 'The record, in questions · AirCase'],
      ['/about', 200, 'index, follow', '/about', 'About · AirCase'],
      ['/privacy', 200, 'index, follow', '/privacy', 'Privacy · AirCase'],
      ['/compare?cases=DFW08TA066,SEA08LA057', 200, 'noindex, nofollow', '/compare', 'Comparing 2 cases · AirCase'],
      ['/account', 200, 'noindex, nofollow', '/account', 'Account · AirCase'],
      [`/briefs/${BRIEF_ID}?step=2`, 200, 'noindex, nofollow', `/briefs/${BRIEF_ID}`, 'AI brief · AirCase'],
      ['/no-such-page', 404, 'noindex', null, 'Page not found · AirCase'],
      ['/index.html', 404, 'noindex', null, 'Page not found · AirCase'],
    ];
    for (const [url, status, robots, canonical, title] of table) {
      const r = await page(url);
      expect(r.status, url).toBe(status);
      expect(r.body, url).toContain('<div id="root">');
      expect(headOf(r), url).toMatchObject({ robots, canonical: canonical === null ? null : `${ORIGIN}${canonical}`, title, titles: 1, descriptions: 1 });
    }
    // The home page is a WebSite in JSON-LD; Explore has none.
    expect(headOf(await page('/')).ld).toEqual([
      { '@context': 'https://schema.org', '@type': 'WebSite', name: 'AirCase', alternateName: 'aviation casebook', url: `${ORIGIN}/` },
    ]);
    expect(headOf(await page('/explore')).ld).toEqual([]);
  });

  it('a served number not in canonical form is 301 to the canonical case path, the query dropped', async () => {
    for (const url of ['/cases/dfw08ta066', '/cases/Dfw08TA066?brief=x&step=1', '/cases/%20DFW08TA066', '/cases/DFW08TA066/', '/cases/dfw08ta066/?q=1']) {
      const r = await page(url);
      expect(r.status, url).toBe(301);
      expect(r.headers.location, url).toBe('/cases/DFW08TA066');
    }
    // An unknown number is not redirected.
    expect((await page('/cases/zzz99zz999')).status).toBe(404);
  });

  it('a page path with a trailing slash is 301 to the path without it, the query dropped', async () => {
    for (const [url, to] of [
      ['/explore/', '/explore'],
      ['/explore/?q=carburetor', '/explore'],
      ['/about/', '/about'],
      ['/compare/?cases=DFW08TA066', '/compare'],
      [`/briefs/${BRIEF_ID}/`, `/briefs/${BRIEF_ID}`],
    ] as const) {
      const r = await page(url);
      expect(r.status, url).toBe(301);
      expect(r.headers.location, url).toBe(to);
    }
    // The target is the path alone: never another host, whatever the request says.
    const absolute = await app.inject({ method: 'GET', url: '/about/', remoteAddress: LOCAL, headers: { host: 'evil.example', accept: 'text/html' } });
    expect(absolute.headers.location).toBe('/about');
    expect((await page('/')).status).toBe(200);
  });

  it('the page goes to requests that take HTML or anything, or say nothing; others get the plain 404', async () => {
    const accepts = ['text/html', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', '*/*', undefined];
    for (const [url, status] of [
      ['/explore', 200],
      ['/cases/DFW08TA066', 200],
      ['/cases/ZZZ99ZZ999', 404],
      ['/no-such-page', 404],
    ] as const) {
      for (const accept of accepts) {
        const r = await get(url, { headers: accept === undefined ? {} : { accept } });
        expect(r.status, `${url} ${accept}`).toBe(status);
        expect(r.body, `${url} ${accept}`).toContain('<div id="root">');
      }
      const json = await get(url, { headers: { accept: 'application/json' } });
      expect(json.status, url).toBe(404);
      expect(json.body, url).toBe('Not found');
      expect(json.headers['content-type'], url).toBe('text/plain; charset=utf-8');
    }
    // A path with a file extension that no route serves is the plain 404, whatever it accepts.
    expect((await page('/missing.png')).body).toBe('Not found');
    // HEAD gets the same status and type (Node's HTTP server sends no body for HEAD).
    for (const [url, status] of [
      ['/cases/DFW08TA066', 200],
      ['/cases/ZZZ99ZZ999', 404],
      ['/explore', 200],
      ['/no-such-page', 404],
    ] as const) {
      const r = await app.inject({ method: 'HEAD', url, remoteAddress: LOCAL });
      expect(r.statusCode, url).toBe(status);
      expect(r.headers['content-type'], url).toBe('text/html; charset=utf-8');
    }
  });

  it('case pages count against the API’s rate limit and need a network identity; other pages do not', async () => {
    const limited = makeApp({ rateLimit: { limit: 3, windowMs: 60_000 } });
    expect((await page('/cases/DFW08TA066', { app: limited })).status).toBe(200);
    expect((await get('/api/cases/DFW08TA066', { app: limited })).status).toBe(200);
    expect((await page('/cases/ZZZ99ZZ999', { app: limited })).status).toBe(404);
    const refused = await page('/cases/DFW08TA066', { app: limited });
    expect(refused.status).toBe(429);
    const body = ErrorResponseSchema.parse(refused.json);
    expect(body.error).toBe('rate_limited');
    expect(refused.headers['retry-after']).toBe(String(body.retryAfter));
    expect(refused.headers['cache-control']).toBe('no-store');
    expect((await get('/api/cases/DFW08TA066', { app: limited })).status).toBe(429);
    expect((await get('/sitemap.xml', { app: limited })).status).toBe(429);
    // The other pages, robots.txt and the files are not limited.
    for (const url of ['/', '/explore?q=carb', '/about', '/no-such-page', '/robots.txt', '/assets/app-0123abcd.js']) {
      expect((await page(url, { app: limited })).status, url).toBeLessThan(429);
    }
    // Tunnel mode: the case page needs the client address, like the API; the other pages do not.
    const tunnel = makeApp({ config: { appUrl: 'https://casebook.example', trustedProxyCidrs: ['203.0.113.0/28'] } });
    const anonymous = await page('/cases/DFW08TA066', { app: tunnel, from: '203.0.113.2' });
    expect(anonymous.status).toBe(400);
    expect(ErrorResponseSchema.parse(anonymous.json).error).toBe('bad_request');
    expect((await page('/cases/DFW08TA066', { app: tunnel, from: '203.0.113.2', headers: { 'cf-connecting-ip': '198.51.100.9' } })).status).toBe(200);
    expect((await page('/explore', { app: tunnel, from: '203.0.113.2' })).status).toBe(200);
  });

  it('X-Robots-Tag: outside live every response is noindex, nofollow; on live the API is noindex', async () => {
    for (const url of ['/', '/cases/DFW08TA066', '/cases/dfw08ta066', '/no-such-page', '/api/config', '/api/nope', '/assets/app-0123abcd.js', '/missing.js', '/robots.txt', '/sitemap.xml', '/%E0%A4%A']) {
      expect((await page(url)).headers['x-robots-tag'], url).toBe('noindex, nofollow');
    }
    const live = makeApp({ config: { appUrl: 'https://aircase.example', trustedProxyCidrs: [], appEnv: 'live' } });
    for (const url of ['/api/config', '/api/nope', '/api/cases/DFW08TA066', '/%61pi/nope', '/api/%ZZ']) {
      expect((await page(url, { app: live })).headers['x-robots-tag'], url).toBe('noindex');
    }
    for (const url of ['/', '/cases/DFW08TA066', '/explore?q=carb', '/no-such-page', '/assets/app-0123abcd.js', '/robots.txt', '/sitemap.xml']) {
      expect((await page(url, { app: live })).headers['x-robots-tag'], url).toBeUndefined();
    }
  });

  it('robots.txt keeps crawlers out outside live, and on live points them to the sitemap', async () => {
    const dev = await get('/robots.txt');
    expect(dev.status).toBe(200);
    expect(dev.body).toBe('User-agent: *\nDisallow: /\n');
    expect(dev.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(dev.headers['cache-control']).toBe('public, max-age=3600');
    const live = makeApp({ config: { appUrl: 'https://aircase.example', trustedProxyCidrs: [], appEnv: 'live' } });
    expect((await get('/robots.txt', { app: live })).body).toBe('User-agent: *\nAllow: /\n\nSitemap: https://aircase.example/sitemap.xml\n');
  });

  it('the sitemaps list the pages and the canonical page of every case in the default cohort, with the snapshot date', async () => {
    const config = ConfigResponseSchema.parse((await get('/api/config')).json);
    const g = dataset.generationId;
    const cohort = ((await appDb.execute(sql`select ntsb_no from cases where generation_id = ${g} and is_us and answer_eligible`)).rows as { ntsb_no: string }[])
      .map((r) => r.ntsb_no)
      .sort();
    const [{ total } = { total: 0 }] = (await appDb.execute(sql`select count(*)::int as total from cases where generation_id = ${g}`)).rows as { total: number }[];
    // The fixtures hold other records too (other statuses, other countries): they are not listed.
    expect(cohort.length).toBeGreaterThan(5);
    expect(total).toBeGreaterThan(cohort.length);

    const index = await get('/sitemap.xml');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(index.headers['cache-control']).toBe('public, max-age=3600');
    expect(locs(parseXml(index.body))).toEqual([`${ORIGIN}/sitemaps/pages.xml`, `${ORIGIN}/sitemaps/cases-1.xml`]);
    expect(locs(parseXml((await get('/sitemaps/pages.xml')).body))).toEqual(['/', '/explore', '/dashboard', '/about', '/privacy'].map((p) => `${ORIGIN}${p}`));
    const cases = await get('/sitemaps/cases-1.xml');
    expect(cases.headers['content-type']).toBe('application/xml; charset=utf-8');
    const doc = parseXml(cases.body);
    expect(locs(doc)).toEqual(cohort.map((n) => `${ORIGIN}/cases/${n}`));
    expect(new Set([...doc.getElementsByTagName('lastmod')].map((l) => l.textContent))).toEqual(new Set([config.snapshotDate]));
    // Every listed address is the canonical, served page.
    for (const n of cohort) expect((await page(`/cases/${n}`)).status, n).toBe(200);
    for (const url of ['/sitemaps/cases-2.xml', '/sitemaps/cases-0.xml', '/sitemaps/other.xml']) expect((await get(url)).status, url).toBe(404);

    // Files of at most `sitemapUrlLimit` URLs (10,000 by default).
    const small = makeApp({ sitemapUrlLimit: 5 });
    const files = Math.ceil(cohort.length / 5);
    expect(locs(parseXml((await get('/sitemap.xml', { app: small })).body))).toHaveLength(1 + files);
    const chunks: string[] = [];
    for (let n = 1; n <= files; n++) chunks.push(...locs(parseXml((await get(`/sitemaps/cases-${n}.xml`, { app: small })).body)));
    expect(chunks).toEqual(cohort.map((n) => `${ORIGIN}/cases/${n}`));
    expect((await get(`/sitemaps/cases-${files + 1}.xml`, { app: small })).status).toBe(404);
  });

  it('while no dataset can be served, the index lists the pages only, case sitemaps are 404 and case pages 503', async () => {
    const mapping = await es.indices.getMapping({ index: dataset.casesIndex });
    const current = mapping[dataset.casesIndex]?.mappings._meta ?? {};
    try {
      // A fingerprint this server does not serve: the dataset is unavailable (server/dataset.ts).
      await es.indices.putMapping({ index: dataset.casesIndex, _meta: { ...current, fingerprint: 'not-a-servable-fingerprint' } });
      const broken = makeApp();
      const index = await get('/sitemap.xml', { app: broken });
      expect(index.status).toBe(200);
      expect(locs(parseXml(index.body))).toEqual([`${ORIGIN}/sitemaps/pages.xml`]);
      expect((await get('/sitemaps/pages.xml', { app: broken })).status).toBe(200);
      expect((await get('/sitemaps/cases-1.xml', { app: broken })).status).toBe(404);
      // A case page keeps the API's error contract.
      const unavailable = await page('/cases/DFW08TA066', { app: broken });
      expect(unavailable.status).toBe(503);
      expect(ErrorResponseSchema.parse(unavailable.json).error).toBe('unavailable');
      // Pages without data are still served.
      expect((await page('/explore', { app: broken })).status).toBe(200);
    } finally {
      await es.indices.putMapping({ index: dataset.casesIndex, _meta: current });
    }
    expect((await get('/sitemaps/cases-1.xml', { app: makeApp() })).status).toBe(200);
  });
});

describe('an earlier cases index version', () => {
  it('serves a cases-v2 index (same fields, older analysis) and refuses a fingerprint mismatch', async () => {
    const mapping = await es.indices.getMapping({ index: dataset.casesIndex });
    const current = mapping[dataset.casesIndex]?.mappings._meta ?? {};
    const v2 = { ...current, index_version: 'cases-v2', fingerprint: EARLIER_SERVABLE_CASES_VERSIONS['cases-v2'] };
    try {
      // Each new app resolves the manifest and reads the index _meta afresh.
      await es.indices.putMapping({ index: dataset.casesIndex, _meta: v2 });
      const served = await get('/api/config', { app: makeApp() });
      expect(served.status, served.body).toBe(200);
      expect(ConfigResponseSchema.parse(served.json).datasetRevision).toMatch(new RegExp(`^g${dataset.generationId}-cases-v2-[0-9a-f]{8}$`));
      const found = await get('/api/search?q=carburetor%20icing', { app: makeApp() });
      expect(found.status, found.body).toBe(200);
      expect(SearchResponseSchema.parse(found.json).total).toBe(7);
      await es.indices.putMapping({ index: dataset.casesIndex, _meta: { ...v2, fingerprint: casesIndexFingerprint() } });
      expect((await get('/api/config', { app: makeApp() })).status).toBe(503);
    } finally {
      await es.indices.putMapping({ index: dataset.casesIndex, _meta: current });
    }
    expect((await get('/api/config', { app: makeApp() })).status).toBe(200);
  });
});

// Last: it deletes the active cases index.
describe('a lost index', () => {
  it('makes the API unavailable (503), never a 404 or an internal message', async () => {
    const fresh = makeApp();
    expect((await get('/api/config', { app: fresh })).status).toBe(200);
    await es.indices.delete({ index: dataset.casesIndex });
    for (const a of [app, fresh, makeApp()]) {
      const r = await get('/api/search?q=carburetor', { app: a });
      expect(r.status).toBe(503);
      expect(ErrorResponseSchema.parse(r.json).error).toBe('unavailable');
      expect(r.body).not.toContain(dataset.casesIndex);
    }
    // A fresh app: health results are shared for a couple of seconds.
    expect((await get('/api/health', { app: makeApp() })).json).toMatchObject({ status: 'unavailable', search: 'no_dataset' });
  });
});
