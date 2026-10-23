/**
 * Answerability controls (fix round 1, gate item 8): records where case relevance on the
 * complete record differs from what a delivered bundle supports. Each group is one
 * record with one relevance item (the complete record) and answerability items for
 * different delivered bundles (exact paragraphs of the record's sections), judged with
 * the answerability prompt: a bundle can show only part of a relevant case (partial), or
 * an early statement that the complete record later contradicts (answerable, although
 * the case is not relevant). Related items stay in one split. Conventions as in
 * controls.ts.
 */
import type { Control, ControlRecord } from './controls.js';
import { fillerParagraphs, type FillerPlace } from './filler.js';

const LODI: FillerPlace = { airport: 'Lodi Airport', station: 'KLOD', elevation: 60, temperature: 32 };
const KALAMAZOO: FillerPlace = { airport: 'Kalamazoo/Battle Creek International Airport', station: 'KAZO', elevation: 874, temperature: 19 };
const NAPLES: FillerPlace = { airport: 'Naples Municipal Airport', station: 'KAPF', elevation: 8, temperature: 29 };
const HUTCHINSON: FillerPlace = { airport: 'Hutchinson Regional Airport', station: 'KHUT', elevation: 1543, temperature: 26 };

/** A group's controls: its relevance item and its answerability items, sharing one record. */
function group(
  base: { prefix: string; question: string; record: ControlRecord; relevance: { label: 0 | 1 | 2; anchors: string[]; note: string } },
  bundles: { id: string; mutation: string; label: 0 | 1 | 2; bundle: Control['bundle']; note: string }[],
): Control[] {
  return [
    {
      id: `${base.prefix}-record`,
      family: 'answerability',
      mutation: 'complete_record',
      question: base.question,
      label: base.relevance.label,
      kind: 'relevance',
      reading: 'novel',
      record: base.record,
      anchors: base.relevance.anchors,
      note: base.relevance.note,
    },
    ...bundles.map((b) => ({
      id: `${base.prefix}-${b.id}`,
      family: 'answerability' as const,
      mutation: b.mutation,
      question: base.question,
      label: b.label,
      kind: 'answerability' as const,
      bundle: b.bundle,
      reading: 'novel' as const,
      record: base.record,
      anchors: (b.bundle ?? []).map((x) => x.text),
      note: b.note,
    })),
  ];
}

// ---------------------------------------------------------------------------
// ans-skyd (dev): a relevant case whose bundles show part of it

const SKYD_LOSS = 'The commercial pilot was flying the airplane on a skydiving flight with three parachutists on board. The pilot reported that, while climbing through about 3,000 ft above ground level, the engine lost partial power and then stopped.';
const SKYD_EXAM = 'Postaccident examination of the engine at a salvage facility revealed no mechanical malfunctions or anomalies that would have precluded normal operation.';
const SKYD_PC = 'A total loss of engine power during the climb for reasons that could not be determined because the postaccident examination of the engine revealed no anomalies.';
const skydContext = fillerParagraphs('WPR20LA911', LODI, 2);
const SKYD_RECORD: ControlRecord = {
  ntsbNo: 'WPR20LA911',
  date: '2020-09-05',
  city: 'Lodi',
  state: 'CA',
  aircraft: [{ make: 'Cessna', model: '182Q', category: 'AIR', farPart: '091', purpose: 'SKYD', phase: 'initial_climb', engine: 'REC' }],
  factual: [SKYD_LOSS, ...skydContext, 'The pilot made a forced landing in a vineyard, and the airplane came to rest upright with damage to both wings.', SKYD_EXAM].join('\n\n'),
  analysis: 'The reason for the loss of engine power could not be determined.',
  probableCause: SKYD_PC,
  findings: [],
  occurrences: [{ aircraft: 1, code: '341', phase: 'initial_climb', description: 'Initial climb Loss of engine power (total)', defining: true }],
};

// ---------------------------------------------------------------------------
// ans-late (dev): an early statement the complete record later contradicts

const LATE_LOSS = 'The commercial pilot was flying the airplane on a skydiving flight with four parachutists on board. The pilot reported that, during the climb, the engine lost power and began to vibrate.';
const LATE_FIRST = 'Postaccident examination of the engine at the accident site revealed no mechanical anomalies that would have precluded normal operation.';
const LATE_TEARDOWN =
  "A subsequent detailed examination at an overhaul facility found that the No. 4 cylinder's exhaust valve guide had worn beyond limits and the valve had stuck open, which resulted in the loss of power.";
