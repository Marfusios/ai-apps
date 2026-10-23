/**
 * Narrative controls of the Track N judge calibration (task 10c protocol v4, section 3):
 * balanced, deliberately hard synthetic records for negation, chronology (inside or
 * outside a window, approximate values, clocks and anchors, flight ordinals), pilot
 * statement against investigator finding, cross-aircraft attribution in multi-aircraft
 * events (event-scoped and aircraft-scoped sections), causal uncertainty, bundle
 * answerability against complete-record relevance (`controls-bundles.ts`) and long
 * records judged in parts (`controls-long.ts`).
 *
 * Every record is written for the purpose in the style of an NTSB report and is not a
 * real case: its case number has the real format with a sequence of 900 or above, which
 * no case of the data uses (the calibration builder checks every number against the
 * generation). Each group is a set of minimal variants of one base record: the variants
 * change the sentences that decide the grade, so each label is **constructed** (known by
 * how the record was built) under the rubric of the development question it names;
 * `anchors` are the exact sentences the label rests on, and the builder checks they are
 * in the record. No label is an expert's.
 *
 * **Reading.** `reading: 'edge-case'` marks a control whose deciding situation is one the
 * rubric spells out (an edge case or a clause the judge sees in its prompt): it tests
 * lookup. `reading: 'novel'` marks one the rubric does not spell out: the judge has to
 * read the record and apply the rubric. The report breaks accuracy down by both.
 *
 * Fix round 1 (the gate's items 1, 4 and 8, the review's I4 and M7): the chronology
 * controls keep clocks and flight ordinals apart, the ambiguous tail rotor record is
 * unambiguous, the occurrence rows match the narratives, every control family has at
 * least 8 holdout items in groups of their own, and causal uncertainty, aircraft-scoped
 * attribution, answerability and long records have controls.
 */
import type { Grade } from '../spec.js';
import { fillerParagraphs, type FillerPlace } from './filler.js';

export const CONTROL_FAMILIES = ['negation', 'chronology', 'pilot_vs_investigator', 'cross_aircraft', 'causal_uncertainty', 'answerability', 'long_record'] as const;
export type ControlFamily = (typeof CONTROL_FAMILIES)[number];

export interface ControlAircraft {
  make: string;
  model: string;
  category: string;
  farPart: string;
  purpose: string;
  phase: string;
  engine: string;
}

export interface ControlRecord {
  ntsbNo: string;
  date: string;
  city: string;
  state: string;
  aircraft: ControlAircraft[];
  /** Section texts: with one aircraft they are aircraft-scoped, with several event-scoped. May hold `{{fill:<key>}}` (long records). */
  factual: string;
  analysis: string;
  probableCause: string;
  /** Factual sections scoped to one aircraft of a multi-aircraft event, after the event-scoped one (S2, S3, ...). */
  aircraftSections?: { aircraft: number; text: string }[];
  /** Header facts other than the defaults (minor injuries, daylight, visual conditions). */
  event?: { highestInjury?: string; light?: string; weather?: string };
  findings: { aircraft: number; code: string; description: string; inProbableCause: boolean }[];
  occurrences: { aircraft: number; code: string; phase: string; description: string; defining: boolean }[];
}

export interface Control {
  id: string;
  family: ControlFamily;
  /** How the variant was made (one per family member). */
  mutation: string;
  /** The development question (and rubric) the label is under. */
  question: string;
  label: Grade;
  /** What is judged: case relevance on the complete record (default), or answerability of `bundle`. */
  kind?: 'relevance' | 'answerability';
  /** Answerability: the delivered passages, each an exact, unique stretch of one section (`S1`, `S2`, ...). */
  bundle?: { section: string; text: string }[];
  /** Whether the rubric spells out the deciding situation (module comment). */
  reading: 'edge-case' | 'novel';
  record: ControlRecord;
  /** Sentences of the record the label rests on (checked verbatim). */
  anchors: string[];
  /** Long records: the part (1-based) of the chunked record each anchor must lie in (checked). */
  anchorParts?: number[];
  note: string;
}

/** Realistic-length context: neutral paragraphs around the deciding sentences (filler.ts). */
export const context = (seed: string, place: FillerPlace, count: number): string => fillerParagraphs(seed, place, count).join('\n\n');

const C182 = (purpose: string, phase = 'initial_climb'): ControlAircraft => ({ make: 'Cessna', model: '182P', category: 'AIR', farPart: '091', purpose, phase, engine: 'REC' });

// ---------------------------------------------------------------------------
// Negation (dev: neg-skyd, neg-carb; holdout: neg-gear and controls-reading's neg-jump)

const HOLLISTER: FillerPlace = { airport: 'Hollister Municipal Airport', station: 'KCVH', elevation: 230, temperature: 27 };
const SKYD_START =
  'The commercial pilot was flying the airplane on a skydiving flight with four parachutists on board. The pilot reported that, during the climb through about 1,500 ft above ground level, the engine lost total power. He turned back toward the airport and landed in a plowed field short of the runway, where the airplane nosed over.';
const skydivingRecord = (id: string, exam: string, analysis: string, probable: string, findings: ControlRecord['findings'] = []): ControlRecord => ({
  ntsbNo: id,
  date: '2021-07-17',
  city: 'Hollister',
  state: 'CA',
  aircraft: [C182('SKYD')],
  factual: `${SKYD_START}\n\n${context(id, HOLLISTER, 2)}\n\n${exam}`,
  analysis,
  probableCause: probable,
  findings: findings.length > 0 ? findings : [{ aircraft: 1, code: '0105850000', description: 'Aircraft-Aircraft power plant-Engine (reciprocating)-(general)-Unknown/Not determined', inProbableCause: true }],
  occurrences: [
    { aircraft: 1, code: '341', phase: 'initial_climb', description: 'Initial climb Loss of engine power (total)', defining: true },
    { aircraft: 1, code: '440', phase: 'emergency_descent', description: 'Emergency descent Off-field or emergency landing', defining: false },
  ],
});

const CYLINDER_FATIGUE = { aircraft: 1, code: '0105853006', description: 'Aircraft-Aircraft power plant-Engine (reciprocating)-Recip eng cylinder section-Fatigue/wear/corrosion', inProbableCause: true };

const OTTUMWA: FillerPlace = { airport: 'Ottumwa Regional Airport', station: 'KOTM', elevation: 846, temperature: 12 };
const carbRecord = (
  id: string,
  phaseSentence: string,
  weather: string,
  probable: string,
  over: { model?: string; phase?: 'en_route' | 'approach'; occurrence?: string } = {},
): ControlRecord => ({
  ntsbNo: id,
  date: '2019-03-09',
  city: 'Ottumwa',
  state: 'IA',
  aircraft: [{ make: 'Piper', model: over.model ?? 'PA-28-161', category: 'AIR', farPart: '091', purpose: 'PERS', phase: over.phase ?? 'en_route', engine: 'REC' }],
  factual: `The private pilot was on a cross-country personal flight. ${phaseSentence} He was unable to restore power and made a forced landing in a pasture, during which the left wing struck a fence post.\n\n${context(id, OTTUMWA, 1)}\n\nThe engine was examined after the accident and no mechanical anomalies were found.`,
  analysis: weather,
  probableCause: probable,
  findings: [],
  occurrences: [{ aircraft: 1, code: '342', phase: over.phase ?? 'en_route', description: over.occurrence ?? 'Enroute-cruise Loss of engine power (partial)', defining: true }],
});

