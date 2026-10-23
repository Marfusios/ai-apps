/**
 * Display wording for NTSB contract data: mono lines, weather chips, injury
 * phrases, flight-profile steps. Deterministic and NTSB-only.
 */
import { aircraftLetter, aircraftName } from '../../../../shared/case-view';
import type { CaseDetail, Caution, Finding, Weather } from '../../../../shared/contracts/cases';
import type { PhaseGroup } from '../../../../shared/codes';
import type { Coded } from '../../../../shared/contracts/common';
import type { AircraftBrief, CaseRow } from '../../../../shared/contracts/search';
import type { FlightProfileStep } from '../../components/flight-profile-layout';
import { PHASE_SHORT } from '../../components/flight-profile-layout';

export { aircraftLetter, aircraftName };

/** Data cautions as short chip phrases (strips and cards); the drawer shows the full sentence. */
export const CAUTION_SHORT: Readonly<Record<Caution['kind'], string>> = {
  status_blank: 'status blank',
  status_conflict: 'status',
  injury_mismatch: 'injury codes',
  shared_narrative: 'shared narrative',
  defining_event_conflict: 'defining event',
};

const LIGHT_SHORT: Readonly<Record<string, string>> = {
  DAYL: 'DAY',
  DAWN: 'DAWN',
  DUSK: 'DUSK',
  NITE: 'NIGHT',
  NDRK: 'NIGHT, DARK',
  NBRT: 'NIGHT, BRIGHT',
  NR: 'LIGHT NOT REPORTED',
};

const LIGHT_WORD: Readonly<Record<string, string>> = {
  DAYL: 'daylight',
  DAWN: 'dawn',
  DUSK: 'dusk',
  NITE: 'night',
  NDRK: 'night, dark',
  NBRT: 'night, bright',
};

/** "VMC DAY"; "WEATHER NOT REPORTED" when neither is recorded. */
export function conditionsShort(conditions: Coded, light: Coded): string {
  const wx = conditions.code === null ? '' : conditions.code === 'UNK' ? 'WX UNKNOWN' : conditions.code;
  const lt = light.code === null ? '' : (LIGHT_SHORT[light.code] ?? light.code);
  const out = [wx, lt].filter(Boolean).join(' ');
  return out === '' ? 'WEATHER NOT REPORTED' : out;
}

export function lightWord(light: Coded): string | null {
  return light.code ? (LIGHT_WORD[light.code] ?? null) : null;
}

const INJURY_SHORT: Readonly<Record<string, string>> = {
  FATL: 'FATAL',
  SERS: 'SERIOUS INJURY',
  MINR: 'MINOR INJURY',
  NONE: 'NO INJURIES',
  UNK: 'INJURY UNKNOWN',
};

/** Highest injury for mono lines; fatal outcomes are bold ink, never red (UI_DESIGN §2.1). */
export function injuryShort(injury: Coded): { text: string; fatal: boolean } {
  if (injury.code === null) return { text: 'INJURY NOT REPORTED', fatal: false };
  return { text: INJURY_SHORT[injury.code] ?? injury.code, fatal: injury.code === 'FATL' };
}

/** "1 minor injury", "2 fatal, 1 serious", "No injuries", from the event's counts. */
export function injurySummary(detail: Pick<CaseDetail, 'injuries' | 'highestInjury'>): string {
  const { fatal, serious, minor } = detail.injuries;
  const parts: string[] = [];
  if (fatal) parts.push(`${fatal} fatal`);
  if (serious) parts.push(`${serious} serious ${serious === 1 ? 'injury' : 'injuries'}`);
  if (minor) parts.push(`${minor} minor ${minor === 1 ? 'injury' : 'injuries'}`);
  if (parts.length > 0) return parts.join(', ');
  if (fatal === 0 && serious === 0 && minor === 0) return 'No injuries';
  return detail.highestInjury.code ? `Highest injury: ${detail.highestInjury.label.toLowerCase()}` : 'Injuries not reported';
}

