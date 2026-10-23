/**
 * The task 10d retrieval experiments on real Elasticsearch: a fixture variant whose
 * WPR15FA010 is an all-helicopter two-aircraft event (DCA25MA108 stays an airliner and
 * an Army helicopter), indexed as passages-v2 and cases-v3 with fake vectors under the
 * production model name (nothing is paid).
 *
 * - The case-level channel's filter reaches exactly the cases the passages-v2 filter
 *   reaches, for every aircraft selection the event-level qualification test tries and
 *   for event facets and years (`filterConsistency`, the preflight's check).
 * - The default configuration sends the production request bodies and returns the
 *   production ranking and bundle.
 * - A case-level-fusion variant with the case channel maps case-only hits to passages.
 * - The diagnostics' Elasticsearch facts: reachability, the seeded background, signals.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../../server/db/client.js';
import type { AircraftSelection, RetrievalFilters } from '../../server/search/filters.js';
import { compileFilters } from '../../server/search/filters.js';
import { retrieveCandidates, retrieveEvidence, type RetrievalDataset } from '../../server/search/hybrid.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { createFakeEmbedder, fakeVector } from '../../worker/index/embed.js';
import { PASSAGES_EMBEDDING_DIMS, rebuildPassagesIndex } from '../../worker/index/passages-index.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { searchCaseChannel } from '../../evals/retrieval/experiments/cases-channel.js';
import { filterConsistency } from '../../evals/retrieval/experiments/cli.js';
import { experimentConfig, paramsOf } from '../../evals/retrieval/experiments/config.js';
import { backgroundSample, caseSignals, reachableCases } from '../../evals/retrieval/experiments/diagnose.js';
import type { ExperimentItem } from '../../evals/retrieval/experiments/experiment.js';
import { runVariant } from '../../evals/retrieval/experiments/variant.js';
import { editTable, makeExtractDir, removeDir } from '../support/extract-dir.js';
import { evIdOf, loadVerified } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetCorpus, testDbUrl, testEs } from './helpers.js';

const PREFIX = `${TEST_INDEX_PREFIX}${randomBytes(4).toString('hex')}`;
const MODEL = 'text-embedding-3-small';
const embedder = createFakeEmbedder(PASSAGES_EMBEDDING_DIMS, MODEL);

let ingest: Db;
let es: Client;
let dir: string;
const reportDir = mkdtempSync(join(tmpdir(), 'aviation-experiments-test-'));
let generationId: number;
let passagesIndex: string;
let casesIndex: string;
const dataset = (): RetrievalDataset => ({ generationId, passagesIndex });

beforeAll(async () => {
  await resetCorpus();
  ingest = createDb(testDbUrl('ingest'), { max: 4, applicationName: 'aviation-test-experiments' });
  es = testEs();
  dir = await makeExtractDir({
    edit: (d) => {
      const wpr = evIdOf(d, 'WPR15FA010');
      editTable(d, 'aircraft', (rows) => rows.map((r) => (r.ev_id !== wpr ? r : { ...r, acft_category: 'HELI', ...(r.aircraft_key === '2' ? { type_fly: '' } : {}) })));
    },
  });
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

const item = (id: string, filters: RetrievalFilters, relevant: string[] = ['DFW08TA066']): ExperimentItem => ({
  id,
  split: 'dev',
  group: 'g1',
  class: 'narrow',
  area: 'occurrence',
  paraphraseOf: null,
  question: 'midair collision',
  filters,
  relevant,
});

describe('the case-level channel reaches the passages-v2 cohort', () => {
  it('for every aircraft selection of the event-level qualification test, and event facets and years', async () => {
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
    const items = [
      item('none', {}),
      item('years', { yearFrom: 2008, yearTo: 2015 }),
      item('state', { state: ['TX', 'NY'] }),
      item('injury', { injury: ['FATL'] }),
      ...selections.map((s, i) => item(`aircraft-${i}`, s as RetrievalFilters)),
      item('heli-years', { category: ['HELI'], yearFrom: 2015 }),
    ];
    const checks = await filterConsistency(es, { passagesIndex, casesIndex, qualification: true }, items);
    expect(checks).toHaveLength(items.length);
    for (const c of checks) {
      expect({ filters: c.filters, onlyPassages: c.onlyPassages, onlyCasesIndex: c.onlyCasesIndex }).toEqual({ filters: c.filters, onlyPassages: [], onlyCasesIndex: [] });
    }
    // The cohort is the answer-eligible one, and the mixed event never satisfies a helicopter-only filter.
    const heli = checks.find((c) => c.questions.includes('aircraft-0'));
    expect(heli?.passagesCases).toBeGreaterThan(0);
    expect(checks.find((c) => c.questions.includes('none'))?.passagesCases).toBe(checks.find((c) => c.questions.includes('none'))?.casesIndexCases);
    const channel = await searchCaseChannel(es, casesIndex, 'midair collision join up', { fields: 'narratives', depth: 50, role: 'third' }, { category: ['HELI'] }, paramsOf(experimentConfig({})));
    expect(channel.cases).toContain('WPR15FA010');
    expect(channel.cases).not.toContain('DCA25MA108');
  });
});

describe('experiments on real Elasticsearch', () => {
  it('the default configuration is production: the same bodies, ranking and bundle', async () => {
    const filters = { category: ['HELI'] };
    const text = 'helicopter controlled flight into terrain at night with terrain warning inhibited';
    const reference = await retrieveEvidence(es, embedder, { dataset: dataset(), text, filters });
    const candidates = await retrieveCandidates(es, embedder, { dataset: dataset(), text, filters });
    const run = await runVariant(es, embedder, { dataset: dataset(), casesIndex, question: text, filters }, experimentConfig({}));
    expect(run.requests.keyword).toEqual(reference.requests.keyword);
    expect(run.requests.vector).toEqual(reference.requests.vector);
    expect(run.requests.fetch).toEqual(reference.requests.fetch);
    expect(run.ranking).toEqual(candidates.cases.map((c) => c.ntsbNo));
    expect(run.packed.cases).toEqual(reference.cases);
  });

  it('a case-level-fusion variant with the case channel maps case-only hits to passages and packs them', async () => {
    // Depth 1 per passage channel: most cases reach the ranking through the case channel only.
    const config = experimentConfig({ perChannel: 1, fusion: 'case', caseChannel: { fields: 'narratives+findings', depth: 20, role: 'third' } });
    const run = await runVariant(es, embedder, { dataset: dataset(), casesIndex, question: 'fuel pump failure engine power loss', filters: {} }, config);
    expect(run.channels.keyword.length).toBeLessThanOrEqual(1);
    expect(run.channels.cases?.length).toBeGreaterThan(2);
    expect(run.mappedCases.length).toBeGreaterThan(0);
    expect(run.requests.mapping).not.toBeNull();
    const mapped = new Set(run.mappedCases);
    const packedMapped = run.packed.cases.filter((c) => mapped.has(c.ntsbNo));
    expect(packedMapped.length).toBeGreaterThan(0);
    for (const c of packedMapped) {
      expect(c.passages.some((p) => p.sectionKind === 'probable_cause')).toBe(true);
      expect(c.passages.every((p) => p.ntsbNo === c.ntsbNo)).toBe(true);
    }
    expect(new Set(run.ranking).size).toBe(run.ranking.length);
  });

  it('collects the diagnostics’ facts read-only: reachability, a seeded background, three signals', async () => {
    const filters = {};
    const filter = compileFilters(filters, { eventAircraftQualification: true }).bool.filter;
    const heliFilter = compileFilters({ category: ['HELI'] }, { eventAircraftQualification: true }).bool.filter;
    expect([...(await reachableCases(es, passagesIndex, filter, ['DFW08TA066', 'NOSUCH0001']))]).toEqual(['DFW08TA066']);
    expect(await reachableCases(es, passagesIndex, heliFilter, ['DCA25MA108'])).toEqual(new Set());
    const a = await backgroundSample(es, casesIndex, filters, ['DFW08TA066'], 5, 11);
    expect(a).toHaveLength(5);
    expect(a).not.toContain('DFW08TA066');
    expect(await backgroundSample(es, casesIndex, filters, ['DFW08TA066'], 5, 11)).toEqual(a);
    const question = 'castellated nut on the governor lever control rod came loose cotter pin missing';
    const vector = Array.from(fakeVector(queryEmbeddingInput(question), PASSAGES_EMBEDDING_DIMS));
    const signals = await caseSignals(es, { passagesIndex, casesIndex }, { question, vector, filter, filters }, ['DFW08TA066', ...a]);
    const dfw = signals.get('DFW08TA066');
    expect(dfw?.bm25).toBeGreaterThan(0);
    expect(dfw?.cosine).toBeGreaterThan(0);
    for (const n of a) expect(signals.get(n)?.cosine).toBeGreaterThan(0);
    expect(Math.max(...a.map((n) => signals.get(n)?.bm25 ?? 0))).toBeLessThan(dfw?.bm25 as number);
  });
});
