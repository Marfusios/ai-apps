/**
 * Deterministic case-level fusion (server/search/case-fusion.ts): a total order in every
 * channel, unique cases before ranks, exact reciprocal rank fusion and a total tie order.
 */
import { describe, expect, it } from 'vitest';
import {
  caseCandidates,
  compareFractions,
  exactRrf,
  orderChannel,
  passagesByCase,
  rrfFraction,
  uniqueCases,
  asFusedHits,
} from '../../server/search/case-fusion.js';
import type { PassageHit } from '../../server/search/hybrid.js';
import { caseRrfFuse } from '../../evals/retrieval/experiments/fusion.js';
import { mulberry32 } from '../../evals/retrieval/experiments/stats.js';

const K = 60;
const hit = (id: string, ntsbNo: string): PassageHit => ({
  id,
  ntsbNo,
  sectionId: `${ntsbNo}:s`,
  revisionId: 'r',
  sectionKind: 'analysis',
  scope: 'aircraft',
  aircraftSpecific: true,
  aircraftKey: 1,
  start: 0,
  end: 1,
  part: 1,
  parts: 1,
  continuation: false,
});

/** A list holding `id` at 1-based `rank`, padded with fillers unique to the list. */
function listWith(entries: [string, number][], tag: string, length = 250): string[] {
  const out = Array.from({ length }, (_, i) => `${tag}-${i}`);
  for (const [id, rank] of entries) out[rank - 1] = id;
  return out;
}

describe('a total order in every channel', () => {
  it('orders by score, then id, whatever order Elasticsearch returned equal scores in', () => {
    const hits = [
      { id: 'c', score: 2 },
      { id: 'b', score: 3 },
      { id: 'a', score: 2 },
      { id: 'd', score: 2 },
    ];
    const ordered = orderChannel(hits, (h) => h.id, (h) => h.score).map((h) => h.id);
    expect(ordered).toEqual(['b', 'a', 'c', 'd']);
    expect(orderChannel([...hits].reverse(), (h) => h.id, (h) => h.score).map((h) => h.id)).toEqual(ordered);
    expect(hits[0]?.id).toBe('c');
    expect(() => orderChannel([{ id: 'x', score: Number.NaN }], (h) => h.id, (h) => h.score)).toThrow(/finite score/);
  });

  it('collapses a passage list to unique cases at their best passage', () => {
    expect(uniqueCases([hit('p1', 'A'), hit('p2', 'B'), hit('p3', 'A'), hit('p4', 'C'), hit('p5', 'B')])).toEqual(['A', 'B', 'C']);
  });
});

