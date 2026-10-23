/**
 * The display projection (Tasks 16d and 16e, gate G6; rules `display-deps-v2`): one pure
 * function that turns a judged check into what may be shown. The brief pipeline renders
 * every response surface from its outcome (server/briefs/render.ts `answerResult`,
 * `storedDimensions`; the case context reads only what the step stored), and the checker
 * calibration computes its display metrics through it (evals/checker/metrics.ts), so the
 * metrics measure what the server projects. (What the browser renders from it is the web
 * client's job: tests/web cover every state the projection can produce.)
 *
 * **Whole-output failures.** A failed check call (timeout, refusal, truncation, invalid
 * output), a check input that could not hold every claim, and a structurally unusable
 * verdict set (`STRUCTURAL_CHECK_CODES`: a missing, repeated or unknown verdict id,
 * evidence outside a claim's cases, an invalid quote) withhold everything generated.
 *
 * **Claims.** A claim is shown only with exactly one valid `supported` verdict
 * (`confirmed`), only when no deterministic rule abstains from it, and only while
 * everything it depends on is shown. Dependencies are explicit and derived by the server
 * from the composition's structure (`displayPlan`), never from the model. Whole sentences
 * only: nothing is spliced, reworded or replaced.
 *
 * **Static abstentions** (Task 16e; `abstain` in the plan): claims the deterministic rules
 * never show, whatever the checker says: an excerpt that needs its context
 * (`excerpt_context`, `excerpt-context-v1`, server/briefs/excerpts.ts) and a flight ordinal
 * without explicit evidence in its cited passages (`ordinal_evidence`,
 * `ordinal-evidence-v1`, server/briefs/ordinals.ts). They are checked like every claim (a
 * contradiction still counts), removed with cause `static`, and cascade like any removal.
 *
 * **Dependency rules (`display-deps-v2`).** For each presented case X:
 * - *reading*: X's AI reading is shown only with its minimum content, a confirmed `why`
 *   line and at least one confirmed quote that no rule abstains from, and never after a
 *   contradicted criterion claim of X (a contradicted decision has no direction: the case
 *   may be outside the reader's criteria, so it is not presented as a match). Every other
 *   statement of X depends on the reading.
 * - *basis*: X's summary sentences, classification and group placement depend on X having
 *   no contradicted essential claim (`ESSENTIAL_KINDS`: its why line, classification,
 *   maintenance, timing facts, criterion decisions and quote attributions, and any summary
 *   sentence that cites it). One contradiction there suppresses X's summary sentences,
 *   its classification and every comparison citing X, whatever the thresholds (the gate's
 *   override for an essential attribution, maintenance anchor or causal premise). The
 *   symptom and gap notes are not essential. (v2: the classification is removed with the
 *   group placement it carries, so a suppressed case's classification is counted as
 *   removed, 16d review m4.)
 * - *group*: X keeps its group (glyph and group membership) only with its reading, its
 *   basis and, for mechanical grouping, its confirmed classification; otherwise it is shown
 *   unclassified, never in another group.
 * - *criteria*: each decision is shown as decided only when its own claim is confirmed and
 *   every timing fact of X (for the timing window and first flight) or X's symptom (for a
 *   failure type decided from it) is shown. Otherwise it is shown `unconfirmed` with
 *   `notVerified`. Decisions are never recomputed, so a removal can only downgrade one
 *   (the gate's probe: 2 days and 40 days against 30 days stays unconfirmed when the 40-day
 *   fact is removed).
 * - *conflicts* (v2, 16d review m3): timing facts whose values cannot all hold
 *   (`together`, `conflictingFacts` in server/briefs/criteria.ts) are shown together or not
 *   at all, so a lone survivor never reads as settled.
 * - *summary sentences*: a sentence depends on the reading and basis of every presented
 *   case it cites. A case's own sentences (citing only that case) stand or fall together,
 *   whichever comes first. A sentence citing two or more cases (a comparison or a count)
 *   also depends on every statement and the group placement of each case it cites, on
 *   each of their own sentences and on every other comparison sharing a case with it; a
 *   comparison's removal never takes a case's own sentences with it. v2 (16d review I1):
 *   a sentence that refers outside itself anywhere (`refersOutside`: pointers, pronouns
 *   and connectives as in v1, plus comparisons and repetitions such as "similar",
 *   "comparable", "again", "too", "also", "another", "earlier", "previous", "remaining",
 *   "both", "the second case") depends on every other summary sentence, and one that
 *   counts or ranges over cases (`countsCases`: "three of the four cases", "in all
 *   cases", "the other cases") also depends on the reading, basis and group placement of
 *   every presented case: when in doubt, the sentence goes with its antecedent.
 * - Gap notes depend on nothing else.
 *
 * **Whole-summary rules** (pre-registered experimental usability defaults, not safety
 * guarantees): after the cascade, more than a third of the original summary sentences
 * removed (`display_removed_share`), or two or more contradicted claims of any kind
 * (`display_contradictions`), withhold the whole output. **Minimum useful content**: an
 * answer needs at least one shown summary sentence and one presented case with its
 * reading (`display_minimum_content`); a marker-only summary is never shown.
 *
 * **Modes.** `claims` is claim-level display. `whole` (the production default until gate
 * G6 clears partial display, `AI_PARTIAL_DISPLAY`) shows the output only when nothing at
 * all was removed, statically or otherwise: 16c's rule, computed by the same projection.
 */
