/** The server's decision on the attribution check's answer (server/evidence/attribution.ts, attr.a3), with fixed answers. */
import { describe, expect, it } from 'vitest';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { automaticCandidates } from '../../shared/automatic-candidates.js';
import { AttributionInputSchema, ATTRIBUTION_MAX_CANDIDATES, renderAttributionUser, type AttributionOutput } from '../../server/ai/prompts/attribution.a2.js';
import { attributedFilters, attributionInput, candidateValues, quoteCovers } from '../../server/evidence/attribution.js';

type Check = AttributionOutput['checks'][number];
const candidatesOf = (question: string, suggested: BriefFilters) => automaticCandidates(question, suggested, {}).candidates;
const decide = (question: string, suggested: BriefFilters, checks: Check[] | null) =>
  attributedFilters(question, candidatesOf(question, suggested), checks && { checks });
const location = (id: string, quote: string): Check => ({ id, about: 'accident_location', quote });

const MIXED = 'Find helicopter accidents in Alaska during 2019.';
const MIXED_SUGGESTED = { state: ['AK'], category: ['HELI'], yearFrom: 2019, yearTo: 2019 };
const approve = (state: string, years: string, category: string): Check[] => [
  { id: 'state:AK', about: 'accident_location', quote: state }, { id: 'years', about: 'accident_date', quote: years },
  { id: 'category:HELI', about: 'accident_aircraft', quote: category }];

describe('the check input', () => {
  it('renders one canonical value per check, with the years\' operators, never scope text', () => {
    const value = (question: string, suggested: BriefFilters) => candidatesOf(question, suggested).flatMap(candidateValues).map(v => [v.id, v.value]);
    expect(value('Find accidents in Ohio or Iowa.', { state: ['OH', 'IA'] })).toEqual([['state:IA', 'Iowa (IA)'], ['state:OH', 'Ohio (OH)']]);
    expect(value('Find accidents in the District of Columbia.', { state: ['DC'] })).toEqual([['state:DC', 'District of Columbia (DC)']]);
    expect(value('Find accidents in 2019.', { yearFrom: 2019, yearTo: 2019 })).toEqual([['years', '2019']]);
    expect(value('Find accidents between 2015 and 2018.', { yearFrom: 2015, yearTo: 2018 })).toEqual([['years', '2015 to 2018']]);
    expect(value('Find accidents after 2015.', { yearFrom: 2016 })).toEqual([['years', '2016 or later']]);
    expect(value('Find accidents before 2000.', { yearTo: 1999 })).toEqual([['years', '1999 or earlier']]);
    expect(value('Find powered parachute accidents.', { category: ['PPAR'] })).toEqual([['category:PPAR', 'powered parachute']]);
    expect(value('Find gyroplane accidents.', { category: ['GYRO'] })).toEqual([['category:GYRO', 'gyrocraft']]);
  });
  it('each value keeps its own witness', () => {
    const q = 'Find crashes in Nevada of aircraft registered in California.';
    const values = candidatesOf(q, { state: ['NV', 'CA'] }).flatMap(candidateValues);
    expect(values.map(v => [v.id, q.slice(v.witness.start, v.witness.end)])).toEqual([['state:CA', 'California'], ['state:NV', 'Nevada']]);
  });
  it('is a valid frozen-prompt input, fields in order, and the rendered turn escapes candidates', () => {
    const input = attributionInput(MIXED, candidatesOf(MIXED, MIXED_SUGGESTED));
    expect(AttributionInputSchema.safeParse(input).success).toBe(true);
    expect(input).toEqual({ question: MIXED, candidates: [{ id: 'state:AK', field: 'state', value: 'Alaska (AK)' },
      { id: 'years', field: 'years', value: '2019' }, { id: 'category:HELI', field: 'category', value: 'helicopter' }] });
    expect(renderAttributionUser(input)).toBe(`<question>\n${MIXED}\n</question>\nCandidates from AirCase: ${JSON.stringify(input.candidates)}`);
  });
  it('the most values the candidate builder sends fit the check', () => {
    const q = 'Find helicopter, glider or balloon accidents in Ohio, Iowa, Utah, Idaho, Texas, Maine, Kansas or Alaska in 2019.';
    const input = attributionInput(q, candidatesOf(q, { state: ['OH', 'IA', 'UT', 'ID', 'TX', 'ME', 'KS', 'AK'], category: ['HELI', 'GLI', 'BALL'], yearFrom: 2019, yearTo: 2019 }));
    expect(input.candidates).toHaveLength(ATTRIBUTION_MAX_CANDIDATES);
    expect(AttributionInputSchema.safeParse(input).success).toBe(true);
  });
});

