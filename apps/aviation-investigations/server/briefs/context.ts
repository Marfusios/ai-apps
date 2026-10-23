/**
 * The brief's AI context for one case (UI_DESIGN §4.5, "WHY IT'S IN YOUR RESULTS" and
 * "CITED PASSAGE"), read by its read owner through
 * `GET /api/briefs/:id/steps/:n/cases/:ntsbNo`. It comes entirely from what the finished
 * step stored: the validated reading of the case, the passages it was checked against
 * (with the quote spans to highlight), its gap notes, and labelled lines from server
 * templates. Each line links to the passages its own claim was checked on (gate G6 #5),
 * never just the first quote: a TIMING line its fact's passages, a CRITERIA line the
 * passage set its criterion claim cited (G6 #3). A case on the sheet or a case a gap
 * note is about has a context; a withheld step returns the NTSB passages with no
 * reading. Everything here was stored after the display projection (Task 16d): a
 * statement the check could not confirm is absent, and the card's not-verified fields and
 * decisions get a "not verified" line that describes the checking outcome, never the
 * evidence.
 */
import {
  FAILURE_TYPE_LABELS,
  type CardStatementKind,
  type CaseContextResponse,
  type CaseReading,
  type CriterionDecision,
  type GlyphKind,
  type MaintenanceRelation,
  type Symptom,
  type TimingChip,
} from '../../shared/contracts/briefs.js';
import { ordinalWord, timingValueText } from './render.js';
import type { StepRow, StoredDimensions } from './store.js';

const EVIDENCE_LINE: Readonly<Record<GlyphKind, string>> = {
  causal: 'Causal fault established in the investigation',
  defect_not_causal: 'Defect found; causal link not established',
  no_fault: 'No relevant fault identified',
  insufficient: 'The supplied passages do not settle the mechanical evidence',
};

const MAINTENANCE_LINE: Readonly<Record<Exclude<MaintenanceRelation, 'unknown'>, string>> = {
  investigator_attributed: 'Investigators attributed a contribution to maintenance',
  preceding_not_established: 'Maintenance came first; a causal link was not established',
  no_evidence: 'No relevant maintenance in the supplied passages',
};

/**
 * The SYMPTOM line says the symptom in the same words as the failure-type chip and
 * reading (the contract's one table), so a label edited there changes both. `other` has
 * no line; the type fails to compile if a symptom is added without a label.
 */
const SYMPTOM_LINE: Readonly<Record<Exclude<Symptom, 'other'>, string>> = FAILURE_TYPE_LABELS;

/**
 * Definite wording only for a decision the facts settle under the timing rules (an
 * approximate value never matches: server/briefs/criteria.ts); an unconfirmed one says
 * so first, and says this analysis could not establish it from the supplied passages,
 * never that the investigation has no such information.
 */
export const CRITERION_LINE: Readonly<Record<CriterionDecision['criterion'], Record<CriterionDecision['decision'], string>>> = {
  timing_window: {
    matches: 'Within your timing window',
    unconfirmed: 'Unconfirmed: this analysis could not establish your timing window from the supplied passages',
  },
  first_flight_only: {
    matches: 'On the first flight after maintenance, as asked',
    unconfirmed: 'Unconfirmed: this analysis could not establish the first flight from the supplied passages',
  },
  failure_type: {
    matches: 'The failure you asked about',
    unconfirmed: 'Unconfirmed: this analysis could not establish the failure type from the supplied passages',
  },
};

/**
 * A statement the check could not confirm (Task 16d): it describes the checking outcome,
 * never the NTSB evidence (the passages may well show it).
 */
export const NOT_VERIFIED_LINE = 'Not verified: the check could not confirm this against the cited passages';

/**
 * A case of an answer shown without its reading (Task 16e): the check could not confirm
 * its minimum content (a why line and a quote), or a rule left its quotes out.
 */
export const READING_NOT_SHOWN_LINE = 'AI reading not shown: the check could not confirm it against the cited passages';

/** Quotes the excerpt-context rule left out (Task 16e; `quotesOmitted`), by count. */
export function quotesOmittedLine(n: number): string {
  return n === 1
    ? 'One quote left out: it needs the report’s surrounding text to keep its meaning'
    : `${n} quotes left out: they need the report’s surrounding text to keep their meaning`;
}

/** The context line of each kind of removed card statement that has one (`notVerified`). */
const NOT_VERIFIED_LABEL: Partial<Record<CardStatementKind, CaseContextResponse['lines'][number]['label']>> = {
  classification: 'EVIDENCE',
  maintenance: 'MAINTENANCE',
  symptom: 'SYMPTOM',
  timing: 'TIMING',
  attribution: 'QUOTES',
};

/** "the maintenance (the annual inspection)": the relevant maintenance a TIMING line is about. */
const maintenanceLabel = (m: string | undefined) => (m ? `the maintenance (${m})` : 'the maintenance');

export function timingLine(t: TimingChip, maintenance?: string): string {
  const bound = { exact: '', about: 'About ', at_most: 'At most ', at_least: 'At least ' }[t.bound];
  const v = t.value === null ? '' : timingValueText(t.value);
  const m = maintenanceLabel(maintenance);
  const line = (() => {
    switch (t.basis) {
      case 'flight_hours':
        return `${bound}${v} flight ${t.value === 1 ? 'hour' : 'hours'} after ${m}`;
      case 'operating_hours':
        return `${bound}${v} ${t.value === 1 ? 'hour' : 'hours'} after ${m}, not stated as flight hours`;
      case 'calendar_days':
        return `${bound}${v} calendar ${t.value === 1 ? 'day' : 'days'} after ${m}`;
      case 'same_day':
        return `On the same calendar day as ${m}`;
      case 'previous_day':
        return `On the calendar day after ${m}`;
      case 'immediately_before':
        return `On the flight that began immediately after ${m}`;
      case 'first_flight':
        return `On the first flight after ${m}`;
      case 'subsequent_flight':
        return `On the ${ordinalWord(t.value ?? 2)} flight after ${m}`;
      case 'flights_between':
        return t.value === 0 && t.bound === 'exact'
          ? `No completed flight between ${m} and the event flight`
          : `${bound}${v} completed ${t.value === 1 ? 'flight' : 'flights'} between ${m} and the event flight`;
      case 'qualitative':
        return `Time since ${m} described in words`;
    }
  })();
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
}

