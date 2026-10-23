/**
 * Server templates for readings of vague terms (UI_DESIGN §4.3): interpretation
 * chips, clarification readings ("AI SUGGESTED READINGS") and the interpretation
 * lines the answer model receives. The planner returns only an allowlisted ambiguity
 * type and single-token values (server/ai/provider.ts `AmbiguitySchema`); every word a
 * reader sees comes from the tables below or, for failure types, the contract's
 * `FAILURE_TYPE_LABELS`. A value without a template is dropped.
 */
import { PHASE_LABEL, type PhaseGroup } from '../../shared/codes.js';
import {
  FAILURE_TYPE_LABELS,
  FAILURE_TYPES,
  type BriefFilters,
  type FailureType,
  type InterpretationChip,
  type Reading,
  type TimingWindow,
} from '../../shared/contracts/briefs.js';
import { FACET_VALUES } from '../../shared/contracts/search.js';
import type { Ambiguity } from '../ai/provider.js';

/** The fixed line and label of a clarification reply. */
export const CLARIFICATION_LABEL = 'AI SUGGESTED READINGS';
export const CLARIFICATION_LINE = 'Which did you mean? Pick one to ask the AI.';

const MAX_DAYS = 365;
const MAX_FLIGHT_HOURS = 500;

// ---------------------------------------------------------------------------
// Timing windows: tokens `30d`, `10h`, `30d_or_10h`, `first_flight`

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Within 30 days or 10 flight hours". */
export function timingWindowLabel(w: TimingWindow): string {
  const parts = [
    ...(w.days !== null ? [plural(w.days, 'day', 'days')] : []),
    ...(w.flightHours !== null ? [plural(w.flightHours, 'flight hour', 'flight hours')] : []),
  ];
  return `Within ${parts.join(' or ')}`;
}

/** The window as the compose stage reads it. */
function timingWindowInterpretation(w: TimingWindow): string {
  const parts = [
    ...(w.days !== null ? [plural(w.days, 'calendar day', 'calendar days')] : []),
    ...(w.flightHours !== null ? [plural(w.flightHours, 'flight hour', 'flight hours')] : []),
  ];
  return `Read vague timing words about maintenance as: within ${parts.join(' or ')} after the maintenance.`;
}

export const FIRST_FLIGHT_LABEL = 'First flight after maintenance only';
const FIRST_FLIGHT_INTERPRETATION = 'Only an event on the first flight after the maintenance counts.';

export type TimingReading = { kind: 'window'; window: TimingWindow } | { kind: 'first_flight' };

/** Parse a planner timing token; null for anything outside the template grammar or range. */
export function parseTimingToken(token: string): TimingReading | null {
  if (token === 'first_flight') return { kind: 'first_flight' };
  const m = /^(?:(\d{1,3})d)?(?:_or_)?(?:(\d{1,3})h)?$/.exec(token);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  // `_or_` only between both parts.
  if (token.includes('_or_') !== (m[1] !== undefined && m[2] !== undefined)) return null;
  const days = m[1] === undefined ? null : Number(m[1]);
  const flightHours = m[2] === undefined ? null : Number(m[2]);
  if (days !== null && (days < 1 || days > MAX_DAYS)) return null;
  if (flightHours !== null && (flightHours < 1 || flightHours > MAX_FLIGHT_HOURS)) return null;
  return { kind: 'window', window: { days, flightHours } };
}

/** The planner token for a window (inverse of `parseTimingToken`). */
export function timingToken(w: TimingWindow): string {
  if (w.days !== null && w.flightHours !== null) return `${w.days}d_or_${w.flightHours}h`;
  return w.days !== null ? `${w.days}d` : `${w.flightHours}h`;
}

// ---------------------------------------------------------------------------
// Failure types (labels: the contract's `FAILURE_TYPE_LABELS`, shared with the web
// client's chip editor), aircraft categories, phases

const FAILURE_TYPE_INTERPRETATION: Readonly<Record<FailureType, string>> = {
  total_power_loss: 'Read the failure in the question as: a total loss of engine power.',
  partial_power_loss: 'Read the failure in the question as: a partial loss of engine power.',
  rough_running: 'Read the failure in the question as: an engine running rough.',
  failure_to_climb: 'Read the failure in the question as: an aircraft unable to climb.',
};

export const isFailureType = (v: string): v is FailureType => (FAILURE_TYPES as readonly string[]).includes(v);

export const CATEGORY_READING_LABEL: Readonly<Record<string, string>> = {
  AIR: 'Airplanes only',
  HELI: 'Helicopters only',
  GLI: 'Gliders only',
  BALL: 'Balloons only',
  BLIM: 'Blimps only',
  GYRO: 'Gyrocraft only',
  PLFT: 'Powered-lift aircraft only',
  ULTR: 'Ultralights only',
  WSFT: 'Weight-shift aircraft only',
  PPAR: 'Powered parachutes only',
  RCKT: 'Rockets only',
};

const phaseReadingLabel = (g: PhaseGroup) => `Phase of flight: ${PHASE_LABEL[g]}`;

// ---------------------------------------------------------------------------
// Readings in effect

/** Readings of a brief's vague terms. `pinned`: the reader chose it; otherwise the planner's default. */
export interface ReadingState {
  timingWindow?: { value: TimingWindow; pinned: boolean };
  firstFlightOnly?: { value: boolean; pinned: boolean };
  failureType?: { value: FailureType; pinned: boolean };
}

