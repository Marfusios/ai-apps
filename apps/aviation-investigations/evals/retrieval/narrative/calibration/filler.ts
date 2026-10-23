/**
 * Neutral report paragraphs for the synthetic narrative controls (Track N calibration):
 * the airport, the land around it, its history, the notification of the investigation and
 * general Federal Aviation Administration guidance, which make a record read like a real
 * NTSB report and give the judge something to read past.
 *
 * **Neutral** (fix round 2, review M7 and N5): a paragraph says nothing about the
 * accident, so it cannot contradict any record. It never describes the accident site,
 * the wreckage or any damage, the occupants or injuries, the time of day or the light,
 * the aircraft or any of its parts, and it never states anything a Track N rubric turns
 * on: no engine, power, examination, malfunction or failure, no maintenance, inspection
 * or clock, no pilot certificate, instruction or student, no tower, radio or traffic
 * pattern, no fire, no recorded data, no landing gear, propeller or rotor, no wires or
 * loads, no cause or certainty (`FILLER_FORBIDDEN`, checked by a test on every paragraph).
 * Guidance names the handbook of the record's kind of aircraft (`Vehicle`).
 *
 * Long records (`longFiller`) reach past the 12,000-token chunk budget with automated
 * weather observations at the airport (visual conditions; the only paragraphs with
 * weather words, `WEATHER_WORDS`) between the same neutral paragraphs, so the decisive
 * sentences of a long control land in different parts of the record. Deterministic for a
 * seed (`mulberry32`), so a record built from them keeps its fingerprint.
 */
import { mulberry32 } from '../../experiments/stats.js';
import { sha256 } from '../spec.js';

export interface FillerPlace {
  /** The airport the paragraphs describe, and its weather station's identifier. */
  airport: string;
  station: string;
  /** Field elevation in feet. */
  elevation: number;
  /** Temperatures for the weather observations of long records (°C); the dew point is kept 9 to 14 °C below. */
  temperature: number;
  /** The land around the airport (never the accident site). */
  area: string;
}

/** The kind of aircraft a record is about: guidance names its handbook (`aircraft` when an event involves both kinds). */
export type Vehicle = 'airplane' | 'helicopter' | 'aircraft';

