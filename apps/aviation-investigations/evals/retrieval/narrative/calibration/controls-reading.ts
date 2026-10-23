/**
 * Narrative controls that need reading (fix round 1, review I4): situations the rubrics
 * do not spell out, in records of realistic length, for every concept family, with
 * aircraft-scoped sections in multi-aircraft events and causal uncertainty. Most are
 * holdout groups (calibration.ts lists them), so the holdout tests reading as well as
 * edge-case lookup. Conventions as in controls.ts.
 */
import type { Control, ControlAircraft, ControlRecord } from './controls.js';
import { context } from './controls.js';
import type { FillerPlace } from './filler.js';

// ---------------------------------------------------------------------------
// Negation: neg-jump (holdout), a turbine skydiving airplane

const DELAND: FillerPlace = { airport: 'DeLand Municipal Airport', station: 'KDED', elevation: 79, temperature: 31, area: 'pine forest and housing developments' };
/** The jump flight's landing as the investigators tell it, and its coded rows: a forced landing after a power loss, or (power loss doubted) a descent to land. */
const JUMP_LANDING = {
  forced: {
    sentence: 'The parachutists exited the airplane, and the pilot glided to a forced landing on a closed runway, during which the airplane overran into a drainage ditch.',
    phase: 'en_route',
    occurrences: [
      { aircraft: 1, code: '341', phase: 'en_route', description: 'Enroute-climb to cruise Loss of engine power (total)', defining: true },
      { aircraft: 1, code: '300', phase: 'landing', description: 'Landing-landing roll Runway excursion', defining: false },
    ],
  },
  doubted: {
    sentence: 'The parachutists exited the airplane, and the pilot descended to land on a closed runway, where the airplane overran into a drainage ditch.',
    phase: 'landing',
    occurrences: [{ aircraft: 1, code: '300', phase: 'landing', description: 'Landing-landing roll Runway excursion', defining: true }],
  },
} as const;
const jumpRecord = (id: string, exam: string, analysis: string, probable: string, landing: keyof typeof JUMP_LANDING = 'forced'): ControlRecord => ({
  ntsbNo: id,
  date: '2022-05-14',
  city: 'DeLand',
  state: 'FL',
  aircraft: [{ make: 'Cessna', model: '208B', category: 'AIR', farPart: '091', purpose: 'SKYD', phase: JUMP_LANDING[landing].phase, engine: 'TP' }],
  factual: `The commercial pilot was flying the turbine-powered airplane on a skydiving flight with 14 parachutists on board. The pilot reported that, during the climb through about 9,000 ft mean sea level, the engine lost power and the propeller began to windmill. ${JUMP_LANDING[landing].sentence}\n\n${context(id, DELAND, 2)}\n\n${exam}`,
  analysis,
  probableCause: probable,
  findings: [],
  occurrences: JUMP_LANDING[landing].occurrences.map((o) => ({ ...o })),
});

export const NEGATION_READING: readonly Control[] = [
  {
    id: 'neg-jump-teardown-clean',
    family: 'negation',
    mutation: 'base',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 2,
    reading: 'novel',
    record: jumpRecord(
      'ERA22LA901',
      "The engine was shipped to the manufacturer's facility, where it was disassembled under the supervision of an NTSB investigator. The teardown found no evidence of a preimpact failure or malfunction of the engine, and the fuel nozzles and the fuel control unit flowed within the manufacturer's limits.",
      'The pilot reported a loss of engine power during the climb, and the teardown of the engine found nothing that would have caused it. The reason for the loss of engine power could not be determined.',
      'A loss of engine power during the climb for reasons that could not be determined.',
    ),
    anchors: ['The teardown found no evidence of a preimpact failure or malfunction of the engine'],
    note: "A supervised teardown found nothing wrong: the investigators' examination, grade 2, in other words than the rubric's.",
  },
  {
    id: 'neg-jump-blade-fatigue',
    family: 'negation',
    mutation: 'contradiction',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 0,
    reading: 'novel',
    record: jumpRecord(
      'ERA22LA902',
      "The engine was shipped to the manufacturer's facility, where it was disassembled under the supervision of an NTSB investigator. The teardown found that several compressor turbine blades had separated from the disk, and metallurgical examination of the fracture surfaces showed a pre-existing fatigue crack in one blade.",
      'The fatigue fracture of a compressor turbine blade resulted in the loss of engine power.',
      'A loss of engine power during the climb due to the fatigue fracture of a compressor turbine blade.',
    ),
    anchors: ['showed a pre-existing fatigue crack in one blade'],
    note: 'The teardown found a pre-existing failure: grade 0.',
  },
  {
    id: 'neg-jump-external-only',
    family: 'negation',
    mutation: 'not_examined',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 1,
    reading: 'novel',
    record: jumpRecord(
      'ERA22LA903',
      'The airplane came to rest partially submerged in the ditch, and the engine could be examined only externally: no external damage or fluid leaks were noted, but the engine was not disassembled, and its internal components were not examined.',
      'Because the internal components of the engine were not examined, the investigation could not determine whether a mechanical malfunction contributed to the loss of engine power.',
      'A loss of engine power during the climb for reasons that could not be determined.',
    ),
    anchors: ['the engine could be examined only externally', 'its internal components were not examined'],
    note: 'Only an external look at the engine, its internal condition not determined: an examination in part, partial. Fix round 2: the record now says what was not examined (review N3).',
  },
  {
    id: 'neg-jump-power-loss-doubted',
    family: 'negation',
    mutation: 'doubted_power_loss',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 1,
    reading: 'novel',
    record: jumpRecord(
      'ERA22LA904',
      "The engine was shipped to the manufacturer's facility, where it was disassembled under the supervision of an NTSB investigator. The teardown found no evidence of a preimpact failure or malfunction of the engine.",
      "Engine trend data stored by the airplane's engine monitoring unit showed torque and turbine temperature values consistent with normal engine operation until the airplane was below 1,000 ft above the ground, and the investigation could not confirm that the engine lost power as the pilot reported.",
      'The pilot\'s improper glide planning during a precautionary descent, which resulted in a runway overrun.',
      'doubted',
    ),
    anchors: ['the investigation could not confirm that the engine lost power as the pilot reported'],
    note: 'The investigators found nothing wrong but doubt the reported power loss: partial (a clause of the rubric applied to a record that never uses its words). Fix round 2: no coded row or investigators\' sentence asserts the power loss any more (review N2).',
  },
];

// ---------------------------------------------------------------------------
// Chronology: chr-thrush, chr-cub and chr-rotor (holdout)

const WALNUT_RIDGE: FillerPlace = { airport: 'Walnut Ridge Regional Airport', station: 'KARG', elevation: 279, temperature: 30, area: 'flat farmland and the town to the north' };
const thrushRecord = (id: string, maintenance: string): ControlRecord => ({
  ntsbNo: id,
  date: '2021-07-08',
  city: 'Walnut Ridge',
  state: 'AR',
  aircraft: [{ make: 'Thrush', model: 'S2R-R1340', category: 'AIR', farPart: '137', purpose: 'AAPL', phase: 'maneuvering', engine: 'REC' }],
  factual: `The commercial pilot was applying herbicide to a soybean field. During the pull-up at the end of a swath run, the engine lost power, and the pilot landed the airplane in the field ahead, where it nosed over in the soft soil.\n\n${context(id, WALNUT_RIDGE, 2)}\n\n${maintenance}\n\nExamination of the engine did not reveal any anomalies that would have precluded normal operation.`,
  analysis: 'The pilot reported a loss of engine power during the application flight. The reason for the loss of engine power could not be determined.',
  probableCause: 'A loss of engine power for reasons that could not be determined.',
  findings: [],
  occurrences: [{ aircraft: 1, code: '341', phase: 'maneuvering', description: 'Maneuvering-low-alt flying Loss of engine power (total)', defining: true }],
});

