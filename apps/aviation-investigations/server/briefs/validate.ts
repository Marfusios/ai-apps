/**
 * Code checks on a composition before anything reaches the reader (DESIGN §5 step 5,
 * amendment A4). They run before the model checker and are not fallible the way it
 * is: every quote is located in its passage, every case number is allowlisted, and
 * the structure is consistent. Any failure withholds the whole summary; there is no
 * repair loop.
 *
 * **Quote rule `quote-ws-v1`** (versioned: change the version when the rule changes,
 * because stored citations depend on it). Both the passage and the quote are
 * normalized the same way, and only this way: every maximal run of whitespace
 * (ECMAScript `\s`: space, tab, CR, LF, VT, FF, NBSP U+00A0, U+1680, U+2000–U+200A,
 * U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) becomes one space. The quote is then
 * trimmed; an empty quote is refused. The quote must be a substring of the passage's
 * normalized text, compared code unit by code unit: no case folding, no Unicode
 * normalization, no folding of quotation marks, dashes or ellipses. When it occurs
 * more than once, the first occurrence in the cited passage is used and the number
 * of occurrences is recorded. The match is mapped back through the normalization's
 * offset map to a span of the original passage text (UTF-16 code units), and to the
 * section text by the passage's offset in its section.
 *
 * Quotes are compared with the stored citation text (`case_sections.text` sliced by the
 * passage offsets), never with the copy rendered into the prompt, where untrusted
 * text had tag-like `<` replaced (server/ai/prompts/untrusted.ts).
 *
 * **Provenance chain** (A4): case → aircraft/scope → section id + revision hash →
 * passage → quote. `resolvePassage` checks a retrieved passage against its stored
 * section revision before the passage enters the allowlist; `validateComposition`
 * then requires each quote's passage to belong to the case that cites it.
 *
 * **Case numbers.** Every token shaped like an NTSB number in the summary, the groups,
 * the case entries, the `why` lines and the gap notes must be in the allowlist (case
 * insensitive). Quotes are exempt: they are verified passage text.
 */
import { createHash } from 'node:crypto';
import { ComposeOutputSchema, type ComposeOutput } from '../../shared/contracts/briefs.js';

export const QUOTE_MATCH_RULE_VERSION = 'quote-ws-v1';

/** A passage the composition may cite, with its provenance. */
export interface AllowedPassage {
  ntsbNo: string;
  /** The passage's citation text exactly as stored. */
  text: string;
  /** sha256 of the section revision's citation text (`case_sections.sha256`). */
  sha: string;
  sectionId: string;
  revisionId: string;
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
  /** The passage text at `passageSpan`: what the reader sees as the quote. */
  text: string;
  passageSpan: Span;
  sectionSpan: Span;
  /** Occurrences of the normalized quote in the normalized passage; the first is used. */
  matches: number;
  occurrence: 'first';
}

export type ValidationCode =
  | 'schema'
  | 'unknown_case'
  | 'duplicate_case'
  | 'duplicate_group'
  | 'group_kind_mismatch'
  | 'group_unknown_case'
  | 'case_not_grouped'
  | 'case_in_two_groups'
  | 'unknown_passage'
  | 'foreign_passage'
  | 'provenance'
  | 'empty_quote'
  | 'malformed_quote'
  | 'quote_not_found'
  | 'timing_shape'
  | 'bad_marker'
  | 'marker_unknown_case'
  | 'unallowlisted_case_number'
  | 'markup_or_link'
  | 'gap_unknown_case'
  | 'gap_foreign_passage';

/** A content-free reason: a code and where (a JSON path), never model or passage text. */
export interface ValidationReason {
  code: ValidationCode;
  path: string;
}

export type ValidationResult =
  | { ok: true; ruleVersion: typeof QUOTE_MATCH_RULE_VERSION; citations: ResolvedCitation[] }
  | { ok: false; ruleVersion: typeof QUOTE_MATCH_RULE_VERSION; reasons: ValidationReason[] };

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
  | { ok: false; code: 'empty_quote' | 'malformed_quote' | 'quote_not_found' };

/** Locate `quote` in `passage` under `quote-ws-v1`; the span is in the original passage text. */
export function matchQuote(passage: string, quote: string): QuoteMatch {
  if (LONE_SURROGATE.test(quote)) return { ok: false, code: 'malformed_quote' };
  const q = collapseWhitespace(quote).text.trim();
  if (q === '') return { ok: false, code: 'empty_quote' };
  const p = collapseWhitespace(passage);
  const at = p.text.indexOf(q);
  if (at < 0) return { ok: false, code: 'quote_not_found' };
  let matches = 0;
  for (let i = at; i >= 0; i = p.text.indexOf(q, i + 1)) matches += 1;
  // The trimmed quote starts and ends on non-whitespace, which maps to exactly one code unit.
  const start = p.map[at]!;
  const end = p.map[at + q.length - 1]! + 1;
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
  scope: 'aircraft' | 'event';
  aircraftKey: number | null;
  start: number;
  end: number;
  text: string;
}

/** The stored section revision a passage was cut from. */
export interface SectionRevision {
  ntsbNo: string;
  sectionId: string;
  revisionId: string;
  scope: 'aircraft' | 'event';
  aircraftKey: number | null;
  /** Citation text. */
  text: string;
  /** sha256 hex of `text` (UTF-8). */
  sha256: string;
}

