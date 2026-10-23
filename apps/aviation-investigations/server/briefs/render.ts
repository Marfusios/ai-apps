/**
 * What the brief pipeline builds from evidence and a validated composition, all from
 * server-owned fields and templates:
 * - the compose input (case headers from coded fields, passages after provenance, with
 *   section labels from the canonical passage rows);
 * - the check input (gate G6 #1, #5): every claim the reader would see as a claim with
 *   the passages it says it rests on (summary sentences, `why` lines, classifications,
 *   maintenance, symptom, each chronology fact, attribution, every criterion decision
 *   and gaps), every verified passage of each case those claims are about, and each of
 *   those cases' header line (server data, Task 16d); never the question, the reader's
 *   criteria, the planner's output or earlier answers;
 * - each claim's back-reference to the element it stands for and its stable key
 *   (`ClaimMeta.ref`, `ClaimMeta.key`), and the display plan the projection reads
 *   (`displayPlan`, server/briefs/display.ts);
 * - the briefing-sheet result (cards, groups, summary segments, chips, labels) rendered
 *   from the display projection's outcome only: what it removed is absent, with removal
 *   markers and counts; accepted quotes are shown whole, timing values exactly as
 *   checked, and cases whose criterion is unconfirmed (or not verified) flagged on their
 *   card and their summary citations;
 * - the evidence a finished step keeps for the case context, with each shown structured
 *   claim's own passages and each shown criterion's checked passage set.
 */