const LATE_RECORD: ControlRecord = {
  ntsbNo: 'WPR20LA912',
  date: '2020-10-10',
  city: 'Lodi',
  state: 'CA',
  aircraft: [{ make: 'Cessna', model: '182Q', category: 'AIR', farPart: '091', purpose: 'SKYD', phase: 'initial_climb', engine: 'REC' }],
  factual: [LATE_LOSS, LATE_FIRST, ...fillerParagraphs('WPR20LA912', LODI, 2), 'The pilot landed in an orchard short of the runway, and the airplane nosed over.'].join('\n\n'),
  analysis: LATE_TEARDOWN,
  probableCause: 'A loss of engine power due to an exhaust valve that stuck open because of a worn valve guide.',
  findings: [],
  occurrences: [{ aircraft: 1, code: '342', phase: 'initial_climb', description: 'Initial climb Loss of engine power (partial)', defining: true }],
};

// ---------------------------------------------------------------------------
// ans-taxi (holdout): who moved and who was parked, across aircraft-scoped sections

const TAXI_EVENT = "The two airplanes collided on the ramp; the Piper's propeller struck the Cessna's right wing.";
const TAXI_PIPER = 'The pilot was taxiing the Piper from the self-serve fuel pump to the run-up area.';
const TAXI_CESSNA = "The Cessna was parked on the ramp with its engine shut down while its pilot was inside the fixed base operator's building.";
const taxiContext = fillerParagraphs('CEN22LA909', KALAMAZOO, 2);
const TAXI_RECORD: ControlRecord = {
  ntsbNo: 'CEN22LA909',
  date: '2022-06-04',
  city: 'Kalamazoo',
  state: 'MI',
  aircraft: [
    { make: 'Piper', model: 'PA-28-140', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'taxi', engine: 'REC' },
    { make: 'Cessna', model: '172N', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'standing', engine: 'REC' },
  ],
  factual: [TAXI_EVENT, ...taxiContext].join('\n\n'),
  aircraftSections: [
    { aircraft: 1, text: TAXI_PIPER },
    { aircraft: 2, text: TAXI_CESSNA },
  ],
  analysis: 'The Piper pilot did not maintain clearance from the parked airplane while taxiing.',
  probableCause: "The Piper pilot's failure to maintain clearance from a parked airplane while taxiing.",
  findings: [],
  occurrences: [
    { aircraft: 1, code: '200', phase: 'taxi', description: 'Taxi Ground collision', defining: true },
    { aircraft: 2, code: '200', phase: 'standing', description: 'Standing Ground collision', defining: true },
  ],
};

// ---------------------------------------------------------------------------
// ans-pv (holdout): a claim and its examination in different passages

const PV_CLAIM = "The pilot reported that, during the landing roll, the right brake \"did not work\" and the airplane veered to the right and departed the runway into the grass.";
const PV_EXAM = 'Examination of the brake system found no leaks, the brake fluid reservoir full, and both brakes holding when the toe pedals were applied; the brake linings were within limits.';
const PV_PC = "The pilot's failure to maintain directional control during the landing roll in gusting crosswind conditions.";
const PV_RECORD: ControlRecord = {
  ntsbNo: 'ERA19LA909',
  date: '2019-02-23',
  city: 'Naples',
  state: 'FL',
  aircraft: [{ make: 'Cirrus', model: 'SR20', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'landing', engine: 'REC' }],
  factual: [PV_CLAIM, ...fillerParagraphs('ERA19LA909', NAPLES, 2), PV_EXAM].join('\n\n'),
  analysis: 'The pilot did not maintain directional control during the landing roll in a gusting crosswind.',
  probableCause: PV_PC,
  findings: [],
  occurrences: [{ aircraft: 1, code: '220', phase: 'landing', description: 'Landing-landing roll Loss of control on ground', defining: true }],
};

// ---------------------------------------------------------------------------
// ans-late2 (holdout): an early clean examination, a later found defect

const GEAR_COLLAPSE = 'During the landing roll the nose landing gear collapsed, and the airplane slid to a stop on the runway.';
const GEAR_FIRST = 'Examination of the nose landing gear at the accident site revealed no preimpact anomalies.';
const GEAR_LAB =
  'Metallurgical examination of the nose gear retraction link later found a pre-existing fatigue crack that had propagated through most of the link before it fractured in overload.';
const GEAR_RECORD: ControlRecord = {
  ntsbNo: 'CEN21LA909',
  date: '2021-04-03',
  city: 'Hutchinson',
  state: 'KS',
  aircraft: [{ make: 'Mooney', model: 'M20C', category: 'AIR', farPart: '091', purpose: 'PERS', phase: 'landing', engine: 'REC' }],
  factual: [GEAR_COLLAPSE, GEAR_FIRST, ...fillerParagraphs('CEN21LA909', HUTCHINSON, 2)].join('\n\n'),
  analysis: GEAR_LAB,
  probableCause: 'The fatigue failure of the nose landing gear retraction link, which resulted in the collapse of the nose landing gear.',
  findings: [],
  occurrences: [{ aircraft: 1, code: '090', phase: 'landing', description: 'Landing Abnormal runway contact', defining: true }],
};

