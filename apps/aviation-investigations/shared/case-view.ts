/**
 * Deterministic text built from coded NTSB fields: the case headline, finding
 * display text and data cautions (UI_DESIGN §2.7, §4.5). Nothing here is written by
 * a language model; the same input always gives the same words.
 */
import type { PhaseGroup } from './codes.js';
import { CATEGORY_NOUN, EVENT_CODE, US_STATE } from './vocab.js';

// ---------------------------------------------------------------------------
// Headline: "{make model}{ category noun}, {defining event} {phase phrase} near {city, state}"

/** Headline wording of defining events; other codes use the lower-cased dictionary label. */
const EVENT_PHRASE: Readonly<Record<string, string>> = {
  '000': '',
  '090': 'abnormal runway contact',
  '091': 'tailstrike',
  '092': 'hard landing',
  '093': 'dragged wing, rotor or float',
  '094': 'landing gear collapse',
  '095': 'landing with the gear not configured',
  '096': 'nose-over',
  '097': 'rollover',
  '120': 'controlled flight into terrain',
  '150': 'fire in flight',
  '170': 'post-impact fire',
  '190': 'fuel-related event',
  '191': 'fuel starvation',
  '192': 'fuel exhaustion',
  '193': 'fuel contamination',
  '194': 'wrong fuel',
  '200': 'ground collision',
  '210': 'icing encounter',
  '220': 'low-altitude operation',
  '230': 'loss of control on the ground',
  '231': 'dynamic rollover',
  '240': 'loss of control in flight',
  '241': 'aerodynamic stall/spin',
  '242': 'loss of tail rotor effectiveness',
  '244': 'settling with power',
  '250': 'midair collision',
  '260': 'near midair collision',
  '271': 'in-flight upset',
  '300': 'runway excursion',
  '320': 'runway incursion',
  '330': 'system malfunction',
  '332': 'electrical system failure',
  '333': 'flight control malfunction',
  '334': 'flight instrument failure',
  '337': 'structural failure',
  '338': 'part separation from the aircraft',
  '340': 'powerplant malfunction',
  '341': 'total loss of engine power',
  '342': 'partial loss of engine power',
  '343': 'uncontained engine failure',
  '360': 'turbulence encounter',
  '361': 'wake turbulence encounter',
  '390': 'windshear or thunderstorm encounter',
  '400': 'weather encounter',
  '401': 'VFR flight into IMC',
  '402': 'loss of visual reference',
  '440': 'off-field landing',
  '441': 'ditching',
  '470': 'collision with terrain or an object',
  '490': 'collision during takeoff or landing',
  '900': '',
  '901': 'birdstrike',
};

/** Phase phrases for specific `phase_no` codes. */
const PHASE_CODE_PHRASE: Readonly<Record<string, string>> = {
  '251': 'while taxiing',
  '252': 'while taxiing',
  '253': 'while taxiing',
  '301': 'during a rejected takeoff',
  '401': 'in the climb to cruise',
  '402': 'in cruise',
  '404': 'in the descent',
  '405': 'in a hold',
  '451': 'during aerobatics',
  '452': 'in low-altitude flight',
  '453': 'in a hover',
  '501': 'on initial approach',
  '502': 'on final approach',
  '503': 'on a circling approach',
  '504': 'during a missed approach',
  '505': 'on the crosswind leg',
  '506': 'on the downwind leg',
  '507': 'on the base leg',
  '508': 'on final',
  '509': 'during a go-around',
  '551': 'at touchdown',
  '552': 'during the landing roll',
  '553': 'after an aborted landing',
  '601': 'in an autorotation',
};

const PHASE_GROUP_PHRASE: Readonly<Record<PhaseGroup, string>> = {
  prior_to_flight: 'before flight',
  standing: 'while standing',
  pushback: 'during pushback',
  taxi: 'while taxiing',
  takeoff: 'on takeoff',
  initial_climb: 'in the initial climb',
  en_route: 'en route',
  maneuvering: 'while maneuvering',
  approach: 'on approach',
  landing: 'on landing',
  emergency_descent: 'in an emergency descent',
  uncontrolled_descent: 'in an uncontrolled descent',
  post_impact: 'after impact',
  after_landing: 'after landing',
  other: '',
  unknown: '',
};

