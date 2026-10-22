/**
 * Evidence packing (stage 2 of retrieval; amendments A3, A11, A13; review gate G5 #2).
 * Pure: it takes the case-candidate ranking, each candidate case's probable-cause
 * passages and the passages' token counts, and returns the bundle the compose stage
 * sees.
 *
 * 1. **Reserve.** Walk the case ranking and select at most `maxCases`. Each selected
 *    case reserves its justification: its best retrieved passage (the one that ranked
 *    it) plus every probable-cause passage it has under the request's filters (each
 *    aircraft's own cause variant, continuation parts included), deduplicated. A case
 *    without a cause, or whose reservation no longer fits the passage or token budget,
 *    is skipped and the next case is tried: fewer, well-supported cases are preferred
 *    over thin ones (A11). Reserved passages are never removed afterwards, so a case
 *    never ends up holding only causes it was not retrieved for.
 * 2. **Diversify.** Each selected case adds its next best retrieved passages until it
 *    holds `retrievedPerCase` retrieved passages (a retrieved cause counts) or
 *    `maxPassagesPerCase` passages (causes included).
 * 3. **Trim.** While the bundle holds more than `maxPassages` passages or more than
 *    `maxEvidenceTokens` tokens, the lowest-ranked passage added in step 2 is dropped.
 * 4. **Fill.** Free capacity goes to the next-best retrieved passages of the selected
 *    cases, in fused order, while a case holds fewer than `maxPassagesPerCase`
 *    passages and the bundle stays within both budgets.
 *
 * Only a case whose reservation alone exceeds `maxPassagesPerCase` (an event with
 * several distinct causes) goes over that cap, with its reservation alone.
 *
 * Within a case, passages are returned in reading order (factual, analysis, probable
 * cause; then section and part), each with its role, whether it was reserved, and its
 * fused rank.
 */
import type { CaseCandidate, FusedHit } from './rrf.js';

export const SECTION_ORDER = { factual: 0, analysis: 1, probable_cause: 2 } as const;
export type PassageKind = keyof typeof SECTION_ORDER;

/** What packing needs to know about a passage. */
export interface PackablePassage {
  readonly id: string;
  readonly ntsbNo: string;
  readonly sectionId: string;
  readonly sectionKind: PassageKind;
  readonly part: number;
}

export interface PackOptions {
  maxCases: number;
  maxPassages: number;
  /** Retrieved passages per case in the diversification pass (the best one and a retrieved cause count). */
  retrievedPerCase: number;
  /** Passages per case after filling, causes included. */
  maxPassagesPerCase: number;
  /** Passage-text tokens (`cl100k_base`) of the whole bundle. */
  maxEvidenceTokens: number;
}

export type PackRole = 'retrieved' | 'probable_cause' | 'fill';

export interface PackedPassage<P extends PackablePassage> {
  passage: P;
  /** `probable_cause` for every cause passage, retrieved or attached. */
  role: PackRole;
  /** Part of the case's reservation (its best retrieved passage and its causes): never trimmed. */
  reserved: boolean;
  /** 1-based fused rank, `null` for a cause that was attached without being retrieved. */
  fusedRank: number | null;
  fusedScore: number | null;
  tokens: number;
}

export interface PackedCase<P extends PackablePassage> {
  ntsbNo: string;
  /** 1-based rank in the case-candidate ranking. */
  caseRank: number;
  caseScore: number;
  passages: PackedPassage<P>[];
}

export type SkipReason = 'no_probable_cause' | 'no_retrieved_passage' | 'over_budget';

export interface PackResult<P extends PackablePassage> {
  cases: PackedCase<P>[];
  passages: number;
  tokens: number;
  /** Candidate cases passed over before `maxCases` were selected. */
  skipped: { ntsbNo: string; caseRank: number; reason: SkipReason }[];
  /** Diversification passages of selected cases removed by the trim. */
  trimmed: { id: string; ntsbNo: string; fusedRank: number }[];
}

export interface PackInput<P extends PackablePassage> {
  cases: readonly CaseCandidate<P>[];
  /** Probable-cause passages of each candidate case under the request's filters. */
  probableCauses: ReadonlyMap<string, readonly P[]>;
  /** Passage-text tokens of a passage (every retrieved passage of a selected case and every cause). */
  tokensOf: (p: P) => number;
}

function checkOptions(o: PackOptions): void {
  const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (![o.maxCases, o.maxPassages, o.retrievedPerCase, o.maxPassagesPerCase, o.maxEvidenceTokens].every(positive)) {
    throw new Error('packing limits must be positive integers');
  }
}

const readingOrder = <P extends PackablePassage>(a: PackedPassage<P>, b: PackedPassage<P>) =>
  SECTION_ORDER[a.passage.sectionKind] - SECTION_ORDER[b.passage.sectionKind] ||
  (a.passage.sectionId < b.passage.sectionId ? -1 : a.passage.sectionId > b.passage.sectionId ? 1 : 0) ||
  a.passage.part - b.passage.part;

