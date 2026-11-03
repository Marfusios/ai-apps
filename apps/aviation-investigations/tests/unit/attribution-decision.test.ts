/** The server's decision on the attribution check's answer (server/evidence/attribution.ts), with fixed answers. */
import { describe, expect, it } from 'vitest';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { automaticCandidates } from '../../shared/automatic-candidates.js';
import { AttributionInputSchema, renderAttributionUser, type AttributionOutput } from '../../server/ai/prompts/attribution.a1.js';
import { attributedFilters, attributionInput, candidateValues, quoteCovers } from '../../server/evidence/attribution.js';

type Check = AttributionOutput['checks'][number];
const candidatesOf = (question: string, suggested: BriefFilters) => automaticCandidates(question, suggested, {}).candidates;
const decide = (question: string, suggested: BriefFilters, checks: Check[] | null) =>
  attributedFilters(question, candidatesOf(question, suggested), checks && { checks });

const MIXED = 'Find helicopter accidents in Alaska during 2019.';
const MIXED_SUGGESTED = { state: ['AK'], category: ['HELI'], yearFrom: 2019, yearTo: 2019 };
const approve = (state: string, years: string, category: string): Check[] => [
  { id: 'state', about: 'accident_location', quote: state }, { id: 'years', about: 'accident_date', quote: years },
  { id: 'category', about: 'accident_aircraft', quote: category }];

describe('the check input', () => {
  it('renders canonical values with their operators, never scope text', () => {
    const value = (question: string, suggested: BriefFilters) => candidatesOf(question, suggested).flatMap(candidateValues);
    expect(value('Find accidents in Ohio or Iowa.', { state: ['OH', 'IA'] })).toEqual(['Iowa (IA)', 'Ohio (OH)']);
    expect(value('Find accidents in the District of Columbia.', { state: ['DC'] })).toEqual(['District of Columbia (DC)']);
    expect(value('Find accidents in 2019.', { yearFrom: 2019, yearTo: 2019 })).toEqual(['2019']);
    expect(value('Find accidents between 2015 and 2018.', { yearFrom: 2015, yearTo: 2018 })).toEqual(['2015 to 2018']);
    expect(value('Find accidents after 2015.', { yearFrom: 2016 })).toEqual(['2016 or later']);
    expect(value('Find accidents before 2000.', { yearTo: 1999 })).toEqual(['1999 or earlier']);
    expect(value('Find powered parachute accidents.', { category: ['PPAR'] })).toEqual(['powered parachute']);
    expect(value('Find gyroplane accidents.', { category: ['GYRO'] })).toEqual(['gyrocraft']);
  });
  it('is a valid frozen-prompt input in field order, and the rendered turn escapes candidates', () => {
    const input = attributionInput(MIXED, candidatesOf(MIXED, MIXED_SUGGESTED));
    expect(AttributionInputSchema.safeParse(input).success).toBe(true);
    expect(input).toEqual({ question: MIXED, candidates: [{ id: 'state', values: ['Alaska (AK)'] },
      { id: 'years', values: ['2019'] }, { id: 'category', values: ['helicopter'] }] });
    expect(renderAttributionUser(input)).toBe(`<question>\n${MIXED}\n</question>\nCandidates from AirCase: ${JSON.stringify(input.candidates)}`);
  });
});

