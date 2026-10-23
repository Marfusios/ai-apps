/**
 * What the brief pipeline builds from evidence and a validated composition, all from
 * server-owned fields and templates:
 * - the compose input (case headers from coded fields, passages after provenance, with
 *   section labels from the canonical passage rows);
 * - the check input (gate G6 #1, #5): every claim the reader would see as a claim with
 *   the passages it says it rests on (summary sentences, `why` lines, classifications,
 *   maintenance, symptom, each chronology fact, attribution, every criterion decision
 *   and gaps), every verified passage of each case those claims are about, and the
 *   reader's criteria as server templates; never the question, the planner's output or
 *   earlier answers;
 * - the briefing-sheet result (cards, groups, summary segments, chips, labels), with
 *   accepted quotes shown whole, timing values shown exactly as checked, and cases a
 *   criterion is unconfirmed for flagged on their card and their summary citations;
 * - the evidence a finished step keeps for the case context, with each structured
 *   claim's own passages and each criterion's checked passage set.
 */
import { buildHeadline, aircraftName } from '../../shared/case-view.js';
import {
  GLYPH_KINDS,
  type BriefFilters,
  type BriefResult,
  type CaseCard,
  type CaseReading,
  type ChronologyFact as ComposeChronologyFact,
  type ChronologyRelation,
  type ComposeChronology,
  type ComposeCase,
  type ComposeOutput,
  type Criterion,
  type CriterionDecision,
  type GlyphKind,
  type GroupKind,
  type InterpretationChip,
  type MaintenanceRelation,
  type NtsbExcerpt,
  type SummarySegment,
  type Symptom,
  type TimingBound,
  type TimingChip,
} from '../../shared/contracts/briefs.js';
import { SECTION_LABEL } from '../../shared/contracts/search.js';
import { MAX_CHECK_CLAIMS, type CheckInput, type ClaimKind, type ComposeInput } from '../ai/provider.js';
import { maintenanceWords, type CaseEvidence, type CriterionCheck, type Decision } from './criteria.js';
import type { CaseSummary, EvidencePassage } from './evidence.js';
import { splitSentences } from './sentences.js';
import { NO_MATCH_LINES } from './static-replies.js';
import type { StoredDimensions, StoredEvidence, StoredPassage } from './store.js';
import type { AllowedPassage, ResolvedCitation } from './validate.js';

/** A bundle case after the provenance and completeness checks: its card fields and its allowlisted passages. */
export interface VerifiedCase {
  ntsbNo: string;
  rank: number;
  summary: CaseSummary;
  passages: {
    passageId: string;
    role: EvidencePassage['role'];
    reserved: boolean;
    rank: number | null;
    /** From the canonical passage row. */
    sectionKind: StoredPassage['sectionKind'];
    allowed: AllowedPassage;
  }[];
}

/**
 * A verified case's supplied passages as the criteria read them: their ids and verified
 * scopes, and whether the event involved more than one aircraft (timing rule A-2: a
 * fact's attribution comes from the verified scope of the passages it cites).
 */
export function caseEvidence(vc: Pick<VerifiedCase, 'passages' | 'summary'> | undefined): CaseEvidence {
  const passages = vc?.passages ?? [];
  return {
    passageIds: passages.map((p) => p.passageId),
    scopes: new Map(passages.map((p) => [p.passageId, { scope: p.allowed.scope, aircraftKey: p.allowed.aircraftKey }])),
    multiAircraft: (vc?.summary.row.aircraft.length ?? 0) > 1,
  };
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

/** A passage as the models see it: label, scope and aircraft from verified metadata only. */
function modelPassage(vc: VerifiedCase, p: VerifiedCase['passages'][number]) {
  const aircraft = p.allowed.scope === 'aircraft' ? aircraftLabel(vc.summary, p.allowed.aircraftKey) : undefined;
  return {
    passageId: p.passageId,
    section: SECTION_LABEL[p.allowed.sectionKind],
    scope: p.allowed.scope,
    ...(aircraft ? { aircraft } : {}),
    text: p.allowed.text,
  };
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
    cases: cases.map((c) => ({ ntsbNo: c.ntsbNo, header: caseHeader(c.summary), passages: c.passages.map((p) => modelPassage(c, p)) })),
  };
}

// ---------------------------------------------------------------------------
// One canonical representation of timing values (G6 #6)