const BOISE: FillerPlace = { airport: 'Caldwell Executive Airport', station: 'KEUL', elevation: 2432, temperature: 21, area: 'farmland and the city to the north' };
const cubRecord = (id: string, timing: string, aircraft: ControlAircraft = { make: 'Piper', model: 'PA-18-150', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'landing', engine: 'REC' }): ControlRecord => ({
  ntsbNo: id,
  date: '2019-06-22',
  city: 'Caldwell',
  state: 'ID',
  aircraft: [aircraft],
  factual: `The private pilot reported that, during the landing roll on runway 30 in a gusting right crosswind, the airplane weathervaned into the wind and he could not keep it on the runway; the airplane ground looped, and the left wing struck the ground.\n\n${context(id, BOISE, 2)}\n\n${timing}`,
  analysis: 'The pilot did not maintain directional control during the landing roll in gusting crosswind conditions.',
  probableCause: "The pilot's failure to maintain directional control during the landing roll in gusting crosswind conditions, which resulted in a ground loop.",
  findings: [],
  occurrences: [{ aircraft: 1, code: '230', phase: 'landing', description: 'Landing-landing roll Loss of control on ground', defining: true }],
});

const BILLINGS: FillerPlace = { airport: 'Billings Logan International Airport', station: 'KBIL', elevation: 3652, temperature: 24, area: 'sandstone bluffs above the city of Billings' };
/** A helicopter's precautionary landing after a control vibration (fix round 2, the gate's item 5: the 10-hour window's boundaries). */
const rotorRecord = (id: string, maintenance: string): ControlRecord => ({
  ntsbNo: id,
  date: '2022-08-06',
  city: 'Billings',
  state: 'MT',
  aircraft: [{ make: 'Bell', model: '206L-4', category: 'HELI', farPart: '091', purpose: 'BUS', phase: 'landing', engine: 'TS' }],
  factual: `The commercial pilot was flying the helicopter to a ranch north of the city. He reported that, during the approach to the ranch's landing area, he felt a vibration in the cyclic and decided to land at once; during the landing in a pasture, the left skid caught a fence and the helicopter rolled onto its side.\n\n${context(id, BILLINGS, 2, 'helicopter')}\n\n${maintenance}\n\nExamination of the flight controls and the main and tail rotor systems found no anomalies that would have caused a vibration.`,
  analysis: 'The reason for the vibration the pilot reported could not be determined. The pilot did not maintain clearance from the fence during the precautionary landing.',
  probableCause: "The pilot's failure to maintain clearance from a fence during a precautionary landing.",
  findings: [],
  occurrences: [
    { aircraft: 1, code: '470', phase: 'landing', description: 'Landing Collision with terr/obj (non-CFIT)', defining: true },
    { aircraft: 1, code: '097', phase: 'landing', description: 'Landing Roll over', defining: false },
  ],
});

