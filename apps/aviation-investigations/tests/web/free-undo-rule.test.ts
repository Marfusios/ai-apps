/**
 * The one free undo's rule as the web client applies it (web/src/features/evidence/undo.ts
 * `freeUndoRule`; Task 30 spec §6, the server's `canUndo` is the same rule, held to it by
 * tests/unit/evidence-undo.test.ts): an edit is free when the page says its undo is there, it sends
 * no words, and its filters are the applied ones with one or more whole automatic filters taken out
 * (the state set, both year bounds as one, the aircraft category set, each counted only while the
 * applied value is the automatic one) and/or the added terms taken out, and nothing else changed.
 * One value of several, or one year bound, is no undo.
 */
import { describe, expect, it } from 'vitest';
import type { BriefFilters } from '../../shared/contracts/briefs';
import { CreateEvidenceRequestSchema, EvidencePageSchema, type CreateEvidenceRequest, type EvidenceAutomaticFilters, type EvidenceQuery } from '../../shared/contracts/evidence';
import { MOCK_EVIDENCE_FIELDS_POLICY, MOCK_EVIDENCE_QUESTIONS, MockEvidence } from '../../web/mock/evidence';
import { freeUndoRule, type UndoEdit, type UndoParent } from '../../web/src/features/evidence/undo';

const QUESTION: EvidenceQuery = { source: 'question', keywords: { kind: 'question' } };
const PLUS_TERMS: EvidenceQuery = { source: 'question', keywords: { kind: 'question+terms', terms: 'power loss' } };

/** An original question search whose applied filters are exactly what its policy applied on its own. */
function original(automatic: EvidenceAutomaticFilters | null, query: EvidenceQuery = QUESTION, undo: UndoParent['undo'] = 'available'): UndoParent {
  const applied: BriefFilters = { ...automatic };
  return { undo, query, appliedFilters: applied, automaticFilters: automatic };
}

/** A state, years and an aircraft category the policy applied, and each of them alone, as applied filters. */
const ALL: EvidenceAutomaticFilters = { state: ['TX'], yearFrom: 2008, yearTo: 2012, category: ['HELI'] };
const STATE: BriefFilters = { state: ['TX'] };
const YEARS: BriefFilters = { yearFrom: 2008, yearTo: 2012 };
const CATEGORY: BriefFilters = { category: ['HELI'] };

/** What an edit sends: its filters, and the question's own keywords or words of the reader's own. */
const edit = (filters: BriefFilters, change: Omit<UndoEdit, 'filters'> = {}): UndoEdit => ({ filters, ...change });

