/**
 * The evidence checker's verdicts, judged in code (check.v4; gate G6 conditions 3 and 5).
 * The model's output is never trusted to be complete or consistent:
 *
 * **Completeness, deterministic.** Exactly one verdict for every claim id the server
 * issued (`C1`..): a missing id (`check_missing_verdict`), a repeated id
 * (`check_duplicate_verdict`) or an id the server never issued (`check_unknown_claim`)
 * withholds the summary. A truncated, refused, unparseable or schema-invalid response
 * never reaches this module: the adapter fails the stage, which withholds too.
 *
 * **References.** Every passage a verdict names must be a supplied passage of a case the
 * claim is about (`check_invalid_evidence`). A `supported` verdict rests on passages the
 * claim cites (support found only elsewhere is not support for that citation); an absence
 * claim (it cites every supplied passage of its case) may name none. A `contradicted`
 * verdict names the passages that conflict. A quote must belong to a `contradicted`
 * verdict, come from one of its passages and be found there word for word under the
 * quote rule (`quote-ws-v2`), once per claim (`check_invalid_quote`). A verified quote
 * shows the words exist, not that they entail anything.
 *
 * **Aggregation, conservative.** Only a claim judged `supported` can be shown, whatever
 * its kind: any `contradicted` or `not_established` verdict withholds the summary. A
 * displayed absence claim needs `supported` too: `not_established` never authorizes "no
 * maintenance was mentioned". A `contradicted` verdict on a server claim that the
 * supplied passages do not settle a criterion is also recorded as `chronology_missed`: a
 * likely extraction failure (or a checker error), diagnostic only. It withholds like any
 * contradiction, and nothing is retried or repaired.
 */
import type { Criterion } from '../../shared/contracts/briefs.js';
import type { CheckInput, CheckOutput, CheckVerdict, ClaimKind } from '../ai/provider.js';
import type { ClaimMeta } from './render.js';
import { matchQuote } from './validate.js';

/** The codes a judged check can produce (content-free; `withheldCodes`, `meta.check`). */
export const CHECK_CODES = [
  'contradicted',
  'not_established',
  'chronology_missed',
  'check_missing_verdict',
  'check_duplicate_verdict',
  'check_unknown_claim',
  'check_invalid_evidence',
  'check_invalid_quote',
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

/** One content-free problem: the claim id (as issued, or as the model wrote it when unknown), its index (-1 for an unknown id), its kind and the code. */
export interface CheckProblem {
  claim: string;
  index: number;
  kind: ClaimKind | 'unknown';
  code: CheckCode;
}

export interface CheckJudgement {
  /** True only when every claim has exactly one valid `supported` verdict and every quote is valid. */
  ok: boolean;
  /** Every code found, in `CHECK_CODES` order. */
  codes: CheckCode[];
  /** Verdicts per value, counting each claim's first verdict. */
  counts: Record<CheckVerdict, number>;
  problems: CheckProblem[];
  /** Server "do not settle" criterion claims the checker contradicted (diagnostic). */
  chronologyMissed: { claim: string; index: number; ntsbNo: string | null; criterion: Criterion }[];
}

const ORDER = new Map(CHECK_CODES.map((c, i) => [c, i]));

/**
 * Judge a check output against the input it answered (both as the model saw them:
 * passage aliases, claim ids) and the server's claim metadata (`checkInput`, by index).
 */
export function judgeCheck(input: CheckInput, output: CheckOutput, meta: readonly Pick<ClaimMeta, 'criterion' | 'decision'>[]): CheckJudgement {
  const problems: CheckProblem[] = [];
  const counts: Record<CheckVerdict, number> = { supported: 0, contradicted: 0, not_established: 0 };
  const chronologyMissed: CheckJudgement['chronologyMissed'] = [];
  const passages = new Map(input.passages.map((p) => [p.passageId, p]));
  const index = new Map(input.claims.map((c, i) => [c.id, i]));
  const problem = (claim: string, i: number, code: CheckCode) =>
    problems.push({ claim, index: i, kind: i >= 0 ? input.claims[i]!.kind : 'unknown', code });

  /** Every supplied passage of the cases a claim is about. */
  const scopeOf = (c: CheckInput['claims'][number]): Set<string> => {
    const cases = c.ntsbNo ? new Set([c.ntsbNo]) : new Set(c.passageIds.map((id) => passages.get(id)?.ntsbNo).filter((n): n is string => n !== undefined));
    return new Set(input.passages.filter((p) => cases.has(p.ntsbNo)).map((p) => p.passageId));
  };

  const judged = new Map<string, CheckOutput['verdicts'][number]>();
  for (const v of output.verdicts) {
    const i = index.get(v.claim);
    if (i === undefined) {
      problem(v.claim, -1, 'check_unknown_claim');
      continue;
    }
    if (judged.has(v.claim)) {
      problem(v.claim, i, 'check_duplicate_verdict');
      continue;
    }
    judged.set(v.claim, v);
    counts[v.verdict] += 1;
    const claim = input.claims[i]!;
    const scope = scopeOf(claim);
    const cited = new Set(claim.passageIds);
    const named = [...new Set(v.passages)];
    let valid = named.every((id) => scope.has(id));
    if (v.verdict === 'supported' && !claim.absence) valid &&= named.length > 0 && named.every((id) => cited.has(id));
    if (v.verdict === 'contradicted') valid &&= named.length > 0;
    if (!valid) problem(v.claim, i, 'check_invalid_evidence');
    if (v.verdict === 'contradicted') {
      problem(v.claim, i, 'contradicted');
      const m = meta[i];
      if (claim.kind === 'criterion' && m?.criterion && m.decision === 'unknown') {
        problem(v.claim, i, 'chronology_missed');
        chronologyMissed.push({ claim: v.claim, index: i, ntsbNo: claim.ntsbNo ?? null, criterion: m.criterion });
      }
    } else if (v.verdict === 'not_established') {
      problem(v.claim, i, 'not_established');
    }
  }
  input.claims.forEach((c, i) => {
    if (!judged.has(c.id)) problem(c.id, i, 'check_missing_verdict');
  });

  const quoted = new Set<string>();
  for (const q of output.quotes) {
    const i = index.get(q.claim);
    const v = judged.get(q.claim);
    const p = passages.get(q.passage);
    const ok =
      i !== undefined &&
      v?.verdict === 'contradicted' &&
      v.passages.includes(q.passage) &&
      p !== undefined &&
      !quoted.has(q.claim) &&
      matchQuote(p.text, q.text).ok;
    quoted.add(q.claim);
    if (!ok) problem(q.claim, i ?? -1, 'check_invalid_quote');
  }

  const codes = [...new Set(problems.map((p) => p.code))].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
  return { ok: codes.length === 0, codes, counts, problems, chronologyMissed };
}