import type { CardStatementKind, Criterion } from '../../shared/contracts/briefs.js';
import type { ClaimKind } from '../ai/provider.js';
import type { Decision } from './criteria.js';
import type { CheckJudgement, StructuralCheckCode } from './verdicts.js';

export const DISPLAY_RULES_VERSION = 'display-deps-v2';

/** Claim kinds whose contradiction suppresses their case's summary sentences and group placement. */
export const ESSENTIAL_KINDS: ReadonlySet<ClaimKind> = new Set(['summary', 'why', 'classification', 'maintenance', 'timing', 'criterion', 'attribution']);

/** The deterministic rules that abstain from a claim whatever its verdict (Task 16e). */
export const STATIC_RULES = ['excerpt_context', 'ordinal_evidence'] as const;
export type StaticAbstention = (typeof STATIC_RULES)[number];

/**
 * Words anywhere in a summary sentence that refer outside it (`display-deps-v2`; v1's
 * lexicon and the 16d review's misses), matched as whole words after the case markers are
 * removed. Conservative by design: a false match only makes the sentence depend on the
 * others, which can remove it, never show anything.
 */
export const SENTENCE_REFERENCE = new RegExp(
  [
    String.raw`\b(?:this|these|those|such|both|either|neither|other|others|another|also|too|again|similar|similarly|comparable|compared|comparison|likewise|same|different|differently|unlike|whereas|however|respectively|aforementioned|former|latter|remaining|rest|earlier|later|previous|previously|prior|preceding|next|following|additional|additionally|further|furthermore|moreover|instead|otherwise|alike)\b`,
    String.raw`\b(?:in\s+contrast|as\s+in|like\s+the|as\s+well|the\s+(?:first|second|third|fourth|fifth|sixth|last|final)\s+(?:case|one|investigation|accident|event|airplane|aircraft))\b`,
  ].join('|'),
  'i',
);
/** …and words that refer back when they open the sentence. */
export const REFERENCE_START = /^\s*(?:it|its|they|their|them|he|his|she|her|that|then|thus|therefore|hence|consequently|meanwhile|instead|still|yet|but|and|or|so|here|there|ultimately|eventually|finally)\b/i;
/** Counts and ranges over cases: "three of the four cases", "in all cases", "the other cases", "each case". */
export const CASE_SET = new RegExp(
  [
    String.raw`(?<![\w-])(?:all|both|each|every|none|neither|either|most|many|several|some|few|two|three|four|five|six|\d+)\s+(?:of\s+)?(?:the\s+|these\s+|those\s+)?(?:other\s+|remaining\s+)?(?:cases?|investigations?|accidents?|events?|incidents?|airplanes?|aircraft|helicopters?|examples?|records?)\b`,
    String.raw`\bof\s+the\s+(?:two|three|four|five|six|\d+)(?![\w-])`,
    String.raw`\b(?:the|these|those|other|remaining)\s+(?:cases|investigations|accidents|events|incidents|examples)\b`,
    String.raw`\banother\s+(?:case|investigation|accident|event|incident|example)\b`,
  ].join('|'),
  'i',
);

