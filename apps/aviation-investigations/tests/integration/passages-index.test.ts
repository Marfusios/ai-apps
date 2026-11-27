import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Client, estypes } from '@elastic/elasticsearch';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { activePins } from '../../server/db/generations.js';
import type { CaseRecord } from '../../server/db/queries/case-records.js';
import { embeddingCache, passages as passagesTable } from '../../server/db/schema/index.js';
import { SPEND_LOCK_KEY } from '../../server/quota/policy.js';
import type { QuotaBudgets } from '../../server/quota/policy.js';
import { aliasTargets } from '../../worker/index/aliases.js';
import { GenerationNotIndexableError } from '../../worker/index/cases-index.js';
import { createFakeEmbedder, fakeVector, type Embedder } from '../../worker/index/embed.js';
import { embeddingCacheKey, storeEmbeddings } from '../../worker/index/embedding-cache.js';
import { buildCasePassages, type CasePassage } from '../../worker/index/passages.js';
import {
  CacheIncompleteError,
  CostNotConfirmedError,
  PASSAGES_EMBEDDING_DIMS,
  passagesAlias,
  planPassages,
  rebuildPassagesIndex,
  type PassageDoc,
  type PassagesIndexReport,
} from '../../worker/index/passages-index.js';
import { SpendRefusedError, createLedgerSpendGate, createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { loadFromExtract } from '../../worker/ingest/load.js';
import { TABLE_NAMES } from '../../worker/ingest/tables.js';
import { fixtureCaseRecords } from '../support/case-records.js';
import { editTable, makeExtractDir, removeDir } from '../support/extract-dir.js';
import { count, evIdOf, loadVerified, sqlState } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetControls, resetCorpus, testDb, testDbUrl, testEs, testEsApiKey, testPool } from './helpers.js';

const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const ALIAS = passagesAlias(PREFIX);
const DIMS = PASSAGES_EMBEDDING_DIMS;
/** Fixture cases that must never get passages: foreign, in progress, blank status, completed without cause. */
const EXCLUDED = ['ENG08WA029', 'CEN23LA137', 'CEN22LA442', 'ENG10WA034'];
const BUDGETS: QuotaBudgets = { monthlyUsd: 100, interactiveMonthlyUsd: 80, interactiveDailyUsd: 3, ingestionMonthlyUsd: 20, anonymousShare: 0.25 };

/** A build holds the build lock, the snapshot stream and a writer at once: a pool of 4. */
let ingest: Db;
let migrator: Db;
let app: Db;
let es: Client;
let fixtureDir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-passages-test-'));
const tempDirs: string[] = [];
let generationId: number;
let offline: Map<string, CaseRecord>;
let expected: CasePassage[];
let unique: number;
let eligible: string[];
let built: PassagesIndexReport;

const total = (r: estypes.SearchResponse) => (typeof r.hits.total === 'number' ? r.hits.total : (r.hits.total?.value ?? -1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ownIndices(): Promise<string[]> {
  // Index-level API: the writer key has no cluster privilege, so `_cat/indices` is refused.
  const found = await es.indices.get({ index: `${PREFIX}-*`, expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: true });
  return Object.keys(found).sort();
}

async function resetCache(): Promise<void> {
  const pool = testPool('migrator');
  try {
    await pool.query('TRUNCATE "embedding_cache"');
  } finally {
    await pool.end();
  }
}

/** Remove one cached vector (the migrator owns the table; the ingest role cannot delete). */
async function dropCachedVector(): Promise<string> {
  const pool = testPool('migrator');
  try {
    const r = await pool.query<{ cache_key: string }>('delete from embedding_cache where cache_key = (select min(cache_key) from embedding_cache) returning cache_key');
    const key = r.rows[0]?.cache_key;
    if (!key) throw new Error('the cache is empty');
    return key;
  } finally {
    await pool.end();
  }
}

const run = promisify(execFile);
const APP_DIR = resolve(import.meta.dirname, '../..');

/** `pnpm worker …` as a child process against aviation_test and this file's index prefix only. */
async function worker(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run(resolve(APP_DIR, 'node_modules/.bin/tsx'), ['worker/cli.ts', ...args], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      // Nonempty process values win over .env.local: only the test environment is reached.
      DATABASE_URL: testDbUrl('app'),
      DATABASE_INGEST_URL: testDbUrl('ingest'),
      ELASTICSEARCH_READ_API_KEY: testEsApiKey('read'),
      ELASTICSEARCH_WRITE_API_KEY: testEsApiKey('write'),
      ELASTICSEARCH_INDEX_PREFIX: PREFIX,
      OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small',
      OPENAI_EMBEDDING_DIMENSIONS: String(DIMS),
    },
  });
}