import { buildHeadline, aircraftName, placePhrase } from '../../shared/case-view.js';
import {
  GLYPH_KINDS,
  type BriefCheck,
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
import { conflictingFacts, maintenanceWords, ordinalVerified, type CaseEvidence, type CriterionCheck, type Decision } from './criteria.js';
import { DISPLAY_RULES_VERSION, countsCases, refersOutside, type DisplayOutcome, type DisplayPlan, type StaticAbstention } from './display.js';
import { textOrdinalsVerified } from './ordinals.js';
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
  /** The case's header line from coded fields (`caseHeader`): server data for the compose stage. */
  header: string;
  /**
   * The check stage's header (`checkHeader`): only the aircraft, place and date, so the
   * checker can verify how a claim names the case and nothing else (16c review M5).
   */
  checkHeader: string;
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
 * A verified case's supplied passages as the criteria read them: their ids, verified
 * scopes and canonical texts, and whether the event involved more than one aircraft
 * (timing rule A-2: a fact's attribution comes from the verified scope of the passages it
 * cites; rule O-1: a flight ordinal needs its evidence in those passages' text).
 */
export function caseEvidence(vc: Pick<VerifiedCase, 'passages' | 'summary'> | undefined): CaseEvidence {
  const passages = vc?.passages ?? [];
  return {
    passageIds: passages.map((p) => p.passageId),
    scopes: new Map(passages.map((p) => [p.passageId, { scope: p.allowed.scope, aircraftKey: p.allowed.aircraftKey }])),
    multiAircraft: (vc?.summary.row.aircraft.length ?? 0) > 1,
    texts: new Map(passages.map((p) => [p.passageId, p.allowed.text])),
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

/**
 * "Cessna 150M and Lockheed-Martin F-16CM, near Moncks Corner, South Carolina · 2015-07-07 ·
 * 2 aircraft": the check stage's server data about a case (Task 16d; 16c review M5): the
 * aircraft, the place and the date from coded fields, without the defining event or phase
 * the compose header names, which a claim must take from the passages.
 */
export function checkHeader(s: CaseSummary): string {
  const r = s.row;
  const names = r.aircraft.map((a) => aircraftName(a));
  const place = placePhrase(r.city, r.state.code);
  const count = r.aircraft.length > 1 ? ` · ${r.aircraft.length} aircraft` : '';
  return `${names.join(' and ')}${place ? `, ${place}` : ''}${r.date ? ` · ${r.date}` : ''}${count}`.slice(0, 400);
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
    cases: cases.map((c) => ({ ntsbNo: c.ntsbNo, header: c.header, passages: c.passages.map((p) => modelPassage(c, p)) })),
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
  /** Its index in the composition's `chronology.facts` (its identity; chips are reordered). */
  fact: number;
}

/** Display order of the relations. */
const RELATION_ORDER: readonly ChronologyRelation[] = [
  'flight_hours',
  'operating_hours',
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

/**
 * One relevant fact as its chip basis, value and checker claim; null when its parts are
 * inconsistent (validation refuses those first). A template asserts flight hours only for
 * `flight_hours`, the relation compose.v7 keeps for hours a passage calls flight hours.
 */
function factView(f: ComposeChronologyFact, m: string, fact: number): ChronologyFact | null {
  const ids = [...f.passageIds];
  const v = f.value;
  const b = f.bound ?? 'exact';
  const capital = `${m.charAt(0).toUpperCase()}${m.slice(1)}`;
  switch (f.relation) {
    case 'flight_hours':
    case 'calendar_days': {
      if (v === undefined || f.bound === undefined) return null;
      const unit = f.relation === 'flight_hours' ? plural(v, 'flight hour', 'flight hours') : plural(v, 'calendar day', 'calendar days');
      return { basis: f.relation, value: v, bound: b, claim: `The event happened ${BOUND_WORD[b]}${timingValueText(v)} ${unit} after ${m}.`, passageIds: ids, fact };
    }
    case 'operating_hours': {
      if (v === undefined || f.bound === undefined) return null;
      return {
        basis: 'operating_hours',
        value: v,
        bound: b,
        claim: `A supplied passage puts the event ${BOUND_WORD[b]}${timingValueText(v)} ${plural(v, 'hour', 'hours')} after ${m}, without calling them flight hours.`,
        passageIds: ids,
        fact,
      };
    }
    case 'same_day':
      return { basis: 'same_day', value: null, bound: 'exact', claim: `${capital} was done on the same calendar day as the event.`, passageIds: ids, fact };
    case 'previous_day':
      return { basis: 'previous_day', value: null, bound: 'exact', claim: `${capital} was done on the calendar day before the event.`, passageIds: ids, fact };
    case 'immediately_before':
      return { basis: 'immediately_before', value: null, bound: 'exact', claim: `${capital} was completed immediately before the flight on which the event happened.`, passageIds: ids, fact };
    case 'flight_ordinal':
      if (v === undefined || !Number.isInteger(v) || v < 1) return null;
      return {
        basis: v === 1 ? 'first_flight' : 'subsequent_flight',
        value: v,
        bound: 'exact',
        claim: `The event happened on the ${ordinalWord(v)} flight after ${m}.`,
        passageIds: ids,
        fact,
      };
    case 'intervening_flights': {
      if (v === undefined || f.bound === undefined) return null;
      const count = v === 0 && b === 'exact' ? 'No completed flight' : `${capitalWord(BOUND_WORD[b])}${timingValueText(v)} completed ${plural(v, 'flight', 'flights')}`;
      return { basis: 'flights_between', value: v, bound: b, claim: `${count} came between ${m} and the flight on which the event happened.`, passageIds: ids, fact };
    }
    case 'words':
      return { basis: 'qualitative', value: null, bound: 'exact', claim: `A supplied passage describes the time between ${m} and the event in words, without a number.`, passageIds: ids, fact };
  }
}

const capitalWord = (s: string) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s);

/**
 * The case's displayed chronology facts (from its relevant maintenance) in display order:
 * flight hours, operating hours, calendar days, the same or the previous day, immediately
 * before, which flight, flights in between, words. Each keeps its index in the
 * composition's facts (`fact`).
 */
export function chronologyFacts(c: Chronology | undefined): ChronologyFact[] {
  if (!c) return [];
  const m = maintenanceWords(c);
  const indexed = c.facts.map((f, i) => ({ f, i }));
  return RELATION_ORDER.flatMap((relation) =>
    indexed.filter(({ f }) => f.anchor === 'relevant_maintenance' && f.relation === relation).flatMap(({ f, i }) => factView(f, m, i) ?? []),
  );
}

const BOUND_PREFIX = { exact: '', about: '≈ ', at_most: '≤ ', at_least: '≥ ' } as const;

/** "5.1 FH", "≈ 198 H", "≤ 17 DAYS", "SAME DAY", "PREVIOUS DAY", "IMMEDIATELY BEFORE", "1ST FLIGHT", "3RD FLIGHT", "0 FLIGHTS BETWEEN", "IN WORDS". */
export function timingChip(f: Pick<ChronologyFact, 'basis' | 'value' | 'bound'>): TimingChip {
  const v = f.value ?? 0;
  const prefix = BOUND_PREFIX[f.bound];
  const label = (() => {
    switch (f.basis) {
      case 'flight_hours':
        return `${prefix}${timingValueText(v)} FH`;
      case 'operating_hours':
        return `${prefix}${timingValueText(v)} H`;
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

/** The cases a summary sentence cites, in order, once each. */
export function sentenceCases(sentence: string): string[] {
  return [...new Set([...sentence.matchAll(MARKER)].map((m) => m[1]!))];
}

/**
 * The composition element a claim stands for (Task 16d; 16c review §10): a summary
 * sentence, a field of a presented case (by its index in `composition.cases`), one timing
 * fact (`fact`: its index in the case's `chronology.facts`; `chip`: its position among the
 * chips), a criterion decision, one quote (`quote`: its index in the case's quotes;
 * `citation`: its index in the resolved citations) or a gap note.
 */
export type ClaimRef =
  | { kind: 'summary'; sentence: number }
  | { kind: 'why' | 'classification' | 'maintenance' | 'symptom'; case: number }
  | { kind: 'timing'; case: number; fact: number; chip: number }
  | { kind: 'criterion'; case: number; criterion: Criterion }
  | { kind: 'attribution'; case: number; quote: number; citation: number }
  | { kind: 'gap'; gap: number };

/**
 * A claim's stable key (`display-deps-v1`): `summary.<i>`, `case.<ntsbNo>.why`,
 * `.classification`, `.maintenance`, `.symptom`, `.timing.<fact>`, `.criterion.<criterion>`,
 * `.quote.<quote>`, or `gap.<g>`. Content-free (case numbers are public).
 */
export function claimKey(ref: ClaimRef, ntsbNo: string | null): string {
  switch (ref.kind) {
    case 'summary':
      return `summary.${ref.sentence}`;
    case 'gap':
      return `gap.${ref.gap}`;
    case 'timing':
      return `case.${ntsbNo}.timing.${ref.fact}`;
    case 'criterion':
      return `case.${ntsbNo}.criterion.${ref.criterion}`;
    case 'attribution':
      return `case.${ntsbNo}.quote.${ref.quote}`;
    default:
      return `case.${ntsbNo}.${ref.kind}`;
  }
}

/**
 * What the pipeline keeps about each claim, by index (claim `C<i+1>`): its kind and case,
 * the passages of the cases it is about (its verdict's evidence must come from them), for
 * a criterion claim the criterion and decision (a contradicted `unknown` decision is
 * `chronology_missed`), and its back-reference and stable key for the display projection.
 */
export interface ClaimMeta {
  kind: ClaimKind;
  ntsbNo: string | null;
  absence: boolean;
  /** Every supplied passage of the cases the claim is about. */
  scope: string[];
  criterion?: Criterion;
  decision?: Decision;
  /** The element it stands for. */
  ref: ClaimRef;
  /** Stable display key (`claimKey`). */
  key: string;
  /** The cases it is about: a summary sentence's markers, otherwise its case. */
  cases: string[];
}

/** The longest claim text the check stage takes (CheckInputSchema). */
const MAX_CLAIM_TEXT = 2_000;

export interface CheckOptions {
  mechanicalCause: boolean;
  /** Per presented case, every criterion decision as a claim with its cited passages (`evaluateCase`). */
  criterionChecks: ReadonlyMap<string, readonly CriterionCheck[]>;
}

/**
 * The check stage's input for a validated composition. The passages are every verified
 * passage of each case a claim is about (a presented case, or a case a gap note is
 * about), so the checker can see contradicting evidence the composition did not quote,
 * and each of those cases' header line is server data. Claims get server-issued ids
 * `C1`.. in order. Each claim cites what it says it rests on: a summary sentence the
 * passages of the cases it marks; a `why` line its case's quoted passages; a structured
 * value its own passages; an attribution claim its quote's passage; a criterion decision
 * the facts that decided it. An **absence claim** (a statement that something is not in
 * the supplied passages: an insufficient classification, no maintenance evidence, an
 * unknown criterion decision, a gap note) cites every supplied passage of its case, so its
 * scope is explicit and complete; so does a semantic criterion. `overflow`: some claim did
 * not fit the input bounds; it would go unchecked, so the caller must treat the check as
 * inconclusive. The reader's criteria are not in the input: each criterion claim states
 * its own (Task 16d).
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
    ref: ClaimRef,
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
      ref,
      key: claimKey(ref, kind === 'summary' || kind === 'gap' ? null : ntsbNo),
      cases: [...about],
    });
  };
  const own = (ids: readonly string[], n: string) => (ids.length > 0 ? ids : all(n));

  summarySentences(c.summary).forEach((sentence, si) => {
    const marked = sentenceCases(sentence);
    add('summary', { kind: 'summary', sentence: si }, marked, sentence.replace(MARKER, (_, n: string) => `(${n})`), marked.flatMap(all));
  });
  const groupOf = new Map<string, GroupKind>();
  for (const g of c.groups) for (const n of g.caseNumbers) groupOf.set(n, g.kind);
  c.cases.forEach((k, ci) => {
    const n = k.ntsbNo;
    add('why', { kind: 'why', case: ci }, [n], k.why, quoted.get(n) ?? all(n));
    const group = groupOf.get(n);
    if (opts.mechanicalCause && group && group !== 'examples') {
      const absent = ABSENT_CLASSIFICATION.has(group);
      add('classification', { kind: 'classification', case: ci }, [n], CLASSIFICATION_CLAIM[group], absent ? all(n) : own(k.evidencePassageIds, n), { absence: absent });
    }
    if (opts.mechanicalCause && k.maintenance && k.maintenance.relation !== 'unknown') {
      const absent = k.maintenance.relation === 'no_evidence';
      add('maintenance', { kind: 'maintenance', case: ci }, [n], MAINTENANCE_CLAIM[k.maintenance.relation], absent ? all(n) : own(k.maintenance.passageIds, n), {
        absence: absent,
      });
    }
    if (opts.mechanicalCause && k.symptom && k.symptom.value !== 'other') {
      add('symptom', { kind: 'symptom', case: ci }, [n], SYMPTOM_CLAIM[k.symptom.value], own(k.symptom.passageIds, n));
    }
    chronologyFacts(k.chronology).forEach((f, chip) => add('timing', { kind: 'timing', case: ci, fact: f.fact, chip }, [n], f.claim, own(f.passageIds, n)));
    for (const d of opts.criterionChecks.get(n) ?? []) {
      add('criterion', { kind: 'criterion', case: ci, criterion: d.criterion }, [n], d.claim, d.absence ? all(n) : own(d.passageIds, n), {
        absence: d.absence,
        criterion: d.criterion,
        decision: d.decision,
      });
    }
  });
  citations.forEach((cit, ix) => {
    const speaker = c.cases[cit.caseIndex]?.quotes[cit.quoteIndex]?.speaker ?? 'investigators';
    add('attribution', { kind: 'attribution', case: cit.caseIndex, quote: cit.quoteIndex, citation: ix }, [cit.ntsbNo], `${SPEAKER_CLAIM[speaker]} “${cit.text}”`, [
      cit.passageId,
    ]);
  });
  // A gap note says what the case's supplied passages do not show: it is judged on all of them.
  c.gaps.forEach((g, gi) => add('gap', { kind: 'gap', gap: gi }, [g.ntsbNo], g.note, all(g.ntsbNo).length > 0 ? all(g.ntsbNo) : g.passageIds, { absence: true }));

  // Every verified passage of every case a claim is about, in bundle order, with its header.
  const about = new Set([...c.cases.map((k) => k.ntsbNo), ...c.gaps.map((g) => g.ntsbNo)]);
  for (const sentence of summarySentences(c.summary)) for (const n of sentenceCases(sentence)) about.add(n);
  return { input: { cases: checkCases(cases.values(), about), passages: checkPassages(cases.values(), about), claims }, claims: meta, overflow };
}

/** The header lines of the cases in `about`, in bundle order (server data for the check stage). */
export function checkCases(cases: Iterable<VerifiedCase>, about: ReadonlySet<string>): CheckInput['cases'] {
  return [...cases].filter((vc) => about.has(vc.ntsbNo)).map((vc) => ({ ntsbNo: vc.ntsbNo, header: vc.checkHeader }));
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

/**
 * The claims of a validated composition that a deterministic rule never shows, whatever
 * the checker says (Task 16e; server/briefs/display.ts "Static abstentions"), by stable key:
 * - `excerpt_context`: a quote the excerpt-context policy found to need its surrounding
 *   text (`ResolvedCitation.excerpt`, `excerpt-context-v1`);
 * - `ordinal_evidence` (`ordinal-evidence-v2`): a timing fact stating which flight it was,
 *   or how many flights came in between, without explicit evidence in the passages it
 *   cites; and a summary sentence, `why` line or gap note stating a flight ordinal without
 *   explicit evidence in the passages it cites (the check input's citations: canonical ids).
 * `input` and `claims` are `checkInput`'s, in canonical passage ids.
 */
export function staticAbstentions(
  c: ComposeOutput,
  citations: readonly ResolvedCitation[],
  cases: ReadonlyMap<string, VerifiedCase>,
  input: Pick<CheckInput, 'claims'>,
  claims: readonly ClaimMeta[],
): Map<string, StaticAbstention> {
  const texts = new Map([...cases.values()].flatMap((vc) => vc.passages.map((p): [string, string] => [p.passageId, p.allowed.text])));
  const out = new Map<string, StaticAbstention>();
  claims.forEach((m, i) => {
    const claim = input.claims[i]!;
    const ref = m.ref;
    if (ref.kind === 'attribution') {
      if ((citations[ref.citation]?.excerpt.problems.length ?? 0) > 0) out.set(m.key, 'excerpt_context');
    } else if (ref.kind === 'timing') {
      const k = c.cases[ref.case];
      const f = k?.chronology?.facts[ref.fact];
      if (k && f && !ordinalVerified(f, caseEvidence(cases.get(k.ntsbNo)))) out.set(m.key, 'ordinal_evidence');
    } else if (ref.kind === 'summary' || ref.kind === 'why' || ref.kind === 'gap') {
      const cited = claim.passageIds.flatMap((id) => (texts.has(id) ? [texts.get(id)!] : []));
      if (!textOrdinalsVerified(claim.text, cited)) out.set(m.key, 'ordinal_evidence');
    }
  });
  return out;
}

/**
 * The display plan of a validated composition and the claims `checkInput` rendered from
 * it (server/briefs/display.ts): every claim's stable key, kind and cases, each criterion
 * claim's decision, the static abstentions (`staticAbstentions`), the presented cases and
 * whether a classification claim carries their group, each summary sentence's cases and
 * reference flags (`refersOutside`, `countsCases`), and each case's conflicting timing
 * facts, which are shown together or not at all (`conflictingFacts`).
 */
export function displayPlan(
  c: ComposeOutput,
  claims: readonly ClaimMeta[],
  mechanicalCause: boolean,
  opts: { abstain?: ReadonlyMap<string, StaticAbstention>; cases?: ReadonlyMap<string, VerifiedCase> } = {},
): DisplayPlan {
  const groupOf = new Map<string, GroupKind>();
  for (const g of c.groups) for (const n of g.caseNumbers) groupOf.set(n, g.kind);
  const keys = new Set(claims.map((m) => m.key));
  const together = c.cases.flatMap((k) =>
    conflictingFacts(k.chronology, caseEvidence(opts.cases?.get(k.ntsbNo)))
      .map((facts) => facts.map((f) => `case.${k.ntsbNo}.timing.${f}`).filter((key) => keys.has(key)))
      .filter((g) => g.length > 1),
  );
  return {
    rules: DISPLAY_RULES_VERSION,
    shape: c.outcome === 'answer' ? 'answer' : 'abstention',
    grouping: c.outcome === 'answer' ? (mechanicalCause ? 'mechanical' : 'examples') : null,
    cases: c.cases.map((k) => {
      const g = groupOf.get(k.ntsbNo);
      return { ntsbNo: k.ntsbNo, classified: mechanicalCause && g !== undefined && g !== 'examples' };
    }),
    sentences: summarySentences(c.summary).map((s) => ({ cases: sentenceCases(s), reference: refersOutside(s), set: countsCases(s) })),
    claims: claims.map((m) => ({
      key: m.key,
      kind: m.kind,
      cases: [...m.cases],
      ...(m.criterion ? { criterion: m.criterion } : {}),
      ...(m.decision ? { decision: m.decision } : {}),
      ...(opts.abstain?.has(m.key) ? { abstain: opts.abstain.get(m.key)! } : {}),
    })),
    together,
  };
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

/**
 * The shown summary: the sentences the projection kept, whole and in order, each run of
 * removed sentences replaced by one `removed` marker with its count (no text replaces
 * them).
 */
export function displayedSummary(sentences: readonly string[], shown: readonly boolean[], unconfirmed: ReadonlySet<string>): SummarySegment[] {
  const out: SummarySegment[] = [];
  let run: string[] = [];
  let removed = 0;
  const flushText = () => {
    if (run.length > 0) out.push(...summarySegments(run.join(' '), unconfirmed));
    run = [];
  };
  const flushRemoved = () => {
    if (removed > 0) out.push({ kind: 'removed', count: removed });
    removed = 0;
  };
  sentences.forEach((s, i) => {
    if (shown[i]) {
      flushRemoved();
      run.push(s);
    } else {
      flushText();
      removed += 1;
    }
  });
  flushText();
  flushRemoved();
  return out;
}

export interface AnswerInput {
  composition: ComposeOutput;
  citations: readonly ResolvedCitation[];
  cases: ReadonlyMap<string, VerifiedCase>;
  mechanicalCause: boolean;
  interpretations: InterpretationChip[];
  filters: BriefFilters;
  /** The claims `checkInput` rendered (by check index) and what the projection shows of them. */
  claims: readonly ClaimMeta[];
  display: DisplayOutcome;
}

/** The result's partial-check record (counts only). */
function checkRecord(d: DisplayOutcome): BriefCheck {
  const r = d.counts.removed;
  const omitted = { excerpts: d.counts.abstained.excerpt_context, ordinals: d.counts.abstained.ordinal_evidence };
  return {
    rules: DISPLAY_RULES_VERSION,
    status: 'partially_checked',
    shown: d.counts.shown,
    ...(omitted.excerpts + omitted.ordinals > 0 ? { omitted } : {}),
    removed: {
      summary: r.summary,
      why: r.why,
      classification: r.classification,
      maintenance: r.maintenance,
      symptom: r.symptom,
      timing: r.timing,
      attribution: r.attribution,
      criterion: r.criterion,
      gap: r.gap,
    },
    unclassified: d.cases.filter((c) => c.reading && !c.grouped).map((c) => c.ntsbNo),
  };
}

/** The shown keys of a projection. */
const shownKeys = (claims: readonly ClaimMeta[], d: DisplayOutcome) => new Set(claims.flatMap((m, i) => (d.displayed[i] ? [m.key] : [])));

function reading(k: ComposeCase, ci: number, a: AnswerInput, vc: VerifiedCase, group: GroupKind | undefined, shown: ReadonlySet<string>): CaseReading {
  const d = a.display.cases.find((x) => x.ntsbNo === k.ntsbNo)!;
  const quotes = a.citations
    .filter((x) => x.caseIndex === ci && shown.has(`case.${k.ntsbNo}.quote.${x.quoteIndex}`))
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
  // Ambiguous attribution in a multi-aircraft event: no glyph (UI_DESIGN §4.3). A removed group placement: none either.
  const glyph =
    a.mechanicalCause && d.grouped && group && group !== 'examples' && !(evidence.scope === 'event' && multiAircraft) ? (group as GlyphKind) : null;
  return {
    glyph,
    why: k.why,
    timing: chronologyFacts(k.chronology)
      .filter((f) => shown.has(`case.${k.ntsbNo}.timing.${f.fact}`))
      .map(timingChip),
    quotes,
    evidence,
    criteria: d.decisions.map((x) => ({ criterion: x.criterion, decision: x.decision, ...(x.notVerified ? { notVerified: true as const } : {}) })),
  };
}

const gapsOf = (c: ComposeOutput, shown: ReadonlySet<string>) =>
  c.gaps.flatMap((g, gi) => (shown.has(`gap.${gi}`) ? [{ ntsbNo: g.ntsbNo, text: g.note, passageIds: [...g.passageIds] }] : []));

/**
 * The answer as the projection shows it (it must be shown: `display.shown`). Cards,
 * groups, summary citations, criteria labels and gap notes all come from the projection's
 * outcome, never from the composition or the pre-check decisions alone.
 */
export function answerResult(a: AnswerInput): Extract<BriefResult, { kind: 'answer' }> {
  if (!a.display.shown) throw new Error('answerResult needs a shown projection');
  const c = a.composition;
  const shown = shownKeys(a.claims, a.display);
  const groupOf = new Map<string, GroupKind>();
  for (const g of c.groups) for (const n of g.caseNumbers) groupOf.set(n, g.kind);
  const byCase = new Map(a.display.cases.map((d) => [d.ntsbNo, d]));
  const cards: CaseCard[] = c.cases.map((k, ci) => {
    const vc = a.cases.get(k.ntsbNo)!;
    const d = byCase.get(k.ntsbNo)!;
    const notVerified = d.removed.length > 0 ? { notVerified: [...d.removed] } : {};
    const omitted = d.excerptsOmitted > 0 ? { quotesOmitted: d.excerptsOmitted } : {};
    return { ...plainCard(vc), reading: d.reading ? reading(k, ci, a, vc, groupOf.get(k.ntsbNo), shown) : null, ...notVerified, ...omitted };
  });
  const grouped = (n: string) => byCase.get(n)?.grouped === true;
  const groups = a.mechanicalCause
    ? GLYPH_KINDS.map((kind) => ({ kind, caseNumbers: (c.groups.find((g) => g.kind === kind)?.caseNumbers ?? []).filter(grouped) }))
    : [{ kind: 'examples' as const, caseNumbers: c.cases.map((k) => k.ntsbNo).filter(grouped) }];
  // Cases flagged unconfirmed: any decision the projection shows as unconfirmed (never the pre-check state).
  const unconfirmed = new Set(a.display.cases.filter((d) => d.decisions.some((x) => x.decision === 'unconfirmed')).map((d) => d.ntsbNo));
  return {
    kind: 'answer',
    interpretations: a.interpretations,
    filters: a.filters,
    grouping: a.mechanicalCause ? 'mechanical' : 'examples',
    summary: displayedSummary(summarySentences(c.summary), a.display.sentences, unconfirmed),
    groups,
    cases: cards,
    gaps: gapsOf(c, shown),
    check: checkRecord(a.display),
  };
}

/**
 * The explicit abstention: the cases the answer model was given, as plain cards, with its
 * gap notes as the projection shows them (`display`; omitted for an abstention with
 * nothing to check).
 */
export function noMatchResult(
  c: ComposeOutput,
  cases: readonly VerifiedCase[],
  context: { interpretations: InterpretationChip[]; filters: BriefFilters },
  checked?: { claims: readonly ClaimMeta[]; display: DisplayOutcome },
): Extract<BriefResult, { kind: 'no_match' }> {
  const shown = checked ? shownKeys(checked.claims, checked.display) : new Set(c.gaps.map((_, gi) => `gap.${gi}`));
  return {
    kind: 'no_match',
    ...context,
    lines: [...NO_MATCH_LINES],
    cases: cases.map(plainCard),
    gaps: gapsOf(c, shown),
    ...(checked ? { check: checkRecord(checked.display) } : {}),
  };
}

/**
 * Each presented case's shown structured claims with their own passages, for the case
 * context: its shown chronology facts (in chip order, aligned with the reading's chips),
 * maintenance and symptom when shown, the group's evidence passages when the group is
 * shown, and each criterion decision as the projection shows it with the passage set its
 * claim cited. A case without a shown reading keeps nothing.
 */
export function storedDimensions(
  c: ComposeOutput,
  mechanicalCause: boolean,
  criterionChecks: ReadonlyMap<string, readonly CriterionCheck[]>,
  checked: { claims: readonly ClaimMeta[]; display: DisplayOutcome },
): StoredDimensions[] {
  const shown = shownKeys(checked.claims, checked.display);
  const byCase = new Map(checked.display.cases.map((d) => [d.ntsbNo, d]));
  return c.cases.flatMap((k) => {
    const d = byCase.get(k.ntsbNo);
    if (!d?.reading) return [];
    const has = (field: string) => shown.has(`case.${k.ntsbNo}.${field}`);
    const timing = chronologyFacts(k.chronology).filter((f) => has(`timing.${f.fact}`));
    const criteria = (criterionChecks.get(k.ntsbNo) ?? []).flatMap((x) => {
      const shownDecision = d.decisions.find((y) => y.criterion === x.criterion);
      return shownDecision ? [{ criterion: x.criterion, decision: shownDecision.decision, passageIds: [...x.passageIds] }] : [];
    });
    const anchored = timing.length > 0 || (criterionChecks.get(k.ntsbNo) ?? []).some((x) => x.criterion !== 'failure_type' && has(`criterion.${x.criterion}`));
    return [
      {
        ntsbNo: k.ntsbNo,
        evidencePassageIds: d.grouped ? [...k.evidencePassageIds] : [],
        ...(mechanicalCause && k.maintenance && has('maintenance') ? { maintenance: { relation: k.maintenance.relation, passageIds: [...k.maintenance.passageIds] } } : {}),
        ...(mechanicalCause && k.symptom && has('symptom') ? { symptom: { value: k.symptom.value, passageIds: [...k.symptom.passageIds] } } : {}),
        // In chip order: `timing[i]` is the passages of the reading's `timing[i]`.
        timing: timing.map((f) => ({ basis: f.basis, passageIds: f.passageIds })),
        ...(k.chronology && anchored ? { relevantMaintenance: k.chronology.maintenance } : {}),
        criteria,
      },
    ];
  });
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