export const CHRONOLOGY_READING: readonly Control[] = [
  {
    id: 'chr-thrush-tach-inside',
    family: 'chronology',
    mutation: 'base',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 2,
    reading: 'novel',
    record: thrushRecord('CEN21LA901', "According to the maintenance records, a new engine-driven fuel pump was installed at a tachometer time of 2,881.4 hours. The airplane's tachometer read 2,889.9 hours at the accident site."),
    anchors: ['a new engine-driven fuel pump was installed at a tachometer time of 2,881.4 hours', "The airplane's tachometer read 2,889.9 hours at the accident site."],
    note: 'Two readings of one clock: 8.5 tachometer hours after an engine accessory was installed, inside the window.',
  },
  {
    id: 'chr-thrush-tach-outside',
    family: 'chronology',
    mutation: 'outside_window',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 0,
    reading: 'novel',
    record: thrushRecord('CEN21LA902', "According to the maintenance records, a new engine-driven fuel pump was installed at a tachometer time of 2,881.4 hours. The airplane's tachometer read 2,912.0 hours at the accident site."),
    anchors: ['a new engine-driven fuel pump was installed at a tachometer time of 2,881.4 hours', "The airplane's tachometer read 2,912.0 hours at the accident site."],
    note: 'Two readings of one clock: 30.6 tachometer hours, outside the window.',
  },
  {
    id: 'chr-thrush-loads-only',
    family: 'chronology',
    mutation: 'flight_count',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 1,
    reading: 'novel',
    record: thrushRecord('CEN21LA903', 'A new engine-driven fuel pump was installed 6 days before the accident. The operator stated that the airplane had flown 11 loads since the installation; the flight time of the loads was not recorded.'),
    anchors: ['the airplane had flown 11 loads since the installation; the flight time of the loads was not recorded'],
    note: 'A number of flights and calendar days, never converted into hours: the interval is not stated, partial.',
  },
  {
    id: 'chr-thrush-mixed-clocks',
    family: 'chronology',
    mutation: 'mixed_clocks',
    question: 'mc-ag-arkansas-engine-after-maintenance',
    label: 1,
    reading: 'edge-case',
    record: thrushRecord('CEN21LA904', "A new engine-driven fuel pump was installed when the airplane's Hobbs meter read 1,604.2 hours. At the accident the airplane's tachometer read 2,889.9 hours; the Hobbs reading at the accident was not recorded."),
    anchors: ["A new engine-driven fuel pump was installed when the airplane's Hobbs meter read 1,604.2 hours.", 'the Hobbs reading at the accident was not recorded'],
    note: 'One end on the Hobbs meter, the other on the tachometer: never compared, partial.',
  },
  {
    id: 'chr-cub-not-flown-since',
    family: 'chronology',
    mutation: 'base',
    question: 'mc-first-flight-after-annual',
    label: 2,
    reading: 'novel',
    record: cubRecord('WPR19LA901', "The airplane's annual inspection was completed 9 days before the accident, and the airplane remained in the maintenance hangar until the owner retrieved it on the day of the accident. The accident flight was the airplane's first flight since the inspection."),
    anchors: ["The accident flight was the airplane's first flight since the inspection."],
    note: 'First flight after the annual, stated, although the annual was more than 7 days before: grade 2.',
  },
  {
    id: 'chr-cub-two-flights',
    family: 'chronology',
    mutation: 'not_first_flight',
    question: 'mc-first-flight-after-annual',
    label: 0,
    reading: 'novel',
    record: cubRecord('WPR19LA902', "The airplane's annual inspection was completed 4 days before the accident. Fuel receipts and the owner's logbook showed that he flew the airplane on a local flight on each of the 2 days before the accident."),
    anchors: ['he flew the airplane on a local flight on each of the 2 days before the accident'],
    note: 'Two earlier flights after a recent annual are stated: grade 0.',
  },
  {
    id: 'chr-cub-condition-recent',
    family: 'chronology',
    mutation: 'ordinal_not_stated',
    question: 'mc-first-flight-after-annual',
    label: 1,
    reading: 'novel',
    record: cubRecord(
      'WPR19LA903',
      "The amateur-built airplane's condition inspection was completed 2 days before the accident. The pilot did not report whether he had flown the airplane between the inspection and the accident flight, and no flight records were found.",
      { make: 'Vans', model: 'RV-7', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'landing', engine: 'REC' },
    ),
    anchors: ["The amateur-built airplane's condition inspection was completed 2 days before the accident.", 'no flight records were found'],
    note: 'A condition inspection (the annual of an amateur-built airplane) 2 days before, the flight count unknown: partial.',
  },
  {
    id: 'chr-rotor-hobbs-exact',
    family: 'chronology',
    mutation: 'boundary_inside',
    question: 'mc-helicopter-control-rotor-maintenance-10h',
    label: 2,
    reading: 'novel',
    record: rotorRecord('WPR22LA921', "According to the maintenance records, the main rotor blades were replaced at a Hobbs reading of 1,862.4 hours. The helicopter's Hobbs meter read 1,872.4 hours at the accident site."),
    anchors: ['the main rotor blades were replaced at a Hobbs reading of 1,862.4 hours', "The helicopter's Hobbs meter read 1,872.4 hours at the accident site."],
    note: 'Two readings of one clock, exactly 10.0 hours apart: "10 hours or less" holds, grade 2.',
  },
  {
    id: 'chr-rotor-hobbs-just-over',
    family: 'chronology',
    mutation: 'boundary_outside',
    question: 'mc-helicopter-control-rotor-maintenance-10h',
    label: 0,
    reading: 'novel',
    record: rotorRecord('WPR22LA922', "According to the maintenance records, the main rotor blades were replaced at a Hobbs reading of 1,862.4 hours. The helicopter's Hobbs meter read 1,872.9 hours at the accident site."),
    anchors: ['the main rotor blades were replaced at a Hobbs reading of 1,862.4 hours', "The helicopter's Hobbs meter read 1,872.9 hours at the accident site."],
    note: 'Two exact readings of one clock, 10.5 hours apart, and no other clock: every clock beyond the limit, grade 0.',
  },
  {
    id: 'chr-rotor-clocks-disagree',
    family: 'chronology',
    mutation: 'clocks_disagree',
    question: 'mc-helicopter-control-rotor-maintenance-10h',
    label: 1,
    reading: 'edge-case',
    record: rotorRecord(
      'WPR22LA923',
      "According to the maintenance records, the tail rotor pitch links were replaced when the helicopter's hour meter read 902.5 hours and its Hobbs meter read 1,866.0 hours. At the accident the hour meter read 911.8 hours and the Hobbs meter read 1,877.2 hours.",
    ),
    anchors: ["the tail rotor pitch links were replaced when the helicopter's hour meter read 902.5 hours and its Hobbs meter read 1,866.0 hours", 'At the accident the hour meter read 911.8 hours and the Hobbs meter read 1,877.2 hours.'],
    note: 'The hour meter gives 9.3 hours and the Hobbs meter 11.2: the clocks disagree, partial (the rubric names it).',
  },
  {
    id: 'chr-rotor-first-flight-timed',
    family: 'chronology',
    mutation: 'first_flight_timed',
    question: 'mc-helicopter-control-rotor-maintenance-10h',
    label: 2,
    reading: 'edge-case',
    record: rotorRecord('WPR22LA924', 'The swashplate had been replaced the day before the accident, and the accident flight was the first flight after the replacement; the accident happened about 25 minutes after takeoff.'),
    anchors: ['the accident flight was the first flight after the replacement; the accident happened about 25 minutes after takeoff'],
    note: 'The first flight after the work, with its flight time stated (about 25 minutes): inside the window, grade 2.',
  },
  {
    id: 'chr-rotor-first-flight-untimed',
    family: 'chronology',
    mutation: 'first_flight_untimed',
    question: 'mc-helicopter-control-rotor-maintenance-10h',
    label: 1,
    reading: 'edge-case',
    record: rotorRecord('WPR22LA925', 'The swashplate had been replaced the day before the accident, and the accident flight was the first flight after the replacement; the time of the takeoff was not recorded.'),
    anchors: ['the accident flight was the first flight after the replacement; the time of the takeoff was not recorded'],
    note: 'The first flight after the work without its flight time: the interval is not stated, partial.',
  },
  {
    id: 'chr-rotor-split-ends',
    family: 'chronology',
    mutation: 'mixed_clocks',
    question: 'mc-helicopter-control-rotor-maintenance-10h',
    label: 1,
    reading: 'edge-case',
    record: rotorRecord('WPR22LA926', "According to the maintenance records, a cyclic servo was replaced when the helicopter's Hobbs meter read 1,866.0 hours. At the accident the hour meter read 911.8 hours; the Hobbs reading at the accident was not recorded."),
    anchors: ["a cyclic servo was replaced when the helicopter's Hobbs meter read 1,866.0 hours", 'the Hobbs reading at the accident was not recorded'],
    note: 'One end on the Hobbs meter, the other on the hour meter: no clock gives the interval, partial.',
  },
];

// ---------------------------------------------------------------------------
// Pilot statement against investigator finding: att-engine and att-yaw (holdout)

const BOZEMAN: FillerPlace = { airport: 'Bozeman Yellowstone International Airport', station: 'KBZN', elevation: 4473, temperature: 16, area: 'farmland and the town of Belgrade, with mountains to the south' };
/** How a claim record's flight ended, as the investigators tell it, with its phase and coded rows (fix round 2, review N2 and N4: each variant is coherent on its own). */
interface ClaimEnding {
  narrative: string;
  analysis: string;
  phase: string;
  occurrences: ControlRecord['occurrences'];
  damage?: string;
}
/** The pilot's reported power loss and forced landing; the coded rows record the landing only, since the investigators did not find a power loss. */
const FORCED_LANDING: ClaimEnding = {
  narrative: 'The pilot made a forced landing in a hayfield, where the airplane struck an irrigation pivot.',
  analysis: 'The pilot made a forced landing in a hayfield after he reported that the engine had quit.',
  phase: 'emergency_descent',
  occurrences: [{ aircraft: 1, code: '440', phase: 'emergency_descent', description: 'Emergency descent Off-field or emergency landing', defining: true }],
};
/** The same landing after a fuel starvation the investigators found. */
const STARVATION_LANDING: ClaimEnding = {
  ...FORCED_LANDING,
  analysis: 'The pilot made a forced landing in a hayfield after the engine lost power from fuel starvation.',
  phase: 'en_route',
  occurrences: [
    { aircraft: 1, code: '191', phase: 'en_route', description: 'Enroute-cruise Fuel starvation', defining: false },
    { aircraft: 1, code: '341', phase: 'en_route', description: 'Enroute-cruise Loss of engine power (total)', defining: true },
    { aircraft: 1, code: '440', phase: 'emergency_descent', description: 'Emergency descent Off-field or emergency landing', defining: false },
  ],
};
const engineClaimRecord = (id: string, claim: string, exam: string, probable: string, ending: ClaimEnding = FORCED_LANDING): ControlRecord => ({
  ntsbNo: id,
  date: '2020-08-29',
  city: 'Belgrade',
  state: 'MT',
  aircraft: [{ make: 'Beech', model: 'A36', category: 'AIR', farPart: '091', purpose: 'PERS', phase: ending.phase, engine: 'REC', ...(ending.damage ? { damage: ending.damage } : {}) }],
  factual: `${claim} ${ending.narrative}\n\n${context(id, BOZEMAN, 2)}\n\n${exam}`,
  analysis: ending.analysis,
  probableCause: probable,
  findings: [],
  occurrences: ending.occurrences,
});

