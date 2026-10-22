/**
 * Code checks on a composition before anything reaches the reader (DESIGN §5 step 5,
 * amendment A4, gate G6). They run before the model checker and are not fallible the
 * way it is: every passage is canonical, every quote is located in its passage, every
 * claim cites passages of its own case, every case number is allowlisted, and the
 * structure is consistent. Any failure withholds the whole summary; there is no repair
 * loop.
 *
 * **Quote rule `quote-ws-v2`** (versioned: stored citations depend on it). Both the
 * passage and the quote are normalized the same way, and only this way: every maximal
 * run of whitespace (ECMAScript `\s`: space, tab, CR, LF, VT, FF, NBSP U+00A0, U+1680,
 * U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) becomes one space,
 * and the quote is trimmed. The quote must then have at least `QUOTE_MIN_WORDS` words
 * and be a substring of the passage's normalized text, compared code unit by code unit:
 * no case folding, no Unicode normalization, no folding of quotation marks, dashes or
 * ellipses. When it occurs more than once, the first occurrence in the cited passage is
 * used and the number of occurrences is recorded. The match is mapped back through the
 * normalization's offset map to a span of the original passage text (UTF-16 code
 * units), which may be at most `QUOTE_MAX_SOURCE` code units long, and to the section
 * text by the passage's offset in its section. An accepted quote is shown whole: its
 * text is never cut afterwards. (v1, the phase-1 rule, had no length bounds.)
 *
 * Quotes are compared with the stored citation text (`case_sections.text` sliced by the
 * canonical passage offsets), never with the copy rendered into the prompt, where
 * untrusted text had tag-like `<` replaced (server/ai/prompts/untrusted.ts).
 *
 * **Provenance chain** (A4; G6 #2, #4): case → aircraft/scope → section id + revision
 * hash → passage → quote. `resolvePassage` checks a retrieved passage against its
 * canonical `passages` row (identity, derivation, section kind, scope, aircraft,
 * offsets) and its section revision (hash, text) before the passage enters the
 * allowlist; the caller fails the whole bundle on any problem. `validateComposition`
 * then requires every quote and every cited passage to belong to the case that cites it.
 *
 * **Case numbers.** Every token shaped like an NTSB number in the summary, the groups,
 * the case entries, the `why` lines and the gap notes must be in the allowlist (case
 * insensitive); `DCA25MA108A/B` names both aircraft numbers. Quotes are exempt: they
 * are verified passage text.
 *
 * **Summary sentences** (server/briefs/sentences.ts, fail closed: when in doubt, split or
 * withhold). The summary must be plain one-line text (`summary_format`). Each sentence
 * must end with the `[[case:…]]` markers of the cases it is about, immediately before or
 * after its final punctuation: a sentence without one fails `uncited_summary`, one with a
 * marker anywhere else `misplaced_citation`, and one with a `.`, `!` or `?` inside it
 * that is neither a declared abbreviation context nor a decimal point
 * `ambiguous_boundary`.
 *
 * **Passage aliases in prose** (`alias_in_text`): the summary, `why` lines and gap notes
 * may not name a passage alias the model was shown (an allowlist key such as `P3`)
 * unless the reader's question or a passage of the bundle uses the same token, so an
 * aircraft model ("P210"), a station pressure ("P3", "P2.5"), a connector ("J1/P1") or a
 * taxiway named by the reader or the record stays. Quotes are exempt.
 */
import { createHash } from 'node:crypto';
import { ComposeOutputSchema, type ComposeOutput, type GlyphKind } from '../../shared/contracts/briefs.js';
import { ambiguousBoundary, citationPlacement, splitSentences, summaryFormatProblem } from './sentences.js';

export const QUOTE_MATCH_RULE_VERSION = 'quote-ws-v2';
/** A quote has at least this many whitespace-separated words after normalization. */
export const QUOTE_MIN_WORDS = 3;
/** The passage text a quote resolves to is at most this many UTF-16 code units. */
export const QUOTE_MAX_SOURCE = 600;