describe('attributedFilters', () => {
  it('applies every candidate whose check names its accident class and quotes its witness', () => {
    expect(decide(MIXED, MIXED_SUGGESTED, approve('in Alaska', 'during 2019', 'helicopter accidents'))).toEqual({
      filters: { state: ['AK'], yearFrom: 2019, yearTo: 2019, category: ['HELI'] },
      fields: { state: 'applied', years: 'applied', category: 'applied' },
    });
  });
  it('a check for another class applies nothing for that field only', () => {
    const checks = approve('in Alaska', 'during 2019', 'helicopter');
    checks[0] = { ...checks[0]!, about: 'aircraft_history' };
    checks[2] = { ...checks[2]!, about: 'accident_location' }; // the right word, the wrong field's class
    expect(decide(MIXED, MIXED_SUGGESTED, checks)).toEqual({ filters: { yearFrom: 2019, yearTo: 2019 },
      fields: { state: 'attribution:aircraft_history', years: 'applied', category: 'attribution:accident_location' } });
  });
  it('compares quotes without case and with whitespace normalised, against the normalised question', () => {
    expect(decide(MIXED, MIXED_SUGGESTED, approve('IN  ALASKA', ' during\n2019 ', 'Helicopter')).fields)
      .toEqual({ state: 'applied', years: 'applied', category: 'applied' });
    // Repeated spaces collapse (a tab or newline is a control character: never a candidate).
    expect(decide('Find helicopter  accidents in   Alaska.', { state: ['AK'] }, [{ id: 'state', about: 'accident_location', quote: 'accidents in Alaska' }]).fields)
      .toEqual({ state: 'applied' });
  });
  it.each([
    ['an empty quote', ''],
    ['a quote not in the question', 'in Alaska during 2018'],
    ['a quote around only part of the witness', 'Alask'],
    ['a quote of the neighbouring words', 'accidents in'],
  ])('%s is a bad quote', (_label, quote) => {
    expect(decide('Find accidents in Alaska.', { state: ['AK'] }, [{ id: 'state', about: 'accident_location', quote }]))
      .toEqual({ filters: null, fields: { state: 'bad_quote' } });
  });
  it('a postal witness is the whole City, XX place: a lowercase "in" is not Indiana', () => {
    const q = 'Find crashes in Ohio discussed by an instructor in Indianapolis, IN.';
    const s = { state: ['OH', 'IN'] };
    expect(decide(q, s, [{ id: 'state', about: 'accident_location', quote: 'crashes in Ohio' }]).fields).toEqual({ state: 'bad_quote' });
    expect(decide(q, s, [{ id: 'state', about: 'accident_location', quote: 'IN' }]).fields).toEqual({ state: 'bad_quote' });
    expect(decide(q, s, [{ id: 'state', about: 'accident_location', quote: 'in Ohio discussed by an instructor in Indianapolis, IN' }]))
      .toEqual({ filters: { state: ['IN', 'OH'] }, fields: { state: 'applied' } });
  });
  it('a quote with a lowercase "or" does not cover Oregon', () => {
    const q = 'Find accidents near Portland, OR.';
    expect(decide(q, { state: ['OR'] }, [{ id: 'state', about: 'accident_location', quote: 'or' }]).fields).toEqual({ state: 'bad_quote' });
    expect(decide(q, { state: ['OR'] }, [{ id: 'state', about: 'accident_location', quote: 'near Portland, OR' }]).fields).toEqual({ state: 'applied' });
  });
  it('a year quote must hold the operator, not only the digits', () => {
    const q = 'Find accidents after 2015.';
    expect(decide(q, { yearFrom: 2016 }, [{ id: 'years', about: 'accident_date', quote: '2015' }]).fields).toEqual({ years: 'bad_quote' });
    expect(decide(q, { yearFrom: 2016 }, [{ id: 'years', about: 'accident_date', quote: 'after 2016' }]).fields).toEqual({ years: 'bad_quote' });
    expect(decide(q, { yearFrom: 2016 }, [{ id: 'years', about: 'accident_date', quote: 'accidents after 2015' }]))
      .toEqual({ filters: { yearFrom: 2016 }, fields: { years: 'applied' } });
  });
  it('a quote from another occurrence of the same words does not cover the witness', () => {
    // "helicopter" names the category once; the quote's other "accidents" occurrence is beside another value.
    const q = 'Find helicopter accidents near Juneau, AK, then accidents of the operator.';
    expect(decide(q, { category: ['HELI'] }, [{ id: 'category', about: 'accident_aircraft', quote: 'accidents of the operator' }]).fields)
      .toEqual({ category: 'bad_quote' });
    // Overlapping occurrences are all tried.
    expect(quoteCovers('Find aaa accidents.', 'aa', [{ start: 6, end: 8 }])).toBe(true);
    expect(quoteCovers('Find aaa accidents.', 'aa', [{ start: 5, end: 8 }])).toBe(false);
  });
  it('a multi-value candidate applies only as a whole', () => {
    const q = 'Find accidents in Alaska or Hawaii.';
    expect(decide(q, { state: ['AK', 'HI'] }, [{ id: 'state', about: 'accident_location', quote: 'in Alaska' }]))
      .toEqual({ filters: null, fields: { state: 'bad_quote' } });
    expect(decide(q, { state: ['AK', 'HI'] }, [{ id: 'state', about: 'accident_location', quote: 'alaska or hawaii' }]))
      .toEqual({ filters: { state: ['AK', 'HI'] }, fields: { state: 'applied' } });
  });
  it('no answer (a failed or refused stage) applies nothing', () => {
    expect(decide(MIXED, MIXED_SUGGESTED, null)).toEqual({ filters: null,
      fields: { state: 'attribution_unavailable', years: 'attribution_unavailable', category: 'attribution_unavailable' } });
  });
  it.each([
    ['a missing check', approve('in Alaska', 'during 2019', 'helicopter').slice(0, 2)],
    ['a duplicate check', [...approve('in Alaska', 'during 2019', 'helicopter').slice(0, 2), { id: 'state' as const, about: 'accident_location' as const, quote: 'Alaska' }]],
    ['an extra check', [...approve('in Alaska', 'during 2019', 'helicopter'), { id: 'state' as const, about: 'accident_location' as const, quote: 'Alaska' }]],
  ])('a structurally incomplete answer (%s) applies nothing at all', (_label, checks) => {
    expect(decide(MIXED, MIXED_SUGGESTED, checks)).toEqual({ filters: null,
      fields: { state: 'attribution_unavailable', years: 'attribution_unavailable', category: 'attribution_unavailable' } });
  });
  it('a check for a field that is no candidate is an extra check', () => {
    expect(decide('Find accidents in Alaska.', { state: ['AK'] }, [{ id: 'state', about: 'accident_location', quote: 'Alaska' },
      { id: 'years', about: 'accident_date', quote: '' }])).toEqual({ filters: null, fields: { state: 'attribution_unavailable' } });
  });
  it('no candidates, no decision; and no question or quote text in the result', () => {
    expect(attributedFilters(MIXED, [], null)).toEqual({ filters: null, fields: {} });
    const out = JSON.stringify(decide(MIXED, MIXED_SUGGESTED, approve('SENTINEL', 'during 2019', 'helicopter')));
    expect(out).not.toMatch(/SENTINEL|Alaska|helicopter accidents/);
  });
});
