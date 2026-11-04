/**
 * The one free undo, held to the server's rule (server/evidence/undo.ts `canUndo`) over the
 * parents and edits the rule tells apart: the web client's rule (web/src/features/evidence/undo.ts)
 * reading the page as the server projects it (`pageOf`, with its read-time `undo` hint), and the mock
 * API's (web/mock/evidence.ts, `quotaExempt` and its own `undo` hint), each exactly. The parents carry
 * an automatic state, years (both bounds, or one) and an aircraft category, alone and together
 * (DESIGN "Evidence.v3"): an undo takes out whole automatic facets, the added terms, or both, and
 * nothing else. A legacy v2 search offers no free undo in the interface.
 */
import { describe, expect, it } from 'vitest';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { CreateEvidenceRequestSchema, EvidencePageSchema, type CreateEvidenceRequest, type EvidenceAutomaticFilters, type EvidenceQuery } from '../../shared/contracts/evidence.js';
import { canUndo } from '../../server/evidence/undo.js';
import { pageOf, type EvidenceRow } from '../../server/evidence/store.js';
import { MockEvidence } from '../../web/mock/evidence.js';
import { addedTerms, forgetUndos, freeUndoRule, rememberCharged, undoWasCharged } from '../../web/src/features/evidence/undo.js';

const now = new Date('2026-10-25T12:00:00Z');
const ID = '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f';
const question = 'Carb icing on approach in Texas';

interface Parent {
  name: string;
  version: 'evidence.v3' | 'evidence.v2';
  edited: boolean;
  query: EvidenceQuery;
  automaticFilters: EvidenceAutomaticFilters | null;
  appliedFilters: BriefFilters;
  freeUndo: boolean;
  claimed: boolean;
  expired: boolean;
}

function row(p: Parent): EvidenceRow {
  return {
    traceId: null, feedbackRating: null, feedbackDay: null, id: ID, readOwner: 'a'.repeat(64), readOwnerKind: 'trial', ownerMovedAt: null,
    billingPrincipal: 'a'.repeat(64), billingKind: 'trial', reservationId: 1, freeUndoReservationId: p.claimed ? 7 : null,
    generationId: 1, casesIndex: 'test-cases', passagesIndex: 'test-passages', status: 'results', createdAt: now,
    expiresAt: new Date(now.getTime() + (p.expired ? -1 : 86_400_000)),
    data: {
      question, edited: p.edited, version: p.version, query: p.query,
      context: { dataset: { revision: 'g1', snapshotDate: '2026-10-01' }, citationTextVersion: 'v1', fieldNormalizationVersion: 'v1', mappingVerified: false },
      automaticFilters: p.automaticFilters, appliedFilters: p.appliedFilters, suggestion: null, hint: null, note: null,
      marks: 'search_words', freeUndo: p.freeUndo, cases: [], ranking: [],
    },
  } as EvidenceRow;
}

const QUESTION: EvidenceQuery = { source: 'question', keywords: { kind: 'question' } };
const PLUS_TERMS: EvidenceQuery = { source: 'question', keywords: { kind: 'question+terms', terms: 'carb icing' } };
const TERMS: EvidenceQuery = { source: 'question', keywords: { kind: 'terms', terms: 'carb icing' } };
const OWN_WORDS: EvidenceQuery = { source: 'edited', terms: 'carburetor heat' };

/** What an undo takes out whole: the state set, the years (both bounds, one facet, even with one open), the aircraft category set. */
type Facet = 'state' | 'years' | 'category';
const FACET_KEYS = { state: ['state'], years: ['yearFrom', 'yearTo'], category: ['category'] } as const satisfies Record<Facet, readonly (keyof BriefFilters)[]>;
const FACETS = Object.keys(FACET_KEYS) as Facet[];

/** `filters` without the given facets. */
function without(filters: BriefFilters, facets: readonly Facet[]): BriefFilters {
  const out: Record<string, unknown> = { ...filters };
  for (const facet of facets) for (const key of FACET_KEYS[facet]) delete out[key];
  return out as BriefFilters;
}

/** A question search's applied filters: what its policy applied on its own (the question request carries none). */
const appliedOf = (automatic: EvidenceAutomaticFilters | null): BriefFilters => (automatic ? (structuredClone(automatic) as BriefFilters) : {});

/**
 * The automatic filters an original can carry: each facet alone (several states or categories, a
 * one-sided year range either way), any two, all three.
 */
