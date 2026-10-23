/**
 * Track N on the fixture corpus (fake vectors under the production model name; nothing
 * is paid):
 * - the cohort derivation from PostgreSQL equals what the passages-v2 filter reaches in
 *   Elasticsearch, for event facets, years and aircraft facets over multi-aircraft
 *   events (the pool preflight's check);
 * - the complete case evidence loads in one read-only snapshot: every section in record
 *   order with its hash checked, findings without `cause_factor`, occurrences, stable
 *   fingerprints;
 * - pools build from the experiment harness's runs (case-level fusion with the cases
 *   channel, scope keyword text given), the lure's hard negatives and the tail sample,
 *   and every delivered passage's text is the stored section text at its offsets;
 * - an interrupted run's allocation is recovered against the ledger: its evaluation
 *   reservations (and only its own) are read, an open one blocks the recovery within its
 *   lease and counts in full after it, and the allocation's log gains the difference.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { quotaPolicy, reserveSpend, settleSpend } from '../../server/quota/index.js';
import { loadConfig } from '../../shared/config.js';
import type { RetrievalFilters } from '../../server/search/filters.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { createFakeEmbedder } from '../../worker/index/embed.js';
import { PASSAGES_EMBEDDING_DIMS, rebuildPassagesIndex } from '../../worker/index/passages-index.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { experimentConfig } from '../../evals/retrieval/experiments/config.js';
import { loadNarrativeCorpus } from '../../evals/retrieval/narrative/build.js';
import { deriveCohort, type NarrativeItem } from '../../evals/retrieval/narrative/dataset.js';
import { fingerprint, loadCaseEvidence, EVIDENCE_QUERIES } from '../../evals/retrieval/narrative/evidence.js';
import { ledgerRecovery } from '../../evals/retrieval/narrative/commands.js';
import { allocationLockPath, loggedRunUsd, openAllocation, recoverAllocation } from '../../evals/retrieval/narrative/judging.js';
import { assemblePool, bundlePairs, indexCohort, lureCases, poolRun } from '../../evals/retrieval/narrative/pool.js';
import { questionVersion, rubricVersion, sha256 } from '../../evals/retrieval/narrative/spec.js';
import { NARRATIVE_QUESTIONS } from '../../evals/retrieval/narrative/questions.js';
import { makeExtractDir, removeDir } from '../support/extract-dir.js';
import { loadVerified } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetControls, resetCorpus, testDbUrl, testEs } from './helpers.js';

const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const embedder = createFakeEmbedder(PASSAGES_EMBEDDING_DIMS, 'text-embedding-3-small');

let ingest: Db;
let es: Client;
let dir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-narrative-test-'));
let generationId: number;
let passagesIndex: string;
let casesIndex: string;

beforeAll(async () => {
  await resetCorpus();
  ingest = createDb(testDbUrl('ingest'), { max: 4, applicationName: 'aviation-test-narrative' });
  es = testEs();
  dir = await makeExtractDir();
  generationId = await loadVerified(ingest, dir, reportDir);
  passagesIndex = (await rebuildPassagesIndex(es, ingest, embedder, { generationId, prefix: PREFIX, gate: createMemorySpendGate(1), confirmCost: true })).index;
  casesIndex = (await rebuildCasesIndex(es, ingest, { generationId, prefix: PREFIX })).index;
}, 180_000);

afterAll(async () => {
  const found = await es.indices.get({ index: `${PREFIX}-*`, expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: true });
  for (const name of Object.keys(found)) await es.indices.delete({ index: name });
  await closeDb(ingest);
  for (const d of [dir, reportDir]) removeDir(d);
});

async function withClient<T>(f: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDbUrl('app') });
  await client.connect();
  try {
    return await f(client);
  } finally {
    await client.end();
  }
}

describe('cohorts', () => {
  it('derive from PostgreSQL exactly what the passages-v2 filter reaches', async () => {
    const corpus = await withClient((c) => loadNarrativeCorpus(c, generationId, false));
    const selections: RetrievalFilters[] = [
      {},
      { yearFrom: 2008, yearTo: 2015 },
      { state: ['TX', 'NY'] },
      { injury: ['FATL'] },
      { category: ['AIR'] },
      { category: ['HELI'] },
      { category: ['AIR', 'HELI'] },
      { category: ['HELI'], far_part: ['ARMF'] },
      { far_part: ['091'] },
      { purpose: ['PERS'] },
      { purpose: ['AAPL'] },
      { engine: ['REC'] },
      { phase: ['landing'] },
      { far_part: ['091'], purpose: ['PERS'], yearFrom: 2014 },
      { light: ['NITE', 'NDRK', 'NBRT'] },
    ];
    for (const filters of selections) {
      const fromDb = deriveCohort(corpus.cohort, filters);
      const fromIndex = await indexCohort(es, passagesIndex, { filters }, true);
      expect({ filters, cases: fromDb }).toEqual({ filters, cases: fromIndex });
    }
    expect(deriveCohort(corpus.cohort, {}).length).toBe(12);
  });
});

describe('complete case evidence', () => {
  it('loads every section, finding and occurrence in one snapshot, hashes checked, without cause_factor', async () => {
    const corpus = await withClient((c) => loadNarrativeCorpus(c, generationId, false));
    const cases = corpus.cohort.map((c) => c.ntsbNo);
    const loaded = await withClient((c) => loadCaseEvidence(c, generationId, [...cases, 'NOTACASE01']));
    expect(loaded.missing).toEqual(['NOTACASE01']);
    expect(loaded.integrity).toEqual([]);
    expect([...loaded.evidence.keys()].sort()).toEqual([...cases].sort());
    for (const e of loaded.evidence.values()) {
      expect(e.sections.length).toBeGreaterThan(0);
      expect(e.sections.map((s) => s.alias)).toEqual(e.sections.map((_, i) => `S${i + 1}`));
      const order = { factual: 0, analysis: 1, probable_cause: 2 };
      expect(e.sections.map((s) => order[s.kind])).toEqual([...e.sections.map((s) => order[s.kind])].sort());
      for (const s of e.sections) expect(sha256(s.text)).toBe(s.sha256);
      for (const f of e.findings) expect(f.description ?? '').not.toMatch(/\s-\s[CF]\s*$/);
      if (e.aircraft.length > 1) expect(e.sections.every((s) => s.scope === 'event')).toBe(true);
    }
    const again = await withClient((c) => loadCaseEvidence(c, generationId, cases));
    for (const n of cases) expect(fingerprint(again.evidence.get(n) as never)).toBe(fingerprint(loaded.evidence.get(n) as never));
    for (const sql of Object.values(EVIDENCE_QUERIES)) expect(sql).not.toMatch(/cause_factor/);
  });
});

describe('pools', () => {
  it('build from the experiment harness runs, the lure and the tail, with delivered passages that match the stored text', async () => {
    const corpus = await withClient((c) => loadNarrativeCorpus(c, generationId, false));
    const template = NARRATIVE_QUESTIONS.find((q) => q.type === 'broad' && Object.keys(q.filters).length === 0) as (typeof NARRATIVE_QUESTIONS)[number];
    const v = questionVersion(template);
    const family: NarrativeItem = {
      id: template.id,
      question: 'engine power loss examination revealed no anomalies',
      family: template.id,
      tags: [...template.tags],
      type: 'broad',
      filters: {},
      questionVersion: v,
      memberVersion: v,
      rubric: template.rubric,
      rubricVersion: rubricVersion(template.rubric),
      lure: 'fuel exhaustion fuel starvation',
      cohort: { size: 12, cases: null },
      relatedPositives: [],
      note: 'fixture',
    };
    const ctx = { es, dataset: { generationId, passagesIndex }, passagesIndex, casesIndex, eventAircraftQualification: true };
    const methods = [
      { id: 'p50-kt', config: experimentConfig({ keywordText: 'scope' }) },
      { id: 'c200+n-kt', config: experimentConfig({ fusion: 'case', perChannel: 200, caseChannel: { fields: 'narratives', depth: 200, role: 'third' }, keywordText: 'scope' }) },
    ];
    const runs = [];
    for (const m of methods) for (const [sample, text] of ['engine power loss', 'loss of engine power examination'].entries()) runs.push(await poolRun(ctx, embedder, family, m, sample + 1, text));
    const cohort = await indexCohort(es, passagesIndex, family, true);
    const lure = await lureCases(es, casesIndex, family);
    const pool = assemblePool({ family, members: [family], runs, cohort, lure, rule: { version: 'track-n-pool-v1', depth: 3, methods: ['p50-kt', 'c200+n-kt'], scopeSamples: 2, hardNegatives: 2, lureDepth: 200, tail: { nearFrom: 4, nearTo: 8, near: 2, far: 2 }, keepRanks: 300 } as never });
    expect(runs.every((r) => r.ranking.length > 0 && r.bundle.length > 0)).toBe(true);
    const ids = pool.cases.map((c) => c.ntsbNo);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of pool.cases) expect(cohort).toContain(c.ntsbNo);
    expect(pool.cases.filter((c) => c.sources.includes('hard-negative')).length).toBeLessThanOrEqual(2);
    expect(pool.tail.near.length + pool.tail.far.length).toBeGreaterThan(0);
    expect(pool.version).toMatch(/^[0-9a-f]{64}$/);
    // Every delivered passage is the stored section text at its offsets.
    const pairs = bundlePairs(pool);
    const loaded = await withClient((c) => loadCaseEvidence(c, generationId, pairs.map((p) => p.ntsbNo)));
    for (const p of pairs) {
      const e = loaded.evidence.get(p.ntsbNo);
      for (const x of p.passages) {
        const s = e?.sections.find((sec) => sec.sectionId === x.sectionId && sec.revisionId === x.revisionId);
        expect(sha256((s?.text ?? '').slice(x.start, x.end))).toBe(x.textSha256);
      }
    }
  }, 120_000);
});

describe('allocation recovery against the ledger', () => {
  it("reads the interrupted run's own evaluation reservations, waits out a live lease and appends the difference", async () => {
    await resetControls();
    const policy = quotaPolicy({
      ai: loadConfig({ env: {}, files: [] }).ai,
      auth: { identityHmacSecret: 'test-identity-hmac-secret-0123456789', ipHmacSecret: 'test-network-hmac-secret-0123456789' },
    });
    const T = new Date('2026-12-01T10:00:00Z');
    const at = (ms: number) => new Date(T.getTime() + ms);
    const run = 'eval-10c2-relevance-20261201T100000Z';
    const reserve = async (requestId: string, usd: number) => {
      const r = await reserveSpend(ingest, { category: 'evaluation', usd, request: { provider: 'anthropic', model: 'claude-haiku-5-5', stage: 'judge', requestId }, budgets: policy.budgets, now: T, ttlMs: 60_000 });
      if (!r.ok) throw new Error(`reservation refused: ${JSON.stringify(r)}`);
      return r;
    };
    const settled = await reserve(`${run}-relevance-judge-a`, 0.02);
    expect(await settleSpend(ingest, settled, { lines: [{ usd: 0.01 }] }, settled.fencingToken, at(1_000))).toMatchObject({ ok: true });
    const uncertain = await reserve(`${run}-relevance-judge-b`, 0.03);
    expect(await settleSpend(ingest, uncertain, 'uncertain', uncertain.fencingToken, at(1_000))).toMatchObject({ ok: true });
    await reserve(`${run}-adjudicate-initial-adjudicator`, 0.05);
    // Another run whose id starts with this one, and an unrelated run: neither is read.
    await reserve(`${run}2-relevance-judge-a`, 0.07);
    await reserve('eval-10c2-calibration-20261201T090000Z-relevance-judge-a', 0.11);
    const ledger = ledgerRecovery(ingest);
    const rows = await ledger.runReservations(run);
    expect(rows.map((r) => [r.requestId, r.status, r.reservedUsd, r.chargedUsd, r.uncertain])).toEqual([
      [`${run}-relevance-judge-a`, 'settled', 0.02, 0.01, false],
      [`${run}-relevance-judge-b`, 'settled', 0.03, 0.03, true],
      [`${run}-adjudicate-initial-adjudicator`, 'open', 0.05, null, null],
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'aviation-narrative-recover-'));
    const a = openAllocation(dir, 'track-n-test', 1);
    writeFileSync(allocationLockPath(a), JSON.stringify({ run, pid: 999_999_999, host: hostname(), at: T.toISOString() }));
    await expect(recoverAllocation(a, run, ledger, { confirm: true, now: at(30_000) })).rejects.toThrow(/still open/);
    const done = await recoverAllocation(a, run, ledger, { confirm: true, now: at(61_000) });
    expect(done.ledger).toMatchObject({ reservations: 3, settled: { count: 1 }, chargedInFull: { count: 1 }, openPastLease: { count: 1 } });
    expect(done.ledger.chargedUsd).toBeCloseTo(0.09, 9);
    expect(done.appendedUsd).toBeCloseTo(0.09, 9);
    expect(loggedRunUsd(a.log, run)).toBeCloseTo(0.09, 9);
    await resetControls();
  });
});