const MARKERS = /\[\[case:[A-Za-z0-9]+\]\]/g;

/** True when a summary sentence refers outside itself under `display-deps-v2`. */
export function refersOutside(sentence: string): boolean {
  const text = sentence.replace(MARKERS, ' ');
  return SENTENCE_REFERENCE.test(text) || REFERENCE_START.test(text) || CASE_SET.test(text);
}

/** True when a summary sentence counts or ranges over cases (it may cover cases it does not cite). */
export function countsCases(sentence: string): boolean {
  return CASE_SET.test(sentence.replace(MARKERS, ' '));
}

// ---------------------------------------------------------------------------
// The plan: what the server knows about each claim's place in the composition

export interface PlanClaim {
  /** Stable key (`ClaimMeta.key`): `summary.<i>`, `case.<ntsbNo>.<field>`, `gap.<g>`. */
  key: string;
  kind: ClaimKind;
  /** The cases it is about (a summary sentence: its markers). */
  cases: string[];
  /** A criterion claim's criterion and server decision. */
  criterion?: Criterion;
  decision?: Decision;
  /** A deterministic rule never shows it, whatever its verdict (Task 16e). */
  abstain?: StaticAbstention;
}

export interface PlanCase {
  ntsbNo: string;
  /** Its group placement rests on a classification claim (mechanical grouping). */
  classified: boolean;
}

export interface PlanSentence {
  cases: string[];
  /** Refers outside itself (`refersOutside`): depends on every other summary sentence. */
  reference: boolean;
  /** Counts or ranges over cases (`countsCases`): depends on every presented case too. */
  set: boolean;
}

/**
 * Everything the projection reads, as data: built by the server from the composition and
 * the claims it rendered (`displayPlan`, server/briefs/render.ts); stored with each
 * calibration brief so the metrics run the same projection.
 */
export interface DisplayPlan {
  rules: typeof DISPLAY_RULES_VERSION;
  /**
   * `answer`: a summary and presented cases; `abstention`: gap notes only (an explicit
   * `no_supported_match`); `claims`: a calibration claim batch (independent claims).
   */
  shape: 'answer' | 'abstention' | 'claims';
  grouping: 'mechanical' | 'examples' | null;
  cases: PlanCase[];
  sentences: PlanSentence[];
  /** In check order: claim `C<i+1>` is `claims[i]`. */
  claims: PlanClaim[];
  /** Claim keys shown together or not at all (conflicting timing facts of a case). */
  together: string[][];
}

export type DisplayMode = 'claims' | 'whole';

/** What the check produced: nothing usable (a failed call or an overflowing input), or a judged verdict set. */
export type DisplayInput = { kind: 'failed' } | { kind: 'judged'; judgement: Pick<CheckJudgement, 'structural' | 'claims'> };

export const DISPLAY_WITHHELD_CODES = [
  'check_failed',
  'check_structural',
  'display_removed_share',
  'display_contradictions',
  'display_minimum_content',
  'display_whole_brief',
] as const;
export type DisplayWithheldCode = (typeof DISPLAY_WITHHELD_CODES)[number];

/** Why a claim is not shown: its own verdict, a deterministic rule, a dependency, or the whole output withheld. */
export type RemovalCause = 'contradicted' | 'not_established' | 'static' | 'dependency' | 'withheld';

export interface CaseDisplay {
  ntsbNo: string;
  /** Its AI reading is shown (minimum content). */
  reading: boolean;
  /** It keeps its group placement. */
  grouped: boolean;
  /** An essential contradiction removed its summary sentences and group placement. */
  suppressed: boolean;
  /** Each criterion decision as shown (none without a reading). */
  decisions: { criterion: Criterion; decision: 'matches' | 'unconfirmed'; notVerified: boolean }[];
  /** Kinds of its statements not shown (an excerpt omitted by the excerpt rule is counted apart). */
  removed: CardStatementKind[];
  /** Its quotes omitted because they need their surrounding text (`excerpt_context`). */
  excerptsOmitted: number;
}