const KERRVILLE: FillerPlace = { airport: 'Kerrville Municipal Airport', station: 'KERV', elevation: 1617, temperature: 31 };
const gearRecord = (id: string, exam: string, probable: string, report = ''): ControlRecord => ({
  ntsbNo: id,
  date: '2016-08-21',
  city: 'Kerrville',
  state: 'TX',
  aircraft: [{ make: 'Beech', model: 'A36', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'landing', engine: 'REC' }],
  factual: `The pilot reported that the airplane touched down firmly on the nose wheel and bounced. On the second touchdown the nose landing gear collapsed and the airplane slid to a stop on the runway, which resulted in substantial damage to the forward fuselage.${report ? ` ${report}` : ''}\n\n${context(id, KERRVILLE, 2)}${exam ? `\n\n${exam}` : ''}`,
  analysis: 'The pilot did not maintain the proper landing attitude during the touchdown, which resulted in a hard landing.',
  probableCause: probable,
  findings: [],
  occurrences: [{ aircraft: 1, code: '090', phase: 'landing', description: 'Landing Abnormal runway contact', defining: true }],
});

export const NEGATION_CONTROLS: readonly Control[] = [
  {
    id: 'neg-skyd-no-anomaly',
    family: 'negation',
    mutation: 'base',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 2,
    reading: 'edge-case',
    record: skydivingRecord(
      'WPR21LA901',
      'Postaccident examination of the engine revealed no mechanical malfunctions or anomalies that would have precluded normal operation. The fuel tanks contained about 20 gallons of fuel.',
      'The pilot reported a total loss of engine power during the climb. The postaccident examination of the engine did not reveal any mechanical malfunctions or anomalies that would have precluded normal operation, and the reason for the loss of power could not be determined.',
      'A total loss of engine power during the initial climb for reasons that could not be determined because postaccident examination did not reveal any anomalies.',
    ),
    anchors: ['Postaccident examination of the engine revealed no mechanical malfunctions or anomalies that would have precluded normal operation.'],
    note: "Power loss, and the investigators' examination of the engine found nothing: every grade-2 condition.",
  },
  {
    id: 'neg-skyd-anomaly-found',
    family: 'negation',
    mutation: 'contradiction',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 0,
    reading: 'edge-case',
    record: skydivingRecord(
      'WPR21LA902',
      'Postaccident examination of the engine revealed that the No. 3 cylinder exhaust valve had fractured, and pieces of the valve head were found in the cylinder. The fracture surface showed features consistent with fatigue.',
      'The pilot reported a total loss of engine power during the climb. The examination found a fatigue fracture of the No. 3 cylinder exhaust valve, which resulted in the loss of power.',
      'A total loss of engine power during the initial climb due to a fatigue fracture of an exhaust valve.',
      [CYLINDER_FATIGUE],
    ),
    anchors: ['Postaccident examination of the engine revealed that the No. 3 cylinder exhaust valve had fractured'],
    note: 'The examination found a pre-existing failure: grade 0 under the rubric.',
  },
  {
    id: 'neg-skyd-not-examined',
    family: 'negation',
    mutation: 'not_examined',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 1,
    reading: 'edge-case',
    record: skydivingRecord(
      'WPR21LA903',
      'A postimpact fire consumed most of the engine compartment, and the engine could not be examined in detail. No fuel was recovered from the wreckage.',
      'The pilot reported a total loss of engine power during the climb. Because of the fire damage, the engine could not be examined, and the reason for the loss of power could not be determined.',
      'A total loss of engine power during the initial climb for reasons that could not be determined because the engine was destroyed by the postimpact fire.',
    ),
    anchors: ['the engine could not be examined in detail'],
    note: 'Power loss with the examination result unknown: partial.',
  },
  {
    id: 'neg-skyd-airframe-only',
    family: 'negation',
    mutation: 'scope_of_negation',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 1,
    reading: 'edge-case',
    record: skydivingRecord(
      'WPR21LA904',
      'Examination of the airframe and flight control systems revealed no anomalies. The engine was retained by the operator, and the investigation did not examine it.',
      'The pilot reported a total loss of engine power during the climb. The airframe showed no anomalies; the engine was not examined.',
      'A total loss of engine power during the initial climb for reasons that could not be determined because the engine was not examined.',
    ),
    anchors: ['Examination of the airframe and flight control systems revealed no anomalies.', 'the investigation did not examine it'],
    note: 'The "no anomalies" statement covers the airframe only: partial, a negation-scope trap.',
  },
  {
    id: 'neg-skyd-no-anomalies-other-than',
    family: 'negation',
    mutation: 'embedded_exception',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 0,
    reading: 'novel',
    record: skydivingRecord(
      'WPR21LA905',
      'Postaccident examination of the engine revealed no anomalies other than a crack in the No. 2 cylinder head, which showed evidence of pre-existing fatigue and through which compression had been lost.',
      'The pilot reported a total loss of engine power during the climb. The fatigue crack in the No. 2 cylinder head resulted in a loss of compression and the loss of engine power.',
      'A total loss of engine power during the initial climb due to a fatigue crack in a cylinder head.',
      [CYLINDER_FATIGUE],
    ),
    anchors: ['revealed no anomalies other than a crack in the No. 2 cylinder head'],
    note: '"No anomalies other than" a pre-existing crack: an anomaly was found, grade 0; a negation that does not negate.',
  },
  {
    id: 'neg-skyd-fuel-exhaustion-engine-ok',
    family: 'negation',
    mutation: 'other_reason',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 2,
    reading: 'edge-case',
    record: skydivingRecord(
      'WPR21LA906',
      'Postaccident examination of the engine revealed no evidence of preimpact mechanical malfunction. Both fuel tanks were intact and empty, and no fuel was found in the fuel lines or the carburetor bowl.',
      'The pilot did not refuel before the third flight of the day and the engine lost power due to fuel exhaustion. The engine showed no evidence of a mechanical malfunction.',
      "The pilot's inadequate fuel planning, which resulted in a total loss of engine power due to fuel exhaustion.",
      [{ aircraft: 1, code: '0206103044', description: 'Personnel issues-Task performance-Planning/preparation-Fuel planning-Pilot', inProbableCause: true }],
    ),
    anchors: ['Postaccident examination of the engine revealed no evidence of preimpact mechanical malfunction.'],
    note: 'The rubric allows a reason other than an engine defect: the engine was found sound, grade 2 (an edge case of the rubric).',
  },
  {
    id: 'neg-skyd-pilot-statement-only',
    family: 'negation',
    mutation: 'wrong_speaker',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 1,
    reading: 'edge-case',
    record: skydivingRecord(
      'WPR21LA907',
      'In a written statement, the pilot reported that there were no mechanical malfunctions or failures with the airplane before the flight. The airplane was repaired by the operator, and the engine was not examined by the investigation.',
      'The pilot reported a total loss of engine power during the climb. The reason for the loss of power could not be determined because the engine was not examined.',
      'A total loss of engine power during the initial climb for reasons that could not be determined.',
    ),
    anchors: ['the pilot reported that there were no mechanical malfunctions or failures with the airplane before the flight', 'the engine was not examined by the investigation'],
    note: "Only the pilot says nothing was wrong; the investigators did not examine the engine: partial (review I3c's pattern).",
  },
  {
    id: 'neg-carb-not-conducive',
    family: 'negation',
    mutation: 'base',
    question: 'ng-carb-icing-not-conducive',
    label: 2,
    reading: 'edge-case',
    record: carbRecord(
      'CEN19LA911',
      'While in cruise flight at 4,500 ft, the engine began to run rough and lost partial power.',
      'The temperature and dew point recorded near the time of the accident were not conducive to carburetor icing at any power setting. The reason for the partial loss of engine power could not be determined.',
      'A partial loss of engine power during cruise flight for reasons that could not be determined.',
    ),
    anchors: ['were not conducive to carburetor icing at any power setting'],
    note: 'Power loss, weather stated not conducive: grade 2.',
  },
  {
    id: 'neg-carb-conducive-glide-descent',
    family: 'negation',
    mutation: 'contradiction',
    question: 'ng-carb-icing-not-conducive',
    label: 0,
    reading: 'edge-case',
    record: carbRecord(
      'CEN19LA912',
      'During the descent to the destination airport with the engine at reduced power, the engine began to run rough and lost partial power.',
      'The temperature and dew point recorded near the time of the accident were conducive to serious carburetor icing at glide and descent power. It is likely that carburetor ice formed during the descent.',
      'A partial loss of engine power during the descent due to carburetor icing.',
      { phase: 'approach', occurrence: 'Approach Loss of engine power (partial)' },
    ),
    anchors: ['were conducive to serious carburetor icing at glide and descent power'],
    note: 'Conducive at the power setting in use: grade 0. Fix round 1: the occurrence row now says approach, not cruise (review M7).',
  },
  {
    id: 'neg-carb-glide-only-cruise-loss',
    family: 'negation',
    mutation: 'conditional_scope',
    question: 'ng-carb-icing-not-conducive',
    label: 2,
    reading: 'edge-case',
    record: carbRecord(
      'CEN19LA913',
      'While in cruise flight at 4,500 ft with the engine at cruise power, the engine began to run rough and lost partial power.',
      'The temperature and dew point recorded near the time of the accident were conducive to serious carburetor icing at glide power but not at cruise power. The partial loss of power occurred in cruise flight, and its reason could not be determined.',
      'A partial loss of engine power during cruise flight for reasons that could not be determined.',
    ),
    anchors: ['were conducive to serious carburetor icing at glide power but not at cruise power'],
    note: 'Conducive only at glide power, loss in cruise: not conducive at the setting in use, grade 2 (an edge case of the rubric).',
  },
  {
    id: 'neg-carb-fuel-injected',
    family: 'negation',
    mutation: 'other_reason',
    question: 'ng-carb-icing-not-conducive',
    label: 1,
    reading: 'edge-case',
    record: carbRecord(
      'CEN19LA914',
      'While in cruise flight at 4,500 ft, the engine began to run rough and lost partial power.',
      "The airplane's engine was equipped with a fuel injection system and did not have a carburetor; carburetor icing therefore could not have occurred. The weather conditions at the time are not otherwise discussed, and the reason for the partial loss of power could not be determined.",
      'A partial loss of engine power during cruise flight for reasons that could not be determined.',
      { model: 'PA-28R-201' },
    ),
    anchors: ['carburetor icing therefore could not have occurred'],
    note: 'Icing ruled out by the fuel system, not by the weather: partial. Fix round 1: a fuel-injected model (review M7).',
  },
  {
    id: 'neg-gear-no-preimpact',
    family: 'negation',
    mutation: 'base',
    question: 'ng-gear-collapse-no-defect',
    label: 2,
    reading: 'edge-case',
    record: gearRecord('CEN16LA921', 'Examination of the nose landing gear revealed no evidence of a preimpact mechanical malfunction or failure; the overload fractures were consistent with the hard landing.', "The pilot's improper landing flare, which resulted in a hard landing and the collapse of the nose landing gear."),
    anchors: ['Examination of the nose landing gear revealed no evidence of a preimpact mechanical malfunction or failure'],
    note: 'Collapse, and the gear examination found no pre-existing defect: grade 2.',
  },
  {
    id: 'neg-gear-fatigue-found',
    family: 'negation',
    mutation: 'contradiction',
    question: 'ng-gear-collapse-no-defect',
    label: 0,
    reading: 'edge-case',
    record: gearRecord('CEN16LA922', 'Examination of the nose landing gear revealed a pre-existing fatigue crack that had propagated through about 70 percent of the drag link before the overload fracture.', 'The failure of the nose landing gear drag link due to a pre-existing fatigue crack.'),
    anchors: ['revealed a pre-existing fatigue crack that had propagated through about 70 percent of the drag link'],
    note: 'A pre-existing defect was found: grade 0.',
  },
  {
    id: 'neg-gear-not-examined',
    family: 'negation',
    mutation: 'not_examined',
    question: 'ng-gear-collapse-no-defect',
    label: 1,
    reading: 'edge-case',
    record: gearRecord('CEN16LA923', 'The nose landing gear components were discarded during the recovery of the airplane and were not available for examination.', "The pilot's improper landing flare, which resulted in a hard landing and the collapse of the nose landing gear."),
    anchors: ['were not available for examination'],
    note: 'Collapse without an examination result: partial.',
  },
  {
    id: 'neg-gear-pilot-statement',
    family: 'negation',
    mutation: 'wrong_speaker',
    question: 'ng-gear-collapse-no-defect',
    label: 1,
    reading: 'edge-case',
    record: gearRecord(
      'CEN16LA924',
      '',
      "The pilot's improper landing flare, which resulted in a hard landing and the collapse of the nose landing gear.",
      'The pilot reported that there were no preaccident mechanical malfunctions or failures with the airplane that would have precluded normal operation.',
    ),
    anchors: ['The pilot reported that there were no preaccident mechanical malfunctions or failures with the airplane that would have precluded normal operation.'],
    note: "The only statement that nothing was wrong is the pilot's; no examination is described: partial (review I3c).",
  },
  {
    id: 'neg-gear-airframe-general',
    family: 'negation',
    mutation: 'scope_of_negation',
    question: 'ng-gear-collapse-no-defect',
    label: 1,
    reading: 'edge-case',
    record: gearRecord('CEN16LA925', 'Examination of the airframe revealed no preimpact mechanical anomalies.', "The pilot's improper landing flare, which resulted in a hard landing and the collapse of the nose landing gear."),
    anchors: ['Examination of the airframe revealed no preimpact mechanical anomalies.'],
    note: 'A general "no anomalies" statement that does not name the gear: partial.',
  },
];

