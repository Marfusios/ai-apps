/**
 * The retrieval evaluation on the fixture corpus (fake embeddings under the production
 * model name, no paid call): metrics, bundles and recorded request bodies, and the
 * `pnpm eval:retrieval` command end to end against an unpublished passages index:
 * it fails closed on dataset problems before embedding anything, and an exploratory
 * `--fake-embedder` run writes a non-gating report. The same for the coded-reference
 * track (`--track coded`), whose builder reads the fixture generation in one snapshot.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { CORPUS_QUERIES, loadCodedCorpus } from '../../evals/retrieval/coded/build-coded.js';
import { assembleCoded, codeStats, deriveQuestion, indexCorpus, type CodedCorpus, type CodedDataset, type CodedQuestionSpec } from '../../evals/retrieval/coded/coded.js';
import { evaluateCoded } from '../../evals/retrieval/coded/evaluate.js';
import { evaluateRetrieval } from '../../evals/retrieval/evaluate.js';
import { readGenerationSource, type GenerationSource } from '../../evals/retrieval/generation.js';
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
/** The fixture generation's identity, as a dataset built from it records it. */
let fixtureSource: GenerationSource;

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
  const client = new pg.Client({ connectionString: testDbUrl('app') });
  await client.connect();
  try {
    fixtureSource = await readGenerationSource(client, generationId);
  } finally {
    await client.end();
  }
}, 180_000);

/** `pnpm eval:retrieval` as a child process against the fixture index (fake or no embeddings), with the test environment's read access. */
const runCli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [join(APP_DIR, 'node_modules/tsx/dist/cli.mjs'), 'evals/retrieval/run.ts', '--passages-index', index, ...args], {
    cwd: APP_DIR,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: testDbUrl('app'), ELASTICSEARCH_READ_API_KEY: testEsApiKey('read'), ...env },
  });

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
      source: { ...fixtureSource, answerEligibleCases: 12, builder: 'test', rulesSha256: '0'.repeat(64) },
      limits: { minExpected: 1, maxExpected: 20 },
      questions,
    };
    const datasetFile = join(work, 'dataset.json');
    writeFileSync(datasetFile, JSON.stringify(dataset));
    const out = join(work, 'out');
    const cli = (...args: string[]) => runCli(['--dataset', datasetFile, '--out-dir', out, ...args]);

    // The fixture set breaks the silver-set rules (no paraphrases, tags in one split): the
    // run stops before embedding anything, in plan mode and in a paid run alike. Its
    // labels hold on the target: every rule re-run there gives its expected cases.
    for (const args of [[], ['--confirm-cost']]) {
      const refused = cli(...args);
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stderr).toMatch(/dataset: only 0 paraphrases/);
      expect(refused.stderr).toContain('nothing embedded');
      expect(refused.stderr).not.toMatch(/^(labels|generation):/m);
    }
    expect(existsSync(out)).toBe(false);

    // Labels that do not hold on the target, and an index that breaks the passages contract, stop the run too.
    const tampered = join(work, 'dataset-tampered.json');
    writeFileSync(tampered, JSON.stringify({ ...dataset, questions: questions.map((q) => (q.id === 'fixture-0' ? { ...q, expected: ['NYC08LA106'] } : q)) }));
    const wrongLabels = runCli(['--dataset', tampered, '--out-dir', out, '--confirm-cost']);
    expect(wrongLabels.status).toBe(1);
    expect(wrongLabels.stderr).toContain('labels: fixture-0: the target derives 1 positive cases, the dataset has 1: +1 (DFW08TA066) -1 (NYC08LA106)');
    const refusedIndex = runCli(['--dataset', datasetFile, '--out-dir', out, '--confirm-cost'], { OPENAI_EMBEDDING_DIMENSIONS: '1024' });
    expect(refusedIndex.status).toBe(1);
    expect(refusedIndex.stderr).toContain('breaks the passages contract');
    expect(refusedIndex.stderr).toContain('nothing embedded');
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
      // What was measured (retrieval.v1's passage stage, BM25 on the question), whatever the server runs.
      retrieval: { measured: { version: 'retrieval.v1', keywordText: 'question', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }, configured: { version: expect.stringMatching(/^retrieval\./) } },
    });
    expect(report.nonGatingReasons).toEqual(expect.arrayContaining(['--exploratory', '--fake-embedder']));
    expect(report.nonGatingReasons.some((r) => r.startsWith('dataset: '))).toBe(true);
    expect(report).toMatchObject({ dataset: { target: { source: fixtureSource, questionsRederived: 40 } } });
    expect(Object.keys(report.summary)).toEqual(['10', '20']);
    expect(report.questions.every((q) => q.split === 'dev')).toBe(true);
    // No vector anywhere in the report: no run of 50 numbers.
    expect(text).not.toMatch(/(-?\d\.\d+,\s*){50}/);
    expect(text).toContain('1536-dimension query vector elided');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Coded-reference track (task 10c Track C)

