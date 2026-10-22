import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SearchRequestSchema, SearchResponseSchema, type SearchResponse } from '../../shared/contracts/search.js';
import { HOME_EXAMPLES } from '../../shared/examples.js';
import { buildMockApi, buildMockCorpus, readFixtureTables, serialize, type MockApiFiles } from '../../scripts/mock-api/build.js';
import { searchCorpus, stem, type MockCorpus } from '../../web/mock/engine.js';
import { normalizeCorpus } from '../../worker/ingest/normalize.js';

const appDir = join(import.meta.dirname, '..', '..');
let files: MockApiFiles;
let corpus: MockCorpus;

beforeAll(async () => {
  files = await buildMockApi(appDir);
  corpus = buildMockCorpus(normalizeCorpus(await readFixtureTables(appDir)));
});

const search = (query: Record<string, string>): SearchResponse => {
  const response = searchCorpus(corpus, SearchRequestSchema.parse(query));
  SearchResponseSchema.parse(response);
  return response;
};
const count = (r: SearchResponse, facet: keyof SearchResponse['facets'], value: string): number | undefined =>
  r.facets[facet].find((b) => b.value === value)?.count;

describe('mock API build', () => {
  it('committed web/mock files are current (run pnpm mock:build after changing fixtures or projections)', () => {
    for (const [name, content] of Object.entries(files)) {
      expect(readFileSync(join(appDir, 'web/mock', name), 'utf8'), name).toBe(serialize(content));
    }
  });

  it('search covers US events only; every case still has a detail', () => {
    expect(corpus.docs.every((d) => d.row.country === 'USA')).toBe(true);
    expect(corpus.cases.ENG08WA029?.country).toBe('PE');
    expect(corpus.docs.some((d) => d.row.ntsbNo === 'ENG08WA029')).toBe(false);
  });
});

describe('mock search counting', () => {
  it('search carburetor icing returns completed matches with highlighted probable causes', () => {
    const r = search({ q: 'carburetor icing' });
    expect(r.total).toBeGreaterThanOrEqual(5);
    expect(r.rows.every((row) => row.completion.class === 'completed')).toBe(true);
    const row = r.rows.find((x) => x.ntsbNo === 'ERA25LA016');
    expect(row?.snippet?.section).toBe('probable_cause');
    const marked = (row?.snippet?.highlights ?? []).map((h) => row?.snippet?.text.slice(h.start, h.end).toLowerCase());
    // Adjacent matched words form one mark.
    expect(marked).toContain('carburetor icing');
    // "carburetor ice" matches through stemming, as the English analyzer would.
    expect(r.rows.map((x) => x.ntsbNo)).toContain('WPR24LA154');
  });

  it('records outside the default cohort are counted in the completion facet but not listed', () => {
    const r = search({ q: 'carburetor icing' });
    expect(count(r, 'completion', 'other_status')).toBe(2);
    const all = search({ q: 'carburetor icing', completion: 'any' });
    expect(all.total).toBe(r.total + 2);
  });

  it('disjunctive phase counts ignore the phase selection but apply other filters', () => {
    const base = search({ q: 'carburetor icing' });
    const climb = search({ q: 'carburetor icing', phase: 'initial_climb' });
    expect(climb.total).toBe(count(base, 'phase', 'initial_climb'));
    expect(climb.facets.phase).toEqual(base.facets.phase);
    // Other facets narrow to the phase selection.
    const climbInjuries = climb.facets.injury.reduce((n, b) => n + b.count, 0);
    expect(climbInjuries).toBe(climb.total);
  });

  it('counts distinct events, with the defining phase of each aircraft (A14)', () => {
    const r = search({ q: 'midair', completion: 'any' });
    expect(r.total).toBe(2);
    expect(r.multiAircraft).toBe(2);
    // DCA25MA108 (an airplane and a helicopter) counts under both categories, so the
    // category buckets sum to one more than the total; two-airplane events count once.
    const all = search({ completion: 'any' });
    expect(all.facets.category.reduce((n, b) => n + b.count, 0)).toBe(all.total + 1);
    expect(count(all, 'category', 'HELI')).toBe(4);
  });

  it('SEA08LA057 counts under both of its aircraft defining phases, once each', () => {
    const r = search({ q: 'SEA08LA057' });
    expect(r.total).toBe(1);
    expect(count(r, 'phase', 'landing')).toBe(1);
    expect(count(r, 'phase', 'initial_climb')).toBe(1);
    expect(count(r, 'category', 'AIR')).toBe(1);
    expect(r.multiAircraft).toBe(1);
  });

  it('mentionedIn counts every report hit and the probable-cause subset', () => {
    const r = search({ q: 'midair', completion: 'any' });
    expect(r.mentionedIn).toEqual({ anywhere: 2, probable_cause: 1 });
    expect(search({ q: 'midair', completion: 'any', mentionedIn: 'probable_cause' }).total).toBe(1);
  });

  it('no results reports the total after dropping each active filter', () => {
    const r = search({ q: 'carburetor icing', phase: 'landing', injury: 'FATL' });
    expect(r.total).toBe(0);
    expect(r.relaxations.map((x) => x.drop)).toEqual(['completion', 'phase', 'injury']);
    expect(r.relaxations.find((x) => x.drop === 'phase')?.count).toBe(search({ q: 'carburetor icing', injury: 'FATL' }).total);
    // Selected values stay visible with a zero count.
    expect(count(r, 'phase', 'landing')).toBe(0);
  });

  it('years split the default cohort from other records, ignoring year and completion filters', () => {
    const r = search({ q: 'carburetor icing', yearFrom: '2020' });
    const y2025 = r.years.find((y) => y.year === 2025);
    expect(y2025).toEqual({ year: 2025, completed: 0, other: 1 });
    expect(r.years[0]?.year).toBe(2008);
    expect(r.rows.every((row) => (row.date ?? '') >= '2020')).toBe(true);
  });

  it('pages and sorts by date', () => {
    const newest = search({ pageSize: '5' });
    const oldest = search({ pageSize: '5', sort: 'oldest' });
    expect(newest.rows).toHaveLength(5);
    expect(newest.rows[0]?.date && oldest.rows[0]?.date && newest.rows[0].date > oldest.rows[0].date).toBe(true);
    const page2 = search({ pageSize: '5', page: '2' });
    expect(page2.rows[0]?.ntsbNo).not.toBe(newest.rows[0]?.ntsbNo);
  });

  it('every home example chip returns results (UI_DESIGN §4.2)', () => {
    // Mock corpus only. Task 8's real-server search test must repeat this against the
    // Elasticsearch index (all words, stemming, synonyms), as UI_DESIGN §4.2 requires.
    for (const q of HOME_EXAMPLES) {
      expect(search({ q }).total, q).toBeGreaterThan(0);
    }
  });

  it('stems like a light English stemmer', () => {
    expect(stem('icing')).toBe(stem('ice'));
    expect(stem('carburetors')).toBe(stem('carburetor'));
    expect(stem('stalled')).toBe(stem('stall'));
  });
});
