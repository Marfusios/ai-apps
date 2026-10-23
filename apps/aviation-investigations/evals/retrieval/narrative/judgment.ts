/**
 * Validation of Track N judge outputs (task 10c protocol v4, section 2), in code, before
 * any output counts. Version `NARRATIVE_VALIDATOR_VERSION` together with the brief
 * validator's quote rule (`quote-ws-v2`, reused from `server/briefs/validate.ts`) is the
 * validator version of the judgment cache identity.
 *
 * - **Sources.** Every evidence item names a label the request showed: a section (S..),
 *   a delivered passage (P..), a finding (F..) or an occurrence (O..).
 * - **Quotes.** A section or passage item needs a quote, located with `matchQuote`
 *   (whitespace runs collapsed, at least three words, exact code units, at most 600
 *   code units of source) in the stored text: the section's `case_sections.text`, or the
 *   passage's stored text. A quote from one part of a long case must lie in that part.
 *   The match is mapped to its canonical identity (section id and revision, or passage
 *   id) and its offsets. A coded row needs no quote; a quote given for one must be in its
 *   description. A valid quote proves the text exists, not that it entails the grade.
 * - **Grades.** A grade of 2 or 1 cites evidence. A grade of 0 rests either on evidence
 *   (the contrary situation) or on a stated absence. `abstain` only in an adjudicator's
 *   final decision. An absence ("absent from complete input") needs the complete input:
 *   never in one part of a long case.
 * - **Limits** (`OUTPUT_LIMITS`): evidence items, quote, rationale, absence and notes
 *   lengths.
 *
 * Problems are content-free codes with the label they concern (`quote_not_found:S3`).
 */
import { matchQuote, QUOTE_MATCH_RULE_VERSION } from '../../../server/briefs/validate.js';
import type { CaseEvidence, DeliveredPassage, SectionPiece } from './evidence.js';
import { GRADE_OF, OUTPUT_LIMITS, type Answerability, type ChunkVerdict, type Verdict } from './schemas.js';
import type { Grade } from './spec.js';

export const NARRATIVE_VALIDATOR_VERSION = 'track-n-validate.v1';
/** The validator version of the cache identity: this module and the quote rule it reuses. */
export const VALIDATOR_VERSION = `${NARRATIVE_VALIDATOR_VERSION}+${QUOTE_MATCH_RULE_VERSION}`;

export type SourceKind = 'section' | 'passage' | 'finding' | 'occurrence';

interface Source {
  kind: SourceKind;
  /** Where a quote must be found: the stored text. */
  text: string;
  /** Allowed spans of `text` (one part of a long case); the whole text when absent. */
  spans?: [number, number][];
  sectionId?: string;
  revisionId?: string;
  passageId?: string;
  rowId?: string;
}

export interface ValidationContext {
  sources: ReadonlyMap<string, Source>;
  allowAbstain: boolean;
  /** False in one part of a long case: an absence needs the complete input. */
  allowAbsence: boolean;
}

/** The sources of a complete-record request (every section, finding and occurrence). */
export function caseSources(e: CaseEvidence, pieces?: readonly SectionPiece[]): Map<string, Source> {
  const out = new Map<string, Source>();
  for (const s of e.sections) {
    const mine = pieces?.filter((p) => p.alias === s.alias);
    if (pieces && (!mine || mine.length === 0)) continue;
    out.set(s.alias, {
      kind: 'section',
      text: s.text,
      ...(mine ? { spans: mine.map((p) => [p.start, p.end] as [number, number]) } : {}),
      sectionId: s.sectionId,
      revisionId: s.revisionId,
    });
  }
  for (const f of e.findings) out.set(f.alias, { kind: 'finding', text: f.description ?? '', rowId: f.rowId });
  for (const o of e.occurrences) out.set(o.alias, { kind: 'occurrence', text: o.description ?? '', rowId: o.rowId });
  return out;
}

/** The sources of an answerability request: the delivered passages P1.. in order. */
export function passageSources(passages: readonly DeliveredPassage[]): Map<string, Source> {
  return new Map(passages.map((p, i) => [`P${i + 1}`, { kind: 'passage' as const, text: p.text, passageId: p.passageId, sectionId: p.sectionId, revisionId: p.revisionId }]));
}

export interface ValidatedEvidence {
  source: string;
  kind: SourceKind;
  quote: string | null;
  /** Offsets of the quote in the stored text (UTF-16 code units). */
  span?: { start: number; end: number };
  sectionId?: string;
  revisionId?: string;
  passageId?: string;
  rowId?: string;
}

export interface ValidatedVerdict {
  grade: Grade | 'abstain';
  evidence: ValidatedEvidence[];
  absent: boolean;
  absentWhat: string | null;
  rationale: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; problems: string[] };

function locate(src: Source, quote: string): { ok: true; span: { start: number; end: number } } | { ok: false; code: string } {
  const spans = src.spans ?? [[0, src.text.length]];
  let first: string | null = null;
  for (const [a, b] of spans) {
    const m = matchQuote(src.text.slice(a, b), quote);
    if (m.ok) return { ok: true, span: { start: a + m.span.start, end: a + m.span.end } };
    first ??= m.code;
  }
  // A quote found elsewhere in the section, but not in this part.
  if (src.spans && matchQuote(src.text, quote).ok) return { ok: false, code: 'quote_outside_part' };
  return { ok: false, code: first ?? 'quote_not_found' };
}