export type SectionKind = 'factual' | 'analysis' | 'probable_cause';

/** A passage the composition may cite, with its verified provenance. */
export interface AllowedPassage {
  ntsbNo: string;
  /** The passage's citation text exactly as stored. */
  text: string;
  /** sha256 of the section revision's citation text (`case_sections.sha256`). */
  sha: string;
  sectionId: string;
  revisionId: string;
  /** From the canonical `passages` row, never from retrieval. */
  sectionKind: SectionKind;
  /** UTF-16 offset of the passage in its section text. */
  sectionStart: number;
  scope: 'aircraft' | 'event';
  aircraftKey: number | null;
}

export interface Allowlist {
  passages: ReadonlyMap<string, AllowedPassage>;
  /**
   * Case numbers the text may mention: the bundle's event numbers and the suffixed
   * numbers of their aircraft (resolved through the event, never by stripping a letter).
   */
  cases: ReadonlySet<string>;
}

export interface ValidateOptions {
  /** From the scope stage: evidence groups (true) or one `examples` group (false). */
  mechanicalCause: boolean;
  /**
   * The reader's text the answer model read (the question and any text refinement): an
   * alias-shaped token in it is the reader's word, not a leaked passage alias.
   */
  readerText?: string;
}

export interface Span {
  start: number;
  end: number;
}

export interface ResolvedCitation {
  ntsbNo: string;
  /** Index of the case in `composition.cases` and of the quote in its `quotes`. */
  caseIndex: number;
  quoteIndex: number;
  passageId: string;
  sectionId: string;
  revisionId: string;
  sectionSha: string;
  /** The passage text at `passageSpan`: what the reader sees as the quote, whole. */
  text: string;
  passageSpan: Span;
  sectionSpan: Span;
  /** Occurrences of the normalized quote in the normalized passage; the first is used. */
  matches: number;
  occurrence: 'first';
}

/** Why a composition fails validation (content-free codes; also a span attribute and log field). */
export const VALIDATION_CODES = [
  'schema',
  'outcome_mismatch',
  'unknown_case',
  'duplicate_case',
  'duplicate_group',
  'group_kind_mismatch',
  'group_unknown_case',
  'case_not_grouped',
  'case_in_two_groups',
  'unknown_passage',
  'foreign_passage',
  'missing_support',
  'provenance',
  'empty_quote',
  'quote_too_short',
  'quote_too_long',
  'malformed_quote',
  'quote_not_found',
  'timing_precision',
  'bad_marker',
  'marker_unknown_case',
  'uncited_summary',
  'misplaced_citation',
  'ambiguous_boundary',
  'summary_format',
  'unallowlisted_case_number',
  'markup_or_link',
  'alias_in_text',
  'gap_unknown_case',
  'gap_foreign_passage',
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

/** A content-free reason: a code and where (a JSON path), never model or passage text. */
export interface ValidationReason {
  code: ValidationCode;
  path: string;
}

/**
 * `summarySentences`: the summary as the validator split it (server/briefs/sentences.ts;
 * empty when the composition failed its schema), so a `summary.<i>` reason names entry
 * `i`. Model text: kept server-side only (the step's `meta` records just the count).
 */
export type ValidationResult =
  | { ok: true; ruleVersion: typeof QUOTE_MATCH_RULE_VERSION; citations: ResolvedCitation[]; summarySentences: string[] }
  | { ok: false; ruleVersion: typeof QUOTE_MATCH_RULE_VERSION; reasons: ValidationReason[]; summarySentences: string[] };

// ---------------------------------------------------------------------------
// Whitespace normalization with an offset map

/** ECMAScript `\s`; every member is a single UTF-16 code unit. */
const WHITESPACE = /\s/;

export interface Normalized {
  text: string;
  /** `map[i]`: offset in the original text of normalized code unit `i` (a run's first code unit for its space). */
  map: number[];
}

/** Collapse every whitespace run to one space, keeping where each code unit came from. */
export function collapseWhitespace(text: string): Normalized {
  const out: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (WHITESPACE.test(text[i]!)) {
      map.push(i);
      out.push(' ');
      while (i < text.length && WHITESPACE.test(text[i]!)) i += 1;
    } else {
      map.push(i);
      out.push(text[i]!);
      i += 1;
    }
  }
  return { text: out.join(''), map };
}