/** The answer-eligible US fixture cases: completed with a probable cause (ENG08WA029 is Peruvian; three have no cause). */
const FIXTURE_COHORT = [
  'CEN19FA024', 'CEN20LA361', 'CEN24FA064', 'DCA25MA108', 'DEN08LA103', 'DFW08TA066',
  'ERA24LA303', 'MIA08LA156', 'NYC08LA106', 'SEA08LA057', 'WPR15FA010', 'WPR26LA114',
];

const codedSpec = (id: string, question: string, wording: string[], filters: CodedQuestionSpec['filters'], clauses: CodedQuestionSpec['codeSet']['clauses']): CodedQuestionSpec => ({
  id,
  question,
  area: 'occurrence',
  class: 'narrow',
  filters,
  codeSet: { clauses, attribution: 'same-aircraft' },
  wording,
  note: 'fixture',
});
const CODED_SPECS: CodedQuestionSpec[] = [
  codedSpec('fx-midair', 'Which accidents involved a midair collision?', ['midair collision'], {}, [{ kind: 'event', codes: ['250'] }]),
  codedSpec('fx-midair-airplanes', 'Which midair collisions were between airplanes?', ['midair collision'], { category: ['AIR'] }, [{ kind: 'event', codes: ['250'] }]),
  codedSpec('fx-decision-cause', "Which accidents have a probable cause that cites the pilot's decision making?", ["the pilot's decision making"], {}, [
    { kind: 'finding', codes: ['0204152044'], inProbableCause: true },
  ]),
  codedSpec('fx-decision-cause-helicopters', "Which helicopter accidents have a probable cause that cites the pilot's decision making?", ["the pilot's decision making"], { category: ['HELI'] }, [
    { kind: 'finding', codes: ['0204152044'], inProbableCause: true },
  ]),
];