/** "Newnan, GA"; the state code alone when there is no city. */
export function placeShort(city: string | null, state: Coded, country: string | null): string {
  const c = (city ?? '').trim();
  const titled = c !== '' && c === c.toUpperCase() ? c.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, s: string, ch: string) => s + ch.toUpperCase()) : c;
  const region = state.code ?? (country && country !== 'USA' ? country : '');
  return [titled, region].filter(Boolean).join(', ') || 'Place not recorded';
}

/** "Part 91 · personal", from the coded operation and purpose. */
export function operationLine(a: Pick<AircraftBrief, 'farPart' | 'purpose'>): string {
  const part = a.farPart.code ? a.farPart.label : '';
  const purpose = a.purpose.code ? a.purpose.label.toLowerCase() : '';
  return [part, purpose].filter(Boolean).join(' · ') || 'Operation not reported';
}

/** Mono "PHASE · DEFINING EVENT" for one aircraft. */
export function phaseEventShort(a: AircraftBrief): string {
  if (!a.definingEvent) return 'NO DEFINING EVENT CODED';
  return `${PHASE_SHORT[a.definingEvent.phase]} · ${a.definingEvent.event.label.toUpperCase()}`;
}

/** The row's second line for a single-aircraft event: phase · event · conditions · injury. */
export function rowMonoParts(row: CaseRow): { text: string; strong?: boolean }[] {
  const parts: { text: string; strong?: boolean }[] = [];
  if (row.aircraft.length === 1) parts.push({ text: phaseEventShort(row.aircraft[0] as AircraftBrief) });
  parts.push({ text: conditionsShort(row.conditions, row.light) });
  const injury = injuryShort(row.highestInjury);
  parts.push({ text: injury.text, strong: injury.fatal });
  return parts;
}

/** Bold aircraft line: "Piper PA-28-151"; multi-aircraft events say how many. */
export function aircraftSummary(row: Pick<CaseRow, 'aircraft'>): string {
  if (row.aircraft.length === 0) return 'No aircraft recorded';
  if (row.aircraft.length === 1) return aircraftName(row.aircraft[0] as AircraftBrief);
  return `${row.aircraft.length} aircraft`;
}

export function letterOf(ntsbNo: string, a: Pick<AircraftBrief, 'aircraftNtsbNo'>, index: number): string {
  return aircraftLetter(ntsbNo, a.aircraftNtsbNo, index);
}

/**
 * Schematic order of phase groups for the flight profile. Occurrence numbers are
 * not chronological in every record (newer records number the defining event
 * after the impact), so the profile orders steps by phase: an emergency or
 * uncontrolled descent comes before the landing it ends in.
 */
const SCHEMATIC_RANK: Readonly<Record<PhaseGroup, number | null>> = {
  prior_to_flight: 0,
  standing: 1,
  pushback: 2,
  taxi: 3,
  takeoff: 4,
  initial_climb: 5,
  en_route: 6,
  maneuvering: 7,
  approach: 8,
  emergency_descent: 9,
  uncontrolled_descent: 9,
  landing: 10,
  after_landing: 11,
  post_impact: 12,
  other: null,
  unknown: null,
};

/**
 * Flight-profile steps of one aircraft, in schematic order: by phase (above), then
 * the coded phase (551 flare before 552 roll), then occurrence number. Steps with
 * an unknown or other phase stay after the step they follow in the record.
 */