const build = (embedder: Embedder, over: Partial<Parameters<typeof rebuildPassagesIndex>[3]> = {}) =>
  rebuildPassagesIndex(es, ingest, embedder, {
    generationId,
    prefix: PREFIX,
    gate: createMemorySpendGate(20),
    confirmCost: true,
    windowSize: 25,
    ...over,
  });

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

/** A session of its own (two-session tests). */
async function session(role: 'ingest' | 'migrator' = 'ingest'): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: testDbUrl(role), application_name: 'aviation-test-session' });
  await c.connect();
  return c;
}

/** Wait until `pid` is blocked on a lock; fails with the query's outcome if it finished instead. */
async function waitForLockWait(observer: pg.Client, pid: number, query: Promise<unknown>): Promise<void> {
  let settled: string | undefined;
  query.then(
    (v) => (settled = `finished: ${JSON.stringify(v)}`),
    (e: unknown) => (settled = `failed: ${String(e)}`),
  );
  for (let i = 0; i < 200; i += 1) {
    if (settled) throw new Error(`session ${pid} did not wait for a lock (${settled})`);
    // pg_locks, not pg_stat_activity: the group role a login acts as cannot see the login's other sessions there.
    const r = await observer.query<{ waiting: boolean }>(`select exists (select 1 from pg_locks where pid = $1 and not granted) as waiting`, [pid]);
    if (r.rows[0]?.waiting) return;
    await sleep(25);
  }
  throw new Error(`session ${pid} never waited for a lock`);
}

beforeAll(async () => {
  await resetCorpus();
  await resetCache();
  ingest = createDb(testDbUrl('ingest'), { max: 4, applicationName: 'aviation-test-passages' });
  migrator = testDb('migrator');
  app = testDb('app');
  es = testEs();
  fixtureDir = await makeExtractDir();
  generationId = await loadVerified(ingest, fixtureDir, reportDir);
  offline = await fixtureCaseRecords(generationId);
  const records = [...offline.values()].filter((r) => r.answerEligible).sort((a, b) => a.ntsbNo.localeCompare(b.ntsbNo));
  eligible = records.map((r) => r.ntsbNo);
  expected = records.flatMap((r) => buildCasePassages(r).passages);
  unique = new Set(expected.map((p) => p.input)).size;
}, 120_000);

afterAll(async () => {
  for (const index of await ownIndices()) await es.indices.delete({ index });
  await Promise.all([closeDb(ingest), closeDb(migrator), closeDb(app)]);
  for (const d of [fixtureDir, reportDir, ...tempDirs]) removeDir(d);
});

describe('planPassages (dry run)', () => {
  it('counts and prices every passage without writing anything', async () => {
    const plan = await planPassages(ingest, {
      generationId,
      embedding: { model: 'text-embedding-3-small', dims: DIMS, usdPerMillionTokens: 0.02 },
      batchSize: 4,
    });
    expect(plan).toMatchObject({
      generationId,
      usCases: 15,
      answerEligibleCases: eligible.length,
      casesWithPassages: eligible.length,
      passages: expected.length,
      eventScoped: expected.filter((p) => p.scope === 'event').length,
      continuations: 0,
      uniqueInputs: unique,
      duplicateInputs: expected.length - unique,
      cache: { available: true, hits: 0, hitTokens: 0 },
      toEmbed: { inputs: unique, requests: 1 },
    });
    expect(plan.tokens.input).toBe(expected.reduce((n, p) => n + p.inputTokens, 0));
    expect(plan.tokens.text).toBe(expected.reduce((n, p) => n + p.tokens, 0));
    expect(plan.tokens.overlap).toBe(expected.reduce((n, p) => n + p.overlapTokens, 0));
    expect(plan.tokens.overlap).toBeGreaterThan(0);
    expect(plan.tokens.header).toBe(plan.tokens.input - plan.tokens.text);
    expect(plan.estimatedUsd).toBeCloseTo((plan.toEmbed.tokens * 0.02) / 1e6, 12);
    expect(plan.inputTokenPercentiles.max).toBeLessThanOrEqual(8192);
    expect(await count(ingest, sql`select count(*) from passages`)).toBe(0);
    expect(await count(ingest, sql`select count(*) from embedding_cache`)).toBe(0);
    expect(await activePins(ingest, generationId)).toEqual([]);
  });

  it('refuses a generation that is not verified', async () => {
    const loaded = await loadFromExtract(ingest, await onlyEvent('NYC08LA106'));
    await expect(
      planPassages(ingest, { generationId: loaded.generationId, embedding: { model: 'm', dims: DIMS, usdPerMillionTokens: 0 } }),
    ).rejects.toBeInstanceOf(GenerationNotIndexableError);
  });
});