/** A lone surrogate: JSON can carry one, and it could match half of a character. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export type QuoteMatch =
  | { ok: true; span: Span; matches: number }
  | { ok: false; code: 'empty_quote' | 'quote_too_short' | 'quote_too_long' | 'malformed_quote' | 'quote_not_found' };

/** Locate `quote` in `passage` under `quote-ws-v2`; the span is in the original passage text. */
export function matchQuote(passage: string, quote: string): QuoteMatch {
  if (LONE_SURROGATE.test(quote)) return { ok: false, code: 'malformed_quote' };
  const q = collapseWhitespace(quote).text.trim();
  if (q === '') return { ok: false, code: 'empty_quote' };
  if (q.split(' ').length < QUOTE_MIN_WORDS) return { ok: false, code: 'quote_too_short' };
  const p = collapseWhitespace(passage);
  const at = p.text.indexOf(q);
  if (at < 0) return { ok: false, code: 'quote_not_found' };
  let matches = 0;
  for (let i = at; i >= 0; i = p.text.indexOf(q, i + 1)) matches += 1;
  // The trimmed quote starts and ends on non-whitespace, which maps to exactly one code unit.
  const start = p.map[at]!;
  const end = p.map[at + q.length - 1]! + 1;
  if (end - start > QUOTE_MAX_SOURCE) return { ok: false, code: 'quote_too_long' };
  return { ok: true, span: { start, end }, matches };
}

// ---------------------------------------------------------------------------
// Provenance of one retrieved passage

/** A retrieved passage as the retriever reports it. */
export interface RetrievedPassageRef {
  passageId: string;
  ntsbNo: string;
  sectionId: string;
  revisionId: string;
  sectionKind: SectionKind;
  scope: 'aircraft' | 'event';
  aircraftKey: number | null;
  start: number;
  end: number;
  text: string;
}

/** The canonical `passages` row of a passage, with its section revision's text and hash. */
export interface CanonicalPassage {
  passageId: string;
  chunkerVersion: string;
  ntsbNo: string;
  sectionId: string;
  revisionId: string;
  sectionKind: SectionKind;
  scope: 'aircraft' | 'event';
  aircraftKey: number | null;
  start: number;
  end: number;
  /** The section revision's citation text and its recorded sha256. */
  sectionText: string;
  sectionSha: string;
}

export type ProvenanceProblem =
  | 'no_passage'
  | 'passage_id'
  | 'section_mismatch'
  | 'kind_mismatch'
  | 'scope_mismatch'
  | 'section_hash_mismatch'
  | 'offsets'
  | 'text_mismatch';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The approved passage id derivation (Task 9, worker/index/passages.ts `passageId`):
 * sha256 over the JSON array `[revision id, start, end, chunker version]`.
 */
export function derivePassageId(revisionId: string, start: number, end: number, chunkerVersion: string): string {
  return createHash('sha256').update(JSON.stringify([revisionId, start, end, chunkerVersion])).digest('hex');
}

/**
 * Check a retrieved passage against its canonical `passages` row and section revision:
 * the row exists for the served chunker, its id follows the approved derivation, the
 * retrieved case, section, revision, kind, scope, aircraft and offsets are the row's,
 * the section text still hashes to its recorded sha256, and the passage text is exactly
 * the section text at those offsets. The allowlisted values are the canonical ones.
 */