/**
 * A timing value as text. Validation allows one decimal place for flight hours and
 * whole days (`timingValueAllowed`), so this is the number exactly as checked, stored
 * and shown; nothing is rounded.
 */
export function timingValueText(v: number): string {
  return String(v);
}

const BOUND_WORD = { exact: '', about: 'about ', at_most: 'at most ', at_least: 'at least ' } as const;

type Chronology = ComposeChronology;

/**
 * One displayed chronology fact (a fact from the relevant maintenance to the event
 * flight; facts measured from another anchor are kept in the composition but neither
 * shown nor decisive): its chip basis and value, its checker claim and the passages that
 * state it.
 */
export interface ChronologyFact {
  basis: TimingChip['basis'];
  /** The stated number (hours, days, the flight's ordinal, completed flights in between), or null. */
  value: number | null;
  bound: TimingBound;
  claim: string;
  passageIds: string[];
}

/** Display order of the relations. */
const RELATION_ORDER: readonly ChronologyRelation[] = [
  'flight_hours',
  'calendar_days',
  'same_day',
  'previous_day',
  'immediately_before',
  'flight_ordinal',
  'intervening_flights',
  'words',
];

/** "1st", "2nd", "3rd", "4th", "11th", "21st". */
export function ordinalNumber(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** "first", "second", "third", then "4th", "21st". */
export function ordinalWord(n: number): string {
  return n >= 1 && n <= 3 ? ['first', 'second', 'third'][n - 1]! : ordinalNumber(n);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** One relevant fact as its chip basis, value and checker claim; null when its parts are inconsistent (validation refuses those first). */
function factView(f: ComposeChronologyFact, m: string): ChronologyFact | null {
  const ids = [...f.passageIds];
  const v = f.value;
  const b = f.bound ?? 'exact';
  const capital = `${m.charAt(0).toUpperCase()}${m.slice(1)}`;
  switch (f.relation) {
    case 'flight_hours':
    case 'calendar_days': {
      if (v === undefined || f.bound === undefined) return null;
      const unit = f.relation === 'flight_hours' ? plural(v, 'flight hour', 'flight hours') : plural(v, 'calendar day', 'calendar days');
      return { basis: f.relation, value: v, bound: b, claim: `The event happened ${BOUND_WORD[b]}${timingValueText(v)} ${unit} after ${m}.`, passageIds: ids };
    }
    case 'same_day':
      return { basis: 'same_day', value: null, bound: 'exact', claim: `${capital} was done on the same calendar day as the event.`, passageIds: ids };
    case 'previous_day':
      return { basis: 'previous_day', value: null, bound: 'exact', claim: `${capital} was done on the calendar day before the event.`, passageIds: ids };
    case 'immediately_before':
      return { basis: 'immediately_before', value: null, bound: 'exact', claim: `${capital} was completed immediately before the flight on which the event happened.`, passageIds: ids };
    case 'flight_ordinal':
      if (v === undefined || !Number.isInteger(v) || v < 1) return null;
      return {
        basis: v === 1 ? 'first_flight' : 'subsequent_flight',
        value: v,
        bound: 'exact',
        claim: `The event happened on the ${ordinalWord(v)} flight after ${m}.`,
        passageIds: ids,
      };
    case 'intervening_flights': {
      if (v === undefined || f.bound === undefined) return null;
      const count = v === 0 && b === 'exact' ? 'No completed flight' : `${capitalWord(BOUND_WORD[b])}${timingValueText(v)} completed ${plural(v, 'flight', 'flights')}`;
      return { basis: 'flights_between', value: v, bound: b, claim: `${count} came between ${m} and the flight on which the event happened.`, passageIds: ids };
    }
    case 'words':
      return { basis: 'qualitative', value: null, bound: 'exact', claim: `A supplied passage describes the time between ${m} and the event in words, without a number.`, passageIds: ids };
  }
}

const capitalWord = (s: string) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s);

/**
 * The case's displayed chronology facts (from its relevant maintenance) in display order:
 * flight hours, calendar days, the same or the previous day, immediately before, which
 * flight, flights in between, words.
 */
export function chronologyFacts(c: Chronology | undefined): ChronologyFact[] {
  if (!c) return [];
  const m = maintenanceWords(c);
  return RELATION_ORDER.flatMap((relation) =>
    c.facts.filter((f) => f.anchor === 'relevant_maintenance' && f.relation === relation).flatMap((f) => factView(f, m) ?? []),
  );
}

const BOUND_PREFIX = { exact: '', about: '≈ ', at_most: '≤ ', at_least: '≥ ' } as const;

/** "5.1 FH", "≤ 17 DAYS", "SAME DAY", "PREVIOUS DAY", "IMMEDIATELY BEFORE", "1ST FLIGHT", "3RD FLIGHT", "0 FLIGHTS BETWEEN", "IN WORDS". */
export function timingChip(f: Pick<ChronologyFact, 'basis' | 'value' | 'bound'>): TimingChip {
  const v = f.value ?? 0;
  const prefix = BOUND_PREFIX[f.bound];
  const label = (() => {
    switch (f.basis) {
      case 'flight_hours':
        return `${prefix}${timingValueText(v)} FH`;
      case 'calendar_days':
        return `${prefix}${timingValueText(v)} ${v === 1 ? 'DAY' : 'DAYS'}`;
      case 'same_day':
        return 'SAME DAY';
      case 'previous_day':
        return 'PREVIOUS DAY';
      case 'immediately_before':
        return 'IMMEDIATELY BEFORE';
      case 'first_flight':
        return '1ST FLIGHT';
      case 'subsequent_flight':
        return `${ordinalNumber(v).toUpperCase()} FLIGHT`;
      case 'flights_between':
        return `${prefix}${timingValueText(v)} ${v === 1 ? 'FLIGHT' : 'FLIGHTS'} BETWEEN`;
      case 'qualitative':
        return 'IN WORDS';
    }
  })();
  return { basis: f.basis, value: f.value, bound: f.bound, label };
}

// ---------------------------------------------------------------------------
// Claims for the check stage (server templates for every structured value)

export const CLASSIFICATION_CLAIM: Readonly<Record<GlyphKind, string>> = {
  causal:
    'Investigators established that a mechanical fault (a failed, contaminated, misassembled or improperly maintained part or system of the aircraft) caused this event.',
  defect_not_causal: 'Investigators found a defect but did not establish that it caused this event.',
  no_fault: 'Investigators examined the aircraft and found no relevant mechanical fault.',
  insufficient:
    'The supplied passages of this case do not settle the mechanical evidence: they establish neither a mechanical fault that caused the event, nor a defect without an established causal link, nor an examination that found no relevant fault, or they conflict. This is about the supplied passages, not an NTSB finding.',
};

/** Classification claims about every supplied passage of the case (absence claims). */
const ABSENT_CLASSIFICATION: ReadonlySet<GlyphKind> = new Set(['insufficient']);

export const MAINTENANCE_CLAIM: Readonly<Record<Exclude<MaintenanceRelation, 'unknown'>, string>> = {
  investigator_attributed:
    'Investigators attributed a cause of, or a contribution to, this event to maintenance (work done on the aircraft, such as an inspection, repair, installation or overhaul).',
  preceding_not_established: 'Maintenance preceded this event, but investigators did not establish that it caused or contributed to it.',
  no_evidence: 'None of the supplied passages of this case mentions maintenance relevant to the event.',
};

export const SYMPTOM_CLAIM: Readonly<Record<Exclude<Symptom, 'other'>, string>> = {
  total_power_loss: 'The engine lost all power.',
  partial_power_loss: 'The engine lost partial power.',
  rough_running: 'The engine ran rough.',
  failure_to_climb: 'The aircraft could not climb.',
};

export const SPEAKER_CLAIM = {
  investigators: 'These words are the investigators’ own (examination, analysis, findings or probable cause), and they keep their meaning without the surrounding text:',
  pilot: 'These words report the pilot’s account, and they keep their meaning without the surrounding text:',
  witness: 'These words report a witness’s account, and they keep their meaning without the surrounding text:',
} as const;

/** Summary sentences (server/briefs/sentences.ts); markers stay with their sentence. */
export function summarySentences(summary: string): string[] {
  return splitSentences(summary);
}

const MARKER = /\[\[case:([A-Z0-9]+)\]\]/g;

/**
 * What the pipeline keeps about each claim, by index (claim `C<i+1>`): its kind and case,
 * the passages of the cases it is about (its verdict's evidence must come from them), and
 * for a criterion claim the criterion and decision (a contradicted `unknown` decision is
 * `chronology_missed`).
 */
export interface ClaimMeta {
  kind: ClaimKind;
  ntsbNo: string | null;
  absence: boolean;
  /** Every supplied passage of the cases the claim is about. */
  scope: string[];
  criterion?: Criterion;
  decision?: Decision;
}

/** The longest claim text the check stage takes (CheckInputSchema). */
const MAX_CLAIM_TEXT = 2_000;

export interface CheckOptions {
  mechanicalCause: boolean;
  /** The reader's criteria as server templates (server/briefs/criteria.ts `criteriaLines`). */
  criteria: string[];
  /** Per presented case, every criterion decision as a claim with its cited passages (`evaluateCase`). */
  criterionChecks: ReadonlyMap<string, readonly CriterionCheck[]>;
}

/**
 * The check stage's input for a validated composition. The passages are every verified
 * passage of each case a claim is about (a presented case, or a case a gap note is
 * about), so the checker can see contradicting evidence the composition did not quote.
 * Claims get server-issued ids `C1`.. in order. Each claim cites what it says it rests
 * on: a summary sentence the passages of the cases it marks; a `why` line its case's
 * quoted passages; a structured value its own passages; an attribution claim its quote's
 * passage; a criterion decision the facts that decided it. An **absence claim** (a
 * statement that something is not in the supplied passages: an insufficient
 * classification, no maintenance evidence, an unknown criterion decision, a gap note)
 * cites every supplied passage of its case, so its scope is explicit and complete; so
 * does a semantic criterion. `overflow`: some claim did not fit the input bounds; it
 * would go unchecked, so the caller must treat the check as inconclusive.
 */
export function checkInput(
  c: ComposeOutput,
  citations: readonly ResolvedCitation[],
  cases: ReadonlyMap<string, VerifiedCase>,
  opts: CheckOptions,
): { input: CheckInput; claims: ClaimMeta[]; overflow: boolean } {
  const all = (n: string) => (cases.get(n)?.passages ?? []).map((p) => p.passageId);
  const quoted = new Map<string, string[]>();
  for (const cit of citations) {
    const ids = quoted.get(cit.ntsbNo) ?? [];
    if (!ids.includes(cit.passageId)) ids.push(cit.passageId);
    quoted.set(cit.ntsbNo, ids);
  }
  const claims: CheckInput['claims'] = [];
  const meta: ClaimMeta[] = [];
  let overflow = false;
  const add = (
    kind: ClaimKind,
    about: readonly string[],
    text: string,
    passageIds: readonly string[],
    extra: { absence?: boolean; criterion?: Criterion; decision?: Decision } = {},
  ) => {
    const ids = [...new Set(passageIds)];
    if (ids.length === 0 || ids.length > 12 || claims.length >= MAX_CHECK_CLAIMS || text.length > MAX_CLAIM_TEXT) {
      overflow = true;
      return;
    }
    const ntsbNo = about.length === 1 ? about[0]! : null;
    const absence = extra.absence ?? false;
    claims.push({ id: `C${claims.length + 1}`, kind, ...(ntsbNo ? { ntsbNo } : {}), text, passageIds: ids, absence });
    meta.push({
      kind,
      ntsbNo,
      absence,
      scope: [...new Set(about.flatMap(all))],
      ...(extra.criterion ? { criterion: extra.criterion } : {}),
      ...(extra.decision ? { decision: extra.decision } : {}),
    });
  };
  const own = (ids: readonly string[], n: string) => (ids.length > 0 ? ids : all(n));

  for (const sentence of summarySentences(c.summary)) {
    const marked = [...new Set([...sentence.matchAll(MARKER)].map((m) => m[1]!))];
    add('summary', marked, sentence.replace(MARKER, (_, n: string) => `(${n})`), marked.flatMap(all));
  }
  const groupOf = new Map<string, GroupKind>();
  for (const g of c.groups) for (const n of g.caseNumbers) groupOf.set(n, g.kind);
  for (const k of c.cases) {
    const n = k.ntsbNo;
    add('why', [n], k.why, quoted.get(n) ?? all(n));
    const group = groupOf.get(n);
    if (opts.mechanicalCause && group && group !== 'examples') {
      const absent = ABSENT_CLASSIFICATION.has(group);
      add('classification', [n], CLASSIFICATION_CLAIM[group], absent ? all(n) : own(k.evidencePassageIds, n), { absence: absent });
    }
    if (opts.mechanicalCause && k.maintenance && k.maintenance.relation !== 'unknown') {
      const absent = k.maintenance.relation === 'no_evidence';
      add('maintenance', [n], MAINTENANCE_CLAIM[k.maintenance.relation], absent ? all(n) : own(k.maintenance.passageIds, n), { absence: absent });
    }
    if (opts.mechanicalCause && k.symptom && k.symptom.value !== 'other') add('symptom', [n], SYMPTOM_CLAIM[k.symptom.value], own(k.symptom.passageIds, n));
    for (const f of chronologyFacts(k.chronology)) add('timing', [n], f.claim, own(f.passageIds, n));
    for (const d of opts.criterionChecks.get(n) ?? []) {
      add('criterion', [n], d.claim, d.absence ? all(n) : own(d.passageIds, n), { absence: d.absence, criterion: d.criterion, decision: d.decision });
    }
  }
  for (const cit of citations) {
    const speaker = c.cases[cit.caseIndex]?.quotes[cit.quoteIndex]?.speaker ?? 'investigators';
    add('attribution', [cit.ntsbNo], `${SPEAKER_CLAIM[speaker]} “${cit.text}”`, [cit.passageId]);
  }
  // A gap note says what the case's supplied passages do not show: it is judged on all of them.
  for (const g of c.gaps) add('gap', [g.ntsbNo], g.note, all(g.ntsbNo).length > 0 ? all(g.ntsbNo) : g.passageIds, { absence: true });

  // Every verified passage of every case a claim is about, in bundle order.
  const about = new Set([...c.cases.map((k) => k.ntsbNo), ...c.gaps.map((g) => g.ntsbNo)]);
  for (const sentence of summarySentences(c.summary)) for (const m of sentence.matchAll(MARKER)) about.add(m[1]!);
  return { input: { criteria: opts.criteria.slice(0, 4), passages: checkPassages(cases.values(), about), claims }, claims: meta, overflow };
}

/** Every verified passage of the cases in `about`, in bundle order, as the check stage reads them (canonical ids). */
export function checkPassages(cases: Iterable<VerifiedCase>, about: ReadonlySet<string>): CheckInput['passages'] {
  const passages: CheckInput['passages'] = [];
  for (const vc of cases) {
    if (!about.has(vc.ntsbNo)) continue;
    for (const p of vc.passages) passages.push({ ...modelPassage(vc, p), ntsbNo: vc.ntsbNo });
  }
  return passages;
}

// ---------------------------------------------------------------------------
// Result

const EXCERPT_MAX = 600;

/** `text` cut to at most `max` code units at a word boundary, never inside a surrogate pair. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const space = text.lastIndexOf(' ', max);
  let at = space > max / 2 ? space : max;
  if (at > 0 && /[\uD800-\uDBFF]/.test(text[at - 1]!)) at -= 1;
  return text.slice(0, at).trimEnd();
}

/** The case's best retrieved passage, cut at a word boundary. */
export function excerptOf(c: VerifiedCase): NtsbExcerpt {
  const best =
    [...c.passages].filter((p) => p.reserved && p.rank !== null).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))[0] ??
    [...c.passages].filter((p) => p.rank !== null).sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))[0] ??
    c.passages[0]!;
  const text = best.allowed.text.trim();
  const cut = cutText(text, EXCERPT_MAX);
  return { passageId: best.passageId, section: best.allowed.sectionKind, text: cut, truncatedStart: false, truncatedEnd: cut.length < text.length };
}

