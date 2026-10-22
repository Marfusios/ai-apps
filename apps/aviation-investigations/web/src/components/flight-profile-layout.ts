/**
 * Deterministic layout for the schematic flight profile (UI_DESIGN §2.5). Each
 * NTSB event-sequence step gets an equal horizontal slot and a schematic height
 * from its phase group. Nothing is to scale: heights only say "on the ground",
 * "climbing", "en route" and so on.
 *
 * Up to and including the defining event the flight is a smooth line of level
 * segments (drawn blue); after it, straight segments to each later step (drawn ink,
 * dashed). An impact step is placed on the ground and marked with an ✕.
 */
import { PHASE_LABEL, type PhaseGroup } from '../../../shared/codes.js';

export interface FlightProfileStep {
  phaseGroup: PhaseGroup;
  /** The event as published, e.g. "Loss of engine power (total)". */
  eventLabel: string;
  isDefining: boolean;
  /** An impact occurrence is coded for this step. */
  impact: boolean;
}

export type FlightProfileSize = 'mini' | 'full';

/** Schematic height, 0 (ground) to 1 (en route). */
export const PHASE_ALTITUDE: Readonly<Record<PhaseGroup, number>> = {
  prior_to_flight: 0,
  standing: 0,
  pushback: 0,
  taxi: 0,
  takeoff: 0.12,
  initial_climb: 0.55,
  en_route: 1,
  maneuvering: 0.72,
  approach: 0.42,
  landing: 0.1,
  emergency_descent: 0.34,
  uncontrolled_descent: 0.3,
  post_impact: 0,
  after_landing: 0,
  other: 0.6,
  unknown: 0.6,
};

/** Short uppercase phase names for the mono labels. */
export const PHASE_SHORT: Readonly<Record<PhaseGroup, string>> = {
  prior_to_flight: 'PREFLIGHT',
  standing: 'STANDING',
  pushback: 'PUSHBACK',
  taxi: 'TAXI',
  takeoff: 'TAKEOFF',
  initial_climb: 'INITIAL CLIMB',
  en_route: 'EN ROUTE',
  maneuvering: 'MANEUVERING',
  approach: 'APPROACH',
  landing: 'LANDING',
  emergency_descent: 'EMERG. DESCENT',
  uncontrolled_descent: 'UNCTL. DESCENT',
  post_impact: 'POST-IMPACT',
  after_landing: 'AFTER LANDING',
  other: 'OTHER',
  unknown: 'UNKNOWN PHASE',
};

export interface ProfileFrame {
  width: number;
  height: number;
  ground: number;
  ceiling: number;
  padLeft: number;
  padRight: number;
  /** Mono label size and its approximate advance per character. */
  labelSize: number;
  /** Event label above the defining dot. */
  eventSize: number;
  labels: boolean;
}

export const FRAMES = {
  mini: { width: 96, height: 28, ground: 25, ceiling: 8, padLeft: 2, padRight: 4, labelSize: 0, eventSize: 0, labels: false },
  full: { width: 480, height: 104, ground: 72, ceiling: 26, padLeft: 14, padRight: 14, labelSize: 9, eventSize: 10.5, labels: true },
  fullNarrow: { width: 300, height: 104, ground: 72, ceiling: 26, padLeft: 8, padRight: 8, labelSize: 8.5, eventSize: 10, labels: true },
} as const satisfies Record<string, ProfileFrame>;

export interface ProfileLabel {
  x: number;
  anchor: 'start' | 'middle' | 'end';
  /** 0: phase line under the ground; 1: event line under it. */
  row: 0 | 1;
  text: string;
}

export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DefiningMark {
  x: number;
  y: number;
  impact: boolean;
  /** Event label (full frames), centred on `labelX` with its baseline at `labelY`. */
  label: string;
  labelX: number;
  labelY: number;
  /** Approximate extent of the label text. */
  labelBox: Box;
  /** A leader from the label down to the ring, when the label had to be lifted. */
  leader: { y1: number; y2: number } | null;
}

export interface ProfileLayout {
  frame: ProfileFrame;
  /** Blue, solid: the flight up to the defining event (or all of it). */
  flown: string;
  /** Ink, dashed: after the defining event; null when nothing follows it. */
  after: string | null;
  origin: { x: number; y: number } | null;
  defining: DefiningMark | null;
  impacts: { x: number; y: number }[];
  labels: ProfileLabel[];
}

