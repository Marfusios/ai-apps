/**
 * Wording for brief data that the contract carries as codes: section labels (always
 * deterministic), the AI's reading of who is speaking, and unconfirmed criteria.
 */
import { aircraftLetter, aircraftName } from '../../../../shared/case-view';
import type { BriefQuote, CaseReading, Criterion, Speaker } from '../../../../shared/contracts/briefs';
import { SECTION_LABEL, type AircraftBrief, type SectionKind } from '../../../../shared/contracts/search';

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

/**
 * The drawer's CRITERIA line for the same decision without its "Unconfirmed:" lead
 * (server/briefs/context.ts `CRITERION_LINE`, which a test holds this to): the analysis
 * could not establish it from the supplied passages, never that the passages or the
 * investigation lack the information (DESIGN §3).
 */
const UNCONFIRMED_LINE: Readonly<Record<Criterion, string>> = {
  timing_window: 'This analysis could not establish your timing window from the supplied passages.',
  first_flight_only: 'This analysis could not establish the first flight from the supplied passages.',
  failure_type: 'This analysis could not establish the failure type from the supplied passages.',
};

/** What this analysis could not settle, one line per unconfirmed criterion (UNCONFIRMED label). */
export function unconfirmedLines(reading: CaseReading | null): string[] {
  return (reading?.criteria ?? []).filter((c) => c.decision === 'unconfirmed').map((c) => UNCONFIRMED_LINE[c.criterion]);
}

/** Applies to the event; aircraft not stated (UI_DESIGN §4.3, multi-aircraft events). */
export const EVENT_SCOPE_CAUTION = 'Applies to the event; aircraft not stated';

type AircraftRef = Pick<AircraftBrief, 'aircraftKey' | 'aircraftNtsbNo' | 'make' | 'model'>;

/** "Aircraft A · Piper PA 28-180"; null when the key is not one of the event's aircraft. */
function namedAircraft(ntsbNo: string, aircraft: readonly AircraftRef[], key: number | null): string | null {
  const i = key === null ? -1 : aircraft.findIndex((a) => a.aircraftKey === key);
  if (i < 0) return null;
  const a = aircraft[i] as AircraftRef;
  return `Aircraft ${aircraftLetter(ntsbNo, a.aircraftNtsbNo, i)} · ${aircraftName(a)}`;
}

/** "both aircraft" or "all 3 aircraft". */
const everyAircraft = (n: number): string => (n === 2 ? 'both aircraft' : `all ${n} aircraft`);

/**
 * Whom a reading's evidence is about, said outright in a multi-aircraft event (UI_DESIGN
 * §4.3 "Cards and strips name the aircraft the evidence is attributed to"): the aircraft
 * of aircraft-scoped evidence, or the event narrative, which is never attributed to one
 * aircraft. Null for a single-aircraft event, where there is nothing to tell apart.
 */
export function evidenceAttribution(ntsbNo: string, aircraft: readonly AircraftRef[], evidence: CaseReading['evidence']): string | null {
  if (aircraft.length < 2) return null;
  if (evidence.scope === 'aircraft') {
    // An aircraft this record does not list: say so, and never imply which aircraft.
    return namedAircraft(ntsbNo, aircraft, evidence.aircraftKey) ?? 'Aircraft not identified in this record — not attributed to one aircraft';
  }
  return `Event narrative, ${everyAircraft(aircraft.length)} — not attributed to one aircraft`;
}

/**
 * True when a multi-aircraft event's evidence cannot be tied to one aircraft (event
 * narrative, or an aircraft key the record does not list): the card shows the UI_DESIGN
 * caution "Applies to the event; aircraft not stated".
 */
export function attributionAmbiguous(aircraft: readonly AircraftRef[], evidence: CaseReading['evidence']): boolean {
  if (evidence.scope === 'event') return evidence.multiAircraft;
  return aircraft.length > 1 && !aircraft.some((a) => a.aircraftKey === evidence.aircraftKey);
}

/** The quote's part of a multi-aircraft event, for its label: "AIRCRAFT A", "EVENT NARRATIVE, BOTH AIRCRAFT" or "AIRCRAFT NOT STATED". */
export function quoteAttribution(ntsbNo: string, aircraft: readonly AircraftRef[], quote: Pick<BriefQuote, 'scope' | 'aircraftKey'>): string | null {
  if (aircraft.length < 2) return null;
  if (quote.scope === 'event') return `Event narrative, ${everyAircraft(aircraft.length)}`.toUpperCase();
  const one = namedAircraft(ntsbNo, aircraft, quote.aircraftKey);
  return one ? one.split(' · ')[0]!.toUpperCase() : 'AIRCRAFT NOT STATED';
}

/** "6 examples found · not every matching investigation" (required by DESIGN §5). */
export function resultsLabel(n: number): string {
  return `${n} ${n === 1 ? 'example' : 'examples'} found · not every matching investigation`;
}
