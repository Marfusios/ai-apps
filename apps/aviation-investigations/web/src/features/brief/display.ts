/**
 * Wording for brief data that the contract carries as codes: section labels (always
 * deterministic), the AI's reading of who is speaking, and unconfirmed criteria.
 */
import type { CaseReading, Criterion, Speaker } from '../../../../shared/contracts/briefs';
import { SECTION_LABEL, type SectionKind } from '../../../../shared/contracts/search';

/** "NTSB · ANALYSIS": whose words follow, from the section kind, never from the AI. */
export function ntsbSectionTag(section: SectionKind): string {
  return `NTSB · ${SECTION_LABEL[section].toUpperCase()}`;
}

/** The brief's attribution of a quote (UI_DESIGN §4.3 "Who is speaking"), or null for investigators. */
export function speakerTag(speaker: Speaker): string | null {
  if (speaker === 'pilot') return "PILOT'S ACCOUNT · AI READING";
  if (speaker === 'witness') return "WITNESS'S ACCOUNT · AI READING";
  return null;
}

const UNCONFIRMED_LINE: Readonly<Record<Criterion, string>> = {
  timing_window: 'The passages do not establish your timing window.',
  first_flight_only: 'The passages do not establish the first flight after maintenance.',
  failure_type: 'The passages do not establish the failure type.',
};

/** What the passages do not settle, one line per unconfirmed criterion (UNCONFIRMED label). */
export function unconfirmedLines(reading: CaseReading | null): string[] {
  return (reading?.criteria ?? []).filter((c) => c.decision === 'unconfirmed').map((c) => UNCONFIRMED_LINE[c.criterion]);
}

/** Applies to the event; aircraft not stated (UI_DESIGN §4.3, multi-aircraft events). */
export const EVENT_SCOPE_CAUTION = 'Applies to the event; aircraft not stated';

/** "6 examples found · not every matching investigation" (required by DESIGN §5). */
export function resultsLabel(n: number): string {
  return `${n} ${n === 1 ? 'example' : 'examples'} found · not every matching investigation`;
}
