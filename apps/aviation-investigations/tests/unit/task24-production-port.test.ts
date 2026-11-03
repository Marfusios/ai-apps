/** Real shared ranking pipeline, offline providers/records; no HTTP or shared-service writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeProvider } from '../../server/ai/fake.js';
import { loadConfig } from '../../shared/config.js';
import { evidenceCases } from '../../web/mock/evidence.js';
import { evidenceRankingConfig, evidenceRankingIdentity } from '../../server/evidence/ranking-config.js';
import { evidenceReservation } from '../../server/evidence/pricing.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { productionPort } from '../../evals/search-quality/ab-production.js';
import { applyFiltersRequest } from '../../evals/applied-filters/plan.js';
import type { LexicalSource } from '../../server/evidence/pipeline.js';
import { ARM_IDS, type Arm, type ArmIdentity } from '../../evals/search-quality/ab-types.js';
import type { TaskAllocation } from '../../evals/search-quality/money.js';
import type { Db } from '../../server/db/client.js';
import type { Client } from '@elastic/elasticsearch';
import type { PinnedDataset } from '../../server/dataset.js';

const mocks = vi.hoisted(() => ({ provider: undefined as any, search: vi.fn(), active: vi.fn() }));
vi.mock('../../server/ai/anthropic.js', async original => ({ ...await original<typeof import('../../server/ai/anthropic.js')>(), createAnthropicProvider: () => mocks.provider }));
vi.mock('../../server/ai/embeddings.js', async original => ({ ...await original<typeof import('../../server/ai/embeddings.js')>(),
  createOpenAIQueryEmbedder: () => ({ model: 'text-embedding-3-small', dims: 1536, usdPerMillionTokens: .02, embed: vi.fn(), embedWithSignal: vi.fn() }) }));
vi.mock('../../server/db/generations.js', async original => ({ ...await original<typeof import('../../server/db/generations.js')>(), getActiveManifest: mocks.active }));
vi.mock('../../server/evidence/retrieve.js', async original => ({ ...await original<typeof import('../../server/evidence/retrieve.js')>(),
  createEvidenceRetriever: () => ({ available: async () => true, search: mocks.search }) }));

const identities = Object.fromEntries(Object.entries(ARM_IDS).map(([alias, version]) => {
  const c = evidenceRankingConfig(version);
  return [alias, { alias, ...evidenceRankingIdentity(c), reservationUsd: evidenceReservation(c.scope.model, c.embedding.model, c).reservationUsd,
    changedKnobs: Number(c.lexicalText !== 'question') + Number(!!c.rerank), depth: c.rerank?.depth ?? 0 }];
})) as Record<Arm, ArmIdentity>;
const dataset = { manifest: { generationId: 1, casesIndex: 'synthetic-cases', passagesIndex: 'synthetic-passages' } } as PinnedDataset;
const question = { id: 'synthetic-question', question: 'Find engine power loss investigations in Alaska.', relevant: ['SYNTHETIC1'], group: 'one', class: 'narrow' as const, area: 'aircraft_systems' };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'task24-port-offline-'));
  mocks.active.mockReset().mockResolvedValue(dataset.manifest);
  mocks.provider = createFakeProvider({ evidenceScope: { output: { intent: 'case_search', filters: { state: ['AK'] }, terms: 'engine power loss' } },
    rerank: input => ({ output: { grades: input.cases.map((c, i) => ({ id: c.id, grade: i % 4 })) } }) });
  mocks.search.mockReset().mockImplementation(async (_dataset, _plan, _signal, report) => {
    report({ model: 'text-embedding-3-small', dims: 1536, inputTemplate: 'query-v1', billing: 'reported', tokens: 10, usd: .0000002 });
    const base = evidenceCases({}, 'engine')[0]!;
    const cases = Array.from({ length: 3 }, (_, i) => ({ ...structuredClone(base), rank: i + 1, case: { ...base.case, ntsbNo: `SYNTHETIC${i}` } }));
    return { cases, ranking: cases.map(c => ({ ntsbNo: c.case.ntsbNo, seeds: [], channels: ['keyword'] })) };
  });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function setup(limit = 10) {
  const memory = createMemorySpendGate(limit), gate = vi.fn(() => memory);
  const allocation = { gate } as unknown as TaskAllocation;
  const settings = { env: {}, config: loadConfig({ files: [], env: { APP_ENV: 'dev', ANTHROPIC_API_KEY: 'synthetic', OPENAI_API_KEY: 'synthetic' } }) };
  return { memory, gate, port: productionPort(settings, {} as Db, {} as Client, dataset, allocation, 'selection', 'a'.repeat(64), directory, identities) };
}
describe('Task 24 production entry-point adapter', () => {
  it('runs fresh scope/retrieval/rerank with empty execution filters and settles all stages', async () => {
    const h = setup(), attempt = { key: 'synthetic-question:TH50:1', questionId: question.id, arm: 'TH50' as const, sample: 1 as const };
    const result = await h.port.run(attempt, question);
    expect(result.failure).toBeNull(); expect(result.safetyFaults).toEqual([]);
    expect(mocks.search.mock.calls[0]![1]).toEqual({ text: question.question, keywordText: 'engine power loss', filters: {} });
    expect(result.executed).toEqual({ lexical: 'engine power loss', vector: question.question });
    expect(mocks.provider.calls.map((c: any) => c.stage)).toEqual(['scope', 'rerank']);
    expect(h.memory.records).toHaveLength(3); expect(h.memory.records.every(r => r.status === 'settled')).toBe(true);
    expect(result.actualUsd).toBeCloseTo(h.memory.records.reduce((n, r) => n + r.chargedUsd!, 0), 9);
    expect(result.ranking).toEqual([...result.fused].reverse());
    expect(result.reservationIds).toHaveLength(3);
  });
  it('never dispatches a provider when the production gate refuses', async () => {
    const h = setup(0);
    const result = await h.port.run({ key: 'synthetic-question:Q0:1', questionId: question.id, arm: 'Q0', sample: 1 }, question);
    expect(result.failure).toBe('spend'); expect(mocks.provider.calls).toHaveLength(0); expect(mocks.search).not.toHaveBeenCalled();
  });
  it('stops before paid admission when the active generation changes', async () => {
    const h = setup(); mocks.active.mockResolvedValue({ ...dataset.manifest, generationId: 2 });
    await expect(h.port.run({ key: 'synthetic-question:Q0:1', questionId: question.id, arm: 'Q0', sample: 1 }, question)).rejects.toThrow('Active target changed');
    expect(h.gate).not.toHaveBeenCalled(); expect(mocks.provider.calls).toHaveLength(0);
  });
});

describe('Task 29 edits through the production entry point', () => {
  it('runs "Apply these filters" as the site does: the suggestion\'s filters, inherited texts, no scope, a rerank', async () => {
    const h = setup();
    const live = await h.port.run({ key: 'synthetic-question:QH50:1', questionId: question.id, arm: 'QH50', sample: 1 }, question);
    expect(live.suggestion).toEqual({ filters: { state: ['AK'] }, terms: 'engine power loss' });
    const filters = applyFiltersRequest(live.lexicalSource as LexicalSource, live.addedTerms ?? null, live.suggestion ?? null)!;
    expect(filters).toEqual({ state: ['AK'] });
    const before = mocks.provider.calls.length;
    mocks.search.mockClear();
    const edit = await h.port.run({ key: 'synthetic-question:QH50F:1', questionId: question.id, arm: 'QH50', sample: 1 }, question,
      { filters, edited: { executed: live.executed!, lexicalSource: live.lexicalSource as LexicalSource, addedTerms: live.addedTerms ?? null } });
    expect(edit.failure).toBeNull(); expect(edit.safetyFaults).toEqual([]);
    expect(mocks.provider.calls.slice(before).map((c: any) => c.stage)).toEqual(['rerank']);
    expect(mocks.search.mock.calls[0]![1]).toEqual({ text: live.executed!.vector, keywordText: live.executed!.lexical, filters: { state: ['AK'] } });
    expect(edit).toMatchObject({ edited: true, appliedFilters: { state: ['AK'] }, scopeOutcome: 'skipped', rerankOutcome: 'applied', suggestion: null });
  });
  it('runs Elasticsearch alone with scope skipped and no filters', async () => {
    const h = setup();
    const q0 = await h.port.run({ key: 'synthetic-question:Q0:1', questionId: question.id, arm: 'Q0', sample: 1 }, question, { filters: {}, skipScope: true });
    expect(q0.failure).toBeNull(); expect(mocks.provider.calls).toHaveLength(0);
    expect(mocks.search.mock.calls[0]![1].filters).toEqual({});
    expect(q0).toMatchObject({ scopeOutcome: 'skipped', rerankOutcome: 'disabled', edited: false });
  });
});