// ---------------------------------------------------------------------------
// Chronology (dev: chr-ag, chr-annual; holdout: chr-heli and controls-reading's chr-thrush, chr-cub)

const STUTTGART: FillerPlace = { airport: 'Stuttgart Municipal Airport', station: 'KSGT', elevation: 224, temperature: 29 };
const AG = (phase = 'maneuvering'): ControlAircraft => ({ make: 'Air Tractor', model: 'AT-402B', category: 'AIR', farPart: '137', purpose: 'AAPL', phase, engine: 'TP' });
const agRecord = (id: string, maintenance: string, extraAnalysis = ''): ControlRecord => ({
  ntsbNo: id,
  date: '2020-06-12',
  city: 'Stuttgart',
  state: 'AR',
  aircraft: [AG()],
  factual: `The commercial pilot was applying fungicide to a rice field. He reported that, during a turn at the end of a swath run, the engine lost power. He made a forced landing in an adjacent field, and the airplane came to rest inverted.\n\n${context(id, STUTTGART, 1)}\n\n${maintenance}\n\nExamination of the engine did not reveal any anomalies that would have precluded normal operation.`,
  analysis: `The pilot reported a loss of engine power during the application flight. ${extraAnalysis}The reason for the loss of engine power could not be determined.`,
  probableCause: 'A loss of engine power for reasons that could not be determined.',
  findings: [],
  occurrences: [{ aircraft: 1, code: '341', phase: 'maneuvering', description: 'Maneuvering-low-alt flying Loss of engine power (total)', defining: true }],
});