describe('attributedFilters', () => {
  it('applies every field whose values\' checks name its accident class and quote their witnesses', () => {
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
  it('a field applies only when every one of its values is approved, each with its own witness', () => {
    // The development evaluation's case: Nevada is where the crashes happened, California where the aircraft were registered.
    const q = 'Find crashes in Nevada of aircraft registered in California.', s = { state: ['NV', 'CA'] };
    expect(decide(q, s, [{ id: 'state:CA', about: 'aircraft_history', quote: 'registered in California' }, location('state:NV', 'crashes in Nevada')]))
      .toEqual({ filters: null, fields: { state: 'attribution:aircraft_history' } });
    expect(decide(q, s, [location('state:CA', 'in California'), location('state:NV', 'in Nevada')]))
      .toEqual({ filters: { state: ['CA', 'NV'] }, fields: { state: 'applied' } });
    // A quote that holds the other value's witness is no quote for this one.
    expect(decide(q, s, [location('state:CA', 'Nevada'), location('state:NV', 'California')]).fields).toEqual({ state: 'bad_quote' });
    expect(decide('Find accidents in Alaska or Hawaii.', { state: ['AK', 'HI'] }, [location('state:AK', 'in Alaska'), location('state:HI', 'Alaska')]).fields)
      .toEqual({ state: 'bad_quote' });
  });
  it('the field\'s reason is its first value, in value order, that is not approved', () => {
    const q = 'Find accidents in Ohio, Iowa, Utah, Idaho, Texas, Maine, Kansas or Alaska.';
    const codes = ['AK', 'IA', 'ID', 'KS', 'ME', 'OH', 'TX', 'UT'];
    const names: Record<string, string> = { AK: 'Alaska', IA: 'Iowa', ID: 'Idaho', KS: 'Kansas', ME: 'Maine', OH: 'Ohio', TX: 'Texas', UT: 'Utah' };
    const checks = codes.map(c => location(`state:${c}`, names[c]!));
    expect(decide(q, { state: codes }, checks)).toEqual({ filters: { state: codes }, fields: { state: 'applied' } });
    checks[7] = { ...checks[7]!, about: 'unclear' }; checks[6] = { ...checks[6]!, quote: 'Texa' };
    expect(decide(q, { state: codes }, checks).fields).toEqual({ state: 'bad_quote' });
  });
  it('compares quotes without case and with whitespace normalised, against the normalised question', () => {
    expect(decide(MIXED, MIXED_SUGGESTED, approve('IN  ALASKA', ' during\n2019 ', 'Helicopter')).fields)
      .toEqual({ state: 'applied', years: 'applied', category: 'applied' });
    // Repeated spaces, tabs and line breaks collapse to one space in the question and in the quote.
    expect(decide('Find helicopter  accidents in \t Alaska.', { state: ['AK'] }, [location('state:AK', 'accidents in Alaska')]).fields)
      .toEqual({ state: 'applied' });
  });
  it.each([
    ['an empty quote', ''],
    ['a quote not in the question', 'in Alaska during 2018'],
    ['a quote around only part of the witness', 'Alask'],
    ['a quote of the neighbouring words', 'accidents in'],
  ])('%s is a bad quote', (_label, quote) => {
    expect(decide('Find accidents in Alaska.', { state: ['AK'] }, [location('state:AK', quote)]))
      .toEqual({ filters: null, fields: { state: 'bad_quote' } });
  });
  it('nested punctuation in a quote: it must still be a span of the question that holds the witness', () => {
    const q = 'Find ((helicopter)) accidents ((in [Alaska])), during 2019.';
    expect(decide(q, MIXED_SUGGESTED, approve('((in [Alaska]))', ')), during 2019.', '((helicopter))')).fields)
      .toEqual({ state: 'applied', years: 'applied', category: 'applied' });
    expect(decide(q, MIXED_SUGGESTED, approve('(in [Alaska])', 'during 2019', '[helicopter]')).fields)
      .toEqual({ state: 'applied', years: 'applied', category: 'bad_quote' });
    expect(decide(q, MIXED_SUGGESTED, approve('in Alaska', 'during 2019', 'helicopter')).fields)
      .toEqual({ state: 'bad_quote', years: 'applied', category: 'applied' });
  });
  it('a postal witness is the whole City, XX place: a lowercase "in" is not Indiana', () => {
    const q = 'Find crashes in Ohio discussed by an instructor in Indianapolis, IN.';
    const s = { state: ['OH', 'IN'] };
    expect(decide(q, s, [location('state:IN', 'IN'), location('state:OH', 'crashes in Ohio')]).fields).toEqual({ state: 'bad_quote' });
    expect(decide(q, s, [location('state:IN', 'in Ohio'), location('state:OH', 'crashes in Ohio')]).fields).toEqual({ state: 'bad_quote' });
    expect(decide(q, s, [location('state:IN', 'in Indianapolis, IN'), location('state:OH', 'crashes in Ohio')]))
      .toEqual({ filters: { state: ['IN', 'OH'] }, fields: { state: 'applied' } });
  });
  it('a quote with a lowercase "or" does not cover Oregon', () => {
    const q = 'Find accidents near Portland, OR.';
    expect(decide(q, { state: ['OR'] }, [location('state:OR', 'or')]).fields).toEqual({ state: 'bad_quote' });
    expect(decide(q, { state: ['OR'] }, [location('state:OR', 'near Portland, OR')]).fields).toEqual({ state: 'applied' });
  });
  it('a year quote must hold the operator, not only the digits', () => {
    const q = 'Find accidents after 2015.';
    const date = (quote: string): Check[] => [{ id: 'years', about: 'accident_date', quote }];
    expect(decide(q, { yearFrom: 2016 }, date('2015')).fields).toEqual({ years: 'bad_quote' });
    expect(decide(q, { yearFrom: 2016 }, date('after 2016')).fields).toEqual({ years: 'bad_quote' });
    expect(decide(q, { yearFrom: 2016 }, date('accidents after 2015'))).toEqual({ filters: { yearFrom: 2016 }, fields: { years: 'applied' } });
  });
  it('a merged category mention is one value; a quote covering any one of its words covers it (review A2 m4)', () => {
    const q = 'Find blimp or airship accidents.', aircraft = (quote: string): Check[] => [{ id: 'category:BLIM', about: 'accident_aircraft', quote }];
    expect(decide(q, { category: ['BLIM'] }, aircraft('blimp or airship'))).toEqual({ filters: { category: ['BLIM'] }, fields: { category: 'applied' } });
    expect(decide(q, { category: ['BLIM'] }, aircraft('airship')).fields).toEqual({ category: 'applied' });
    expect(decide(q, { category: ['BLIM'] }, aircraft('blimp')).fields).toEqual({ category: 'applied' });
    expect(decide(q, { category: ['BLIM'] }, aircraft('or')).fields).toEqual({ category: 'bad_quote' });
    expect(decide(q, { category: ['BLIM'] }, aircraft('airshi')).fields).toEqual({ category: 'bad_quote' });
  });
  it('a decade\'s witness is "the 1990s", without its lead word (review A2 m4)', () => {
    const date = (quote: string): Check[] => [{ id: 'years', about: 'accident_date', quote }];
    for (const q of ['Find accidents in the 1990s.', 'Find accidents during the 1990s.', 'Find crashes of the 1990s.']) {
      expect(decide(q, { yearFrom: 1990, yearTo: 1999 }, date('the 1990s')), q).toEqual({ filters: { yearFrom: 1990, yearTo: 1999 }, fields: { years: 'applied' } });
      expect(decide(q, { yearFrom: 1990, yearTo: 1999 }, date('1990s')).fields, q).toEqual({ years: 'bad_quote' });
    }
  });
  it('a quote from another occurrence of the same words does not cover the witness', () => {
    // "helicopter" names the category once; the quote's other "accidents" occurrence is beside another value.
    const q = 'Find helicopter accidents near Juneau, AK where accidents of the operator happened.';
    expect(decide(q, { category: ['HELI'] }, [{ id: 'category:HELI', about: 'accident_aircraft', quote: 'accidents of the operator' }]).fields)
      .toEqual({ category: 'bad_quote' });
    // Overlapping occurrences are all tried.
    expect(quoteCovers('Find aaa accidents.', 'aa', [{ start: 6, end: 8 }])).toBe(true);
    expect(quoteCovers('Find aaa accidents.', 'aa', [{ start: 5, end: 8 }])).toBe(false);
  });
  it('no answer (a failed or refused stage) applies nothing', () => {
    expect(decide(MIXED, MIXED_SUGGESTED, null)).toEqual({ filters: null,
      fields: { state: 'attribution_unavailable', years: 'attribution_unavailable', category: 'attribution_unavailable' } });
  });
  it.each([
    ['a missing check', approve('in Alaska', 'during 2019', 'helicopter').slice(0, 2)],
    ['a duplicate check', [...approve('in Alaska', 'during 2019', 'helicopter').slice(0, 2), location('state:AK', 'Alaska')]],
    ['an extra check', [...approve('in Alaska', 'during 2019', 'helicopter'), location('state:HI', 'Alaska')]],
    ['attr.a1\'s field ids', approve('in Alaska', 'during 2019', 'helicopter').map(c => ({ ...c, id: c.id.split(':')[0]! }))],
  ])('a structurally incomplete answer (%s) applies nothing at all', (_label, checks) => {
    expect(decide(MIXED, MIXED_SUGGESTED, checks)).toEqual({ filters: null,
      fields: { state: 'attribution_unavailable', years: 'attribution_unavailable', category: 'attribution_unavailable' } });
  });
  it('a check for a value that is no candidate is an extra check', () => {
    expect(decide('Find accidents in Alaska.', { state: ['AK'] }, [location('state:AK', 'Alaska'), { id: 'years', about: 'accident_date', quote: '' }]))
      .toEqual({ filters: null, fields: { state: 'attribution_unavailable' } });
  });
  it('no candidates, no decision; and no question or quote text in the result', () => {
    expect(attributedFilters(MIXED, [], null)).toEqual({ filters: null, fields: {} });
    const out = JSON.stringify(decide(MIXED, MIXED_SUGGESTED, approve('SENTINEL', 'during 2019', 'helicopter')));
    expect(out).not.toMatch(/SENTINEL|Alaska|helicopter accidents/);
  });
});