const round = (n: number): number => Math.round(n * 10) / 10;
const MONO_ADVANCE = 0.6;
const SANS_ADVANCE = 0.62;
/** Baseline of the defining label above the line or dot beneath it. */
const LABEL_LIFT = 13;
/** Ring radius around the defining dot, full frames. */
export const RING_RADIUS = 7.5;

type Point = readonly [x: number, y: number];

/**
 * The highest point (smallest y) of a polyline within [left, right]. Segments are
 * straight lines or curves with horizontal end tangents, which never leave the
 * box of their two end points, so the end points bound them.
 */
function highestOver(points: readonly Point[], left: number, right: number): number {
  let top = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1]!;
    const [x2, y2] = points[i]!;
    if (Math.max(x1, x2) >= left && Math.min(x1, x2) <= right) top = Math.min(top, y1, y2);
  }
  return top;
}

function truncate(text: string, maxChars: number): string {
  if (maxChars < 2) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function curve(fromX: number, fromY: number, toX: number, toY: number): string {
  if (fromY === toY) return `H${round(toX)}`;
  const mid = round(fromX + (toX - fromX) / 2);
  return `C${mid} ${round(fromY)} ${mid} ${round(toY)} ${round(toX)} ${round(toY)}`;
}

export function layoutProfile(steps: readonly FlightProfileStep[], frame: ProfileFrame): ProfileLayout {
  const { width, ground, ceiling, padLeft, padRight } = frame;
  const y = (step: FlightProfileStep): number =>
    step.impact ? ground : round(ground - PHASE_ALTITUDE[step.phaseGroup] * (ground - ceiling));

  if (steps.length === 0) {
    return { frame, flown: '', after: null, origin: null, defining: null, impacts: [], labels: [] };
  }

  const first = steps[0]!;
  const needsOrigin = y(first) !== ground;
  const lead = needsOrigin ? 0.75 : 0;
  const unit = (width - padLeft - padRight) / (steps.length + lead);
  const slotStart = (i: number): number => padLeft + (lead + i) * unit;
  const definingIndex = steps.findIndex((s) => s.isDefining);
  const lastFlown = definingIndex === -1 ? steps.length - 1 : definingIndex;

  // Anchor of each step: a level segment [a, b] or, for an impact, a point at mid-slot.
  const anchor = (i: number): { a: number; b: number; y: number } => {
    const s = steps[i]!;
    const start = slotStart(i);
    if (s.impact) {
      const mid = start + unit / 2;
      return { a: mid, b: mid, y: y(s) };
    }
    const a = i === 0 && !needsOrigin ? start : start + unit * 0.4;
    return { a, b: start + unit, y: y(s) };
  };

  const origin = needsOrigin ? { x: round(padLeft), y: ground } : null;
  let cx = origin ? origin.x : anchor(0).a;
  let cy = origin ? origin.y : anchor(0).y;
  let flown = `M${round(cx)} ${round(cy)}`;
  const knots: Point[] = [[cx, cy]];
  for (let i = 0; i <= lastFlown; i++) {
    const { a, b, y: sy } = anchor(i);
    if (a !== cx || sy !== cy) {
      flown += curve(cx, cy, a, sy);
      knots.push([a, sy]);
    }
    if (b !== a) {
      flown += `H${round(b)}`;
      knots.push([b, sy]);
    }
    cx = b;
    cy = sy;
  }

  let after: string | null = null;
  let defining: ProfileLayout['defining'] = null;
  if (definingIndex !== -1) {
    const step = steps[definingIndex]!;
    const afterKnots: Point[] = [[cx, cy]];
    if (definingIndex < steps.length - 1) {
      after = `M${round(cx)} ${round(cy)}`;
      for (let j = definingIndex + 1; j < steps.length; j++) {
        const point: Point = [slotStart(j) + unit / 2, y(steps[j]!)];
        after += `L${round(point[0])} ${round(point[1])}`;
        afterKnots.push(point);
      }
    }
    defining = definingMark(frame, step, cx, cy, [knots, afterKnots]);
  }

  const impacts = steps.flatMap((s, i) => {
    if (!s.impact) return [];
    const x = i <= lastFlown ? anchor(i).a : slotStart(i) + unit / 2;
    return [{ x: round(x), y: ground }];
  });

  const labels: ProfileLabel[] = [];
  if (frame.labels) {
    // Labels sit on slot centres and never exceed their slots, so they cannot overlap.
    const centre = (i: number): number => slotStart(i) + unit / 2;
    const place = (x: number, text: string, row: 0 | 1): void => {
      if (text === '') return;
      const half = (text.length * frame.labelSize * MONO_ADVANCE) / 2;
      if (x - half < 0) labels.push({ x: round(Math.max(x - unit / 2, 0)), anchor: 'start', row, text });
      else if (x + half > width) labels.push({ x: round(Math.min(x + unit / 2, width)), anchor: 'end', row, text });
      else labels.push({ x: round(x), anchor: 'middle', row, text });
    };
    const maxChars = (slots: number): number => Math.floor((slots * unit - 10) / (frame.labelSize * MONO_ADVANCE));
    // One phase label per run of steps in the same phase group, centred on the run.
    for (let i = 0; i < steps.length; ) {
      let run = 1;
      while (i + run < steps.length && steps[i + run]!.phaseGroup === steps[i]!.phaseGroup) run++;
      const x = (centre(i) + centre(i + run - 1)) / 2;
      place(x, truncate(PHASE_SHORT[steps[i]!.phaseGroup], maxChars(run)), 0);
      i += run;
    }
    // The defining event is labelled above its dot; other events go under their phase.
    steps.forEach((s, i) => {
      const event = s.eventLabel.toUpperCase();
      if (s.isDefining || event === PHASE_SHORT[s.phaseGroup] || event === PHASE_LABEL[s.phaseGroup].toUpperCase()) return;
      place(centre(i), truncate(event, maxChars(1)), 1);
    });
  }

  return { frame, flown, after, origin, defining, impacts, labels };
}

/**
 * Places the defining event's label centred over its dot. When a line within the
 * label's width rises above the dot (a descent or impact into the defining event,
 * or a climb after it), the label is lifted above that line and a leader joins it
 * to the ring, so text never crosses the profile.
 */
function definingMark(
  frame: ProfileFrame,
  step: FlightProfileStep,
  x: number,
  y: number,
  lines: readonly (readonly Point[])[],
): DefiningMark {
  const advance = frame.eventSize * SANS_ADVANCE;
  const label = advance > 0 ? truncate(step.eventLabel, Math.floor((frame.width - 8) / advance)) : '';
  const half = (label.length * advance) / 2;
  const labelX = Math.min(Math.max(x, half + 2), frame.width - half - 2);
  const top = Math.min(y, ...lines.map((line) => highestOver(line, labelX - half, labelX + half)));
  const labelY = Math.max(frame.eventSize, top - LABEL_LIFT);
  const lifted = labelY < y - LABEL_LIFT;
  return {
    x: round(x),
    y: round(y),
    impact: step.impact,
    label,
    labelX: round(labelX),
    labelY: round(labelY),
    labelBox: {
      x1: round(labelX - half),
      y1: round(labelY - frame.eventSize * 0.8),
      x2: round(labelX + half),
      y2: round(labelY + frame.eventSize * 0.25),
    },
    leader: lifted && label ? { y1: round(labelY + 4), y2: round(y - RING_RADIUS - 1.5) } : null,
  };
}

/** "Schematic flight profile, not to scale: …" with every step in words. */
export function profileAccessibleName(steps: readonly FlightProfileStep[]): string {
  const prefix = 'Schematic flight profile, not to scale: ';
  if (steps.length === 0) return `${prefix}no event sequence on record.`;
  const parts = steps.map((s) =>
    [PHASE_LABEL[s.phaseGroup], s.eventLabel, s.isDefining && 'defining event', s.impact && 'impact']
      .filter(Boolean)
      .join(', '),
  );
  return `${prefix}${parts.join('; then ')}.`;
}

/** The mono caption beside a mini profile: "PHASE · DEFINING EVENT". */
export function profileCaption(steps: readonly FlightProfileStep[]): string {
  const key = steps.find((s) => s.isDefining) ?? steps[0];
  if (!key) return 'NO EVENT SEQUENCE';
  return `${PHASE_SHORT[key.phaseGroup]} · ${key.eventLabel.toUpperCase()}`;
}
