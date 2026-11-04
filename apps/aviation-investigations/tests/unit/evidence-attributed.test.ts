/**
 * `attributed.v1` end to end without providers: the policy identity, the metered attribution stage in
 * `rankEvidence` (fake provider, memory spend gate), the reservation, the real adapter's request on an
 * offline transport, the free preflight and the Langfuse mirror. No provider network.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { automaticCandidates } from '../../shared/automatic-candidates.js';
import { loadConfig } from '../../shared/config.js';
import { EVIDENCE_RANKING_VERSIONS } from '../../shared/evidence-ranking.js';
import { createFakeProvider, approveCandidates, type FakeScript } from '../../server/ai/fake.js';
import { createAnthropicProvider, outputFormat, type AnthropicMessagesClient } from '../../server/ai/anthropic.js';
import { ATTRIBUTION_CAPS, CACHED_PREFIX_MAX, stageWorstCaseUsd } from '../../server/ai/pricing.js';
import { ATTRIBUTION_MODEL, evidenceAttributionCtx, isValidStageCtx } from '../../server/ai/provider.js';
import { ATTRIBUTION_SYSTEM, AttributionWireOutputSchema, renderAttributionUser } from '../../server/ai/prompts/attribution.a2.js';
import { attributionStage, autoFilterIdentity, autoFilterPolicy, automaticFieldsOf, automaticState, type EvidenceAutoFilterPolicy } from '../../server/evidence/auto-filters.js';
import { attributedFilters, attributionInput } from '../../server/evidence/attribution.js';
import { candidateFingerprint, CANDIDATE_PROBES } from '../../server/evidence/candidate-probes.js';
import { rankEvidence, RankingFailure } from '../../server/evidence/pipeline.js';
import { evidenceRankingConfig } from '../../server/evidence/ranking-config.js';
import { attributionWorstCaseUsd, evidenceReservation, evidenceStartupCheck } from '../../server/evidence/pricing.js';
import { admittedRankingSpendGate, evaluationRankingSpendGate } from '../../server/evidence/spend.js';
import type { EvidenceRetriever } from '../../server/evidence/retrieve.js';
import type { PinnedDataset } from '../../server/dataset.js';
import type { Admission } from '../../server/quota/admit.js';
import { UNCERTAIN_CALL_STAGES } from '../../server/quota/policy.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { attributionPreflightRequests, runAiPreflight } from '../../worker/ai-preflight.js';
import { MIRRORED_PROMPTS } from '../../worker/langfuse-prompts.js';
import { syntheticEvidenceCases } from '../support/evidence-cases.js';

const MIXED = 'Find helicopter accidents in Alaska during 2019 after an engine failure.';
const SUGGESTED: BriefFilters = { state: ['AK'], yearFrom: 2019, yearTo: 2019, category: ['HELI'], phase: ['takeoff'] };
const attributed = autoFilterPolicy('attributed.v1');
const WORST = stageWorstCaseUsd('claude-haiku-5-5', ATTRIBUTION_CAPS, CACHED_PREFIX_MAX);

function setup(script: FakeScript = {}, policy: EvidenceAutoFilterPolicy = attributed, filters: BriefFilters = SUGGESTED) {
  const config = evidenceRankingConfig('er-q-v1'), cases = syntheticEvidenceCases(2);
  const llm = createFakeProvider({ evidenceScope: { output: { intent: 'case_search', filters, terms: 'engine failure' } }, ...script });
  const search = vi.fn<EvidenceRetriever['search']>(async (_dataset, _plan, _signal, callback) => {
    callback?.({ model: 'text-embedding-3-small', dims: 1536, inputTemplate: 'query-v1', billing: 'reported', tokens: 12, usd: 0.00000024 });
    return { cases, ranking: cases.map(c => ({ ntsbNo: c.case.ntsbNo, seeds: [], channels: ['keyword' as const] })) };
  });
  const memory = createMemorySpendGate(1), spend = evaluationRankingSpendGate(() => memory, 'attributed');
  const input = { question: MIXED, filters: {}, dataset: {} as PinnedDataset, signal: new AbortController().signal, autoFilters: policy };
  const providers = { llm, retriever: { available: async () => true, search }, embeddingModel: 'text-embedding-3-small' };
  const stages = () => memory.records.map(r => r.purpose.split(':').at(-1));
  return { config, llm, search, memory, spend, input, providers, stages };
}

describe('the attributed.v1 policy', () => {
  it('is registered, frozen and pinned; none and v1.3 keep their identities', () => {
    expect(Object.isFrozen(attributed)).toBe(true); expect(Object.isFrozen(attributed.attribution.caps)).toBe(true);
    expect(attributed).toMatchObject({ version: 'attributed.v1', fields: ['state', 'years', 'category'],
      rules: { state: 'state-mention.v1', years: 'year-mention.v1', category: 'category-mention.v1' },
      attribution: { stage: 'attribution', model: 'claude-haiku-5-5', prompt: { version: 'attr.a3' }, caps: { input: 5000, output: 1200 },
        timeoutMs: 8000, settings: { thinking: 'off', effort: 'low', retries: 0, cache: 'system-5m' } },
      behaviour: { version: 'candidate-probes.v1' }, appliesTo: 'question-case-search' });
    expect(autoFilterIdentity(attributed).sha256).toBe('5c0448bfc72e3d0c425ee1b54766074fdb643634dd2c257085557487e464ec76');
    expect(autoFilterIdentity(autoFilterPolicy('none')).sha256).toBe('f586929efd8c2254ec18d3ac2141d2be48fad1125b3708160686b31a67766715');
    expect(autoFilterIdentity(autoFilterPolicy('state-explicit.v1.3')).sha256).toBe('8e1491adf18797055438498cd49bec694ec265d3698b8ea0049ee34c4575f6de');
  });
  it('binds the prompt text and wire schema it sends', async () => {
    const { createHash } = await import('node:crypto');
    const { z } = await import('zod');
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(attributed.attribution.prompt).toEqual({ version: 'attr.a3', sha256: hash(ATTRIBUTION_SYSTEM),
      schemaSha256: hash(JSON.stringify(z.toJSONSchema(AttributionWireOutputSchema))) });
  });
  it('names its fields for /api/config; the deterministic policies decide without a check', () => {
    expect(automaticFieldsOf(autoFilterPolicy('none'))).toEqual([]);
    expect(automaticFieldsOf(autoFilterPolicy('state-explicit.v1.3'))).toEqual(['state']);
    expect(automaticFieldsOf(attributed)).toEqual(['state', 'years', 'category']);
    expect(attributionStage(autoFilterPolicy('none'))).toBeNull(); expect(attributionStage(autoFilterPolicy('state-explicit.v1.3'))).toBeNull();
    expect(() => automaticState(attributed, MIXED, SUGGESTED, false, false)).toThrow('attribution check');
    expect(automaticState(attributed, MIXED, SUGGESTED, true, false)).toEqual({ filters: null, reason: 'edited' });
  });
  it('fingerprints the candidate rules, the renderer and the quote validator, including a change without a version bump', () => {
    const fields = attributed.fields, base = candidateFingerprint(fields);
    expect(attributed.behaviour.sha256).toBe(base);
    expect(CANDIDATE_PROBES.length).toBeGreaterThan(400);
    // A rule that also accepts "Kansas City", a renderer without operators, a validator that ignores quotes.
    const rule: typeof automaticCandidates = (q, e, r, f) => q === 'Find accidents in Kansas City.'
      ? { candidates: [{ field: 'state', state: ['KS'], witnesses: [{ start: 18, end: 24 }] }], reasons: { state: 'candidate', years: 'disabled', category: 'disabled' } }
      : automaticCandidates(q, e, r, f);
    expect(candidateFingerprint(fields, rule)).not.toBe(base);
    expect(candidateFingerprint(fields, undefined, undefined, (q, c) => renderAttributionUser(attributionInput(q, c)).replace('2019', '2019 only'))).not.toBe(base);
    expect(candidateFingerprint(fields, undefined, (q, c, o) => attributedFilters(q, c, o && { checks: o.checks.map(k => ({ ...k, quote: q })) }))).not.toBe(base);
    // A subset policy is its own identity.
    expect(candidateFingerprint(['state'])).not.toBe(base);
  });
});

describe('rankEvidence with attributed.v1', () => {
  it('runs one metered check for the candidates, applies them before retrieval and keeps the rest suggested', async () => {
    const h = setup();
    const out = await rankEvidence(h.config, h.input, h.providers, h.spend);
    expect(h.llm.calls.map(c => c.stage)).toEqual(['scope', 'attribution']);
    expect(h.llm.calls[1]!.input).toEqual(attributionInput(MIXED, automaticCandidates(MIXED, SUGGESTED, {}).candidates));
    expect(h.search).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filters: { state: ['AK'], yearFrom: 2019, yearTo: 2019, category: ['HELI'] } }),
      expect.anything(), expect.anything(), expect.anything());
    expect(out).toMatchObject({ automaticFilters: { state: ['AK'], yearFrom: 2019, yearTo: 2019, category: ['HELI'] },
      appliedFilters: { state: ['AK'], yearFrom: 2019, yearTo: 2019, category: ['HELI'] }, autoFilterReason: 'applied',
      autoFilterFields: { state: 'applied', years: 'applied', category: 'applied' }, attributionOutcome: 'applied',
      autoFilterPolicy: autoFilterIdentity(attributed) });
    expect(out.suggestion).toEqual({ filters: { phase: ['takeoff'] }, terms: 'engine failure' });
    // Reserved at its own worst case, settled at the actual usage: scope, attribution, embedding.
    expect(h.stages()).toEqual(['scope', 'attribution', 'embed']);
    expect(h.memory.records[1]).toMatchObject({ reservedUsd: WORST, status: 'settled', chargedUsd: 0.00015 });
    expect(out.usage.map(l => l.stage)).toEqual(['scope', 'attribution', 'embed']);
    expect(out.usage[1]).toMatchObject({ stage: 'attribution', model: 'claude-haiku-5-5', provider: 'fake', usd: 0.00015 });
  });
  it('runs no check without a candidate', async () => {
    const h = setup({}, attributed, { phase: ['takeoff'], state: ['TX'] });
    const out = await rankEvidence(h.config, h.input, h.providers, h.spend);
    expect(h.llm.calls.map(c => c.stage)).toEqual(['scope']); expect(h.stages()).toEqual(['scope', 'embed']);
    expect(out).toMatchObject({ automaticFilters: null, appliedFilters: {}, autoFilterReason: 'not_applied', attributionOutcome: 'not_run',
      autoFilterFields: { state: 'not_candidate:set_mismatch', years: 'not_candidate:empty', category: 'not_candidate:empty' } });
    expect(out.suggestion?.filters).toEqual({ phase: ['takeoff'], state: ['TX'] });
  });
  it('applies only the fields the check approves, all or nothing per field', async () => {
    const h = setup({ evidenceAttribution: input => ({ output: { checks: approveCandidates(input).output.checks.map(c =>
      c.id === 'years' ? { ...c, about: 'aircraft_history' as const } : c.id === 'category:HELI' ? { ...c, quote: 'engine failure' } : c) } }) });
    const out = await rankEvidence(h.config, h.input, h.providers, h.spend);
    expect(out).toMatchObject({ automaticFilters: { state: ['AK'] }, appliedFilters: { state: ['AK'] }, autoFilterReason: 'applied',
      autoFilterFields: { state: 'applied', years: 'attribution:aircraft_history', category: 'bad_quote' } });
    expect(out.suggestion?.filters).toEqual({ yearFrom: 2019, yearTo: 2019, category: ['HELI'], phase: ['takeoff'] });
  });
  it.each(['timeout', 'network', 'rate_limited', 'overloaded', 'refusal', 'truncated', 'invalid_output'] as const)('a %s check keeps every suggestion and applies nothing', async fail => {
    const fallback = vi.fn();
    const h = setup({ evidenceAttribution: { fail } });
    const out = await rankEvidence(h.config, h.input, h.providers, h.spend, undefined, { onFallback: fallback });
    expect(out).toMatchObject({ automaticFilters: null, appliedFilters: {}, autoFilterReason: 'not_applied',
      autoFilterFields: { state: 'attribution_unavailable', years: 'attribution_unavailable', category: 'attribution_unavailable' } });
    expect(out.suggestion?.filters).toEqual(SUGGESTED);
    expect(out.attributionOutcome).toBe(fail === 'network' ? 'provider_error' : fail);
    expect(fallback).toHaveBeenCalledWith({ stage: 'attribution', outcome: out.attributionOutcome });
    expect(h.search).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filters: {} }), expect.anything(), expect.anything(), expect.anything());
    const line = out.usage.find(l => l.stage === 'attribution');
    if (fail === 'timeout' || fail === 'network') expect(line).toMatchObject({ uncertain: true, usd: WORST }); // unknown usage: the full worst case
    else if (['refusal', 'truncated', 'invalid_output'].includes(fail)) expect(line).toMatchObject({ usd: 0.00015 }); // billed
    else expect(line).toBeUndefined(); // unbilled
  });
  it('a structurally incomplete answer applies nothing but settles its known usage', async () => {
    const h = setup({ evidenceAttribution: { output: { checks: [{ id: 'state:AK', about: 'accident_location', quote: 'in Alaska' }] } } });
    const out = await rankEvidence(h.config, h.input, h.providers, h.spend);
    expect(out).toMatchObject({ attributionOutcome: 'invalid_output', automaticFilters: null,
      autoFilterFields: { state: 'attribution_unavailable', years: 'attribution_unavailable', category: 'attribution_unavailable' } });
    expect(out.usage.find(l => l.stage === 'attribution')).toEqual(expect.objectContaining({ usd: 0.00015 }));
    expect(out.usage.find(l => l.stage === 'attribution')?.uncertain).toBeUndefined();
  });
  it('a provider count over the cap never generates or charges (input_too_large)', async () => {
    const h = setup({ attributionCounts: ATTRIBUTION_CAPS.input + 1 });
    const out = await rankEvidence(h.config, h.input, h.providers, h.spend);
    expect(out.attributionOutcome).toBe('input_too_large'); expect(out.automaticFilters).toBeNull();
    expect(h.llm.calls.map(c => c.stage)).toEqual(['scope']); expect(h.memory.records[1]).toMatchObject({ chargedUsd: 0 });
  });
  it('a stopped search (deletion, shutdown) before the check fails, sends nothing and settles zero', async () => {
    const h = setup(); let guards = 0;
    await expect(rankEvidence(h.config, h.input, h.providers, h.spend, async () => { if (++guards === 2) throw new Error('deleted'); }))
      .rejects.toMatchObject({ stage: 'scope' });
    expect(h.llm.calls.map(c => c.stage)).toEqual(['scope']); expect(h.search).not.toHaveBeenCalled();
    expect(h.memory.records.map(r => [r.purpose.split(':').at(-1), r.chargedUsd])).toEqual([['scope', 0.00015], ['attribution', 0]]);
  });
  it('an outer abort during the check ends the search; its unknown usage settles at the worst case', async () => {
    const controller = new AbortController();
    const h = setup({ evidenceAttribution: () => { controller.abort(); return { fail: 'timeout', billing: { kind: 'uncertain' } }; } });
    await expect(rankEvidence(h.config, { ...h.input, signal: controller.signal }, h.providers, h.spend)).rejects.toThrow();
    expect(h.search).not.toHaveBeenCalled();
    expect(h.memory.records.at(-1)).toMatchObject({ purpose: expect.stringMatching(/:attribution$/), status: 'uncertain', chargedUsd: WORST });
  });
  it('records the attribution facts once the check settles, so a search that then stops or fails keeps them (review M6)', async () => {
    const unavailable = { state: 'attribution_unavailable', years: 'attribution_unavailable', category: 'attribution_unavailable' };
    // Dispatched, then the search was stopped during the check (shutdown).
    const controller = new AbortController(), aborted = { onAttribution: vi.fn(), onExecution: vi.fn() };
    const a = setup({ evidenceAttribution: () => { controller.abort(); return { fail: 'timeout', billing: { kind: 'uncertain' } }; } });
    await expect(rankEvidence(a.config, { ...a.input, signal: controller.signal }, a.providers, a.spend, undefined, aborted)).rejects.toThrow();
    expect(aborted.onAttribution).toHaveBeenCalledExactlyOnceWith({ attributionOutcome: 'aborted', autoFilterFields: unavailable });
    expect(aborted.onExecution).not.toHaveBeenCalled();
    // Approved and settled, then the search was stopped before retrieval (deletion).
    const before = { onAttribution: vi.fn(), onExecution: vi.fn() }, b = setup(); let guards = 0;
    await expect(rankEvidence(b.config, b.input, b.providers, b.spend, async () => { if (++guards === 3) throw new Error('deleted'); }, before))
      .rejects.toMatchObject({ stage: 'retrieve' });
    expect(before.onAttribution).toHaveBeenCalledExactlyOnceWith({ attributionOutcome: 'applied',
      autoFilterFields: { state: 'applied', years: 'applied', category: 'applied' } });
    expect(before.onExecution).not.toHaveBeenCalled();
    // Stopped at the check's own guard: nothing dispatched.
    const guarded = { onAttribution: vi.fn() }, c = setup(); guards = 0;
    await expect(rankEvidence(c.config, c.input, c.providers, c.spend, async () => { if (++guards === 2) throw new Error('deleted'); }, guarded))
      .rejects.toMatchObject({ stage: 'scope' });
    expect(guarded.onAttribution).toHaveBeenCalledExactlyOnceWith({ attributionOutcome: 'stopped', autoFilterFields: unavailable });
    // No candidate: the decision without a check.
    const none = { onAttribution: vi.fn() }, d = setup({}, attributed, { state: ['TX'] });
    await rankEvidence(d.config, d.input, d.providers, d.spend, undefined, none);
    expect(none.onAttribution).toHaveBeenCalledExactlyOnceWith({ attributionOutcome: 'not_run',
      autoFilterFields: { state: 'not_candidate:set_mismatch', years: 'not_candidate:empty', category: 'not_candidate:empty' } });
    // Observability cannot change the search.
    const e = setup();
    await expect(rankEvidence(e.config, e.input, e.providers, e.spend, undefined, { onAttribution: () => { throw new Error('logger'); } }))
      .resolves.toMatchObject({ attributionOutcome: 'applied' });
  });
  it('a refused reservation or settlement is a ranking failure, never an abstention', async () => {
    for (const failure of ['reserve', 'settle'] as const) {
      const h = setup(); let calls = 0;
      const gate = h.spend as unknown as Record<'reserve' | 'settle', (...args: unknown[]) => Promise<unknown>>;
      const real = gate[failure].bind(h.spend);
      gate[failure] = async (...args) => { if (++calls === 2) throw new Error('private'); return real(...args); };
      await expect(rankEvidence(h.config, h.input, h.providers, h.spend)).rejects.toMatchObject({ stage: 'spend' });
      expect(h.search).not.toHaveBeenCalled();
    }
  });
  it('the uncertain allowance and edits never call it; a provider without the stage is refused up front', async () => {
    const skipped = setup();
    const out = await rankEvidence(skipped.config, { ...skipped.input, uncertainAllowanceReached: true }, skipped.providers, skipped.spend);
    expect(skipped.llm.calls).toHaveLength(0); expect(out).toMatchObject({ autoFilterReason: 'scope_unavailable', attributionOutcome: 'not_run', autoFilterFields: {} });
    const edited = setup();
    const e = await rankEvidence(edited.config, { ...edited.input, filters: { state: ['AK'] }, edited: { executed: { lexical: 'engine', vector: MIXED }, lexicalSource: 'question' } }, edited.providers, edited.spend);
    expect(edited.llm.calls).toHaveLength(0); expect(e).toMatchObject({ autoFilterReason: 'edited', automaticFilters: null, appliedFilters: { state: ['AK'] } });
    const missing = setup();
    delete (missing.llm as { evidenceAttribution?: unknown }).evidenceAttribution;
    await expect(rankEvidence(missing.config, missing.input, missing.providers, missing.spend)).rejects.toBeInstanceOf(RankingFailure);
    expect(missing.llm.calls).toHaveLength(0); expect(missing.memory.records).toHaveLength(0);
  });
  it('a non-search intent or a failed scope runs no check', async () => {
    for (const [evidenceScope, reason] of [[{ output: { intent: 'out_of_scope' as const, filters: {} } }, 'non_search'], [{ fail: 'timeout' as const }, 'scope_unavailable']] as const) {
      const h = setup({ evidenceScope });
      const out = await rankEvidence(h.config, h.input, h.providers, h.spend);
      expect(h.llm.calls.map(c => c.stage)).toEqual(['scope']); expect(out).toMatchObject({ autoFilterReason: reason, attributionOutcome: 'not_run' });
    }
  });
  it('a field the request already constrains is never automatic, and is never overwritten', async () => {
    const h = setup();
    const out = await rankEvidence(h.config, { ...h.input, filters: { state: ['HI'] } }, h.providers, h.spend);
    expect(out.appliedFilters).toEqual({ state: ['HI'], yearFrom: 2019, yearTo: 2019, category: ['HELI'] });
    expect(out.autoFilterFields).toMatchObject({ state: 'not_candidate:requested', years: 'applied', category: 'applied' });
  });
  it('state-explicit.v1.3 is unchanged: state only, no check', async () => {
    const h = setup({}, autoFilterPolicy('state-explicit.v1.3'), { state: ['AK'], yearFrom: 2019, yearTo: 2019 });
    const out = await rankEvidence(h.config, { ...h.input, question: 'Find accidents in Alaska' }, h.providers, h.spend);
    expect(h.llm.calls.map(c => c.stage)).toEqual(['scope']);
    expect(out).toMatchObject({ automaticFilters: { state: ['AK'] }, autoFilterReason: 'applied', autoFilterFields: {}, attributionOutcome: 'not_run' });
    expect(out.suggestion?.filters).toEqual({ yearFrom: 2019, yearTo: 2019 });
  });
});

describe('money', () => {
  it.each(EVIDENCE_RANKING_VERSIONS)('%s reserves the attribution worst case only under attributed.v1, before the one rounding', version => {
    const c = evidenceRankingConfig(version);
    const none = evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', c);
    const with_ = evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', c, attributed);
    expect(evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', c, autoFilterPolicy('state-explicit.v1.3'))).toEqual(none);
    expect(with_.worstCaseUsd - none.worstCaseUsd).toBeCloseTo(0.001225, 12);
    expect(with_.reservationUsd).toBe(Math.ceil(with_.worstCaseUsd * 1e4) / 1e4);
  });
  it('is $0.001225: 5,000 input tokens all written to the cache, 1,200 output tokens (twelve checks)', () => {
    expect(WORST).toBeCloseTo((5000 * 0.1 + 1200 * 0.5 + 5000 * (0.125 - 0.1)) / 1e6, 12);
    expect(attributionWorstCaseUsd(attributed.attribution)).toBe(WORST);
    const reserve = (version: Parameters<typeof evidenceRankingConfig>[0]) =>
      evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', evidenceRankingConfig(version), attributed).reservationUsd;
    expect(reserve('er-q-v1')).toBe(0.0037); expect(reserve('er-q-h50-v1')).toBe(0.0102); expect(reserve('er-q-h100-v1')).toBe(0.0152);
  });
  it('the admitted HTTP gate holds every stage within the attributed reservation; without the check\'s share it runs out at the last stage', async () => {
    const c = evidenceRankingConfig('er-q-h50-v1'), r = c.rerank!;
    const calls = [
      { stage: 'scope' as const, provider: 'anthropic' as const, model: 'claude-haiku-5-5', worstCaseUsd: 0.0024125 },
      { stage: 'attribution' as const, provider: 'anthropic' as const, model: 'claude-haiku-5-5', worstCaseUsd: WORST },
      { stage: 'embed' as const, provider: 'openai' as const, model: 'text-embedding-3-small', worstCaseUsd: 0.00002 },
      { stage: 'rerank' as const, provider: 'anthropic' as const, model: r.model, worstCaseUsd: stageWorstCaseUsd(r.model, r.caps, r.cachePrefixTokens) },
    ];
    const admitted = admittedRankingSpendGate({ reservationUsd: evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', c, attributed).reservationUsd } as Admission);
    for (const call of calls) await admitted.gate.reserve(call);
    const without = admittedRankingSpendGate({ reservationUsd: evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', c).reservationUsd } as Admission);
    await without.gate.reserve(calls[0]!); await without.gate.reserve(calls[1]!); await without.gate.reserve(calls[2]!);
    await expect(without.gate.reserve(calls[3]!)).rejects.toThrow();
  });
  it('the startup check prices the configured policy, and an uncertain check counts toward the daily allowance', () => {
    const cfg = loadConfig({ env: { NODE_ENV: 'test', AI_LLM_PROVIDER: 'fake', AVIATION_EVIDENCE_AUTO_FILTERS: 'attributed.v1' }, files: [] });
    expect(evidenceStartupCheck(cfg).reservationUsd).toBe(0.0037);
    expect(UNCERTAIN_CALL_STAGES).toContain('attribution');
  });
});

describe('the real adapter on an offline transport', () => {
  const output = { checks: [{ id: 'state:AK', about: 'accident_location' as const, quote: 'in Alaska' }] };
  const input = attributionInput('Find accidents in Alaska.', automaticCandidates('Find accidents in Alaska.', { state: ['AK'] }, {}).candidates);
  function provider(parsed: unknown = { result: output }, counted = 1000) {
    const count = vi.fn(async () => ({ input_tokens: counted }));
    const parse = vi.fn(async () => ({ usage: { input_tokens: 900, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn', parsed_output: parsed }));
    const client = { messages: { countTokens: count, parse } } as unknown as AnthropicMessagesClient;
    // The configured scope model does not choose the check's model.
    return { count, parse, p: createAnthropicProvider({ models: { scope: 'claude-sonnet-5-5', answer: 'claude-opus-5-5', check: 'claude-haiku-5-5' }, client }) };
  }
  it('sends Haiku, thinking off, effort low, the cached frozen prompt and the wire envelope; unwraps the result', async () => {
    const { p, count, parse } = provider();
    const ctx = evidenceAttributionCtx(new AbortController().signal, 8000);
    const result = await p.evidenceAttribution!(input, ctx);
    expect(result).toMatchObject({ output, model: ATTRIBUTION_MODEL, promptVersion: 'attr.a3', provider: 'anthropic' });
    const [sent, options] = (parse.mock.calls as unknown as [Record<string, any>, Record<string, any>][])[0]!;
    const [counted] = (count.mock.calls as unknown as [Record<string, any>][])[0]!;
    expect(sent).toEqual({ ...counted, max_tokens: 1200 });
    expect(sent.model).toBe('claude-haiku-5-5'); expect(sent.thinking).toEqual({ type: 'disabled' }); expect(sent.output_config.effort).toBe('low');
    expect(sent.system).toEqual([{ type: 'text', text: ATTRIBUTION_SYSTEM, cache_control: { type: 'ephemeral' } }]);
    expect(sent.messages).toEqual([{ role: 'user', content: renderAttributionUser(input) }]);
    expect(sent.output_config.format.schema).toEqual(outputFormat(AttributionWireOutputSchema).schema);
    expect(options.maxRetries).toBe(0);
    expect(await p.countEvidenceAttributionTokens!(input, ctx)).toBe(1000); expect(parse).toHaveBeenCalledOnce();
  });
  it('refuses contexts above its caps, an over-cap count and an invalid envelope, without unbilled generation', async () => {
    const { p, parse } = provider(null);
    const ctx = evidenceAttributionCtx(new AbortController().signal, 8000);
    await expect(p.evidenceAttribution!(input, { ...ctx, maxInputTokens: 5001 })).rejects.toMatchObject({ category: 'invalid_input', billing: { kind: 'none' } });
    expect(isValidStageCtx('attribution', { ...ctx, maxOutputTokens: 1201 })).toBe(false);
    expect(parse).not.toHaveBeenCalled();
    await expect(p.evidenceAttribution!(input, ctx)).rejects.toMatchObject({ category: 'invalid_output', stage: 'attribution', billing: { kind: 'usage' } });
    const over = provider(undefined, 5001);
    await expect(over.p.evidenceAttribution!(input, ctx)).rejects.toMatchObject({ category: 'cap_exceeded', billing: { kind: 'none' } });
    expect(over.parse).not.toHaveBeenCalled();
  });
});

describe('preflight and prompt mirror', () => {
  const models = { scope: 'claude-haiku-5-5', answer: 'claude-haiku-5-5', check: 'claude-haiku-5-5' };
  it('counts the real request at its largest under attributed.v1, and reports OVER instead of truncating', async () => {
    const a = attributionPreflightRequests();
    expect(a.worst.map(w => w.input.question.length)).toEqual([600, 600]);
    // The most values one check takes: the eight longest state labels, the longest year value, the three longest categories.
    expect(a.worst[0]!.input.candidates.map(c => c.id)).toEqual(['state:DC', 'state:NC', 'state:SC', 'state:MA', 'state:NH', 'state:WV',
      'state:ND', 'state:PA', 'years', 'category:PPAR', 'category:PLFT', 'category:WSFT']);
    expect(a.worst[0]!.input.candidates.slice(8).map(c => c.value)).toEqual(['1999 or earlier', 'powered parachute', 'powered-lift', 'weight-shift']);
    expect(a.worst[1]!.input.candidates).toEqual(a.worst[0]!.input.candidates);
    expect(JSON.parse(a.output).result.checks.map((c: { id: string }) => c.id)).toEqual(a.worst[0]!.input.candidates.map(c => c.id));
    const provider = createFakeProvider({ attributionCounts: input => input.candidates.length > 1 ? 5001 : 2000 });
    const reservationUsd = evidenceReservation('claude-haiku-5-5', 'text-embedding-3-small', evidenceRankingConfig(), attributed).reservationUsd;
    const rows = (await runAiPreflight(provider, async (_m, text) => Math.ceil(text.length / 4), models,
      { embeddingModel: 'text-embedding-3-small', reservationUsd, autoFilters: attributed })).filter(r => r.stage === 'attribution');
    expect(rows.map(r => [r.request, r.limit, r.ok])).toEqual([
      ['attr.a3: fixed prompt + schema', 5000, true], ['attr.a3: cached prefix', CACHED_PREFIX_MAX, true],
      ['attr.a3: most values, 600-character Latin question', 5000, false], ['attr.a3: most values, 600-character dense question', 5000, false],
      ['attr.a3: output at its schema bounds', 1200, true]]);
    expect(rows.every(r => r.model === 'claude-haiku-5-5')).toBe(true);
    expect(provider.calls).toHaveLength(0);
    // The reservation must cover the check, and no other policy counts it.
    await expect(runAiPreflight(provider, async () => 1, models, { embeddingModel: 'text-embedding-3-small', reservationUsd: 0.0025, autoFilters: attributed }))
      .rejects.toThrow('reservation too small');
    expect((await runAiPreflight(provider, async () => 1, models, { embeddingModel: 'text-embedding-3-small', reservationUsd: 0.0025 }))
      .some(r => r.stage === 'attribution')).toBe(false);
  });
  it('mirrors attr.a3 with its user turn as a template', () => {
    const mirror = MIRRORED_PROMPTS.find(p => p.name === 'aircase-attr.a3')!;
    expect(mirror.prompt).toEqual([{ role: 'system', content: ATTRIBUTION_SYSTEM },
      { role: 'user', content: '<question>\n{{question}}\n</question>\nCandidates from AirCase: {{candidates_json}}' }]);
  });
});
