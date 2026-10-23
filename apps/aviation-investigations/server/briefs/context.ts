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
 * reading.
 */
import {
  FAILURE_TYPE_LABELS,
  type CaseContextResponse,
  type CaseReading,
  type CriterionDecision,
  type GlyphKind,
  type MaintenanceRelation,
  type Symptom,
  type TimingChip,
} from '../../shared/contracts/briefs.js';
import { timingValueText } from './render.js';
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
 * Definite wording only for a decision the facts settle (an approximate value never
 * matches: server/briefs/criteria.ts); an unconfirmed one says so first.
 */
export const CRITERION_LINE: Readonly<Record<CriterionDecision['criterion'], Record<CriterionDecision['decision'], string>>> = {
  timing_window: { matches: 'Within your timing window', unconfirmed: 'Unconfirmed: the passages do not establish your timing window' },
  first_flight_only: {
    matches: 'On the first flight after maintenance, as asked',
    unconfirmed: 'Unconfirmed: the passages do not establish the first flight',
  },
  failure_type: { matches: 'The failure you asked about', unconfirmed: 'Unconfirmed: the passages do not establish the failure type' },
};

export function timingLine(t: TimingChip): string {
  const bound = { exact: '', about: 'About ', at_most: 'At most ', at_least: 'At least ' }[t.bound];
  const v = t.value === null ? '' : timingValueText(t.value);
  switch (t.basis) {
    case 'flight_hours':
      return `${bound}${v} flight ${t.value === 1 ? 'hour' : 'hours'} after the maintenance`;
    case 'calendar_days':
      return `${bound}${v} ${t.value === 1 ? 'day' : 'days'} after the maintenance`;
    case 'first_flight':
      return 'On the first flight after the maintenance';
    case 'subsequent_flight':
      return 'On a later flight after the maintenance';
    case 'qualitative':
      return 'Time since maintenance described in words only';
  }
}

/**
 * WHY IT'S IN YOUR RESULTS: labelled lines from server templates, each with the passages
 * its claim was checked on (empty for a statement about what the passages lack).
 */
export function readingLines(reading: CaseReading, dims: StoredDimensions | undefined): CaseContextResponse['lines'] {
  const lines: CaseContextResponse['lines'] = [];
  if (reading.glyph) lines.push({ label: 'EVIDENCE', text: EVIDENCE_LINE[reading.glyph], passageIds: dims?.evidencePassageIds ?? [] });
  if (dims?.maintenance && dims.maintenance.relation !== 'unknown') {
    lines.push({ label: 'MAINTENANCE', text: MAINTENANCE_LINE[dims.maintenance.relation], passageIds: dims.maintenance.passageIds });
  }
  if (dims?.symptom && dims.symptom.value !== 'other') {
    lines.push({ label: 'SYMPTOM', text: SYMPTOM_LINE[dims.symptom.value], passageIds: dims.symptom.passageIds });
  }
  for (const t of reading.timing) {
    lines.push({ label: 'TIMING', text: timingLine(t), passageIds: dims?.timing?.find((x) => x.basis === t.basis)?.passageIds ?? [] });
  }
  for (const c of reading.criteria) {
    // The passage set the criterion's own claim cited, never the symptom's or timing's.
    const passageIds = dims?.criteria?.find((x) => x.criterion === c.criterion)?.passageIds ?? [];
    lines.push({ label: 'CRITERIA', text: CRITERION_LINE[c.criterion][c.decision], passageIds });
  }
  const account = reading.quotes.find((q) => q.speaker !== 'investigators');
  if (account) {
    lines.push({
      label: 'ACCOUNT',
      text: account.speaker === 'pilot' ? "Quotes the pilot's account" : "Quotes a witness's account",
      passageIds: [account.passageId],
    });
  }
  return lines.slice(0, 12);
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
  const lines = reading ? readingLines(reading, evidence.dimensions?.find((d) => d.ntsbNo === ntsbNo)) : [];
  return { briefId: step.briefId, step: step.n, ntsbNo, reading, lines, gaps, passages };
}