export function resolvePassage(
  passage: RetrievedPassageRef,
  canonical: CanonicalPassage | undefined,
): { ok: true; allowed: AllowedPassage } | { ok: false; problem: ProvenanceProblem } {
  const c = canonical;
  if (!c || c.passageId !== passage.passageId) return { ok: false, problem: 'no_passage' };
  if (derivePassageId(c.revisionId, c.start, c.end, c.chunkerVersion) !== c.passageId) return { ok: false, problem: 'passage_id' };
  if (
    c.ntsbNo !== passage.ntsbNo ||
    c.sectionId !== passage.sectionId ||
    c.revisionId !== passage.revisionId ||
    !c.sectionId.startsWith(`${c.ntsbNo}:`) ||
    !HEX64.test(c.revisionId)
  ) {
    return { ok: false, problem: 'section_mismatch' };
  }
  if (c.sectionKind !== passage.sectionKind) return { ok: false, problem: 'kind_mismatch' };
  if (c.scope !== passage.scope || c.aircraftKey !== passage.aircraftKey) return { ok: false, problem: 'scope_mismatch' };
  if (!HEX64.test(c.sectionSha) || createHash('sha256').update(c.sectionText, 'utf8').digest('hex') !== c.sectionSha) {
    return { ok: false, problem: 'section_hash_mismatch' };
  }
  const { start, end } = c;
  if (
    passage.start !== start ||
    passage.end !== end ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > c.sectionText.length
  ) {
    return { ok: false, problem: 'offsets' };
  }
  const text = c.sectionText.slice(start, end);
  if (text !== passage.text) return { ok: false, problem: 'text_mismatch' };
  return {
    ok: true,
    allowed: {
      ntsbNo: c.ntsbNo,
      text,
      sha: c.sectionSha,
      sectionId: c.sectionId,
      revisionId: c.revisionId,
      sectionKind: c.sectionKind,
      sectionStart: start,
      scope: c.scope,
      aircraftKey: c.aircraftKey,
    },
  };
}

// ---------------------------------------------------------------------------
// Free-text checks

/**
 * Anything shaped like an NTSB number (`DFW08TA066`, `SEA08LA057A`, `GAA19CA123`),
 * deliberately loose: 2–4 letters, 2 digits, 1–3 letters, 2–5 digits, an optional
 * letter, not inside a longer word; `/B` suffixes after an aircraft letter name more
 * aircraft of the same event (`DCA25MA108A/B`).
 */
const CASE_NUMBER_TOKEN = /(?<![A-Za-z0-9])([A-Za-z]{2,4}\d{2}[A-Za-z]{1,3}\d{2,5})([A-Za-z]?)((?:\/[A-Za-z](?![A-Za-z0-9]))*)(?![A-Za-z0-9])/g;

/** Every NTSB-number-shaped token in `text`, upper-cased; aircraft shorthand is expanded. */
export function caseNumberTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CASE_NUMBER_TOKEN)) {
    const base = m[1]!.toUpperCase();
    const letter = (m[2] ?? '').toUpperCase();
    out.push(base + letter);
    for (const more of (m[3] ?? '').split('/').filter(Boolean)) out.push(base + more.toUpperCase());
  }
  return out;
}