/** Interpretation chips for the briefing sheet, in a fixed order. */
export function interpretationChips(r: ReadingState): InterpretationChip[] {
  const chips: InterpretationChip[] = [];
  if (r.timingWindow) {
    chips.push({ field: 'timing_window', value: r.timingWindow.value, label: timingWindowLabel(r.timingWindow.value), pinned: r.timingWindow.pinned });
  }
  if (r.firstFlightOnly?.value) {
    chips.push({ field: 'first_flight_only', value: true, label: FIRST_FLIGHT_LABEL, pinned: r.firstFlightOnly.pinned });
  }
  if (r.failureType) {
    chips.push({ field: 'failure_type', value: r.failureType.value, label: FAILURE_TYPE_LABELS[r.failureType.value], pinned: r.failureType.pinned });
  }
  return chips;
}

/** The `<interpretations>` lines of the compose input. */
export function composeInterpretations(r: ReadingState): string[] {
  return [
    ...(r.timingWindow ? [timingWindowInterpretation(r.timingWindow.value)] : []),
    ...(r.firstFlightOnly?.value ? [FIRST_FLIGHT_INTERPRETATION] : []),
    ...(r.failureType ? [FAILURE_TYPE_INTERPRETATION[r.failureType.value]] : []),
  ];
}

/**
 * Apply the planner's default reading for a case search. Readings the reader pinned
 * win; category and phase readings are filters, not interpretations, and are ignored.
 */
export function withDefaultReading(r: ReadingState, ambiguity: Ambiguity | undefined): ReadingState {
  const value = ambiguity?.values[0];
  if (!ambiguity || value === undefined) return r;
  const out: ReadingState = { ...r };
  if (ambiguity.type === 'timing_window') {
    const t = parseTimingToken(value);
    if (t?.kind === 'window' && !r.timingWindow?.pinned) out.timingWindow = { value: t.window, pinned: false };
    if (t?.kind === 'first_flight' && !r.firstFlightOnly?.pinned) out.firstFlightOnly = { value: true, pinned: false };
  } else if (ambiguity.type === 'failure_type' && isFailureType(value) && !r.failureType?.pinned) {
    out.failureType = { value, pinned: false };
  }
  return out;
}

/** True when the reader already chose a reading of this ambiguity type. */
export function isPinned(r: ReadingState, type: Ambiguity['type']): boolean {
  if (type === 'timing_window') return r.timingWindow?.pinned === true || r.firstFlightOnly?.pinned === true;
  if (type === 'failure_type') return r.failureType?.pinned === true;
  return false;
}

// ---------------------------------------------------------------------------
// Clarification readings

const PHASES = FACET_VALUES.phase as readonly string[];
const CATEGORIES = FACET_VALUES.category as readonly string[];

/**
 * Two or three readings for a `needs_clarification` scope result, each a label from the
 * tables above and the refinement that picking it posts. Values without a template,
 * duplicates and anything past three are dropped; fewer than two readings means there
 * is nothing to offer (the caller then runs a normal search).
 */
export function clarificationReadings(ambiguity: Ambiguity, filters: BriefFilters): Reading[] {
  const out: Reading[] = [];
  const labels = new Set<string>();
  const add = (reading: Reading) => {
    if (out.length >= 3 || labels.has(reading.label)) return;
    labels.add(reading.label);
    out.push(reading);
  };
  for (const value of ambiguity.values) {
    switch (ambiguity.type) {
      case 'timing_window': {
        const t = parseTimingToken(value);
        if (t?.kind === 'window') add({ label: timingWindowLabel(t.window), refinement: { kind: 'interpretation', field: 'timing_window', value: t.window } });
        if (t?.kind === 'first_flight') add({ label: FIRST_FLIGHT_LABEL, refinement: { kind: 'interpretation', field: 'first_flight_only', value: true } });
        break;
      }
      case 'failure_type':
        if (isFailureType(value)) add({ label: FAILURE_TYPE_LABELS[value], refinement: { kind: 'interpretation', field: 'failure_type', value } });
        break;
      case 'aircraft_category':
        if (CATEGORIES.includes(value) && Object.hasOwn(CATEGORY_READING_LABEL, value)) {
          add({ label: CATEGORY_READING_LABEL[value]!, refinement: { kind: 'filters', filters: { ...filters, category: [value] } } });
        }
        break;
      case 'phase':
        if (PHASES.includes(value) && value !== 'blank') {
          add({ label: phaseReadingLabel(value as PhaseGroup), refinement: { kind: 'filters', filters: { ...filters, phase: [value] } } });
        }
        break;
    }
  }
  return out.length >= 2 ? out : [];
}

/** Every label a clarification can show (for tests: the reply is templates only). */
export function clarificationTemplateLabels(): { fixed: string[]; patterns: RegExp[] } {
  return {
    fixed: [
      FIRST_FLIGHT_LABEL,
      ...Object.values(FAILURE_TYPE_LABELS),
      ...Object.values(CATEGORY_READING_LABEL),
      ...(PHASES.filter((p) => p !== 'blank') as PhaseGroup[]).map(phaseReadingLabel),
    ],
    patterns: [/^Within \d{1,3} days?( or \d{1,3} flight hours?)?$/, /^Within \d{1,3} flight hours?$/],
  };
}