const CORPORATE_SUFFIX = /^(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|aircraft|aviation|industries|manufacturing|mfg|gmbh|sa|ag)\.?$/i;

/** "PIPER AIRCRAFT INC" → "Piper"; mixed-case makes keep their spelling. */
export function displayMake(make: string | null): string {
  const raw = (make ?? '').trim().replace(/\s+/g, ' ');
  if (raw === '') return '';
  const words = raw.split(' ');
  while (words.length > 1 && CORPORATE_SUFFIX.test(words[words.length - 1] as string)) words.pop();
  const joined = words.join(' ').replace(/,$/, '');
  if (joined !== joined.toUpperCase()) return joined;
  return joined.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** "Hughes OH-6": display make and the published model. */
export function aircraftName(a: { make: string | null; model: string | null }): string {
  const make = displayMake(a.make);
  const model = (a.model ?? '').trim();
  const name = [make, model].filter((s) => s !== '').join(' ');
  return name === '' ? 'Unidentified aircraft' : name;
}

function titleCase(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function eventPhrase(code: string | null): string {
  if (code === null) return '';
  if (Object.hasOwn(EVENT_PHRASE, code)) return EVENT_PHRASE[code] as string;
  const label = EVENT_CODE[code];
  return label ? label.charAt(0).toLowerCase() + label.slice(1) : '';
}

export function phasePhrase(phaseCode: string | null, group: PhaseGroup): string {
  if (phaseCode !== null && Object.hasOwn(PHASE_CODE_PHRASE, phaseCode)) return PHASE_CODE_PHRASE[phaseCode] as string;
  return PHASE_GROUP_PHRASE[group];
}

/** "near Valentine, Texas"; empty when neither city nor state is recorded. */
export function placePhrase(city: string | null, stateCode: string | null): string {
  const c = city ? titleCase(city) : '';
  const code = (stateCode ?? '').trim().toUpperCase();
  const state = code !== '' && Object.hasOwn(US_STATE, code) ? (US_STATE[code] as string) : '';
  const place = [c, state].filter((s) => s !== '').join(', ');
  return place === '' ? '' : `near ${place}`;
}

export interface HeadlineAircraft {
  make: string | null;
  model: string | null;
  categoryCode: string | null;
  definingEvent: { phase: PhaseGroup; phaseCode: string | null; eventCode: string | null } | null;
}

export interface HeadlineInput {
  aircraft: readonly HeadlineAircraft[];
  /** `ev_type` code, used when no defining event is coded. */
  eventTypeCode: string | null;
  city: string | null;
  stateCode: string | null;
}

function nameWithCategory(a: HeadlineAircraft): string {
  const code = (a.categoryCode ?? '').toUpperCase();
  const noun = Object.hasOwn(CATEGORY_NOUN, code) ? (CATEGORY_NOUN[code] as string) : '';
  return noun ? `${aircraftName(a)} ${noun}` : aircraftName(a);
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} other aircraft`;
}

/**
 * The case headline (UI_DESIGN §4.5). Multi-aircraft events name the aircraft and
 * keep the event or phase only when every aircraft shares it, so nothing is
 * attributed to the wrong aircraft. Without a defining event the event type is
 * used: "Airbus A330 incident near Boston, Massachusetts".
 */
export function buildHeadline(input: HeadlineInput): string {
  const aircraft = input.aircraft;
  const place = placePhrase(input.city, input.stateCode);
  const names = aircraft.length === 0 ? ['Unidentified aircraft'] : aircraft.map(nameWithCategory);
  const subject = joinNames(names);

  const defining = aircraft.map((a) => a.definingEvent);
  const allDefined = defining.length > 0 && defining.every((d) => d !== null);
  const first = defining[0] ?? null;
  const sameEvent = allDefined && defining.every((d) => d?.eventCode === first?.eventCode);
  const samePhase = allDefined && defining.every((d) => d?.phase === first?.phase && d?.phaseCode === first?.phaseCode);
  const event = sameEvent && first ? eventPhrase(first.eventCode) : '';
  const phase = samePhase && first ? phasePhrase(first.phaseCode, first.phase) : '';

  if (event === '') {
    const type = (input.eventTypeCode ?? '').toUpperCase();
    const noun = type === 'ACC' ? 'accident' : type === 'INC' ? 'incident' : 'event';
    return [subject, noun, phase, place].filter((s) => s !== '').join(' ');
  }
  return `${subject}, ${[event, phase, place].filter((s) => s !== '').join(' ')}`;
}

// ---------------------------------------------------------------------------
// Findings

/** The deprecated cause/factor marker some descriptions end with ("... - C"). */
const CAUSE_FACTOR_MARKER = /\s+-\s+[CF]\s*$/;

/**
 * Finding description for display: as published, trimmed, with the deprecated
 * trailing " - C" / " - F" removed. That marker must never read as a cause or
 * contributing label (DATA_REVIEW).
 */
export function findingText(description: string | null): string | null {
  if (description === null) return null;
  const text = description.replace(CAUSE_FACTOR_MARKER, '').trim();
  return text === '' ? null : text;
}

// ---------------------------------------------------------------------------
// Data cautions (deterministic only, UI_DESIGN §2.7)

export type CautionKind =
  | 'status_blank'
  | 'status_conflict'
  | 'injury_mismatch'
  | 'shared_narrative'
  | 'defining_event_conflict';

export interface CautionInput {
  rawStatus: string | null;
  completed: boolean;
  hasProbableCause: boolean;
  highestInjuryCode: string | null;
  injuries: { fatal: number | null; serious: number | null; minor: number | null };
  aircraftCount: number;
  hasEventScopedSections: boolean;
  /** Aircraft labels (A, B…) whose defining flags conflict. */
  definingConflicts: readonly string[];
}

const INJURY_WORD: Readonly<Record<string, string>> = { FATL: 'fatal', SERS: 'serious', MINR: 'minor', NONE: 'none' };

function countWords(n: number, word: string): string {
  return `${n} ${word}`;
}

export function dataCautions(input: CautionInput): { kind: CautionKind; text: string }[] {
  const out: { kind: CautionKind; text: string }[] = [];
  const status = (input.rawStatus ?? '').trim();
  if (status === '') {
    out.push({
      kind: 'status_blank',
      text: 'The NTSB status field is blank in this snapshot, so the record is not counted as a completed investigation.',
    });
  } else if (!input.completed && input.hasProbableCause) {
    out.push({
      kind: 'status_conflict',
      text: `The record has probable-cause text, but its NTSB status (${status}) is not a completed status. Both are shown as published.`,
    });
  }

  const code = (input.highestInjuryCode ?? '').trim().toUpperCase();
  const { fatal, serious, minor } = input.injuries;
  if (code in INJURY_WORD && fatal !== null && serious !== null && minor !== null) {
    const derived = fatal > 0 ? 'FATL' : serious > 0 ? 'SERS' : minor > 0 ? 'MINR' : 'NONE';
    if (derived !== code) {
      const counts = [
        fatal > 0 && countWords(fatal, 'fatal'),
        serious > 0 && countWords(serious, 'serious'),
        minor > 0 && countWords(minor, 'minor'),
      ].filter(Boolean);
      const listed = counts.length > 0 ? counts.join(', ') : 'no injuries';
      out.push({
        kind: 'injury_mismatch',
        text: `The coded highest injury is ${INJURY_WORD[code]}, but the injury counts list ${listed}. Both are shown as published.`,
      });
    }
  }

  if (input.aircraftCount > 1 && input.hasEventScopedSections) {
    out.push({
      kind: 'shared_narrative',
      text: `This event involved ${input.aircraftCount} aircraft. The NTSB narrative describes the event as a whole, so its text is not attributed to one aircraft here.`,
    });
  }

  if (input.definingConflicts.length > 0) {
    const which = input.definingConflicts.join(' and ');
    out.push({
      kind: 'defining_event_conflict',
      text: `More than one sequence step is flagged as the defining event for aircraft ${which}, so none is shown as defining.`,
    });
  }
  return out;
}

/** Letter for an aircraft: the suffix of its suffixed number (`SEA08LA057B` → B), else by position. */
export function aircraftLetter(eventNtsbNo: string, aircraftNtsbNo: string | null, index: number): string {
  if (aircraftNtsbNo && aircraftNtsbNo.startsWith(eventNtsbNo)) {
    const suffix = aircraftNtsbNo.slice(eventNtsbNo.length);
    if (/^[A-Z]$/.test(suffix)) return suffix;
  }
  return String.fromCharCode(65 + (index % 26));
}