const BEND: FillerPlace = { airport: 'Bend Municipal Airport', station: 'KBDN', elevation: 3460, temperature: 18 };
const annualRecord = (id: string, timing: string): ControlRecord => ({
  ntsbNo: id,
  date: '2018-10-02',
  city: 'Bend',
  state: 'OR',
  aircraft: [{ make: 'Mooney', model: 'M20J', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'initial_climb', engine: 'REC' }],
  factual: `The private pilot departed for a local flight. Shortly after takeoff the airplane's airspeed indicator showed no indication, and the pilot returned to land with a tailwind; the airplane overran the end of the runway and struck a fence.\n\n${context(id, BEND, 1)}\n\n${timing}\n\nExamination of the pitot system revealed that the pitot line was disconnected at a fitting behind the instrument panel.`,
  analysis: 'The pitot line had not been reconnected after it was disconnected, which resulted in the loss of airspeed indication.',
  probableCause: "The disconnected pitot line, which resulted in a loss of airspeed indication, and the pilot's decision to land with a tailwind, which resulted in a runway overrun.",
  findings: [],
  occurrences: [{ aircraft: 1, code: '490', phase: 'landing', description: 'Landing Collision during takeoff/land', defining: true }],
});

const KAHULUI: FillerPlace = { airport: 'Kahului Airport', station: 'PHOG', elevation: 54, temperature: 26 };
const heliRecord = (id: string, maintenance: string): ControlRecord => ({
  ntsbNo: id,
  date: '2017-04-26',
  city: 'Kahului',
  state: 'HI',
  aircraft: [{ make: 'Robinson', model: 'R44 II', category: 'HELI', farPart: '091', purpose: 'PERS', phase: 'maneuvering', engine: 'REC' }],
  factual: `The pilot reported that, while maneuvering at low altitude, the helicopter began a slow yaw to the right that he could not stop with the pedals. He entered an autorotation and landed hard in a field.\n\n${context(id, KAHULUI, 1)}\n\n${maintenance}\n\nExamination of the tail rotor system found the tail rotor drive and flight controls continuous; no anomalies were found.`,
  analysis: 'The pilot likely did not apply sufficient pedal input in the left crosswind, which resulted in a loss of tail rotor effectiveness.',
  probableCause: "The pilot's inadequate pedal input in a crosswind, which resulted in a loss of tail rotor effectiveness.",
  findings: [],
  occurrences: [{ aircraft: 1, code: '240', phase: 'maneuvering', description: 'Maneuvering-low-alt flying Loss of control in flight', defining: true }],
});