const FREDERICKSBURG: FillerPlace = { airport: 'Gillespie County Airport', station: 'KT82', elevation: 1695, temperature: 33, area: 'rolling ranch land and vineyards' };
const yawRecord = (id: string, claim: string, exam: string, analysis: string, probable: string): ControlRecord => ({
  ntsbNo: id,
  date: '2021-09-11',
  city: 'Fredericksburg',
  state: 'TX',
  aircraft: [{ make: 'Robinson', model: 'R66', category: 'HELI', farPart: '091', purpose: 'PERS', phase: 'maneuvering', engine: 'TS' }],
  factual: `${claim} The helicopter rotated several times before it struck the ground on its right side.\n\n${context(id, FREDERICKSBURG, 2, 'helicopter')}\n\n${exam}`,
  analysis,
  probableCause: probable,
  findings: [],
  occurrences: [{ aircraft: 1, code: '240', phase: 'maneuvering', description: 'Maneuvering-low-alt flying Loss of control in flight', defining: true }],
});

export const ATTRIBUTION_READING: readonly Control[] = [
  {
    id: 'att-engine-test-run',
    family: 'pilot_vs_investigator',
    mutation: 'base',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 2,
    reading: 'novel',
    record: engineClaimRecord(
      'WPR20LA901',
      'The pilot reported that, about 15 minutes after takeoff, "the engine quit" and would not restart.',
      'After the accident the engine was test-run on the airframe with a temporary fuel supply; it started immediately and produced rated power through its full range, and no anomalies were noted.',
      'A reported loss of engine power for reasons that could not be determined, because the engine ran normally when tested.',
    ),
    anchors: ['"the engine quit"', 'it started immediately and produced rated power through its full range'],
    note: 'The pilot reported the engine quit; the test run found it working: grade 2.',
  },
  {
    id: 'att-engine-selector-found',
    family: 'pilot_vs_investigator',
    mutation: 'contradiction',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 0,
    reading: 'novel',
    record: engineClaimRecord(
      'WPR20LA902',
      'The pilot reported that, about 15 minutes after takeoff, "the engine quit" and would not restart.',
      "Examination of the fuel system found that the detent of the fuel selector valve was worn, which allowed the valve to rest between tank positions and block the fuel flow to the engine.",
      'A total loss of engine power due to fuel starvation, which resulted from a worn fuel selector valve detent.',
      STARVATION_LANDING,
    ),
    anchors: ['the detent of the fuel selector valve was worn, which allowed the valve to rest between tank positions and block the fuel flow to the engine'],
    note: 'The examination found a mechanical cause of the reported power loss: the reported problem was confirmed, grade 0.',
  },
  {
    id: 'att-engine-brake-burned',
    family: 'pilot_vs_investigator',
    mutation: 'unresolved',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 1,
    reading: 'novel',
    record: engineClaimRecord(
      'WPR20LA903',
      'The pilot reported that, during the landing roll at the destination, the left brake "locked" and the airplane veered off the runway.',
      'The airplane was destroyed by a postimpact fire, and the brake system could not be examined.',
      'A loss of directional control during the landing roll for reasons that could not be determined.',
      {
        narrative: 'The airplane departed the left side of the runway, struck a drainage culvert and came to rest inverted, and a fire started.',
        analysis: 'Because the fire destroyed the brake system, the investigation could not determine why the airplane veered off the runway.',
        phase: 'landing',
        damage: 'DEST',
        occurrences: [
          { aircraft: 1, code: '230', phase: 'landing', description: 'Landing-landing roll Loss of control on ground', defining: true },
          { aircraft: 1, code: '170', phase: 'post_impact', description: 'Post-impact Fire/smoke (post-impact)', defining: false },
        ],
      },
    ),
    anchors: ['the left brake "locked"', 'the brake system could not be examined'],
    note: 'A reported failure the fire made impossible to examine: partial. Fix round 2: a landing-roll record throughout, no forced landing (review N4).',
  },
  {
    id: 'att-engine-passenger-claim',
    family: 'pilot_vs_investigator',
    mutation: 'wrong_speaker',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 0,
    reading: 'novel',
    record: engineClaimRecord(
      'WPR20LA904',
      'The pilot was landing at a private grass airstrip on a ranch. A passenger reported that the engine "stopped running" during the descent. The pilot stated that the engine operated normally throughout the flight and that he had misjudged the approach to the airstrip.',
      'Examination of the engine revealed no anomalies.',
      "The pilot's misjudgment of the approach to a private airstrip, which resulted in a collision with an irrigation pivot.",
      {
        narrative: 'The airplane touched down short of the airstrip, in a hayfield, where it struck an irrigation pivot.',
        analysis: 'The pilot misjudged the approach to the private airstrip, and the airplane touched down short of it.',
        phase: 'approach',
        occurrences: [
          { aircraft: 1, code: '370', phase: 'approach', description: 'Approach-VFR pattern final Landing area undershoot', defining: true },
          { aircraft: 1, code: '470', phase: 'landing', description: 'Landing Collision with terr/obj (non-CFIT)', defining: false },
        ],
      },
    ),
    anchors: ['The pilot stated that the engine operated normally throughout the flight'],
    note: 'Only a passenger reported a problem; the pilot reported none: grade 0, a speaker trap the rubric does not spell out for passengers. Fix round 2: no sentence of the investigators says the pilot reported a problem (review N2).',
  },
  {
    id: 'att-yaw-lost-control',
    family: 'pilot_vs_investigator',
    mutation: 'no_failure_claim',
    question: 'pv-helicopter-tail-rotor-claim',
    label: 1,
    reading: 'novel',
    record: yawRecord(
      'CEN21LA905',
      'The pilot reported that, while hovering downwind over a pasture, he "lost tail rotor control" and the helicopter spun to the right.',
      'Examination established tail rotor drive continuity from the main gearbox to the tail rotor, and no anomalies were found with the tail rotor system or its controls.',
      'The right yaw was consistent with a loss of tail rotor effectiveness in the downwind hover.',
      "The pilot's loss of yaw control while hovering downwind, which resulted in a loss of tail rotor effectiveness.",
    ),
    anchors: ['he "lost tail rotor control"', 'no anomalies were found with the tail rotor system or its controls'],
    note: 'A reported loss of control, no claim that anything failed, and no failure found: partial.',
  },
  {
    id: 'att-yaw-shaft-claim',
    family: 'pilot_vs_investigator',
    mutation: 'base',
    question: 'pv-helicopter-tail-rotor-claim',
    label: 2,
    reading: 'novel',
    record: yawRecord(
      'CEN21LA906',
      'The pilot reported that "the tail rotor drive shaft must have broken" because the pedals had no effect.',
      'Examination found the tail rotor drive shaft intact and continuous from the main gearbox to the tail rotor gearbox, and the tail rotor blades showed leading-edge damage consistent with rotation under power at impact.',
      'The right yaw was consistent with a loss of tail rotor effectiveness in the gusting wind.',
      "The pilot's loss of yaw control in gusting wind, which resulted in a loss of tail rotor effectiveness.",
    ),
    anchors: ['"the tail rotor drive shaft must have broken"', 'Examination found the tail rotor drive shaft intact and continuous'],
    note: 'A failure claim the examination did not bear out: grade 2.',
  },
  {
    id: 'att-yaw-gearbox-seized',
    family: 'pilot_vs_investigator',
    mutation: 'contradiction',
    question: 'pv-helicopter-tail-rotor-claim',
    label: 0,
    reading: 'novel',
    record: yawRecord(
      'CEN21LA907',
      'The pilot reported that "the tail rotor quit" while he was maneuvering at low altitude.',
      "The tail rotor gearbox contained no oil, and its output shaft bearings had seized; the gearbox's filler cap was found loose.",
      'The loss of oil from the tail rotor gearbox resulted in the seizure of its bearings and a loss of tail rotor thrust.',
      'The seizure of the tail rotor gearbox bearings due to a loss of oil, which resulted in a loss of tail rotor thrust.',
    ),
    anchors: ['its output shaft bearings had seized'],
    note: 'The examination found a tail rotor system failure: grade 0.',
  },
];

