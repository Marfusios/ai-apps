/** Server-only v3 disclosure, policy and free-undo rules. No provider network. */
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../shared/config.js';
import { EVIDENCE_RANKING_VERSIONS } from '../../shared/evidence-ranking.js';
import { CreateEvidenceRequestSchema, EvidencePageSchema, type CreateEvidenceRequest } from '../../shared/contracts/evidence.js';
import { autoFilterIdentity, autoFilterPolicy, automaticState } from '../../server/evidence/auto-filters.js';
import { disclosedQuery, questionQuery, remainingSuggestion } from '../../server/evidence/disclosure.js';
import { canUndo } from '../../server/evidence/undo.js';
import { pageOf, withSuggestion, type EvidenceRow } from '../../server/evidence/store.js';
import { evidenceRankingConfig, evidenceRankingIdentity } from '../../server/evidence/ranking-config.js';
import { rankEvidence, rankingTexts } from '../../server/evidence/pipeline.js';
import { createFakeProvider, type FakeScript } from '../../server/ai/fake.js';
import { evaluationRankingSpendGate } from '../../server/evidence/spend.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import type { EvidenceRetriever } from '../../server/evidence/retrieve.js';
import type { PinnedDataset } from '../../server/dataset.js';
import { evidenceCases } from '../../web/mock/evidence.js';

const now = new Date('2026-10-25T12:00:00Z');
const question = 'Find engine failures in California';
const rawSuggestion = { terms: 'power loss', filters: { state: ['CA'], yearFrom: 2019 } };
function row(): EvidenceRow {
  return { id: '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f', readOwner: 'a'.repeat(64), readOwnerKind: 'trial', ownerMovedAt: null,
    billingPrincipal: 'a'.repeat(64), billingKind: 'trial', reservationId: 1, freeUndoReservationId: null,
    generationId: 1, casesIndex: 'test-cases', passagesIndex: 'test-passages', status: 'results', createdAt: now,
    expiresAt: new Date(now.getTime() + 86400_000), data: {
      question, edited: false, version: 'evidence.v3', query: { source: 'question', keywords: { kind: 'terms', terms: 'power loss' } },
      context: { dataset: { revision: 'g1', snapshotDate: '2026-10-01' }, citationTextVersion: 'v1', fieldNormalizationVersion: 'v1', mappingVerified: false },
      automaticFilters: { state: ['CA'] }, appliedFilters: { state: ['CA'], yearFrom: 2019 }, suggestion: null, hint: null, note: null,
      marks: 'search_words', freeUndo: false, cases: [], ranking: [],
    } };
}
const edit = (changes: Record<string, unknown> = {}) => CreateEvidenceRequestSchema.parse({ kind: 'edited', from: row().id,
  filters: { yearFrom: 2019 }, idempotencyKey: 'undo-12345678', ...changes }) as Extract<CreateEvidenceRequest, { kind: 'edited' }>;

describe('independent automatic state policy', () => {
  it('defaults to none, rejects unknown values and refuses the state policy on live', () => {
    expect(loadConfig({ files: [], env: {} }).ai.evidenceAutoFilters).toBe('none');
    expect(loadConfig({ files: [], env: { AVIATION_EVIDENCE_AUTO_FILTERS: 'state-explicit.v1.1' } }).ai.evidenceAutoFilters).toBe('state-explicit.v1.1');
    expect(() => loadConfig({ files: [], env: { AVIATION_EVIDENCE_AUTO_FILTERS: 'state-explicit.v1' } })).toThrow();
    expect(() => loadConfig({ files: [], env: { APP_ENV: 'live', AVIATION_EVIDENCE_AUTO_FILTERS: 'state-explicit.v1.1' } })).toThrow('not cleared for live');
    expect(loadConfig({ files: [], env: { APP_ENV: 'live', AVIATION_EVIDENCE_AUTO_FILTERS: 'none' } }).ai.evidenceAutoFilters).toBe('none');
  });
  it('has distinct immutable identities and rejects altered policies', () => {
    expect(Object.isFrozen(autoFilterPolicy('state-explicit.v1.1'))).toBe(true);
    expect(autoFilterIdentity(autoFilterPolicy()).sha256).toBe('774bdd396d1b1aa32764f75a6458cae5690372d422cb601fa0f6fb271c8643c8');
    expect(autoFilterIdentity(autoFilterPolicy('state-explicit.v1.1')).sha256).toBe('69fc897400e4bb92e66cf47109d44b6731abbcfffae2fbd2725b13e90558a255');
    expect(() => automaticState({ ...autoFilterPolicy('state-explicit.v1.1'), field: null } as never, question, rawSuggestion.filters, false, false)).toThrow('unregistered');
  });
  it('applies only a cleared complete state set from a valid question search', () => {
    const p = autoFilterPolicy('state-explicit.v1.1');
    expect(automaticState(p, question, rawSuggestion.filters, false, false)).toEqual({ filters: { state: ['CA'] }, reason: 'applied' });
    expect(automaticState(p, question, rawSuggestion.filters, true, false)).toEqual({ filters: null, reason: 'edited' });
    expect(automaticState(p, question, null, false, false).reason).toBe('scope_unavailable');
    expect(automaticState(p, question, null, false, true).reason).toBe('non_search');
    expect(automaticState(p, 'Find events in California or Nevada', { state: ['CA'] }, false, false).reason).toBe('set_mismatch');
  });
});

