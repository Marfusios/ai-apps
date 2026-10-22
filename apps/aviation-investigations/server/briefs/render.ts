/**
 * What the brief pipeline builds from evidence and a validated composition, all from
 * server-owned fields and templates:
 * - the compose input (case headers from coded fields, passages after provenance);
 * - the check input: every claim the reader would see, as bounded claim/citation
 *   pairs (amendment A4: summary sentences, `why` lines, classifications, maintenance,
 *   symptom, timing, attribution and gaps), never the question or the planner's output;
 * - the briefing-sheet result (cards, groups, summary segments, chips, labels);
 * - the evidence a finished step keeps for the case context.
 */
import { buildHeadline, aircraftName } from '../../shared/case-view.js';
import {
  GLYPH_KINDS,
  type BriefFilters,
  type BriefResult,
  type CaseCard,
  type CaseReading,
  type ComposeOutput,
  type GlyphKind,
  type GroupKind,
  type InterpretationChip,
  type MaintenanceRelation,
  type NtsbExcerpt,
  type SummarySegment,
  type Symptom,
  type TimingChip,
} from '../../shared/contracts/briefs.js';
import { SECTION_LABEL } from '../../shared/contracts/search.js';
import type { CheckInput, ClaimKind, ComposeInput } from '../ai/provider.js';
import type { CaseSummary, EvidenceCase } from './evidence.js';
import type { StoredEvidence, StoredPassage } from './store.js';
import type { AllowedPassage, ResolvedCitation } from './validate.js';

/** A bundle case after provenance: its card fields and its allowlisted passages. */
export interface VerifiedCase {
  ntsbNo: string;
  rank: number;
  summary: CaseSummary;
  passages: { passageId: string; role: EvidenceCase['passages'][number]['role']; rank: number | null; sectionKind: StoredPassage['sectionKind']; allowed: AllowedPassage }[];
}

// ---------------------------------------------------------------------------
// Compose input

/** "Hughes OH-6 helicopter, total loss of engine power while maneuvering near Valentine, Texas · 2008-02-08". */
export function caseHeader(s: CaseSummary): string {
  const r = s.row;
  const headline = buildHeadline({
    aircraft: r.aircraft.map((a) => ({
      make: a.make,
      model: a.model,
      categoryCode: a.category.code,
      definingEvent: a.definingEvent
        ? { phase: a.definingEvent.phase, phaseCode: a.definingEvent.phaseDetail.code, eventCode: a.definingEvent.event.code }
        : null,
    })),
    eventTypeCode: r.eventType.code,
    city: r.city,
    stateCode: r.state.code,
  });
  const count = r.aircraft.length > 1 ? ` · ${r.aircraft.length} aircraft` : '';
  return `${headline}${r.date ? ` · ${r.date}` : ''}${count}`.slice(0, 400);
}

function aircraftLabel(s: CaseSummary, key: number | null): string | undefined {
  if (key === null) return undefined;
  const a = s.row.aircraft.find((x) => x.aircraftKey === key);
  return a ? aircraftName(a).slice(0, 120) : undefined;
}

