/**
 * The cases-index channel (server/search/cases-channel.ts): its filter keeps the AI
 * evidence cohort and the passages contract's aircraft semantics (never keyword search's
 * "some aircraft matches"), its request refuses partial results, its hits are checked,
 * and its index is checked against the generation and a servable cases version.
 * Real indexes: tests/integration/case-retrieval.test.ts.
 */
import type { Client, estypes } from '@elastic/elasticsearch';
import { describe, expect, it } from 'vitest';
import { NO_AIRCRAFT, RetrievalFiltersSchema, aircraftClause, filterClauses, type Query, type RetrievalFilters } from '../../server/search/filters.js';
import {
  assertServableCasesIndex,
  casesAircraftClause,
  casesChannelBody,
  casesChannelFilter,
  casesOf,
} from '../../server/search/cases-channel.js';
import { IncompleteSearchError, RetrievalUnavailableError } from '../../server/search/hybrid.js';
import { CASES_INDEX_VERSION, EARLIER_SERVABLE_CASES_VERSIONS, casesIndexFingerprint } from '../../worker/index/cases-index.js';

const V2 = { eventAircraftQualification: true };
const V1 = { eventAircraftQualification: false };
const COHORT: Query[] = [{ term: { country: 'USA' } }, { term: { answer_eligible: true } }, { range: { aircraft_count: { gte: 1 } } }];

const single = (inner: Query[]): Query => ({
  bool: { filter: [{ term: { aircraft_count: 1 } }, { nested: { path: 'aircraft', query: { bool: { filter: inner } } } }] },
});
const several = (conjunction: Query[]): Query => ({
  bool: {
    filter: [{ range: { aircraft_count: { gte: 2 } } }, { nested: { path: 'aircraft', query: { match_all: {} } } }],
    must_not: [{ nested: { path: 'aircraft', query: { bool: { must_not: [{ bool: { filter: conjunction } }] } } } }],
  },
});

describe('the cases channel filter', () => {
  it('always holds the AI evidence cohort: US, answer-eligible, with aircraft rows (the only events that have passages)', () => {
    expect(casesChannelFilter({}, V2)).toEqual(COHORT);
    expect(casesChannelFilter({}, V1)).toEqual(COHORT);
  });

  it('applies event facets and years exactly as the passages compiler does', () => {
    const f: RetrievalFilters = { injury: ['FATL', 'blank'], conditions: ['IMC'], light: ['NITE'], state: ['TX'], yearFrom: 2010, yearTo: 2012 };
    const passages = filterClauses('passages', f);
    const [country, eligible, ...rest] = passages;
    expect(casesChannelFilter(f, V2)).toEqual([country, eligible, COHORT[2], ...rest]);
    expect(casesChannelFilter(f, V1)).toEqual(casesChannelFilter(f, V2));
  });

  it('under passages-v2: one aircraft meets every facet itself, or every aircraft of a multi-aircraft event does', () => {
    const inner: Query[] = [{ terms: { 'aircraft.defining_phase_group': ['landing'] } }, { terms: { 'aircraft.category': ['HELI'] } }];
    const conjunction: Query[] = [{ terms: { 'aircraft.defining_phase_group': ['landing'] } }, { terms: { 'aircraft.category': ['HELI'] } }];
    const clause = { bool: { should: [single(inner), several(conjunction)], minimum_should_match: 1 } };
    expect(casesChannelFilter({ phase: ['landing'], category: ['HELI'], yearFrom: 2015 }, V2)).toEqual([...COHORT, clause, { range: { ev_year: { gte: 2015 } } }]);
  });

  it('under passages-v1: only single-aircraft events (event-scoped passages never satisfy an aircraft filter)', () => {
    const inner: Query[] = [{ terms: { 'aircraft.category': ['HELI'] } }];
    expect(casesChannelFilter({ category: ['HELI'] }, V1)).toEqual([...COHORT, single(inner)]);
    expect(casesAircraftClause({ category: ['HELI'] }, V1)).toEqual(single(inner));
  });

  it('blank matches a missing value for the one aircraft, fails in a multi-aircraft event, and alone leaves that branch out', () => {
    const inner: Query[] = [
      { bool: { should: [{ terms: { 'aircraft.purpose': ['PERS'] } }, { bool: { must_not: [{ exists: { field: 'aircraft.purpose' } }] } }], minimum_should_match: 1 } },
    ];
    expect(casesAircraftClause({ purpose: ['PERS', 'blank'] }, V2)).toEqual({
      bool: { should: [single(inner), several([{ terms: { 'aircraft.purpose': ['PERS'] } }])], minimum_should_match: 1 },
    });
    const blankOnly: Query[] = [{ bool: { must_not: [{ exists: { field: 'aircraft.category' } }] } }];
    expect(casesAircraftClause({ category: ['blank'] }, V2)).toEqual(single(blankOnly));
    // A facet whose only value is blank removes the multi-aircraft branch, even with another facet.
    const mixed = casesAircraftClause({ category: ['HELI'], purpose: ['blank'] }, V2);
    expect(JSON.stringify(mixed)).not.toContain('"gte":2');
  });

  it('never uses keyword search’s rule: no "some aircraft" clause, no "no aircraft" branch, no event without aircraft rows', () => {
    for (const f of [{ category: ['HELI'] }, { category: ['blank'] }, { purpose: ['blank'], engine: ['blank'] }, { phase: ['landing', 'blank'], far_part: ['091'] }] as RetrievalFilters[]) {
      for (const opts of [V1, V2]) {
        const clauses = casesChannelFilter(f, opts);
        const json = JSON.stringify(clauses);
        const keywordRule = aircraftClause(RetrievalFiltersSchema.parse(f));
        expect(clauses).not.toContainEqual(keywordRule);
        expect(json).not.toContain(JSON.stringify(NO_AIRCRAFT));
        // Every aircraft branch pins the event's aircraft count: one, or at least two.
        expect(json).toMatch(/"aircraft_count":1/);
        expect(json).not.toMatch(/"aircraft_count":0|"lte"/);
        expect(clauses).toContainEqual({ range: { aircraft_count: { gte: 1 } } });
      }
    }
  });

  it('accepts only validated retrieval filters (no completion, no unknown facet)', () => {
    expect(() => casesChannelFilter({ completion: ['in_progress'] } as unknown as RetrievalFilters, V2)).toThrow();
    expect(() => casesChannelFilter({ category: ['NOPE'] } as unknown as RetrievalFilters, V2)).toThrow();
  });
});