export const CHRONOLOGY_CONTROLS: readonly Control[] = [
  {
    id: 'chr-ag-inside-window',
    family: 'chronology',
    mutation: 'base',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 2,
    reading: 'edge-case',
    record: agRecord('CEN20LA931', 'According to the maintenance records, the engine had been overhauled and reinstalled in the airplane, and it had accumulated 12.4 hours since the overhaul at the time of the accident.'),
    anchors: ['it had accumulated 12.4 hours since the overhaul at the time of the accident'],
    note: "Power loss 12.4 hours after an engine overhaul on the engine's own clock: inside the 25-hour window.",
  },
  {
    id: 'chr-ag-outside-window',
    family: 'chronology',
    mutation: 'outside_window',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 0,
    reading: 'edge-case',
    record: agRecord('CEN20LA932', 'According to the maintenance records, the engine fuel control unit had been replaced about 40 flight hours before the accident; no other engine maintenance had been performed since the last overhaul 1,250 hours before.'),
    anchors: ['the engine fuel control unit had been replaced about 40 flight hours before the accident'],
    note: 'About 40 flight hours: clearly outside the 25-hour window.',
  },
  {
    id: 'chr-ag-calendar-only',
    family: 'chronology',
    mutation: 'calendar_only',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 1,
    reading: 'edge-case',
    record: agRecord('CEN20LA933', "The airplane's most recent annual inspection, which included the engine, was completed 3 weeks before the accident. The hours flown since the inspection could not be determined because the operator did not record flight times."),
    anchors: ['was completed 3 weeks before the accident', 'The hours flown since the inspection could not be determined'],
    note: 'Calendar time only, hours unknown: partial.',
  },
  {
    id: 'chr-ag-approximate-limit',
    family: 'chronology',
    mutation: 'approximate_value',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 1,
    reading: 'edge-case',
    record: agRecord('CEN20LA934', 'According to the operator, the engine had been overhauled the previous month and had about 25 hours since the overhaul.'),
    anchors: ['had about 25 hours since the overhaul'],
    note: 'An approximate value at the limit: partial (an edge case of the rubric).',
  },
  {
    id: 'chr-ag-days-not-hours',
    family: 'chronology',
    mutation: 'unit_swap',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 1,
    reading: 'edge-case',
    record: agRecord('CEN20LA935', "The engine had been overhauled and reinstalled 20 days before the accident. The airplane's flight hours since the reinstallation were not recorded."),
    anchors: ['The engine had been overhauled and reinstalled 20 days before the accident.'],
    note: '20 days is calendar time, not 20 hours on any clock: partial, a unit trap.',
  },
  {
    id: 'chr-ag-wrong-anchor',
    family: 'chronology',
    mutation: 'wrong_anchor',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 0,
    reading: 'novel',
    record: agRecord(
      'CEN20LA936',
      'The pilot had flown 8 hours since his most recent flight review. According to the maintenance records, the engine had last been overhauled 1,310 hours before the accident, and no engine maintenance had been performed since its last 100-hour inspection 90 hours before the accident.',
      "The airplane had been flown 8 hours since the pilot's flight review. ",
    ),
    anchors: ['the engine had last been overhauled 1,310 hours before the accident', 'no engine maintenance had been performed since its last 100-hour inspection 90 hours before the accident'],
    note: "The 8 hours are measured from the pilot's flight review, not from engine maintenance (90 hours before): grade 0, an anchor trap.",
  },
  {
    id: 'chr-annual-first-flight',
    family: 'chronology',
    mutation: 'base',
    question: 'mc-first-flight-after-annual',
    label: 2,
    reading: 'edge-case',
    record: annualRecord('WPR18LA941', "The airplane's annual inspection was signed off by the mechanic on the morning of the accident, and the accident flight was the first flight after the inspection. During the inspection the mechanic had disconnected the pitot line to replace the airspeed indicator."),
    anchors: ['the accident flight was the first flight after the inspection'],
    note: 'First flight after the annual: grade 2.',
  },
  {
    id: 'chr-annual-second-flight',
    family: 'chronology',
    mutation: 'not_first_flight',
    question: 'mc-first-flight-after-annual',
    label: 1,
    reading: 'edge-case',
    record: annualRecord('WPR18LA942', "The airplane's annual inspection was completed 2 days before the accident. The airplane had been flown 0.3 hours since the inspection, on a test flight by the mechanic the day before the accident."),
    anchors: ['The airplane had been flown 0.3 hours since the inspection, on a test flight by the mechanic the day before the accident.'],
    note: 'Exactly one earlier flight after the annual is stated (the test flight): the accident flight was the second, partial.',
  },
  {
    id: 'chr-annual-several-flights',
    family: 'chronology',
    mutation: 'outside_window',
    question: 'mc-first-flight-after-annual',
    label: 0,
    reading: 'novel',
    record: annualRecord('WPR18LA943', "The airplane's last annual inspection was completed 2 months before the accident, and the owner had flown it on several local flights since then, about 15 hours in all."),
    anchors: ['the owner had flown it on several local flights since then'],
    note: 'Several flights since the annual are stated (the hours are not used to infer them): grade 0. Fix round 1: the flights are stated, not inferred from hours (gate item 1).',
  },
  {
    id: 'chr-annual-other-maintenance',
    family: 'chronology',
    mutation: 'wrong_event',
    question: 'mc-first-flight-after-annual',
    label: 0,
    reading: 'edge-case',
    record: annualRecord('WPR18LA944', "The accident flight was the first flight after an avionics shop replaced the airspeed indicator; the airplane's last annual inspection had been completed 8 months before the accident."),
    anchors: ['The accident flight was the first flight after an avionics shop replaced the airspeed indicator'],
    note: 'First flight after other maintenance, the annual long before: grade 0.',
  },
  {
    id: 'chr-heli-inside',
    family: 'chronology',
    mutation: 'base',
    question: 'mc-helicopter-control-rotor-maintenance-10h',
    label: 2,
    reading: 'edge-case',
    record: heliRecord('WPR17LA951', 'The tail rotor pitch link bearings had been replaced 2.1 flight hours before the accident.'),
    anchors: ['The tail rotor pitch link bearings had been replaced 2.1 flight hours before the accident.'],
    note: 'Rotor system work 2.1 flight hours before: grade 2 (no causal link required).',
  },
  {
    id: 'chr-heli-outside',
    family: 'chronology',
    mutation: 'outside_window',
    question: 'mc-helicopter-control-rotor-maintenance-10h',
    label: 0,
    reading: 'edge-case',
    record: heliRecord('WPR17LA952', 'The main rotor blades had been replaced about 300 flight hours before the accident, and no other maintenance on the rotor system or flight controls was recorded since then.'),
    anchors: ['The main rotor blades had been replaced about 300 flight hours before the accident'],
    note: 'Clearly outside the 10-hour window: grade 0.',
  },
  {
    id: 'chr-heli-general-inspection',
    family: 'chronology',
    mutation: 'general_inspection',
    question: 'mc-helicopter-control-rotor-maintenance-10h',
    label: 1,
    reading: 'edge-case',
    record: heliRecord('WPR17LA953', 'A 100-hour inspection had been completed 4 flight hours before the accident; the records do not describe any work on the flight controls or the rotor system.'),
    anchors: ['A 100-hour inspection had been completed 4 flight hours before the accident'],
    note: 'A general inspection inside the window without control or rotor work: partial.',
  },
];

// ---------------------------------------------------------------------------
// Pilot statement against investigator finding (dev: att-brake, att-tail; holdout: att-data and controls-reading's att-engine, att-yaw)

const LAKELAND: FillerPlace = { airport: 'Lakeland Linder International Airport', station: 'KLAL', elevation: 142, temperature: 30 };
const brakeRecord = (id: string, report: string, exam: string, probable: string): ControlRecord => ({
  ntsbNo: id,
  date: '2015-05-30',
  city: 'Lakeland',
  state: 'FL',
  aircraft: [{ make: 'Cirrus', model: 'SR22', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'landing', engine: 'REC' }],
  factual: `${report} The airplane departed the left side of the runway and struck a taxiway sign.\n\n${context(id, LAKELAND, 1)}\n\n${exam}`,
  analysis: 'The pilot did not maintain directional control during the landing roll.',
  probableCause: probable,
  findings: [],
  occurrences: [{ aircraft: 1, code: '220', phase: 'landing', description: 'Landing-landing roll Loss of control on ground', defining: true }],
});

const SCOTTSDALE: FillerPlace = { airport: 'Scottsdale Airport', station: 'KSDL', elevation: 1510, temperature: 24 };
const tailRotorRecord = (id: string, exam: string, probable: string, claim = 'The pilot reported that, during the approach to a helipad, "the tail rotor failed" and the helicopter began to spin to the right.'): ControlRecord => ({
  ntsbNo: id,
  date: '2014-11-08',
  city: 'Scottsdale',
  state: 'AZ',
  aircraft: [{ make: 'Bell', model: '206B', category: 'HELI', farPart: '091', purpose: 'PERS', phase: 'approach', engine: 'TS' }],
  factual: `${claim} The helicopter descended in the spin and impacted terrain.\n\n${context(id, SCOTTSDALE, 1)}\n\n${exam}`,
  analysis: 'The approach was made with a left quartering tailwind of about 12 knots.',
  probableCause: probable,
  findings: [],
  occurrences: [{ aircraft: 1, code: '240', phase: 'approach', description: 'Approach Loss of control in flight', defining: true }],
});

const PRESCOTT: FillerPlace = { airport: 'Prescott Regional Airport', station: 'KPRC', elevation: 5045, temperature: 9 };
const dataRecord = (id: string, data: string): ControlRecord => ({
  ntsbNo: id,
  date: '2022-01-15',
  city: 'Prescott',
  state: 'AZ',
  aircraft: [{ make: 'Cessna', model: '172S', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'en_route', engine: 'REC' }],
  factual: `The pilot reported that he climbed to 3,000 ft above ground level after departure and that the engine then lost power, after which he glided to a field and landed hard.\n\n${context(id, PRESCOTT, 1)}\n\n${data}`,
  analysis: 'The examination of the engine found no anomalies.',
  probableCause: 'A loss of engine power for reasons that could not be determined.',
  findings: [],
  occurrences: [{ aircraft: 1, code: '341', phase: 'en_route', description: 'Enroute Loss of engine power (total)', defining: true }],
});