describe('removing whole automatic filters is the free undo', () => {
  it.each([
    ['the state', { ...YEARS, ...CATEGORY }],
    ['the years', { ...STATE, ...CATEGORY }],
    ['the aircraft category', { ...STATE, ...YEARS }],
    ['the state and the years', { ...CATEGORY }],
    ['the state and the category', { ...YEARS }],
    ['the years and the category', { ...STATE }],
    ['all three', {}],
  ] as [string, BriefFilters][])('%s', (_name, left) => {
    expect(freeUndoRule(original(ALL), edit(left))).toBe(true);
    // With the added terms taken out too, when the search added some.
    expect(freeUndoRule(original(ALL, PLUS_TERMS), edit(left, { keywords: 'question' }))).toBe(true);
    // …and keeping them.
    expect(freeUndoRule(original(ALL, PLUS_TERMS), edit(left))).toBe(true);
  });

  it('the added terms alone, the filters kept', () => {
    expect(freeUndoRule(original(ALL, PLUS_TERMS), edit({ ...ALL }, { keywords: 'question' }))).toBe(true);
    expect(freeUndoRule(original(null, PLUS_TERMS), edit({}, { keywords: 'question' }))).toBe(true);
  });

  it('facets are sets and years are as given: the order of keys and values does not matter', () => {
    const two = original({ state: ['CA', 'NV'], category: ['AIR', 'HELI'] });
    expect(freeUndoRule(two, edit({ category: ['HELI', 'AIR'] }))).toBe(true);
    expect(freeUndoRule(two, edit({ state: ['NV', 'CA'] }))).toBe(true);
    expect(freeUndoRule(two, edit({ state: ['NV', 'CA'], category: [] }))).toBe(true);
  });

  it('one year bound is the years too: a policy that applied only “from” or only “to”', () => {
    expect(freeUndoRule(original({ yearFrom: 2015 }), edit({}))).toBe(true);
    expect(freeUndoRule(original({ state: ['AK'], yearTo: 1999 }), edit({ state: ['AK'] }))).toBe(true);
    expect(freeUndoRule(original({ state: ['AK'], yearTo: 1999 }), edit({ yearTo: 1999 }))).toBe(true);
  });

  it('a category-only page: the whole category, the terms, or both', () => {
    const helicopter = original({ category: ['HELI'] }, PLUS_TERMS);
    expect(freeUndoRule(helicopter, edit({}))).toBe(true);
    expect(freeUndoRule(helicopter, edit({ ...CATEGORY }, { keywords: 'question' }))).toBe(true);
    expect(freeUndoRule(helicopter, edit({}, { keywords: 'question' }))).toBe(true);
    // Two categories are one filter: both out together.
    expect(freeUndoRule(original({ category: ['AIR', 'HELI'] }), edit({}))).toBe(true);
  });

  it('a state-only page reads as before: the whole state, the terms, or both', () => {
    const texas = original({ state: ['TX'] }, PLUS_TERMS);
    expect(freeUndoRule(texas, edit({}))).toBe(true);
    expect(freeUndoRule(texas, edit({ state: ['TX'] }, { keywords: 'question' }))).toBe(true);
    expect(freeUndoRule(texas, edit({}, { keywords: 'question' }))).toBe(true);
  });
});