describe('the cases channel request and hits', () => {
  it('BM25 over the configured fields with the keyword text, the filter as bool.filter, no partial results, the cut by score then case number', () => {
    const body = casesChannelBody('cases-x', 'fuel selector', ['probable_cause', 'analysis', 'factual'], COHORT, 200);
    expect(body).toEqual({
      index: 'cases-x',
      size: 200,
      track_total_hits: false,
      allow_partial_search_results: false,
      _source: ['ntsb_no'],
      query: {
        bool: {
          must: [{ multi_match: { query: 'fuel selector', fields: ['probable_cause', 'analysis', 'factual'], type: 'best_fields', operator: 'or' } }],
          filter: COHORT,
        },
      },
      // Applied while Elasticsearch collects the top 200: equal scores at the cut go by case number.
      sort: [{ _score: { order: 'desc' } }, { ntsb_no: { order: 'asc' } }],
    });
  });

  const response = (hits: Record<string, unknown>[], over: Record<string, unknown> = {}) =>
    ({
      timed_out: false,
      _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
      hits: { hits },
      ...over,
    }) as unknown as estypes.SearchResponse<Record<string, unknown>>;

  it('checks each response: complete, a valid case number and score per hit, no case twice', () => {
    expect(casesOf(response([{ _id: '1', _score: 3, _source: { ntsb_no: 'CEN19FA024' } }]))).toEqual([{ ntsbNo: 'CEN19FA024', score: 3 }]);
    const fails: [Record<string, unknown>[], Record<string, unknown>][] = [
      [[], { timed_out: true }],
      [[], { _shards: { total: 2, successful: 1, skipped: 0, failed: 1 } }],
      [[{ _id: '1', _score: 3, _source: {} }], {}],
      [[{ _id: '1', _score: 3, _source: { ntsb_no: 'bad no' } }], {}],
      [[{ _id: '1', _score: null, _source: { ntsb_no: 'CEN19FA024' } }], {}],
      [
        [
          { _id: '1', _score: 3, _source: { ntsb_no: 'CEN19FA024' } },
          { _id: '2', _score: 2, _source: { ntsb_no: 'CEN19FA024' } },
        ],
        {},
      ],
    ];
    for (const [hits, over] of fails) {
      const err = (() => {
        try {
          casesOf(response(hits, over));
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(IncompleteSearchError);
      expect((err as IncompleteSearchError).request).toBe('cases');
    }
  });
});

describe('the cases index check', () => {
  const client = (meta: Record<string, unknown> | null, calls: { n: number }) =>
    ({
      indices: {
        getMapping: async ({ index }: { index: string }) => {
          calls.n += 1;
          if (!meta) throw Object.assign(new Error('missing'), { meta: { statusCode: 404 } });
          return { [index]: { mappings: { _meta: meta } } };
        },
      },
    }) as unknown as Client;
  const ok = { index_version: CASES_INDEX_VERSION, fingerprint: casesIndexFingerprint(), generation_id: 7 };

  it('accepts a servable version of the same generation and remembers the pass', async () => {
    const calls = { n: 0 };
    const es = client(ok, calls);
    expect(await assertServableCasesIndex(es, 'cases-ok-1', 7)).toEqual({ index: 'cases-ok-1', indexVersion: CASES_INDEX_VERSION });
    await assertServableCasesIndex(es, 'cases-ok-1', 7);
    expect(calls.n).toBe(1);
    const [v2, fp] = Object.entries(EARLIER_SERVABLE_CASES_VERSIONS)[0]!;
    expect(await assertServableCasesIndex(client({ ...ok, index_version: v2, fingerprint: fp }, calls), 'cases-ok-2', 7)).toMatchObject({ indexVersion: v2 });
  });

  it('refuses another generation, an unknown version or fingerprint and a missing index, and never remembers a failure', async () => {
    const calls = { n: 0 };
    for (const [meta, re] of [
      [{ ...ok, generation_id: 8 }, /generation 8, not 7/],
      [{ ...ok, fingerprint: 'f'.repeat(64) }, /not a servable cases index/],
      [{ ...ok, index_version: 'cases-v9' }, /not a servable cases index/],
      [{ ...ok, generation_id: undefined }, /generation unknown/],
      [null, /does not exist/],
    ] as [Record<string, unknown> | null, RegExp][]) {
      const es = client(meta, calls);
      for (let i = 0; i < 2; i += 1) {
        const err = await assertServableCasesIndex(es, 'cases-bad', 7).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RetrievalUnavailableError);
        expect(err).toMatchObject({ reason: 'index_mismatch', message: expect.stringMatching(re) });
      }
    }
    expect(calls.n).toBe(10);
  });
});