export type ProvenanceProblem =
  | 'no_section'
  | 'section_mismatch'
  | 'scope_mismatch'
  | 'section_hash_mismatch'
  | 'offsets'
  | 'text_mismatch';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Check a retrieved passage against its stored section revision: same case, section,
 * revision, scope and aircraft; the section text still hashes to its recorded sha256;
 * and the passage text is exactly the section text at the passage's offsets. The
 * allowlisted text is the stored slice.
 */
export function resolvePassage(
  passage: RetrievedPassageRef,
  section: SectionRevision | undefined,
): { ok: true; allowed: AllowedPassage } | { ok: false; problem: ProvenanceProblem } {
  if (!section) return { ok: false, problem: 'no_section' };
  if (
    section.ntsbNo !== passage.ntsbNo ||
    section.sectionId !== passage.sectionId ||
    section.revisionId !== passage.revisionId ||
    !section.sectionId.startsWith(`${section.ntsbNo}:`) ||
    !HEX64.test(section.revisionId)
  ) {
    return { ok: false, problem: 'section_mismatch' };
  }
  if (section.scope !== passage.scope || section.aircraftKey !== passage.aircraftKey) return { ok: false, problem: 'scope_mismatch' };
  if (!HEX64.test(section.sha256) || createHash('sha256').update(section.text, 'utf8').digest('hex') !== section.sha256) {
    return { ok: false, problem: 'section_hash_mismatch' };
  }
  const { start, end } = passage;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > section.text.length) {
    return { ok: false, problem: 'offsets' };
  }
  const text = section.text.slice(start, end);
  if (text !== passage.text) return { ok: false, problem: 'text_mismatch' };
  return {
    ok: true,
    allowed: {
      ntsbNo: section.ntsbNo,
      text,
      sha: section.sha256,
      sectionId: section.sectionId,
      revisionId: section.revisionId,
      sectionStart: start,
      scope: section.scope,
      aircraftKey: section.aircraftKey,
    },
  };
}

// ---------------------------------------------------------------------------
// Free-text checks

/**
 * Anything shaped like an NTSB number (`DFW08TA066`, `SEA08LA057A`, `GAA19CA123`),
 * deliberately loose: 2–4 letters, 2 digits, 1–3 letters, 2–5 digits, an optional
 * letter, not inside a longer word. Matched case-insensitively.
 */
const CASE_NUMBER_TOKEN = /(?<![A-Za-z0-9])[A-Za-z]{2,4}\d{2}[A-Za-z]{1,3}\d{2,5}[A-Za-z]?(?![A-Za-z0-9])/g;

/** Every NTSB-number-shaped token in `text`, upper-cased. */
export function caseNumberTokens(text: string): string[] {
  return [...text.matchAll(CASE_NUMBER_TOKEN)].map((m) => m[0].toUpperCase());
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
  if (!parsed.success) return { ok: false, ruleVersion, reasons: schemaReasons(parsed.error.issues) };
  const c = parsed.data;
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
  c.groups.forEach((g, gi) => {
    if (kinds.has(g.kind)) fail('duplicate_group', `groups.${gi}.kind`);
    kinds.add(g.kind);
    if (opts.mechanicalCause === (g.kind === 'examples')) fail('group_kind_mismatch', `groups.${gi}.kind`);
    g.caseNumbers.forEach((n, ni) => {
      if (!used.has(n)) fail('group_unknown_case', `groups.${gi}.caseNumbers.${ni}`);
      grouped.set(n, (grouped.get(n) ?? 0) + 1);
    });
  });
  if (!opts.mechanicalCause && c.groups.length !== 1) fail('group_kind_mismatch', 'groups');
  c.cases.forEach((k, i) => {
    const n = grouped.get(k.ntsbNo) ?? 0;
    if (n === 0) fail('case_not_grouped', `cases.${i}.ntsbNo`);
    if (n > 1) fail('case_in_two_groups', `cases.${i}.ntsbNo`);
  });

  // Quotes: from a passage of the same case, located under the versioned rule.
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
    const t = k.timing;
    if (t) {
      const numeric = t.basis === 'flight_hours' || t.basis === 'calendar_days';
      if (numeric !== (t.value !== undefined)) fail('timing_shape', `cases.${ci}.timing`);
    }
  });

  // Gaps: about a case in the bundle, resting on that case's passages.
  c.gaps.forEach((g, gi) => {
    if (!bundleCases.has(g.ntsbNo) || !allow.cases.has(g.ntsbNo)) fail('gap_unknown_case', `gaps.${gi}.ntsbNo`);
    g.passageIds.forEach((id, pi) => {
      const p = allow.passages.get(id);
      if (!p || p.ntsbNo !== g.ntsbNo) fail('gap_foreign_passage', `gaps.${gi}.passageIds.${pi}`);
    });
  });

  // Summary markers point at cases the composition uses.
  const markers = summaryMarkers(c.summary);
  if (markers === null) fail('bad_marker', 'summary');
  else markers.forEach((n) => (used.has(n) ? undefined : fail('marker_unknown_case', 'summary')));

  // Free text: every NTSB-number-shaped token is allowlisted; no links or markup.
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
  }

  return reasons.length > 0 ? { ok: false, ruleVersion, reasons } : { ok: true, ruleVersion, citations };
}
