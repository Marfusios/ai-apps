/**
 * Neutral report paragraphs for the synthetic narrative controls (Track N calibration):
 * the weather observations, airport, site, wreckage layout, emergency response, survival
 * and organizational details that make a record read like a real NTSB report and give
 * the judge something to read past. None of them states anything a Track N rubric turns
 * on: no engine, power, examination, malfunction or failure statement, no maintenance or
 * inspection, no pilot certificate, instruction or student, no tower or radio frequency,
 * no fire, no recorded flight data, no landing gear and no propeller. Deterministic for
 * a seed (`mulberry32`), so a record built from them keeps its fingerprint.
 *
 * Long records (`longFiller`) reach past the 12,000-token chunk budget with hourly
 * weather observations, site and wreckage-layout details and generic background, so the
 * decisive sentences of a long control land in different parts of the record.
 */
import { mulberry32 } from '../../experiments/stats.js';
import { sha256 } from '../spec.js';

export interface FillerPlace {
  /** The airport or nearest town the paragraphs name, and the weather station's identifier. */
  airport: string;
  station: string;
  /** Field elevation in feet. */
  elevation: number;
  /** Temperatures for the weather observations (°C); the dew point is kept 9 to 14 °C below. */
  temperature: number;
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const int = (rand: () => number, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const rng = (seed: string): (() => number) => mulberry32(parseInt(sha256(seed).slice(0, 8), 16));

const DIRECTIONS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const SURFACES = ['asphalt', 'concrete', 'asphalt and concrete'];
const TERRAIN = ['a harvested hayfield', 'a pasture bordered by a drainage ditch', 'gently rolling farmland', 'a gravel road and the field beside it', 'a soybean field', 'an open field with tall grass', 'a fallow field crossed by a dirt track'];

/** One hourly weather observation sentence (no ceiling, no reduced visibility: visual conditions). */
function observation(rand: () => number, place: FillerPlace, hour: number): string {
  const t = place.temperature + int(rand, -2, 2);
  const dew = t - int(rand, 9, 14);
  const wind = int(rand, 0, 35) * 10;
  const speed = int(rand, 3, 12);
  return (
    `At ${String(hour).padStart(2, '0')}${pick(rand, ['53', '55', '56'])}, the automated weather observation at ${place.station} recorded wind from ${String(wind).padStart(3, '0')}° at ${speed} knots, ` +
    `visibility 10 statute miles, ${pick(rand, ['clear sky', 'a few clouds at 6,500 ft above ground level', 'scattered clouds at 8,000 ft above ground level'])}, temperature ${t}°C, dew point ${dew}°C, and an altimeter setting of ${(29.85 + rand() * 0.3).toFixed(2)} inches of mercury.`
  );
}

/** A paragraph of a given topic. */
function paragraph(rand: () => number, place: FillerPlace, topic: number): string {
  switch (topic % 9) {
    case 0:
      return `${place.airport} is at an elevation of ${place.elevation.toLocaleString('en-US')} ft. It has ${pick(rand, ['one runway', 'two runways'])}; runway ${String(int(rand, 1, 18)).padStart(2, '0')}/${String(int(rand, 19, 36))} is ${(int(rand, 3, 6) * 1_000 + int(rand, 0, 9) * 100).toLocaleString('en-US')} ft long and ${int(rand, 6, 15) * 10} ft wide, with an ${pick(rand, SURFACES)} surface. The runway is equipped with medium-intensity edge lights, and a segmented circle and wind cone are located ${pick(rand, ['near midfield', 'west of the runway', 'beside the ramp'])}.`;
    case 1:
      return `The accident site was located in ${pick(rand, TERRAIN)} about ${(rand() * 3 + 0.4).toFixed(1)} miles ${pick(rand, DIRECTIONS)} of ${place.airport}, at an elevation of about ${place.elevation + int(rand, -60, 60)} ft. The first ground mark was a ${int(rand, 8, 40)}-ft-long furrow on a magnetic heading of about ${String(int(rand, 1, 36) * 10).padStart(3, '0')}°, and the main wreckage came to rest ${int(rand, 40, 220)} ft beyond it.`;
    case 2:
      return `The left wing remained attached to the fuselage; its leading edge was crushed aft along the outboard ${int(rand, 3, 9)} ft. The right wing was ${pick(rand, ['bent upward near midspan', 'separated at the wing root and found 25 ft from the fuselage', 'wrinkled along its upper skin'])}. The empennage was intact, and the horizontal stabilizer and elevator showed ${pick(rand, ['minor impact damage', 'no damage', 'a dent near the right tip'])}.`;
    case 3:
      return `First responders from the ${pick(rand, ['county sheriff\'s office', 'local volunteer rescue squad', 'state highway patrol'])} arrived about ${int(rand, 9, 30)} minutes after the accident. ${pick(rand, ['The occupants had exited the airplane on their own.', 'A passerby had helped the occupants away from the wreckage.', 'The occupants were assisted out of the cabin by responders.'])} The occupants were taken to a hospital in ${pick(rand, ['a nearby city', 'the county seat', 'a regional medical center'])} for evaluation.`;
    case 4:
      return `The seats and their attachments remained in place, and the ${pick(rand, ['lap belts and shoulder harnesses', 'four-point restraints', 'lap belts'])} were found unlatched by rescue personnel. The cabin structure was ${pick(rand, ['largely intact', 'deformed around the forward doorpost', 'compressed at the lower forward fuselage'])}, and the occupiable space was ${pick(rand, ['maintained', 'mostly maintained', 'reduced on the left side'])}.`;
    case 5:
      return `The operator ${pick(rand, ['had been in business for 14 years', 'was a family-owned company founded in 2003', 'had moved its base of operations to the airport two years before the accident'])} and ${pick(rand, ['employed six pilots', 'operated three airplanes', 'flew mostly during the summer months'])}. Its owner stated that the company's pilots completed a written company procedures review each spring and that flights were dispatched by telephone.`;
    case 6:
      return `The sunrise on the day of the accident was at ${int(rand, 5, 6)}:${String(int(rand, 10, 59)).padStart(2, '0')}, and the sunset was at ${int(rand, 19, 20)}:${String(int(rand, 10, 59)).padStart(2, '0')}. The moon was ${pick(rand, ['a waxing crescent', 'a waning gibbous', 'full', 'a first-quarter moon'])}, and its illumination was ${int(rand, 10, 99)} percent.`;
    case 7:
      return `The airplane was recovered to a secure storage facility in ${pick(rand, ['a nearby town', 'the county', 'the region'])}, where it was ${pick(rand, ['laid out by section', 'placed on a flatbed trailer', 'stored indoors'])} for the investigation. Photographs taken at the site documented the position of the cabin doors, the wing flap ${pick(rand, ['handle', 'indicator'])} and the cockpit switches.`;
    default:
      return `Federal Aviation Administration guidance published in ${pick(rand, ['the Pilot\'s Handbook of Aeronautical Knowledge', 'the Airplane Flying Handbook', 'Advisory Circular 91-79'])} describes ${pick(rand, ['the hazards of low-altitude maneuvering', 'how to plan an approach to an unfamiliar field', 'the effect of wind on groundspeed during turns', 'how to brief passengers before departure'])} and recommends that pilots ${pick(rand, ['plan for an alternate course of action before every flight', 'review the airport diagram before each departure', 'maintain situational awareness of nearby terrain', 'brief passengers on seatbelt use and exits'])}.`;
  }
}

/** `count` neutral paragraphs for a record of realistic length (module comment). */
export function fillerParagraphs(seed: string, place: FillerPlace, count: number): string[] {
  const rand = rng(seed);
  const start = int(rand, 0, 8);
  return Array.from({ length: count }, (_, i) => paragraph(rand, place, start + i));
}

/**
 * A long run of neutral text for a long record (module comment): about `paragraphs`
 * paragraphs, each of several observations or details, joined by blank lines.
 */
export function longFiller(seed: string, place: FillerPlace, paragraphs: number): string {
  const rand = rng(`${seed}|long`);
  const out: string[] = [];
  let hour = 0;
  for (let i = 0; i < paragraphs; i += 1) {
    if (i % 3 === 0) {
      const lines = Array.from({ length: 5 }, () => observation(rand, place, (hour++ % 24)));
      out.push(lines.join(' '));
    } else {
      out.push([paragraph(rand, place, int(rand, 0, 8)), paragraph(rand, place, int(rand, 0, 8))].join(' '));
    }
  }
  return out.join('\n\n');
}

/** Words the filler never uses (a test checks every generated paragraph). */
export const FILLER_FORBIDDEN = /\b(engine|power|examin|anomal|malfunction|fail|maintenance|inspect|overhaul|certificat|student|instruct|tower|frequency|ctaf|fire|smoke|data|gps|ads-b|radar|gear|propeller|rotor|brake|annual|hobbs|tachometer|carburetor|icing|fuel)\w*/i;