const AUTOMATIC: EvidenceAutomaticFilters[] = [
  { state: ['TX'] },
  { state: ['CA', 'NV'] },
  { yearFrom: 2010, yearTo: 2015 },
  { yearFrom: 2008 },
  { yearTo: 1999 },
  { category: ['HELI'] },
  { category: ['AIR', 'HELI'] },
  { state: ['TX'], yearFrom: 2008 },
  { state: ['CA', 'NV'], category: ['HELI'] },
  { yearFrom: 2010, yearTo: 2015, category: ['AIR', 'HELI'] },
  { state: ['TX'], yearFrom: 2008, yearTo: 2012, category: ['HELI'] },
  { state: ['CA', 'NV'], yearTo: 1999, category: ['AIR', 'HELI'] },
];

/**
 * Originals whose applied filters are not just what the policy added: a facet whose applied value is
 * not the automatic one is no automatic filter to take out, and a filter beside it stays.
 */
const DIVERGED: { automatic: EvidenceAutomaticFilters; applied: BriefFilters }[] = [
  { automatic: { state: ['TX'], yearFrom: 2008 }, applied: { state: ['OK', 'TX'], yearFrom: 2008 } },
  { automatic: { category: ['HELI'], yearFrom: 2008 }, applied: { category: ['AIR', 'HELI'], yearFrom: 2008 } },
  { automatic: { state: ['TX'], yearFrom: 2008 }, applied: { state: ['TX'], yearFrom: 2010 } },
  { automatic: { yearFrom: 2008 }, applied: { yearFrom: 2008, yearTo: 2012 } },
  { automatic: { state: ['TX'], category: ['HELI'] }, applied: { state: ['TX'], category: ['HELI'], phase: ['approach'] } },
];

/** Every v3 parent shape the rule distinguishes: originals with and without additions, edits that look like them, and the conditions that end an undo. */
function parents(): Parent[] {
  const out: Parent[] = [];
  const base = { version: 'evidence.v3' as const, freeUndo: false, claimed: false, expired: false };
  for (const query of [QUESTION, PLUS_TERMS, TERMS]) {
    for (const automaticFilters of [null, ...AUTOMATIC]) {
      const original: Parent = { name: `original ${JSON.stringify(query)} ${JSON.stringify(automaticFilters)}`, edited: false, query, automaticFilters, appliedFilters: appliedOf(automaticFilters), ...base };
      out.push(original, { ...original, name: `${original.name}, claimed`, claimed: true }, { ...original, name: `${original.name}, expired`, expired: true });
    }
    for (const { automatic, applied } of DIVERGED) {
      out.push({ name: `original ${JSON.stringify(query)} ${JSON.stringify(automatic)} applied as ${JSON.stringify(applied)}`, edited: false, query, automaticFilters: automatic, appliedFilters: applied, ...base });
    }
    // Edits that kept the question: filters of the reader's (also years and a category, as an automatic search has them), none left (it looks like an original), and an undo.
    out.push({ name: `edit with a filter ${JSON.stringify(query)}`, edited: true, query, automaticFilters: null, appliedFilters: { phase: ['approach'] }, ...base });
    out.push({ name: `edit with years and a category ${JSON.stringify(query)}`, edited: true, query, automaticFilters: null, appliedFilters: { state: ['TX'], yearFrom: 2008, category: ['HELI'] }, ...base });
    out.push({ name: `edit with no filter ${JSON.stringify(query)}`, edited: true, query, automaticFilters: null, appliedFilters: {}, ...base });
    out.push({ name: `undo ${JSON.stringify(query)}`, edited: true, query, automaticFilters: null, appliedFilters: {}, ...base, freeUndo: true });
  }
  out.push({ name: 'edit with words', edited: true, query: OWN_WORDS, automaticFilters: null, appliedFilters: {}, ...base });
  return out;
}

type Edit = Extract<CreateEvidenceRequest, { kind: 'edited' }>;

/** Filters as one key: facets as sets, keys in order. */
const filterKey = (f: BriefFilters): string => JSON.stringify(Object.entries(f).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]));

/**
 * Every edit of `p` the rule tells apart: the filters kept; every set of whole facets taken out (the
 * state, both year bounds, the category); one value of several, one of two year bounds, a moved
 * endpoint, a bound added to a one-sided range, a new value or another filter, also beside a whole
 * facet taken out; everything out. Each sends words, the question's keywords or neither.
 */
