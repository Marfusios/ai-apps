/**
 * The brief's AI context for one case (UI_DESIGN §4.5, "WHY IT'S IN YOUR RESULTS" and
 * "CITED PASSAGE"), read by its read owner through
 * `GET /api/briefs/:id/steps/:n/cases/:ntsbNo`. It comes entirely from what the finished
 * step stored: the validated reading of the case, the passages it was checked against
 * (with the quote spans to highlight) and labelled lines from server templates. A
 * withheld step returns the NTSB passages with no reading.
 */
import type {
  CaseContextResponse,
  CaseReading,
  GlyphKind,
  MaintenanceRelation,
  Symptom,
  TimingChip,
} from '../../shared/contracts/briefs.js';
import type { StepRow } from './store.js';

const EVIDENCE_LINE: Readonly<Record<GlyphKind, string>> = {
  causal: 'Causal fault established in the investigation',
  defect_not_causal: 'Defect found; causal link not established',
  no_fault: 'No relevant fault identified',
  insufficient: 'Insufficient or conflicting evidence',
};

const MAINTENANCE_LINE: Readonly<Record<Exclude<MaintenanceRelation, 'unknown'>, string>> = {
  investigator_attributed: 'Investigators attributed a contribution to maintenance',
  preceding_not_established: 'Maintenance came first; a causal link was not established',
  no_evidence: 'No relevant maintenance in the cited passages',
};

const SYMPTOM_LINE: Readonly<Record<Exclude<Symptom, 'other'>, string>> = {
  total_power_loss: 'Total loss of engine power',
  partial_power_loss: 'Partial loss of engine power',
  rough_running: 'Engine running rough',
  failure_to_climb: 'Unable to climb',
};

function timingLine(t: TimingChip): string {
  const bound = { exact: '', about: 'About ', at_most: 'At most ', at_least: 'At least ' }[t.bound];
  switch (t.basis) {
    case 'flight_hours':
      return `${bound}${t.value} flight hours after the maintenance`;
    case 'calendar_days':
      return `${bound}${t.value} ${t.value === 1 ? 'day' : 'days'} after the maintenance`;
    case 'first_flight':
      return 'On the first flight after the maintenance';
    case 'subsequent_flight':
      return 'On a later flight after the maintenance';
    case 'qualitative':
      return 'Time since maintenance described in words only';
  }
}

/** WHY IT'S IN YOUR RESULTS: labelled lines from server templates, each jumping to a quoted passage. */
export function readingLines(
  reading: CaseReading,
  dims?: { maintenance?: MaintenanceRelation; symptom?: Symptom },
): CaseContextResponse['lines'] {
  const lines: CaseContextResponse['lines'] = [];
  const first = reading.quotes[0]?.passageId ?? null;
  if (reading.glyph) lines.push({ label: 'EVIDENCE', text: EVIDENCE_LINE[reading.glyph], passageId: first });
  if (dims?.maintenance && dims.maintenance !== 'unknown') {
    lines.push({ label: 'MAINTENANCE', text: MAINTENANCE_LINE[dims.maintenance], passageId: first });
  }
  if (dims?.symptom && dims.symptom !== 'other') lines.push({ label: 'SYMPTOM', text: SYMPTOM_LINE[dims.symptom], passageId: first });
  if (reading.timing) lines.push({ label: 'TIMING', text: timingLine(reading.timing), passageId: first });
  const account = reading.quotes.find((q) => q.speaker !== 'investigators');
  if (account) {
    lines.push({
      label: 'ACCOUNT',
      text: account.speaker === 'pilot' ? "Quotes the pilot's account" : "Quotes a witness's account",
      passageId: account.passageId,
    });
  }
  return lines;
}

/** The context of `ntsbNo` in a finished step, or null when the step has no such case. */
export function caseContext(step: StepRow, ntsbNo: string): CaseContextResponse | null {
  const result = step.result;
  const evidence = step.evidence;
  if (!result || !evidence || (result.kind !== 'answer' && result.kind !== 'withheld')) return null;
  const card = result.cases.find((c) => c.case.ntsbNo === ntsbNo);
  if (!card) return null;
  const reading = result.kind === 'answer' ? card.reading : null;
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
  return { briefId: step.briefId, step: step.n, ntsbNo, reading, lines, passages };
}