export const ATTRIBUTION_CONTROLS: readonly Control[] = [
  {
    id: 'att-brake-claim-not-confirmed',
    family: 'pilot_vs_investigator',
    mutation: 'base',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 2,
    reading: 'edge-case',
    record: brakeRecord(
      'ERA15LA961',
      'The pilot reported that, during the landing roll, the left brake failed and the airplane veered to the left.',
      'Examination of the brake system after the accident found that both brakes operated normally, with no leaks in the hydraulic lines and pads within limits.',
      "The pilot's failure to maintain directional control during the landing roll.",
    ),
    anchors: ['the left brake failed', 'found that both brakes operated normally'],
    note: "The pilot's reported failure, and the investigators found the system working: grade 2.",
  },
  {
    id: 'att-brake-claim-confirmed',
    family: 'pilot_vs_investigator',
    mutation: 'contradiction',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 0,
    reading: 'edge-case',
    record: brakeRecord(
      'ERA15LA962',
      'The pilot reported that, during the landing roll, the left brake failed and the airplane veered to the left.',
      'Examination of the brake system found that the left brake hydraulic line had chafed through against the landing gear leg, and all brake fluid had been lost from the left brake.',
      'The loss of left brake effectiveness due to a chafed brake hydraulic line, which resulted in a loss of directional control.',
    ),
    anchors: ['the left brake hydraulic line had chafed through against the landing gear leg'],
    note: 'The investigators confirmed the reported failure: grade 0.',
  },
  {
    id: 'att-witness-not-pilot',
    family: 'pilot_vs_investigator',
    mutation: 'wrong_speaker',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 0,
    reading: 'edge-case',
    record: brakeRecord(
      'ERA15LA963',
      'The pilot reported no mechanical problems with the airplane before the accident. A witness on the ramp stated that he heard a "grinding noise" from the left wheel during the landing roll.',
      'Examination of the brake system found that both brakes operated normally.',
      "The pilot's failure to maintain directional control during the landing roll.",
    ),
    anchors: ['The pilot reported no mechanical problems with the airplane before the accident.'],
    note: 'Only a witness suggested a problem; the pilot reported none: grade 0, a speaker trap.',
  },
  {
    id: 'att-claim-not-examined',
    family: 'pilot_vs_investigator',
    mutation: 'unresolved',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 1,
    reading: 'edge-case',
    record: brakeRecord(
      'ERA15LA964',
      'The pilot reported that, during the landing roll, the left brake failed and the airplane veered to the left.',
      'The airplane was repaired by the owner before it could be examined, and the brake system was not examined by the investigation.',
      "The pilot's failure to maintain directional control during the landing roll for reasons that could not be determined.",
    ),
    anchors: ['the brake system was not examined by the investigation'],
    note: 'Reported problem left unresolved: partial.',
  },
  {
    id: 'att-claim-not-corroborated',
    family: 'pilot_vs_investigator',
    mutation: 'paraphrased_finding',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 2,
    reading: 'novel',
    record: brakeRecord(
      'ERA15LA965',
      'The pilot reported that the throttle became stuck at full power during the landing flare.',
      "Examination of the throttle linkage found it intact and free to move through its full range; the pilot's statement that the throttle was stuck could not be corroborated.",
      "The pilot's failure to maintain directional control during the landing roll.",
    ),
    anchors: ["the pilot's statement that the throttle was stuck could not be corroborated"],
    note: 'Reported failure the investigators could not corroborate, with the system found working: grade 2.',
  },
  {
    id: 'att-tail-rotor-lte',
    family: 'pilot_vs_investigator',
    mutation: 'base',
    question: 'pv-helicopter-tail-rotor-claim',
    label: 2,
    reading: 'edge-case',
    record: tailRotorRecord(
      'WPR14LA971',
      'Examination of the tail rotor drive system established continuity from the main transmission to the tail rotor gearbox, and the tail rotor blades showed chordwise scratches consistent with rotation under power at impact. The investigation attributed the spin to a loss of tail rotor effectiveness in the tailwind.',
      "The pilot's failure to maintain yaw control in a left quartering tailwind, which resulted in a loss of tail rotor effectiveness.",
    ),
    anchors: ['Examination of the tail rotor drive system established continuity', 'The investigation attributed the spin to a loss of tail rotor effectiveness in the tailwind.'],
    note: 'The pilot claimed a tail rotor failure the investigators did not find: grade 2. Fix round 1: the blades now plainly show rotation under power (gate item 4: the former wording could read as evidence of a drive failure).',
  },
  {
    id: 'att-tail-rotor-failure-found',
    family: 'pilot_vs_investigator',
    mutation: 'contradiction',
    question: 'pv-helicopter-tail-rotor-claim',
    label: 0,
    reading: 'edge-case',
    record: tailRotorRecord(
      'WPR14LA972',
      'Examination of the tail rotor drive system found that the tail rotor drive shaft had fractured at the forward hanger bearing; the fracture surface showed fatigue cracking.',
      'The fatigue failure of the tail rotor drive shaft, which resulted in a loss of tail rotor thrust.',
    ),
    anchors: ['the tail rotor drive shaft had fractured at the forward hanger bearing'],
    note: 'A tail rotor failure was found: grade 0.',
  },
  {
    id: 'att-tail-rotor-unsettled',
    family: 'pilot_vs_investigator',
    mutation: 'unresolved',
    question: 'pv-helicopter-tail-rotor-claim',
    label: 1,
    reading: 'edge-case',
    record: tailRotorRecord(
      'WPR14LA973',
      'The tail boom separated and was destroyed in the impact and the postimpact fire, and continuity of the tail rotor drive system could not be established.',
      'A loss of yaw control during the approach for reasons that could not be determined.',
    ),
    anchors: ['continuity of the tail rotor drive system could not be established'],
    note: 'The claim could not be settled: partial.',
  },
  {
    id: 'att-tail-rotor-lte-report',
    family: 'pilot_vs_investigator',
    mutation: 'no_failure_claim',
    question: 'pv-helicopter-tail-rotor-claim',
    label: 1,
    reading: 'edge-case',
    record: tailRotorRecord(
      'WPR14LA974',
      'Examination of the tail rotor drive system established continuity from the main transmission to the tail rotor gearbox, and no anomalies were found with the tail rotor or its controls.',
      "The pilot's failure to maintain yaw control in a left quartering tailwind, which resulted in a loss of tail rotor effectiveness.",
      'The pilot reported that, during the approach to a helipad, the helicopter "got into loss of tail rotor effectiveness" and began to spin to the right.',
    ),
    anchors: ['the helicopter "got into loss of tail rotor effectiveness"', 'no anomalies were found with the tail rotor or its controls'],
    note: 'The pilot reported a loss of tail rotor effectiveness, not a failure, and none was found: partial (review I3d).',
  },
  {
    id: 'att-data-contradicts',
    family: 'pilot_vs_investigator',
    mutation: 'base',
    question: 'pv-recorded-data-contradicts-pilot',
    label: 2,
    reading: 'edge-case',
    record: dataRecord('WPR22LA981', 'ADS-B data showed that after departure the airplane climbed to a maximum of about 900 ft above ground level before it began to descend toward the field.'),
    anchors: ['ADS-B data showed that after departure the airplane climbed to a maximum of about 900 ft above ground level'],
    note: "Recorded data contradict the pilot's account, whether or not the record points the difference out: grade 2 (the rubric's grade 2 no longer conflicts with its grade 1, gate item 4).",
  },
  {
    id: 'att-data-witness-only',
    family: 'pilot_vs_investigator',
    mutation: 'wrong_source',
    question: 'pv-recorded-data-contradicts-pilot',
    label: 1,
    reading: 'edge-case',
    record: dataRecord('WPR22LA982', 'A witness near the departure end of the runway stated that the airplane "never got higher than the treetops" before it turned toward the field. No recorded flight data were available.'),
    anchors: ['No recorded flight data were available.'],
    note: 'Contradicted only by a witness, with no recorded data: partial (the rubric now decides in order, so "no recorded data" no longer also reads as grade 0, gate item 4).',
  },
  {
    id: 'att-data-consistent',
    family: 'pilot_vs_investigator',
    mutation: 'contradiction',
    question: 'pv-recorded-data-contradicts-pilot',
    label: 0,
    reading: 'edge-case',
    record: dataRecord('WPR22LA983', "GPS data recovered from a portable unit showed the airplane climbing to about 3,000 ft above ground level, consistent with the pilot's account, before it began a steady descent toward the field."),
    anchors: ["consistent with the pilot's account"],
    note: 'Recorded data agree with the account: grade 0.',
  },
];

