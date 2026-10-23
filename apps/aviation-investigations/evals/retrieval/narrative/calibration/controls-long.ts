/**
 * Long-record controls (fix round 1, gate item 8): records above the 12,000-token chunk
 * budget, so the judges read them part by part with carried notes and a consolidation
 * step. The deciding sentences sit in different parts: a late contradiction (the
 * analysis, in the last part, overturns an early statement), or evidence spread across
 * parts (one condition early, the other late). `anchorParts` records the part of each
 * anchor, and the builder checks it against the chunk plan. Each long text is stored
 * once per group in the calibration file (`{{fill:<key>}}` in the record, `fillers` in
 * the file). Conventions as in controls.ts.
 */
import type { Control, ControlRecord } from './controls.js';
import { longFiller, type FillerPlace } from './filler.js';

/** The neutral text of each long group, about 13,000 `cl100k` tokens. */
const PARAGRAPHS = 78;
const PERRIS: FillerPlace = { airport: 'Perris Valley Airport', station: 'KRIV', elevation: 1413, temperature: 33 };
const GAINESVILLE: FillerPlace = { airport: 'Gainesville Regional Airport', station: 'KGNV', elevation: 152, temperature: 27 };
const SPRINGFIELD: FillerPlace = { airport: 'Springfield-Branson National Airport', station: 'KSGF', elevation: 1268, temperature: 22 };

export const LONG_FILLERS: Readonly<Record<string, string>> = Object.freeze({
  'long-skyd': longFiller('long-skyd', PERRIS, PARAGRAPHS),
  'long-pv': longFiller('long-pv', GAINESVILLE, PARAGRAPHS),
  'long-mx': longFiller('long-mx', SPRINGFIELD, PARAGRAPHS),
});
const fill = (key: string): string => `{{fill:${key}}}`;

// ---------------------------------------------------------------------------
// long-skyd (dev): ng-skydiving-power-loss-no-anomaly

const CARAVAN = { make: 'Cessna', model: '208B', category: 'AIR', farPart: '091', purpose: 'SKYD', phase: 'initial_climb', engine: 'TP' };
const skydLong = (id: string, early: string, late: string, analysis: string, probable: string): ControlRecord => ({
  ntsbNo: id,
  date: '2023-08-12',
  city: 'Perris',
  state: 'CA',
  aircraft: [CARAVAN],
  factual: [early, fill('long-skyd'), late].filter((x) => x !== '').join('\n\n'),
  analysis,
  probableCause: probable,
  findings: [],
  occurrences: [{ aircraft: 1, code: '341', phase: 'initial_climb', description: 'Initial climb Loss of engine power (total)', defining: true }],
});
const SKYD_LOSS = 'The commercial pilot was flying the airplane on a skydiving flight with 12 parachutists on board. The pilot reported that, during the climb through about 6,000 ft mean sea level, the engine lost power.';
const SKYD_INITIAL = 'An initial examination of the engine at the accident site revealed no mechanical anomalies.';
const SKYD_CLEAN_LATE = 'Postaccident examination of the engine, including a teardown at the manufacturer, revealed no anomalies that would have precluded normal operation.';
const SKYD_TEARDOWN = 'A teardown of the engine at the manufacturer later found a fractured compressor turbine blade with a pre-existing fatigue crack, which resulted in the loss of engine power.';
const SKYD_NO_LOSS_EARLY = 'The commercial pilot was flying the airplane on a skydiving flight with 12 parachutists on board. After the parachutists exited, the pilot turned back toward the airport, and the airplane collided with terrain during a forced landing in a field.';
const SKYD_EXAM_EARLY = 'Postaccident examination of the engine revealed no mechanical anomalies that would have precluded normal operation.';
const SKYD_LOSS_LATE = 'The pilot reported that the engine had lost power during the climb, before the parachutists exited, and that he had planned the forced landing from that point.';
const SKYD_NOT_EXAMINED = 'The engine was damaged by the postimpact fire, and the investigation could not examine its internal components; the reason for the loss of engine power could not be determined.';

// ---------------------------------------------------------------------------
// long-pv (holdout): pv-pilot-reported-failure-not-confirmed