export function composeInput(
  cases: readonly VerifiedCase[],
  opts: { question: string; refinement?: string; mechanicalCause: boolean; interpretations: string[] },
): ComposeInput {
  return {
    question: opts.question,
    ...(opts.refinement ? { refinement: opts.refinement } : {}),
    mechanicalCause: opts.mechanicalCause,
    interpretations: opts.interpretations.slice(0, 4),
    cases: cases.map((c) => ({
      ntsbNo: c.ntsbNo,
      header: caseHeader(c.summary),
      passages: c.passages.map((p) => {
        const aircraft = p.allowed.scope === 'aircraft' ? aircraftLabel(c.summary, p.allowed.aircraftKey) : undefined;
        return {
          passageId: p.passageId,
          section: SECTION_LABEL[p.sectionKind],
          scope: p.allowed.scope,
          ...(aircraft ? { aircraft } : {}),
          text: p.allowed.text,
        };
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Claims for the check stage (server templates for every structured value)

const CLASSIFICATION_CLAIM: Readonly<Record<GlyphKind, string>> = {
  causal: 'Investigators established a mechanical fault that caused this event.',
  defect_not_causal: 'Investigators found a defect but did not establish that it caused this event.',
  no_fault: 'Investigators examined the aircraft and found no relevant mechanical fault.',
  insufficient: 'The evidence does not establish a causal mechanical fault, a defect without a causal link, or a negative examination; it is insufficient or conflicting.',
};

const MAINTENANCE_CLAIM: Readonly<Record<Exclude<MaintenanceRelation, 'unknown'>, string>> = {
  investigator_attributed: 'Investigators attributed a cause of, or a contribution to, this event to maintenance.',
  preceding_not_established: 'Maintenance preceded this event, but investigators did not establish that it caused or contributed to it.',
  no_evidence: 'The cited passages mention no maintenance relevant to this event.',
};

const SYMPTOM_CLAIM: Readonly<Record<Exclude<Symptom, 'other'>, string>> = {
  total_power_loss: 'The engine lost all power.',
  partial_power_loss: 'The engine lost partial power.',
  rough_running: 'The engine ran rough.',
  failure_to_climb: 'The aircraft could not climb.',
};

const BOUND_WORD = { exact: '', about: 'about ', at_most: 'at most ', at_least: 'at least ' } as const;

const number = (v: number) => String(Math.round(v * 100) / 100);

function timingClaim(t: NonNullable<ComposeOutput['cases'][number]['timing']>): string {
  const b = BOUND_WORD[t.bound];
  switch (t.basis) {
    case 'flight_hours':
      return `The event happened ${b}${number(t.value ?? 0)} flight hours after the relevant maintenance.`;
    case 'calendar_days':
      return `The event happened ${b}${number(t.value ?? 0)} calendar days after the relevant maintenance.`;
    case 'first_flight':
      return 'The event happened on the first flight after the relevant maintenance.';
    case 'subsequent_flight':
      return 'The event happened on a later flight after the relevant maintenance, not the first.';
    case 'qualitative':
      return 'The passages describe the time between the relevant maintenance and the event only in words, without a number.';
  }
}

const SPEAKER_CLAIM = {
  investigators: 'These words are the investigators’ own (examination, analysis, findings or probable cause):',
  pilot: 'These words report the pilot’s account:',
  witness: 'These words report a witness’s account:',
} as const;

/** Summary sentences: split after sentence punctuation; markers stay with their sentence. */
export function summarySentences(summary: string): string[] {
  return summary
    .split(/(?<=[.!?](?:\s*\[\[case:[A-Z0-9]+\]\])*)\s+(?=\S)(?!\[\[)/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const MARKER = /\[\[case:([A-Z0-9]+)\]\]/g;

export interface ClaimMeta {
  kind: ClaimKind;
  ntsbNo: string | null;
}

/** Claims the check stage takes at most (CheckInputSchema), and the longest claim text. */
const MAX_CLAIMS = 100;
const MAX_CLAIM_TEXT = 2_000;

/**
 * The check stage's input for a validated composition: the cited passages (each once)
 * and every claim with the passages it rests on. A summary sentence cites the quoted
 * passages of the cases it marks (every quoted passage when it marks none).
 * `overflow`: some claim did not fit the input bounds; it would go unchecked, so the
 * caller must treat the check as inconclusive.
 */
export function checkInput(
  c: ComposeOutput,
  citations: readonly ResolvedCitation[],
  cases: ReadonlyMap<string, VerifiedCase>,
  opts: { mechanicalCause: boolean },
): { input: CheckInput; claims: ClaimMeta[]; overflow: boolean } {
  const quoted = new Map<string, string[]>();
  for (const cit of citations) {
    const ids = quoted.get(cit.ntsbNo) ?? [];
    if (!ids.includes(cit.passageId)) ids.push(cit.passageId);
    quoted.set(cit.ntsbNo, ids);
  }
  const allQuoted = [...new Set(citations.map((x) => x.passageId))];
  const claims: CheckInput['claims'] = [];
  const meta: ClaimMeta[] = [];
  let overflow = false;
  const add = (kind: ClaimKind, ntsbNo: string | null, text: string, passageIds: string[]) => {
    const ids = [...new Set(passageIds)];
    if (ids.length === 0 || ids.length > 12 || claims.length >= MAX_CLAIMS || text.length > MAX_CLAIM_TEXT) {
      overflow = true;
      return;
    }
    claims.push({ kind, ...(ntsbNo ? { ntsbNo } : {}), text, passageIds: ids });
    meta.push({ kind, ntsbNo });
  };

  for (const sentence of summarySentences(c.summary)) {
    const marked = [...new Set([...sentence.matchAll(MARKER)].map((m) => m[1]!))];
    const ids = marked.length > 0 ? marked.flatMap((n) => quoted.get(n) ?? []) : allQuoted;
    add('summary', marked.length === 1 ? marked[0]! : null, sentence.replace(MARKER, (_, n: string) => `(${n})`), ids);
  }
  const groupOf = new Map<string, GroupKind>();
  for (const g of c.groups) for (const n of g.caseNumbers) groupOf.set(n, g.kind);
  c.cases.forEach((k) => {
    const ids = quoted.get(k.ntsbNo) ?? [];
    add('why', k.ntsbNo, k.why, ids);
    const group = groupOf.get(k.ntsbNo);
    if (opts.mechanicalCause && group && group !== 'examples') add('classification', k.ntsbNo, CLASSIFICATION_CLAIM[group], ids);
    if (opts.mechanicalCause && k.maintenance && k.maintenance !== 'unknown') add('maintenance', k.ntsbNo, MAINTENANCE_CLAIM[k.maintenance], ids);
    if (opts.mechanicalCause && k.symptom && k.symptom !== 'other') add('symptom', k.ntsbNo, SYMPTOM_CLAIM[k.symptom], ids);
    if (k.timing) add('timing', k.ntsbNo, timingClaim(k.timing), ids);
  });
  for (const cit of citations) {
    const speaker = c.cases[cit.caseIndex]?.quotes[cit.quoteIndex]?.speaker ?? 'investigators';
    add('attribution', cit.ntsbNo, `${SPEAKER_CLAIM[speaker]} “${cit.text}”`, [cit.passageId]);
  }
  for (const g of c.gaps) add('gap', g.ntsbNo, g.note, g.passageIds);

  const cited = new Set(claims.flatMap((x) => x.passageIds));
  const passages: CheckInput['passages'] = [];
  for (const vc of cases.values()) {
    for (const p of vc.passages) {
      if (!cited.has(p.passageId)) continue;
      const aircraft = p.allowed.scope === 'aircraft' ? aircraftLabel(vc.summary, p.allowed.aircraftKey) : undefined;
      passages.push({
        passageId: p.passageId,
        ntsbNo: vc.ntsbNo,
        section: SECTION_LABEL[p.sectionKind],
        scope: p.allowed.scope,
        ...(aircraft ? { aircraft } : {}),
        text: p.allowed.text,
      });
    }
  }
  return { input: { passages, claims }, claims: meta, overflow };
}

// ---------------------------------------------------------------------------
// Result

const BOUND_PREFIX = { exact: '', about: '≈ ', at_most: '≤ ', at_least: '≥ ' } as const;

/** "5.1 FH", "≤ 17 DAYS", "1ST FLIGHT", "LATER FLIGHT", "NOT QUANTIFIED". */
export function timingChip(t: NonNullable<ComposeOutput['cases'][number]['timing']>): TimingChip {
  const prefix = BOUND_PREFIX[t.bound];
  const value = t.value ?? null;
  const label =
    t.basis === 'flight_hours'
      ? `${prefix}${number(value ?? 0)} FH`
      : t.basis === 'calendar_days'
        ? `${prefix}${number(value ?? 0)} ${value === 1 ? 'DAY' : 'DAYS'}`
        : t.basis === 'first_flight'
          ? '1ST FLIGHT'
          : t.basis === 'subsequent_flight'
            ? 'LATER FLIGHT'
            : 'NOT QUANTIFIED';
  return { basis: t.basis, value: t.basis === 'flight_hours' || t.basis === 'calendar_days' ? value : null, bound: t.bound, label };
}

const EXCERPT_MAX = 600;

/** The case's best retrieved passage, cut at a word boundary. */
export function excerptOf(c: VerifiedCase): NtsbExcerpt {
  const best =
    [...c.passages].filter((p) => p.role === 'retrieved').sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))[0] ?? c.passages[0]!;
  const text = best.allowed.text.trim();
  let cut = text;
  let truncatedEnd = false;
  if (text.length > EXCERPT_MAX) {
    const at = text.lastIndexOf(' ', EXCERPT_MAX);
    cut = text.slice(0, at > EXCERPT_MAX / 2 ? at : EXCERPT_MAX).trimEnd();
    truncatedEnd = true;
  }
  return { passageId: best.passageId, section: best.sectionKind, text: cut, truncatedStart: false, truncatedEnd };
}

/** A plain card: NTSB fields and an excerpt, no AI reading. */
export function plainCard(c: VerifiedCase): CaseCard {
  return { case: c.summary.row, report: c.summary.report, excerpt: excerptOf(c), reading: null };
}

/** Summary text as text segments and case citations. */
export function summarySegments(summary: string): SummarySegment[] {
  const out: SummarySegment[] = [];
  let last = 0;
  for (const m of summary.matchAll(MARKER)) {
    const text = summary.slice(last, m.index);
    if (text.trim() !== '') out.push({ kind: 'text', text });
    out.push({ kind: 'case', ntsbNo: m[1]! });
    last = (m.index ?? 0) + m[0].length;
  }
  const tail = summary.slice(last);
  if (tail.trim() !== '') out.push({ kind: 'text', text: tail });
  return out;
}

export interface AnswerInput {
  composition: ComposeOutput;
  citations: readonly ResolvedCitation[];
  cases: ReadonlyMap<string, VerifiedCase>;
  mechanicalCause: boolean;
  interpretations: InterpretationChip[];
  filters: BriefFilters;
}

function reading(k: ComposeOutput['cases'][number], ci: number, a: AnswerInput, vc: VerifiedCase, group: GroupKind | undefined): CaseReading {
  const cits = a.citations.filter((x) => x.caseIndex === ci);
  const quotes = cits.map((cit) => {
    const p = vc.passages.find((x) => x.passageId === cit.passageId)!;
    return {
      passageId: cit.passageId,
      section: p.sectionKind,
      scope: p.allowed.scope,
      aircraftKey: p.allowed.aircraftKey,
      sectionId: cit.sectionId,
      revisionId: cit.revisionId,
      sectionRevision: cit.sectionSha,
      text: cit.text.slice(0, 1_200),
      span: cit.passageSpan,
      sectionSpan: cit.sectionSpan,
      speaker: k.quotes[cit.quoteIndex]?.speaker ?? 'investigators',
    };
  });
  const first = quotes[0]!;
  const multiAircraft = vc.summary.row.aircraft.length > 1;
  const evidence =
    first.scope === 'aircraft' && first.aircraftKey !== null && quotes.every((q) => q.scope === 'aircraft' && q.aircraftKey === first.aircraftKey)
      ? { scope: 'aircraft' as const, aircraftKey: first.aircraftKey }
      : { scope: 'event' as const, multiAircraft };
  // Ambiguous attribution in a multi-aircraft event: no glyph (UI_DESIGN §4.3).
  const glyph =
    a.mechanicalCause && group && group !== 'examples' && !(evidence.scope === 'event' && multiAircraft) ? (group as GlyphKind) : null;
  return { glyph, why: k.why, timing: k.timing ? timingChip(k.timing) : null, quotes, evidence };
}

export function answerResult(a: AnswerInput): Extract<BriefResult, { kind: 'answer' }> {
  const c = a.composition;
  const groupOf = new Map<string, GroupKind>();
  for (const g of c.groups) for (const n of g.caseNumbers) groupOf.set(n, g.kind);
  const cards: CaseCard[] = c.cases.map((k, ci) => {
    const vc = a.cases.get(k.ntsbNo)!;
    return { ...plainCard(vc), reading: reading(k, ci, a, vc, groupOf.get(k.ntsbNo)) };
  });
  const groups = a.mechanicalCause
    ? GLYPH_KINDS.map((kind) => ({ kind, caseNumbers: c.groups.find((g) => g.kind === kind)?.caseNumbers ?? [] }))
    : [{ kind: 'examples' as const, caseNumbers: c.cases.map((k) => k.ntsbNo) }];
  return {
    kind: 'answer',
    interpretations: a.interpretations,
    filters: a.filters,
    grouping: a.mechanicalCause ? 'mechanical' : 'examples',
    summary: summarySegments(c.summary),
    groups,
    cases: cards,
    gaps: c.gaps.map((g) => ({ ntsbNo: g.ntsbNo, text: g.note })),
  };
}

/** What a finished step keeps for the case context: every verified passage of the bundle. */
export function storedEvidence(cases: Iterable<VerifiedCase>, ruleVersion: string | null): StoredEvidence {
  const passages: StoredPassage[] = [];
  for (const c of cases) {
    for (const p of c.passages) {
      passages.push({
        passageId: p.passageId,
        ntsbNo: c.ntsbNo,
        sectionKind: p.sectionKind,
        scope: p.allowed.scope,
        aircraftKey: p.allowed.aircraftKey,
        sectionId: p.allowed.sectionId,
        revisionId: p.allowed.revisionId,
        sectionRevision: p.allowed.sha,
        sectionStart: p.allowed.sectionStart,
        text: p.allowed.text,
      });
    }
  }
  return { ruleVersion, passages };
}
