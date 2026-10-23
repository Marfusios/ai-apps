/**
 * The evidence checker's verdicts, judged in code (check.v4 and later; gate G6 conditions 3 and 5).
 * The model's output is never trusted to be complete or consistent:
 *
 * **Completeness, deterministic.** Exactly one verdict for every claim id the server
 * issued (`C1`..): a missing id (`check_missing_verdict`), a repeated id
 * (`check_duplicate_verdict`) or an id the server never issued (`check_unknown_claim`)
 * makes the output unusable as a whole. A truncated, refused, unparseable or
 * schema-invalid response never reaches this module: the adapter fails the stage.
 *
 * **References.** Every passage a verdict names must be a supplied passage of a case the
 * claim is about (`check_invalid_evidence`). A `supported` verdict rests on passages the
 * claim cites (support found only elsewhere is not support for that citation); an absence
 * claim (it cites every supplied passage of its case) may name none, and any other
 * `supported` verdict must name at least one. A `contradicted` verdict names the passages
 * that conflict. A quote must belong to a `contradicted` verdict, come from one of its
 * passages and be found there word for word under the checker's quote rule
 * (`checker-quote-v1`), once per claim (`check_invalid_quote`). A verified quote shows the
 * words exist, not that they entail anything.
 *
 * **Support outside the citations** (`check-judgement-v2`, Task 16e; 16d concern 5). A
 * `supported` verdict that names, besides or instead of the claim's own citations, another
 * supplied passage of the claim's case says the claim's own citations did not establish it
 * all: that claim is not confirmed (`supported_outside_citations`, judged like
 * `not_established`), and the rest of the verdict set stays judged. Version 1 made it a
 * structural code that withheld the whole output. A verdict naming a passage outside the
 * claim's cases, or a `supported` verdict naming none, is still structural.
 *
 * **Structural codes** (`STRUCTURAL_CHECK_CODES`: incomplete, repeated or unknown verdict
 * ids, invalid references, invalid quotes) mean the output is not a usable verdict set:
 * the display projection withholds the whole output (server/briefs/display.ts), as it does
 * for a failed call.
 *
 * **Per claim.** A claim is *confirmed* only with exactly one valid `supported` verdict,
 * whatever its kind; `contradicted` and `not_established` are not. A displayed absence
 * claim needs `supported` too: `not_established` never authorizes "no maintenance was
 * mentioned". A `contradicted` verdict on a server claim that the supplied passages do not
 * settle a criterion is also recorded as `chronology_missed`: a likely extraction failure
 * (or a checker error), diagnostic only; the checker's reading never replaces the server
 * decision, and nothing is retried or repaired. What a rejected claim removes from the
 * display is the projection's business (`display-deps-v1`).
 *
 * **Checker quote rule `checker-quote-v1`** (Task 16d, versioned apart from the public
 * citation rule `quote-ws-v2`, which stays as it is): the same whitespace normalization
 * and exact matching, at least `QUOTE_MIN_WORDS` words, and a source span of at most
 * `CHECK_QUOTE_MAX_SOURCE` code units (the public rule allows 600). A checker quote is
 * diagnostic and never shown, so its bound follows the check output's
 * (`CHECK_QUOTE_MAX`, `check-output-v2`).
 */
import type { Criterion } from '../../shared/contracts/briefs.js';
import { CHECK_QUOTE_MAX, type CheckInput, type CheckOutput, type CheckVerdict, type ClaimKind } from '../ai/provider.js';
import type { ClaimMeta } from './render.js';
import { matchQuote, type QuoteMatch } from './validate.js';

export const CHECKER_QUOTE_RULE_VERSION = 'checker-quote-v1';
/** The judging rules (`judgeCheck`): v1 is Task 16d's, v2 adds `supported_outside_citations` (module comment). */
export const CHECK_JUDGEMENT_VERSION = 'check-judgement-v2';
/** The passage text a checker quote may resolve to, in UTF-16 code units. */
export const CHECK_QUOTE_MAX_SOURCE = CHECK_QUOTE_MAX;

/** Locate a checker quote in its passage under `checker-quote-v1`. */
export function matchCheckerQuote(passage: string, quote: string): QuoteMatch {
  return matchQuote(passage, quote, CHECK_QUOTE_MAX_SOURCE);
}