/** The record's kind of aircraft from its aircraft categories. */
export const vehicleOf = (categories: readonly string[]): Vehicle =>
  categories.every((c) => c === 'HELI') ? 'helicopter' : categories.every((c) => c === 'AIR') ? 'airplane' : 'aircraft';

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const int = (rand: () => number, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const rng = (seed: string): (() => number) => mulberry32(parseInt(sha256(seed).slice(0, 8), 16));

const SIDES = ['north', 'east', 'south', 'west'];
const HANDBOOKS: Readonly<Record<Vehicle, readonly string[]>> = {
  airplane: ['the Airplane Flying Handbook', "the Pilot's Handbook of Aeronautical Knowledge"],
  helicopter: ['the Helicopter Flying Handbook', "the Pilot's Handbook of Aeronautical Knowledge"],
  aircraft: ["the Pilot's Handbook of Aeronautical Knowledge"],
};
const GUIDANCE_TOPICS: Readonly<Record<Vehicle, readonly string[]>> = {
  airplane: ['how to use checklists', 'how to read airport signs and markings', 'how to manage workload', 'how to plan an arrival at an unfamiliar airport'],
  helicopter: ['how to use checklists', 'how to manage workload', 'how to plan an arrival at an unfamiliar landing area', 'how to read airport signs and markings'],
  aircraft: ['how to use checklists', 'how to read airport signs and markings', 'how to manage workload'],
};
const GUIDANCE_ADVICE = ['review the airport diagram before each departure', 'use a written checklist', 'plan an alternate course of action before departure', 'set aside time to study the local procedures of an unfamiliar airport'];

/** One automated weather observation sentence (visual conditions; long records only). */
function observation(rand: () => number, place: FillerPlace, hour: number): string {
  const t = place.temperature + int(rand, -2, 2);
  const dew = t - int(rand, 9, 14);
  const wind = int(rand, 0, 35) * 10;
  const speed = int(rand, 3, 12);
  return (
    `At ${String(hour).padStart(2, '0')}${pick(rand, ['53', '55', '56'])}, the automated weather observation at ${place.station} included wind from ${String(wind).padStart(3, '0')}° at ${speed} knots, ` +
    `visibility 10 statute miles, ${pick(rand, ['clear sky', 'a few clouds at 6,500 ft above ground level', 'scattered clouds at 8,000 ft above ground level'])}, temperature ${t}°C, dew point ${dew}°C, and an altimeter setting of ${(29.85 + rand() * 0.3).toFixed(2)} inches of mercury.`
  );
}

/** A neutral paragraph of a given topic (module comment). */
function paragraph(rand: () => number, place: FillerPlace, vehicle: Vehicle, topic: number): string {
  switch (topic % 5) {
    case 0:
      return `${place.airport} is a public-use airport at an elevation of ${place.elevation.toLocaleString('en-US')} ft, owned by ${pick(rand, ['the city', 'the county', 'an airport authority'])}. Its runways have ${pick(rand, ['asphalt', 'concrete', 'asphalt and concrete'])} surfaces, and its ${pick(rand, ['administration building', 'terminal building'])} stands on the ${pick(rand, SIDES)} side of the airport.`;
    case 1:
      return `The land around ${place.airport} is ${place.area}. The nearest ${pick(rand, ['state highway', 'county road', 'interstate highway'])} passes about ${(rand() * 2 + 0.5).toFixed(1)} miles to the ${pick(rand, SIDES)}.`;
    case 2:
      return `The airport opened in ${int(rand, 1938, 1975)} and is home to about ${int(rand, 4, 22) * 10} based aircraft. Its ${pick(rand, ['administration building', 'terminal building'])} was built in ${int(rand, 1962, 2015)}, and a ${pick(rand, ['restaurant', 'museum', 'pilot shop'])} at the airport is open ${pick(rand, ['on weekends', 'every day', 'from spring to fall'])}.`;
    case 3:
      return `The National Transportation Safety Board was notified of the accident by the Federal Aviation Administration ${pick(rand, ['the same day', 'within a day'])}${pick(rand, ['', ', and the Federal Aviation Administration was a party to the investigation'])}.`;
    default:
      return `Federal Aviation Administration guidance in ${pick(rand, HANDBOOKS[vehicle])} describes ${pick(rand, GUIDANCE_TOPICS[vehicle])} and recommends that pilots ${pick(rand, GUIDANCE_ADVICE)}.`;
  }
}

/** `count` neutral paragraphs for a record of realistic length (module comment). */
export function fillerParagraphs(seed: string, place: FillerPlace, count: number, vehicle: Vehicle = 'airplane'): string[] {
  const rand = rng(seed);
  const start = int(rand, 0, 4);
  return Array.from({ length: count }, (_, i) => paragraph(rand, place, vehicle, start + i));
}

/**
 * A long run of neutral text for a long record (module comment): about `paragraphs`
 * paragraphs, every third one five weather observations, the others two neutral
 * paragraphs each, joined by blank lines.
 */
export function longFiller(seed: string, place: FillerPlace, paragraphs: number, vehicle: Vehicle = 'airplane'): string {
  const rand = rng(`${seed}|long`);
  const out: string[] = [];
  let hour = 0;
  for (let i = 0; i < paragraphs; i += 1) {
    if (i % 3 === 0) {
      const lines = Array.from({ length: 5 }, () => observation(rand, place, hour++ % 24));
      out.push(lines.join(' '));
    } else {
      out.push([paragraph(rand, place, vehicle, int(rand, 0, 4)), paragraph(rand, place, vehicle, int(rand, 0, 4))].join(' '));
    }
  }
  return out.join('\n\n');
}

/**
 * Words no neutral paragraph uses (a test checks every generated paragraph): what the
 * rubrics turn on, the accident and its aftermath, the aircraft and its parts, the time of
 * day, causes and certainty, and speakers.
 */
export const FILLER_FORBIDDEN =
  /\b(engine|power|examin|anomal|malfunction|fail|maintenance|inspect|overhaul|repair|replac|install|adjust|rigg|hour|hobbs|tachometer|clock|annual|first|second|certificat|student|instruct|tower|towered|frequency|ctaf|radio|pattern|control|clearance|fire|smoke|data|gps|ads-b|radar|record|video|camera|photo|gear|propeller|rotor|brake|fuel|carburetor|icing|wing|elevator|stabiliz|aileron|rudder|flap|fuselage|empennage|cabin|seat|restraint|occupant|passenger|injur|fatal|hospital|damage|destroy|wreck|impact|crash|site|terrain|field|collid|collision|struck|strik|contact|taxi|park|ramp|hangar|wire|line|cable|pole|load|sling|hook|race|show|aerobatic|night|dark|moon|sunset|sunrise|dusk|dawn|light|flight|determin|likely|probab|possib|cause|reason|unknown|stated|reported|said|told|according)\w*/i;

/** Weather words: only the observation sentences of long records use them. */
export const WEATHER_WORDS = /\b(wind|visibility|cloud|temperature|dew|altimeter|weather)\w*/i;