const pvLong = (id: string, early: string, late: string, probable: string): ControlRecord => ({
  ntsbNo: id,
  date: '2023-05-20',
  city: 'Gainesville',
  state: 'FL',
  aircraft: [{ make: 'Piper', model: 'PA-32R-300', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'maneuvering', engine: 'REC' }],
  factual: [early, fill('long-pv')].join('\n\n'),
  analysis: late,
  probableCause: probable,
  findings: [],
  occurrences: [{ aircraft: 1, code: '240', phase: 'maneuvering', description: 'Maneuvering Loss of control in flight', defining: true }],
});
const PV_CLAIM = 'The pilot reported that, while maneuvering at low altitude, "the elevator jammed" and he could not raise the nose before the airplane struck trees.';
const PV_WORKING = 'Examination of the elevator control system found it continuous and free to move through its full range of travel, with no binding.';
const PV_FOUND = 'Examination of the elevator control system found that a bolt securing the elevator push-pull tube had backed out and jammed against the bellcrank, which restricted elevator travel.';
const PV_BURNED = 'The airplane was destroyed by a postimpact fire, and the elevator control system could not be examined.';
const PV_WITNESS = 'A witness stated that the elevator "looked stuck" as the airplane descended toward the trees. The pilot reported that the airplane had no mechanical problems and that he lost control while maneuvering at low altitude.';

// ---------------------------------------------------------------------------
// long-mx (holdout): ma-airplane-collision-student-pilot