export interface DisplayOutcome {
  rules: typeof DISPLAY_RULES_VERSION;
  mode: DisplayMode;
  /** False: the whole output is withheld (`withheld` says why). */
  shown: boolean;
  withheld: DisplayWithheldCode[];
  /** Per claim (check index): shown. All false when withheld. */
  displayed: boolean[];
  /** Per claim: why it is not shown (null when shown). */
  removal: (RemovalCause | null)[];
  /** Per summary sentence: shown. */
  sentences: boolean[];
  cases: CaseDisplay[];
  /** Claims judged `contradicted`. */
  contradictions: number;
  /** Summary sentences removed after the cascade (before any whole-output rule). */
  removedSentences: number;
  /** Shown claims, removed ones by kind (every cause), and the claims each deterministic rule abstained from. */
  counts: { shown: number; removed: Record<ClaimKind, number>; abstained: Record<StaticAbstention, number> };
}

const KINDS: readonly ClaimKind[] = ['summary', 'why', 'classification', 'maintenance', 'symptom', 'timing', 'attribution', 'criterion', 'gap'];
const CARD_KINDS: ReadonlySet<string> = new Set<CardStatementKind>(['why', 'classification', 'maintenance', 'symptom', 'timing', 'attribution', 'criterion']);

/** A node of the dependency graph: a claim (by its key) or a virtual node of a case. */
interface Node {
  base: boolean;
  deps: string[];
}

const readingKey = (n: string) => `case.${n}#reading`;
const basisKey = (n: string) => `case.${n}#basis`;
const groupKey = (n: string) => `case.${n}#group`;

/**
 * The dependency graph of a plan: every claim (by key) and the virtual nodes of each
 * presented case, with each node's explicit dependencies. `confirmed` and `contradicted`
 * are per claim index; a claim a rule abstains from has a false base. Exported for the M5
 * dependency test.
 */
export function dependencyGraph(plan: DisplayPlan, confirmed: readonly boolean[], contradicted: readonly boolean[]): Map<string, Node> {
  const nodes = new Map<string, Node>();
  const shownable = plan.claims.map((c, i) => confirmed[i] === true && c.abstain === undefined);
  const claimsOf = (n: string) => plan.claims.map((c, i) => ({ c, i })).filter(({ c }) => c.kind !== 'summary' && c.kind !== 'gap' && c.cases.length === 1 && c.cases[0] === n);
  const presented = plan.cases.map((c) => c.ntsbNo);
  const presentedSet = new Set(presented);
  const standalone = plan.shape === 'claims';

  for (const pc of standalone ? [] : plan.cases) {
    const n = pc.ntsbNo;
    const own = claimsOf(n);
    const why = own.filter(({ c }) => c.kind === 'why');
    const quotes = own.filter(({ c }) => c.kind === 'attribution');
    const criterionContradicted = own.some(({ c, i }) => c.kind === 'criterion' && contradicted[i]);
    nodes.set(readingKey(n), {
      base: why.length > 0 && why.every(({ i }) => shownable[i]) && quotes.some(({ i }) => shownable[i]) && !criterionContradicted,
      deps: [],
    });
    const essential =
      own.some(({ c, i }) => ESSENTIAL_KINDS.has(c.kind) && contradicted[i]) ||
      plan.claims.some((c, i) => c.kind === 'summary' && c.cases.includes(n) && contradicted[i]);
    nodes.set(basisKey(n), { base: !essential, deps: [readingKey(n)] });
    const classification = own.filter(({ c }) => c.kind === 'classification').map(({ c }) => c.key);
    nodes.set(groupKey(n), { base: !(pc.classified && classification.length === 0), deps: [readingKey(n), basisKey(n), ...(pc.classified ? classification : [])] });
  }

  const sentenceKeys = plan.claims.filter((c) => c.kind === 'summary').map((c) => c.key);
  const together = new Map<string, string[]>();
  for (const group of plan.together) for (const key of group) together.set(key, [...(together.get(key) ?? []), ...group.filter((k) => k !== key)]);

  plan.claims.forEach((c, i) => {
    const deps: string[] = [];
    if (!standalone) {
      if (c.kind === 'summary') {
        const s = Number(c.key.slice('summary.'.length));
        const sentence = plan.sentences[s];
        const cited = c.cases.filter((n) => presentedSet.has(n));
        const comparison = c.cases.length >= 2;
        for (const n of cited) deps.push(readingKey(n), basisKey(n));
        plan.claims.forEach((o, j) => {
          if (j === i || o.kind !== 'summary') return;
          const shares = o.cases.some((n) => c.cases.includes(n));
          const other = o.cases.length >= 2;
          // A case's own sentences stand together; a comparison also rests on its cases' own sentences and on comparisons sharing a case.
          if (shares && (comparison || !other)) deps.push(o.key);
        });
        // v2: a sentence that refers outside itself goes with every other sentence; one that counts cases, with every case too.
        if (sentence?.reference || sentence?.set) deps.push(...sentenceKeys.filter((k) => k !== c.key));
        if (sentence?.set) for (const n of presented) deps.push(readingKey(n), basisKey(n), groupKey(n));
        if (comparison) {
          for (const n of cited) {
            for (const { c: o } of claimsOf(n)) deps.push(o.key);
            deps.push(groupKey(n));
          }
        }
      } else if (c.kind !== 'gap' && c.cases.length === 1 && presentedSet.has(c.cases[0]!)) {
        const n = c.cases[0]!;
        deps.push(readingKey(n));
        // v2 (16d review m4): the classification goes with the group placement it carries.
        if (c.kind === 'classification') deps.push(basisKey(n));
        if (c.kind === 'criterion') {
          const own = claimsOf(n).map(({ c: o }) => o);
          if (c.criterion === 'failure_type') deps.push(...own.filter((o) => o.kind === 'symptom').map((o) => o.key));
          else deps.push(...own.filter((o) => o.kind === 'timing').map((o) => o.key));
        }
        deps.push(...(together.get(c.key) ?? []));
      }
    }
    nodes.set(c.key, { base: shownable[i]!, deps: [...new Set(deps)] });
  });
  return nodes;
}

