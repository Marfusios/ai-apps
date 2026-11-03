/** Task 30's evaluation harness, offline: probe schema, scoring, exact bounds, the decision rule, sizing and request shapes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeWarnings, validateProbes, type Probe } from '../../evals/auto-filters/probes.js';
import {
  attributedRequest, attributionSampleMicros, autoFilters, binomialCdf, buttonFilters, c2Verdict, chargeableSampleMicros, confusion, decideField,
  editRequest, exactLower, exactUpper, fieldKey, fieldOutcome, fieldSummary, fittedTerms, groupSummary, liveRequest, nextStreak30, positiveRecall,
  precisionOf, q0Request, questionPrecision, replayScope, retrievalQuestionMicros, review24Unsafe, scriptedScopeOutput, stageMicros30, trapFailures,
  trapStops, v13Replay, wholeObject, wholeOutcome, Z_ONE_SIDED_95, Z_SIMULTANEOUS, type AutoFilters, type DecisionInputs, type ScoredSample,
  MAX_SHARDS, PART_BUDGET_MICROS, PARTS, TASK30_FAMILY, laneCapMicros, laneLockKey, laneSpec, parseShard, shardItems,
} from '../../evals/auto-filters/plan.js';
import { categoryAllowanceMicros } from '../../evals/langfuse/money.js';
import { wilson } from '../../evals/search-quality/field-score.js';
import { validateEvidenceScope } from '../../server/ai/prompts/scope.e1.js';
import { attributionStage, autoFilterIdentity, autoFilterPolicy } from '../../server/evidence/auto-filters.js';
import { attributionWorstCaseUsd } from '../../server/evidence/pricing.js';
import { evidenceRankingConfig } from '../../server/evidence/ranking-config.js';
import { stageWorstCaseUsd } from '../../server/ai/pricing.js';
import type { SearchObservation } from '../../evals/search-quality/ab-types.js';
import type { C2Dataset } from '../../evals/search-quality/part5/field-score.js';
import replay from '../fixtures/state-field-replay.json' with { type: 'json' };
import { createFakeProvider } from '../../server/ai/fake.js';
import { loadConfig } from '../../shared/config.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import { evidenceCases } from '../../web/mock/evidence.js';
import { productionPort } from '../../evals/search-quality/ab-production.js';
import { attributionPort } from '../../evals/auto-filters/port.js';
import { currentIdentities } from '../../evals/auto-filters/run.js';
import { attemptKey } from '../../evals/auto-filters/inputs.js';
import type { AttributionPart, Row30, ScriptedScope } from '../../evals/auto-filters/plan.js';
import type { CappedAllocation } from '../../evals/langfuse/money.js';
import type { Db } from '../../server/db/client.js';
import type { Client } from '@elastic/elasticsearch';
import type { PinnedDataset } from '../../server/dataset.js';

const probe = (over: Partial<Probe> = {}): Probe => ({ id: 'wa-state-001', question: 'Find accidents in Ohio.', forced: { state: ['OH'] }, gold: { state: ['OH'] },
  field: 'state', kind: 'positive', pattern: 'plain-location', source: 'writer-a', ...over });
const file = (probes: unknown[]) => ({ version: 'task30-probes-v1', probes });

describe('Task 30 probe files', () => {
  it('accepts a valid development file and refuses confirmation sources in it', () => {
    const ok = validateProbes(file([probe(), probe({ id: 'cx-years-001', question: 'Crashes after 2015', forced: { yearFrom: 2015, yearTo: 2015 },
      gold: { yearFrom: 2016 }, field: 'years', kind: 'trap', source: 'codex' })]), 'dev');
    expect(ok.probes).toHaveLength(2);
    expect(() => validateProbes(file([probe({ source: 'c1' })]), 'dev')).toThrow(/c1 is not a dev source/);
    expect(() => validateProbes(file([probe({ source: 'writer-a' })]), 'confirm')).toThrow(/writer-a is not a confirm source/);
    expect(validateProbes(file([probe({ source: 'c6' })]), 'confirm').probes).toHaveLength(1);
  });
  it.each([
    ['an unknown key', { ...probe(), note: 'x' }],
    ['a question over 300 characters', probe({ question: 'a'.repeat(301) })],
    ['an empty forced object', probe({ forced: {} })],
    ['an unknown state', probe({ forced: { state: ['XX'] } })],
    ['a repeated value', probe({ forced: { state: ['OH', 'OH'] } })],
    ['an inverted year range', probe({ forced: { yearFrom: 2019, yearTo: 2018 }, field: 'years' })],
    ['a gold year outside 1900 to 2100', probe({ forced: { yearFrom: 1899 }, gold: { yearFrom: 1899 }, field: 'years' })],
    ['a forced number that is no four-digit year', probe({ forced: { yearFrom: 999 }, gold: {}, field: 'years', kind: 'trap' })],
    ['an empty set', probe({ gold: { state: [] } })],
    ['UNK in gold', probe({ forced: { category: ['UNK'] }, gold: { category: ['UNK'] }, field: 'category' })],
    ['a territory in gold', probe({ forced: { state: ['PR'] }, gold: { state: ['PR'] } })],
    ['forced without the probe field', probe({ field: 'years' })],
    ['an unknown kind', { ...probe(), kind: 'control' }],
  ])('refuses %s', (_name, p) => {
    expect(() => validateProbes(file([p]), 'dev')).toThrow(/Invalid dev probe file/);
  });
  it('accepts forced values that can never be applied (a territory, UNK, a four-digit number that is no event year)', () => {
    expect(validateProbes(file([probe({ forced: { state: ['PR'] }, gold: {}, kind: 'trap' }),
      probe({ id: 'b-years-036', question: 'pilots with 1500 hours who crashed on night VFR flights', forced: { yearFrom: 1500, yearTo: 1500 }, gold: {}, field: 'years', kind: 'trap' })]), 'dev').probes).toHaveLength(2);
  });
  it('refuses repeated ids and repeated questions (whitespace and case normalised)', () => {
    expect(() => validateProbes(file([probe(), probe({ question: 'Other' })]), 'dev')).toThrow(/repeated id/);
    expect(() => validateProbes(file([probe(), probe({ id: 'wa-state-002', question: '  find   ACCIDENTS in Ohio. ' })]), 'dev')).toThrow(/same question as wa-state-001/);
    expect(() => validateProbes({ version: 'task30-probes-v2', probes: [probe()] }, 'dev')).toThrow(/Invalid dev probe file/);
  });
  it('reports kind labels that disagree with forced and gold, without refusing the file', () => {
    const w = probeWarnings(validateProbes(file([probe({ kind: 'trap' }), probe({ id: 'b', question: 'b', gold: { state: ['OH'], yearFrom: 2019, yearTo: 2019 } })]), 'dev'));
    expect(w).toEqual({ kindMismatch: ['wa-state-001'], goldNotForced: ['b:years'] });
  });
});

const sample = (over: Partial<ScoredSample> & { applied?: AutoFilters; gold?: AutoFilters }): ScoredSample => ({ itemId: 'i1', sample: 1, applied: {}, gold: {},
  forced: null, reasons: {}, scopeOutcome: 'used', attributionOutcome: 'not_run', tags: {}, ...over });

describe('Task 30 field scoring', () => {
  it('normalises the automatic fields only, sets sorted and empty sets dropped', () => {
    expect(autoFilters({ state: ['OH', 'AK', 'OH'], category: [], yearTo: 2019, phase: ['LANDING'] } as never)).toEqual({ state: ['AK', 'OH'], yearTo: 2019 });
    expect(fieldKey({ yearFrom: 2015, yearTo: 2018 }, 'years')).toBe('2015..2018');
    expect(fieldKey({ yearFrom: 2016 }, 'years')).toBe('2016..');
    expect(fieldKey({}, 'category')).toBeNull();
  });
  it('separates a wrong value from an application on a trap', () => {
    expect(fieldOutcome({ state: ['AK'] }, { state: ['AK'] }, 'state')).toBe('tp');
    expect(fieldOutcome({ state: ['AK', 'HI'] }, { state: ['AK'] }, 'state')).toBe('wrong_value');
    expect(fieldOutcome({ state: ['AK'] }, {}, 'state')).toBe('applied_on_trap');
    expect(fieldOutcome({}, { state: ['AK'] }, 'state')).toBe('fn');
    expect(fieldOutcome({}, {}, 'state')).toBe('tn');
  });
  it('scores years as one field: both bounds must match', () => {
    expect(fieldOutcome({ yearFrom: 2015, yearTo: 2015 }, { yearFrom: 2016 }, 'years')).toBe('wrong_value');
    expect(fieldOutcome({ yearFrom: 2016 }, { yearFrom: 2016, yearTo: 2018 }, 'years')).toBe('wrong_value');
    expect(fieldOutcome({ yearFrom: 2016, yearTo: 2018 }, { yearFrom: 2016, yearTo: 2018 }, 'years')).toBe('tp');
    expect(fieldOutcome({ yearTo: 1999 }, {}, 'years')).toBe('applied_on_trap');
  });
  it('counts TP, both kinds of FP, FN and TN', () => {
    const c = confusion([sample({ applied: { state: ['AK'] }, gold: { state: ['AK'] } }), sample({ applied: { state: ['AK', 'HI'] }, gold: { state: ['AK'] } }),
      sample({ applied: { state: ['TX'] } }), sample({ gold: { state: ['OH'] } }), sample({})], 'state');
    expect(c).toEqual({ samples: 5, tp: 1, fp: 2, wrongValue: 1, appliedOnTrap: 1, fn: 2, tn: 1 });
    expect(precisionOf(c)).toMatchObject({ applied: 3, correct: 1, rate: 1 / 3 });
  });
});

describe('Task 30 bounds', () => {
  it('uses Wilson with the one-sided 95% and the simultaneous quantiles', () => {
    expect(wilson(400, 400, Z_ONE_SIDED_95).lower).toBeCloseTo(0.9932815837823105, 12);
    expect(wilson(400, 400, Z_SIMULTANEOUS).lower).toBeCloseTo(0.9904877056657034, 12);
    expect(wilson(9, 10, Z_ONE_SIDED_95).lower).toBeCloseTo(0.6522813326641417, 12);
    expect(precisionOf({ samples: 400, tp: 400, fp: 0, wrongValue: 0, appliedOnTrap: 0, fn: 0, tn: 0 })).toMatchObject({
      lower95: expect.closeTo(0.9932815837823105, 12), simultaneousLower: expect.closeTo(0.9904877056657034, 12), exactLower95: expect.closeTo(0.05 ** (1 / 400), 12) });
  });
  it('computes exact one-sided Clopper–Pearson bounds (values checked with an independent exact binomial bisection)', () => {
    expect(exactUpper(0, 299)).toBeCloseTo(0.009969146792899286, 12);
    expect(exactUpper(0, 299)).toBeLessThanOrEqual(0.01);
    expect(exactUpper(0, 298)).toBeGreaterThan(0.01);
    expect(exactLower(149, 149)).toBeCloseTo(0.9800951837793149, 12);
    expect(exactLower(149, 149)).toBeGreaterThanOrEqual(0.98);
    expect(exactLower(148, 148)).toBeLessThan(0.98);
    expect(exactUpper(1, 10)).toBeCloseTo(0.3941633024365049, 9);
    expect(exactLower(9, 10)).toBeCloseTo(0.6058366975634952, 9);
    expect(exactUpper(3, 330)).toBeCloseTo(0.023327179612583404, 9);
    expect(exactLower(300, 310)).toBeCloseTo(0.9458975162493595, 9);
    expect(exactUpper(5, 5)).toBe(1); expect(exactLower(0, 5)).toBe(0);
    expect(binomialCdf(1, 10, exactUpper(1, 10))).toBeCloseTo(0.05, 9);
    expect(() => exactUpper(3, 2)).toThrow();
  });
});

const trapItem = (id: string, applied: AutoFilters[], reasons: string[], tags: Record<string, string> = {}): ScoredSample[] =>
  applied.map((a, i) => sample({ itemId: id, sample: i + 1, applied: a, gold: {}, forced: { state: ['AK'] }, reasons: { state: reasons[i] }, tags }));
const positiveItem = (id: string, applied: AutoFilters[], reasons: string[], tags: Record<string, string> = {}): ScoredSample[] =>
  applied.map((a, i) => sample({ itemId: id, sample: i + 1, applied: a, gold: { state: ['OH'] }, forced: { state: ['OH'] }, reasons: { state: reasons[i] }, tags }));

describe('Task 30 question-level trap and precision measures', () => {
  const rows = [
    ...trapItem('t1', [{}, {}, {}], ['not_candidate:negated', 'not_candidate:negated', 'not_candidate:negated'], { source: 'writer-a', pattern: 'negation' }),
    ...trapItem('t2', [{}, { state: ['AK'] }, {}], ['attribution:aircraft_history', 'applied', 'bad_quote'], { source: 'review-24', pattern: 'maintenance' }),
    ...trapItem('t3', [{}, {}, {}], ['attribution:person', 'attribution_unavailable', 'attribution:person'], { source: 'codex', pattern: 'maintenance' }),
    ...positiveItem('p1', [{ state: ['OH'] }, { state: ['OH'] }, {}], ['applied', 'applied', 'attribution:unclear'], { source: 'writer-a', pattern: 'plain' }),
    ...positiveItem('p2', [{}, {}, {}], ['not_candidate:not_explicit', 'not_candidate:not_explicit', 'not_candidate:not_explicit'], { source: 'writer-b', pattern: 'plain' }),
  ];
  it('fails a trap item when any sample applied a value gold does not hold, with exact upper bounds', () => {
    const t = trapFailures(rows, 'state');
    expect(t).toMatchObject({ items: 3, failures: 1, failedItems: ['t2'], samples: 9, failedSamples: 1 });
    expect(t.upper95).toBeCloseTo(exactUpper(1, 3), 12);
    expect(t.sampleUpper95).toBeCloseTo(exactUpper(1, 9), 12);
  });
  it('counts only the samples the check answered for the model-only rate', () => {
    // t1 never reached the check; t3's unavailable sample is not an answer.
    expect(trapFailures(rows, 'state', true)).toMatchObject({ items: 2, failures: 1, samples: 5, failedSamples: 1 });
  });
  it('reports how each trap sample was stopped', () => {
    expect(trapStops(rows, 'state')).toEqual({
      byCategory: { applied: 1, attribution: 3, attribution_unavailable: 1, bad_quote: 1, not_candidate: 3 },
      byReason: { applied: 1, 'attribution:aircraft_history': 1, 'attribution:person': 2, attribution_unavailable: 1, bad_quote: 1, 'not_candidate:negated': 3 },
    });
  });
  it('counts precision once per question that applied the field, wrong if any sample was wrong', () => {
    const p = questionPrecision(rows, 'state');
    expect(p).toMatchObject({ applications: 2, wrong: 1, correct: 1, wrongItems: ['t2'] });
    expect(p.lower95).toBeCloseTo(exactLower(1, 2), 12);
  });
  it('reports recall on positives with candidate coverage and the check-only share', () => {
    expect(positiveRecall(rows, 'state')).toMatchObject({ items: 2, samples: 6, found: 2, allSamples: 0, anySample: 1,
      candidateSamples: 3, modelOnly: { samples: 3, found: 2 } });
  });
  it('counts, for a real scope, every item whose gold holds the field as a positive (a wrong forced bound included)', () => {
    // "accidents before 2000": a naive scope proposes yearTo 2000; gold is 1999. Forced, it is a trap; end to end, a positive.
    const wrongBound = [1, 2, 3].map(n => sample({ itemId: 'y1', sample: n, applied: n === 1 ? { yearTo: 1999 } : {}, gold: { yearTo: 1999 }, forced: { yearTo: 2000 },
      reasons: { years: n === 1 ? 'applied' : 'not_candidate:range_mismatch' } }));
    expect(positiveRecall(wrongBound, 'years')).toMatchObject({ items: 0 });
    expect(positiveRecall(wrongBound, 'years', 'gold')).toMatchObject({ items: 1, samples: 3, found: 1, anySample: 1 });
    expect(trapFailures(wrongBound, 'years')).toMatchObject({ items: 1, failures: 0 });
    expect(trapStops(wrongBound, 'years').byReason).toEqual({ applied_gold: 1, 'not_candidate:range_mismatch': 2 });
  });
  it('breaks results down by tag and finds unsafe review-24 applications', () => {
    const g = groupSummary(rows, 'pattern');
    expect(g.maintenance!.fields.state).toMatchObject({ tp: 0, fp: 1, fn: 0, traps: 2, trapFailures: 1, applications: 1, wrong: 1 });
    expect(g.plain!.fields.state).toMatchObject({ positives: 2, positiveSamples: 6, found: 2 });
    expect(review24Unsafe(rows, 'state')).toEqual({ samples: 1, items: ['t2'] });
    expect(review24Unsafe(rows.filter(r => r.itemId !== 't2'), 'state')).toEqual({ samples: 0, items: [] });
  });
  it('compares the whole filter object, restricted to the policy fields', () => {
    expect(wholeOutcome({ applied: { state: ['OH'], yearFrom: 2019, yearTo: 2019 }, gold: { state: ['OH'], yearFrom: 2019, yearTo: 2019 } }, ['state', 'years', 'category'])).toBe('exact');
    expect(wholeOutcome({ applied: { state: ['OH'] }, gold: { state: ['OH'], yearFrom: 2019, yearTo: 2019 } }, ['state', 'years', 'category'])).toBe('partial');
    expect(wholeOutcome({ applied: { state: ['OH'] }, gold: { state: ['OH'], yearFrom: 2019, yearTo: 2019 } }, ['state'])).toBe('exact');
    expect(wholeOutcome({ applied: { state: ['OH'], category: ['HELI'] }, gold: { state: ['OH'] } }, ['state', 'years', 'category'])).toBe('unsafe');
    expect(wholeOutcome({ applied: {}, gold: { state: ['OH'] } }, ['state'])).toBe('missed');
    expect(wholeOutcome({ applied: {}, gold: {} }, ['state'])).toBe('abstained');
    expect(wholeObject(rows, ['state'])).toEqual({ samples: { abstained: 8, exact: 2, missed: 4, unsafe: 1 }, questions: { abstained: 2, incomplete: 2, unsafe: 1 } });
  });
  it('summarises a field with both denominators', () => {
    const s = fieldSummary(rows, 'state', true);
    expect(s.traps!.policy.items).toBe(3); expect(s.traps!.modelOnly.items).toBe(2);
    expect(s.confusion).toMatchObject({ tp: 2, appliedOnTrap: 1 });
    expect(fieldSummary(rows.map(r => ({ ...r, forced: null })), 'state', true).traps).toBeUndefined();
  });
});

describe('Task 30 per-field decision', () => {
  const traps = (items: number, failures: number) => ({ policy: { items, failures, rate: failures / items, upper95: exactUpper(failures, items) } });
  const precision = (applications: number, wrong: number) => ({ applications, wrong, rate: (applications - wrong) / applications, lower95: exactLower(applications - wrong, applications) });
  const dev = (unsafe: string[] = []): DecisionInputs['development'] => [{ part: 'dev-forced', unsafe: { samples: unsafe.length, items: unsafe } }, { part: 'dev-e2e', unsafe: { samples: 0, items: [] } }];
  const inputs = (t: ReturnType<typeof traps>, p: ReturnType<typeof precision>, development = dev(), e2eRecall = 0.6): DecisionInputs => ({ enabled: true,
    confirmForced: { traps: t, questionPrecision: p, positives: { rate: 0.7 } }, confirmE2e: { positives: { rate: e2eRecall } }, development }) as unknown as DecisionInputs;
  it('turns a field on only when every safety rule passes', () => {
    expect(decideField('state', inputs(traps(330, 0), precision(160, 0)))).toMatchObject({ on: true, trap: { verdict: 'pass' }, precision: { verdict: 'pass' }, review24: { verdict: 'pass' }, recall: { useful: true } });
  });
  it('keeps a field off on insufficient denominators, a straddling bound, a failure or a review-24 veto', () => {
    expect(decideField('state', inputs(traps(298, 0), precision(160, 0)))).toMatchObject({ on: false, trap: { verdict: 'insufficient' } });
    expect(decideField('state', inputs(traps(330, 1), precision(160, 0)))).toMatchObject({ on: false, trap: { verdict: 'straddles' } });
    expect(decideField('state', inputs(traps(330, 10), precision(160, 0)))).toMatchObject({ on: false, trap: { verdict: 'fail' } });
    expect(decideField('state', inputs(traps(330, 0), precision(148, 0)))).toMatchObject({ on: false, precision: { verdict: 'insufficient' } });
    expect(decideField('state', inputs(traps(330, 0), precision(200, 2)))).toMatchObject({ on: false, precision: { verdict: 'straddles' } });
    expect(decideField('state', inputs(traps(330, 0), precision(160, 0), dev(['r24-001'])))).toMatchObject({ on: false, review24: { verdict: 'veto', unsafeItems: ['r24-001'] } });
    expect(decideField('state', inputs(traps(330, 0), precision(160, 0), [{ part: 'dev-forced', unsafe: { samples: 0, items: [] } }, { part: 'dev-e2e', unsafe: null }])))
      .toMatchObject({ on: false, review24: { verdict: 'missing' } });
  });
  it('reports low end-to-end recall as not useful, and missing or disabled fields as off', () => {
    expect(decideField('state', inputs(traps(330, 0), precision(160, 0), dev(), 0.4))).toMatchObject({ on: true, recall: { useful: false } });
    expect(decideField('years', { enabled: true, confirmForced: null, confirmE2e: null, development: [] })).toMatchObject({ on: false, trap: { verdict: 'missing' }, recall: { useful: null } });
    expect(decideField('category', { ...inputs(traps(330, 0), precision(160, 0)), enabled: false })).toMatchObject({ on: false, why: 'not in the evaluated policy' });
  });
});

describe('Task 30 provider stop', () => {
  it('counts AI calls only: three consecutive infrastructure outcomes stop, a scripted-only sample neither counts nor resets', () => {
    let streak = 0;
    for (const calls of [{ attribution: 'timeout' }, {}, { scope: 'used', attribution: 'overloaded' }, {}, { scope: 'rate_limited' }]) streak = nextStreak30(streak, calls);
    expect(streak).toBe(3);
    expect(nextStreak30(2, { scope: 'used', attribution: 'applied' })).toBe(0);
    expect(nextStreak30(2, {})).toBe(2);
    expect(nextStreak30(1, { scope: 'used', rerank: 'provider_error' })).toBe(2);
  });
});

describe('Task 30 scripted scope', () => {
  it('returns the forced filters as a valid search with the question as terms', () => {
    const out = scriptedScopeOutput('Find  accidents\nin Ohio.', { kind: 'search', filters: { state: ['OH'] } });
    expect(out).toEqual({ intent: 'case_search', filters: { state: ['OH'] }, terms: 'Find accidents in Ohio.' });
    expect(validateEvidenceScope(out)).toEqual(out);
    const long = `${'word '.repeat(70)}end`;
    expect(fittedTerms(long).length).toBeLessThanOrEqual(300);
    expect(fittedTerms(long).endsWith('word')).toBe(true);
  });
  it('replays recorded intents: a search with the emitted states, other intents as themselves, a null intent as a failure', () => {
    expect(replayScope('case_search', ['AZ', 'NE'])).toEqual({ kind: 'search', filters: { state: ['AZ', 'NE'] } });
    expect(replayScope('case_search', [])).toEqual({ kind: 'search', filters: {} });
    expect(replayScope('case_comparison', ['AZ'])).toEqual({ kind: 'intent', intent: 'case_comparison' });
    expect(validateEvidenceScope(scriptedScopeOutput('q', { kind: 'intent', intent: 'out_of_scope' }))).toEqual({ intent: 'out_of_scope', filters: {} });
    expect(replayScope(null, ['AZ'])).toEqual({ kind: 'failure' });
    expect(() => replayScope('chat', [])).toThrow();
  });
});

describe('Task 30 retrieval requests', () => {
  const policy = autoFilterPolicy('none');
  const parent = { executed: { lexical: 'q', vector: 'q' }, lexicalSource: 'question', addedTerms: null,
    suggestion: { filters: { yearFrom: 2019, yearTo: 2019, phase: ['landing'] }, terms: 'icing' }, appliedFilters: { state: ['AK'] } } as unknown as SearchObservation;
  it('sends no filters on the first searches; QH50+A also sends the policy', () => {
    expect(liveRequest()).toEqual({ filters: {} });
    expect(q0Request()).toEqual({ filters: {}, skipScope: true });
    expect(attributedRequest(policy)).toEqual({ filters: {}, autoFilters: policy });
  });
  it('edits with the applied (automatic) filters plus the remaining suggestion, as "Apply these filters" does', () => {
    const filters = buttonFilters(parent)!;
    expect(filters).toEqual({ state: ['AK'], yearFrom: 2019, yearTo: 2019, phase: ['landing'] });
    expect(editRequest(filters, parent, policy)).toEqual({ filters, edited: { executed: parent.executed, lexicalSource: 'question', addedTerms: null }, autoFilters: policy });
    expect(buttonFilters({ ...parent, suggestion: { filters: {}, terms: 'icing' } })).toBeNull();
    // Without automatic filters it is Task 29's request.
    expect(buttonFilters({ ...parent, appliedFilters: {} })).toEqual({ yearFrom: 2019, yearTo: 2019, phase: ['landing'] });
  });
});

describe('Task 30 sizing', () => {
  const s = stageMicros30(evidenceRankingConfig('er-q-v1'), evidenceRankingConfig('er-q-h50-v1'), stageWorstCaseUsd('claude-haiku-5-5', { input: 3000, output: 500 }));
  it('sizes the attribution check at its caps with the whole input cache-written ($0.000625)', () => {
    expect(s.attribution).toBe(625);
    expect(() => stageMicros30(evidenceRankingConfig('er-q-v1'), evidenceRankingConfig('er-q-h50-v1'), 0)).toThrow();
    expect(attributionSampleMicros(s)).toBe(s.scope + 625 + s.embed);
    expect(chargeableSampleMicros(s, true)).toBe(625);
    expect(chargeableSampleMicros(s, false)).toBe(s.scope + 625);
  });
  it('sizes a retrieval question from its rows', () => {
    expect(retrievalQuestionMicros(s, 3)).toBe(s.embed + 3 * (2 * s.scope + s.attribution + 4 * s.embed + 4 * s.rerank));
  });
});

describe('Task 30 recorded answers', () => {
  it('recomputes v1.3 on the 1,040 recorded answers exactly as recorded', () => {
    expect(v13Replay(replay.cases)).toEqual({ guard: { tp: 365, fp: 0, fn: 35 }, pipeline: { tp: 363, fp: 0, fn: 37 } });
  });
  it('applies C2\'s registered rule to the applied fields', () => {
    const qs = Array.from({ length: 1600 }, (_, i) => {
      const field = i < 800 ? 'yearRange' as const : 'category' as const, positive = i % 800 < 400;
      return { id: `q${i}`, field, role: positive ? 'positive' : 'control', critical: !positive, wordingFamily: 'f', stratum: positive ? 'p' : 'c',
        question: 'q', gold: positive ? (field === 'yearRange' ? { yearFrom: 2019, yearTo: 2019 } : { category: ['HELI'] }) : {} };
    });
    const dataset = { version: 'task24-fields-c2-v1', source: {}, questions: qs } as unknown as C2Dataset;
    const perfect = qs.map(q => ({ id: q.id, applied: q.gold as AutoFilters, failed: false }));
    expect(c2Verdict(dataset, perfect).clears).toEqual({ yearRange: true, category: true });
    const oneWrong = perfect.map(s => s.id === 'q900' ? { ...s, applied: { category: ['AIR'] } } : s);
    const v = c2Verdict(dataset, oneWrong);
    expect(v.clears).toEqual({ yearRange: true, category: false });
    expect(v.category).toMatchObject({ fp: 1, tp: 399, errorIds: ['q900'] });
    // A year applied on a category question is an auxiliary, critical false application.
    expect(c2Verdict(dataset, perfect.map(s => s.id === 'q1300' ? { ...s, applied: { yearFrom: 2019, yearTo: 2019 } } : s)).yearRange).toMatchObject({ fp: 1, criticalFp: 1 });
    expect(c2Verdict(dataset, perfect.slice(1)).clears).toEqual({ yearRange: false, category: false });
  });
});

describe('Task 30 frozen inputs and items', () => {
  it('checks the state replay against its audited run and Task 24\'s frozen field set', async () => {
    const { loadReplay, REPLAY_OBSERVATIONS_SHA256 } = await import('../../evals/auto-filters/inputs.js');
    const r = loadReplay();
    expect(r.cases).toHaveLength(1040);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(replay.observationsSha256).toBe(REPLAY_OBSERVATIONS_SHA256);
    const dir = mkdtempSync(join(tmpdir(), 'task30-replay-'));
    try {
      const tamper = (change: (d: typeof replay) => unknown) => {
        const path = join(dir, 'replay.json');
        writeFileSync(path, JSON.stringify(change(structuredClone(replay))));
        return () => loadReplay(path);
      };
      expect(tamper(d => ({ ...d, observationsSha256: '0'.repeat(64) }))).toThrow(/observations changed/);
      expect(tamper(d => ({ ...d, questionsSha256: '0'.repeat(64) }))).toThrow(/questions changed/);
      expect(tamper(d => ({ ...d, cases: d.cases.map((c, i) => i === 7 ? { ...c, gold: ['TX'] } : c) }))).toThrow(/disagrees with the frozen field set/);
      expect(tamper(d => ({ ...d, cases: d.cases.slice(1) }))).toThrow(/membership/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('checks C2 against its field manifest', async () => {
    const { loadC2 } = await import('../../evals/auto-filters/inputs.js');
    const c = loadC2();
    expect(c.dataset.questions).toHaveLength(1600);
    expect(c.sha256).toBe('7dfdf59ab386bee17645f3c3f073dcd3af700aa1ef6cda7c6ab7aa5f8ae3eca6');
    const dir = mkdtempSync(join(tmpdir(), 'task30-c2-'));
    try {
      const path = join(dir, 'fields.json');
      writeFileSync(path, JSON.stringify({ ...c.dataset, questions: c.dataset.questions.slice(1) }));
      expect(() => loadC2(path)).toThrow(/C2 field set changed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('maps each input to what its scope answers, its gold and its proposed values', async () => {
    const { replayItems, c2Items, probeItems, seededOrder, attemptKey, loadC2 } = await import('../../evals/auto-filters/inputs.js');
    const items = replayItems(replay.cases);
    const byId = (id: string) => items.find(i => i.id === id)!;
    expect(byId('t24-field-state-positive-001')).toMatchObject({ gold: { state: ['AZ', 'NE'] }, forced: { state: ['AZ', 'NE'] },
      scripted: { kind: 'search', filters: { state: ['AZ', 'NE'] } }, tags: { field: 'state', role: 'positive', intent: 'case_search' } });
    const failed = items.find(i => i.tags.intent === 'scope_failure')!;
    expect(failed).toMatchObject({ scripted: { kind: 'failure' }, forced: {} });
    expect(items.filter(i => i.scripted?.kind === 'intent')).toHaveLength(99);
    const c2 = c2Items(loadC2().dataset);
    expect(c2.find(i => i.id === 't24-c2-yearRange-positive-001')).toMatchObject({ gold: { yearFrom: 2024, yearTo: 2024 }, forced: null, scripted: null,
      tags: { field: 'yearRange', role: 'positive' } });
    const loaded = { family: 'dev' as const, path: 'x', sha256: 'y', file: validateProbes(file([probe()]), 'dev') };
    expect(probeItems(loaded, true)[0]).toMatchObject({ scripted: { kind: 'search', filters: { state: ['OH'] } }, forced: { state: ['OH'] }, gold: { state: ['OH'] },
      tags: { source: 'writer-a', pattern: 'plain-location', kind: 'positive', field: 'state' } });
    expect(probeItems(loaded, false)[0]!.scripted).toBeNull();
    const order = seededOrder(items);
    expect(order.map(i => i.id)).toEqual(seededOrder(items).map(i => i.id));
    expect([...order.map(i => i.id)].sort()).toEqual([...items.map(i => i.id)].sort());
    expect(order[0]!.id).not.toBe(items[0]!.id);
    const keys = new Set([attemptKey('l', 'dev-forced', 'i', 1), attemptKey('l', 'dev-e2e', 'i', 1), attemptKey('l', 'dev-forced', 'i', 2),
      attemptKey('m', 'dev-forced', 'i', 1), attemptKey('l', 'retrieval', 'i', 1, 'QH50', 'trackc-dev'), attemptKey('l', 'retrieval', 'i', 1, 'QH50+A', 'trackc-dev')]);
    expect(keys.size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Through the production entry point (`rankEvidence` and the evaluation gate) with offline fakes.

const mocks = vi.hoisted(() => ({ provider: undefined as any, search: vi.fn(), active: vi.fn() }));
vi.mock('../../server/ai/anthropic.js', async original => ({ ...await original<typeof import('../../server/ai/anthropic.js')>(), createAnthropicProvider: () => mocks.provider }));
vi.mock('../../server/ai/embeddings.js', async original => ({ ...await original<typeof import('../../server/ai/embeddings.js')>(),
  createOpenAIQueryEmbedder: () => ({ model: 'text-embedding-3-small', dims: 1536, usdPerMillionTokens: .02, embed: vi.fn(), embedWithSignal: vi.fn() }) }));
vi.mock('../../server/db/generations.js', async original => ({ ...await original<typeof import('../../server/db/generations.js')>(), getActiveManifest: mocks.active }));
vi.mock('../../server/evidence/retrieve.js', async original => ({ ...await original<typeof import('../../server/evidence/retrieve.js')>(),
  createEvidenceRetriever: () => ({ available: async () => true, search: mocks.search }) }));

const settings = { env: {}, config: loadConfig({ files: [], env: { APP_ENV: 'dev', ANTHROPIC_API_KEY: 'synthetic', OPENAI_API_KEY: 'synthetic' } }) };
const attributed = () => autoFilterPolicy('attributed.v1');
let portDir: string;
beforeEach(() => { portDir = mkdtempSync(join(tmpdir(), 'task30-port-')); });
afterEach(() => rmSync(portDir, { recursive: true, force: true }));
function gateSetup(limit = 10) {
  const memory = createMemorySpendGate(limit), gate = vi.fn(() => memory);
  return { memory, gate, allocation: { gate } as unknown as CappedAllocation };
}
const charged = (memory: ReturnType<typeof createMemorySpendGate>, stage: string) => memory.records.filter(r => r.purpose.endsWith(`:${stage}`)).map(r => r.chargedUsd);

describe('Task 30 attribution parts through the production entry point', () => {
  const item = (question: string, scripted: ScriptedScope | null) => ({ id: 'p1', question, scripted });
  const attempt = { key: 'synthetic-attempt', part: 'dev-forced' as const, itemId: 'p1', sample: 1 };
  it('settles the scripted scope at $0 through the gate and applies a state the check attributes to the accident', async () => {
    mocks.provider = createFakeProvider();
    const h = gateSetup(), port = attributionPort(settings, h.allocation, 'selection', 'a'.repeat(64), portDir, attributed());
    const o = await port.run(attempt, item('Find accidents in Alaska involving engine power loss.', { kind: 'search', filters: { state: ['AK'] } }));
    expect(o.failure).toBeNull(); expect(o.safetyFaults).toEqual([]);
    expect(o).toMatchObject({ scope: 'scripted', intent: 'case_search', emitted: { state: ['AK'] }, scopeOutcome: 'used', automaticFilters: { state: ['AK'] },
      autoFilterFields: { state: 'applied' }, attributionOutcome: 'applied', attributionCalled: true, appliedFilters: { state: ['AK'] } });
    expect(mocks.provider.calls.map((c: { stage: string }) => c.stage)).toEqual(['attribution']);
    expect(h.gate.mock.calls.map(c => (c as unknown[])[4])).toEqual(['scope', 'attribution', 'embed']);
    expect(charged(h.memory, 'scope')).toEqual([0]); expect(charged(h.memory, 'embed')).toEqual([0]);
    expect(charged(h.memory, 'attribution')[0]).toBeGreaterThan(0);
    expect(h.memory.records.every(r => r.status === 'settled')).toBe(true);
    expect(o.actualUsd).toBeCloseTo(charged(h.memory, 'attribution')[0]!, 9);
    expect(o.candidates).toEqual([{ id: 'state', values: ['Alaska (AK)'] }]);
  });
  it('leaves a trap unapplied when the check attributes it elsewhere', async () => {
    mocks.provider = createFakeProvider({ evidenceAttribution: input => ({ output: { checks: input.candidates.map(c => ({ id: c.id, about: 'aircraft_history' as const, quote: 'Alaska' })) } }) });
    const h = gateSetup(), port = attributionPort(settings, h.allocation, 'selection', 'a'.repeat(64), portDir, attributed());
    const o = await port.run(attempt, item('Find accidents involving aircraft maintained in Alaska.', { kind: 'search', filters: { state: ['AK'] } }));
    expect(o).toMatchObject({ failure: null, automaticFilters: null, autoFilterFields: { state: 'attribution:aircraft_history' }, attributionOutcome: 'applied', appliedFilters: {} });
  });
  it('makes no check call for a field the candidate rules stop', async () => {
    mocks.provider = createFakeProvider();
    const h = gateSetup(), port = attributionPort(settings, h.allocation, 'selection', 'a'.repeat(64), portDir, attributed());
    const o = await port.run(attempt, item('Find accidents that did not happen in Alaska.', { kind: 'search', filters: { state: ['AK'] } }));
    expect(o.failure).toBeNull();
    expect(o.autoFilterFields.state).toMatch(/^not_candidate:/);
    expect(o).toMatchObject({ attributionCalled: false, attributionOutcome: 'not_run', automaticFilters: null, actualUsd: 0 });
    expect(h.gate.mock.calls.map(c => (c as unknown[])[4])).toEqual(['scope', 'embed']);
    expect(mocks.provider.calls).toHaveLength(0);
  });
  it('replays a recorded scope failure as an unbilled fallback', async () => {
    mocks.provider = createFakeProvider();
    const h = gateSetup(), port = attributionPort(settings, h.allocation, 'selection', 'a'.repeat(64), portDir, attributed());
    const o = await port.run({ ...attempt, part: 'state-replay' }, item('Find accidents in Alaska.', { kind: 'failure' }));
    expect(o).toMatchObject({ failure: null, safetyFaults: [], intent: null, scopeOutcome: 'unbilled_provider_error', autoFilterReason: 'scope_unavailable',
      autoFilterFields: {}, attributionCalled: false, automaticFilters: null, actualUsd: 0 });
  });
  it('treats a forced value no scope can carry (a year 1500) as the scope fallback a real one would be', async () => {
    mocks.provider = createFakeProvider();
    const h = gateSetup(), port = attributionPort(settings, h.allocation, 'selection', 'a'.repeat(64), portDir, attributed());
    const o = await port.run(attempt, item('pilots with 1500 hours who crashed on night VFR flights', { kind: 'search', filters: { yearFrom: 1500, yearTo: 1500 } }));
    expect(o).toMatchObject({ failure: null, safetyFaults: [], scopeOutcome: 'invalid_output', automaticFilters: null, attributionCalled: false, actualUsd: 0 });
    expect(mocks.provider.calls).toHaveLength(0);
  });
  it('charges the real scope in an end-to-end part', async () => {
    mocks.provider = createFakeProvider({ evidenceScope: { output: { intent: 'case_search', filters: { state: ['AK'], yearFrom: 2019, yearTo: 2019 }, terms: 'engine power loss' } } });
    const h = gateSetup(), port = attributionPort(settings, h.allocation, 'selection', 'a'.repeat(64), portDir, attributed());
    const o = await port.run({ ...attempt, part: 'dev-e2e' }, item('Find engine power loss accidents in Alaska in 2019.', null));
    expect(o.failure).toBeNull(); expect(o.safetyFaults).toEqual([]);
    expect(o).toMatchObject({ scope: 'real', automaticFilters: { state: ['AK'], yearFrom: 2019, yearTo: 2019 }, autoFilterFields: { state: 'applied', years: 'applied' } });
    expect(mocks.provider.calls.map((c: { stage: string }) => c.stage)).toEqual(['scope', 'attribution']);
    expect(charged(h.memory, 'scope')[0]).toBeGreaterThan(0);
    expect(o.actualUsd).toBeLessThanOrEqual(o.boundUsd);
  });
  it('dispatches nothing when the gate refuses', async () => {
    mocks.provider = createFakeProvider();
    const h = gateSetup(0), port = attributionPort(settings, h.allocation, 'selection', 'a'.repeat(64), portDir, attributed());
    const o = await port.run(attempt, item('Find accidents in Alaska.', { kind: 'search', filters: { state: ['AK'] } }));
    expect(o.failure).toBe('spend'); expect(mocks.provider.calls).toHaveLength(0);
  });
});

describe('Task 30 retrieval rows through the production entry point', () => {
  const dataset = { manifest: { generationId: 1, casesIndex: 'synthetic-cases', passagesIndex: 'synthetic-passages' } } as PinnedDataset;
  const question = { id: 'synthetic-question', question: 'Find engine power loss accidents in Alaska during landing.', relevant: ['SYNTHETIC1'], group: 'one', class: 'narrow' as const, area: 'aircraft_systems' };
  beforeEach(() => {
    mocks.active.mockReset().mockResolvedValue(dataset.manifest);
    mocks.provider = createFakeProvider({ evidenceScope: { output: { intent: 'case_search', filters: { state: ['AK'], phase: ['landing'] }, terms: 'engine power loss' } },
      rerank: input => ({ output: { grades: input.cases.map((c, i) => ({ id: c.id, grade: i % 4 })) } }) });
    mocks.search.mockReset().mockImplementation(async (_dataset, _plan, _signal, report) => {
      report({ model: 'text-embedding-3-small', dims: 1536, inputTemplate: 'query-v1', billing: 'reported', tokens: 10, usd: .0000002 });
      const base = evidenceCases({}, 'engine')[0]!;
      const cases = Array.from({ length: 3 }, (_, i) => ({ ...structuredClone(base), rank: i + 1, case: { ...base.case, ntsbNo: `SYNTHETIC${i}` } }));
      return { cases, ranking: cases.map(c => ({ ntsbNo: c.case.ntsbNo, seeds: [], channels: ['keyword'] })) };
    });
  });
  it('QH50+A applies the policy\'s filters at retrieval; its edit adds the remaining suggestion as "Apply these filters" does', async () => {
    const h = gateSetup(), policy = attributed();
    const port = productionPort(settings, {} as Db, {} as Client, dataset, h.allocation as never, 'selection', 'a'.repeat(64), portDir, currentIdentities() as never);
    const live = await port.run({ key: 'q:QH50:1', questionId: question.id, arm: 'QH50', sample: 1 }, question, liveRequest());
    expect(live).toMatchObject({ failure: null, safetyFaults: [], automaticFilters: null, autoFilterPolicy: { version: 'none' }, attributionCalled: false });
    expect(mocks.search.mock.calls[0]![1].filters).toEqual({});
    const auto = await port.run({ key: 'q:QH50A:1', questionId: question.id, arm: 'QH50', sample: 1 }, question, attributedRequest(policy));
    expect(auto).toMatchObject({ failure: null, safetyFaults: [], automaticFilters: { state: ['AK'] }, autoFilterFields: { state: 'applied' },
      attributionCalled: true, autoFilterPolicy: autoFilterIdentity(policy), suggestion: { filters: { phase: ['landing'] } } });
    expect(mocks.search.mock.calls[1]![1].filters).toEqual({ state: ['AK'] });
    expect(auto.reservationUsd).toBeGreaterThan(live.reservationUsd);
    const filters = buttonFilters(auto)!;
    expect(filters).toEqual({ state: ['AK'], phase: ['landing'] });
    const before = mocks.provider.calls.length;
    const edit = await port.run({ key: 'q:QH50AF:1', questionId: question.id, arm: 'QH50', sample: 1 }, question, editRequest(filters, auto, policy));
    expect(edit).toMatchObject({ failure: null, safetyFaults: [], edited: true, automaticFilters: null, scopeOutcome: 'skipped', appliedFilters: filters, attributionCalled: false });
    expect(mocks.provider.calls.slice(before).map((c: { stage: string }) => c.stage)).toEqual(['rerank']);
    expect(mocks.search.mock.calls[2]![1]).toEqual({ text: auto.executed!.vector, keywordText: auto.executed!.lexical, filters });
  });
});

describe('Task 30 part summaries from journals', () => {
  const policy = () => autoFilterPolicy('attributed.v1');
  const observation = (itemId: string, sample: number, automatic: AutoFilters | null, fields: Record<string, string>, part: AttributionPart = 'dev-forced') => ({
    key: attemptKey('l', part, itemId, sample), part, itemId, sample, scope: 'scripted', configuration: { version: 'er-q-v1', sha256: 'x' }, policy: autoFilterIdentity(policy()),
    intent: 'case_search', emitted: { state: ['OH'] }, scopeOutcome: 'used', automaticFilters: automatic, autoFilterFields: fields,
    autoFilterReason: automatic ? 'applied' : 'not_applied', attributionOutcome: 'applied', attributionCalled: true, candidates: null, appliedFilters: automatic ?? {},
    usage: [{ stage: 'attribution', provider: 'anthropic', model: 'claude-haiku-5-5', usd: 0.0002 }], actualUsd: 0.0002, boundUsd: 0.001, reservationIds: [],
    timing: { scope: { attempted: true, ms: 0 }, attribution: { attempted: true, ms: 1 }, retrieve: { attempted: true, ms: 0 } }, totalMs: 1, failure: null, safetyFaults: [] });
  it('scores a development part, including the review-24 veto input, and refuses an incomplete one', async () => {
    const { summarizeAttributionPart } = await import('../../evals/auto-filters/run.js');
    const { probeItems } = await import('../../evals/auto-filters/inputs.js');
    const loaded = { family: 'dev' as const, path: 'x', sha256: 'y', file: validateProbes(file([probe(),
      probe({ id: 'r24-1', question: 'Find accidents involving aircraft maintained in Ohio.', gold: {}, kind: 'trap', source: 'review-24', pattern: 'maintenance' })]), 'dev') };
    const data = { path: 'x', sha256: 'y', items: probeItems(loaded, true), probes: loaded };
    const journal = new Map<string, any>();
    for (const s of [1, 2, 3]) {
      for (const o of [observation('wa-state-001', s, { state: ['OH'] }, { state: 'applied', years: 'not_candidate:empty', category: 'not_candidate:empty' }),
        observation('r24-1', s, s === 2 ? { state: ['OH'] } : null, { state: s === 2 ? 'applied' : 'attribution:aircraft_history' })]) {
        journal.set(o.key, { event: 'result', key: o.key, part: 'dev-forced', itemId: o.itemId, sample: s, observation: o });
      }
    }
    const summary = summarizeAttributionPart('dev-forced', data, journal, 'l', policy());
    expect(summary.fields.state!.traps!.policy).toMatchObject({ items: 1, failures: 1, failedItems: ['r24-1'] });
    expect(summary.fields.state!.questionPrecision).toMatchObject({ applications: 2, wrong: 1 });
    expect(summary.review24!.state).toEqual({ samples: 1, items: ['r24-1'] });
    expect(summary.usd.attribution).toBeCloseTo(0.0012, 9);
    expect(summary.wholeObject.questions).toEqual({ exact: 1, unsafe: 1 });
    journal.delete(attemptKey('l', 'dev-forced', 'r24-1', 3));
    expect(() => summarizeAttributionPart('dev-forced', data, journal, 'l', policy())).toThrow(/Incomplete schedule/);
  });
});

describe('Task 30 retrieval summary from a journal', () => {
  it('scores the five rows, checks every edit against its button and reports what QH50+A applied', async () => {
    const { summarizeRetrievalSet } = await import('../../evals/auto-filters/run.js');
    const policy = autoFilterPolicy('attributed.v1'), none = autoFilterIdentity(autoFilterPolicy('none')), identity = autoFilterIdentity(policy);
    const broad = Array.from({ length: 25 }, (_, i) => `X${i}`);
    const set = { name: 'confirmation', samples: [1], keyFilters: { n1: { state: ['AK'] }, b1: {} }, changes: [], sourceFileSha256: 's', goldSha256: 'g', crossGroupShares: 0,
      questions: [{ id: 'n1', question: 'q', group: 'g1', class: 'narrow', area: 'a', relevant: ['A', 'B'] }, { id: 'b1', question: 'q', group: 'g2', class: 'broad', area: 'a', relevant: broad }] } as never;
    const obs = (over: Partial<SearchObservation>): SearchObservation => ({ key: 'k', questionId: 'n1', arm: 'QH50', sample: 1, configuration: { version: 'er-q-h50-v1', sha256: 'x' },
      ranking: [], fused: [], scopeOutcome: 'used', lexicalSource: 'question', rerankOutcome: 'applied', executed: { lexical: 'q', vector: 'q' }, usage: [], actualUsd: 0.003,
      reservationUsd: 0.01, reservationIds: [], timing: { scope: { attempted: true, ms: 1 }, embed: { attempted: true, ms: 1 }, retrieve: { attempted: true, ms: 1 }, rerank: { attempted: true, ms: 1 } },
      totalMs: 1, embeddingCacheHit: false, failure: null, safetyFaults: [], appliedFilters: {}, suggestion: null, addedTerms: null, edited: false,
      autoFilterPolicy: none, automaticFilters: null, autoFilterFields: {}, attributionOutcome: 'not_run', attributionCalled: false, ...over });
    const noRerank = { scope: { attempted: false, ms: 0 }, embed: { attempted: true, ms: 1 }, retrieve: { attempted: true, ms: 1 }, rerank: { attempted: false, ms: 0 } };
    const journal = new Map<string, any>();
    const put = (row: Row30, q: string, o: SearchObservation) => { const key = attemptKey('l', 'retrieval', q, 1, row, 'confirmation'); journal.set(key, { event: 'result', key, part: 'retrieval', set: 'confirmation', row, itemId: q, sample: 1, observation: o }); };
    put('Q0', 'n1', obs({ configuration: { version: 'er-q-v1', sha256: 'y' }, ranking: ['Z', 'A'], scopeOutcome: 'skipped', rerankOutcome: 'disabled', timing: noRerank }));
    put('QH50', 'n1', obs({ ranking: ['A', 'Z'], fused: ['Z', 'A'], suggestion: { filters: { state: ['AK'] }, terms: 'icing' } }));
    put('QH50+F', 'n1', obs({ ranking: ['A', 'B'], edited: true, scopeOutcome: 'skipped', appliedFilters: { state: ['AK'] } }));
    put('QH50+A', 'n1', obs({ ranking: ['B', 'A'], fused: ['A', 'B'], appliedFilters: { state: ['AK'] }, automaticFilters: { state: ['AK'] }, suggestion: { filters: {}, terms: 'icing' },
      autoFilterPolicy: identity, autoFilterFields: { state: 'applied' }, attributionOutcome: 'applied', attributionCalled: true }));
    put('Q0', 'b1', obs({ configuration: { version: 'er-q-v1', sha256: 'y' }, ranking: ['X0'], scopeOutcome: 'skipped', rerankOutcome: 'disabled', timing: noRerank }));
    put('QH50', 'b1', obs({ questionId: 'b1', ranking: ['X0'], fused: ['X0'] }));
    put('QH50+A', 'b1', obs({ questionId: 'b1', ranking: ['X0'], fused: ['X0'], autoFilterPolicy: identity, autoFilterFields: { state: 'not_candidate:empty' }, attributionOutcome: 'not_run' }));
    const s = summarizeRetrievalSet(set, journal, 'l', policy);
    expect(s.rows['QH50+A']!.narrowR20).toBe(1); expect(s.rows.QH50!.narrowR20).toBe(0.5); expect(s.rows['QH50+F']!.narrowR20).toBe(1);
    expect(s.rows['QH50+A+F']!.narrowR20).toBe(1);
    expect(s.narrowR20Differences['QH50+A - QH50']).toMatchObject({ delta: 0.5, questions: 1 });
    expect(s.automatic.appliedByField).toEqual({ state: 1, years: 0, category: 0 });
    expect(s.automatic.answerKeyMatch.narrow).toEqual({ exact: 1 });
    expect(s.buttons).toEqual({ QH50: 1, 'QH50+A': 0, samples: 2 });
    expect(s.perQuestionLosses).toEqual([]);
    expect(s.determinism).toEqual({ q0VsQh50Fused: 0, q0VsQh50aFusedWithoutAutomatic: 0 });
    expect(s.publishable).toBe(true);
    // An edit without its button, or with other filters, is refused.
    put('QH50+A+F', 'n1', obs({ edited: true, appliedFilters: { state: ['AK'] } }));
    expect(() => summarizeRetrievalSet(set, journal, 'l', policy)).toThrow(/Edit does not match its button/);
    journal.delete(attemptKey('l', 'retrieval', 'n1', 1, 'QH50+A+F', 'confirmation'));
    put('QH50+F', 'n1', obs({ ranking: ['A', 'B'], edited: true, scopeOutcome: 'skipped', appliedFilters: { state: ['HI'] } }));
    expect(() => summarizeRetrievalSet(set, journal, 'l', policy)).toThrow(/Edit ran other filters/);
  });
});

describe('Task 30 preflight', () => {
  it('sizes a scripted part from its candidates, a real-scope part from its attempts, and refuses an unfrozen probe file', async () => {
    const { preflightPart, stages, resolvePolicy } = await import('../../evals/auto-filters/run.js');
    const policy = resolvePolicy('attributed.v1'), s = stages(policy);
    expect(s.attribution).toBe(Math.round(attributionWorstCaseUsd(attributionStage(policy)!) * 1e6));
    const dir = mkdtempSync(join(tmpdir(), 'task30-preflight-'));
    try {
      const replayPart = preflightPart('state-replay', dir, policy, s, undefined, true) as any;
      expect(replayPart).toMatchObject({ ready: true, items: 1040, samples: 1, attempts: 1040, candidates: { scriptedSearches: 918 } });
      expect(replayPart.candidates.withCandidate).toBeGreaterThan(300);
      expect(replayPart.candidates.withCandidate).toBeLessThan(918);
      expect(replayPart.chargeableWorstMicros).toBe(replayPart.candidates.withCandidate * s.attribution);
      expect(replayPart.worstCaseMicros).toBe(1040 * (s.scope + s.attribution + s.embed));
      const c2 = preflightPart('c2', dir, policy, s, undefined, true) as any;
      expect(c2).toMatchObject({ items: 1600, attempts: 1600, chargeableWorstMicros: 1600 * (s.scope + s.attribution) });
      expect(c2.candidates).toBeUndefined();
      const dev = preflightPart('dev-forced', dir, policy, s, undefined, true, { i: 1, k: 3 }) as any;
      expect(dev).toMatchObject({ ready: true, items: 622, samples: 3, attempts: 1866, budgetMicros: 800_000 });
      expect(dev.lanes.map((l: any) => l.lane)).toEqual(['1of3', '2of3', '3of3']);
      expect(dev.lanes.reduce((n: number, l: any) => n + l.items, 0)).toBe(622);
      expect(dev.lanes.every((l: any) => l.capMicros === Math.floor(800_000 / 3) && l.allocation.startsWith('eval-task30-dev-forced-'))).toBe(true);
      expect(dev.lanes.reduce((n: number, l: any) => n + l.chargeableWorstMicros, 0)).toBe(dev.chargeableWorstMicros);
      const confirm = preflightPart('confirm-forced', dir, policy, s, undefined, true) as any;
      expect(confirm).toMatchObject({ items: 1644, confirmFreeze: { probes: 1644 } });
      expect(preflightPart('confirm-forced', dir, policy, s, undefined, false)).toMatchObject({ ready: true });
      expect(() => preflightPart('retrieval', dir, policy, s, undefined, true)).toThrow(/development target/);
      expect(() => resolvePolicy('state-explicit.v1.3')).toThrow(/no attribution check/);
      expect(() => resolvePolicy('attributed.v9')).toThrow(/Unregistered/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('freezes the confirmation probes at their first preflight; a run only checks the freeze', async () => {
    const { freezeConfirm } = await import('../../evals/auto-filters/run.js');
    const dir = mkdtempSync(join(tmpdir(), 'task30-freeze-'));
    try {
      const probes = { family: 'confirm' as const, path: 'x', sha256: 'a'.repeat(64), file: validateProbes(file([probe({ source: 'c1' })]), 'confirm') };
      expect(() => freezeConfirm(dir, probes, false)).toThrow(/Run the preflight first/);
      expect(freezeConfirm(dir, probes, true)).toMatchObject({ sha256: 'a'.repeat(64), probes: 1 });
      expect(freezeConfirm(dir, probes, false).sha256).toBe('a'.repeat(64));
      expect(() => freezeConfirm(dir, { ...probes, sha256: 'b'.repeat(64) }, true)).toThrow(/changed after their first preflight/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Task 30 parallel lanes', () => {
  it('partitions a part\'s seeded order into k disjoint, complete shards', () => {
    const order = Array.from({ length: 23 }, (_, n) => `item-${n}`);
    for (let k = 1; k <= MAX_SHARDS; k += 1) {
      const lanes = Array.from({ length: k }, (_, j) => shardItems(order, { i: j + 1, k }));
      expect(lanes.flat().sort()).toEqual([...order].sort());
      expect(new Set(lanes.flat()).size).toBe(order.length);
      const sizes = lanes.map(l => l.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      lanes.forEach((l, j) => l.forEach(id => expect(order.indexOf(id) % k).toBe(j)));
    }
  });
  it('parses --shard i/k with 1 <= i <= k <= 9', () => {
    expect(parseShard('1/1')).toEqual({ i: 1, k: 1 });
    expect(parseShard('3/4')).toEqual({ i: 3, k: 4 });
    for (const bad of ['0/2', '3/2', '1/10', '1-2', '', 'a/b', '2/02']) expect(() => parseShard(bad)).toThrow(/--shard/);
  });
  it('caps lanes from a fixed per-part budget table that sums to $8.00', () => {
    expect(PART_BUDGET_MICROS).toEqual({ 'dev-forced': 800_000, 'dev-e2e': 1_400_000, 'state-replay': 400_000, c2: 1_200_000,
      'confirm-forced': 1_300_000, 'confirm-e2e': 1_500_000, retrieval: 1_400_000 });
    const total = Object.values(PART_BUDGET_MICROS).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(8_000_000);
    expect(total).toBe(TASK30_FAMILY.capMicros);
    expect(Object.keys(PART_BUDGET_MICROS).sort()).toEqual([...PARTS].sort());
    for (let k = 1; k <= MAX_SHARDS; k += 1) {
      const sum = PARTS.reduce((n, part) => n + (part === 'retrieval' ? laneCapMicros(part, 1) : k * laneCapMicros(part, k)), 0);
      expect(sum).toBeLessThanOrEqual(8_000_000);
      for (const part of PARTS) expect(k * laneCapMicros(part, k)).toBeLessThanOrEqual(PART_BUDGET_MICROS[part]);
    }
    expect(laneSpec('confirm-forced', { i: 2, k: 4 })).toMatchObject({ allocation: 'eval-task30-confirm-forced-2of4', capMicros: 325_000, family: TASK30_FAMILY });
    expect(laneSpec('retrieval', { i: 1, k: 1 }).capMicros).toBe(1_400_000);
    expect(laneSpec('dev-e2e', { i: 3, k: 3 }).capMicros).toBe(466_666);
  });
  it('gives every lane its own lock key, ledger prefix and application name', () => {
    const lanes = PARTS.flatMap(part => (part === 'retrieval' ? [{ i: 1, k: 1 }] : Array.from({ length: MAX_SHARDS }, (_, j) => ({ i: j + 1, k: MAX_SHARDS })))
      .map(shard => laneSpec(part, shard)));
    expect(new Set(lanes.map(l => l.lockKey)).size).toBe(lanes.length);
    for (const other of [732400024, 732500025, 732900029, 733000030]) expect(lanes.map(l => l.lockKey)).not.toContain(other);
    expect(laneLockKey('dev-forced', 1)).toBe(733000101); expect(laneLockKey('retrieval', 1)).toBe(733000161);
    expect(lanes.every(l => l.allocation.length <= 40 && l.allocation.startsWith(TASK30_FAMILY.prefix) && l.applicationName.length <= 63)).toBe(true);
    expect(new Set(lanes.map(l => `${l.allocation}:`)).size).toBe(lanes.length);
    // No lane's ledger prefix (with its colon) is the start of another's.
    for (const a of lanes) for (const b of lanes) if (a !== b) expect(`${b.allocation}:`.startsWith(`${a.allocation}:`)).toBe(false);
    expect(() => laneSpec('retrieval', { i: 1, k: 2 })).toThrow(/one lane/);
    expect(() => laneSpec('c2', { i: 3, k: 2 })).toThrow();
  });
  it('opens each lane with the whole family\'s remaining liability as its evaluation allowance', () => {
    const totals = (charged: number, open = 0) => ({ chargedMicros: charged, ledgerMicros: charged, openMicros: open, open: open ? 1 : 0, reservations: 1 });
    const lane = laneSpec('dev-e2e', { i: 1, k: 3 });
    // Lane cap $1.40 / 3, family $8.00 with $2.00 spent: the lane may run while the family has room; its own cap is checked per block.
    expect(categoryAllowanceMicros(10_000_000, lane, totals(100_000), totals(2_000_000))).toBe(10_000_000 + 6_000_000);
    expect(categoryAllowanceMicros(10_000_000, lane, totals(0), totals(7_900_000, 100_000))).toBe(10_000_000);
    // Without a family (Tasks 25 and 29) nothing changes: this month's spend plus the task's own remaining cap, at most $50.
    const single = { ...lane, family: undefined, capMicros: 800_000 };
    expect(categoryAllowanceMicros(10_000_000, single, totals(300_000))).toBe(10_500_000);
    expect(categoryAllowanceMicros(49_900_000, single, totals(0))).toBe(50_000_000);
  });
  it('freezes a part manifest once; every later lane must hold the same content', async () => {
    const { freezeShared } = await import('../../evals/auto-filters/run.js');
    const dir = mkdtempSync(join(tmpdir(), 'task30-freeze-shared-'));
    try {
      const path = join(dir, 'manifest.json');
      freezeShared(path, { part: 'c2', shards: 2 }, 'part manifest');
      freezeShared(path, { shards: 2, part: 'c2' }, 'part manifest');
      expect(() => freezeShared(path, { part: 'c2', shards: 3 }, 'part manifest')).toThrow(/differs from the one this part froze first/);
      expect(readdirSync(dir)).toEqual(['manifest.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('merges every lane of a part and refuses missing, extra, foreign, overlapping or unreconciled lanes', async () => {
    const { mergeLanes } = await import('../../evals/auto-filters/run.js');
    const root = mkdtempSync(join(tmpdir(), 'task30-merge-'));
    try {
      const part = 'c2' as const, hash = 'h'.repeat(64), order = ['a', 'b', 'c', 'd', 'e'];
      const itemsOf = (sh: { i: number; k: number }) => shardItems(order, sh);
      const lane = (sh: { i: number; k: number }, opts: { items?: string[]; extraItem?: string; manifest?: string; close?: boolean; started?: boolean } = {}) => {
        const d = join(root, part, `${sh.i}of${sh.k}`); mkdirSync(d, { recursive: true });
        const items = opts.items ?? itemsOf(sh);
        writeFileSync(join(d, 'lane.json'), JSON.stringify({ part, shard: sh, allocation: `eval-task30-${part}-${sh.i}of${sh.k}`, lockKey: 1, capMicros: 1, manifestSha256: opts.manifest ?? hash, items }));
        const lines = [...items, ...(opts.extraItem ? [opts.extraItem] : [])].flatMap(itemId => {
          const key = attemptKey('l', part, itemId, 1);
          return [{ event: 'started', key }, ...(opts.started ? [] : [{ event: 'result', key, part, itemId, sample: 1, observation: {} }])];
        });
        writeFileSync(join(d, 'results.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
        writeFileSync(join(d, 'allocation.jsonl'), [{ event: 'open' }, ...(opts.close === false ? [] : [{ event: 'close', balanced: true }])].map(l => JSON.stringify(l)).join('\n') + '\n');
      };
      const reset = () => { rmSync(join(root, part), { recursive: true, force: true }); mkdirSync(join(root, part), { recursive: true }); };
      reset(); lane({ i: 1, k: 2 }); lane({ i: 2, k: 2 });
      expect([...mergeLanes(root, part, 2, hash, itemsOf).values()].map(r => r.itemId).sort()).toEqual(order);
      // A directory a preflight opened, with no lane record, is not a lane.
      mkdirSync(join(root, part, '1of3'));
      expect(mergeLanes(root, part, 2, hash, itemsOf).size).toBe(5);
      reset(); lane({ i: 1, k: 2 });
      expect(() => mergeLanes(root, part, 2, hash, itemsOf)).toThrow(/^Incomplete schedule: c2 lanes not started: 2of2/);
      lane({ i: 2, k: 2 }); lane({ i: 3, k: 3 });
      expect(() => mergeLanes(root, part, 2, hash, itemsOf)).toThrow(/lanes outside its 2 shard\(s\): 3of3/);
      reset(); lane({ i: 1, k: 2 }); lane({ i: 2, k: 2 }, { manifest: 'x'.repeat(64) });
      expect(() => mergeLanes(root, part, 2, hash, itemsOf)).toThrow(/belongs to another run/);
      reset(); lane({ i: 1, k: 2 }); lane({ i: 2, k: 2 }, { items: ['b'] });
      expect(() => mergeLanes(root, part, 2, hash, itemsOf)).toThrow(/holds other items/);
      reset(); lane({ i: 1, k: 2 }); lane({ i: 2, k: 2 }, { extraItem: 'a' });
      expect(() => mergeLanes(root, part, 2, hash, itemsOf)).toThrow(/an item of another shard/);
      reset(); lane({ i: 1, k: 2 }); lane({ i: 2, k: 2 }, { extraItem: 'a' });
      expect(() => mergeLanes(root, part, 2, hash)).toThrow(/journaled in two lanes/);
      reset(); lane({ i: 1, k: 2 }); lane({ i: 2, k: 2 }, { started: true });
      expect(() => mergeLanes(root, part, 2, hash, itemsOf)).toThrow(/no durable result/);
      reset(); lane({ i: 1, k: 2 }); lane({ i: 2, k: 2 }, { close: false });
      expect(() => mergeLanes(root, part, 2, hash, itemsOf)).toThrow(/^Incomplete schedule: c2 lane 2of2 is still running or not closed balanced/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