export const ANSWERABILITY_CONTROLS: readonly Control[] = [
  ...group(
    {
      prefix: 'ans-skyd',
      question: 'ng-skydiving-power-loss-no-anomaly',
      record: SKYD_RECORD,
      relevance: { label: 2, anchors: [SKYD_LOSS, SKYD_EXAM], note: 'The complete record states the power loss and the clean examination: relevant.' },
    },
    [
      { id: 'loss-only', mutation: 'condition_missing', label: 1, bundle: [{ section: 'S1', text: SKYD_LOSS }], note: 'The bundle shows the power loss but not the examination: partial, although the case is relevant.' },
      { id: 'exam-only', mutation: 'condition_missing', label: 1, bundle: [{ section: 'S1', text: SKYD_EXAM }], note: 'The bundle shows the examination but not the power loss: partial.' },
      { id: 'probable-cause', mutation: 'both_in_one_passage', label: 2, bundle: [{ section: 'S3', text: SKYD_PC }], note: 'The probable cause states both conditions: answerable.' },
      { id: 'context-only', mutation: 'irrelevant_passage', label: 0, bundle: [{ section: 'S1', text: skydContext[0] as string }], note: 'A passage that states none of it: not answerable, although the case is relevant.' },
    ],
  ),
  ...group(
    {
      prefix: 'ans-late',
      question: 'ng-skydiving-power-loss-no-anomaly',
      record: LATE_RECORD,
      relevance: { label: 0, anchors: [LATE_TEARDOWN], note: 'The detailed examination found a pre-existing defect: not relevant on the complete record.' },
    },
    [
      { id: 'early-statements', mutation: 'late_contradiction_hidden', label: 2, bundle: [{ section: 'S1', text: LATE_LOSS }, { section: 'S1', text: LATE_FIRST }], note: 'The delivered passages state a power loss and a clean initial examination: answerable, although the complete record contradicts it.' },
      { id: 'teardown', mutation: 'contrary_passage', label: 0, bundle: [{ section: 'S2', text: LATE_TEARDOWN }], note: 'The passage states the contrary (a defect was found): not answerable.' },
    ],
  ),
  ...group(
    {
      prefix: 'ans-taxi',
      question: 'ma-taxiing-strikes-stationary',
      record: TAXI_RECORD,
      relevance: { label: 2, anchors: [TAXI_PIPER, TAXI_CESSNA], note: 'Who moved and who was parked is in the aircraft sections: relevant.' },
    },
    [
      { id: 'event-only', mutation: 'attribution_missing', label: 1, bundle: [{ section: 'S1', text: TAXI_EVENT }], note: 'The event passage shows a ground collision but not who moved: partial.' },
      { id: 'all-three', mutation: 'complete_in_bundle', label: 2, bundle: [{ section: 'S1', text: TAXI_EVENT }, { section: 'S2', text: TAXI_PIPER }, { section: 'S3', text: TAXI_CESSNA }], note: 'The collision and both aircraft sections: answerable.' },
      { id: 'context-only', mutation: 'irrelevant_passage', label: 0, bundle: [{ section: 'S1', text: taxiContext[1] as string }], note: 'A passage that states none of it: not answerable.' },
    ],
  ),
  ...group(
    {
      prefix: 'ans-pv',
      question: 'pv-pilot-reported-failure-not-confirmed',
      record: PV_RECORD,
      relevance: { label: 2, anchors: [PV_CLAIM, PV_EXAM], note: 'The claim and the examination that found the brakes working: relevant.' },
    },
    [
      { id: 'claim-only', mutation: 'condition_missing', label: 1, bundle: [{ section: 'S1', text: PV_CLAIM }], note: 'The claim without the examination: partial.' },
      { id: 'exam-only', mutation: 'condition_missing', label: 1, bundle: [{ section: 'S1', text: PV_EXAM }], note: 'The examination without the claim: partial.' },
      { id: 'both', mutation: 'complete_in_bundle', label: 2, bundle: [{ section: 'S1', text: PV_CLAIM }, { section: 'S1', text: PV_EXAM }], note: 'The claim and the examination: answerable.' },
      { id: 'probable-cause', mutation: 'irrelevant_passage', label: 0, bundle: [{ section: 'S3', text: PV_PC }], note: 'The probable cause states neither the claim nor the examination: not answerable.' },
    ],
  ),
  ...group(
    {
      prefix: 'ans-late2',
      question: 'ng-gear-collapse-no-defect',
      record: GEAR_RECORD,
      relevance: { label: 0, anchors: [GEAR_LAB], note: 'A pre-existing fatigue crack was found later: not relevant on the complete record.' },
    },
    [
      { id: 'early-statements', mutation: 'late_contradiction_hidden', label: 2, bundle: [{ section: 'S1', text: GEAR_COLLAPSE }, { section: 'S1', text: GEAR_FIRST }], note: 'A collapse and a clean initial examination of that gear: answerable from the passages, although the case is not relevant.' },
      { id: 'lab', mutation: 'contrary_passage', label: 0, bundle: [{ section: 'S2', text: GEAR_LAB }], note: 'The passage states the contrary: not answerable.' },
    ],
  ),
];
