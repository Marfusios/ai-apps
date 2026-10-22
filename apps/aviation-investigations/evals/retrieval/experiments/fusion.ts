/**
 * Fusion for the retrieval experiments (task 10d, phase A). Pure.
 *
 * - `weightedRrfFuse`: passage-level RRF with a weight per list, `sum w / (k + rank)`.
 *   With every weight 1 it *is* the production `rrfFuse` (it delegates), so the
 *   baseline never goes through experiment code.
 * - `caseRrfFuse`: case-level RRF. Each channel is first collapsed to its unique cases
 *   in list order (a case at its best passage), then fused over those case ranks, so
 *   agreement on the same case through different passages counts. Ties: the best rank
 *   any list gave the case, then the case number (deterministic).
 * - `roundRobinCases`: a bounded, channel-balanced case pool: the lists' unique cases
 *   taken in turn, first list first, skipping cases already taken.
 * - `candidatesFor`: a case order as packing candidates. Each case keeps its passages
 *   in passage-fused order; a case only the case-level channel found gets the passages
 *   `mapped` to it (`cases-channel.ts`), ranked after every fused passage.
 */
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

/** Case-level weighted RRF over case lists (each list's cases unique; a repeat keeps its first rank). */
export function caseRrfFuse(lists: readonly (readonly string[])[], weights: readonly number[], k: number): FusedCase[] {
  if (weights.length !== lists.length) throw new Error('one weight per list');
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) throw new Error('weights must be finite and non-negative');
  if (!Number.isFinite(k) || k < 0) throw new Error(`invalid RRF constant: ${k}`);
  const byCase = new Map<string, Omit<FusedCase, 'rank'>>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    const w = weights[li] as number;
    list.forEach((ntsbNo, i) => {
      if (seen.has(ntsbNo)) return;
      seen.add(ntsbNo);
      let c = byCase.get(ntsbNo);
      if (!c) {
        c = { ntsbNo, score: 0, ranks: lists.map(() => null) };
        byCase.set(ntsbNo, c);
      }
      c.ranks[li] = i + 1;
      c.score += w / (k + i + 1);
    });
  });
  const best = (c: Omit<FusedCase, 'rank'>) => Math.min(...c.ranks.map((r) => r ?? Number.POSITIVE_INFINITY));
  return [...byCase.values()]
    .sort((a, b) => b.score - a.score || best(a) - best(b) || (a.ntsbNo < b.ntsbNo ? -1 : a.ntsbNo > b.ntsbNo ? 1 : 0))
    .map((c, i) => ({ ...c, rank: i + 1 }));
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