// ---------------------------------------------------------------------------
// Cross-aircraft attribution (dev: mx-student, mx-taxi; holdout: mx-pattern and controls-reading's mx-scoped, mx-ramp)

const PA28 = (purpose: string, phase: string): ControlAircraft => ({ make: 'Piper', model: 'PA-28-181', category: 'AIR', farPart: '091', purpose, phase, engine: 'REC' });
const C172 = (purpose: string, phase: string): ControlAircraft => ({ make: 'Cessna', model: '172S', category: 'AIR', farPart: '091', purpose, phase, engine: 'REC' });
const FREDERICK: FillerPlace = { airport: 'Frederick Municipal Airport', station: 'KFDK', elevation: 306, temperature: 23 };

const MIDAIR_ANALYSIS = 'Both pilots were responsible for seeing and avoiding the other airplane.';
const leg = (name: string): ControlRecord['occurrences'] => [
  { aircraft: 1, code: '250', phase: 'approach', description: `Approach-VFR pattern ${name} Midair collision`, defining: true },
  { aircraft: 2, code: '250', phase: 'approach', description: `Approach-VFR pattern ${name} Midair collision`, defining: true },
];
const collisionRecord = (
  id: string,
  aircraft: ControlAircraft[],
  factual: string,
  probable: string,
  over: { analysis?: string; occurrences?: ControlRecord['occurrences']; event?: ControlRecord['event'] } = {},
): ControlRecord => ({
  ntsbNo: id,
  date: '2023-09-03',
  city: 'Frederick',
  state: 'MD',
  aircraft,
  ...(over.event ? { event: over.event } : {}),
  factual: `${factual}\n\n${context(id, FREDERICK, 1)}`,
  analysis: over.analysis ?? MIDAIR_ANALYSIS,
  probableCause: probable,
  findings: [],
  occurrences: over.occurrences ?? leg('final'),
});

