/**
 * Application-side reciprocal rank fusion (DESIGN §5): a passage's fused score is
 * `sum over channels of 1 / (k + rank)`, with 1-based ranks and `k = 60`. Elasticsearch's
 * own RRF retriever needs a paid licence; this needs nothing but the two ranked lists.
 *
 * Ordering is total and deterministic: fused score (descending), then the best rank
 * any list gave the item, then the item id. Fusion never looks at the channels' raw
 * scores, which are not comparable (BM25 vs cosine).
 *
 * `rankCases` turns the fused passage list into the case-candidate ranking (amendment
 * A13): each case appears once, at its best passage (`best`, the default) or by the
 * sum of its passages' fused scores (`sum`, for evaluation).
 */

/** The RRF constant of DESIGN §5. */
export const RRF_K = 60;

export interface RankedItem {
  readonly id: string;
}

export interface FusedHit<T extends RankedItem> {
  id: string;
  item: T;
  /** Sum of `1 / (k + rank)` over the lists that hold the item. */
  score: number;
  /** 1-based rank in each input list, `null` where the list does not hold the item. */
  ranks: (number | null)[];
  /** 1-based position in the fused list. */
  rank: number;
}

/**
 * Fuse ranked lists with reciprocal rank fusion. A repeated id inside one list keeps
 * its first (best) rank; the item kept is the first one met across the lists.
 */
export function rrfFuse<T extends RankedItem>(lists: readonly (readonly T[])[], k = RRF_K): FusedHit<T>[] {
  if (!Number.isFinite(k) || k < 0) throw new Error(`invalid RRF constant: ${k}`);
  const byId = new Map<string, Omit<FusedHit<T>, 'rank'>>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
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
      hit.score += 1 / (k + rank);
    });
  });
  const best = (h: Omit<FusedHit<T>, 'rank'>) => Math.min(...h.ranks.map((r) => r ?? Number.POSITIVE_INFINITY));
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || best(a) - best(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((h, i) => ({ ...h, rank: i + 1 }));
}

/** A ranked list taken as it is (one channel alone), in the fused shape. */
export function asRanking<T extends RankedItem>(list: readonly T[], k = RRF_K): FusedHit<T>[] {
  return rrfFuse([list], k);
}

export type CaseScoring = 'best' | 'sum';

export interface CaseCandidate<T extends RankedItem & { readonly ntsbNo: string }> {
  ntsbNo: string;
  /** 1-based case rank. */
  rank: number;
  /** The best passage's fused score (`best`) or the sum over the case's passages (`sum`). */
  score: number;
  /** The case's passages in fused order. */
  passages: FusedHit<T>[];
}

/**
 * The case-candidate ranking of a fused passage list (amendment A13): unique cases,
 * ordered by `scoring`; ties keep the order of each case's best passage.
 */
export function rankCases<T extends RankedItem & { readonly ntsbNo: string }>(
  fused: readonly FusedHit<T>[],
  scoring: CaseScoring = 'best',
): CaseCandidate<T>[] {
  const byCase = new Map<string, { first: number; score: number; passages: FusedHit<T>[] }>();
  for (const hit of fused) {
    const c = byCase.get(hit.item.ntsbNo);
    if (!c) byCase.set(hit.item.ntsbNo, { first: hit.rank, score: hit.score, passages: [hit] });
    else {
      c.passages.push(hit);
      if (scoring === 'sum') c.score += hit.score;
    }
  }
  return [...byCase.entries()]
    .sort(([, a], [, b]) => (scoring === 'sum' ? b.score - a.score : 0) || a.first - b.first)
    .map(([ntsbNo, c], i) => ({ ntsbNo, rank: i + 1, score: c.score, passages: c.passages }));
}
