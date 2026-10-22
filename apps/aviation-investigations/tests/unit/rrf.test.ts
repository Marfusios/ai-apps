import { describe, expect, it } from 'vitest';
import { RRF_K, asRanking, rankCases, rrfFuse } from '../../server/search/rrf.js';

const item = (id: string, ntsbNo = id.split(':')[0] as string) => ({ id, ntsbNo });
const ids = (hits: { id: string }[]) => hits.map((h) => h.id);

describe('reciprocal rank fusion', () => {
  it('rrf ranks item in both lists above single-list items', () => {
    // "b" is second in both lists; "a" and "c" are first in one list each.
    const fused = rrfFuse([[item('a'), item('b')], [item('c'), item('b')]]);
    expect(ids(fused)).toEqual(['b', 'a', 'c']);
    expect(fused[0]?.score).toBeCloseTo(2 / (RRF_K + 2), 12);
    expect(fused[0]?.ranks).toEqual([2, 2]);
    expect(fused[1]?.ranks).toEqual([1, null]);
    // Deep in both lists still beats the top of one list alone: 2/(60+30) > 1/(60+1).
    const deep = rrfFuse([
      [item('x'), ...Array.from({ length: 28 }, (_, i) => item(`k${i}`)), item('both')],
      [item('y'), ...Array.from({ length: 28 }, (_, i) => item(`v${i}`)), item('both')],
    ]);
    expect(deep[0]?.id).toBe('both');
  });

  it('scores sum(1 / (k + rank)) with 1-based ranks and a configurable k', () => {
    const [top] = rrfFuse([[item('a')], [item('a')]], 0);
    expect(top?.score).toBe(2);
    const fused = rrfFuse([[item('a'), item('b'), item('c')]], 10);
    expect(fused.map((h) => h.score)).toEqual([1 / 11, 1 / 12, 1 / 13]);
    expect(fused.map((h) => h.rank)).toEqual([1, 2, 3]);
    expect(() => rrfFuse([[item('a')]], -1)).toThrow(/RRF constant/);
  });

  it('orders ties by the best single-list rank, then by id, so results are deterministic', () => {
    // c and d have the same ranks (1 and 2) and so the same score and the same best rank.
    const fused = rrfFuse([[item('d'), item('c')], [item('c'), item('d')]]);
    expect(ids(fused)).toEqual(['c', 'd']);
    const again = rrfFuse([[item('d'), item('c')], [item('c'), item('d')]]);
    expect(again).toEqual(fused);
  });

  it('keeps the first rank of an id repeated inside one list', () => {
    const fused = rrfFuse([[item('a'), item('b'), item('a')]]);
    expect(fused.find((h) => h.id === 'a')?.ranks).toEqual([1]);
    expect(fused).toHaveLength(2);
  });

  it('takes one list as it is', () => {
    expect(ids(asRanking([item('z'), item('a')]))).toEqual(['z', 'a']);
  });
});

describe('case candidates', () => {
  it('deduplicates passages to cases at their best passage', () => {
    const fused = rrfFuse([[item('A:1'), item('B:1'), item('A:2'), item('C:1')], [item('B:2'), item('A:1')]]);
    const cases = rankCases(fused);
    expect(cases.map((c) => c.ntsbNo)).toEqual(['A', 'B', 'C']);
    expect(cases.map((c) => c.rank)).toEqual([1, 2, 3]);
    expect(cases[0]?.passages.map((h) => h.id)).toEqual(['A:1', 'A:2']);
    expect(cases[0]?.score).toBe(fused[0]?.score);
  });

  it('can order cases by the sum of their passages instead', () => {
    // A has one top passage; B has three middling ones.
    const fused = rrfFuse([[item('A:1'), item('B:1'), item('B:2'), item('B:3')]]);
    expect(rankCases(fused, 'best').map((c) => c.ntsbNo)).toEqual(['A', 'B']);
    expect(rankCases(fused, 'sum').map((c) => c.ntsbNo)).toEqual(['B', 'A']);
  });
});