const mxLong = (id: string, early: string, cessna: string): ControlRecord => ({
  ntsbNo: id,
  date: '2023-04-29',
  city: 'Springfield',
  state: 'MO',
  aircraft: [
    { make: 'Piper', model: 'PA-28-181', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'landing', engine: 'REC' },
    { make: 'Cessna', model: '172S', category: 'AIR', farPart: '091', purpose: 'INST', phase: 'landing', engine: 'REC' },
  ],
  factual: [early, fill('long-mx')].join('\n\n'),
  aircraftSections: [
    { aircraft: 1, text: 'The pilot of the Piper held a private pilot certificate and was returning from a cross-country flight.' },
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
const MX_EVENT = 'The Piper and the Cessna collided over the runway threshold while both were landing on runway 9; both airplanes came to rest on the runway.';
const MX_WITNESS = 'A witness on the ramp stated that the Cessna "was flown by a student pilot." The Piper and the Cessna collided over the runway threshold while both were landing on runway 9.';

export const LONG_CONTROLS: readonly Control[] = [
  {
    id: 'long-skyd-clean-late',
    family: 'long_record',
    mutation: 'spread_late_condition',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 2,
    reading: 'novel',
    record: skydLong('WPR23LA901', SKYD_LOSS, SKYD_CLEAN_LATE, 'The reason for the loss of engine power could not be determined.', 'A loss of engine power during the climb for reasons that could not be determined.'),
    anchors: [SKYD_LOSS, SKYD_CLEAN_LATE],
    anchorParts: [1, 2],
    note: 'The power loss in the first part, the clean examination in the last: grade 2.',
  },
  {
    id: 'long-skyd-late-teardown',
    family: 'long_record',
    mutation: 'late_contradiction',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 0,
    reading: 'novel',
    record: skydLong('WPR23LA902', `${SKYD_LOSS} ${SKYD_INITIAL}`, '', SKYD_TEARDOWN, 'A loss of engine power due to the fatigue fracture of a compressor turbine blade.'),
    anchors: [SKYD_INITIAL, SKYD_TEARDOWN],
    anchorParts: [1, 2],
    note: 'A clean initial examination in the first part, overturned by the teardown in the last: grade 0.',
  },
  {
    id: 'long-skyd-loss-late',
    family: 'long_record',
    mutation: 'spread_late_condition',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 2,
    reading: 'novel',
    record: skydLong('WPR23LA903', `${SKYD_NO_LOSS_EARLY} ${SKYD_EXAM_EARLY}`, '', SKYD_LOSS_LATE, 'A loss of engine power during the climb for reasons that could not be determined.'),
    anchors: [SKYD_EXAM_EARLY, SKYD_LOSS_LATE],
    anchorParts: [1, 2],
    note: 'The clean examination in the first part, the power loss only in the last: grade 2.',
  },
  {
    id: 'long-skyd-not-examined',
    family: 'long_record',
    mutation: 'unresolved',
    question: 'ng-skydiving-power-loss-no-anomaly',
    label: 1,
    reading: 'novel',
    record: skydLong('WPR23LA904', SKYD_LOSS, '', SKYD_NOT_EXAMINED, 'A loss of engine power during the climb for reasons that could not be determined because the engine could not be examined.'),
    anchors: [SKYD_LOSS, 'the investigation could not examine its internal components'],
    anchorParts: [1, 2],
    note: 'The power loss in the first part; the last part says the engine could not be examined: partial.',
  },
  {
    id: 'long-pv-found-working',
    family: 'long_record',
    mutation: 'spread_late_condition',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 2,
    reading: 'novel',
    record: pvLong('ERA23LA901', PV_CLAIM, PV_WORKING, "The pilot's failure to maintain airplane control while maneuvering at low altitude."),
    anchors: [PV_CLAIM, PV_WORKING],
    anchorParts: [1, 2],
    note: 'The claim in the first part, the examination that found the system working in the last: grade 2.',
  },
  {
    id: 'long-pv-found-jam',
    family: 'long_record',
    mutation: 'late_contradiction',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 0,
    reading: 'novel',
    record: pvLong('ERA23LA902', PV_CLAIM, PV_FOUND, 'The restriction of elevator travel by a bolt that had backed out of the elevator push-pull tube.'),
    anchors: [PV_CLAIM, PV_FOUND],
    anchorParts: [1, 2],
    note: 'The examination in the last part confirmed the reported jam: grade 0.',
  },
  {
    id: 'long-pv-not-examined',
    family: 'long_record',
    mutation: 'unresolved',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 1,
    reading: 'novel',
    record: pvLong('ERA23LA903', PV_CLAIM, PV_BURNED, 'A loss of airplane control while maneuvering at low altitude for reasons that could not be determined.'),
    anchors: [PV_CLAIM, PV_BURNED],
    anchorParts: [1, 2],
    note: 'The claim could not be settled (the last part): partial.',
  },
  {
    id: 'long-pv-witness-claim',
    family: 'long_record',
    mutation: 'wrong_speaker',
    question: 'pv-pilot-reported-failure-not-confirmed',
    label: 0,
    reading: 'novel',
    record: pvLong('ERA23LA904', PV_WITNESS, PV_WORKING, "The pilot's failure to maintain airplane control while maneuvering at low altitude."),
    anchors: ['The pilot reported that the airplane had no mechanical problems', PV_WORKING],
    anchorParts: [1, 2],
    note: 'Only a witness suggested a jam; the pilot reported no problem: grade 0, across parts.',
  },
  {
    id: 'long-mx-student-late',
    family: 'long_record',
    mutation: 'spread_late_condition',
    question: 'ma-airplane-collision-student-pilot',
    label: 2,
    reading: 'novel',
    record: mxLong('CEN23MA901', MX_EVENT, 'The pilot of the Cessna held a student pilot certificate and was on a solo cross-country flight.'),
    anchors: [MX_EVENT, 'The pilot of the Cessna held a student pilot certificate and was on a solo cross-country flight.'],
    anchorParts: [1, 2],
    note: "The collision in the first part, the student in the Cessna's own section in the last: grade 2.",
  },
  {
    id: 'long-mx-student-passenger',
    family: 'long_record',
    mutation: 'wrong_role',
    question: 'ma-airplane-collision-student-pilot',
    label: 0,
    reading: 'novel',
    record: mxLong('CEN23MA902', MX_EVENT, "A student pilot rode in the Cessna's right seat as a passenger; the Cessna was flown by its owner, who held a private pilot certificate."),
    anchors: [MX_EVENT, "A student pilot rode in the Cessna's right seat as a passenger"],
    anchorParts: [1, 2],
    note: 'The student was a passenger (the last part): grade 0.',
  },
  {
    id: 'long-mx-instruction-unknown',
    family: 'long_record',
    mutation: 'unresolved',
    question: 'ma-airplane-collision-student-pilot',
    label: 1,
    reading: 'novel',
    record: mxLong('CEN23MA903', MX_EVENT, 'The Cessna was on an instructional flight with a flight instructor on board; the investigation did not establish what pilot certificate the person receiving instruction held.'),
    anchors: [MX_EVENT, 'the investigation did not establish what pilot certificate the person receiving instruction held'],
    anchorParts: [1, 2],
    note: 'Instruction in a colliding airplane, the certificate unknown (the last part): partial.',
  },
  {
    id: 'long-mx-witness-student',
    family: 'long_record',
    mutation: 'late_contradiction',
    question: 'ma-airplane-collision-student-pilot',
    label: 0,
    reading: 'novel',
    record: mxLong('CEN23MA904', MX_WITNESS, 'The pilot of the Cessna held a private pilot certificate and was receiving a flight review from the flight instructor on board.'),
    anchors: ['A witness on the ramp stated that the Cessna "was flown by a student pilot."', 'The pilot of the Cessna held a private pilot certificate and was receiving a flight review'],
    anchorParts: [1, 2],
    note: "A witness's claim in the first part; the Cessna's section in the last shows a certificated pilot on a flight review: grade 0.",
  },
];
