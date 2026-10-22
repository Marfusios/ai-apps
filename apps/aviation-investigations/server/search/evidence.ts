/**
 * Evidence packing (stage 2 of retrieval; amendments A3, A11, A13). Pure: it takes the
 * case-candidate ranking, each candidate case's probable-cause passages and the
 * passages' token counts, and returns the bundle the compose stage sees.
 *
 * 1. **Cases.** Walk the case ranking and select at most `maxCases`. A case is
 *    selected only together with every probable-cause passage it has under the
 *    request's filters (each aircraft's own cause, continuation parts included). A
 *    case without one, or whose causes no longer fit the passage or token budget, is
 *    skipped and the next case is tried: fewer, well-supported cases are preferred
 *    over thin ones (A11).
 * 2. **Diversify.** Each selected case contributes its `retrievedPerCase` best
 *    retrieved passages (fused order). A retrieved probable cause counts among them.
 *    `maxPassagesPerCase` (cause included) caps a case here and in step 5; only a
 *    case with more cause passages than the cap (an event with many aircraft) goes
 *    over it, with its causes alone.
 * 3. **Attach causes.** Each selected case's probable-cause passages are added if they
 *    were not retrieved. They count toward every limit from the start (A11).
 * 4. **Trim.** While the bundle holds more than `maxPassages` passages or more than
 *    `maxEvidenceTokens` tokens, the lowest-ranked passage that is not a probable
 *    cause is dropped. Causes are never dropped: step 1 already made them fit.
 * 5. **Fill.** Free capacity goes to the next-best retrieved passages of the selected
 *    cases, in fused order, while a case holds fewer than `maxPassagesPerCase`
 *    passages (cause included) and the bundle stays within both budgets.
 *
 * Within a case, passages are returned in reading order (factual, analysis, probable
 * cause; then section and part), each with its role and fused rank.
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
  /** Retrieved passages per case in the diversification pass (a retrieved cause counts). */
  retrievedPerCase: number;
  /** Passages per case after filling, cause included. */
  maxPassagesPerCase: number;
  /** Passage-text tokens (`cl100k_base`) of the whole bundle. */
  maxEvidenceTokens: number;
}

export type PackRole = 'retrieved' | 'probable_cause' | 'fill';

export interface PackedPassage<P extends PackablePassage> {
  passage: P;
  /** `probable_cause` for every cause passage, retrieved or attached. */
  role: PackRole;
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

export type SkipReason = 'no_probable_cause' | 'cause_over_budget';

export interface PackResult<P extends PackablePassage> {
  cases: PackedCase<P>[];
  passages: number;
  tokens: number;
  /** Candidate cases passed over before `maxCases` were selected. */
  skipped: { ntsbNo: string; caseRank: number; reason: SkipReason }[];
  /** Retrieved passages of selected cases removed by the trim. */
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

  // 1. Cases, with room for their causes.
  type Slot = { candidate: CaseCandidate<P>; chosen: Map<string, PackedPassage<P>> };
  const slots: Slot[] = [];
  let count = 0;
  let tokens = 0;
  for (const candidate of input.cases) {
    if (slots.length >= o.maxCases) break;
    const causes = input.probableCauses.get(candidate.ntsbNo) ?? [];
    if (causes.length === 0) {
      skipped.push({ ntsbNo: candidate.ntsbNo, caseRank: candidate.rank, reason: 'no_probable_cause' });
      continue;
    }
    const causeTokens = causes.reduce((sum, p) => sum + input.tokensOf(p), 0);
    if (count + causes.length > o.maxPassages || tokens + causeTokens > o.maxEvidenceTokens) {
      skipped.push({ ntsbNo: candidate.ntsbNo, caseRank: candidate.rank, reason: 'cause_over_budget' });
      continue;
    }
    const retrieved = new Map(candidate.passages.map((h) => [h.id, h]));
    const chosen = new Map<string, PackedPassage<P>>();
    // 3 (done first so a cause always holds its place). Causes keep their fused rank when retrieved.
    for (const p of causes) {
      if (p.ntsbNo !== candidate.ntsbNo || p.sectionKind !== 'probable_cause') {
        throw new Error(`passage ${p.id} is not a probable cause of ${candidate.ntsbNo}`);
      }
      const hit = retrieved.get(p.id);
      chosen.set(p.id, { passage: p, role: 'probable_cause', fusedRank: hit?.rank ?? null, fusedScore: hit?.score ?? null, tokens: input.tokensOf(p) });
    }
    slots.push({ candidate, chosen });
    count += causes.length;
    tokens += causeTokens;
  }

  const isCause = (h: FusedHit<P>) => h.item.sectionKind === 'probable_cause';
  const add = (slot: Slot, h: FusedHit<P>, role: PackRole) => {
    const packed: PackedPassage<P> = { passage: h.item, role, fusedRank: h.rank, fusedScore: h.score, tokens: input.tokensOf(h.item) };
    slot.chosen.set(h.id, packed);
    count += 1;
    tokens += packed.tokens;
  };

  // 2. Diversify: the case's best retrieved passages; a retrieved cause is already chosen and counts.
  for (const slot of slots) {
    for (const h of slot.candidate.passages.slice(0, o.retrievedPerCase)) {
      if (slot.chosen.has(h.id)) continue;
      // Every cause under the filters was attached in step 1; skip anything else claiming to be one.
      if (isCause(h)) continue;
      if (slot.chosen.size >= o.maxPassagesPerCase) break;
      add(slot, h, 'retrieved');
    }
  }

  // 4. Trim the lowest-ranked non-cause passages until both budgets hold.
  while (count > o.maxPassages || tokens > o.maxEvidenceTokens) {
    let worst: { slot: Slot; p: PackedPassage<P> } | null = null;
    for (const slot of slots) {
      for (const p of slot.chosen.values()) {
        if (p.role === 'probable_cause' || p.fusedRank === null) continue;
        if (!worst || p.fusedRank > (worst.p.fusedRank as number)) worst = { slot, p };
      }
    }
    if (!worst) throw new Error('the probable causes alone exceed the bundle limits'); // excluded by step 1
    worst.slot.chosen.delete(worst.p.passage.id);
    count -= 1;
    tokens -= worst.p.tokens;
    trimmed.push({ id: worst.p.passage.id, ntsbNo: worst.p.passage.ntsbNo, fusedRank: worst.p.fusedRank as number });
  }

  // 5. Fill free capacity in fused order, within the per-case cap and both budgets.
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