function edits(p: Parent): Edit[] {
  const a = p.appliedFilters;
  const present = FACETS.filter((facet) => FACET_KEYS[facet].some((key) => a[key] !== undefined));
  const filters: BriefFilters[] = [a, {}, { ...a, injury: ['FATL'] }, { injury: ['FATL'] }];
  for (let mask = 1; mask < 1 << present.length; mask++) {
    const rest = without(a, present.filter((_facet, i) => mask & (1 << i)));
    filters.push(rest, { ...rest, injury: ['FATL'] });
  }
  const changed: BriefFilters[] = [];
  if ((a.state ?? []).length > 1) changed.push({ ...a, state: (a.state ?? []).slice(1) });
  if ((a.category ?? []).length > 1) changed.push({ ...a, category: (a.category ?? []).slice(1) });
  if (a.yearFrom !== undefined && a.yearTo !== undefined) {
    const { yearFrom: _from, ...upperOnly } = a;
    const { yearTo: _to, ...lowerOnly } = a;
    changed.push(upperOnly, lowerOnly);
  }
  if (a.yearFrom !== undefined) changed.push({ ...a, yearFrom: a.yearFrom + 1 });
  if (a.yearTo !== undefined) changed.push({ ...a, yearTo: a.yearTo + 1 });
  if (a.yearFrom === undefined && a.yearTo !== undefined) changed.push({ ...a, yearFrom: 1990 });
  if (a.yearFrom !== undefined && a.yearTo === undefined) changed.push({ ...a, yearTo: 2020 });
  if (a.state) changed.push({ ...a, state: [...new Set([...a.state, 'OK'])] as BriefFilters['state'] });
  if (a.category) changed.push({ ...a, category: [...new Set([...a.category, 'GLI'])] as BriefFilters['category'] });
  filters.push(...changed);
  // A change beside a whole facet taken out is still a change.
  for (const c of changed) for (const facet of present) filters.push(without(c, [facet]));
  const seen = new Set<string>();
  const out: Edit[] = [];
  for (const f of filters) {
    if (seen.has(filterKey(f))) continue;
    seen.add(filterKey(f));
    for (const change of [{}, { keywords: 'question' }, { terms: 'carb icing' }, { terms: 'carburetor heat' }]) {
      out.push(CreateEvidenceRequestSchema.parse({ kind: 'edited', from: ID, filters: f, ...change, idempotencyKey: 'undo-12345678' }) as Edit);
    }
  }
  return out;
}

const describeEdit = (e: Edit): string => JSON.stringify({ filters: e.filters, terms: e.terms, keywords: e.keywords });

/** What a free edit of `p` took out: its whole facets (in order) and, with `+terms`, the added terms. */
function kindOf(p: Parent, e: Edit): string {
  const removed = FACETS.filter((facet) => FACET_KEYS[facet].some((key) => p.appliedFilters[key] !== undefined) && FACET_KEYS[facet].every((key) => e.filters[key] === undefined));
  return `${removed.join('+') || 'nothing'}${e.keywords === 'question' ? ' +terms' : ''}`;
}

