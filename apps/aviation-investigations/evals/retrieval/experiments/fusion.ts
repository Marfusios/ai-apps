/**
 * Fusion for the retrieval experiments (task 10d, phase A). Pure.
 *
 * - `weightedRrfFuse`: passage-level RRF with a weight per list, `sum w / (k + rank)`.
 *   With every weight 1 it *is* the production `rrfFuse` (it delegates), so the
 *   baseline never goes through experiment code.
 * - `caseRrfFuse`: case-level RRF. Each channel is first collapsed to its unique cases
 *   in list order (a case at its best passage), then fused over those case ranks, so
 *   agreement on the same case through different passages counts. Since task 10e it is
 *   production's own comparator (`exactRrf`, server/search/case-fusion.ts): exact
 *   fractions and the total tie order (best rank, ranks list by list, case number), with
 *   the weights scaled to the smallest equivalent integers (`integerWeights`), so a
 *   harness variant orders tied cases exactly as the adopted code would.
 * - `roundRobinCases`: a bounded, channel-balanced case pool: the lists' unique cases
 *   taken in turn, first list first, skipping cases already taken.
 * - `candidatesFor`: a case order as packing candidates. Each case keeps its passages
 *   in passage-fused order; a case only the case-level channel found gets the passages
 *   `mapped` to it (`cases-channel.ts`), ranked after every fused passage.
 */
import { exactRrf } from '../../../server/search/case-fusion.js';
import { rankCases, rrfFuse, type CaseCandidate, type FusedHit, type RankedItem } from '../../../server/search/rrf.js';
import type { PassageHit } from '../../../server/search/hybrid.js';

/** Weighted RRF over ranked lists; the production `rrfFuse` when every weight is 1. */
export function weightedRrfFuse<T extends RankedItem>(lists: readonly (readonly T[])[], weights: readonly number[], k: number): FusedHit<T>[] {
  if (weights.length !== lists.length) throw new Error('one weight per list');
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new Error('weights must be finite and non-negative');
  if (weights.every((w) => w === 1)) return rrfFuse(lists, k);
  if (!Number.isFinite(k) || k < 0) throw new Error(`invalid RRF constant: ${k}`);
  const byId = new Map<string, Omit<FusedHit<T>, 'rank'>>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    const w = weights[li] as number;
    list.forEach((item, i) => {
      if (seen.has(item.id)) return;
      seen.add(item.id);
      const rank = i + 1;
      let hit = byId.get(item.id);
      if (!hit) {
        hit = { id: item.id, item, score: 0, ranks: lists.map(() => null) };
        byId.set(item.id, hit);
      }
      hit.ranks[li] = rank;
      hit.score += w / (k + rank);
    });
  });
  const best = (h: Omit<FusedHit<T>, 'rank'>) => Math.min(...h.ranks.map((r) => r ?? Number.POSITIVE_INFINITY));
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || best(a) - best(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((h, i) => ({ ...h, rank: i + 1 }));
}

/** The unique cases of a passage list, in list order (each case at its first, best passage). */
export function uniqueCaseOrder(list: readonly { readonly ntsbNo: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of list) {
    if (seen.has(p.ntsbNo)) continue;
    seen.add(p.ntsbNo);
    out.push(p.ntsbNo);
  }
  return out;
}

export interface FusedCase {
  ntsbNo: string;
  score: number;
  /** 1-based rank in each case list, null where the list does not hold the case. */
  ranks: (number | null)[];
  rank: number;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * The smallest non-negative integers in the same proportions as `weights` (RRF orders are
 * unchanged by scaling every weight alike), for production's exact comparator. Weights
 * with more than six decimals are refused.
 */
export function integerWeights(weights: readonly number[]): number[] {
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new Error('weights must be finite and non-negative');
  for (let scale = 1; scale <= 1_000_000; scale *= 10) {
    const scaled = weights.map((w) => w * scale);
    if (scaled.every((x) => Math.abs(x - Math.round(x)) < 1e-9 && Number.isSafeInteger(Math.round(x)))) {
      const ints = scaled.map((x) => Math.round(x));
      const g = ints.reduce((a, b) => gcd(a, b), 0);
      return g > 1 ? ints.map((x) => x / g) : ints;
    }
  }
  throw new Error('weights need at most six decimals to be fused exactly');
}

/** Case-level weighted RRF over case lists (each list's cases unique; a repeat keeps its first rank), exactly as production fuses. */
export function caseRrfFuse(lists: readonly (readonly string[])[], weights: readonly number[], k: number): FusedCase[] {
  if (weights.length !== lists.length) throw new Error('one weight per list');
  return exactRrf(lists, (n) => n, integerWeights(weights), k).map((c) => ({ ntsbNo: c.id, score: c.score, ranks: [...c.ranks], rank: c.rank }));
}

/** A channel-balanced pool: the lists' cases taken in turn (first list first), unique, at most `size`. */
export function roundRobinCases(lists: readonly (readonly string[])[], size: number): string[] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('invalid pool size');
  const out: string[] = [];
  const taken = new Set<string>();
  const next = lists.map(() => 0);
  for (;;) {
    let progressed = false;
    for (let li = 0; li < lists.length; li += 1) {
      if (out.length >= size) return out;
      const list = lists[li] as readonly string[];
      let i = next[li] as number;
      while (i < list.length && taken.has(list[i] as string)) i += 1;
      if (i < list.length) {
        const n = list[i] as string;
        taken.add(n);
        out.push(n);
        progressed = true;
        i += 1;
      }
      next[li] = i;
    }
    if (!progressed) return out;
  }
}

/** The fused passage list grouped by case (each case's passages in fused order), as `rankCases` groups it. */
export function passagesByCase(fused: readonly FusedHit<PassageHit>[]): Map<string, FusedHit<PassageHit>[]> {
  return new Map(rankCases(fused, 'best').map((c) => [c.ntsbNo, c.passages]));
}

/**
 * `order` as packing candidates (1-based ranks in that order, `scores` when given).
 * Passages come from `byCase`; a case missing there gets its `mapped` passages, ranked
 * after every fused passage (`fusedCount`), in their given order; otherwise none.
 */
export function candidatesFor(
  order: readonly string[],
  byCase: ReadonlyMap<string, readonly FusedHit<PassageHit>[]>,
  mapped: ReadonlyMap<string, readonly PassageHit[]>,
  fusedCount: number,
  scores?: ReadonlyMap<string, number>,
): CaseCandidate<PassageHit>[] {
  let nextRank = fusedCount;
  return order.map((ntsbNo, i) => {
    const own = byCase.get(ntsbNo);
    let passages: FusedHit<PassageHit>[];
    if (own) passages = [...own];
    else {
      passages = (mapped.get(ntsbNo) ?? []).map((p) => {
        nextRank += 1;
        return { id: p.id, item: p, score: 0, ranks: [], rank: nextRank };
      });
    }
    return { ntsbNo, rank: i + 1, score: scores?.get(ntsbNo) ?? 0, passages };
  });
}