/**
 * WHY IT'S IN YOUR RESULTS: labelled lines from server templates, each with the passages
 * its claim was checked on (empty for a statement about what the passages lack), then a
 * "not verified" line for each kind of statement the projection removed (`notVerified`).
 */
export function readingLines(
  reading: CaseReading,
  dims: StoredDimensions | undefined,
  notVerified: readonly CardStatementKind[] = [],
  quotesOmitted = 0,
): CaseContextResponse['lines'] {
  const lines: CaseContextResponse['lines'] = [];
  if (reading.glyph) lines.push({ label: 'EVIDENCE', text: EVIDENCE_LINE[reading.glyph], passageIds: dims?.evidencePassageIds ?? [] });
  if (dims?.maintenance && dims.maintenance.relation !== 'unknown') {
    lines.push({ label: 'MAINTENANCE', text: MAINTENANCE_LINE[dims.maintenance.relation], passageIds: dims.maintenance.passageIds });
  }
  if (dims?.symptom && dims.symptom.value !== 'other') {
    lines.push({ label: 'SYMPTOM', text: SYMPTOM_LINE[dims.symptom.value], passageIds: dims.symptom.passageIds });
  }
  reading.timing.forEach((t, i) => {
    // `dims.timing` is in chip order: each line links the passages of its own fact.
    const own = dims?.timing?.[i];
    lines.push({ label: 'TIMING', text: timingLine(t, dims?.relevantMaintenance), passageIds: own && own.basis === t.basis ? own.passageIds : [] });
  });
  for (const c of reading.criteria) {
    // The passage set the criterion's own claim cited, never the symptom's or timing's.
    const passageIds = dims?.criteria?.find((x) => x.criterion === c.criterion)?.passageIds ?? [];
    lines.push({ label: 'CRITERIA', text: c.notVerified ? NOT_VERIFIED_LINE : CRITERION_LINE[c.criterion][c.decision], passageIds: c.notVerified ? [] : passageIds });
  }
  const account = reading.quotes.find((q) => q.speaker !== 'investigators');
  if (account) {
    lines.push({
      label: 'ACCOUNT',
      text: account.speaker === 'pilot' ? "Quotes the pilot's account" : "Quotes a witness's account",
      passageIds: [account.passageId],
    });
  }
  for (const kind of notVerified) {
    const label = NOT_VERIFIED_LABEL[kind];
    if (label) lines.push({ label, text: NOT_VERIFIED_LINE, passageIds: [] });
  }
  if (quotesOmitted > 0) lines.push({ label: 'QUOTES', text: quotesOmittedLine(quotesOmitted), passageIds: [] });
  return lines.slice(0, 12);
}

/** The lines of a case an answer shows without its reading (Task 16e): what was not shown, never what the record lacks. */
export function readingRemovedLines(quotesOmitted = 0): CaseContextResponse['lines'] {
  return [
    { label: 'READING', text: READING_NOT_SHOWN_LINE, passageIds: [] },
    ...(quotesOmitted > 0 ? [{ label: 'QUOTES' as const, text: quotesOmittedLine(quotesOmitted), passageIds: [] }] : []),
  ];
}

/** The context of `ntsbNo` in a finished step, or null when the step has no such case. */
export function caseContext(step: StepRow, ntsbNo: string): CaseContextResponse | null {
  const result = step.result;
  const evidence = step.evidence;
  if (!result || !evidence || (result.kind !== 'answer' && result.kind !== 'withheld' && result.kind !== 'no_match')) return null;
  const card = result.cases.find((c) => c.case.ntsbNo === ntsbNo);
  const gaps = result.kind === 'withheld' ? [] : result.gaps.filter((g) => g.ntsbNo === ntsbNo);
  if (!card && gaps.length === 0) return null;
  const reading = result.kind === 'answer' ? (card?.reading ?? null) : null;
  const passages = evidence.passages
    .filter((p) => p.ntsbNo === ntsbNo)
    .map((p) => ({
      passageId: p.passageId,
      section: p.sectionKind,
      scope: p.scope,
      aircraftKey: p.aircraftKey,
      sectionId: p.sectionId,
      revisionId: p.revisionId,
      sectionRevision: p.sectionRevision,
      sectionStart: p.sectionStart,
      text: p.text,
      highlights: (reading?.quotes ?? []).filter((q) => q.passageId === p.passageId).map((q) => q.span),
    }));
  if (passages.length === 0) return null;
  const removed = result.kind === 'answer' && card !== undefined && reading === null && (card.notVerified !== undefined || card.quotesOmitted !== undefined);
  const lines = reading
    ? readingLines(reading, evidence.dimensions?.find((d) => d.ntsbNo === ntsbNo), card?.notVerified ?? [], card?.quotesOmitted ?? 0)
    : removed
      ? readingRemovedLines(card.quotesOmitted ?? 0)
      : [];
  return { briefId: step.briefId, step: step.n, ntsbNo, reading, lines, gaps, passages };
}