describe('v3 execution facts', () => {
  it.each(EVIDENCE_RANKING_VERSIONS)('%s discloses its actual words, order and marks without leaking execution metadata', async version => {
    const config = evidenceRankingConfig(version), cases = evidenceCases({}, 'engine').slice(0, 2);
    const llm = createFakeProvider({ evidenceScope: { output: { intent: 'case_search', ...rawSuggestion } },
      rerank: input => ({ output: { grades: input.cases.map(c => ({ id: c.id, grade: 2 })) } }),
    });
    const search: EvidenceRetriever['search'] = vi.fn(async () => ({ cases, ranking: cases.map(c => ({ ntsbNo: c.case.ntsbNo, seeds: [], channels: [] })) }));
    const out = await rankEvidence(config, { question, filters: {}, dataset: {} as PinnedDataset, signal: new AbortController().signal,
      autoFilters: autoFilterPolicy('state-explicit.v1.1'),
    }, { llm, retriever: { available: async () => true, search }, embeddingModel: 'text-embedding-3-small' }, evaluationRankingSpendGate(() => createMemorySpendGate(1), 'v3'));
    expect(search).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filters: { state: ['CA'] } }), expect.anything(), expect.anything(), expect.anything());
    expect(out.suggestion?.filters).toEqual({ yearFrom: 2019 });
    const saved = row();
    saved.data = { ...saved.data, ...out, query: questionQuery(question, out.lexicalSource, out.executed),
      rankingConfig: out.configuration, marks: 'search_words' };
    saved.data = withSuggestion(saved.data, remainingSuggestion(disclosedQuery(saved.data), out.suggestion), config.query.highlights);
    const page = pageOf(saved, 1)!;
    expect(page.query).toEqual({ source: 'question', keywords: config.lexicalText === 'question' ? { kind: 'question' } : { kind: config.lexicalText, terms: 'power loss' } });
    expect(page.automaticFilters).toEqual({ state: ['CA'] }); expect(page.appliedFilters).toEqual({ state: ['CA'] });
    expect(page.order).toBe(config.rerank ? 'ai_relevance' : 'match');
    expect(page.marks).toBe(version === 'er-q-v1' ? 'suggested_terms' : 'search_words');
    expect(page.suggestion).toEqual({ filters: { yearFrom: 2019 }, terms: config.lexicalText === 'question' ? 'power loss' : null });
    expect(page.freeUndo).toBe(false);
    expect(page).not.toHaveProperty('autoFilterPolicy'); expect(page).not.toHaveProperty('autoFilterReason');
    expect(page).not.toHaveProperty('executed'); expect(page).not.toHaveProperty('rankingConfig');
  });
  it.each(['timeout', 'network', 'rate_limited', 'overloaded', 'count_failed', 'cap_exceeded', 'refusal', 'truncated', 'invalid_output'] as const)('%s rerank fallback discloses match order', async fail => {
    const config = evidenceRankingConfig('er-t-h50-v1'), cases = evidenceCases({}, 'engine').slice(0, 1);
    const script: FakeScript = { evidenceScope: { output: { intent: 'case_search', ...rawSuggestion } }, rerank: { fail } };
    const out = await rankEvidence(config, { question, filters: {}, dataset: {} as PinnedDataset, signal: new AbortController().signal },
      { llm: createFakeProvider(script), retriever: { available: async () => true, search: async () => ({ cases, ranking: cases.map(c => ({ ntsbNo: c.case.ntsbNo, seeds: [], channels: [] })) }) }, embeddingModel: 'text-embedding-3-small' },
      evaluationRankingSpendGate(() => createMemorySpendGate(1), 'fallback'));
    const saved = row(); saved.data = { ...saved.data, ...out, query: questionQuery(question, out.lexicalSource, out.executed), marks: 'search_words' };
    expect(pageOf(saved, 1)?.order).toBe('match');
  });
  it('discloses legacy v2 keywords from executed text and does not invent automatic filters', () => {
    const saved = row(); saved.data.version = 'evidence.v2'; saved.data.query = { source: 'question' };
    delete saved.data.automaticFilters; delete saved.data.freeUndo; delete saved.data.marks;
    saved.data.lexicalSource = 'question+terms'; saved.data.executed = { lexical: question + ' power loss', vector: question };
    saved.data.rankingConfig = evidenceRankingIdentity(evidenceRankingConfig('er-qt-v1'));
    const page = pageOf(saved, 1)!;
    expect(page).toMatchObject({ version: 'evidence.v3', automaticFilters: null, order: 'match', marks: 'search_words', freeUndo: false,
      query: { source: 'question', keywords: { kind: 'question+terms', terms: 'power loss' } } });
    expect(EvidencePageSchema.safeParse(page).success).toBe(true);
  });
  it('retains only the portion of appended terms actually searched, and omits redundant suggestions', () => {
    expect(questionQuery(question, 'question+terms', { vector: question, lexical: question + ' power' })).toEqual({ source: 'question', keywords: { kind: 'question+terms', terms: 'power' } });
    expect(remainingSuggestion(questionQuery(question, 'terms', { vector: question, lexical: 'power' }), { terms: 'power loss', filters: {} })).toBeNull();
  });
  it('a partial first appended word is a question fallback', () => {
    const q = 'engine '.repeat(994).trim();
    const terms = 'antidisestablishmentarianism'.repeat(4);
    const texts = rankingTexts(q, terms, evidenceRankingConfig('er-qt-v1'));
    expect(texts.lexicalSource).toBe('fallback_question');
    expect(texts.executed.lexical).toBe(texts.executed.vector);
    expect(questionQuery(q, texts.lexicalSource, texts.executed)).toEqual({ source: 'question', keywords: { kind: 'question' } });
  });
});