describe('rebuildPassagesIndex', () => {
  it('refuses without --confirm-cost: no embedding call, no index, no rows, no pin left', async () => {
    const fake = createFakeEmbedder(DIMS);
    const err = await build(fake, { confirmCost: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostNotConfirmedError);
    expect((err as CostNotConfirmedError).plan.passages).toBe(expected.length);
    expect(fake.calls).toEqual([]);
    expect(await ownIndices()).toEqual([]);
    expect(await count(ingest, sql`select count(*) from passages`)).toBe(0);
    expect(await activePins(ingest, generationId)).toEqual([]);
  });

  it('refuses when the reservations exceed the remaining indexing budget', async () => {
    const priced: Embedder & { calls: string[][] } = { ...createFakeEmbedder(DIMS), usdPerMillionTokens: 0.02 };
    await expect(build(priced, { gate: createMemorySpendGate(0) })).rejects.toBeInstanceOf(SpendRefusedError);
    expect(priced.calls).toEqual([]);
    expect(await ownIndices()).toEqual([]);
  });

  it('refuses a pool too small for the build', async () => {
    const small = testDb('ingest');
    try {
      await expect(rebuildPassagesIndex(es, small, createFakeEmbedder(DIMS), { generationId, prefix: PREFIX, gate: createMemorySpendGate(1), confirmCost: true })).rejects.toThrow(
        /pool of at least 3/,
      );
    } finally {
      await closeDb(small);
    }
  });

  it('builds the index from answer-eligible US cases only, with a fake embedder', async () => {
    const fake = createFakeEmbedder(DIMS);
    built = await build(fake);
    expect(built).toMatchObject({
      passages: expected.length,
      passagesAlreadyStored: 0,
      cacheHits: 0,
      deduplicated: expected.length - unique,
      embedded: { inputs: unique },
      aliasVerified: true,
    });
    expect(built.attemptId).not.toBeNull();
    expect(fake.calls.flat()).toHaveLength(unique);
    for (const call of fake.calls) expect(call.length).toBeLessThanOrEqual(96);
    // Requests have the plan's boundaries (windows of 25 passages do not split them).
    expect(built.embedded.requests).toBe(built.plan.toEmbed.requests);
    expect(built.embedded.tokens).toBe(built.plan.toEmbed.tokens);
    expect(await aliasTargets(es, ALIAS)).toEqual([built.index]);
    expect(built.index).toMatch(new RegExp(`^${PREFIX}-passages-v2-g${generationId}-\\d{17}-${built.buildId}$`));
    // The build's pin (index-build:<id>, no expiry) is gone once it has finished.
    expect(await activePins(ingest, generationId)).toEqual([]);
    const rec = await ingest.$client.query('select generation_id, alias, deleted_at from index_builds where build_id = $1', [built.buildId]);
    expect(rec.rows).toEqual([{ generation_id: String(generationId), alias: ALIAS, deleted_at: null }]);

    const res = await es.search<PassageDoc>({
      index: ALIAS,
      size: 0,
      track_total_hits: true,
      aggs: { cases: { terms: { field: 'ntsb_no', size: 100 } } },
    });
    expect(total(res)).toBe(expected.length);
    const cases = (res.aggregations!.cases as estypes.AggregationsStringTermsAggregate).buckets as estypes.AggregationsStringTermsBucket[];
    expect(cases.map((b) => b.key).sort()).toEqual(eligible);
    for (const no of EXCLUDED) expect(eligible).not.toContain(no);
    expect((await es.count({ index: ALIAS, query: { term: { answer_eligible: false } } })).count).toBe(0);

    const rows = await ingest.select().from(passagesTable).where(eq(passagesTable.generationId, generationId));
    expect(rows.map((r) => r.passageId).sort()).toEqual(expected.map((p) => p.passageId).sort());
    expect(await count(ingest, sql`select count(*) from embedding_cache`)).toBe(unique);
  });

  it('stores vectors out of _source in an int8 HNSW cosine field and finds them with kNN', async () => {
    const mapping = await es.indices.getMapping({ index: built.index });
    expect(mapping[built.index]?.mappings.properties?.embedding).toMatchObject({
      type: 'dense_vector',
      dims: DIMS,
      similarity: 'cosine',
      index_options: { type: 'int8_hnsw' },
    });
    expect(mapping[built.index]?.mappings._meta).toMatchObject({ generation_id: generationId, chunker_version: 'chunk-v2', build_id: built.buildId });
    const target = expected.find((p) => p.ntsbNo === 'NYC08LA106' && p.kind === 'probable_cause') as CasePassage;
    const doc = await es.get<PassageDoc>({ index: built.index, id: target.passageId });
    expect(doc._source).not.toHaveProperty('embedding');
    expect(doc._source?.text).toBe(target.text);
    const knn = await es.search<PassageDoc>({
      index: built.index,
      knn: { field: 'embedding', query_vector: Array.from(fakeVector(target.input, DIMS)), k: 3, num_candidates: 50 },
      _source: ['passage_id'],
    });
    expect(knn.hits.hits[0]?._id).toBe(target.passageId);
  });

  it('keeps event-scoped passages out of nested aircraft filters by construction', async () => {
    const dca = await es.search<PassageDoc>({ index: built.index, query: { term: { ntsb_no: 'DCA25MA108' } }, size: 20 });
    expect(dca.hits.hits.length).toBeGreaterThan(0);
    for (const h of dca.hits.hits) {
      expect(h._source).toMatchObject({
        scope: 'event',
        aircraft_specific: false,
        aircraft_key: null,
        aircraft: [],
        event_aircraft_count: 2,
        event_aircraft_complete: true,
      });
      expect(h._source?.event_aircraft.map((a) => a.make)).toEqual(['BOMBARDIER INC', 'SIKORSKY']);
    }
    const mapping = await es.indices.getMapping({ index: built.index });
    expect(mapping[built.index]?.mappings.properties?.event_aircraft).toMatchObject({ type: 'nested' });
    expect(mapping[built.index]?.mappings._meta).toMatchObject({ index_version: 'passages-v2', input_template_version: 'input-v1' });
    // A nested aircraft filter alone, without any aircraft_specific clause.
    const byMake = (make: string) =>
      es.search<PassageDoc>({
        index: built.index,
        size: 100,
        _source: ['ntsb_no'],
        query: { nested: { path: 'aircraft', query: { term: { 'aircraft.make': make } } } },
      });
    expect(total(await byMake('sikorsky'))).toBe(0);
    // WPR15FA010 (a Cessna 170B and a Savannah) has only event-scoped passages.
    expect([...new Set((await byMake('cessna')).hits.hits.map((h) => h._source?.ntsb_no))].sort()).toEqual(['CEN20LA361', 'DEN08LA103']);
    // The event's aircraft stay findable as event facts, each one whole (nested).
    const eventMake = (make: string, far: string) =>
      es.search({
        index: built.index,
        size: 0,
        track_total_hits: true,
        query: { nested: { path: 'event_aircraft', query: { bool: { filter: [{ term: { 'event_aircraft.make': make } }, { term: { 'event_aircraft.far_part': far } }] } } } },
      });
    expect(total(await eventMake('sikorsky', 'ARMF'))).toBeGreaterThan(0);
    // The helicopter is not Part 121: a flattened object would have matched this.
    expect(total(await eventMake('sikorsky', '121'))).toBe(0);
  });

  it('reuses cached embeddings: a rebuild makes no embedding call', async () => {
    const second = createFakeEmbedder(DIMS);
    const report = await build(second);
    expect(second.calls).toEqual([]);
    expect(report).toMatchObject({
      passages: expected.length,
      passagesAlreadyStored: expected.length,
      cacheHits: unique,
      deduplicated: expected.length - unique,
      embedded: { inputs: 0, tokens: 0, requests: 0 },
      plan: { cache: { available: true, hits: unique }, toEmbed: { inputs: 0, tokens: 0 } },
    });
    expect(report.previousIndices).toEqual([built.index]);
    expect(await aliasTargets(es, ALIAS)).toEqual([report.index]);
    const target = expected[0] as CasePassage;
    const vector = async (index: string) =>
      (await es.search({ index, query: { ids: { values: [target.passageId] } }, _source: false, fields: ['embedding'] })).hits.hits[0]
        ?.fields?.embedding as number[];
    const a = await vector(built.index);
    expect(a).toHaveLength(DIMS);
    expect(await vector(report.index)).toEqual(a);
  });

  it('cache only: builds from embedding_cache with no embedder call, no confirmation and no budget', async () => {
    const fake = createFakeEmbedder(DIMS);
    const report = await build(fake, { cacheOnly: true, confirmCost: false, gate: createMemorySpendGate(0) });
    expect(fake.calls).toEqual([]);
    expect(report).toMatchObject({
      cacheOnly: true,
      passages: expected.length,
      cacheHits: unique,
      embedded: { inputs: 0, tokens: 0, requests: 0, usd: 0 },
      plan: { toEmbed: { inputs: 0, tokens: 0, requests: 0 }, estimatedUsd: 0, reservationUsd: 0 },
    });
    expect(await aliasTargets(es, ALIAS)).toEqual([report.index]);
  });

  it('cache only: vectors cached for the unchanged input-v1 inputs (as the v1 build left them) serve every passage', async () => {
    await resetCache();
    const model = 'fake-embedding-v1';
    const byKey = new Map(expected.map((p) => [embeddingCacheKey({ input: p.input, model, dims: DIMS, templateVersion: 'input-v1' }), p.input]));
    await storeEmbeddings(ingest, [...byKey].map(([key, input]) => ({ key, vector: fakeVector(input, DIMS) })), model, DIMS, 'input-v1');
    const plan = await planPassages(ingest, { generationId, embedding: { model, dims: DIMS, usdPerMillionTokens: 0.02 } });
    expect(plan).toMatchObject({ cache: { available: true, hits: unique }, toEmbed: { inputs: 0, tokens: 0, requests: 0 }, estimatedUsd: 0 });
    const fake = createFakeEmbedder(DIMS);
    const report = await build(fake, { cacheOnly: true, confirmCost: false, gate: createMemorySpendGate(0) });
    expect(fake.calls).toEqual([]);
    expect(report.cacheHits).toBe(unique);
  });

  it('cache only: one missing input stops the build before any index, without calling the embedder', async () => {
    await dropCachedVector();
    const indices = await ownIndices();
    const target = await aliasTargets(es, ALIAS);
    const fake = createFakeEmbedder(DIMS);
    const err = await build(fake, { cacheOnly: true, confirmCost: false, gate: createMemorySpendGate(0) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CacheIncompleteError);
    expect((err as CacheIncompleteError).plan.toEmbed.inputs).toBe(1);
    expect(String(err)).toMatch(/1 of \d+ embedding inputs are not in embedding_cache/);
    expect(fake.calls).toEqual([]);
    expect(await ownIndices()).toEqual(indices);
    expect(await aliasTargets(es, ALIAS)).toEqual(target);
    expect(await activePins(ingest, generationId)).toEqual([]);
    // A paid build would embed exactly that input; it also restores the cache for the tests below.
    const paid = createFakeEmbedder(DIMS);
    await build(paid);
    expect(paid.calls.flat()).toHaveLength(1);
  });

  it('misses the cache for another model (the key covers model and template)', async () => {
    const plan = await planPassages(ingest, { generationId, embedding: { model: 'fake-embedding-v2', dims: DIMS, usdPerMillionTokens: 0 } });
    expect(plan.cache.hits).toBe(0);
    expect(plan.toEmbed.inputs).toBe(plan.uniqueInputs);
  });

  it('runs one build per generation at a time', async () => {
    let inner: unknown;
    await build(createFakeEmbedder(DIMS), {
      afterPin: async () => {
        inner = await build(createFakeEmbedder(DIMS)).catch((e: unknown) => e);
      },
    });
    expect(String(inner)).toMatch(/another passages build of generation \d+ is running/);
  });
});

describe('worker index passages (CLI)', () => {
  it('the dry run reports 0 to embed, --cache-only builds without an OpenAI client, and a missing input fails it', async () => {
    // Vectors cached under the configured model name (fake values), as a paid build leaves them.
    await build(createFakeEmbedder(DIMS, 'text-embedding-3-small'));
    const id = String(generationId);
    const dry = await worker('index', 'passages', '--generation', id);
    expect(dry.stdout).toMatch(/^to embed: 0 inputs, 0 tokens, 0 requests \(every input is cached/m);
    expect(dry.stdout).toMatch(/0 to embed: run with --cache-only/);
    expect(dry.stdout).toMatch(/^event aircraft sets \(checked against case_aircraft\): 3 events complete/m);

    const before = await aliasTargets(es, ALIAS);
    const built = await worker('index', 'passages', '--generation', id, '--cache-only');
    expect(built.stdout).toMatch(/^mode: cache only \(no embedder; nothing paid\)$/m);
    expect(built.stdout).toMatch(/^embedded: 0 inputs, 0 tokens, 0 requests, \$0\.0000$/m);
    const after = await aliasTargets(es, ALIAS);
    expect(after).not.toEqual(before);
    expect(after[0]).toMatch(new RegExp(`^${PREFIX}-passages-v2-g${id}-`));

    await expect(worker('index', 'passages', '--generation', id, '--cache-only', '--confirm-cost')).rejects.toMatchObject({ code: 2 });
    // Remove every vector of the configured model but one: the cache-only build stops, paying nothing.
    const pool = testPool('migrator');
    try {
      await pool.query(`delete from embedding_cache where model = 'text-embedding-3-small' and cache_key <> (select min(cache_key) from embedding_cache where model = 'text-embedding-3-small')`);
    } finally {
      await pool.end();
    }
    const failed = await worker('index', 'passages', '--generation', id, '--cache-only').catch((e: unknown) => e as { code: number; stderr: string });
    expect(failed).toMatchObject({ code: 1 });
    expect((failed as { stderr: string }).stderr).toMatch(/embedding inputs are not in embedding_cache .*a cache-only build embeds nothing and stops/);
    expect(await aliasTargets(es, ALIAS)).toEqual(after);
  }, 120_000);
});

describe('passages table', () => {
  it('is immutable and deleted only with its generation', async () => {
    expect(await sqlState(migrator.execute(sql`update passages set part = part`))).toBe('55000');
    expect(await sqlState(migrator.execute(sql`delete from passages where generation_id = ${generationId}`))).toBe('55000');
    expect(await sqlState(ingest.execute(sql`update passages set part = part`))).toBe('42501');
    expect(await sqlState(ingest.execute(sql`delete from passages`))).toBe('42501');
  });

  async function sampleRow() {
    const [row] = await ingest
      .select()
      .from(passagesTable)
      .where(and(eq(passagesTable.generationId, generationId), eq(passagesTable.ntsbNo, 'NYC08LA106')))
      .limit(1);
    if (!row) throw new Error('no passage row');
    return row;
  }

  it('accepts only rows matching a section of an answer-eligible US case in a verified generation', async () => {
    const row = await sampleRow();
    const fresh = (over: Partial<typeof row>) => ({ ...row, passageId: randomBytes(32).toString('hex'), ...over });
    const insert = (over: Partial<typeof row>) => ingest.insert(passagesTable).values(fresh(over));
    expect(await sqlState(insert({ revisionId: 'f'.repeat(64) }))).toBe('23514');
    expect(await sqlState(insert({ scope: 'event', aircraftKey: null, aircraftSpecific: false }))).toBe('23514');
    expect(await sqlState(insert({ aircraftSpecific: false }))).toBe('23514');
    const foreign = (await ingest.execute(sql`select section_id, revision_id, sha256 from case_sections
      where generation_id = ${generationId} and ntsb_no = 'ENG08WA029' limit 1`)).rows[0] as Record<string, string>;
    expect(
      await sqlState(
        insert({ ntsbNo: 'ENG08WA029', sectionId: foreign.section_id, revisionId: foreign.revision_id, sectionSha: foreign.sha256 }),
      ),
    ).toBe('23514');
    const loaded = await loadFromExtract(ingest, await onlyEvent('NYC08LA106'));
    expect(await sqlState(insert({ generationId: loaded.generationId }))).toBe('55000');
    expect(await sqlState(insert({}))).toBeUndefined();
  });

  it('rejects offsets past the end of the section text (UTF-16 units)', async () => {
    const row = await sampleRow();
    const r = (await ingest.execute(sql`select char_length(text) as n,
        char_length(regexp_replace(text, '[^\\U00010000-\\U0010FFFF]', '', 'g')) as astral
      from case_sections where generation_id = ${generationId} and section_id = ${row.sectionId}`)).rows[0] as { n: number; astral: number };
    const units = Number(r.n) + Number(r.astral);
    const insert = (start: number, end: number) =>
      ingest.insert(passagesTable).values({ ...row, passageId: randomBytes(32).toString('hex'), start, end });
    expect(await sqlState(insert(0, units + 1))).toBe('23514');
    expect(await sqlState(insert(units - 1, units))).toBeUndefined();
    // The UTF-16 length counts an astral character twice.
    const astral = (await ingest.execute(sql`select char_length(regexp_replace('a\u{1F600}b\u{1D400}', '[^\\U00010000-\\U0010FFFF]', '', 'g')) as n`)).rows[0] as { n: number };
    expect(Number(astral.n)).toBe(2);
  });

  it('is readable by the app role, which cannot read cached vectors', async () => {
    expect(await count(app, sql`select count(*) from passages`)).toBeGreaterThan(0);
    expect(await sqlState(app.select().from(embeddingCache).limit(1))).toBe('42501');
  });

  it('holds the generation against pruning while a passage insert is open (two sessions)', async () => {
    const other = await loadVerified(ingest, await onlyEvent('NYC08LA106'), reportDir);
    const [row] = await ingest
      .select()
      .from(passagesTable)
      .where(and(eq(passagesTable.generationId, generationId), eq(passagesTable.ntsbNo, 'NYC08LA106')))
      .limit(1);
    if (!row) throw new Error('no passage row');
    const values = [other, randomBytes(32).toString('hex'), row.chunkerVersion, row.ntsbNo, row.sectionId, row.revisionId, row.sectionSha,
      row.sectionKind, row.scope, row.aircraftKey, row.aircraftSpecific, row.start, row.end, row.part, row.parts, row.continuation, row.tokenCount];
    const insertSql = `insert into passages (generation_id, passage_id, chunker_version, ntsb_no, section_id, revision_id, section_sha,
      section_kind, scope, aircraft_key, aircraft_specific, start, "end", part, parts, continuation, token_count)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`;
    const writer = await session();
    const pruner = await session();
    const observer = await session();
    try {
      // Insert first: pruning waits for the insert to commit, then removes its row with the generation.
      await writer.query('begin');
      await writer.query(insertSql, values);
      const pid = (await pruner.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid as number;
      const pruning = pruner.query('select prune_generation($1)', [other]);
      await waitForLockWait(observer, pid, pruning);
      await writer.query('commit');
      await pruning;
      expect(await count(ingest, sql`select count(*) from passages where generation_id = ${other}`)).toBe(0);
      expect(await count(ingest, sql`select count(*) from dataset_generations where id = ${other}`)).toBe(0);

      // Prune first: the insert waits for the prune to commit, then finds the generation gone.
      const third = await loadVerified(ingest, await onlyEvent('NYC08LA106'), reportDir);
      await pruner.query('begin');
      await pruner.query('select prune_generation($1)', [third]);
      const wpid = (await writer.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid as number;
      const inserting = writer.query(insertSql, [third, ...values.slice(1)]).then(
        () => 'inserted',
        (e: { code?: string }) => e.code,
      );
      await waitForLockWait(observer, wpid, inserting);
      await pruner.query('commit');
      expect(await inserting).toBe('55000');
      expect(await count(ingest, sql`select count(*) from passages where generation_id = ${third}`)).toBe(0);
    } finally {
      await writer.query('rollback').catch(() => undefined);
      await pruner.query('rollback').catch(() => undefined);
      await Promise.all([writer.end(), pruner.end(), observer.end()]);
    }
  });

  it('loses a pruned generation’s passages and keeps the others', async () => {
    const other = await loadVerified(ingest, await onlyEvent('NYC08LA106'), reportDir);
    await rebuildPassagesIndex(es, ingest, createFakeEmbedder(DIMS), {
      generationId: other,
      prefix: PREFIX,
      gate: createMemorySpendGate(20),
      confirmCost: true,
    });
    const before = await count(ingest, sql`select count(*) from passages where generation_id = ${generationId}`);
    expect(await count(ingest, sql`select count(*) from passages where generation_id = ${other}`)).toBeGreaterThan(0);
    await ingest.execute(sql`select prune_generation(${other})`);
    expect(await count(ingest, sql`select count(*) from passages where generation_id = ${other}`)).toBe(0);
    expect(await count(ingest, sql`select count(*) from passages where generation_id = ${generationId}`)).toBe(before);
  });
});

describe('ledger spend gate', () => {
  const opts = { budgets: BUDGETS, provider: 'openai', model: 'text-embedding-3-small', stage: 'embed' };

  it('reserves, settles at usage or in full, and reports what is left of the shared allowance', async () => {
    await resetControls();
    const gate = createLedgerSpendGate(ingest, opts);
    expect(await gate.remainingUsd('indexing')).toBeCloseTo(20, 6);
    const a = await gate.reserve({ category: 'indexing', usd: 0.0017, purpose: 'passages-g1' });
    expect(await gate.remainingUsd('evaluation')).toBeCloseTo(20 - 0.0017, 6);
    await gate.settle(a, { usd: 0.0012, tokens: 60_000 });
    const b = await gate.reserve({ category: 'indexing', usd: 0.002, purpose: 'passages-g1' });
    await gate.settle(b, 'uncertain');
    expect(await gate.remainingUsd('indexing')).toBeCloseTo(20 - 0.0012 - 0.002, 6);
    const lines = await ingest.$client.query<{ usd: string; uncertain: boolean; tokens: unknown; stage: string }>(
      `select usd::text, uncertain, tokens, stage from cost_ledger order by id`,
    );
    expect(lines.rows).toEqual([
      { usd: '0.001200', uncertain: false, tokens: { input: 60_000 }, stage: 'embed' },
      { usd: '0.002000', uncertain: true, tokens: null, stage: 'uncertain' },
    ]);
    await expect(gate.settle(a, { usd: 0 })).rejects.toThrow(/could not be settled: not_open/);
    await expect(gate.reserve({ category: 'indexing', usd: 25, purpose: 'x' })).rejects.toBeInstanceOf(SpendRefusedError);
  });

  it('retries a busy ledger with a bounded wait', async () => {
    await resetControls();
    const holder = await session();
    try {
      await holder.query('select pg_advisory_lock($1)', [SPEND_LOCK_KEY]);
      const waits: number[] = [];
      const gate = createLedgerSpendGate(ingest, {
        ...opts,
        busyRetries: 2,
        busyDelayMs: 10,
        sleep: async (ms) => {
          waits.push(ms);
          // The other holder finishes while we wait.
          await holder.query('select pg_advisory_unlock($1)', [SPEND_LOCK_KEY]);
        },
      });
      const r = await gate.reserve({ category: 'indexing', usd: 0.001, purpose: 'busy' });
      expect(r.reservationId).toMatch(/^\d+$/);
      expect(waits).toEqual([10]);

      await holder.query('select pg_advisory_lock($1)', [SPEND_LOCK_KEY]);
      const stubborn = createLedgerSpendGate(ingest, { ...opts, busyRetries: 1, busyDelayMs: 1, sleep: async () => undefined });
      await expect(stubborn.reserve({ category: 'indexing', usd: 0.001, purpose: 'busy' })).rejects.toThrow(/stayed busy/);
    } finally {
      await holder.end();
    }
  }, 30_000);
});
