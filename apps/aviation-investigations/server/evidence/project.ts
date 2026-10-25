/** Deterministic evidence projection. Source text is never rewritten, abbreviated or completed. */
import { wholeNarrativeParagraphs } from '../../shared/narrative-paragraphs.js';
import { AVIATION_STOP_WORDS, AVIATION_SYNONYMS } from '../../shared/aviation-analysis.js';
import { BRIEF_FILTER_FACETS, type BriefFilters } from '../../shared/contracts/briefs.js';
import { EvidenceCaseSchema, MAX_EXCERPTS_PER_CASE, type EvidenceCase, type EvidenceExcerpt, type EvidenceRelevance } from '../../shared/contracts/evidence.js';
import type { ReportLink } from '../../shared/contracts/cases.js';
import { SECTION_LABEL } from '../../shared/contracts/search.js';
import type { CaseRecord, CaseRecordAircraft, CaseRecordSection } from '../db/queries/case-records.js';
import type { CaseRowBase } from '../db/queries/case-views.js';
import type { PassageHit } from '../search/hybrid.js';

export const EVIDENCE_PROJECTION_VERSION = 'paragraphs.v2';
export interface RankedEvidenceCase { ntsbNo: string; seeds: PassageHit[]; channels: EvidenceRelevance['channels'] }
type Span = { start: number; end: number };
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s: string): string[] => s.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];
const normalized = (s: string) => s.toLowerCase().replace(/\s+/gu, ' ').trim();
const occurrences = (text: string, phrase: string): Span[] => {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${phrase.split(/\s+/u).map(escape).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
  return [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
};

/** Only explicit search-time synonym rules, in their declared direction. No inferred semantic matches or stems. */
export function termPlan(query: string): { term: string; synonyms: string[] }[] {
  const plan = new Map<string, Set<string>>();
  for (const rule of AVIATION_SYNONYMS) {
    const [left, right] = rule.split('=>');
    const source = left!.split(',').map((s) => s.trim());
    const targets = (right ?? left!).split(',').map((s) => s.trim());
    for (const term of source) if (occurrences(query, term).length > 0) {
      const synonyms = plan.get(term) ?? new Set<string>();
      for (const target of targets) if (target !== term) synonyms.add(target);
      plan.set(term, synonyms);
    }
  }
  for (const word of words(query)) {
    const term = normalized(word);
    if (term.length <= 80 && !AVIATION_STOP_WORDS.includes(term) && !plan.has(term)) plan.set(term, new Set());
  }
  return [...plan].slice(0, 20).map(([term, synonyms]) => ({ term, synonyms: [...synonyms] }));
}

export function highlighted(text: string, plan: ReturnType<typeof termPlan>): { highlights: EvidenceExcerpt['highlights']; terms: EvidenceRelevance['terms'] } {
  const matches = plan.flatMap((p, term) => [
    ...occurrences(text, p.term).map((s) => ({ ...s, match: 'literal' as const, term })),
    ...p.synonyms.flatMap((syn) => occurrences(text, syn).map((s) => ({ ...s, match: 'synonym' as const, term }))),
  ]).sort((a, b) => a.start - b.start || b.end - a.end || (a.match === b.match ? a.term - b.term : a.match === 'literal' ? -1 : 1));
  const accepted: typeof matches = [];
  for (const m of matches) if (m.start >= (accepted.at(-1)?.end ?? 0)) accepted.push(m);
  const terms = plan.map((p, i) => ({ term: p.term,
    literal: accepted.filter((m) => m.term === i && m.match === 'literal').length,
    synonym: accepted.filter((m) => m.term === i && m.match === 'synonym').length,
  }));
  return { terms, highlights: accepted.slice(0, 200).map(({ start, end, match }) => ({ start, end, match })) };
}

/** The chunker's single-line/hard-wrap rules, with headings kept with their paragraph. */
export function paragraphSpans(text: string): Span[] {
  if (text.includes('\r')) throw new Error('noncanonical line ending');
  return wholeNarrativeParagraphs(text);
}

function verifySeed(seed: PassageHit, section: CaseRecordSection, c: CaseRecord): void {
  const boundary = (n: number) => n === 0 || n === section.text.length || !(/[\uD800-\uDBFF]/.test(section.text[n - 1]!) && /[\uDC00-\uDFFF]/.test(section.text[n]!));
  if (seed.ntsbNo !== c.ntsbNo || seed.sectionId !== section.sectionId || seed.revisionId !== section.revisionId ||
      seed.sectionKind !== section.kind || seed.scope !== section.scope || seed.aircraftKey !== section.aircraftKey ||
      !Number.isInteger(seed.start) || !Number.isInteger(seed.end) || seed.start < 0 || seed.end <= seed.start || seed.end > section.text.length ||
      !boundary(seed.start) || !boundary(seed.end) ||
      (section.scope === 'aircraft' && (c.aircraft.length !== 1 || c.aircraft[0]?.aircraftKey !== section.aircraftKey)) ||
      (section.scope === 'event' && section.aircraftKey !== null)) throw new Error('invalid canonical evidence seed');
}

const member = (values: readonly string[], value: string | null): boolean => values.includes(value ?? 'blank');
function aircraftMatches(a: CaseRecordAircraft, f: BriefFilters): boolean {
  return (!f.category?.length || member(f.category, a.category)) &&
    (!f.phase?.length || member(f.phase, a.definingPhaseGroup)) &&
    (!f.far_part?.length || member(f.far_part, a.farPart)) &&
    (!f.purpose?.length || member(f.purpose, a.purpose)) &&
    (!f.engine?.length || (a.engines.some((e) => e.engType && f.engine!.includes(e.engType)) ||
      (a.engines.every((e) => e.engType === null) && f.engine.includes('blank'))));
}
/** Re-check all filters against coded rows. Never infer a fact from a retrieval score or a narrative. */
export function satisfiedFilters(c: CaseRecord, f: BriefFilters): EvidenceRelevance['filters'] {
  if (!c.isUs || !c.answerEligible) throw new Error('evidence outside default cohort');
  for (const [key, value] of [['injury', c.highestInjury], ['conditions', c.wxCondBasic], ['light', c.lightCond], ['state', c.state]] as const) {
    if (f[key]?.length && !member(f[key]!, value)) throw new Error('canonical event filter mismatch');
  }
  const aircraftFilters = ['category', 'phase', 'engine', 'far_part', 'purpose'] as const;
  if (aircraftFilters.some((key) => f[key]?.length)) {
    if (c.aircraft.length === 0 || !c.aircraft.every((a) => aircraftMatches(a, f))) throw new Error('canonical aircraft filter mismatch');
    // Multi-aircraft event qualification never treats a blank as a positive value.
    if (c.aircraft.length > 1) {
      const nonblank = { ...f };
      for (const k of aircraftFilters) if (f[k]?.length) {
        nonblank[k] = f[k]!.filter((v) => v !== 'blank');
        if (!nonblank[k]!.length) throw new Error('blank event filter');
      }
      if (!c.aircraft.every((a) => aircraftMatches(a, nonblank))) throw new Error('blank event filter');
    }
  }
  const years = f.yearFrom !== undefined || f.yearTo !== undefined;
  if (years && (c.evYear === null || c.evYear < (f.yearFrom ?? 1900) || c.evYear > (f.yearTo ?? 2100))) throw new Error('canonical year filter mismatch');
  return [...BRIEF_FILTER_FACETS.filter((key) => f[key]?.length), ...(years ? ['years' as const] : [])];
}

export function projectCase(record: CaseRecord, row: CaseRowBase, report: ReportLink, ranked: RankedEvidenceCase, rank: number, filters: BriefFilters, terms: string): EvidenceCase {
  const plan = termPlan(terms);
  const excerpts: EvidenceExcerpt[] = [];
  const seen = new Set<string>();
  const counts = plan.map((p) => ({ term: p.term, literal: 0, synonym: 0 }));
  for (const seed of ranked.seeds) {
    const section = record.sections.find((s) => s.sectionId === seed.sectionId);
    if (!section) throw new Error('missing canonical evidence section');
    verifySeed(seed, section, record);
    for (const paragraph of paragraphSpans(section.text).filter((p) => p.start < seed.end && p.end > seed.start)) {
      const key = `${section.sectionKey}:${paragraph.start}`;
      if (seen.has(key) || excerpts.length >= MAX_EXCERPTS_PER_CASE) continue;
      seen.add(key);
      const text = section.text.slice(paragraph.start, paragraph.end);
      const marks = highlighted(text, plan);
      marks.terms.forEach((t, i) => { counts[i]!.literal += t.literal; counts[i]!.synonym += t.synonym; });
      excerpts.push({ sectionKey: section.sectionKey, section: section.kind, label: SECTION_LABEL[section.kind], scope: section.scope,
        aircraftKey: section.aircraftKey, revision: section.revisionId, paragraph, seed: { start: seed.start, end: seed.end }, text, highlights: marks.highlights });
    }
  }
  const probableCauses = record.sections.filter((s) => s.kind === 'probable_cause').map((s) => ({ sectionKey: s.sectionKey,
    scope: s.scope, aircraftKey: s.aircraftKey, revision: s.revisionId, text: s.text }));
  if (probableCauses.length === 0) throw new Error('missing canonical cause');
  return EvidenceCaseSchema.parse({ rank, case: row, report, probableCauses, excerpts,
    relevance: { filters: satisfiedFilters(record, filters), terms: counts.filter((t) => t.literal + t.synonym > 0), channels: ranked.channels } });
}

/** Optional display annotations only; never changes ranks, source text, spans or selection. */
export function suggestedHighlights(result: EvidenceCase, terms: string): EvidenceCase {
  const plan = termPlan(terms);
  const counts = plan.map(p => ({ term: p.term, literal: 0, synonym: 0 }));
  const excerpts = result.excerpts.map(excerpt => {
    const marks = highlighted(excerpt.text, plan);
    marks.terms.forEach((t, i) => { counts[i]!.literal += t.literal; counts[i]!.synonym += t.synonym; });
    return { ...excerpt, highlights: marks.highlights };
  });
  return EvidenceCaseSchema.parse({ ...result, excerpts, relevance: { ...result.relevance,
    terms: counts.filter(t => t.literal + t.synonym > 0) } });
}