export function packEvidence<P extends PackablePassage>(input: PackInput<P>, o: PackOptions): PackResult<P> {
  checkOptions(o);
  const skipped: PackResult<P>['skipped'] = [];
  const trimmed: PackResult<P>['trimmed'] = [];
  const packed = (p: P, role: PackRole, reserved: boolean, hit: FusedHit<P> | undefined): PackedPassage<P> => ({
    passage: p,
    role,
    reserved,
    fusedRank: hit?.rank ?? null,
    fusedScore: hit?.score ?? null,
    tokens: input.tokensOf(p),
  });

  // 1. Reserve each selected case's best retrieved passage and every cause variant.
  type Slot = { candidate: CaseCandidate<P>; chosen: Map<string, PackedPassage<P>> };
  const slots: Slot[] = [];
  let count = 0;
  let tokens = 0;
  for (const candidate of input.cases) {
    if (slots.length >= o.maxCases) break;
    const skip = (reason: SkipReason) => skipped.push({ ntsbNo: candidate.ntsbNo, caseRank: candidate.rank, reason });
    const causes = input.probableCauses.get(candidate.ntsbNo) ?? [];
    if (causes.length === 0) {
      skip('no_probable_cause');
      continue;
    }
    const best = candidate.passages[0];
    if (!best) {
      skip('no_retrieved_passage');
      continue;
    }
    const retrieved = new Map(candidate.passages.map((h) => [h.id, h]));
    const chosen = new Map<string, PackedPassage<P>>();
    for (const p of causes) {
      if (p.ntsbNo !== candidate.ntsbNo || p.sectionKind !== 'probable_cause') {
        throw new Error(`passage ${p.id} is not a probable cause of ${candidate.ntsbNo}`);
      }
      chosen.set(p.id, packed(p, 'probable_cause', true, retrieved.get(p.id)));
    }
    if (!chosen.has(best.id)) chosen.set(best.id, packed(best.item, 'retrieved', true, best));
    let size = 0;
    let weight = 0;
    for (const p of chosen.values()) {
      size += 1;
      weight += p.tokens;
    }
    if (count + size > o.maxPassages || tokens + weight > o.maxEvidenceTokens) {
      skip('over_budget');
      continue;
    }
    slots.push({ candidate, chosen });
    count += size;
    tokens += weight;
  }

  const isCause = (h: FusedHit<P>) => h.item.sectionKind === 'probable_cause';
  const add = (slot: Slot, h: FusedHit<P>, role: PackRole) => {
    const p = packed(h.item, role, false, h);
    slot.chosen.set(h.id, p);
    count += 1;
    tokens += p.tokens;
  };

  // 2. Diversify: the next best retrieved passages, up to `retrievedPerCase` retrieved ones.
  for (const slot of slots) {
    let retrievedHeld = [...slot.chosen.values()].filter((p) => p.fusedRank !== null).length;
    for (const h of slot.candidate.passages) {
      if (retrievedHeld >= o.retrievedPerCase || slot.chosen.size >= o.maxPassagesPerCase) break;
      if (slot.chosen.has(h.id)) continue;
      // Every cause under the filters was reserved in step 1; skip anything else claiming to be one.
      if (isCause(h)) continue;
      add(slot, h, 'retrieved');
      retrievedHeld += 1;
    }
  }

  // 3. Trim the lowest-ranked unreserved passages until both budgets hold.
  while (count > o.maxPassages || tokens > o.maxEvidenceTokens) {
    let worst: { slot: Slot; p: PackedPassage<P> } | null = null;
    for (const slot of slots) {
      for (const p of slot.chosen.values()) {
        if (p.reserved || p.fusedRank === null) continue;
        if (!worst || p.fusedRank > (worst.p.fusedRank as number)) worst = { slot, p };
      }
    }
    if (!worst) throw new Error('the reservations alone exceed the bundle limits'); // excluded by step 1
    worst.slot.chosen.delete(worst.p.passage.id);
    count -= 1;
    tokens -= worst.p.tokens;
    trimmed.push({ id: worst.p.passage.id, ntsbNo: worst.p.passage.ntsbNo, fusedRank: worst.p.fusedRank as number });
  }

  // 4. Fill free capacity in fused order, within the per-case cap and both budgets.
  const trimmedIds = new Set(trimmed.map((t) => t.id));
  const rest = slots
    .flatMap((slot) => slot.candidate.passages.filter((h) => !slot.chosen.has(h.id) && !trimmedIds.has(h.id) && !isCause(h)).map((h) => ({ slot, h })))
    .sort((a, b) => a.h.rank - b.h.rank);
  for (const { slot, h } of rest) {
    if (count >= o.maxPassages) break;
    if (slot.chosen.size >= o.maxPassagesPerCase) continue;
    if (tokens + input.tokensOf(h.item) > o.maxEvidenceTokens) continue;
    add(slot, h, 'fill');
  }

  const cases: PackedCase<P>[] = slots.map((slot) => ({
    ntsbNo: slot.candidate.ntsbNo,
    caseRank: slot.candidate.rank,
    caseScore: slot.candidate.score,
    passages: [...slot.chosen.values()].sort(readingOrder),
  }));
  return { cases, passages: count, tokens, skipped, trimmed };
}
