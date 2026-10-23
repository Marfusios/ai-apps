/**
 * Deterministic case-level fusion (`retrieval.v2`; the gate's condition 5). Pure: it
 * fuses what the channels returned. Which hits a channel returns at its cut is candidate
 * discovery, decided before this code runs (the cutoff policies of
 * server/search/retrieval-config.ts: score then id inside Elasticsearch for the lexical
 * channels, approximate for kNN).
 *
 * 1. **A total order in every channel.** Each channel's returned hits are ordered by
 *    score (descending), then id (passage id, or case number in the cases channel), so
 *    equal scores inside the returned window are tied by the id whatever order the
 *    response listed them in (`orderChannel`). For the lexical channels this is the order
 *    Elasticsearch already applied; for kNN it fixes the order of the window, not which
 *    hits the approximate search found.
 * 2. **Unique cases first.** Each channel is collapsed to its unique cases in that order
 *    (a case at its best hit) before any rank is assigned, so two channels agreeing on a
 *    case through different passages both count (`uniqueCases`).
 * 3. **Exact reciprocal rank fusion.** A fused score `sum w / (k + rank)` over the lists
 *    that hold the item is compared as an exact fraction (BigInt), never as a
 *    floating-point sum: 1/70 + 1/210 and 1/105 + 1/105 are the same score and tie.
 *    `k` and the weights are non-negative integers (`retrieval.v2`: 60 and 1, 1, 1).
 * 4. **A total tie order.** Equal scores: the best rank any list gave the item, then its
 *    ranks list by list in list order (a missing rank after every rank), then its id. No
 *    two items compare equal, so the ranking is a function of the channel lists alone.
 *
 * `exactRrf` fuses both the case lists (the candidate ranking) and the two passage
 * lists (each case's passages in that order: its best supporting passage first, and
 * the passage ranks packing trims and fills by). `caseCandidates` joins them, and gives
 * a case that no passage channel returned the passages mapped to it
 * (server/search/case-mapping.ts), ranked after every fused passage.
 */
import type { PassageHit } from './hybrid.js';
import type { CaseCandidate, FusedHit } from './rrf.js';

/** `hits` in a total order: score descending, then id ascending. Scores must be finite. */
export function orderChannel<T>(hits: readonly T[], id: (t: T) => string, score: (t: T) => number): T[] {
  for (const h of hits) if (!Number.isFinite(score(h))) throw new Error(`channel hit ${id(h)} has no finite score`);
  return [...hits].sort((a, b) => score(b) - score(a) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));
}

/** The unique cases of an ordered passage list, each at its first (best) passage. */
export function uniqueCases(list: readonly { readonly ntsbNo: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of list) {
    if (seen.has(p.ntsbNo)) continue;
    seen.add(p.ntsbNo);
    out.push(p.ntsbNo);
  }
  return out;
}

/** A non-negative exact fraction `num / den` (den > 0). */
export interface Fraction {
  num: bigint;
  den: bigint;
}

/** `sum weights[i] / (k + ranks[i])` over the lists holding the item, exactly. */
export function rrfFraction(ranks: readonly (number | null)[], weights: readonly number[], k: number): Fraction {
  let num = 0n;
  let den = 1n;
  ranks.forEach((r, i) => {
    if (r === null) return;
    const d = BigInt(k + r);
    num = num * d + BigInt(weights[i] as number) * den;
    den *= d;
  });
  return { num, den };
}

/** The sign of `a - b`. */
export function compareFractions(a: Fraction, b: Fraction): number {
  const x = a.num * b.den;
  const y = b.num * a.den;
  return x > y ? 1 : x < y ? -1 : 0;
}

export interface ExactFused<T> {
  id: string;
  item: T;
  /** 1-based rank in each list, null where the list does not hold the item. */
  ranks: (number | null)[];
  /** The exact fused score. */
  fraction: Fraction;
  /** The fused score as a float, for reports only (ordering uses `fraction`). */
  score: number;
  /** 1-based position in the fused order. */
  rank: number;
}

const best = (ranks: readonly (number | null)[]) => Math.min(...ranks.map((r) => r ?? Number.POSITIVE_INFINITY));

function compareRanks(a: readonly (number | null)[], b: readonly (number | null)[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? Number.POSITIVE_INFINITY;
    const y = b[i] ?? Number.POSITIVE_INFINITY;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Reciprocal rank fusion of ordered lists, exact and totally ordered (module comment).
 * A repeated id inside one list keeps its first rank; the item kept is the first met
 * across the lists.
 */
export function exactRrf<T>(lists: readonly (readonly T[])[], idOf: (t: T) => string, weights: readonly number[], k: number): ExactFused<T>[] {
  if (!Number.isSafeInteger(k) || k < 0) throw new Error(`invalid RRF constant: ${k}`);
  if (weights.length !== lists.length) throw new Error('one weight per list');
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new Error('RRF weights must be non-negative integers');
  const byId = new Map<string, { id: string; item: T; ranks: (number | null)[] }>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    list.forEach((item, i) => {
      const id = idOf(item);
      if (seen.has(id)) return;
      seen.add(id);
      let e = byId.get(id);
      if (!e) {
        e = { id, item, ranks: lists.map(() => null) };
        byId.set(id, e);
      }
      e.ranks[li] = i + 1;
    });
  });
  return [...byId.values()]
    .map((e) => {
      const fraction = rrfFraction(e.ranks, weights, k);
      return { ...e, fraction, score: Number(fraction.num) / Number(fraction.den) };
    })
    .sort(
      (a, b) =>
        compareFractions(b.fraction, a.fraction) || best(a.ranks) - best(b.ranks) || compareRanks(a.ranks, b.ranks) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

/** The fused passage list in the shape packing reads. */
export function asFusedHits(fused: readonly ExactFused<PassageHit>[]): FusedHit<PassageHit>[] {
  return fused.map((f) => ({ id: f.id, item: f.item, score: f.score, ranks: [...f.ranks], rank: f.rank }));
}

/** Each case's fused passages, in fused order. */
export function passagesByCase(fused: readonly FusedHit<PassageHit>[]): Map<string, FusedHit<PassageHit>[]> {
  const out = new Map<string, FusedHit<PassageHit>[]>();
  for (const h of fused) out.set(h.item.ntsbNo, [...(out.get(h.item.ntsbNo) ?? []), h]);
  return out;
}

/**
 * The case ranking as packing candidates: `fusedCases` in order (1-based ranks, their
 * float scores), each case with its fused passages, or the passages `mapped` to it
 * (in their given order) ranked after every fused passage, or none.
 */
export function caseCandidates(
  fusedCases: readonly ExactFused<string>[],
  byCase: ReadonlyMap<string, readonly FusedHit<PassageHit>[]>,
  mapped: ReadonlyMap<string, readonly PassageHit[]>,
  fusedPassages: number,
  passageLists: number,
): CaseCandidate<PassageHit>[] {
  let next = fusedPassages;
  return fusedCases.map((c) => {
    const own = byCase.get(c.id);
    const passages: FusedHit<PassageHit>[] = own
      ? [...own]
      : (mapped.get(c.id) ?? []).map((p) => {
          next += 1;
          return { id: p.id, item: p, score: 0, ranks: Array.from({ length: passageLists }, () => null), rank: next };
        });
    for (const p of passages) if (p.item.ntsbNo !== c.id) throw new Error(`passage ${p.id} is not of case ${c.id}`);
    return { ntsbNo: c.id, rank: c.rank, score: c.score, passages };
  });
}
