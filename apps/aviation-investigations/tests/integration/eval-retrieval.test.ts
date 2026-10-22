/**
 * The retrieval evaluation on the fixture corpus (fake embeddings under the production
 * model name, no paid call): metrics, bundles and recorded request bodies, and the
 * `pnpm eval:retrieval` command end to end against an unpublished passages index:
 * it fails closed on dataset problems before embedding anything, and an exploratory
 * `--fake-embedder` run writes a non-gating report.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateRetrieval } from '../../evals/retrieval/evaluate.js';
import { SILVER_VERSION, type Dataset, type DatasetItem } from '../../evals/retrieval/silver.js';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import { createFakeEmbedder } from '../../worker/index/embed.js';
import { PASSAGES_EMBEDDING_DIMS, rebuildPassagesIndex } from '../../worker/index/passages-index.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { makeExtractDir, removeDir } from '../support/extract-dir.js';
import { loadVerified } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetCorpus, testDbUrl, testEs, testEsApiKey } from './helpers.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const embedder = createFakeEmbedder(PASSAGES_EMBEDDING_DIMS, 'text-embedding-3-small');
const work = mkdtempSync(join(tmpdir(), 'aviation-eval-test-'));

let ingest: Db;
let es: Client;
let fixtureDir: string;
let generationId: number;
let index: string;

const item = (id: string, question: string, expected: string[], pattern: string, over: Partial<DatasetItem> = {}): DatasetItem => ({
  id,
  question,
  tags: ['mechanical'],
  section: 'rag',
  filters: {},
  expected,
  derivation: { rule: 'fixture', criteria: { text: [{ in: ['probable_cause'], pattern }] }, note: 'fixture' },
  group: 'g1',
  split: 'dev',
  adjudication: 'pending-expert',
  ...over,
});

const ITEMS: DatasetItem[] = [
  item('governor-nut', 'castellated nut on the governor lever control rod came loose; cotter pin missing', ['DFW08TA066'], 'castellated nut'),
  item('fuel-pump', 'engine-driven fuel pump failure and departing with a known engine deficiency', ['NYC08LA106'], 'fuel pump', {
    split: 'holdout',
    group: 'g2',
    tags: ['maintenance_timing'],
  }),
  item('helicopter-cfit', 'helicopter controlled flight into terrain at night with terrain warning inhibited', ['CEN19FA024'], 'terrain warning', {
    filters: { category: ['HELI'] },
    group: 'g3',
  }),
  // Structured questions are never run by the RAG evaluation.
  item('structured-only', 'inspected within three days before a maintenance error', ['DFW08TA066'], 'x', { section: 'structured', tags: ['structured_timing'] }),
];

beforeAll(async () => {
  await resetCorpus();
  ingest = createDb(testDbUrl('ingest'), { max: 4, applicationName: 'aviation-test-eval' });
  es = testEs();
  fixtureDir = await makeExtractDir();
  generationId = await loadVerified(ingest, fixtureDir, work);
  index = (await rebuildPassagesIndex(es, ingest, embedder, { generationId, prefix: PREFIX, gate: createMemorySpendGate(1), confirmCost: true })).index;
}, 180_000);

afterAll(async () => {
  const found = await es.indices.get({ index: `${PREFIX}-*`, expand_wildcards: 'all', allow_no_indices: true, ignore_unavailable: true });
  for (const name of Object.keys(found)) await es.indices.delete({ index: name });
  await closeDb(ingest);
  removeDir(fixtureDir);
  removeDir(work);
});

describe('retrieval evaluation', () => {
  it('scores keyword, vector and hybrid rankings and their bundles at each channel size', async () => {
    const r = await evaluateRetrieval(es, embedder, { generationId, passagesIndex: index }, ITEMS, { sizes: [10, 100] });
    expect(r.questions.map((q) => q.id)).toEqual(['governor-nut', 'fuel-pump', 'helicopter-cfit']);
    for (const q of r.questions) {
      for (const size of ['10', '100']) {
        const s = q.sizes[size];
        expect(s?.requests.keyword).toMatchObject({ index, size: Number(size) });
        expect(JSON.stringify(s?.requests.vector)).toContain('query vector elided');
        for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
          const m = s?.modes[mode];
          expect(m?.recall.at20).toBeGreaterThanOrEqual(0);
          expect(m?.recall.at20).toBeLessThanOrEqual(1);
          expect(m?.bundle.cases.length).toBeLessThanOrEqual(6);
          expect(m?.bundle.passages).toBeLessThanOrEqual(12);
          expect(m?.top20.length).toBeLessThanOrEqual(20);
        }
      }
    }
    // BM25 finds each fixture case from its own words, in its bundle with its probable cause
    // and with passages that satisfy the question's own text criterion.
    for (const q of r.questions) {
      const kw = q.sizes['100']?.modes.keyword;
      expect(kw?.recall.at20, q.id).toBe(1);
      expect(kw?.coverage, q.id).toMatchObject({ cases: 1, evidence: 1, causes: 1 });
      expect(kw?.ndcg6, q.id).toBeGreaterThan(0);
      expect(kw?.precision, q.id).toBeGreaterThan(0);
      expect(kw?.bundle.cases.find((c) => c.ntsbNo === q.expected[0])?.evidence, q.id).toBe(true);
    }
    // The helicopter filter applies to every channel and the fetch.
    const heli = r.questions.find((q) => q.id === 'helicopter-cfit');
    expect(JSON.stringify(heli?.sizes['10']?.requests.keyword)).toContain('"aircraft.category":["HELI"]');
    expect(JSON.stringify(heli?.sizes['10']?.requests.vector)).toContain('"aircraft.category":["HELI"]');
    expect(JSON.stringify(heli?.sizes['10']?.modes.hybrid.fetch)).toContain('"aircraft.category":["HELI"]');
    expect(r.summary['100']?.keyword.all).toMatchObject({ questions: 3, recallAt20: 1, coverageCases: 1, coverageEvidence: 1, coverageCausesStructural: 1 });
    expect(r.summary['100']?.keyword.dev?.questions).toBe(2);
    expect(r.summary['100']?.keyword.holdout?.questions).toBe(1);
  });

  it('runs as pnpm eval:retrieval: fails closed on dataset problems, and writes a non-gating report when exploratory', () => {
    const questions = Array.from({ length: 40 }, (_, i) => ({ ...ITEMS[i % 3], id: `fixture-${i}`, group: `g${i + 1}` }) as DatasetItem);
    const dataset: Dataset = {
      version: SILVER_VERSION,
      description: 'fixture',
      adjudication: 'pending-expert',
      source: { generationId, answerEligibleCases: 12, builder: 'test', rulesSha256: '0'.repeat(64) },
      limits: { minExpected: 1, maxExpected: 20 },
      questions,
    };
    const datasetFile = join(work, 'dataset.json');
    writeFileSync(datasetFile, JSON.stringify(dataset));
    const out = join(work, 'out');
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [join(APP_DIR, 'node_modules/tsx/dist/cli.mjs'), 'evals/retrieval/run.ts', '--dataset', datasetFile, '--passages-index', index, '--out-dir', out, ...args], {
        cwd: APP_DIR,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: testDbUrl('app'), ELASTICSEARCH_READ_API_KEY: testEsApiKey('read') },
      });

    // The fixture set breaks the silver-set rules (no paraphrases, tags in one split): the
    // run stops before embedding anything, in plan mode and in a paid run alike.
    for (const args of [[], ['--confirm-cost']]) {
      const refused = cli(...args);
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stderr).toMatch(/dataset: only 0 paraphrases/);
      expect(refused.stderr).toContain('nothing embedded');
    }
    expect(existsSync(out)).toBe(false);

    const run = cli('--fake-embedder', '--exploratory', '--sizes', '10,20', '--split', 'dev');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain('NON-GATING');
    expect(run.stderr).toContain('fake embeddings');
    expect(run.stdout).toMatch(/R@20/);
    expect(run.stdout).toContain('meets the passages contract');
    const files = readdirSync(out).filter((f) => /^eval-retrieval-\d{8}T\d{6}Z\.json$/.test(f));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(out, files[0] as string), 'utf8');
    const report = JSON.parse(text) as Record<string, unknown> & { nonGatingReasons: string[]; questions: { split: string }[]; summary: Record<string, unknown> };
    expect(report).toMatchObject({
      kind: 'eval-retrieval',
      gating: false,
      dataset: { ragQuestions: 27, split: 'dev', adjudication: 'pending-expert' },
      index: { passagesIndex: index, generationId, embeddingModel: 'text-embedding-3-small', chunkerVersion: 'chunk-v2', inputTemplateVersion: 'input-v1' },
      embedder: { kind: 'fake', inputs: 2 },
    });
    expect(report.nonGatingReasons).toEqual(expect.arrayContaining(['--exploratory', '--fake-embedder']));
    expect(report.nonGatingReasons.some((r) => r.startsWith('dataset: '))).toBe(true);
    expect(Object.keys(report.summary)).toEqual(['10', '20']);
    expect(report.questions.every((q) => q.split === 'dev')).toBe(true);
    // No vector anywhere in the report: no run of 50 numbers.
    expect(text).not.toMatch(/(-?\d\.\d+,\s*){50}/);
    expect(text).toContain('1536-dimension query vector elided');
  }, 120_000);
});