// ---------------------------------------------------------------------------
// Cross-aircraft attribution with aircraft-scoped sections: mx-scoped and mx-ramp (holdout)

const VERO: FillerPlace = { airport: 'Vero Beach Regional Airport', station: 'KVRB', elevation: 24, temperature: 28, area: 'citrus groves, neighborhoods and the city to the east' };
const scopedRecord = (id: string, piperPurpose: string, piper: string, cessna: string): ControlRecord => ({
  ntsbNo: id,
  date: '2022-03-19',
  city: 'Vero Beach',
  state: 'FL',
  aircraft: [
    { make: 'Piper', model: 'PA-28-161', category: 'AIR', farPart: '091', purpose: piperPurpose, phase: 'landing', engine: 'REC' },
    { make: 'Cessna', model: '152', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'landing', engine: 'REC' },
  ],
  factual: `The Piper and the Cessna collided while both were landing on runway 31; the Cessna's right wing struck the Piper's horizontal stabilizer about 30 ft above the runway, and both airplanes came to rest on the runway.\n\n${context(id, VERO, 2)}`,
  aircraftSections: [
    { aircraft: 1, text: piper },
    { aircraft: 2, text: cessna },
  ],
  analysis: 'Both pilots were responsible for seeing and avoiding the other airplane while landing.',
  probableCause: 'The failure of both pilots to see and avoid the other airplane while landing.',
  findings: [],
  occurrences: [
    { aircraft: 1, code: '250', phase: 'landing', description: 'Landing-flare/touchdown Midair collision', defining: true },
    { aircraft: 2, code: '250', phase: 'landing', description: 'Landing-flare/touchdown Midair collision', defining: true },
  ],
});

const PEACHTREE: FillerPlace = { airport: 'Peachtree City Airport', station: 'KFFC', elevation: 808, temperature: 25, area: 'wooded neighborhoods connected by golf cart paths' };
const rampRecord = (id: string, cessna: string, beech: string, cessnaPhase = 'taxi', beechPhase = 'standing'): ControlRecord => ({
  ntsbNo: id,
  date: '2021-10-16',
  city: 'Peachtree City',
  state: 'GA',
  event: { highestInjury: 'NONE' },
  aircraft: [
    { make: 'Cessna', model: '182T', category: 'AIR', farPart: '091', purpose: 'PERS', phase: cessnaPhase, engine: 'REC' },
    { make: 'Beech', model: '58', category: 'AIR', farPart: '091', purpose: 'BUS', phase: beechPhase, engine: 'REC' },
  ],
  factual: `The two airplanes collided on the ramp in front of the fixed base operator; the Cessna's left wingtip struck the Beech's right horizontal stabilizer.\n\n${context(id, PEACHTREE, 2)}`,
  aircraftSections: [
    { aircraft: 1, text: cessna },
    { aircraft: 2, text: beech },
  ],
  analysis: 'The collision occurred on the ramp in front of the fixed base operator.',
  probableCause: 'The failure to maintain clearance between the two airplanes on the ramp.',
  findings: [],
  occurrences: [
    { aircraft: 1, code: '200', phase: cessnaPhase, description: `${cessnaPhase === 'taxi' ? 'Taxi' : 'Pushback/towing'} Ground collision`, defining: true },
    { aircraft: 2, code: '200', phase: beechPhase, description: `${beechPhase === 'standing' ? 'Standing' : 'Pushback/towing'} Ground collision`, defining: true },
  ],
});

export const CROSS_AIRCRAFT_READING: readonly Control[] = [
  {
    id: 'mx-scoped-student-piper',
    family: 'cross_aircraft',
    mutation: 'base',
    question: 'ma-airplane-collision-student-pilot',
    label: 2,
    reading: 'novel',
    record: scopedRecord(
      'ERA22MA905',
      'INST',
      'The pilot of the Piper, age 19, held a student pilot certificate and was on her third solo flight.',
      'The pilot of the Cessna held a commercial pilot certificate and was returning from a local flight.',
    ),
    anchors: ['held a student pilot certificate and was on her third solo flight'],
    note: "The student is named only in the Piper's own section: grade 2, read across aircraft-scoped sections.",
  },
  {
    id: 'mx-scoped-student-passenger',
    family: 'cross_aircraft',
    mutation: 'wrong_role',
    question: 'ma-airplane-collision-student-pilot',
    label: 0,
    reading: 'novel',
    record: scopedRecord(
      'ERA22MA906',
      'PERS',
      'The Piper was flown by its owner, who held a private pilot certificate; a student pilot rode in the right seat as a passenger and did not manipulate the controls.',
      'The pilot of the Cessna held a commercial pilot certificate.',
    ),
    anchors: ['a student pilot rode in the right seat as a passenger and did not manipulate the controls'],
    note: 'A student pilot on board, but as a passenger: grade 0.',
  },
  {
    id: 'mx-scoped-instruction-unknown',
    family: 'cross_aircraft',
    mutation: 'unresolved',
    question: 'ma-airplane-collision-student-pilot',
    label: 1,
    reading: 'novel',
    record: scopedRecord(
      'ERA22MA907',
      'INST',
      'The Piper was on an instructional flight with a flight instructor on board; the investigation did not determine what pilot certificate the person receiving instruction held.',
      'The pilot of the Cessna held a commercial pilot certificate.',
    ),
    anchors: ['the investigation did not determine what pilot certificate the person receiving instruction held'],
    note: 'Instruction in one colliding airplane, the certificate unknown: partial.',
  },
  {
    id: 'mx-scoped-rating-training',
    family: 'cross_aircraft',
    mutation: 'wrong_role',
    question: 'ma-airplane-collision-student-pilot',
    label: 0,
    reading: 'novel',
    record: scopedRecord(
      'ERA22MA908',
      'INST',
      'The pilot of the Piper held a private pilot certificate and was receiving instruction toward an instrument rating from the flight instructor on board.',
      'The pilot of the Cessna held an airline transport pilot certificate.',
    ),
    anchors: ['held a private pilot certificate and was receiving instruction toward an instrument rating'],
    note: 'Instruction, but of a certificated pilot for a rating, with the purpose "Instructional" in the header: grade 0.',
  },
  {
    id: 'mx-ramp-parked',
    family: 'cross_aircraft',
    mutation: 'base',
    question: 'ma-taxiing-strikes-stationary',
    label: 2,
    reading: 'novel',
    record: rampRecord('ERA21LA901', 'The pilot was taxiing the Cessna to the self-serve fuel pump and did not see the other airplane.', 'The Beech was parked and tied down on the ramp, with no one on board.'),
    anchors: ['The pilot was taxiing the Cessna to the self-serve fuel pump', 'The Beech was parked and tied down on the ramp'],
    note: "Who moved and who was parked is in each aircraft's own section: grade 2.",
  },
  {
    id: 'mx-ramp-towed',
    family: 'cross_aircraft',
    mutation: 'neither_stationary',
    question: 'ma-taxiing-strikes-stationary',
    label: 1,
    reading: 'novel',
    record: rampRecord('ERA21LA902', 'The pilot was taxiing the Cessna to the self-serve fuel pump.', 'The Beech was being towed by a line service tug toward the hangar at the time.', 'taxi', 'pushback'),
    anchors: ['The Beech was being towed by a line service tug toward the hangar at the time.'],
    note: 'The struck airplane was moving (towed): both were moving, partial.',
  },
  {
    id: 'mx-ramp-pushed',
    family: 'cross_aircraft',
    mutation: 'wrong_phase',
    question: 'ma-taxiing-strikes-stationary',
    label: 1,
    reading: 'novel',
    record: rampRecord(
      'ERA21LA903',
      'A ground crew member was pushing the Cessna backward into a parking spot with a tow bar when its left wingtip struck the other airplane; the engine was not running.',
      'The Beech was parked and tied down on the ramp, with no one on board.',
      'pushback',
      'standing',
    ),
    anchors: ['A ground crew member was pushing the Cessna backward into a parking spot with a tow bar'],
    note: 'The moving airplane was pushed by hand, not taxiing: partial.',
  },
  {
    id: 'mx-ramp-stopped-running',
    family: 'cross_aircraft',
    mutation: 'stopped_engine_running',
    question: 'ma-taxiing-strikes-stationary',
    label: 2,
    reading: 'novel',
    record: rampRecord('ERA21LA904', 'The pilot was taxiing the Cessna toward the runway.', 'The Beech was stopped on the ramp with both engines running while the pilot waited for a passenger.'),
    anchors: ['The pilot was taxiing the Cessna toward the runway.', 'The Beech was stopped on the ramp with both engines running'],
    note: 'A stopped airplane with its engines running is still stopped: grade 2.',
  },
];

