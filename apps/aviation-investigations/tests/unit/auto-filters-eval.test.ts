/** Task 30's evaluation harness, offline: probe schema, scoring, exact bounds, the decision rule, sizing and request shapes. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeWarnings, validateProbes, type Probe } from '../../evals/auto-filters/probes.js';
import {
  attributedRequest, attributionSampleMicros, autoFilters, binomialCdf, buttonFilters, c2Verdict, chargeableSampleMicros, confusion, decideField,
  editRequest, exactLower, exactUpper, fieldKey, fieldOutcome, fieldSummary, fittedTerms, groupSummary, liveRequest, nextStreak30, positiveRecall,
  precisionOf, q0Request, questionPrecision, replayScope, retrievalQuestionMicros, review24Unsafe, scriptedScopeOutput, stageMicros30, trapFailures,
  trapStops, v13Replay, wholeObject, wholeOutcome, Z_ONE_SIDED_95, Z_SIMULTANEOUS, type AutoFilters, type DecisionInputs, type ScoredSample,
} from '../../evals/auto-filters/plan.js';
import { wilson } from '../../evals/search-quality/field-score.js';
import { validateEvidenceScope } from '../../server/ai/prompts/scope.e1.js';
import { autoFilterPolicy } from '../../server/evidence/auto-filters.js';
import { evidenceRankingConfig } from '../../server/evidence/ranking-config.js';
import type { SearchObservation } from '../../evals/search-quality/ab-types.js';
import type { C2Dataset } from '../../evals/search-quality/part5/field-score.js';
import replay from '../fixtures/state-field-replay.json' with { type: 'json' };

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
    ['a year outside 1900 to 2100', probe({ forced: { yearFrom: 1899 }, field: 'years' })],
    ['an empty set', probe({ gold: { state: [] } })],
    ['UNK in gold', probe({ forced: { category: ['UNK'] }, gold: { category: ['UNK'] }, field: 'category' })],
    ['a territory in gold', probe({ forced: { state: ['PR'] }, gold: { state: ['PR'] } })],
    ['forced without the probe field', probe({ field: 'years' })],
    ['an unknown kind', { ...probe(), kind: 'control' }],
  ])('refuses %s', (_name, p) => {
    expect(() => validateProbes(file([p]), 'dev')).toThrow(/Invalid dev probe file/);
  });
  it('accepts what a scope may emit in forced even when it can never be applied (a territory, UNK)', () => {
    expect(validateProbes(file([probe({ forced: { state: ['PR'] }, gold: {}, kind: 'trap' })]), 'dev').probes).toHaveLength(1);
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
  it('breaks results down by tag and finds unsafe review-24 applications', () => {
    const g = groupSummary(rows, 'pattern');
    expect(g.maintenance!.fields.state).toMatchObject({ traps: 2, trapFailures: 1, applications: 1, wrong: 1 });
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
  const s = stageMicros30(evidenceRankingConfig('er-q-v1'), evidenceRankingConfig('er-q-h50-v1'), { model: 'claude-haiku-5-5', caps: { input: 3000, output: 500 } });
  it('sizes the attribution check at its caps with the whole input cache-written ($0.000625)', () => {
    expect(s.attribution).toBe(625);
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