describe('one-use free undo predicate', () => {
  it.each([
    {}, { filters: { state: ['CA'], yearFrom: 2019 }, keywords: 'question' }, { keywords: 'question' },
    { filters: { state: [], yearFrom: 2019 } },
  ])('allows removal of state, added keywords or both: %#', changes => expect(canUndo(row(), edit(changes), now)).toBe(true));
  it.each([
    { filters: { state: ['CA'], yearFrom: 2019 } }, // no addition removed
    { terms: 'power loss' }, // even identical explicit terms are an ordinary edit
    { filters: { yearFrom: 2020 } }, { filters: {} }, { filters: { yearFrom: 2019, category: ['AIR'] } },
    { filters: { state: ['NV'], yearFrom: 2019 } },
  ])('rejects edits with anything added, otherwise changed, or unchanged: %#', changes => expect(canUndo(row(), edit(changes), now)).toBe(false));
  it('rejects expired, unfinished, already claimed and edited parents', () => {
    for (const change of [{ status: 'running' }, { status: 'failed' }, { expiresAt: now }, { freeUndoReservationId: 2 }, { data: { ...row().data, edited: true } }]) {
      expect(canUndo({ ...row(), ...change }, edit(), now)).toBe(false);
    }
    const saved = row(); saved.data.query = { source: 'edited', terms: 'power' };
    expect(canUndo(saved, edit(), now)).toBe(false);
  });
  it('question keywords cannot claim an undo unless terms were previously added', () => {
    const saved = row(); saved.data.query = { source: 'question', keywords: { kind: 'question' } };
    expect(canUndo(saved, edit({ keywords: 'question' }), now)).toBe(false);
    expect(canUndo(saved, edit(), now)).toBe(true); // removing the automatic state alone
  });
  it('only the automatic state field may be removed; removing an OR member is a paid narrowing', () => {
    const saved = row(); saved.data.automaticFilters = { state: ['CA', 'NV'] }; saved.data.appliedFilters.state = ['CA', 'NV'];
    expect(canUndo(saved, edit({ filters: { state: ['CA'], yearFrom: 2019 } }), now)).toBe(false);
    expect(canUndo(saved, edit(), now)).toBe(true);
    saved.data.automaticFilters = null;
    expect(canUndo(saved, edit(), now)).toBe(false);
  });
  it('keywords and terms cannot be combined or given null', () => {
    expect(() => edit({ keywords: 'question', terms: 'power' })).toThrow();
    expect(() => edit({ terms: null })).toThrow();
  });
});
