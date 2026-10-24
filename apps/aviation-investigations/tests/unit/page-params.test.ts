/**
 * What Explore and Compare read from their query strings (shared/page-params.ts), shared by the
 * client and the server, which titles those pages on every request without a rate limit. The
 * readers keep their meaning and do bounded work, however long and hostile the query string.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchRequestSchema, defaultSearchRequest } from '../../shared/contracts/search.js';
import { readCompare, readSearchRequest } from '../../shared/page-params.js';
import { HOSTILE_COMPARES, HOSTILE_SEARCHES } from '../support/hostile-queries.js';

const read = (qs: string) => readSearchRequest(new URLSearchParams(qs));

afterEach(() => vi.restoreAllMocks());

describe('reading the search request', () => {
  it('keeps a valid request as it is', () => {
    expect(read('q=carburetor+icing&phase=approach,landing&injury=FATL&yearFrom=2010&yearTo=2020&sort=oldest&page=2')).toMatchObject({
      q: 'carburetor icing',
      phase: ['approach', 'landing'],
      injury: ['FATL'],
      yearFrom: 2010,
      yearTo: 2020,
      sort: 'oldest',
      page: 2,
    });
    expect(read('')).toEqual(defaultSearchRequest());
  });

  it('keeps the valid values of a facet, trimmed, each once, from lists and repeated keys alike', () => {
    expect(read('phase=approach,bogus&q=x').phase).toEqual(['approach']);
    expect(read('phase= approach , landing ,,').phase).toEqual(['approach', 'landing']);
    expect(read('phase=approach&phase=landing,approach').phase).toEqual(['approach', 'landing']);
    expect(read('q=x&phase=approach,bogus').q).toBe('x');
  });

  it('a facet given only values it does not have is ignored; an empty one is an empty selection', () => {
    expect(read('completion=bogus').completion).toEqual(['completed_with_cause']);
    expect(read('phase=bogus,also-bogus').phase).toEqual([]);
    expect(read('completion=').completion).toEqual([]);
    expect(read('completion=any').completion).toEqual([]);
    expect(read('completion=any,bogus').completion).toEqual([]);
  });

  it('a list longer than its facet, of the same value again and again, is that value', () => {
    const r = read(`q=icing&phase=${'approach,'.repeat(200)}`);
    expect(r.phase).toEqual(['approach']);
    expect(r.q).toBe('icing');
  });

  it('drops other values the contract refuses, and a year range that ends before it starts', () => {
    expect(read('sort=bogus&q=x')).toMatchObject({ sort: 'newest', q: 'x' });
    expect(read(`q=${'x'.repeat(1501)}&phase=approach`)).toMatchObject({ q: '', phase: ['approach'] });
    const years = read('yearFrom=2020&yearTo=2010&q=x');
    expect(years.yearFrom).toBeUndefined();
    expect(years.yearTo).toBeUndefined();
    expect(years.q).toBe('x');
  });
});

describe('reading the compared cases', () => {
  it('valid numbers, upper case, each once, at most four, in the order given', () => {
    const params = new URLSearchParams('cases=dfw08ta066, SEA08LA057,bad!,DFW08TA066,ERA25LA016,CEN09CA566,ANC15LA005');
    expect(readCompare(params)).toEqual(['DFW08TA066', 'SEA08LA057', 'ERA25LA016', 'CEN09CA566']);
    expect(readCompare(new URLSearchParams('cases=x,y'))).toEqual([]);
    expect(readCompare(new URLSearchParams())).toEqual([]);
  });
});

describe('bounded work for any query string', () => {
  it.each(HOSTILE_SEARCHES)('%s: the contract is parsed a fixed number of times, never once per item', (_name, qs) => {
    expect(qs.length).toBeGreaterThan(15_000);
    const parse = vi.spyOn(SearchRequestSchema, 'safeParse');
    readSearchRequest(new URLSearchParams(qs));
    // The whole request, each of its 17 keys alone, the valid keys, and those without the years.
    expect(parse.mock.calls.length).toBeLessThanOrEqual(1 + 17 + 2);
  });

  it.each(HOSTILE_COMPARES)('compare, %s: nothing valid, nothing read back', (_name, qs) => {
    expect(qs.length).toBeGreaterThan(15_000);
    expect(readCompare(new URLSearchParams(qs))).toEqual([]);
  });
});