describe('coded-reference track', () => {
  let corpus: CodedCorpus;
  let coded: CodedDataset;

  beforeAll(async () => {
    const client = new pg.Client({ connectionString: testDbUrl('app') });
    await client.connect();
    let source: GenerationSource;
    try {
      ({ source, corpus } = await loadCodedCorpus(client, generationId));
    } finally {
      await client.end();
    }
    expect(source).toEqual(fixtureSource);
    const index = indexCorpus(corpus);
    const derived = new Map(CODED_SPECS.map((s) => [s.id, deriveQuestion(index, s)]));
    const stats = codeStats(corpus, CODED_SPECS.flatMap((s) => s.codeSet.clauses.flatMap((c) => c.codes.map((code) => ({ kind: c.kind, code })))));
    coded = assembleCoded({ ...source, answerEligibleCases: corpus.cases.length, builder: 'test' }, CODED_SPECS, [], derived, stats).dataset;
  });

  it('reads the answer-eligible US cohort in one read-only snapshot, never cause_factor, and derives labels from codes', () => {
    expect(corpus.cases.map((c) => c.ntsbNo)).toEqual(FIXTURE_COHORT);
    expect(corpus.findings.length).toBeGreaterThan(0);
    for (const f of corpus.findings) expect(Object.keys(f).sort()).toEqual(['aircraftKey', 'code', 'description', 'inProbableCause', 'ntsbNo']);
    for (const q of Object.values(CORPUS_QUERIES)) expect(q).not.toMatch(/cause_factor/);
    const byId = new Map(coded.questions.map((q) => [q.id, q]));
    expect(byId.get('fx-midair')?.relevant).toEqual(['DCA25MA108', 'SEA08LA057', 'WPR15FA010']);
    // Under the airplane filter the airplane-and-helicopter midair is coded but unreachable (passages-v2 needs every aircraft to match).
    expect(byId.get('fx-midair-airplanes')).toMatchObject({ relevant: ['SEA08LA057', 'WPR15FA010'], unreachable: ['DCA25MA108'], needsEventAircraftQualification: true });
    expect(byId.get('fx-decision-cause')?.relevant).toEqual(['CEN19FA024', 'NYC08LA106']);
    expect(byId.get('fx-decision-cause-helicopters')?.relevant).toEqual(['CEN19FA024']);
    expect(byId.get('fx-midair')?.codes).toEqual([{ kind: 'event', code: '250', descriptions: ['Midair collision'], cohortCases: 3, relevantCases: 3 }]);
    expect(byId.get('fx-decision-cause')?.codes[0]).toMatchObject({
      descriptions: ['Personnel issues-Action/decision-Info processing/decision-Decision making/judgment-Pilot'],
      cohortCases: 2,
      cohortCasesInProbableCause: 2,
    });
  });

  it('scores keyword, vector and hybrid against the coded reference at each channel size', async () => {
    const r = await evaluateCoded(es, embedder, { generationId, passagesIndex: index }, coded.questions, { sizes: [10, 100] });
    expect(r.questions.map((q) => q.id)).toEqual(coded.questions.map((q) => q.id));
    for (const q of r.questions) {
      for (const size of ['10', '100']) {
        const s = q.sizes[size];
        expect(JSON.stringify(s?.requests.vector)).toContain('query vector elided');
        for (const mode of ['keyword', 'vector', 'hybrid'] as const) {
          const m = s?.modes[mode];
          expect(m?.score.recall.gate).toBe('eligible');
          expect(m?.score.recall.value).toBeGreaterThanOrEqual(0);
          expect(m?.score.recall.value).toBeLessThanOrEqual(1);
          expect(m?.score.ndcg.method).toBe('exact');
          expect(m?.score.precision.strict.lower).toBe(m?.score.precision.strict.upper);
          expect(m?.bundle.cases.length).toBeLessThanOrEqual(6);
          const relevant = coded.questions.find((x) => x.id === q.id)?.relevant ?? [];
          for (const c of m?.bundle.cases ?? []) expect(c.coded, `${q.id} ${c.ntsbNo}`).toBe(relevant.includes(c.ntsbNo));
        }
      }
      // Twelve cases fit in 100 passages per channel: BM25 reaches every coded case in the first 20.
      expect(q.sizes['100']?.modes.keyword.score.recall.value, q.id).toBe(1);
    }
    // The airplane filter reaches the two-airplane midairs through the event-level qualification.
    const air = r.questions.find((q) => q.id === 'fx-midair-airplanes');
    expect(JSON.stringify(air?.sizes['10']?.requests.keyword)).toContain('event_aircraft');
    expect(r.summary['100']?.keyword.all?.recallGate).toMatchObject({ questions: 4, mean: 1, atTarget: 1 });
    expect(r.table).toHaveLength(4 * 2 * 3);
  });

  it('runs as pnpm eval:retrieval --track coded: fails closed before embedding, and writes a coded-reference report when exploratory', () => {
    const datasetFile = join(work, 'coded.json');
    writeFileSync(datasetFile, JSON.stringify(coded));
    const out = join(work, 'coded-out');
    const cli = (file: string, ...args: string[]) => runCli(['--track', 'coded', '--dataset', file, '--out-dir', out, ...args]);

    // The fixture set breaks the coverage rules and was not built from the committed specs: no embedding, in plan mode or paid.
    // Its labels hold on the target: every question re-derived there gives the same cases.
    for (const args of [[], ['--confirm-cost']]) {
      const refused = cli(datasetFile, ...args);
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stderr).toMatch(/dataset: only 4 questions/);
      expect(refused.stderr).toContain('dataset: built from other question specs');
      expect(refused.stderr).toContain('nothing embedded');
      expect(refused.stderr).not.toMatch(/^(labels|generation):/m);
    }
    // Labels that do not hold on the target: a missing positive, and another archive.
    const midair = coded.questions.find((q) => q.id === 'fx-midair') as (typeof coded.questions)[number];
    const wrongLabels = join(work, 'coded-wrong-labels.json');
    writeFileSync(wrongLabels, JSON.stringify({ ...coded, questions: coded.questions.map((q) => (q.id === 'fx-midair' ? { ...q, relevant: midair.relevant.slice(1) } : q)) }));
    const labels = cli(wrongLabels, '--confirm-cost');
    expect(labels.status).toBe(1);
    expect(labels.stderr).toContain(`labels: fx-midair: the target derives 3 positive cases, the dataset has 2: +1 (${midair.relevant[0]})`);
    const otherArchive = join(work, 'coded-other-archive.json');
    writeFileSync(otherArchive, JSON.stringify({ ...coded, source: { ...coded.source, archiveSha256: '0'.repeat(64) } }));
    const archive = cli(otherArchive, '--confirm-cost');
    expect(archive.status).toBe(1);
    expect(archive.stderr).toContain(`generation: the coded set was built from source archive sha256 ${'0'.repeat(64)}; the target generation has ${fixtureSource.archiveSha256}`);
    // An index that breaks the passages contract.
    const refusedIndex = runCli(['--track', 'coded', '--dataset', datasetFile, '--out-dir', out, '--confirm-cost'], { OPENAI_EMBEDDING_DIMENSIONS: '1024' });
    expect(refusedIndex.status).toBe(1);
    expect(refusedIndex.stderr).toContain('breaks the passages contract');
    expect(refusedIndex.stderr).toContain('nothing embedded');
    // Another generation than the one the set was built from.
    const otherGeneration = join(work, 'coded-other-generation.json');
    writeFileSync(otherGeneration, JSON.stringify({ ...coded, source: { ...coded.source, generationId: generationId + 1 } }));
    const mismatch = cli(otherGeneration, '--confirm-cost');
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain(`generation: the coded set was built from generation ${generationId + 1}; the target is generation ${generationId}`);
    // A dataset that does not parse.
    const broken = join(work, 'coded-broken.json');
    writeFileSync(broken, JSON.stringify({ ...coded, reference: 'adjudicated' }));
    const unparsed = cli(broken, '--confirm-cost');
    expect(unparsed.status).toBe(1);
    expect(unparsed.stderr).toContain('the coded dataset does not parse; nothing embedded');
    expect(existsSync(out)).toBe(false);
    expect(cli(datasetFile, '--track', 'nope').status).toBe(2);

    const run = cli(datasetFile, '--fake-embedder', '--exploratory', '--sizes', '10,20');
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain('NON-GATING');
    expect(run.stdout).toContain('coded-reference: 4 questions');
    expect(run.stdout).toContain('meets the passages contract');
    expect(run.stdout).toMatch(/per question, 10 per channel/);
    const files = readdirSync(out).filter((f) => /^eval-retrieval-coded-\d{8}T\d{6}Z\.json$/.test(f));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(out, files[0] as string), 'utf8');
    const report = JSON.parse(text) as Record<string, unknown> & { nonGatingReasons: string[]; table: unknown[]; summary: Record<string, unknown> };
    expect(report).toMatchObject({
      kind: 'eval-retrieval-coded',
      reference: 'coded-reference',
      gating: false,
      dataset: { questions: 4, narrow: 4, broad: 0, split: 'all', notRunWithoutEventAircraftQualification: [] },
      index: { passagesIndex: index, generationId, indexVersion: 'passages-v2', eventAircraftQualification: true },
      embedder: { kind: 'fake', inputs: 4 },
      retrieval: { measured: { version: 'retrieval.v1', keywordText: 'question' }, configured: { version: expect.stringMatching(/^retrieval\./) } },
    });
    expect(report.nonGatingReasons).toEqual(expect.arrayContaining(['--exploratory', '--fake-embedder']));
    expect(report.nonGatingReasons.some((r) => r.startsWith('dataset: '))).toBe(true);
    expect(report).toMatchObject({ dataset: { splitsFrozen: false, target: { source: fixtureSource, questionsRederived: 4, warnings: [] } } });
    expect(Object.keys(report.summary)).toEqual(['10', '20']);
    expect(report.table).toHaveLength(4 * 2 * 3);
    expect(text).not.toMatch(/(-?\d\.\d+,\s*){50}/);
    expect(text).toContain('1536-dimension query vector elided');
    expect(text).not.toMatch(/expert/i);
    expect(run.stdout).toContain('coded P@6');

    // Exploratory runs continue past labels that do not hold, but the report says why it is not gating.
    const exploratoryOut = join(work, 'coded-out-exploratory');
    const lenient = runCli(['--track', 'coded', '--dataset', wrongLabels, '--out-dir', exploratoryOut, '--fake-embedder', '--exploratory', '--sizes', '10']);
    expect(lenient.status, lenient.stderr).toBe(0);
    const [lenientFile] = readdirSync(exploratoryOut);
    const lenientReport = JSON.parse(readFileSync(join(exploratoryOut, lenientFile as string), 'utf8')) as { gating: boolean; nonGatingReasons: string[] };
    expect(lenientReport.gating).toBe(false);
    expect(lenientReport.nonGatingReasons.some((r) => r.startsWith('labels: fx-midair: the target derives 3 positive cases'))).toBe(true);
  }, 180_000);
});