describe('exact reciprocal rank fusion', () => {
  it('compares sums as exact fractions', () => {
    const a = rrfFraction([3, 80], [1, 1], K);
    const b = rrfFraction([24, 30], [1, 1], K);
    expect(compareFractions(a, b)).toBe(0);
    // In floating point these two equal sums differ in the last bit.
    expect(1 / (K + 3) + 1 / (K + 80)).not.toBe(1 / (K + 24) + 1 / (K + 30));
    expect(compareFractions(rrfFraction([1, null], [1, 1], K), rrfFraction([2, null], [1, 1], K))).toBe(1);
    expect(compareFractions(rrfFraction([1, 1, 2], [1, 1, 1], K), rrfFraction([2, 1, 1], [1, 1, 1], K))).toBe(0);
    expect(rrfFraction([null, 2], [1, 3], K)).toEqual({ num: 3n, den: 62n });
  });

  it('ties equal sums exactly and breaks them by best rank, then ranks in list order, then id', () => {
    // (3, 80) and (24, 30) are the same score: the better best rank (3) wins.
    const fused = exactRrf([listWith([['X', 24], ['Y', 3]], 'k'), listWith([['X', 30], ['Y', 80]], 'v')], (n) => n, [1, 1], K);
    const order = fused.map((f) => f.id).filter((n) => n === 'X' || n === 'Y');
    expect(order).toEqual(['Y', 'X']);
    // Same score and best rank: the first list's rank decides; then the id.
    const swapped = exactRrf([listWith([['P', 1], ['Q', 3]], 'k'), listWith([['P', 3], ['Q', 1]], 'v')], (n) => n, [1, 1], K);
    expect(swapped.slice(0, 2).map((f) => f.id)).toEqual(['P', 'Q']);
    // b is first in the first list: the first list's rank decides before the id does.
    const ids = exactRrf([['b', 'a'], ['a', 'b']], (n) => n, [1, 1], K);
    expect(ids.map((f) => [f.id, f.ranks])).toEqual([
      ['b', [1, 2]],
      ['a', [2, 1]],
    ]);
    // Two distinct items never share every rank, so the id is the last guard of a total order.
    const sameRanks = exactRrf([['z'], ['y']], (n) => n, [1, 1], K);
    expect(sameRanks.map((f) => f.id)).toEqual(['z', 'y']);
  });

  it('three-term sums in any channel order are equal scores, never ordered by rounding', () => {
    // (1, 1, 2) and (2, 1, 1): equal in exact arithmetic, different as float sums in channel order.
    expect(1 / 61 + 1 / 61 + 1 / 62).not.toBe(1 / 62 + 1 / 61 + 1 / 61);
    const fused = exactRrf([['A', 'B'], ['A', 'B'], ['B', 'A']], (n) => n, [1, 1, 1], K);
    expect(fused.map((f) => f.ranks)).toEqual([
      [1, 1, 2],
      [2, 2, 1],
    ]);
    const tied = exactRrf([['A', 'x1'], ['A', 'x2'], ['x3', 'A']], (n) => n, [1, 1, 1], K);
    const other = exactRrf([['x1', 'B'], ['B', 'x2'], ['B', 'x3']], (n) => n, [1, 1, 1], K);
    expect(compareFractions(tied[0]!.fraction, other[0]!.fraction)).toBe(0);
  });

  it('is a total order: a function of the lists alone, whatever the arrival order of equal items', () => {
    const rand = mulberry32(20261023);
    for (let trial = 0; trial < 200; trial += 1) {
      const cases = Array.from({ length: 30 }, (_, i) => `C${String(i).padStart(3, '0')}`);
      const pick = () => cases.filter(() => rand() < 0.6).sort(() => rand() - 0.5);
      const lists = [pick(), pick(), pick()];
      const fused = exactRrf(lists, (n) => n, [1, 1, 1], K);
      expect(new Set(fused.map((f) => f.id)).size).toBe(fused.length);
      expect(fused.map((f) => f.rank)).toEqual(fused.map((_, i) => i + 1));
      // Every adjacent pair is strictly ordered by the tie rule.
      for (let i = 1; i < fused.length; i += 1) {
        const [a, b] = [fused[i - 1]!, fused[i]!];
        const c = compareFractions(a.fraction, b.fraction);
        expect(c).toBeGreaterThanOrEqual(0);
        if (c === 0) {
          const best = (r: (number | null)[]) => Math.min(...r.map((x) => x ?? Infinity));
          expect(best(a.ranks) <= best(b.ranks)).toBe(true);
        }
      }
      // The experiments harness fuses with this same comparator (task 10e fix round 1): identical order.
      expect(caseRrfFuse(lists, [1, 1, 1], K).map((f) => f.ntsbNo)).toEqual(fused.map((f) => f.id));
    }
  });

  it('refuses non-integer constants and weights', () => {
    expect(() => exactRrf([['a']], (n) => n, [0.5], K)).toThrow(/integers/);
    expect(() => exactRrf([['a']], (n) => n, [1], 60.5)).toThrow(/RRF constant/);
    expect(() => exactRrf([['a'], ['b']], (n) => n, [1], K)).toThrow(/one weight per list/);
  });
});

describe('case candidates', () => {
  it('give each case its fused passages, or its mapped passages ranked after every fused passage', () => {
    const keyword = [hit('a1', 'A'), hit('b1', 'B'), hit('a2', 'A')];
    const vector = [hit('b2', 'B'), hit('a1', 'A')];
    const fusedPassages = asFusedHits(exactRrf([keyword, vector], (p) => p.id, [1, 1], K));
    const byCase = passagesByCase(fusedPassages);
    expect(byCase.get('A')?.map((p) => p.id)).toEqual(['a1', 'a2']);
    const fusedCases = exactRrf([uniqueCases(keyword), uniqueCases(vector), ['C', 'D', 'A']], (n) => n, [1, 1, 1], K);
    const mapped = new Map([['C', [hit('c9', 'C'), hit('c3', 'C')]]]);
    const candidates = caseCandidates(fusedCases, byCase, mapped, fusedPassages.length, 2);
    expect(candidates.map((c) => c.ntsbNo)).toEqual(['A', 'B', 'C', 'D']);
    const c = candidates.find((x) => x.ntsbNo === 'C')!;
    expect(c.passages.map((p) => [p.id, p.rank, p.ranks])).toEqual([
      ['c9', fusedPassages.length + 1, [null, null]],
      ['c3', fusedPassages.length + 2, [null, null]],
    ]);
    // An unmapped case keeps no passage (packing skips it).
    expect(candidates.find((x) => x.ntsbNo === 'D')?.passages).toEqual([]);
    expect(() => caseCandidates(fusedCases, byCase, new Map([['C', [hit('x', 'D')]]]), 0, 2)).toThrow(/not of case C/);
  });
});