describe('anything else uses one of the visitor’s searches', () => {
  it('one category of two left narrows a category-only search, and a category added widens it', () => {
    const two = original({ category: ['AIR', 'HELI'] });
    expect(freeUndoRule(two, edit({ category: ['HELI'] }))).toBe(false);
    expect(freeUndoRule(two, edit({ category: ['AIR'] }))).toBe(false);
    expect(freeUndoRule(original({ category: ['HELI'] }), edit({ category: ['AIR', 'HELI'] }))).toBe(false);
    expect(freeUndoRule(original({ category: ['HELI'] }), edit({ category: ['GLI'] }))).toBe(false);
  });

  it('one value of several left narrows the search', () => {
    const two = original({ state: ['CA', 'NV'], category: ['AIR', 'HELI'] });
    expect(freeUndoRule(two, edit({ state: ['NV'], category: ['AIR', 'HELI'] }))).toBe(false);
    expect(freeUndoRule(two, edit({ state: ['CA', 'NV'], category: ['HELI'] }))).toBe(false);
    expect(freeUndoRule(two, edit({ state: ['CA'] }))).toBe(false);
    expect(freeUndoRule(two, edit({ category: ['AIR'] }))).toBe(false);
  });

  it('one bound of the automatic years taken out is not the years', () => {
    expect(freeUndoRule(original(ALL), edit({ ...STATE, ...CATEGORY, yearFrom: 2008 }))).toBe(false);
    expect(freeUndoRule(original(ALL), edit({ ...STATE, ...CATEGORY, yearTo: 2012 }))).toBe(false);
    expect(freeUndoRule(original(ALL), edit({ yearTo: 2012 }))).toBe(false);
  });

  it('a filter added, a value changed or added, years moved, beside a removal or alone', () => {
    const page = original(ALL);
    expect(freeUndoRule(page, edit({ ...STATE, ...YEARS, phase: ['approach'] }))).toBe(false);
    expect(freeUndoRule(page, edit({ ...ALL, phase: ['approach'] }))).toBe(false);
    expect(freeUndoRule(page, edit({ state: ['OK'], ...YEARS, ...CATEGORY }))).toBe(false);
    expect(freeUndoRule(page, edit({ state: ['TX', 'OK'], ...YEARS }))).toBe(false);
    expect(freeUndoRule(page, edit({ ...STATE, ...CATEGORY, yearFrom: 2009, yearTo: 2012 }))).toBe(false);
    expect(freeUndoRule(page, edit({ ...STATE, yearFrom: 2008 }))).toBe(false);
    expect(freeUndoRule(page, edit({ ...STATE, ...YEARS, category: ['AIR'] }))).toBe(false);
    expect(freeUndoRule(page, edit({ ...STATE, ...YEARS, category: ['HELI', 'AIR'] }))).toBe(false);
  });

  it('nothing removed: the same filters, and no added terms to take out', () => {
    expect(freeUndoRule(original(ALL), edit({ ...ALL }))).toBe(false);
    expect(freeUndoRule(original(ALL, PLUS_TERMS), edit({ ...ALL }))).toBe(false);
    // The question's own keywords when it added no terms remove nothing, with or without a filter removed.
    expect(freeUndoRule(original(ALL), edit({ ...ALL }, { keywords: 'question' }))).toBe(false);
    expect(freeUndoRule(original(ALL), edit({}, { keywords: 'question' }))).toBe(false);
  });

  it('words of the reader’s own, even with only what AirCase added removed', () => {
    expect(freeUndoRule(original(ALL), edit({}, { terms: 'power loss' }))).toBe(false);
    expect(freeUndoRule(original(ALL, PLUS_TERMS), edit({ ...STATE }, { terms: 'power loss' }))).toBe(false);
    expect(freeUndoRule(original(ALL, PLUS_TERMS), edit({ ...ALL }, { terms: 'power loss' }))).toBe(false);
  });

  it('a page whose undo is used, or that has none', () => {
    for (const undo of ['used', 'none'] as const) {
      expect(freeUndoRule(original(ALL, QUESTION, undo), edit({}))).toBe(false);
      expect(freeUndoRule(original(ALL, QUESTION, undo), edit({ ...STATE, ...CATEGORY }))).toBe(false);
      expect(freeUndoRule(original(ALL, PLUS_TERMS, undo), edit({ ...ALL }, { keywords: 'question' }))).toBe(false);
    }
  });

  it('a filter counts as automatic only while the applied value is the automatic one', () => {
    // Shapes no server makes, for the rule's sake: the applied state is not the automatic set.
    const wider: UndoParent = { undo: 'available', query: QUESTION, appliedFilters: { state: ['OK', 'TX'], ...YEARS }, automaticFilters: { state: ['TX'], yearFrom: 2008, yearTo: 2012 } };
    expect(freeUndoRule(wider, edit({ ...YEARS }))).toBe(false);
    expect(freeUndoRule(wider, edit({ state: ['OK'], ...YEARS }))).toBe(false);
    // The years still count.
    expect(freeUndoRule(wider, edit({ state: ['OK', 'TX'] }))).toBe(true);
    const moved: UndoParent = { undo: 'available', query: QUESTION, appliedFilters: { ...STATE, yearFrom: 2010 }, automaticFilters: { state: ['TX'], yearFrom: 2008 } };
    expect(freeUndoRule(moved, edit({ ...STATE }))).toBe(false);
    expect(freeUndoRule(moved, edit({ yearFrom: 2010 }))).toBe(true);
    // A page with nothing automatic has no filter to take out for free.
    const plain: UndoParent = { undo: 'available', query: PLUS_TERMS, appliedFilters: { ...STATE }, automaticFilters: null };
    expect(freeUndoRule(plain, edit({}))).toBe(false);
    expect(freeUndoRule(plain, edit({ ...STATE }, { keywords: 'question' }))).toBe(true);
  });
});