export const CROSS_AIRCRAFT_CONTROLS: readonly Control[] = [
  {
    id: 'mx-student-in-colliding-airplane',
    family: 'cross_aircraft',
    mutation: 'base',
    question: 'ma-airplane-collision-student-pilot',
    label: 2,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23MA991',
      [C172('INST', 'approach'), PA28('PERS', 'approach')],
      'The Cessna, flown by a student pilot on a solo flight, and the Piper, flown by a private pilot, collided on final approach to runway 23. Both airplanes descended to the ground short of the runway.',
      'The failure of both pilots to see and avoid the other airplane on final approach.',
    ),
    anchors: ['The Cessna, flown by a student pilot on a solo flight, and the Piper, flown by a private pilot, collided on final approach'],
    note: 'A student flew one of the two colliding airplanes: grade 2.',
  },
  {
    id: 'mx-student-elsewhere',
    family: 'cross_aircraft',
    mutation: 'wrong_aircraft',
    question: 'ma-airplane-collision-student-pilot',
    label: 0,
    reading: 'novel',
    record: collisionRecord(
      'ERA23MA992',
      [C172('PERS', 'approach'), PA28('PERS', 'approach')],
      'The Cessna and the Piper, each flown by a private pilot, collided on final approach to runway 23. A student pilot in a third airplane, holding short of the runway for departure, saw the collision and reported it to the airport manager.',
      'The failure of both pilots to see and avoid the other airplane on final approach.',
    ),
    anchors: ['each flown by a private pilot', 'A student pilot in a third airplane, holding short of the runway for departure'],
    note: 'The student was in a third airplane that did not collide: grade 0, a cross-aircraft trap.',
  },
  {
    id: 'mx-flight-review',
    family: 'cross_aircraft',
    mutation: 'wrong_role',
    question: 'ma-airplane-collision-student-pilot',
    label: 0,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23MA993',
      [C172('INST', 'approach'), PA28('PERS', 'approach')],
      'The Cessna, flown by a private pilot receiving a flight review from a flight instructor, and the Piper, flown by a commercial pilot, collided on final approach to runway 23.',
      'The failure of both pilots to see and avoid the other airplane on final approach.',
    ),
    anchors: ['flown by a private pilot receiving a flight review from a flight instructor'],
    note: 'A flight review of a certificated pilot, even with the purpose "Instructional" in the header: grade 0 (the rubric now says so, review M6).',
  },
  {
    id: 'mx-instruction-unclear',
    family: 'cross_aircraft',
    mutation: 'unresolved',
    question: 'ma-airplane-collision-student-pilot',
    label: 1,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23MA994',
      [C172('INST', 'approach'), PA28('PERS', 'approach')],
      'The Cessna, operated on an instructional flight with two pilots on board, and the Piper, flown by a private pilot, collided on final approach to runway 23. The records did not establish which of the two people in the Cessna was manipulating the controls or what pilot certificate the person receiving instruction held.',
      'The failure of both flight crews to see and avoid the other airplane on final approach.',
    ),
    anchors: ['The records did not establish which of the two people in the Cessna was manipulating the controls or what pilot certificate the person receiving instruction held.'],
    note: 'Instruction, student not established: partial.',
  },
  {
    id: 'mx-taxi-strikes-parked',
    family: 'cross_aircraft',
    mutation: 'base',
    question: 'ma-taxiing-strikes-stationary',
    label: 2,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23LA995',
      [C172('PERS', 'taxi'), { make: 'Robinson', model: 'R22', category: 'HELI', farPart: '091', purpose: 'PERS', phase: 'standing', engine: 'REC' }],
      "While taxiing the airplane to the fuel pumps, the pilot did not see the parked and unoccupied helicopter, and the airplane's propeller struck the helicopter's tail boom.",
      "The airplane pilot's failure to maintain clearance from a parked helicopter while taxiing.",
      {
        analysis: 'The airplane pilot did not maintain adequate clearance from the parked helicopter while taxiing.',
        occurrences: [
          { aircraft: 1, code: '200', phase: 'taxi', description: 'Taxi Ground collision', defining: true },
          { aircraft: 2, code: '200', phase: 'standing', description: 'Standing Ground collision', defining: true },
        ],
      },
    ),
    anchors: ["the airplane's propeller struck the helicopter's tail boom"],
    note: 'A taxiing airplane struck a parked helicopter: grade 2. Fix round 1: the analysis no longer says both pilots should have seen and avoided each other (review M7).',
  },
  {
    id: 'mx-landing-roll',
    family: 'cross_aircraft',
    mutation: 'wrong_phase',
    question: 'ma-taxiing-strikes-stationary',
    label: 1,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23LA996',
      [PA28('PERS', 'landing'), C172('INST', 'standing')],
      'During the landing roll, the Piper drifted left of the centerline and its left wing struck the Cessna, which was holding short of the runway on the taxiway with its engine running.',
      "The Piper pilot's failure to maintain directional control during the landing roll.",
      {
        analysis: 'The Piper pilot did not maintain directional control during the landing roll.',
        occurrences: [
          { aircraft: 1, code: '200', phase: 'landing', description: 'Landing-landing roll Ground collision', defining: true },
          { aircraft: 2, code: '200', phase: 'standing', description: 'Standing-engine(s) operating Ground collision', defining: true },
        ],
      },
    ),
    anchors: ['During the landing roll, the Piper drifted left of the centerline and its left wing struck the Cessna'],
    note: 'The moving airplane was on its landing roll, not taxiing: partial.',
  },
  {
    id: 'mx-both-taxiing',
    family: 'cross_aircraft',
    mutation: 'neither_stationary',
    question: 'ma-taxiing-strikes-stationary',
    label: 1,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23LA997',
      [PA28('PERS', 'taxi'), C172('PERS', 'taxi')],
      'The Piper and the Cessna were both taxiing on the parallel taxiway in opposite directions when their wingtips touched.',
      'The failure of both pilots to maintain clearance from the other airplane while taxiing.',
      {
        analysis: 'Both pilots were responsible for maintaining clearance from the other airplane while taxiing.',
        occurrences: [
          { aircraft: 1, code: '200', phase: 'taxi', description: 'Taxi Ground collision', defining: true },
          { aircraft: 2, code: '200', phase: 'taxi', description: 'Taxi Ground collision', defining: true },
        ],
      },
    ),
    anchors: ['were both taxiing on the parallel taxiway in opposite directions'],
    note: 'Neither aircraft was stopped: partial.',
  },
  {
    id: 'mx-taxi-strikes-hangar',
    family: 'cross_aircraft',
    mutation: 'not_aircraft',
    question: 'ma-taxiing-strikes-stationary',
    label: 0,
    reading: 'edge-case',
    record: {
      ntsbNo: 'ERA23LA998',
      date: '2023-09-03',
      city: 'Frederick',
      state: 'MD',
      aircraft: [C172('PERS', 'taxi')],
      factual: `While taxiing to the hangar, the pilot misjudged the clearance and the airplane's right wing struck the hangar door frame.\n\n${context('ERA23LA998', FREDERICK, 1)}`,
      analysis: 'The pilot did not maintain clearance from the hangar while taxiing.',
      probableCause: "The pilot's failure to maintain clearance from a hangar while taxiing.",
      findings: [],
      occurrences: [{ aircraft: 1, code: '200', phase: 'taxi', description: 'Taxi Ground collision', defining: true }],
    },
    anchors: ["the airplane's right wing struck the hangar door frame"],
    note: 'A collision with a building, not another aircraft: grade 0.',
  },
  {
    id: 'mx-pattern-nontowered',
    family: 'cross_aircraft',
    mutation: 'base',
    question: 'ma-midair-pattern-nontowered',
    label: 2,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23FA901',
      [C172('PERS', 'approach'), PA28('PERS', 'approach')],
      'The two airplanes collided on final approach to runway 14 at the non-towered airport. Both pilots had been making position reports on the common traffic advisory frequency.',
      'The failure of both pilots to see and avoid the other airplane in the traffic pattern.',
    ),
    anchors: ['The two airplanes collided on final approach to runway 14 at the non-towered airport.'],
    note: 'A midair in the pattern of a non-towered airport: grade 2.',
  },
  {
    id: 'mx-pattern-tower-unknown',
    family: 'cross_aircraft',
    mutation: 'unresolved',
    question: 'ma-midair-pattern-nontowered',
    label: 1,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23FA902',
      [C172('PERS', 'approach'), PA28('PERS', 'approach')],
      'The two airplanes collided while on the downwind leg of the traffic pattern for runway 14.',
      'The failure of both pilots to see and avoid the other airplane in the traffic pattern.',
      { occurrences: leg('downwind') },
    ),
    anchors: ['collided while on the downwind leg of the traffic pattern for runway 14'],
    note: 'In the pattern, tower status and radio frequency not stated: partial. Fix round 1: the occurrence rows now say downwind (review M7).',
  },
  {
    id: 'mx-pattern-towered',
    family: 'cross_aircraft',
    mutation: 'contradiction',
    question: 'ma-midair-pattern-nontowered',
    label: 0,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23FA903',
      [C172('INST', 'approach'), PA28('PERS', 'approach')],
      'The two airplanes collided on final approach to runway 14. The airport control tower was open at the time, and the local controller had cleared both airplanes to land on runway 14.',
      "The local controller's clearance of both airplanes to land on the same runway and the failure of both pilots to see and avoid the other airplane.",
    ),
    anchors: ['The airport control tower was open at the time'],
    note: 'An operating tower: grade 0.',
  },
  {
    id: 'mx-pattern-tower-closed',
    family: 'cross_aircraft',
    mutation: 'closed_tower',
    question: 'ma-midair-pattern-nontowered',
    label: 2,
    reading: 'edge-case',
    record: collisionRecord(
      'ERA23FA904',
      [C172('PERS', 'approach'), PA28('PERS', 'approach')],
      'The two airplanes collided on the base leg for runway 14 at about 2215. The airport control tower had closed for the night at 2100, and the airport was operating as a non-towered airport.',
      'The failure of both pilots to see and avoid the other airplane in the traffic pattern.',
      { occurrences: leg('base'), event: { light: 'NDRK' } },
    ),
    anchors: ['The airport control tower had closed for the night at 2100'],
    note: 'A closed tower is no operating tower: grade 2.',
  },
];