function validateEvidence(items: readonly { source: string; quote: string | null }[], ctx: ValidationContext, problems: string[]): ValidatedEvidence[] {
  const out: ValidatedEvidence[] = [];
  if (items.length > OUTPUT_LIMITS.evidence) problems.push('too_much_evidence');
  const seen = new Set<string>();
  for (const item of items.slice(0, OUTPUT_LIMITS.evidence)) {
    const key = `${item.source}\u0000${item.quote ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const src = ctx.sources.get(item.source);
    if (!src) {
      problems.push(`unknown_source:${item.source.slice(0, 12)}`);
      continue;
    }
    const ids = { ...(src.sectionId ? { sectionId: src.sectionId } : {}), ...(src.revisionId ? { revisionId: src.revisionId } : {}), ...(src.passageId ? { passageId: src.passageId } : {}), ...(src.rowId ? { rowId: src.rowId } : {}) };
    if (src.kind === 'finding' || src.kind === 'occurrence') {
      if (item.quote !== null && item.quote.trim() !== '' && !matchQuote(src.text, item.quote).ok && !src.text.includes(item.quote.trim())) {
        problems.push(`row_quote_mismatch:${item.source}`);
        continue;
      }
      out.push({ source: item.source, kind: src.kind, quote: null, ...ids });
      continue;
    }
    if (item.quote === null || item.quote.trim() === '') {
      problems.push(`missing_quote:${item.source}`);
      continue;
    }
    if (item.quote.length > OUTPUT_LIMITS.quoteChars) {
      problems.push(`quote_too_long:${item.source}`);
      continue;
    }
    const at = locate(src, item.quote);
    if (!at.ok) {
      problems.push(`${at.code}:${item.source}`);
      continue;
    }
    out.push({ source: item.source, kind: src.kind, quote: src.text.slice(at.span.start, at.span.end), span: at.span, ...ids });
  }
  return out;
}

function gradeRules(grade: Grade | 'abstain', evidence: readonly ValidatedEvidence[], absent: boolean, absentWhat: string | null, ctx: ValidationContext, problems: string[]): void {
  if (grade === 'abstain' && !ctx.allowAbstain) problems.push('abstain_not_allowed');
  if ((grade === 2 || grade === 1) && evidence.length === 0) problems.push('no_evidence_for_positive_grade');
  if (grade === 0 && evidence.length === 0 && !absent) problems.push('zero_grade_without_basis');
  if (absent && !ctx.allowAbsence) problems.push('absence_not_allowed');
  if (absent && (absentWhat === null || absentWhat.trim() === '')) problems.push('absence_without_what');
  if (absentWhat !== null && absentWhat.length > OUTPUT_LIMITS.absentChars) problems.push('absent_too_long');
}

/** A relevance verdict, a consolidation or an adjudicator's decision. */
export function validateVerdict(v: Verdict, ctx: ValidationContext): Validation<ValidatedVerdict> {
  const problems: string[] = [];
  const evidence = validateEvidence(v.evidence, ctx, problems);
  const grade: Grade | 'abstain' = v.grade === 'abstain' ? 'abstain' : GRADE_OF[v.grade];
  gradeRules(grade, evidence, v.absent_from_record, v.absent, ctx, problems);
  if (v.rationale.length > OUTPUT_LIMITS.rationaleChars) problems.push('rationale_too_long');
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  return { ok: true, value: { grade, evidence, absent: v.absent_from_record, absentWhat: v.absent_from_record ? v.absent : null, rationale: v.rationale } };
}

export interface ValidatedChunk {
  grade: Grade;
  evidence: ValidatedEvidence[];
  notes: string;
}

/** One part of a long case: no absence claims; quotes from this part only. */
export function validateChunk(v: ChunkVerdict, ctx: ValidationContext): Validation<ValidatedChunk> {
  const problems: string[] = [];
  const evidence = validateEvidence(v.evidence, { ...ctx, allowAbsence: false }, problems);
  const grade = GRADE_OF[v.grade];
  if ((grade === 2 || grade === 1) && evidence.length === 0) problems.push('no_evidence_for_positive_grade');
  if (v.notes.length > OUTPUT_LIMITS.notesChars) problems.push('notes_too_long');
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  return { ok: true, value: { grade, evidence, notes: v.notes } };
}

/** A bundle answerability judgment (absence means absent from the shown passages; `abstain` only when the context allows it). */
export function validateAnswerability(v: Answerability, ctx: ValidationContext): Validation<ValidatedVerdict> {
  const problems: string[] = [];
  const evidence = validateEvidence(v.evidence, ctx, problems);
  const grade: Grade | 'abstain' = v.grade === 'abstain' ? 'abstain' : GRADE_OF[v.grade];
  gradeRules(grade, evidence, v.absent_from_passages, v.absent, { ...ctx, allowAbsence: true }, problems);
  if (v.rationale.length > OUTPUT_LIMITS.rationaleChars) problems.push('rationale_too_long');
  if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] };
  return { ok: true, value: { grade, evidence, absent: v.absent_from_passages, absentWhat: v.absent_from_passages ? v.absent : null, rationale: v.rationale } };
}

/** The feedback line of the one retry after an invalid output: the problem codes only, never content. */
export const retryFeedback = (problems: readonly string[]): string =>
  `Your previous answer to this request was rejected by the validator for: ${problems.slice(0, 8).join(', ')}. ` +
  'Answer again under the same rules: copy every quote exactly from the section or passage you cite, cite only labels shown above, and give evidence for every grade.';