/** A plain card: NTSB fields and an excerpt, no AI reading. */
export function plainCard(c: VerifiedCase): CaseCard {
  return { case: c.summary.row, report: c.summary.report, excerpt: excerptOf(c), reading: null };
}

/** Summary text as text segments and case citations; `unconfirmed`: cases a criterion is unconfirmed for. */
export function summarySegments(summary: string, unconfirmed: ReadonlySet<string> = new Set()): SummarySegment[] {
  const out: SummarySegment[] = [];
  let last = 0;
  for (const m of summary.matchAll(MARKER)) {
    const text = summary.slice(last, m.index);
    if (text.trim() !== '') out.push({ kind: 'text', text });
    out.push({ kind: 'case', ntsbNo: m[1]!, unconfirmed: unconfirmed.has(m[1]!) });
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
  /** Per presented case, its criteria decisions (none fails: that withholds the summary). */
  criteria: ReadonlyMap<string, CriterionDecision[]>;
}

/** Cases with an unconfirmed criterion: labelled on their card and on every summary citation. */
function unconfirmedCases(criteria: ReadonlyMap<string, CriterionDecision[]>): Set<string> {
  return new Set([...criteria].filter(([, ds]) => ds.some((d) => d.decision === 'unconfirmed')).map(([n]) => n));
}

function reading(k: ComposeCase, ci: number, a: AnswerInput, vc: VerifiedCase, group: GroupKind | undefined): CaseReading {
  const quotes = a.citations
    .filter((x) => x.caseIndex === ci)
    .map((cit) => {
      const p = vc.passages.find((x) => x.passageId === cit.passageId)!;
      return {
        passageId: cit.passageId,
        section: p.allowed.sectionKind,
        scope: p.allowed.scope,
        aircraftKey: p.allowed.aircraftKey,
        sectionId: cit.sectionId,
        revisionId: cit.revisionId,
        sectionRevision: cit.sectionSha,
        // Whole: validation bounds the resolved text (QUOTE_MAX_SOURCE), so nothing is cut.
        text: cit.text,
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
  return {
    glyph,
    why: k.why,
    timing: chronologyFacts(k.chronology).map(timingChip),
    quotes,
    evidence,
    criteria: a.criteria.get(k.ntsbNo) ?? [],
  };
}

const gapsOf = (c: ComposeOutput) => c.gaps.map((g) => ({ ntsbNo: g.ntsbNo, text: g.note, passageIds: [...g.passageIds] }));

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
    summary: summarySegments(c.summary, unconfirmedCases(a.criteria)),
    groups,
    cases: cards,
    gaps: gapsOf(c),
  };
}

/** The explicit abstention: the cases the answer model was given, as plain cards, with its checked gap notes. */
export function noMatchResult(
  c: ComposeOutput,
  cases: readonly VerifiedCase[],
  context: { interpretations: InterpretationChip[]; filters: BriefFilters },
): Extract<BriefResult, { kind: 'no_match' }> {
  return { kind: 'no_match', ...context, lines: [...NO_MATCH_LINES], cases: cases.map(plainCard), gaps: gapsOf(c) };
}

/**
 * Each presented case's structured claims with their own passages, for the case
 * context: its chronology facts (in chip order) and each criterion decision with the
 * passage set its claim cited, kept apart from the symptom and timing support.
 */
export function storedDimensions(
  c: ComposeOutput,
  mechanicalCause: boolean,
  criterionChecks: ReadonlyMap<string, readonly CriterionCheck[]>,
): StoredDimensions[] {
  return c.cases.map((k) => ({
    ntsbNo: k.ntsbNo,
    evidencePassageIds: [...k.evidencePassageIds],
    ...(mechanicalCause && k.maintenance ? { maintenance: { relation: k.maintenance.relation, passageIds: [...k.maintenance.passageIds] } } : {}),
    ...(mechanicalCause && k.symptom ? { symptom: { value: k.symptom.value, passageIds: [...k.symptom.passageIds] } } : {}),
    // In chip order: `timing[i]` is the passages of the reading's `timing[i]`.
    timing: chronologyFacts(k.chronology).map((f) => ({ basis: f.basis, passageIds: f.passageIds })),
    ...(k.chronology ? { relevantMaintenance: k.chronology.maintenance } : {}),
    criteria: (criterionChecks.get(k.ntsbNo) ?? []).map((x) => ({
      criterion: x.criterion,
      decision: x.decision === 'matches' ? ('matches' as const) : ('unconfirmed' as const),
      passageIds: [...x.passageIds],
    })),
  }));
}

/** What a finished step keeps for the case context: every verified passage of the bundle. */
export function storedEvidence(cases: Iterable<VerifiedCase>, ruleVersion: string | null, dimensions?: StoredDimensions[]): StoredEvidence {
  const passages: StoredPassage[] = [];
  for (const c of cases) {
    for (const p of c.passages) {
      passages.push({
        passageId: p.passageId,
        ntsbNo: c.ntsbNo,
        sectionKind: p.allowed.sectionKind,
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
  return { ruleVersion, passages, ...(dimensions ? { dimensions } : {}) };
}