/** Shown nodes: each node's base, while every dependency is shown (a fixpoint; removals only). */
export function resolveGraph(nodes: ReadonlyMap<string, Node>): Map<string, boolean> {
  const shown = new Map([...nodes].map(([k, n]) => [k, n.base]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [k, n] of nodes) {
      if (!shown.get(k)) continue;
      if (n.deps.some((d) => shown.get(d) === false)) {
        shown.set(k, false);
        changed = true;
      }
    }
  }
  return shown;
}

/**
 * Shown nodes that depend on a node not shown (M5: always empty). It proves the projection
 * consistent with the dependencies the plan encodes, not that those dependencies are
 * complete (the gate's 16d finding 3).
 */
export function dependencyViolations(nodes: ReadonlyMap<string, Node>, shown: ReadonlyMap<string, boolean>): string[] {
  return [...nodes].filter(([k, n]) => shown.get(k) && n.deps.some((d) => shown.get(d) === false)).map(([k]) => k);
}

const emptyCounts = (): Record<ClaimKind, number> => Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<ClaimKind, number>;
const emptyAbstained = (): Record<StaticAbstention, number> => Object.fromEntries(STATIC_RULES.map((r) => [r, 0])) as Record<StaticAbstention, number>;

/** Project a judged check onto what may be shown (see the module comment). */
export function projectDisplay(plan: DisplayPlan, input: DisplayInput, mode: DisplayMode): DisplayOutcome {
  const n = plan.claims.length;
  const abstained = emptyAbstained();
  for (const c of plan.claims) if (c.abstain) abstained[c.abstain] += 1;
  const withheldAll = (codes: DisplayWithheldCode[], contradictions = 0, removedSentences = 0, removal?: (RemovalCause | null)[]): DisplayOutcome => {
    const counts = emptyCounts();
    for (const c of plan.claims) counts[c.kind] += 1;
    return {
      rules: DISPLAY_RULES_VERSION,
      mode,
      shown: false,
      withheld: codes,
      displayed: plan.claims.map(() => false),
      removal: removal ?? plan.claims.map(() => 'withheld'),
      sentences: plan.sentences.map(() => false),
      cases: plan.cases.map((c) => ({ ntsbNo: c.ntsbNo, reading: false, grouped: false, suppressed: false, decisions: [], removed: [], excerptsOmitted: 0 })),
      contradictions,
      removedSentences,
      counts: { shown: 0, removed: counts, abstained },
    };
  };
  if (input.kind === 'failed') return withheldAll(['check_failed']);
  const j = input.judgement;
  if (j.structural.length > 0 || j.claims.length !== n) return withheldAll(['check_structural']);

  const confirmed = j.claims.map((c) => c.confirmed);
  const contradicted = j.claims.map((c) => c.verdict === 'contradicted');
  const nodes = dependencyGraph(plan, confirmed, contradicted);
  const shown = resolveGraph(nodes);
  const displayed = plan.claims.map((c) => shown.get(c.key) === true);
  const removal: (RemovalCause | null)[] = plan.claims.map((c, i) =>
    displayed[i] ? null : c.abstain ? 'static' : !confirmed[i] ? (j.claims[i]!.verdict === 'contradicted' ? 'contradicted' : 'not_established') : 'dependency',
  );
  const sentenceShown = plan.sentences.map((_, s) => plan.claims.some((c, i) => c.key === `summary.${s}` && displayed[i]));
  const contradictions = contradicted.filter(Boolean).length;
  const removedSentences = sentenceShown.filter((x) => !x).length;

  const cases: CaseDisplay[] = plan.cases.map((pc) => {
    const reading = plan.shape !== 'claims' && shown.get(readingKey(pc.ntsbNo)) === true;
    const own = plan.claims.map((c, i) => ({ c, i })).filter(({ c }) => c.kind !== 'summary' && c.kind !== 'gap' && c.cases.length === 1 && c.cases[0] === pc.ntsbNo);
    const decisions = reading
      ? own
          .filter(({ c }) => c.kind === 'criterion' && c.criterion)
          .map(({ c, i }) => ({
            criterion: c.criterion!,
            decision: displayed[i] && c.decision === 'matches' ? ('matches' as const) : ('unconfirmed' as const),
            notVerified: !displayed[i],
          }))
      : [];
    const excerpt = ({ c }: { c: PlanClaim }) => c.kind === 'attribution' && c.abstain === 'excerpt_context';
    const removed = [
      ...new Set(
        own
          .filter((x) => !displayed[x.i] && !excerpt(x))
          .map(({ c }) => c.kind)
          .filter((k): k is CardStatementKind => CARD_KINDS.has(k)),
      ),
    ];
    return {
      ntsbNo: pc.ntsbNo,
      reading,
      grouped: reading && shown.get(groupKey(pc.ntsbNo)) === true,
      suppressed: shown.get(basisKey(pc.ntsbNo)) === false && shown.get(readingKey(pc.ntsbNo)) === true,
      decisions,
      removed,
      excerptsOmitted: own.filter(excerpt).length,
    };
  });

  const codes: DisplayWithheldCode[] = [];
  if (plan.shape !== 'claims') {
    if (contradictions >= 2) codes.push('display_contradictions');
    if (plan.shape === 'answer') {
      if (removedSentences * 3 > plan.sentences.length) codes.push('display_removed_share');
      if (!sentenceShown.some(Boolean) || !cases.some((c) => c.reading)) codes.push('display_minimum_content');
    }
  }
  if (mode === 'whole' && displayed.some((d) => !d)) codes.push('display_whole_brief');
  if (codes.length > 0) {
    return withheldAll(
      codes,
      contradictions,
      removedSentences,
      removal.map((r) => r ?? 'withheld'),
    );
  }
  const removedCounts = emptyCounts();
  plan.claims.forEach((c, i) => {
    if (!displayed[i]) removedCounts[c.kind] += 1;
  });
  return {
    rules: DISPLAY_RULES_VERSION,
    mode,
    shown: true,
    withheld: [],
    displayed,
    removal,
    sentences: sentenceShown,
    cases,
    contradictions,
    removedSentences,
    counts: { shown: displayed.filter(Boolean).length, removed: removedCounts, abstained },
  };
}

/**
 * The projection of a plan under a checker that confirms every claim (an oracle): what the
 * deterministic rules and their cascade leave, whatever the checker says. Answer retention
 * (M1, M2) is measured against it, apart from the static abstentions (evals/checker/metrics.ts).
 */
export function oracleDisplay(plan: DisplayPlan, mode: DisplayMode): DisplayOutcome {
  return projectDisplay(plan, { kind: 'judged', judgement: { structural: [], claims: plan.claims.map(() => ({ verdict: 'supported', confirmed: true })) } }, mode);
}

/** The structural codes of a judgement (for the step's meta when `check_structural` withholds). */
export function structuralCodes(j: Pick<CheckJudgement, 'structural'>): StructuralCheckCode[] {
  return [...j.structural];
}