// ---------------------------------------------------------------------------
// Causal uncertainty: cu-show and cu-compete (dev), cu-fire and cu-show2 (holdout)

const OSHKOSH: FillerPlace = { airport: 'Wittman Regional Airport', station: 'KOSH', elevation: 808, temperature: 27, area: 'farmland, the city and Lake Winnebago to the east' };
const SHOW_LOSS_OF_CONTROL = { aircraft: 1, code: '240', phase: 'maneuvering', description: 'Maneuvering-aerobatics Loss of control in flight', defining: true };
const showRecord = (id: string, exam: string, analysis: string, probable: string, occurrence: ControlRecord['occurrences'][number] = SHOW_LOSS_OF_CONTROL): ControlRecord => ({
  ntsbNo: id,
  date: '2019-07-27',
  city: 'Oshkosh',
  state: 'WI',
  aircraft: [{ make: 'Extra', model: 'EA 330SC', category: 'AIR', farPart: '091', purpose: 'ASHO', phase: 'maneuvering', engine: 'REC', damage: 'DEST' }],
  factual: `The pilot was performing an aerobatic routine at an air show. Spectator video showed the airplane complete a hammerhead turn and enter a vertical downline at about 1,500 ft above ground level; the airplane did not recover and struck the ground in a nose-low attitude.\n\n${context(id, OSHKOSH, 2)}\n\n${exam}`,
  analysis,
  probableCause: probable,
  findings: [],
  occurrences: [occurrence],
  event: { highestInjury: 'FATL' },
});
const SHOW_EXAM = 'Examination of the airframe and the engine revealed no preimpact anomalies, and flight control continuity was established.';

const DURANGO: FillerPlace = { airport: 'Durango-La Plata County Airport', station: 'KDRO', elevation: 6685, temperature: 4, area: 'mesas and ranch land, with mountains to the north' };
const competeRecord = (id: string, analysis: string, probable: string): ControlRecord => ({
  ntsbNo: id,
  date: '2018-12-02',
  city: 'Durango',
  state: 'CO',
  aircraft: [{ make: 'Beech', model: 'V35B', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'en_route', engine: 'REC', damage: 'DEST' }],
  factual: `The instrument-rated private pilot was on a cross-country flight under an instrument flight rules clearance. About 20 minutes after takeoff, while in instrument meteorological conditions, the airplane entered a descending right turn that steepened until it broke up in flight; the wreckage was scattered over about half a mile of wooded terrain.\n\n${context(id, DURANGO, 2)}`,
  analysis,
  probableCause: probable,
  findings: [],
  occurrences: [{ aircraft: 1, code: '240', phase: 'en_route', description: 'Enroute-cruise Loss of control in flight', defining: true }],
  event: { highestInjury: 'FATL', weather: 'IMC' },
});

const KNOXVILLE: FillerPlace = { airport: 'McGhee Tyson Airport', station: 'KTYS', elevation: 981, temperature: 22, area: 'the city of Alcoa and wooded hills, with mountains to the east' };
const IN_FLIGHT_FIRE: ControlRecord['occurrences'] = [{ aircraft: 1, code: '150', phase: 'en_route', description: 'Enroute-cruise Fire/smoke (non-impact)', defining: true }];
const fireRecord = (id: string, report: string, exam: string, analysis: string, probable: string, occurrences: ControlRecord['occurrences'] = IN_FLIGHT_FIRE, damage?: string): ControlRecord => ({
  ntsbNo: id,
  date: '2020-04-18',
  city: 'Alcoa',
  state: 'TN',
  aircraft: [{ make: 'Cessna', model: '340A', category: 'AIR', farPart: '091', purpose: 'BUS', phase: 'en_route', engine: 'REC', ...(damage ? { damage } : {}) }],
  factual: `${report}\n\n${context(id, KNOXVILLE, 2)}\n\n${exam}`,
  analysis,
  probableCause: probable,
  findings: [],
  occurrences: occurrences.map((o) => ({ ...o })),
});
const SMOKE_REPORT =
  'The pilot reported that, during cruise flight at 9,000 ft, he smelled smoke and saw smoke coming from behind the instrument panel. He declared an emergency, diverted to a nearby airport and landed; the occupants evacuated as smoke filled the cabin.';

const RENO: FillerPlace = { airport: 'Reno Stead Airport', station: 'KRTS', elevation: 5050, temperature: 29, area: 'high desert with sagebrush and low hills' };
const raceRecord = (id: string, factual: string, analysis: string, probable: string, occurrence: ControlRecord['occurrences'][number] = { aircraft: 1, code: '240', phase: 'maneuvering', description: 'Maneuvering Loss of control in flight', defining: true }): ControlRecord => ({
  ntsbNo: id,
  date: '2017-09-16',
  city: 'Reno',
  state: 'NV',
  aircraft: [{ make: 'Cassutt', model: 'IIIM', category: 'AIR', farPart: '091', purpose: 'ASHO', phase: 'maneuvering', engine: 'REC', damage: 'DEST' }],
  factual: `${factual}\n\n${context(id, RENO, 2)}`,
  analysis,
  probableCause: probable,
  findings: [],
  occurrences: [occurrence],
  event: { highestInjury: 'FATL' },
});