describe('the client’s free-undo rule is the server’s', () => {
  it('on every parent the page can be read for, “free” exactly when the server would make the edit free', () => {
    const free = new Set<string>();
    let read = 0;
    let decisions = 0;
    for (const p of parents()) {
      const saved = row(p);
      const page = pageOf(saved, 1, now);
      if (p.expired) {
        // A search that is gone has no page (a 404), and no undo.
        expect(page, p.name).toBeNull();
        for (const e of edits(p)) expect(canUndo(saved, e, now), p.name).toBe(false);
        continue;
      }
      if (!page) throw new Error(`no page for ${p.name}`);
      read += 1;
      for (const e of edits(p)) {
        const server = canUndo(saved, e, now);
        expect(freeUndoRule(page, { filters: e.filters, terms: e.terms, keywords: e.keywords }), `${p.name}: ${describeEdit(e)}`).toBe(server);
        decisions += 1;
        if (server) free.add(kindOf(p, e));
      }
    }
    // The matrix holds free undos of every kind: each facet alone, any two, all three, with and
    // without the added terms, and the terms alone; and every readable parent.
    const facetSets = ['state', 'years', 'category', 'state+years', 'state+category', 'years+category', 'state+years+category'];
    expect([...free].sort()).toEqual([...facetSets, ...facetSets.map((s) => `${s} +terms`), 'nothing +terms'].sort());
    expect(read).toBe(parents().filter((p) => !p.expired).length);
    expect(decisions).toBeGreaterThan(5_000);
  });

  it('the page’s undo hint: available on an original with something added until claimed, then used; none for edits and for nothing added', () => {
    for (const p of parents().filter((x) => !x.expired)) {
      const hint = pageOf(row(p), 1, now)?.undo;
      const additions = p.automaticFilters !== null || addedTerms(p.query) !== null;
      expect(hint, p.name).toBe(p.edited || !additions ? 'none' : p.claimed ? 'used' : 'available');
    }
  });

  it('a legacy v2 search offers no free undo in the interface, even with recorded added terms', () => {
    const legacy = row({ name: 'v2', version: 'evidence.v2', edited: false, query: PLUS_TERMS, automaticFilters: null, appliedFilters: {}, freeUndo: false, claimed: false, expired: false });
    const page = EvidencePageSchema.parse(pageOf(legacy, 1, now));
    expect(page.undo).toBe('none');
    for (const e of edits({ name: 'v2', version: 'evidence.v2', edited: false, query: PLUS_TERMS, automaticFilters: null, appliedFilters: {}, freeUndo: false, claimed: false, expired: false })) {
      expect(freeUndoRule(page, { filters: e.filters, terms: e.terms, keywords: e.keywords }), describeEdit(e)).toBe(false);
    }
  });

  it('only a question search with added terms has terms to take out', () => {
    expect(addedTerms(QUESTION)).toBeNull();
    expect(addedTerms(OWN_WORDS)).toBeNull();
    expect(addedTerms(PLUS_TERMS)).toEqual({ kind: 'question+terms', terms: 'carb icing' });
    expect(addedTerms(TERMS)).toEqual({ kind: 'terms', terms: 'carb icing' });
  });
});