export function profileSteps(detail: Pick<CaseDetail, 'sequence'>, aircraftKey: number): FlightProfileStep[] {
  const own = detail.sequence.filter((s) => s.aircraftKey === aircraftKey);
  let carried = -1;
  const ranked = own.map((s, i) => {
    const rank = SCHEMATIC_RANK[s.phase];
    if (rank !== null) carried = rank;
    return { s, i, rank: rank ?? carried, code: rank === null ? Infinity : Number(s.phaseDetail.code ?? 0) };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.code - b.code || a.i - b.i);
  return ranked.map(({ s }) => ({ phaseGroup: s.phase, eventLabel: s.event.label, isDefining: s.isDefining === true, impact: s.impact }));
}

/** Mono weather chips in reading order: VMC · DAYLIGHT · BKN 3100 · 10 SM · WIND 290° 6 KT · ALTIMETER 29.95. */
export function weatherChips(w: Weather): string[] {
  const chips: string[] = [];
  if (w.basic.code && w.basic.code !== 'UNK') chips.push(w.basic.code);
  const light = lightWord(w.light);
  if (light) chips.push(light.toUpperCase());
  const ceiling = w.ceiling.cover.code;
  if (ceiling && ceiling !== 'NONE' && ceiling !== 'UNK') {
    chips.push(w.ceiling.heightFt ? `${ceiling} ${w.ceiling.heightFt}` : ceiling);
  }
  const low = w.lowestNonCeiling.cover.code;
  if (low && low !== 'NONE' && low !== 'UNK') {
    if (low === 'CLER') chips.push('CLEAR');
    else chips.push(w.lowestNonCeiling.heightFt ? `${low === 'SCAT' ? 'SCT' : low} ${w.lowestNonCeiling.heightFt}` : w.lowestNonCeiling.cover.label.toUpperCase());
  }
  if (w.visibilitySm !== null && w.visibilitySm > 0) chips.push(`${Number(w.visibilitySm.toFixed(2))} SM`);
  const { wind } = w;
  if (wind.speedIndicator === 'CALM') chips.push('WIND CALM');
  else if (wind.speedKts !== null && wind.speedKts > 0) {
    const dir = wind.directionIndicator === 'V' ? 'VRB' : wind.directionDeg !== null ? `${String(wind.directionDeg).padStart(3, '0')}°` : '';
    const gust = wind.gustKts ? ` G${wind.gustKts}` : '';
    chips.push(`WIND ${dir ? `${dir} ` : ''}${wind.speedKts}${gust} KT`);
  }
  // Recorded zeros are not interpreted; a zero altimeter setting is simply not shown.
  if (w.altimeterInHg !== null && w.altimeterInHg > 20) chips.push(`ALTIMETER ${w.altimeterInHg.toFixed(2)}`);
  return chips;
}

/** "VMC · DAY" / "BKN 3100" / "10 SM": the compact compare-strip conditions. */
export function conditionsLines(w: Weather): string[] {
  const chips = weatherChips(w).filter((c) => !c.startsWith('ALTIMETER') && !c.startsWith('WIND'));
  const first = [w.basic.code && w.basic.code !== 'UNK' ? w.basic.code : null, w.light.code ? (LIGHT_SHORT[w.light.code] ?? w.light.code) : null]
    .filter(Boolean)
    .join(' · ');
  const rest = chips.filter((c) => c !== w.basic.code && c !== lightWord(w.light)?.toUpperCase());
  return [first || 'NOT REPORTED', ...rest];
}

/** "Personnel issues-…-Decision making/judgment-Pilot" → lead "Decision making/judgment", detail "Pilot". */
export function findingParts(finding: Pick<Finding, 'text'>): { lead: string; detail: string | null; path: string | null } {
  const text = finding.text ?? 'Finding text not recorded';
  const parts = text.split('-').map((p) => p.trim());
  if (parts.length !== 5) return { lead: text, detail: null, path: null };
  const [category, subcategory, section, subsection, modifier] = parts as [string, string, string, string, string];
  const meaningful = [subsection, section, subcategory, category].find((p) => p !== '' && p !== '(general)') ?? category;
  const detail = modifier !== '' && modifier !== '(general)' ? modifier : null;
  return { lead: meaningful, detail, path: [category, subcategory, section, subsection].filter((p) => p !== '(general)').join(' › ') };
}