const MARKER = /\[\[case:([^\]]*)\]\]/g;
const MARKER_CASE = /^[A-Z0-9]{5,20}$/;
/** Links, web addresses and markup; generated text is rendered as plain text, and links are never wanted in it. */
const LINK_OR_MARKUP =
  /\b(?:https?:\/\/|www\.)|\b[a-z0-9-]+\.(?:com|org|net|gov|edu|io|info|biz|xyz)\b|<\/?[A-Za-z][^<>]*>|\]\(|`/i;

/** Case numbers in `[[case:…]]` markers, or null when a marker is malformed. */
export function summaryMarkers(summary: string): string[] | null {
  const found: string[] = [];
  for (const m of summary.matchAll(MARKER)) {
    if (!MARKER_CASE.test(m[1] ?? '')) return null;
    found.push(m[1]!);
  }
  const rest = summary.replace(MARKER, '');
  if (/\[\s*\[|\]\s*\]/.test(rest)) return null;
  return found;
}

/**
 * A passage alias (`P1`..`P12`, server/briefs/aliases.ts) as a token of its own: alone,
 * in parentheses, in a list or a range ("P3", "(P3)", "P3, P4", "P3-P5"), upper-case as
 * the model was shown it. Not inside a longer word or number ("WPR19LA123", "P-51",
 * "P210"), not a part of a designator ("J1/P1", "P1/J1", "IO-360-P1") and not a decimal
 * value ("P2.5").
 */
const ALIAS_TOKEN = /(?<![A-Za-z0-9/-])P\d{1,3}(?![A-Za-z0-9/]|\.\d)/g;

/**
 * The aliases of the allowlist (`P1`..) that model prose may not name: those neither the
 * reader's text nor any allowlisted passage uses as a complete token (any letter case,
 * between any separators: "J1/P1", "p3"; not "P1abc", "P10" or "P1.5").
 */
function leakableAliases(allow: Allowlist, readerText: string): Set<string> {
  const texts = [readerText, ...[...allow.passages.values()].map((p) => p.text)];
  const out = new Set<string>();
  for (const id of allow.passages.keys()) {
    if (!/^P\d{1,3}$/.test(id)) continue;
    const used = new RegExp(`(?<![A-Za-z0-9])${id}(?![A-Za-z0-9]|\\.\\d)`, 'i');
    if (!texts.some((t) => used.test(t))) out.add(id);
  }
  return out;
}

/** Allowed precision of timing values: one decimal place for flight hours, whole calendar days. */
export function timingValueAllowed(basis: string, value: number): boolean {
  if (basis === 'calendar_days') return Number.isInteger(value);
  if (basis === 'flight_hours') return Number.isInteger(Math.round(value * 10)) && Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
  return false;
}

/** Group kinds whose classification must cite supporting passages. */
const CITED_GROUPS: ReadonlySet<string> = new Set<GlyphKind>(['causal', 'defect_not_causal', 'no_fault']);

// ---------------------------------------------------------------------------

function schemaReasons(issues: readonly { path: readonly PropertyKey[] }[]): ValidationReason[] {
  return issues.slice(0, 20).map((i) => ({ code: 'schema', path: i.path.map(String).join('.') || '(root)' }));
}

/**
 * Validate a composition against the allowlist. Returns resolved citations for every
 * quote, or every reason it fails (content-free codes and paths).
 */
export function validateComposition(out: ComposeOutput, allow: Allowlist, opts: ValidateOptions): ValidationResult {
  const ruleVersion = QUOTE_MATCH_RULE_VERSION;
  const parsed = ComposeOutputSchema.safeParse(out);
  if (!parsed.success) return { ok: false, ruleVersion, reasons: schemaReasons(parsed.error.issues), summarySentences: [] };
  const c = parsed.data;
  const sentences = splitSentences(c.summary);
  const reasons: ValidationReason[] = [];
  const fail = (code: ValidationCode, path: string) => reasons.push({ code, path });

  // Passages: the provenance shape of every allowlisted entry.
  const bundleCases = new Set<string>();
  for (const [id, p] of allow.passages) {
    if (!p.sectionId.startsWith(`${p.ntsbNo}:`) || !HEX64.test(p.sha) || !HEX64.test(p.revisionId) || p.text === '') {
      fail('provenance', `passages.${id}`);
    }
    bundleCases.add(p.ntsbNo);
  }

  // The outcome: an answer cites at least one case; an abstention presents none.
  if (c.outcome === 'answer') {
    if (c.cases.length === 0 || c.groups.length === 0 || c.summary.trim() === '') fail('outcome_mismatch', 'outcome');
  } else if (c.cases.length > 0 || c.groups.length > 0 || c.summary.trim() !== '') {
    fail('outcome_mismatch', 'outcome');
  }

  // Cases: in the bundle, once each.
  const used = new Set<string>();
  c.cases.forEach((k, i) => {
    if (!bundleCases.has(k.ntsbNo) || !allow.cases.has(k.ntsbNo)) fail('unknown_case', `cases.${i}.ntsbNo`);
    if (used.has(k.ntsbNo)) fail('duplicate_case', `cases.${i}.ntsbNo`);
    used.add(k.ntsbNo);
  });

  // Groups: the right kinds, each used case in exactly one group.
  const kinds = new Set<string>();
  const grouped = new Map<string, number>();
  const groupOf = new Map<string, string>();
  c.groups.forEach((g, gi) => {
    if (kinds.has(g.kind)) fail('duplicate_group', `groups.${gi}.kind`);
    kinds.add(g.kind);
    if (opts.mechanicalCause === (g.kind === 'examples')) fail('group_kind_mismatch', `groups.${gi}.kind`);
    g.caseNumbers.forEach((n, ni) => {
      if (!used.has(n)) fail('group_unknown_case', `groups.${gi}.caseNumbers.${ni}`);
      grouped.set(n, (grouped.get(n) ?? 0) + 1);
      groupOf.set(n, g.kind);
    });
  });
  if (c.outcome === 'answer' && !opts.mechanicalCause && c.groups.length !== 1) fail('group_kind_mismatch', 'groups');
  c.cases.forEach((k, i) => {
    const n = grouped.get(k.ntsbNo) ?? 0;
    if (n === 0) fail('case_not_grouped', `cases.${i}.ntsbNo`);
    if (n > 1) fail('case_in_two_groups', `cases.${i}.ntsbNo`);
  });

  /** Every id cites a passage of `ntsbNo`; at least `min` ids. */
  const support = (ids: readonly string[], ntsbNo: string, path: string, min: number) => {
    if (ids.length < min) fail('missing_support', path);
    ids.forEach((id, i) => {
      const p = allow.passages.get(id);
      if (!p) fail('unknown_passage', `${path}.${i}`);
      else if (p.ntsbNo !== ntsbNo) fail('foreign_passage', `${path}.${i}`);
    });
  };

  // Quotes and cited passages: from passages of the same case; quotes located under the rule.
  const citations: ResolvedCitation[] = [];
  c.cases.forEach((k, ci) => {
    k.quotes.forEach((q, qi) => {
      const path = `cases.${ci}.quotes.${qi}`;
      const p = allow.passages.get(q.passageId);
      if (!p) return void fail('unknown_passage', `${path}.passageId`);
      if (p.ntsbNo !== k.ntsbNo) return void fail('foreign_passage', `${path}.passageId`);
      const m = matchQuote(p.text, q.quote);
      if (!m.ok) return void fail(m.code, `${path}.quote`);
      citations.push({
        ntsbNo: k.ntsbNo,
        caseIndex: ci,
        quoteIndex: qi,
        passageId: q.passageId,
        sectionId: p.sectionId,
        revisionId: p.revisionId,
        sectionSha: p.sha,
        text: p.text.slice(m.span.start, m.span.end),
        passageSpan: m.span,
        sectionSpan: { start: p.sectionStart + m.span.start, end: p.sectionStart + m.span.end },
        matches: m.matches,
        occurrence: 'first',
      });
    });
    support(k.evidencePassageIds, k.ntsbNo, `cases.${ci}.evidencePassageIds`, CITED_GROUPS.has(groupOf.get(k.ntsbNo) ?? '') ? 1 : 0);
    if (k.maintenance) {
      const cited = k.maintenance.relation === 'investigator_attributed' || k.maintenance.relation === 'preceding_not_established';
      support(k.maintenance.passageIds, k.ntsbNo, `cases.${ci}.maintenance.passageIds`, cited ? 1 : 0);
    }
    if (k.symptom) support(k.symptom.passageIds, k.ntsbNo, `cases.${ci}.symptom.passageIds`, 1);
    // Chronology: each stated fact cites the passages that state it; values at their precision.
    const t = k.chronology;
    const at = `cases.${ci}.chronology`;
    if (t?.flightHours) {
      support(t.flightHours.passageIds, k.ntsbNo, `${at}.flightHours.passageIds`, 1);
      if (!timingValueAllowed('flight_hours', t.flightHours.value)) fail('timing_precision', `${at}.flightHours.value`);
    }
    if (t?.calendarDays) {
      support(t.calendarDays.passageIds, k.ntsbNo, `${at}.calendarDays.passageIds`, 1);
      if (!timingValueAllowed('calendar_days', t.calendarDays.value)) fail('timing_precision', `${at}.calendarDays.value`);
    }
    if (t?.flight) support(t.flight.passageIds, k.ntsbNo, `${at}.flight.passageIds`, 1);
    if (t?.qualitative) support(t.qualitative.passageIds, k.ntsbNo, `${at}.qualitative.passageIds`, 1);
  });

  // Gaps: about a case in the bundle, resting on that case's passages.
  c.gaps.forEach((g, gi) => {
    if (!bundleCases.has(g.ntsbNo) || !allow.cases.has(g.ntsbNo)) fail('gap_unknown_case', `gaps.${gi}.ntsbNo`);
    g.passageIds.forEach((id, pi) => {
      const p = allow.passages.get(id);
      if (!p || p.ntsbNo !== g.ntsbNo) fail('gap_foreign_passage', `gaps.${gi}.passageIds.${pi}`);
    });
  });

  // Summary: plain one-line text; markers name used cases; every sentence ends with the
  // markers of the cases it is about, immediately before or after its final punctuation,
  // and holds no other sentence end (server/briefs/sentences.ts).
  if (summaryFormatProblem(c.summary)) fail('summary_format', 'summary');
  const markers = summaryMarkers(c.summary);
  if (markers === null) fail('bad_marker', 'summary');
  else {
    markers.forEach((n) => (used.has(n) ? undefined : fail('marker_unknown_case', 'summary')));
    sentences.forEach((sentence, si) => {
      const placement = citationPlacement(sentence);
      if (placement === 'misplaced') fail('misplaced_citation', `summary.${si}`);
      else if (placement === 'uncited') fail('uncited_summary', `summary.${si}`);
      if (ambiguousBoundary(sentence)) fail('ambiguous_boundary', `summary.${si}`);
    });
  }

  // Free text: every NTSB-number-shaped token is allowlisted; no links, markup or passage aliases.
  const leakable = leakableAliases(allow, opts.readerText ?? '');
  const texts: [string, string][] = [
    ['summary', c.summary],
    ...c.groups.map((g, gi): [string, string] => [`groups.${gi}.caseNumbers`, g.caseNumbers.join(' ')]),
    ...c.cases.map((k, i): [string, string] => [`cases.${i}.ntsbNo`, k.ntsbNo]),
    ...c.cases.map((k, i): [string, string] => [`cases.${i}.why`, k.why]),
    ...c.gaps.map((g, i): [string, string] => [`gaps.${i}.ntsbNo`, g.ntsbNo]),
    ...c.gaps.map((g, i): [string, string] => [`gaps.${i}.note`, g.note]),
  ];
  for (const [path, text] of texts) {
    if (caseNumberTokens(text).some((n) => !allow.cases.has(n))) fail('unallowlisted_case_number', path);
  }
  for (const [path, text] of [
    ['summary', c.summary],
    ...c.cases.map((k, i) => [`cases.${i}.why`, k.why]),
    ...c.gaps.map((g, i) => [`gaps.${i}.note`, g.note]),
  ] as [string, string][]) {
    if (LINK_OR_MARKUP.test(text)) fail('markup_or_link', path);
    if ([...text.replace(MARKER, ' ').matchAll(ALIAS_TOKEN)].some((m) => leakable.has(m[0]))) fail('alias_in_text', path);
  }

  return reasons.length > 0
    ? { ok: false, ruleVersion, reasons, summarySentences: sentences }
    : { ok: true, ruleVersion, citations, summarySentences: sentences };
}