/** The codes a judged check can produce (content-free; `withheldCodes`, `meta.check`). */
export const CHECK_CODES = [
  'contradicted',
  'not_established',
  'supported_outside_citations',
  'chronology_missed',
  'check_missing_verdict',
  'check_duplicate_verdict',
  'check_unknown_claim',
  'check_invalid_evidence',
  'check_invalid_quote',
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

/** Codes that make the output unusable as a whole: the whole output is withheld. */
export const STRUCTURAL_CHECK_CODES = [
  'check_missing_verdict',
  'check_duplicate_verdict',
  'check_unknown_claim',
  'check_invalid_evidence',
  'check_invalid_quote',
] as const satisfies readonly CheckCode[];
export type StructuralCheckCode = (typeof STRUCTURAL_CHECK_CODES)[number];
const STRUCTURAL: ReadonlySet<CheckCode> = new Set(STRUCTURAL_CHECK_CODES);

/** One content-free problem: the claim id (as issued, or as the model wrote it when unknown), its index (-1 for an unknown id), its kind and the code. */
export interface CheckProblem {
  claim: string;
  index: number;
  kind: ClaimKind | 'unknown';
  code: CheckCode;
}

/** One claim as judged: its first verdict (null when it has none) and whether it is confirmed. */
export interface ClaimVerdict {
  verdict: CheckVerdict | null;
  /** Exactly one valid `supported` verdict (valid evidence; no structural problem with this claim). */
  confirmed: boolean;
}

export interface CheckJudgement {
  /** True only when every claim is confirmed and the output has no structural problem. */
  ok: boolean;
  /** Every code found, in `CHECK_CODES` order. */
  codes: CheckCode[];
  /** The structural codes among `codes`: when any is present, the output is unusable as a whole. */
  structural: StructuralCheckCode[];
  /** Verdicts per value, counting each claim's first verdict. */
  counts: Record<CheckVerdict, number>;
  problems: CheckProblem[];
  /** Per claim, by index (claim `C<i+1>`). */
  claims: ClaimVerdict[];
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
  const claims: ClaimVerdict[] = input.claims.map(() => ({ verdict: null, confirmed: false }));
  const invalid = new Set<number>();
  const outside = new Set<number>();
  const problem = (claim: string, i: number, code: CheckCode) => {
    problems.push({ claim, index: i, kind: i >= 0 ? input.claims[i]!.kind : 'unknown', code });
    if (i >= 0 && code !== 'contradicted' && code !== 'not_established' && code !== 'chronology_missed' && code !== 'supported_outside_citations') invalid.add(i);
    // Not confirmed, but not structural: the rest of the verdict set stays judged.
    if (i >= 0 && code === 'supported_outside_citations') outside.add(i);
  };

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
    claims[i]!.verdict = v.verdict;
    const claim = input.claims[i]!;
    const scope = scopeOf(claim);
    const cited = new Set(claim.passageIds);
    const named = [...new Set(v.passages)];
    let valid = named.every((id) => scope.has(id));
    if (v.verdict === 'supported' && !claim.absence) valid &&= named.length > 0;
    if (v.verdict === 'contradicted') valid &&= named.length > 0;
    if (!valid) problem(v.claim, i, 'check_invalid_evidence');
    // A supported verdict resting on a passage the claim does not cite (v2: that claim only).
    else if (v.verdict === 'supported' && !claim.absence && named.some((id) => !cited.has(id))) problem(v.claim, i, 'supported_outside_citations');
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
      matchCheckerQuote(p.text, q.text).ok;
    quoted.add(q.claim);
    if (!ok) problem(q.claim, i ?? -1, 'check_invalid_quote');
  }

  claims.forEach((c, i) => {
    c.confirmed = c.verdict === 'supported' && !invalid.has(i) && !outside.has(i);
  });
  const codes = [...new Set(problems.map((p) => p.code))].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
  const structural = codes.filter((c): c is StructuralCheckCode => STRUCTURAL.has(c));
  return { ok: codes.length === 0, codes, structural, counts, problems, claims, chronologyMissed };
}
