import { describe, expect, it } from 'vitest';
import { withSuggestedFilters as page } from '../../web/src/features/evidence/display';
import { hasFilters, withSuggestedFilters as evaluator } from '../../evals/applied-filters/filters';
import { filterChips } from '../../web/src/features/evidence/SearchPanel';
import type { BriefFilters } from '../../shared/contracts/briefs';

// Task 29 measures the page's "Apply these filters"; its merge must stay the page's.
describe('Task 29 filter merge parity', () => {
  const cases: [BriefFilters, BriefFilters][] = [
    [{}, { state: ['HI'] }],
    [{}, { yearFrom: 2023, yearTo: 2026, category: ['HELI'] }],
    [{ state: ['AK'] }, { state: ['HI', 'AK'] }],
    [{ yearFrom: 2010 }, { yearTo: 2016 }],
    [{ phase: ['LANDING'] }, { state: [], category: ['AIR'] }],
  ];
  it.each(cases)('merges %j with %j as the page does', (applied, suggested) => {
    expect(evaluator(applied, suggested)).toEqual(page(applied, suggested));
  });
});

describe('Task 29 button parity', () => {
  const filters: BriefFilters[] = [{}, { state: [] }, { state: ['HI'] }, { yearFrom: 2020 }, { yearTo: 2021 }, { category: ['HELI'], state: [] }];
  it.each(filters)('offers the button for %j exactly when the page shows a chip', f => {
    expect(hasFilters(f)).toBe(filterChips(f).length > 0);
  });
});