describe('the free undo’s decisions on automatic states, years and categories: the server’s, the client’s and the mock’s alike', () => {
  const ALL: EvidenceAutomaticFilters = { state: ['TX'], yearFrom: 2008, yearTo: 2012, category: ['HELI'] };
  /** Every set of the three facets to take out: each alone, any two, all three. */
  const SUBSETS = [1, 2, 3, 4, 5, 6, 7].map((mask) => FACETS.filter((_facet, i) => mask & (1 << i)));
  /** [what, the parent's automatic filters, its query, the edit's filters, whether it sends the question's keywords, free] */
  const table: [string, EvidenceAutomaticFilters, EvidenceQuery, BriefFilters, boolean, boolean][] = [
    // Years alone: both bounds are one facet; a one-sided range is one facet too.
    ['both automatic year bounds out', { yearFrom: 2010, yearTo: 2015 }, QUESTION, {}, false, true],
    ['the lower of two automatic year bounds out', { yearFrom: 2010, yearTo: 2015 }, QUESTION, { yearTo: 2015 }, false, false],
    ['the upper of two automatic year bounds out', { yearFrom: 2010, yearTo: 2015 }, QUESTION, { yearFrom: 2010 }, false, false],
    ['an automatic lower bound moved', { yearFrom: 2010, yearTo: 2015 }, QUESTION, { yearFrom: 2011, yearTo: 2015 }, false, false],
    ['an automatic upper bound moved', { yearFrom: 2010, yearTo: 2015 }, QUESTION, { yearFrom: 2010, yearTo: 2016 }, false, false],
    ['a one-sided automatic range (to) out', { yearTo: 1999 }, QUESTION, {}, false, true],
    ['a one-sided automatic range (from) out', { yearFrom: 2008 }, QUESTION, {}, false, true],
    ['a one-sided automatic range moved', { yearTo: 1999 }, QUESTION, { yearTo: 1998 }, false, false],
    ['a bound added to a one-sided automatic range', { yearFrom: 2008 }, QUESTION, { yearFrom: 2008, yearTo: 2012 }, false, false],
    // Category alone: the whole set, never one value of several.
    ['the one automatic category out', { category: ['HELI'] }, QUESTION, {}, false, true],
    ['one of two automatic categories out', { category: ['AIR', 'HELI'] }, QUESTION, { category: ['HELI'] }, false, false],
    ['both automatic categories out', { category: ['AIR', 'HELI'] }, QUESTION, {}, false, true],
    ['a category added to the automatic one', { category: ['HELI'] }, QUESTION, { category: ['AIR', 'HELI'] }, false, false],
    // State alone, as before.
    ['the automatic state out', { state: ['TX'] }, QUESTION, {}, false, true],
    ['one of two automatic states out', { state: ['CA', 'NV'] }, QUESTION, { state: ['NV'] }, false, false],
    ['both automatic states out', { state: ['CA', 'NV'] }, QUESTION, {}, false, true],
    // All three: each facet alone, any two, all three, with and without the added terms.
    ...SUBSETS.flatMap((removed) => [PLUS_TERMS, TERMS, QUESTION].flatMap((query) => [false, true].map((keywords) => [
      `${removed.join('+')} out of all three${keywords ? ', and the added terms' : ''}, ${query.source === 'question' ? query.keywords.kind : 'edited'}`,
      ALL, query, without(appliedOf(ALL), removed), keywords,
      // The question's keywords are sent only to take out added terms.
      !keywords || addedTerms(query) !== null,
    ] as [string, EvidenceAutomaticFilters, EvidenceQuery, BriefFilters, boolean, boolean]))),
    ['the added terms alone, all three kept', ALL, PLUS_TERMS, appliedOf(ALL), true, true],
    ['nothing taken out', ALL, PLUS_TERMS, appliedOf(ALL), false, false],
    ['the state out and one year bound', ALL, PLUS_TERMS, { yearFrom: 2008, category: ['HELI'] }, false, false],
    ['the years out and the category widened', ALL, PLUS_TERMS, { state: ['TX'], category: ['AIR', 'HELI'] }, true, false],
    ['the category out and an endpoint moved', ALL, TERMS, { state: ['TX'], yearFrom: 2009, yearTo: 2012 }, false, false],
    ['everything out and another filter added', ALL, PLUS_TERMS, { injury: ['FATL'] }, true, false],
  ];

  it.each(table)('%s', (_what, automatic, query, filters, keywords, expected) => {
    const p: Parent = { name: _what, version: 'evidence.v3', edited: false, query, automaticFilters: automatic, appliedFilters: appliedOf(automatic), freeUndo: false, claimed: false, expired: false };
    const saved = row(p);
    const edit = CreateEvidenceRequestSchema.parse({ kind: 'edited', from: ID, filters, ...(keywords ? { keywords: 'question' } : {}), idempotencyKey: 'undo-12345678' }) as Edit;
    expect(canUndo(saved, edit, now), 'server').toBe(expected);
    const page = pageOf(saved, 1, now);
    if (!page) throw new Error('no page');
    expect(freeUndoRule(page, { filters: edit.filters, terms: edit.terms, keywords: edit.keywords }), 'client').toBe(expected);
    const mock = new MockEvidence({ now: () => now });
    const id = mock.seedForTests({ question, query, appliedFilters: p.appliedFilters, automaticFilters: automatic, edited: false });
    expect(mock.quotaExempt({ ...edit, from: id, idempotencyKey: 'mock-undo-table', turnstileToken: 'token' }), 'mock').toBe(expected);
  });
});

describe('the mock API’s free undo is the server’s', () => {
  it('quotaExempt and the page’s undo hint agree with canUndo and pageOf on every parent and edit', () => {
    let n = 0;
    for (const p of parents()) {
      const mock = new MockEvidence({ now: () => now });
      const id = mock.seedForTests({ question, query: p.query, appliedFilters: p.appliedFilters, automaticFilters: p.automaticFilters, edited: p.edited, freeUndo: p.freeUndo, undoClaimed: p.claimed, expired: p.expired });
      const saved = row(p);
      // The same page, or the same 404.
      const read = mock.read(id, 1);
      const page = pageOf(saved, 1, now);
      if (page === null) expect(read.status, p.name).toBe(404);
      else expect((read.body as { undo: string }).undo, p.name).toBe(page.undo);
      for (const e of edits(p)) {
        n += 1;
        const body = { ...e, from: id, idempotencyKey: `mock-undo-${String(n).padStart(5, '0')}`, turnstileToken: 'token' };
        expect(mock.quotaExempt(body), `${p.name}: ${describeEdit(e)}`).toBe(canUndo(saved, e, now));
      }
    }
  });
});

describe('what the tab remembers', () => {
  it('a counted undo is said on the search it made, until the visitor changes', () => {
    forgetUndos();
    expect(undoWasCharged('child-1')).toBe(false);
    rememberCharged('child-1');
    expect(undoWasCharged('child-1')).toBe(true);
    forgetUndos();
    expect(undoWasCharged('child-1')).toBe(false);
  });
});