describe('the mock API applies the same rule (web/mock/evidence.ts `quotaExempt`, standing in for the server)', () => {
  /** Every edit of `applied` the rule tells apart: each set of keys taken out, one value of several, a filter or value added, years moved. */
  function filtersOf(applied: BriefFilters): BriefFilters[] {
    const keys = ['state', 'yearFrom', 'yearTo', 'category'] as const;
    const out: BriefFilters[] = [];
    for (let removed = 0; removed < 1 << keys.length; removed++) {
      const f: BriefFilters = { ...applied };
      keys.forEach((key, i) => {
        if (removed & (1 << i)) delete f[key];
      });
      out.push(f);
    }
    if ((applied.state ?? []).length > 1) out.push({ ...applied, state: (applied.state ?? []).slice(1) });
    if ((applied.category ?? []).length > 1) out.push({ ...applied, category: (applied.category ?? []).slice(1) });
    out.push({ ...applied, phase: ['approach'] }, { ...applied, state: [...(applied.state ?? []), 'OK'] }, { ...applied, yearFrom: Math.min(2001, applied.yearTo ?? 2001) });
    return out;
  }

  it('on searches the attributed policy made and on other shapes, an edit is exempt from the visitor’s quota exactly when the client shows it free', () => {
    const mock = new MockEvidence({ config: MOCK_EVIDENCE_FIELDS_POLICY });
    const made = mock.create({ kind: 'question', question: MOCK_EVIDENCE_QUESTIONS.fields, idempotencyKey: 'fields-0001', turnstileToken: 'token' });
    const ids = [EvidencePageSchema.parse((made.body as { search: unknown }).search).id];
    const seed = (automatic: EvidenceAutomaticFilters | null, applied: BriefFilters, query: EvidenceQuery, more: { undoClaimed?: boolean; edited?: boolean } = {}) =>
      ids.push(mock.seedForTests({ question: MOCK_EVIDENCE_QUESTIONS.fields, query, appliedFilters: applied, automaticFilters: automatic, edited: more.edited ?? false, undoClaimed: more.undoClaimed ?? false }));
    seed({ state: ['CA', 'NV'], yearFrom: 2010, yearTo: 2020, category: ['AIR', 'HELI'] }, { state: ['CA', 'NV'], yearFrom: 2010, yearTo: 2020, category: ['AIR', 'HELI'] }, PLUS_TERMS);
    seed({ yearTo: 1999 }, { yearTo: 1999 }, QUESTION);
    seed({ category: ['HELI'] }, { category: ['HELI'] }, PLUS_TERMS);
    seed({ category: ['AIR', 'HELI'] }, { category: ['AIR', 'HELI'] }, QUESTION);
    seed({ state: ['TX'], yearFrom: 2008 }, { state: ['OK', 'TX'], yearFrom: 2008 }, QUESTION);
    seed({ category: ['HELI'], yearFrom: 2008 }, { category: ['AIR', 'HELI'], yearFrom: 2008 }, QUESTION);
    seed({ state: ['TX'], yearFrom: 2008 }, { state: ['TX'], yearFrom: 2010 }, PLUS_TERMS);
    seed({ ...ALL }, { ...ALL }, PLUS_TERMS, { undoClaimed: true });
    seed(null, { ...ALL }, PLUS_TERMS, { edited: true });
    let n = 0;
    let free = 0;
    for (const id of ids) {
      const page = EvidencePageSchema.parse(mock.read(id, 1).body);
      for (const filters of filtersOf(page.appliedFilters)) {
        for (const change of [{}, { keywords: 'question' }, { terms: 'power loss' }] as const) {
          n += 1;
          const body = CreateEvidenceRequestSchema.parse({ kind: 'edited', from: id, filters, ...change, idempotencyKey: `undo-${String(n).padStart(4, '0')}`, turnstileToken: 'token' }) as Extract<CreateEvidenceRequest, { kind: 'edited' }>;
          const client = freeUndoRule(page, { filters: body.filters, terms: body.terms, keywords: body.keywords });
          expect(mock.quotaExempt(body), `${JSON.stringify(page.automaticFilters)} ${page.undo}: ${JSON.stringify({ filters, ...change })}`).toBe(client);
          if (client) free += 1;
        }
      }
    }
    // Free undos of each kind are in the matrix.
    expect(free).toBeGreaterThanOrEqual(20);
  });
});