export const CAUSAL_READING: readonly Control[] = [
  {
    id: 'cu-show-why-undetermined',
    family: 'causal_uncertainty',
    mutation: 'base',
    question: 'cu-air-show-undetermined',
    label: 2,
    reading: 'edge-case',
    record: showRecord(
      'CEN19FA901',
      SHOW_EXAM,
      "The investigation could not determine why the pilot did not begin the pull-out from the downline at the planned altitude. The pilot's toxicology tests were negative, and the autopsy found no evidence of a medical condition.",
      "The pilot's failure to begin the recovery from a vertical downline at a sufficient altitude for reasons that could not be determined.",
    ),
    anchors: ['The investigation could not determine why the pilot did not begin the pull-out from the downline at the planned altitude.'],
    note: 'Why the pilot did not recover could not be determined: grade 2.',
  },
  {
    id: 'cu-show-gloc-likely',
    family: 'causal_uncertainty',
    mutation: 'likely_reason',
    question: 'cu-air-show-undetermined',
    label: 1,
    reading: 'edge-case',
    record: showRecord(
      'CEN19FA902',
      SHOW_EXAM,
      'The pilot likely experienced G-induced loss of consciousness during the high-G pull-up into the hammerhead and was not able to begin the recovery from the downline.',
      "The pilot's likely incapacitation due to G-induced loss of consciousness, which resulted in a failure to recover from a vertical downline.",
    ),
    anchors: ['The pilot likely experienced G-induced loss of consciousness'],
    note: 'A likely reason: partial.',
  },
  {
    id: 'cu-show-late-pullout',
    family: 'causal_uncertainty',
    mutation: 'determined',
    question: 'cu-air-show-undetermined',
    label: 0,
    reading: 'edge-case',
    record: showRecord(
      'CEN19FA903',
      SHOW_EXAM,
      'Video and recorded data showed that the pilot began the pull-out about 400 ft lower than his routine called for, and the airplane did not have enough altitude to recover.',
      "The pilot's delayed initiation of the pull-out from a vertical downline, which resulted in a collision with terrain.",
      { aircraft: 1, code: '470', phase: 'maneuvering', description: 'Maneuvering-aerobatics Collision with terr/obj (non-CFIT)', defining: true },
    ),
    anchors: ['the pilot began the pull-out about 400 ft lower than his routine called for'],
    note: 'An established reason: grade 0.',
  },
  {
    id: 'cu-show-pushrod-fatigue',
    family: 'causal_uncertainty',
    mutation: 'determined_failure',
    question: 'cu-air-show-undetermined',
    label: 0,
    reading: 'novel',
    record: showRecord(
      'CEN19FA904',
      'Examination of the airframe found that the left aileron pushrod had separated at its rod end; the fracture surface showed fatigue.',
      'The fatigue separation of the left aileron pushrod resulted in a loss of roll control during the routine.',
      'The fatigue failure of the left aileron pushrod, which resulted in a loss of roll control.',
    ),
    anchors: ['the left aileron pushrod had separated at its rod end; the fracture surface showed fatigue'],
    note: 'A structural failure found at examination established the reason: grade 0.',
  },
  {
    id: 'cu-show-alternatives-open',
    family: 'causal_uncertainty',
    mutation: 'alternatives',
    question: 'cu-air-show-undetermined',
    label: 2,
    reading: 'novel',
    record: showRecord(
      'CEN19FA905',
      SHOW_EXAM,
      "The investigation considered a jam of the elevator controls by a loose object in the cockpit and an incapacitation of the pilot; the evidence available did not allow either one to be established or ruled out, and neither was considered more likely than the other.",
      "The airplane's failure to recover from a vertical downline for reasons that could not be determined.",
    ),
    anchors: ['the evidence available did not allow either one to be established or ruled out'],
    note: 'Two candidates, neither established nor called more likely: undetermined, grade 2.',
  },
  {
    id: 'cu-compete-either',
    family: 'causal_uncertainty',
    mutation: 'base',
    question: 'cu-competing-explanations',
    label: 2,
    reading: 'novel',
    record: competeRecord(
      'CEN18FA901',
      "The airplane's attitude indicator was destroyed, and its condition before the accident could not be determined. The descending turn could have resulted from the pilot's spatial disorientation or from a failure of the attitude indicator, and the evidence did not show which.",
      "The pilot's loss of airplane control in instrument meteorological conditions due to either spatial disorientation or a failure of the attitude indicator; the extent of the damage did not allow the investigation to determine which.",
    ),
    anchors: ['due to either spatial disorientation or a failure of the attitude indicator'],
    note: 'Two alternatives named and left open: grade 2.',
  },
  {
    id: 'cu-compete-settled',
    family: 'causal_uncertainty',
    mutation: 'settled',
    question: 'cu-competing-explanations',
    label: 1,
    reading: 'edge-case',
    record: competeRecord(
      'CEN18FA902',
      'The investigation considered both spatial disorientation and a failure of the vacuum-driven attitude indicator. The vacuum pump was found intact, and its drive coupling turned freely.',
      "The pilot's spatial disorientation, which resulted in a loss of airplane control in instrument meteorological conditions.",
    ),
    anchors: ['The investigation considered both spatial disorientation and a failure of the vacuum-driven attitude indicator.'],
    note: 'Alternatives discussed, and the probable cause settles on one: partial.',
  },
  {
    id: 'cu-compete-likely',
    family: 'causal_uncertainty',
    mutation: 'likely_reason',
    question: 'cu-competing-explanations',
    label: 1,
    reading: 'edge-case',
    record: competeRecord(
      'CEN18FA903',
      'The pilot had little recent experience flying in instrument conditions, and the descending turn was consistent with spatial disorientation.',
      "The pilot's loss of airplane control in instrument meteorological conditions, likely due to spatial disorientation.",
    ),
    anchors: ['likely due to spatial disorientation'],
    note: 'One likely cause, no alternative: partial.',
  },
  {
    id: 'cu-compete-undetermined-bare',
    family: 'causal_uncertainty',
    mutation: 'undetermined_no_candidates',
    question: 'cu-competing-explanations',
    label: 0,
    reading: 'novel',
    record: competeRecord(
      'CEN18FA904',
      'The wreckage was severely fragmented, and the examination found no evidence that explained the loss of control.',
      "The pilot's loss of airplane control in instrument meteorological conditions for reasons that could not be determined.",
    ),
    anchors: ["for reasons that could not be determined"],
    note: 'Undetermined, with no candidate explanation named: grade 0 for this question.',
  },
  {
    id: 'cu-fire-origin-undetermined',
    family: 'causal_uncertainty',
    mutation: 'base',
    question: 'cu-inflight-fire-origin-undetermined',
    label: 2,
    reading: 'edge-case',
    record: fireRecord(
      'ERA20FA901',
      SMOKE_REPORT,
      'The fire damage behind the instrument panel was extensive, and the investigation could not determine where the fire originated.',
      'The in-flight fire consumed the wiring and the instruments behind the panel.',
      'An in-flight fire of undetermined origin.',
    ),
    anchors: ['the investigation could not determine where the fire originated'],
    note: 'An in-flight fire of undetermined origin, no likely source named: grade 2.',
  },
  {
    id: 'cu-fire-heater-likely',
    family: 'causal_uncertainty',
    mutation: 'likely_reason',
    question: 'cu-inflight-fire-origin-undetermined',
    label: 1,
    reading: 'edge-case',
    record: fireRecord(
      'ERA20FA902',
      SMOKE_REPORT,
      "The cabin heater's combustion chamber showed a crack, and the fire most likely originated at the heater; the extent of the damage did not allow the investigation to confirm it.",
      'The fire most likely originated at the cracked combustion chamber of the cabin heater.',
      'An in-flight fire that most likely originated at the cabin heater.',
    ),
    anchors: ['the fire most likely originated at the heater'],
    note: 'A most likely source named: partial.',
  },
  {
    id: 'cu-fire-wire-chafe',
    family: 'causal_uncertainty',
    mutation: 'determined',
    question: 'cu-inflight-fire-origin-undetermined',
    label: 0,
    reading: 'edge-case',
    record: fireRecord(
      'ERA20FA903',
      SMOKE_REPORT,
      'A wire bundle behind the panel had chafed against a structural rib, and the exposed conductors showed arcing that had ignited the surrounding insulation.',
      'The chafed wire bundle arced and ignited the insulation behind the instrument panel.',
      'The chafing of a wire bundle, which resulted in arcing and an in-flight fire.',
    ),
    anchors: ['the exposed conductors showed arcing that had ignited the surrounding insulation'],
    note: 'An established source: grade 0.',
  },
  {
    id: 'cu-fire-more-likely',
    family: 'causal_uncertainty',
    mutation: 'alternatives_one_likelier',
    question: 'cu-inflight-fire-origin-undetermined',
    label: 1,
    reading: 'novel',
    record: fireRecord(
      'ERA20FA904',
      SMOKE_REPORT,
      'The fire damage was concentrated between the cabin heater and the radio stack.',
      'The investigation considered a failure of the cabin heater and an electrical short in the radio stack as sources of the fire and could not determine which one started it, although the heater was considered the more likely of the two.',
      'An in-flight fire whose source could not be determined.',
    ),
    anchors: ['although the heater was considered the more likely of the two'],
    note: 'Two candidate sources, one called more likely: partial, although the probable cause says undetermined.',
  },
  {
    id: 'cu-fire-nacelle-source-unknown',
    family: 'causal_uncertainty',
    mutation: 'location_known',
    question: 'cu-inflight-fire-origin-undetermined',
    label: 2,
    reading: 'novel',
    record: fireRecord(
      'ERA20FA905',
      'The pilot reported that, during cruise flight at 9,000 ft, the right engine fire warning light illuminated and he saw flames coming from the right engine nacelle. He shut down the right engine and landed at a nearby airport; the fire continued after the landing until firefighters put it out.',
      'The fire began in flight in the right engine nacelle. The engine accessories and the nacelle structure were consumed, and the investigation could not determine the source of the fire within the nacelle.',
      'The in-flight fire consumed the right engine nacelle.',
      'An in-flight fire in the right engine nacelle whose source could not be determined.',
    ),
    anchors: ['the investigation could not determine the source of the fire within the nacelle'],
    note: 'Where the fire burned is known, its source is not: grade 2.',
  },
  {
    id: 'cu-fire-postimpact-only',
    family: 'causal_uncertainty',
    mutation: 'no_inflight_fire',
    question: 'cu-inflight-fire-origin-undetermined',
    label: 0,
    reading: 'novel',
    record: fireRecord(
      'ERA20FA906',
      'The pilot reported a loss of power on the right engine during cruise flight and made a forced landing in a field, during which the airplane struck trees.',
      'A fire started at the ruptured right wing fuel tank after the airplane struck the trees; the investigation found no evidence of fire before the impact.',
      'The postimpact fire began at the ruptured right wing fuel tank.',
      'A loss of power on the right engine for reasons that could not be determined, which resulted in a forced landing.',
      [
        { aircraft: 1, code: '342', phase: 'en_route', description: 'Enroute-cruise Loss of engine power (partial)', defining: true },
        { aircraft: 1, code: '440', phase: 'emergency_descent', description: 'Emergency descent Off-field or emergency landing', defining: false },
        { aircraft: 1, code: '170', phase: 'post_impact', description: 'Post-impact Fire/smoke (post-impact)', defining: false },
      ],
      'DEST',
    ),
    anchors: ['the investigation found no evidence of fire before the impact'],
    note: 'Only a postimpact fire: grade 0.',
  },
  {
    id: 'cu-show2-spar-corrosion',
    family: 'causal_uncertainty',
    mutation: 'determined_failure',
    question: 'cu-air-show-undetermined',
    label: 0,
    reading: 'novel',
    record: raceRecord(
      'WPR17FA901',
      'During a high-G turn around a race pylon in the Formula One class, the left wing separated from the airplane, which descended into the desert floor.',
      "Examination found that the left wing's main spar had been weakened by corrosion under the spar cap that had not been detected; the spar fractured in overload at the weakened section.",
      'The in-flight separation of the left wing due to corrosion of the main spar.',
      { aircraft: 1, code: '337', phase: 'maneuvering', description: 'Maneuvering Aircraft structural failure', defining: true },
    ),
    anchors: ["the left wing's main spar had been weakened by corrosion under the spar cap"],
    note: 'An established reason (a structural failure) for an air race accident: grade 0.',
  },
  {
    id: 'cu-show2-spin-unexplained',
    family: 'causal_uncertainty',
    mutation: 'base',
    question: 'cu-air-show-undetermined',
    label: 2,
    reading: 'novel',
    record: raceRecord(
      'WPR17FA902',
      'During the third lap of the race, the airplane pitched up abruptly, entered a spin at low altitude and did not recover.',
      'Examination of the airframe, the flight controls and the engine revealed no anomalies, and the investigation could not determine why the airplane departed controlled flight or why the pilot did not recover.',
      'The airplane\'s departure from controlled flight during an air race for reasons that could not be determined.',
    ),
    anchors: ['the investigation could not determine why the airplane departed controlled flight or why the pilot did not recover'],
    note: 'Undetermined, no likely reason: grade 2.',
  },
  {
    id: 'cu-show2-no-reason-stated',
    family: 'causal_uncertainty',
    mutation: 'silent',
    question: 'cu-air-show-undetermined',
    label: 1,
    reading: 'edge-case',
    record: raceRecord(
      'WPR17FA903',
      'During the planned low pass in front of the crowd that ended the race, the airplane struck the ground.',
      'The pilot was flying a planned low pass at the end of the race.',
      "The airplane's collision with terrain during a low pass.",
      { aircraft: 1, code: '470', phase: 'maneuvering', description: 'Maneuvering-low-alt flying Collision with terr/obj (non-CFIT)', defining: true },
    ),
    anchors: ['The pilot was flying a planned low pass at the end of the race.'],
    note: 'No reason stated, and the record does not say the reason was undetermined: partial.',
  },
  {
    id: 'cu-show2-clearance-undetermined',
    family: 'causal_uncertainty',
    mutation: 'what_known_why_not',
    question: 'cu-air-show-undetermined',
    label: 2,
    reading: 'edge-case',
    record: raceRecord(
      'WPR17FA904',
      'During the final lap of the race, the airplane descended while rounding the last pylon and struck the ground.',
      "Examination of the airframe, the flight controls and the engine revealed no anomalies, and the pilot's toxicology tests were negative. The investigation could not determine why the pilot allowed the airplane to descend into the ground.",
      "The pilot's failure to maintain clearance from the ground while rounding a race pylon for reasons that could not be determined.",
      { aircraft: 1, code: '120', phase: 'maneuvering', description: 'Maneuvering-low-alt flying Controlled flight into terr/obj (CFIT)', defining: true },
    ),
    anchors: ["The pilot's failure to maintain clearance from the ground while rounding a race pylon for reasons that could not be determined."],
    note: 'What the pilot did is established, why is stated as undetermined, and no likely reason is named: grade 2 (fix round 2, review N6).',
  },
];
