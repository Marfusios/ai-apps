/**
 * Task 16e held-out set (dataset v3, held-out split): nine real retrieval bundles under
 * `retrieval.v2` (`QUESTIONS_16E`, the first nine in question order that hold no case of
 * an earlier split: `heldOutBundlesV3`, `HELDOUT_V3`), built and label-frozen after the
 * protocol (`protocol.v3.ts`) was committed and before any 16e checker output was seen.
 * Each bundle brings one brief as compose.v8 would write it (whole-sentence quotes without
 * pointing words, which flight it was only when a passage states it, operating hours apart
 * from flight hours, other anchors kept), model-reviewed claim by claim against every
 * supplied passage of its cases and against the passages each claim cites (a why line is
 * checked against its quotes' passages); one-error variants over the four families; two
 * mixed-error variants; reading variants where the timing allows; and a claim batch of
 * controls and mutations. The critical timing mutations
 * (`HELDOUT_V3.criticalTimingMutations`) are each in at least two bundles.
 *
 * Cases whose mechanical fault the investigators name only as contributing, or only as
 * likely, are left out of the briefs (their classification would be arguable) and appear
 * in the claim batches with claims worded to what the passages state. Readings are chosen
 * so that no decision rests on the case header's date or on a duration in months or years
 * (no exact conversion into calendar days).
 *
 * No label is expert ground truth: the brief claims are model-reviewed, the mutations
 * constructed; a claim review cannot settle is `unknown` and its brief is not wholly
 * supported.
 */
import type { ReadingState } from '../../../server/briefs/clarify.js';
import { splitSentences } from '../../../server/briefs/sentences.js';
import type { ComposeOutput } from '../../../shared/contracts/briefs.js';
import type { BriefSpec, ClaimBatch } from '../types.js';
import { CLASSIFIED, MAINTAINED, firstFlight, firstFlightUnsettled, no, said, timing, windowUnsettled, within, yes } from './helpers.js';

type Composition = ComposeOutput;
type Case = Composition['cases'][number];
type Speaker = Case['quotes'][number]['speaker'];

const q = (passageId: string, quote: string, speaker: Speaker = 'investigators') => ({ passageId, quote, speaker });
const window = (days: number | null, flightHours: number | null, pinned = false): ReadingState => ({ timingWindow: { value: { days, flightHours }, pinned } });
const SHORTLY = window(30, 10);
const FIRST_ONLY: ReadingState = { firstFlightOnly: { value: true, pinned: true } };
const DAY_BEFORE = window(1, null, true);

const caseOf = (c: Composition, ntsbNo: string): Case => {
  const k = c.cases.find((x) => x.ntsbNo === ntsbNo);
  if (!k) throw new Error(`no case ${ntsbNo}`);
  return k;
};
/** Replace one summary sentence (matched by a unique fragment) with another. */
const resentence = (c: Composition, fragment: string, sentence: string) => {
  const parts = splitSentences(c.summary);
  const at = parts.flatMap((s, i) => (s.includes(fragment) ? [i] : []));
  if (at.length !== 1) throw new Error(`no unique sentence with "${fragment}"`);
  parts[at[0]!] = sentence;
  c.summary = parts.join(' ');
};
const variant = (base: BriefSpec, id: string, readings: ReadingState, note: string): BriefSpec => ({ ...base, id, readings, note, errors: [], mixed: [] });

// ---------------------------------------------------------------------------
// q16e-turbocharger: ERA15FA312 (P1, P2, P3), CEN19LA317 (P4, P5), CEN18LA363 (P6, P7),
// WPR20LA033 (P8), CEN11FA007 (P9, P10), CEN22FA011 (P11, P12).

const REPAIRS_312 = 'the two engine repairs';
const ANNUAL_011 = 'the most recent annual inspection';

const TURBO: Composition = {
  outcome: 'answer',
  summary: [
    "In the Cessna T206H case, the engine lost power from a malfunction of the turbocharging system likely due to contaminated oil, and investigators found that the engine manufacturer's guidance on inspecting and maintaining turbocharged engines was inadequate [[case:ERA15FA312]].",
    'In the Beech 58TC case, maintenance personnel did not properly tighten the turbocharger oil line and the right engine propeller governor, which resulted in a loss of engine power [[case:CEN22FA011]].',
    "In the Cessna P210N case, the turbocharger wastegate stuck in the closed position for reasons that could not be determined, and the excessively rich mixture, made worse by the pilot's use of the fuel boost pump, led to a total loss of engine power [[case:CEN18LA363]].",
    "In the Piper PA28 case, examination found a hole in the turbocharger's automatic wastegate controller diaphragm, but the reason for the total loss of engine power could not be determined [[case:CEN19LA317]].",
  ].join(' '),
  groups: [
    { kind: 'causal', caseNumbers: ['ERA15FA312', 'CEN22FA011', 'CEN18LA363'] },
    { kind: 'defect_not_causal', caseNumbers: ['CEN19LA317'] },
  ],
  cases: [
    {
      ntsbNo: 'ERA15FA312',
      why: 'A malfunction of the turbocharging system, likely due to contaminated oil, caused the loss of engine power; the records of two engine repairs about 2 years before the accident did not show that the turbocharger system components were flushed.',
      quotes: [
        q('P3', 'A loss of engine power due to a malfunction of the turbocharging system likely due to contaminated oil.'),
        q('P2', 'Maintenance records indicated that two repairs requiring replacement of major components of the engine took place about 2 years before the accident.'),
      ],
      evidencePassageIds: ['P2', 'P3'],
      symptom: { value: 'total_power_loss', passageIds: ['P2'] },
      chronology: { maintenance: REPAIRS_312, facts: [] },
    },
    {
      ntsbNo: 'CEN22FA011',
      why: 'Maintenance personnel did not properly tighten the turbocharger oil line and the right engine propeller governor, which resulted in a loss of engine power.',
      quotes: [
        q('P12', 'The maintenance personnel’s failure to properly tighten the turbocharger oil line and the right engine propeller governor, which resulted in a loss of engine power.'),
        q('P11', 'The oil line from the turbocharger wastegate control valve outlet to the inlet side of the turbo pressure controller was loose at the wastegate outlet end.'),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      chronology: { maintenance: ANNUAL_011, facts: [] },
    },
    {
      ntsbNo: 'CEN18LA363',
      why: "The wastegate stuck closed for reasons that could not be determined, and the pilot's failure to reduce the throttle during takeoff and his decision to turn on the fuel boost pump, which exacerbated the excessively rich mixture, resulted in a total loss of engine power.",
      quotes: [q('P7', 'The stuck turbocharger wastegate in the closed position for reasons that could not be determined based on the available information.')],
      evidencePassageIds: ['P7'],
      symptom: { value: 'total_power_loss', passageIds: ['P7'] },
    },
    {
      ntsbNo: 'CEN19LA317',
      why: "Examination found a hole in the turbocharger's automatic wastegate controller diaphragm, but a closed wastegate would not result in a total loss of engine power, and the reason for the loss could not be determined.",
      quotes: [q('P4', 'The reason for the loss of engine power could not be determined based on available evidence.')],
      evidencePassageIds: ['P4'],
      symptom: { value: 'total_power_loss', passageIds: ['P5'] },
    },
  ],
  gaps: [{ ntsbNo: 'WPR20LA033', note: 'The supplied passage gives only the probable cause, the separation of the wastegate exhaust elbow, and does not mention maintenance.', passageIds: ['P8'] }],
};

const T1: BriefSpec = {
  id: 'holdout16e.turbocharger',
  bundle: 'q16e-turbocharger',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: TURBO,
  note: 'No case states a time from its maintenance in calendar days or flight hours ("about 2 years" settles nothing): every timing decision is unknown.',
  errors: [
    {
      id: 'months',
      family: 'timing',
      mutation: 'unit_swap',
      expect: 'contradicted',
      note: 'P2: the two repairs took place about 2 years before the accident, not 2 months.',
      edit: (c) => {
        caseOf(c, 'ERA15FA312').why =
          'A malfunction of the turbocharging system, likely due to contaminated oil, caused the loss of engine power; the records of two engine repairs about 2 months before the accident did not show that the turbocharger system components were flushed.';
      },
    },
    {
      id: 'speaker',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P11 is the investigators’ examination, not the pilot’s account.',
      edit: (c) => {
        caseOf(c, 'CEN22FA011').quotes[1]!.speaker = 'pilot';
      },
    },
    {
      id: 'closed',
      family: 'contradiction',
      mutation: 'wrong_cause',
      expect: 'contradicted',
      note: 'P4: a closed wastegate would not result in a total loss of engine power, and the reason for the loss could not be determined.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN19LA317]]',
          "In the Piper PA28 case, a hole in the turbocharger's automatic wastegate controller diaphragm closed the wastegate, which caused the total loss of engine power [[case:CEN19LA317]].",
        ),
    },
    {
      id: 'loosened',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P11: the mechanics did not know why the turbocharger lines would have been taken apart or loosened for the annual inspection.',
      edit: (c) => {
        caseOf(c, 'CEN22FA011').why =
          'Maintenance personnel loosened the turbocharger oil line to inspect it during the annual inspection and did not properly tighten it or the right engine propeller governor, which resulted in a loss of engine power.';
      },
    },
    {
      id: 'removed',
      family: 'attribution',
      mutation: 'misleading_excerpt',
      expect: 'not_established',
      note: 'P2: the excerpt drops "If the engine manufacturer had included these instructions and the mechanics had performed actions such as flushing …": read alone it states a likelihood without its condition.',
      edit: (c) => {
        caseOf(c, 'ERA15FA312').quotes[1] = q(
          'P2',
          'it is likely the contamination found in the check valve (and likely present in other components of the turbocharging system) would have been removed.',
        );
      },
    },
  ],
  mixed: [
    { id: 'mix-months-speaker', errors: ['months', 'speaker'], note: 'A unit swap and a wrong speaker, in two cases.' },
    { id: 'mix-closed-loosened', errors: ['closed', 'loosened'], note: 'A wrong cause and an added detail, in two cases.' },
  ],
};

const TURBO_CLAIMS: ClaimBatch = {
  id: 'holdout16e.turbocharger-claims',
  bundle: 'q16e-turbocharger',
  cases: ['ERA15FA312', 'CEN19LA317', 'CEN18LA363', 'WPR20LA033', 'CEN11FA007', 'CEN22FA011'],
  readings: SHORTLY,
  claims: [
    yes(
      'era15.repairs',
      'why',
      'ERA15FA312',
      ['P2'],
      'Two repairs requiring replacement of major components of the engine took place about 2 years before the accident; the first replaced the turbocharger because of oil leaking past its shaft seal.',
      'P2.',
    ),
    no(
      'era15.flushed',
      'why',
      'ERA15FA312',
      ['P2'],
      'The maintenance records showed that the turbocharger controller and wastegate were flushed after the second repair.',
      'contradiction',
      'negation',
      'contradicted',
      'P2: the records did not show that they were flushed.',
    ),
    no(
      'era15.days',
      'timing',
      'ERA15FA312',
      ['P2'],
      timing(REPAIRS_312, { relation: 'calendar_days', value: 730, bound: 'exact' }),
      'timing',
      'approximate_exact',
      'not_established',
      'P2: "about 2 years", a rough time in years, not an exact number of calendar days.',
    ),
    yes('era15.unsettled', 'criterion', 'ERA15FA312', 'all', windowUnsettled(REPAIRS_312, 30, 10), '"About 2 years" settles nothing, and no passage gives calendar days or flight hours from the repairs (TW-N).', {
      provenance: 'constructed',
      absence: true,
      criterion: 'timing_window',
      decision: 'unknown',
    }),
    yes('era15.pc', 'attribution', 'ERA15FA312', ['P3'], said('investigators', 'A loss of engine power due to a malfunction of the turbocharging system likely due to contaminated oil.'), 'P3, the probable cause, first sentence.'),
    no(
      'era15.certain',
      'why',
      'ERA15FA312',
      ['P3'],
      'Investigators determined that contaminated oil caused the turbocharging system to malfunction.',
      'unsupported_addition',
      'certainty_overstatement',
      'not_established',
      'P3: "likely due to contaminated oil".',
    ),
    yes(
      'cen22.bnut',
      'why',
      'CEN22FA011',
      ['P11'],
      'During the examination, the B-nut of the loose oil line at the wastegate outlet was rotated about three-quarters to one full rotation clockwise before the fitting tightened against the mating surface.',
      'P11.',
    ),
    no(
      'cen22.remembered',
      'why',
      'CEN22FA011',
      ['P11'],
      'The mechanic who worked on the right propeller governor remembered loosening the turbocharger oil lines during the annual inspection.',
      'contradiction',
      'negation',
      'contradicted',
      'P11: he did not remember performing maintenance on those fittings.',
    ),
    yes('cen22.maint', 'maintenance', 'CEN22FA011', ['P12'], MAINTAINED.investigator_attributed, 'P12: the maintenance personnel’s failure to properly tighten the turbocharger oil line.'),
    yes('cen18.class', 'classification', 'CEN18LA363', ['P7'], CLASSIFIED.causal, 'P7: the stuck wastegate is part of the probable cause of the total loss of engine power.'),
    no(
      'cen18.pilot',
      'attribution',
      'CEN18LA363',
      ['P7'],
      said('pilot', 'The stuck turbocharger wastegate in the closed position for reasons that could not be determined based on the available information.'),
      'attribution',
      'wrong_speaker',
      'contradicted',
      'P7 is the probable cause, not the pilot’s account.',
    ),
    yes('cen19.class', 'classification', 'CEN19LA317', ['P4'], CLASSIFIED.defect_not_causal, 'P4: a hole in the wastegate controller diaphragm, which would not cause a total loss of power; the reason was not determined.'),
    no(
      'cen19.found',
      'summary',
      'CEN19LA317',
      ['P4', 'P5'],
      'In the Piper PA28 case, the pilot took off after a mechanic found and corrected the cause of the partial loss of engine power on the earlier flight that day (CEN19LA317).',
      'contradiction',
      'negation',
      'contradicted',
      'P4: the engine test run revealed no anomalies, and the pilot took off without identifying the cause.',
    ),
    yes(
      'cen11.annual',
      'maintenance',
      'CEN11FA007',
      ['P10'],
      MAINTAINED.investigator_attributed,
      'P10: the improper annual inspection by the owner and two mechanics contributed to the accident.',
    ),
    no(
      'cen11.turbo',
      'why',
      'CEN11FA007',
      ['P9', 'P10'],
      'Investigators attributed the partial loss of engine power to a failed turbocharger overboost valve.',
      'contradiction',
      'wrong_cause',
      'contradicted',
      'P9: the overboost valve tested within specifications; P10: the loss came from an obstructed fuel servo air inlet and exhaust ingestion.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16e-crankshaft: NYC08LA280 (P1, P2), WPR24LA084 (P3), ERA23FA025 (P4, P5, P6),
// ERA13LA327 (P7, P8), CEN11FA202 (P9, P10), ERA13LA097 (P11, P12).

const OVERHAUL_280 = 'the engine overhaul';
const FIELD_025 = 'the field overhaul';
const LAST_327 = 'the last engine overhaul';
const OVERHAUL_097 = 'the engine overhaul';

const CRANK: Composition = {
  outcome: 'answer',
  summary: [
    'In the Socata MS894A case, the crankshaft and the No. 3 connecting rod failed in fatigue after maintenance personnel improperly machined the crankshaft during an engine overhaul [[case:NYC08LA280]].',
    'In the Piper PA-32-300 case, a crankshaft that was not authorized for the engine model was installed during a field overhaul, and its failure caused a total loss of engine power [[case:ERA23FA025]].',
    "In the Univair 108-1 case, maintenance personnel did not remove circumferential gouges from a rod journal of the crankshaft during the engine's last overhaul, and the crankshaft failed in fatigue about 115 hours after that overhaul [[case:ERA13LA327]].",
    'In the Piper PA-28R-200 case, improper connecting rods were reinstalled at an engine overhaul, which resulted in abnormal wear of the connecting rod bearings [[case:ERA13LA097]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['NYC08LA280', 'ERA23FA025', 'ERA13LA327', 'ERA13LA097'] }],
  cases: [
    {
      ntsbNo: 'NYC08LA280',
      why: 'Maintenance personnel improperly machined the crankshaft during an engine overhaul, and the crankshaft and the No. 3 connecting rod later failed in fatigue, causing a loss of engine power.',
      quotes: [
        q('P2', 'A loss of engine power due to fatigue failure of the crankshaft and the No. 3 engine cylinder connecting rod as a result of improper machining of the engine crankshaft during engine overhaul by maintenance personnel.'),
        q('P1', 'No logbook entries were located to verify that re-nitriding had been carried out.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
      symptom: { value: 'total_power_loss', passageIds: ['P1'] },
      chronology: { maintenance: OVERHAUL_280, facts: [] },
    },
    {
      ntsbNo: 'ERA23FA025',
      why: 'During a field overhaul about 10 years before the accident, the crankshaft was replaced with one that was not authorized for use in the engine model, and the use of that crankshaft likely resulted in its fatigue failure.',
      quotes: [
        q('P5', 'Review of maintenance records indicated that the engine underwent a field overhaul about 10 years before the accident, during which the crankshaft was replaced.'),
        q(
          'P5',
          'It is likely that the use of a crankshaft that was not approved for use in the accident engine make and model resulted in abnormal contact between the connecting rods and their journals, imparting stress to the crankshaft and resulting in its failure.',
        ),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      symptom: { value: 'total_power_loss', passageIds: ['P6'] },
      chronology: { maintenance: FIELD_025, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 101, bound: 'about', passageIds: ['P5'] }] },
    },
    {
      ntsbNo: 'ERA13LA327',
      why: "Maintenance personnel did not remove circumferential gouges in the aft radius of the R2 rod journal during the engine's last overhaul, and the crankshaft later failed in fatigue, causing a total loss of engine power.",
      quotes: [
        q(
          'P8',
          'Maintenance personnel’s failure to remove circumferential gouges in the aft radius of the R2 rod journal on the crankshaft during its last engine overhaul, which resulted in the fatigue failure of the crankshaft and a subsequent total loss of engine power.',
        ),
        q('P7', 'Postaccident examination of the engine revealed that the crankshaft was fractured.'),
      ],
      evidencePassageIds: ['P7', 'P8'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P8'] },
      symptom: { value: 'total_power_loss', passageIds: ['P8'] },
      chronology: { maintenance: LAST_327, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 115, bound: 'about', passageIds: ['P7'] }] },
    },
    {
      ntsbNo: 'ERA13LA097',
      why: 'Improper connecting rods were reinstalled at the engine overhaul, which resulted in abnormal wear of the connecting rod bearings.',
      quotes: [
        q(
          'P12',
          'The reinstallation of improper connecting rods at engine overhaul, which resulted in abnormal wear of the connecting rod bearings; while the bearings did not meet the manufacturer’s specifications, the use of the unapproved connecting rods more likely caused the bearing wear.',
        ),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      chronology: { maintenance: OVERHAUL_097, facts: [] },
    },
  ],
  gaps: [{ ntsbNo: 'WPR24LA084', note: 'The supplied passage gives only the probable cause and does not say when the engine was last overhauled.', passageIds: ['P3'] }],
};

const T2: BriefSpec = {
  id: 'holdout16e.crankshaft',
  bundle: 'q16e-crankshaft',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: CRANK,
  note: 'About 101 and about 115 hours, not called flight hours, settle nothing (TW-H, AP-1): every timing decision is unknown.',
  errors: [
    {
      id: 'fh115',
      family: 'timing',
      mutation: 'operating_hours_as_flight_hours',
      expect: 'not_established',
      note: 'P7: about 115 hours after the last overhaul, not called flight hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA13LA327]]',
          "In the Univair 108-1 case, maintenance personnel did not remove circumferential gouges from a rod journal of the crankshaft during the engine's last overhaul, and the crankshaft failed in fatigue about 115 flight hours after that overhaul [[case:ERA13LA327]].",
        ),
    },
    {
      id: 'actor',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P2: maintenance personnel machined the crankshaft during the overhaul, not the pilot.',
      edit: (c) => {
        caseOf(c, 'NYC08LA280').why =
          'The pilot improperly machined the crankshaft during an engine overhaul, and the crankshaft and the No. 3 connecting rod later failed in fatigue, causing a loss of engine power.';
      },
    },
    {
      id: 'rod4',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P12: the bearings did not meet the manufacturer’s specifications.',
      edit: (c) => {
        caseOf(c, 'ERA13LA097').why =
          'Improper connecting rods were reinstalled at the engine overhaul, which resulted in abnormal wear of the connecting rod bearings, although the bearings met the manufacturer’s specifications.';
      },
    },
    {
      id: 'renitride',
      family: 'unsupported_addition',
      mutation: 'certainty_overstatement',
      expect: 'not_established',
      note: 'P5: it is possible that the renitriding may have contributed; investigators did not find that it caused the failure.',
      edit: (c) => {
        caseOf(c, 'ERA23FA025').why =
          'During a field overhaul about 10 years before the accident, the crankshaft was replaced with a renitrided one, and investigators found that the renitriding caused its fatigue failure.';
      },
    },
    {
      id: 'bearings',
      family: 'attribution',
      mutation: 'misleading_excerpt',
      expect: 'not_established',
      note: 'P12: the excerpt drops "while" and the rest of the sentence: the unapproved connecting rods more likely caused the bearing wear.',
      edit: (c) => {
        caseOf(c, 'ERA13LA097').quotes[0] = q('P12', 'the bearings did not meet the manufacturer’s specifications');
      },
    },
  ],
  mixed: [
    { id: 'mix-actor-rod4', errors: ['actor', 'rod4'], note: 'A wrong actor and a negation, in two cases.' },
    { id: 'mix-fh115-renitride', errors: ['fh115', 'renitride'], note: 'Operating hours as flight hours and a certainty overstatement, in two cases.' },
  ],
};

const CRANK_CLAIMS: ClaimBatch = {
  id: 'holdout16e.crankshaft-claims',
  bundle: 'q16e-crankshaft',
  cases: ['NYC08LA280', 'WPR24LA084', 'ERA23FA025', 'ERA13LA327', 'CEN11FA202', 'ERA13LA097'],
  readings: SHORTLY,
  claims: [
    yes(
      'nyc08.turned',
      'why',
      'NYC08LA280',
      ['P1'],
      'An engine logbook entry indicated that the main and rod bearing journals had been turned and their diameter reduced by 0.010 inch.',
      'P1.',
    ),
    no(
      'nyc08.nitrided',
      'why',
      'NYC08LA280',
      ['P1'],
      'Logbook entries verified that the crankshaft had been re-nitrided at the factory.',
      'contradiction',
      'negation',
      'contradicted',
      'P1: no logbook entries were located to verify that re-nitriding had been carried out.',
    ),
    yes('era23.hours', 'timing', 'ERA23FA025', ['P5'], timing(FIELD_025, { relation: 'operating_hours', value: 101, bound: 'about' }), 'P5: about 101 hours since overhaul.', {
      provenance: 'constructed',
    }),
    no(
      'era23.fh',
      'timing',
      'ERA23FA025',
      ['P5'],
      timing(FIELD_025, { relation: 'flight_hours', value: 101, bound: 'about' }),
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P5: about 101 hours since overhaul, not called flight hours.',
    ),
    yes('era23.unsettled', 'criterion', 'ERA23FA025', 'all', windowUnsettled(FIELD_025, 30, 10), 'About 10 years and about 101 operating hours settle nothing (TW-H, AP-1).', {
      provenance: 'constructed',
      absence: true,
      criterion: 'timing_window',
      decision: 'unknown',
    }),
    no(
      'era23.outside',
      'criterion',
      'ERA23FA025',
      ['P5'],
      `Under the timing rules, the event did not happen within 30 calendar days or 10 flight hours after ${FIELD_025}.`,
      'timing',
      'approximate_exact',
      'not_established',
      '"About 10 years" and "about 101 hours" are approximate and settle nothing under the timing rules, and the hours are not called flight hours.',
      { criterion: 'timing_window', decision: 'does_not_match' },
    ),
    yes('era13.115', 'timing', 'ERA13LA327', ['P7'], timing(LAST_327, { relation: 'operating_hours', value: 115, bound: 'about' }), 'P7: about 115 hours after the last overhaul.', {
      provenance: 'constructed',
    }),
    no(
      'era13.45',
      'why',
      'ERA13LA327',
      ['P7'],
      'About 45 years before the accident, the crankshaft main and connecting rod bearing journals were polished during an engine overhaul.',
      'contradiction',
      'wrong_value',
      'contradicted',
      'P7: they were ground 0.010 inch undersize about 45 years before; the polishing was at the overhaul about 7 years before.',
    ),
    yes('era13.installed', 'why', 'ERA13LA327', ['P7'], 'The engine was installed in the accident airplane about 3 years before the accident.', 'P7.'),
    no(
      'era13.first',
      'summary',
      'ERA13LA327',
      ['P7', 'P8'],
      "In the Univair 108-1 case, the crankshaft failed on the first flight after the engine's last overhaul (ERA13LA327).",
      'timing',
      'wrong_ordinal',
      'not_established',
      'P7: the failure came about 115 hours after the last overhaul; no passage says which flight it was.',
      { critical: true },
    ),
    yes('cen11.class', 'classification', 'CEN11FA202', ['P10'], CLASSIFIED.causal, 'P10: latent crankcase saddle bore discrepancies precipitated the fatigue failure of the crankshaft.'),
    no(
      'cen11.mechanic',
      'why',
      'CEN11FA202',
      ['P10'],
      'Contributing to the accident was a mechanic’s failure to identify the crankcase discrepancies during an annual inspection.',
      'attribution',
      'wrong_actor',
      'contradicted',
      'P10: the engine manufacturer failed to identify and address them when the engine was rebuilt.',
    ),
    yes(
      'era13-097.pc',
      'attribution',
      'ERA13LA097',
      ['P12'],
      said(
        'investigators',
        'The reinstallation of improper connecting rods at engine overhaul, which resulted in abnormal wear of the connecting rod bearings; while the bearings did not meet the manufacturer’s specifications, the use of the unapproved connecting rods more likely caused the bearing wear.',
      ),
      'P12, the probable cause, whole.',
    ),
    no(
      'wpr24.overhaul',
      'why',
      'WPR24LA084',
      ['P3'],
      "Investigators attributed the failure of the No. 3 connecting rod to improper maintenance during the engine's last overhaul.",
      'unsupported_addition',
      'added_detail',
      'not_established',
      'P3: bearing degradation, with the continued operation of an engine beyond its recommended overhaul contributing; no overhaul work is named.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16e-fuel-cap: CEN21LA242 (P1, P2), CHI08IA294 (P3, P4), ERA10LA357 (P5, P6),
// CEN26LA069 (P7), ERA09LA453 (P8, P9), WPR14FA135 (P10, P11, P12).

const ANNUAL_242 = 'the most recent annual inspection';
const VENT_135 = 'the rerouting of the fuel vent line';

const FUEL_CAP: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper J4A case, a worn gasket blocked the vent hole of a fuel tank cap that was not the correct part for the airplane, and the engine lost power from fuel starvation 39 days and 2.3 flight hours after the most recent annual inspection [[case:CEN21LA242]].',
    "In the Evolution Trikes REVO case, investigators attributed the loss of engine power to the pilot's reconfiguration of the fuel venting system, and the accident flight was the first flight with the rerouted fuel vent line [[case:WPR14FA135]].",
    'In the Cessna 172D case, a blocked fuel tank vent tube led to fuel starvation and a loss of engine power, and the deterioration of the right fuel cap vent contributed [[case:CEN26LA069]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['CEN21LA242', 'WPR14FA135', 'CEN26LA069'] }],
  cases: [
    {
      ntsbNo: 'CEN21LA242',
      why: "A worn gasket under a fuel tank cap that was not the correct part for the airplane blocked the cap's vent hole, which resulted in fuel starvation and a total loss of engine power.",
      quotes: [
        q('P2', 'A total loss of engine power due to a blocked fuel tank cap vent hole, which resulted in fuel starvation.'),
        q('P1', 'The accident occurred 39 days and 2.3 flight hours after the most recent annual inspection.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
      symptom: { value: 'total_power_loss', passageIds: ['P2'] },
      chronology: {
        maintenance: ANNUAL_242,
        facts: [
          { anchor: 'relevant_maintenance', relation: 'calendar_days', value: 39, bound: 'exact', passageIds: ['P1'] },
          { anchor: 'relevant_maintenance', relation: 'flight_hours', value: 2.3, bound: 'exact', passageIds: ['P1'] },
        ],
      },
    },
    {
      ntsbNo: 'WPR14FA135',
      why: "Investigators attributed the loss of engine power and the subsequent loss of aircraft control to the pilot's reconfiguration of the fuel venting system.",
      // Not P11's description of the new routing: its "then routed aft" is a sequence word the excerpt policy omits.
      quotes: [q('P12', "The pilot's reconfiguration of the fuel venting system, which resulted in a loss of engine power and subsequent loss of aircraft control.")],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      chronology: { maintenance: VENT_135, facts: [{ anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P11'] }] },
    },
    {
      ntsbNo: 'CEN26LA069',
      why: 'A blockage in the fuel tank vent tube, which the pilot did not see during the preflight inspection, led to fuel starvation and a loss of engine power, and the deterioration of the right fuel cap vent contributed.',
      quotes: [q('P7', 'Contributing to the accident was the deterioration of the right fuel cap vent to the point where it was inoperative.')],
      evidencePassageIds: ['P7'],
    },
  ],
  gaps: [
    { ntsbNo: 'ERA10LA357', note: 'The supplied passages say the maintenance records did not indicate when the fuel cap was last overhauled.', passageIds: ['P5'] },
    { ntsbNo: 'ERA09LA453', note: 'The supplied passages do not say when the fuel system was last inspected or maintained.', passageIds: ['P8', 'P9'] },
  ],
};

const T3: BriefSpec = {
  id: 'holdout16e.fuel-cap',
  bundle: 'q16e-fuel-cap',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: FUEL_CAP,
  note: 'CEN21LA242 matches by TW-N (2.3 flight hours are within 10, whatever the 39 days); the first flight settles no window (WPR14FA135 unknown); CEN26LA069 names no maintenance.',
  errors: [
    {
      id: 'swap',
      family: 'timing',
      mutation: 'unit_swap',
      expect: 'contradicted',
      note: 'P1: 39 days and 2.3 flight hours, not 39 flight hours and 2.3 days.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN21LA242]]',
          'In the Piper J4A case, a worn gasket blocked the vent hole of a fuel tank cap that was not the correct part for the airplane, and the engine lost power from fuel starvation 39 flight hours and 2.3 days after the most recent annual inspection [[case:CEN21LA242]].',
        ),
    },
    {
      id: 'before',
      family: 'timing',
      mutation: 'before_after',
      expect: 'contradicted',
      critical: true,
      note: 'P1: the accident came 39 days after the most recent annual inspection, not before it.',
      edit: (c) => {
        caseOf(c, 'CEN21LA242').why =
          "A worn gasket under a fuel tank cap that was not the correct part for the airplane blocked the cap's vent hole 39 days before the most recent annual inspection, which resulted in fuel starvation and a total loss of engine power.";
      },
    },
    {
      id: 'zero',
      family: 'timing',
      mutation: 'zero_interval',
      expect: 'not_established',
      critical: true,
      note: 'P11: the first flight with the rerouted line; no passage gives a time of zero hours from the rerouting.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR14FA135]]',
          "In the Evolution Trikes REVO case, investigators attributed the loss of engine power to the pilot's reconfiguration of the fuel venting system, and the engine lost power 0 flight hours after the fuel vent line was rerouted [[case:WPR14FA135]].",
        ),
    },
    {
      id: 'witness',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P2 is the probable cause, not a witness’s account.',
      edit: (c) => {
        caseOf(c, 'CEN21LA242').quotes[0]!.speaker = 'witness';
      },
    },
    {
      id: 'working',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P7: the right fuel cap vent had deteriorated to the point where it was inoperative.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN26LA069]]',
          'In the Cessna 172D case, a blocked fuel tank vent tube led to fuel starvation and a loss of engine power, although the right fuel cap vent was found working normally [[case:CEN26LA069]].',
        ),
    },
    {
      id: 'advice',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P10, P11: nothing says the manufacturer advised the rerouting.',
      edit: (c) => {
        caseOf(c, 'WPR14FA135').why =
          "Investigators attributed the loss of engine power and the subsequent loss of aircraft control to the pilot's reconfiguration of the fuel venting system, which he made on the airframe manufacturer's advice.";
      },
    },
  ],
  mixed: [
    { id: 'mix-swap-advice', errors: ['swap', 'advice'], note: 'A unit swap and an added detail, in two cases.' },
    { id: 'mix-witness-working', errors: ['witness', 'working'], note: 'A wrong speaker and a negation, in two cases.' },
  ],
};

const FUEL_CAP_CLAIMS: ClaimBatch = {
  id: 'holdout16e.fuel-cap-claims',
  bundle: 'q16e-fuel-cap',
  cases: ['CEN21LA242', 'CHI08IA294', 'ERA10LA357', 'CEN26LA069', 'ERA09LA453', 'WPR14FA135'],
  readings: SHORTLY,
  claims: [
    yes('cen21.days', 'timing', 'CEN21LA242', ['P1'], timing(ANNUAL_242, { relation: 'calendar_days', value: 39, bound: 'exact' }), 'P1: 39 days after the most recent annual inspection.', {
      provenance: 'constructed',
    }),
    yes('cen21.fh', 'timing', 'CEN21LA242', ['P1'], timing(ANNUAL_242, { relation: 'flight_hours', value: 2.3, bound: 'exact' }), 'P1: 2.3 flight hours after it.', { provenance: 'constructed' }),
    yes('cen21.within', 'criterion', 'CEN21LA242', ['P1'], within(ANNUAL_242, 30, 10), '2.3 flight hours are within 10, so the window matches whatever the 39 days (TW-N).', {
      provenance: 'constructed',
      criterion: 'timing_window',
      decision: 'matches',
    }),
    no(
      'cen21.unsettled',
      'criterion',
      'CEN21LA242',
      'all',
      windowUnsettled(ANNUAL_242, 30, 10),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P1 settles it: 2.3 flight hours are within 10 (TW-N).',
      { critical: true, absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    no(
      'cen21.outside',
      'criterion',
      'CEN21LA242',
      ['P1'],
      `Under the timing rules, the event did not happen within 30 calendar days or 10 flight hours after ${ANNUAL_242}.`,
      'timing',
      'wrong_window',
      'contradicted',
      'P1: 2.3 flight hours are within 10; a window is inside when either unit is.',
      { criterion: 'timing_window', decision: 'does_not_match' },
    ),
    no(
      'cen21.39fh',
      'summary',
      'CEN21LA242',
      ['P1', 'P2'],
      'In the Piper J4A case, the engine lost power 39 flight hours after the most recent annual inspection (CEN21LA242).',
      'timing',
      'unit_swap',
      'contradicted',
      'P1: 39 days and 2.3 flight hours.',
    ),
    yes('cen21.cap', 'why', 'CEN21LA242', ['P1'], 'The pilot reported that the forward fuel tank cap was on the airplane when he purchased it several years earlier.', 'P1, the pilot’s report.'),
    no(
      'cen21.replaced',
      'why',
      'CEN21LA242',
      ['P1'],
      'During the annual inspection, the mechanic replaced the cracked lower gasket of the forward fuel tank cap.',
      'contradiction',
      'negation',
      'contradicted',
      'P1: the mechanic should have observed the cracks; had they been observed, the cap would likely have been replaced; the two worn gaskets were still under the cap.',
    ),
    yes('wpr14.first', 'timing', 'WPR14FA135', ['P11'], timing(VENT_135, { relation: 'flight_ordinal', value: 1 }), 'P11: the accident flight was the first flight with the fuel line in that position.', {
      provenance: 'constructed',
    }),
    yes('wpr14.ff', 'criterion', 'WPR14FA135', ['P11'], firstFlight(VENT_135), 'P11 states the first flight (FF-O).', {
      provenance: 'constructed',
      criterion: 'first_flight_only',
      decision: 'matches',
    }),
    no(
      'wpr14.window',
      'criterion',
      'WPR14FA135',
      ['P11'],
      within(VENT_135, 30, 10),
      'timing',
      'first_flight_window',
      'not_established',
      'The first flight settles no calendar days or flight hours (G6); no passage gives either.',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'wpr14.second',
      'summary',
      'WPR14FA135',
      ['P10', 'P11', 'P12'],
      'In the Evolution Trikes REVO case, the accident flight was the second flight after the pilot rerouted the fuel vent line (WPR14FA135).',
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P11: it was the first flight with the fuel line in that position.',
      { critical: true },
    ),
    yes(
      'wpr14.pop',
      'why',
      'WPR14FA135',
      ['P11'],
      'On the morning of the accident, a second pilot removed the fuel cap for the accident pilot while he was routing compressed air into the fuel vent line, which produced a pop sound.',
      'P11.',
    ),
    no(
      'wpr14.position',
      'attribution',
      'WPR14FA135',
      ['P11'],
      said('investigators', 'The accident flight was the first flight with the fuel line in this position.'),
      'attribution',
      'quote_context_loss',
      'not_established',
      'P11: "this position" is the rerouting described in the sentence before; read alone the excerpt does not say which position.',
      { critical: true },
    ),
    yes('cen26.pc', 'attribution', 'CEN26LA069', ['P7'], said('investigators', 'Contributing to the accident was the deterioration of the right fuel cap vent to the point where it was inoperative.'), 'P7, the probable cause, second sentence.'),
    no(
      'era10.lineman',
      'why',
      'ERA10LA357',
      ['P5'],
      'The lineman at the fixed-base operator did not secure the fuel caps after fueling the airplane.',
      'contradiction',
      'negation',
      'contradicted',
      'P5: the lineman secured the fuel caps after the service.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16e-injection: ANC16LA010 (P1, P2), WPR22LA287 (P3, P4), CEN24LA378 (P5, P6),
// WPR11LA460 (P7, P8), WPR21LA119 (P9, P10), ERA15LA341 (P11, P12).

const WORK_378 = 'the crankcase repair and new fuel servo installation';
const SERVO_010 = 'the fuel injection servo repair and reinstallation';
const SERVO_341 = 'the fuel injection servo maintenance';

const INJECTION: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper PA32 case, maintenance personnel did not properly tighten the fuel supply line B-nut at the fuel servo, and the engine lost all power on the first flight following the maintenance [[case:CEN24LA378]].',
    'In the Robinson R44 II case, an overhaul facility used an approved lubricant improperly and in excess when overhauling the fuel injection servo, which disrupted fuel flow, and the servo had been reinstalled about 2.1 hours before the accident flight [[case:ANC16LA010]].',
    'In the Mooney M20E case, corrosion and rust in the fuel injection servo led to fuel starvation and a total loss of engine power [[case:WPR21LA119]].',
    'In the Piper PA 28RT-201 case, inadequate maintenance of the fuel injection servo, due to an out-of-date airworthiness directive list, let the servo plug back out of the regulator cover, and the engine lost all power [[case:ERA15LA341]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['CEN24LA378', 'ANC16LA010', 'WPR21LA119', 'ERA15LA341'] }],
  cases: [
    {
      ntsbNo: 'CEN24LA378',
      why: 'Maintenance personnel did not properly tighten the fuel supply line B-nut at the fuel servo, and the engine lost all power on the first flight following the maintenance.',
      quotes: [
        q('P6', 'A total loss of engine power due to maintenance personnel’s failure to properly tighten the fuel supply line B-nut at the fuel servo.'),
        q(
          'P5',
          'Because the accident flight was the first flight following the maintenance and the fuel servo had recently been replaced, it is also likely that maintenance personnel did not adequately tighten the B-nut during maintenance.',
        ),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      symptom: { value: 'total_power_loss', passageIds: ['P6'] },
      chronology: { maintenance: WORK_378, facts: [{ anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P5'] }] },
    },
    {
      ntsbNo: 'ANC16LA010',
      why: 'The overhaul facility used an approved lubricant improperly and in excess during the overhaul of the fuel injection servo, which disrupted fuel flow and caused a total loss of engine power.',
      quotes: [
        q('P2', 'The overhaul facility’s improper and excessive use of an approved lubricant during overhaul of the fuel injection servo, which resulted in a disruption of fuel flow and a total loss of engine power.'),
        q(
          'P1',
          "A review of the helicopter's maintenance records revealed that the fuel injection servo had been repaired on December 9, 2015 by Alaskan Aircraft Engines Inc., Anchorage, Alaska, and had been reinstalled on the helicopter about 2.1 hours prior to the accident flight.",
        ),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
      symptom: { value: 'total_power_loss', passageIds: ['P2'] },
      chronology: { maintenance: SERVO_010, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 2.1, bound: 'about', passageIds: ['P1'] }] },
    },
    {
      ntsbNo: 'WPR21LA119',
      why: 'Corrosion and rust in the fuel injection servo led to fuel starvation and a total loss of engine power during the initial climb after takeoff.',
      quotes: [q('P10', 'A total loss of engine power due to fuel starvation as a result of corrosion and rust in the fuel injection servo.')],
      evidencePassageIds: ['P9', 'P10'],
      symptom: { value: 'total_power_loss', passageIds: ['P10'] },
    },
    {
      ntsbNo: 'ERA15LA341',
      why: 'Because of an out-of-date airworthiness directive list, maintenance personnel did not maintain the fuel injection servo adequately, and its plug backed out of the threaded plug hole on the regulator cover, causing a total loss of engine power.',
      quotes: [
        q(
          'P12',
          'Maintenance personnel’s inadequate fuel injection servo maintenance due to an out-of-date AD list, which resulted in the fuel injection servo plug backing out of the threaded plug hole on the regulator cover of the fuel injection servo and subsequent total loss of engine power.',
        ),
        q(
          'P11',
          'Postaccident examination of the engine revealed that the brass fuel injection servo plug had backed out of the threaded plug hole on the regulator cover of the fuel injection servo and was hanging below the fuel servo by a piece of safety wire.',
        ),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      symptom: { value: 'total_power_loss', passageIds: ['P12'] },
      chronology: { maintenance: SERVO_341, facts: [] },
    },
  ],
  gaps: [{ ntsbNo: 'WPR22LA287', note: 'The supplied passages say the fuel injection servo was last rebuilt in August 1999 and that no accessories were overhauled at the engine overhaul in August 2012.', passageIds: ['P3'] }],
};

const T4: BriefSpec = {
  id: 'holdout16e.injection',
  bundle: 'q16e-injection',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: INJECTION,
  note: 'The first flight settles no window (G6) and about 2.1 hours, not called flight hours, settle nothing (TW-H, AP-1): every timing decision is unknown.',
  errors: [
    {
      id: 'zero',
      family: 'timing',
      mutation: 'zero_interval',
      expect: 'not_established',
      critical: true,
      note: 'P5: the first flight following the maintenance; no passage gives a time of zero hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN24LA378]]',
          'In the Piper PA32 case, maintenance personnel did not properly tighten the fuel supply line B-nut at the fuel servo, and the engine lost all power 0 flight hours after the maintenance [[case:CEN24LA378]].',
        ),
    },
    {
      id: 'fh',
      family: 'timing',
      mutation: 'operating_hours_as_flight_hours',
      expect: 'not_established',
      note: 'P1: about 2.1 hours, not called flight hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ANC16LA010]]',
          'In the Robinson R44 II case, an overhaul facility used an approved lubricant improperly and in excess when overhauling the fuel injection servo, which disrupted fuel flow, and the servo had been reinstalled about 2.1 flight hours before the accident flight [[case:ANC16LA010]].',
        ),
    },
    {
      id: 'pilot',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P11, P12: maintenance personnel maintained the servo, with the mechanic’s out-of-date AD list; not the pilot.',
      edit: (c) => {
        caseOf(c, 'ERA15LA341').why =
          'Because of an out-of-date airworthiness directive list, the pilot did not maintain the fuel injection servo adequately, and its plug backed out of the threaded plug hole on the regulator cover, causing a total loss of engine power.';
      },
    },
    {
      id: 'partial',
      family: 'contradiction',
      mutation: 'wrong_value',
      expect: 'contradicted',
      note: 'P9, P10: a total loss of engine power.',
      edit: (c) => {
        caseOf(c, 'WPR21LA119').why = 'Corrosion and rust in the fuel injection servo led to fuel starvation and a partial loss of engine power during the initial climb after takeoff.';
      },
    },
    {
      id: 'certified',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P1, P2: nothing says who at the facility overhauled the servo or what certificates they held.',
      edit: (c) => {
        caseOf(c, 'ANC16LA010').why =
          'An uncertificated mechanic at the overhaul facility used an approved lubricant improperly and in excess during the overhaul of the fuel injection servo, which disrupted fuel flow and caused a total loss of engine power.';
      },
    },
    {
      id: 'likely',
      family: 'attribution',
      mutation: 'quote_context_loss',
      expect: 'not_established',
      note: 'P5: the excerpt drops the reason the sentence gives ("Because the accident flight was the first flight following the maintenance …") and keeps "also", which points at the sentence before.',
      edit: (c) => {
        caseOf(c, 'CEN24LA378').quotes[1] = q('P5', 'it is also likely that maintenance personnel did not adequately tighten the B-nut during maintenance.');
      },
    },
  ],
  mixed: [
    { id: 'mix-zero-pilot', errors: ['zero', 'pilot'], note: 'A zero interval and a wrong actor, in two cases.' },
    { id: 'mix-fh-partial', errors: ['fh', 'partial'], note: 'Operating hours as flight hours and a wrong value, in two cases.' },
  ],
};

const INJECTION_CLAIMS: ClaimBatch = {
  id: 'holdout16e.injection-claims',
  bundle: 'q16e-injection',
  cases: ['ANC16LA010', 'WPR22LA287', 'CEN24LA378', 'WPR11LA460', 'WPR21LA119', 'ERA15LA341'],
  readings: SHORTLY,
  claims: [
    yes('cen24.first', 'timing', 'CEN24LA378', ['P5'], timing(WORK_378, { relation: 'flight_ordinal', value: 1 }), 'P5: the accident flight was the first flight following the maintenance.', {
      provenance: 'constructed',
    }),
    yes('cen24.ff', 'criterion', 'CEN24LA378', ['P5'], firstFlight(WORK_378), 'P5 states the first flight (FF-O).', { provenance: 'constructed', criterion: 'first_flight_only', decision: 'matches' }),
    no(
      'cen24.ffunsettled',
      'criterion',
      'CEN24LA378',
      'all',
      firstFlightUnsettled(WORK_378),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P5 settles it: the first flight following the maintenance (FF-O).',
      { critical: true, absence: true, criterion: 'first_flight_only', decision: 'unknown' },
    ),
    no(
      'cen24.window',
      'criterion',
      'CEN24LA378',
      ['P5'],
      within(WORK_378, 30, 10),
      'timing',
      'first_flight_window',
      'not_established',
      'The first flight settles no calendar days or flight hours (G6), and no passage gives either from the end of the work.',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    yes('cen24.unsettled', 'criterion', 'CEN24LA378', 'all', windowUnsettled(WORK_378, 30, 10), 'The first flight settles no window, and the 2 years in maintenance are not a time since the work (G6).', {
      provenance: 'constructed',
      absence: true,
      criterion: 'timing_window',
      decision: 'unknown',
    }),
    no(
      'cen24.zero',
      'why',
      'CEN24LA378',
      ['P5'],
      'The engine lost all power 0 flight hours after the maintenance was completed.',
      'timing',
      'zero_interval',
      'not_established',
      'P5: the first flight following the maintenance, after a run-up; no passage gives a time of zero hours.',
      { critical: true },
    ),
    yes('cen24.finger', 'why', 'CEN24LA378', ['P5'], 'Several other engine connections were found only finger tight, including the No. 4 fuel injector nozzle.', 'P5.'),
    no(
      'cen24.mag',
      'why',
      'CEN24LA378',
      ['P5'],
      'During the run-up, the pilot noted an excessive rpm drop on one magneto, and a second magneto check showed the same drop.',
      'contradiction',
      'negation',
      'contradicted',
      'P5: a second magneto check indicated no anomalies.',
    ),
    yes('anc16.hours', 'timing', 'ANC16LA010', ['P1'], timing(SERVO_010, { relation: 'operating_hours', value: 2.1, bound: 'about' }), 'P1: about 2.1 hours prior to the accident flight.', {
      provenance: 'constructed',
    }),
    no(
      'anc16.fh',
      'timing',
      'ANC16LA010',
      ['P1'],
      timing(SERVO_010, { relation: 'flight_hours', value: 2.1, bound: 'about' }),
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P1: about 2.1 hours, not called flight hours.',
    ),
    no(
      'anc16.unapproved',
      'why',
      'ANC16LA010',
      ['P1'],
      'The overhaul facility had switched to an assembly lubricant that was not approved for the fuel injection servo.',
      'contradiction',
      'negation',
      'contradicted',
      'P1: DuPont Krytox is an approved lubricant; it was used in excess and in locations not approved.',
    ),
    yes(
      'era15.ads',
      'why',
      'ERA15LA341',
      ['P11'],
      'The mechanic who had maintained the airplane for about 10 years used an AD list that was not current, so the three airworthiness directives had not been accomplished.',
      'P11.',
    ),
    no(
      'era15.entries',
      'why',
      'ERA15LA341',
      ['P11'],
      'Maintenance records showed that the fuel injection servo plug had been removed and reinstalled at the last annual inspection.',
      'contradiction',
      'negation',
      'contradicted',
      'P11: the records had no entry indicating any maintenance that would have required removal and reinstallation of the plug.',
    ),
    yes('wpr21.class', 'classification', 'WPR21LA119', ['P10'], CLASSIFIED.causal, 'P10: corrosion and rust in the fuel injection servo caused the fuel starvation.'),
    no(
      'wpr11.cause',
      'why',
      'WPR11LA460',
      ['P8'],
      'Investigators attributed the accident to a clogged fuel nozzle in the left engine.',
      'contradiction',
      'wrong_cause',
      'contradicted',
      'P8: the pilot’s failure to maintain minimum controllable airspeed; the partial loss of power from the clogged nozzle contributed.',
    ),
    yes(
      'wpr22.rebuilt',
      'why',
      'WPR22LA287',
      ['P3'],
      'Maintenance records indicated that the fuel injection servo was last rebuilt in August 1999, 23 years before the accident, while the engine was undergoing an overhaul.',
      'P3.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16e-induction: CEN13LA201 (P1, P2), CEN15LA106 (P3, P4, P5), ERA14LA392 (P6, P7),
// CEN22LA421 (P8), WPR13LA290 (P9, P10), CEN19FA279 (P11, P12).

const FILTER_290 = 'the air inlet barrier filter system exchange';
const RECENT_279 = 'the recent maintenance';
const ANNUAL_392 = 'the most recent annual inspection';

const INDUCTION: Composition = {
  outcome: 'answer',
  summary: [
    'In the McDonnell Douglas 369E case, maintenance personnel did not remove shop rags before completing the installation of the air inlet barrier system, and the engine ingested them and lost total power during the postmaintenance flight [[case:WPR13LA290]].',
    'In the Aero Commander 200 case, the engine’s metal intake screen was improperly installed, and the air filter element became displaced and lodged in the intake, causing a total loss of engine power on a maintenance check flight [[case:CEN19FA279]].',
    'In the Bellanca 7GCBC case, air intake filter material was ingested into the carburetor and caused a total loss of engine power about 13 hours of operation after the most recent annual inspection, which had replaced the induction filter [[case:ERA14LA392]].',
    'In the Piper PA-28R-180 case, a collapsed induction hose blocked the engine intake airflow and caused a partial loss of engine power [[case:CEN22LA421]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['WPR13LA290', 'CEN19FA279', 'ERA14LA392', 'CEN22LA421'] }],
  cases: [
    {
      ntsbNo: 'WPR13LA290',
      why: 'Maintenance personnel did not remove shop rags before completing the installation of the air inlet barrier system, and the engine ingested them and lost total power during the postmaintenance flight.',
      quotes: [
        q('P10', "The total loss of engine power due to the ingestion of a foreign object and maintenance personnel's failure to remove shop rags before completing the installation of the air inlet barrier system."),
        q('P9', "A postaccident examination of the helicopter's engine air inlet found that cloth material had been ingested into the engine air intake."),
      ],
      evidencePassageIds: ['P9', 'P10'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P10'] },
      symptom: { value: 'total_power_loss', passageIds: ['P10'] },
      chronology: { maintenance: FILTER_290, facts: [] },
    },
    {
      ntsbNo: 'CEN19FA279',
      why: 'The engine’s metal intake screen was improperly installed, which let the air filter element become displaced and lodge in the intake, blocking intake air and causing a total loss of engine power during a maintenance check flight.',
      quotes: [
        q(
          'P12',
          'The improper installation of the engine’s metal intake screen, which allowed the filter element to become displaced and subsequently lodge in the intake, blocking intake air and causing the total loss of engine power, at low altitude and low airspeed resulting in the airplane impacting terrain.',
        ),
        q('P11', 'The pilot and pilot-rated passenger were conducting a maintenance check flight.'),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      symptom: { value: 'total_power_loss', passageIds: ['P12'] },
      chronology: { maintenance: RECENT_279, facts: [] },
    },
    {
      ntsbNo: 'ERA14LA392',
      why: 'Air intake filter material was ingested into the carburetor and obstructed it, causing a total loss of engine power during maneuvering.',
      quotes: [
        q('P7', 'A total loss of engine power during maneuvering due to an obstruction from air intake filter material being ingested into the carburetor, which resulted in a forced landing.'),
        q('P6', 'Foam consistent with a portion of air intake filter material was observed obstructing more than half of the carburetor venturi opening.'),
      ],
      evidencePassageIds: ['P6', 'P7'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P6'] },
      symptom: { value: 'total_power_loss', passageIds: ['P7'] },
      chronology: { maintenance: ANNUAL_392, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 13, bound: 'about', passageIds: ['P6'] }] },
    },
    {
      ntsbNo: 'CEN22LA421',
      why: 'A collapsed induction hose blocked the engine intake airflow and caused a partial loss of engine power.',
      quotes: [q('P8', 'A partial loss of engine power due to a collapsed induction hose that blocked engine intake airflow.')],
      evidencePassageIds: ['P8'],
      symptom: { value: 'partial_power_loss', passageIds: ['P8'] },
    },
  ],
  gaps: [{ ntsbNo: 'CEN13LA201', note: 'The supplied passages attribute the right engine’s loss of power to ice obstructing its induction air system and do not mention maintenance.', passageIds: ['P1', 'P2'] }],
};

const T5: BriefSpec = {
  id: 'holdout16e.induction',
  bundle: 'q16e-induction',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: INDUCTION,
  note: 'About 13 hours of operation settle nothing (TW-H, AP-1), and no other case states a time from its maintenance: every timing decision is unknown.',
  errors: [
    {
      id: 'fh13',
      family: 'timing',
      mutation: 'operating_hours_as_flight_hours',
      expect: 'not_established',
      note: 'P6: about 13 hours of operation, not called flight hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA14LA392]]',
          'In the Bellanca 7GCBC case, air intake filter material was ingested into the carburetor and caused a total loss of engine power about 13 flight hours after the most recent annual inspection, which had replaced the induction filter [[case:ERA14LA392]].',
        ),
    },
    {
      id: 'speaker',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P9 is the investigators’ analysis, not the pilot’s account.',
      edit: (c) => {
        caseOf(c, 'WPR13LA290').quotes[1]!.speaker = 'pilot';
      },
    },
    {
      id: 'pilotrags',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P9, P10: maintenance personnel left the shop rags, not the pilot.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR13LA290]]',
          'In the McDonnell Douglas 369E case, the pilot did not remove shop rags before completing the installation of the air inlet barrier system, and the engine ingested them and lost total power during the postmaintenance flight [[case:WPR13LA290]].',
        ),
    },
    {
      id: 'total',
      family: 'contradiction',
      mutation: 'wrong_value',
      expect: 'contradicted',
      note: 'P8: a partial loss of engine power.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN22LA421]]',
          'In the Piper PA-28R-180 case, a collapsed induction hose blocked the engine intake airflow and caused a total loss of engine power [[case:CEN22LA421]].',
        ),
    },
    {
      id: 'mechanic',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P11: no records of the installation were found; nothing says who installed the screen.',
      edit: (c) => {
        caseOf(c, 'CEN19FA279').why =
          'The mechanic who installed the field-overhauled engine improperly installed its metal intake screen, which let the air filter element become displaced and lodge in the intake, blocking intake air and causing a total loss of engine power during a maintenance check flight.';
      },
    },
  ],
  mixed: [
    { id: 'mix-fh13-speaker', errors: ['fh13', 'speaker'], note: 'Operating hours as flight hours and a wrong speaker, in two cases.' },
    { id: 'mix-total-mechanic', errors: ['total', 'mechanic'], note: 'A wrong value and an added detail, in two cases.' },
  ],
};

const INDUCTION_CLAIMS: ClaimBatch = {
  id: 'holdout16e.induction-claims',
  bundle: 'q16e-induction',
  cases: ['CEN13LA201', 'CEN15LA106', 'ERA14LA392', 'CEN22LA421', 'WPR13LA290', 'CEN19FA279'],
  readings: SHORTLY,
  claims: [
    yes('era14.hours', 'timing', 'ERA14LA392', ['P6'], timing(ANNUAL_392, { relation: 'operating_hours', value: 13, bound: 'about' }), 'P6: about 13 hours since the most recent annual inspection.', {
      provenance: 'constructed',
    }),
    no(
      'era14.fh',
      'timing',
      'ERA14LA392',
      ['P6'],
      timing(ANNUAL_392, { relation: 'flight_hours', value: 13, bound: 'about' }),
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P6: about 13 hours of operation, not called flight hours.',
    ),
    yes(
      'era14.unsettled',
      'criterion',
      'ERA14LA392',
      'all',
      windowUnsettled(ANNUAL_392, 30, 10),
      'About 13 operating hours settle nothing, and the inspection’s date may not be combined with the header’s (TW-H, AP-1).',
      { provenance: 'constructed', absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    no(
      'era14.within',
      'criterion',
      'ERA14LA392',
      ['P6'],
      within(ANNUAL_392, 30, 10),
      'timing',
      'approximate_exact',
      'not_established',
      'P6: "about 13 hours" of operation settles nothing under the timing rules.',
      { criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'era14.days',
      'why',
      'ERA14LA392',
      ['P6'],
      'The most recent annual inspection was performed about 13 days before the accident.',
      'timing',
      'unit_swap',
      'not_established',
      'P6: about 13 hours of operation since the inspection, not 13 days.',
    ),
    yes(
      'era14.owner',
      'why',
      'ERA14LA392',
      ['P6'],
      'According to the airframe maintenance logbook, the most recent annual inspection was assisted by the previous owner and included replacing the induction filter.',
      'P6.',
    ),
    no(
      'era14.overhauled',
      'why',
      'ERA14LA392',
      ['P6'],
      'The engine was overhauled in 2001, when the No. 4 cylinder was replaced.',
      'contradiction',
      'negation',
      'contradicted',
      'P6: there was no indication that the engine had been overhauled since it was manufactured in 1973.',
    ),
    yes(
      'wpr13.preflight',
      'why',
      'WPR13LA290',
      ['P9'],
      'A preflight inspection was completed before the departure of the postmaintenance check flight, and no discrepancies were noted.',
      'P9.',
    ),
    no(
      'wpr13.visible',
      'why',
      'WPR13LA290',
      ['P9'],
      'The shop rags would have been visible during the preflight inspection.',
      'contradiction',
      'negation',
      'contradicted',
      'P9: with the barrier system installed, the rags would not have been visible during the preflight inspection.',
    ),
    yes(
      'cen19.records',
      'why',
      'CEN19FA279',
      ['P11'],
      'Neither an FAA Form 337 nor maintenance records for the installation of the modified engine were found during the investigation.',
      'P11.',
    ),
    yes('cen15.class', 'classification', 'CEN15LA106', ['P4'], CLASSIFIED.no_fault, 'P4: the engine produced full power with and without the ice in the filter; no other anomalies were noted.'),
    no(
      'cen15.alternate',
      'why',
      'CEN15LA106',
      ['P4'],
      'The student pilot opened the alternate air control during the initial power loss, but the engine did not restart.',
      'contradiction',
      'negation',
      'contradicted',
      'P4: the alternate air lever was found off, and the student did not know its use.',
    ),
    no(
      'cen22.maint',
      'maintenance',
      'CEN22LA421',
      ['P8'],
      MAINTAINED.investigator_attributed,
      'unsupported_addition',
      'added_detail',
      'not_established',
      'P8, the only passage, names the collapsed hose and no maintenance.',
    ),
    yes('cen13.pc', 'attribution', 'CEN13LA201', ['P2'], said('investigators', 'The obstruction of the right engine’s induction air system by ice, which resulted in a loss of engine power.'), 'P2, the probable cause, whole.'),
  ],
};

// ---------------------------------------------------------------------------
// q16e-gascolator: CEN24LA268 (P1, P2), WPR23LA203 (P3, P4), ERA14LA059 (P5, P6),
// CEN17LA316 (P7, P8), ERA23LA144 (P9, P10), CEN24LA184 (P11, P12).

const ANNUAL_268 = 'the annual inspection';
const ANNUAL_144 = 'the extensive annual inspection';
const HUNDRED_203 = 'the last 100-hour inspection';
const LINES_059 = 'the main fuel tank line replacement';

const GASCOLATOR: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper PA-28-181 case near Arcola, Texas, the mechanic did not properly secure the gascolator strainer bowl after an annual inspection, and the engine lost power from fuel starvation on the first flight after that inspection [[case:CEN24LA268]].',
    'In the Piper PA-28R-200 case, maintenance personnel did not secure the fuel strainer bowl with safety wire, and the leaking bowl starved the engine of fuel; the extensive annual inspection had been completed the day before the accident flight [[case:ERA23LA144]].',
    'In the Piper PA-28-181 case near West Jordan, Utah, the mechanic did not properly secure the gascolator strainer bowl, and the engine lost power from fuel starvation after about 60 hours of operation since the last 100-hour inspection [[case:WPR23LA203]].',
    'In the Prostar PT2 case, the owner/pilot did not follow the manufacturer’s recommendations for installing and safety wiring the gascolator strainer bowl, and the bowl separated, causing a total loss of engine power during a test flight [[case:ERA14LA059]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['CEN24LA268', 'ERA23LA144', 'WPR23LA203', 'ERA14LA059'] }],
  cases: [
    {
      ntsbNo: 'CEN24LA268',
      why: 'The mechanic did not properly secure the gascolator strainer bowl after an annual inspection, and on the first flight after that inspection the engine lost power from fuel starvation.',
      quotes: [
        q('P2', 'Loss of engine power due to fuel starvation as a result of the mechanic’s failure to properly secure the fuel system gascolator strainer bowl following an annual inspection.'),
        q('P1', 'The pilot reported that the accident occurred during the first flight after an annual inspection.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
      chronology: { maintenance: ANNUAL_268, facts: [{ anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P1'] }] },
    },
    {
      ntsbNo: 'ERA23LA144',
      why: 'Maintenance personnel did not secure the fuel strainer bowl with safety wire, and the leaking bowl starved the engine of fuel; the extensive annual inspection had been completed the day before the accident flight.',
      quotes: [
        q('P10', 'Maintenance personnel’s failure to secure the fuel strainer bowl with safety wire, which resulted in the fuel strainer bowl leaking and starving the engine of fuel.'),
        q('P9', 'The pilot purchased an airplane that had not flown in 22 years and that had an extensive annual inspection completed the day before the accident flight.'),
      ],
      evidencePassageIds: ['P9', 'P10'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P10'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P9'] },
      chronology: { maintenance: ANNUAL_144, facts: [{ anchor: 'relevant_maintenance', relation: 'previous_day', passageIds: ['P9'] }] },
    },
    {
      ntsbNo: 'WPR23LA203',
      why: 'The mechanic did not properly secure the gascolator strainer bowl: its bail wire was not engaged or safety wired and the bowl was not sealed to the housing, and the engine lost power from fuel starvation.',
      quotes: [
        q('P4', 'Loss of engine power due to fuel starvation as a result of the mechanic’s failure to properly secure the fuel system gascolator strainer bowl.'),
        q('P3', 'Review of the maintenance records showed that the last 100-hour inspection was completed on April 1, 2023, about two months before the accident.'),
      ],
      evidencePassageIds: ['P3', 'P4'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P4'] },
      chronology: { maintenance: HUNDRED_203, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 60, bound: 'about', passageIds: ['P3'] }] },
    },
    {
      ntsbNo: 'ERA14LA059',
      why: 'The owner/pilot did not follow the manufacturer’s recommendations for installing and safety wiring the gascolator strainer bowl, and the bowl separated, causing a total loss of engine power during a test flight after he replaced the main fuel tank lines.',
      quotes: [
        q(
          'P6',
          'The airplane owner/pilot ‘s failure to follow the gascolator manufacturer’s recommendations for installing and safety wiring the gascolator strainer bowl, which resulted in the bowl separating and a total loss of engine power due to fuel starvation.',
        ),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      symptom: { value: 'total_power_loss', passageIds: ['P6'] },
      chronology: { maintenance: LINES_059, facts: [] },
    },
  ],
  gaps: [{ ntsbNo: 'CEN24LA184', note: 'The supplied passages say it could not be determined when maintenance personnel last inspected the gascolator.', passageIds: ['P11'] }],
};

const T6: BriefSpec = {
  id: 'holdout16e.gascolator',
  bundle: 'q16e-gascolator',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: GASCOLATOR,
  note: 'ERA23LA144 matches by TW-C (the day before); the first flight settles no window (CEN24LA268 unknown); about 60 operating hours settle nothing (WPR23LA203 unknown).',
  errors: [
    {
      id: 'hours24',
      family: 'timing',
      mutation: 'previous_day_hours',
      expect: 'not_established',
      critical: true,
      note: 'P9: the day before is one calendar-date boundary, not a number of hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA23LA144]]',
          'In the Piper PA-28R-200 case, maintenance personnel did not secure the fuel strainer bowl with safety wire, and the leaking bowl starved the engine of fuel; the extensive annual inspection had been completed less than 24 hours before the accident flight [[case:ERA23LA144]].',
        ),
    },
    {
      id: 'first',
      family: 'timing',
      mutation: 'wrong_ordinal',
      expect: 'contradicted',
      critical: true,
      note: 'P9: on the day of the accident the pilot flew a short flight to an airport first; the engine lost power on the second leg.',
      edit: (c) => {
        caseOf(c, 'ERA23LA144').why =
          'Maintenance personnel did not secure the fuel strainer bowl with safety wire, and the leaking bowl starved the engine of fuel on the first flight after the extensive annual inspection, which had been completed the day before.';
      },
    },
    {
      id: 'zero',
      family: 'timing',
      mutation: 'zero_interval',
      expect: 'not_established',
      critical: true,
      note: 'P1: the first flight after the inspection; no passage gives a time of zero hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN24LA268]]',
          'In the Piper PA-28-181 case near Arcola, Texas, the mechanic did not properly secure the gascolator strainer bowl after an annual inspection, and the engine lost power from fuel starvation 0 flight hours after that inspection [[case:CEN24LA268]].',
        ),
    },
    {
      id: 'fh60',
      family: 'timing',
      mutation: 'operating_hours_as_flight_hours',
      expect: 'not_established',
      note: 'P3: about 60 hours of operation, not called flight hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR23LA203]]',
          'In the Piper PA-28-181 case near West Jordan, Utah, the mechanic did not properly secure the gascolator strainer bowl, and the engine lost power from fuel starvation about 60 flight hours after the last 100-hour inspection [[case:WPR23LA203]].',
        ),
    },
    {
      id: 'mechanic',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P5, P6: the owner/pilot did the work, not a mechanic.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA14LA059]]',
          'In the Prostar PT2 case, a mechanic did not follow the manufacturer’s recommendations for installing and safety wiring the gascolator strainer bowl, and the bowl separated, causing a total loss of engine power during a test flight [[case:ERA14LA059]].',
        ),
    },
    {
      id: 'rewired',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P1: the mechanics acknowledged that safety wire was not reinstalled after the annual inspection.',
      edit: (c) => {
        caseOf(c, 'CEN24LA268').why =
          'The mechanics reinstalled the safety wire on the gascolator after an annual inspection, but the strainer bowl was not properly secured, and on the first flight after that inspection the engine lost power from fuel starvation.';
      },
    },
    {
      id: 'cracked',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P3: the bowl was not sealed and was twisted; its seal and screen were undamaged; nothing says it was cracked.',
      edit: (c) => {
        caseOf(c, 'WPR23LA203').why =
          'The mechanic did not properly secure the gascolator strainer bowl, which cracked and leaked: its bail wire was not engaged or safety wired and the bowl was not sealed to the housing, and the engine lost power from fuel starvation.';
      },
    },
  ],
  mixed: [
    { id: 'mix-hours24-mechanic', errors: ['hours24', 'mechanic'], note: 'The previous day given as hours and a wrong actor, in two cases.' },
    { id: 'mix-zero-cracked', errors: ['zero', 'cracked'], note: 'A zero interval and an added detail, in two cases.' },
  ],
};

const GASCOLATOR_CLAIMS: ClaimBatch = {
  id: 'holdout16e.gascolator-claims',
  bundle: 'q16e-gascolator',
  cases: ['CEN24LA268', 'WPR23LA203', 'ERA14LA059', 'CEN17LA316', 'ERA23LA144', 'CEN24LA184'],
  readings: SHORTLY,
  claims: [
    yes('cen24.first', 'timing', 'CEN24LA268', ['P1'], timing(ANNUAL_268, { relation: 'flight_ordinal', value: 1 }), 'P1: the pilot reported the first flight after an annual inspection.', {
      provenance: 'constructed',
    }),
    yes('cen24.ff', 'criterion', 'CEN24LA268', ['P1'], firstFlight(ANNUAL_268), 'P1 states the first flight (FF-O).', { provenance: 'constructed', criterion: 'first_flight_only', decision: 'matches' }),
    no(
      'cen24.window',
      'criterion',
      'CEN24LA268',
      ['P1'],
      within(ANNUAL_268, 30, 10),
      'timing',
      'first_flight_window',
      'not_established',
      'The first flight settles no calendar days or flight hours (G6), and no passage gives either.',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'cen24.zero',
      'timing',
      'CEN24LA268',
      ['P1'],
      timing(ANNUAL_268, { relation: 'flight_hours', value: 0, bound: 'exact' }),
      'timing',
      'zero_interval',
      'not_established',
      'P1: the first flight after the inspection, after a preflight inspection and an extended run-up; no passage gives zero flight hours.',
      { critical: true },
    ),
    yes('era23.prev', 'timing', 'ERA23LA144', ['P9'], timing(ANNUAL_144, { relation: 'previous_day' }), 'P9: completed the day before the accident flight.', { provenance: 'constructed' }),
    yes('era23.within', 'criterion', 'ERA23LA144', ['P9'], within(ANNUAL_144, 30, 10), 'The day before is within 30 calendar days (TW-C).', {
      provenance: 'constructed',
      criterion: 'timing_window',
      decision: 'matches',
    }),
    no(
      'era23.24h',
      'summary',
      'ERA23LA144',
      ['P9', 'P10'],
      'In the Piper PA-28R-200 case, the extensive annual inspection was completed within 24 hours of the accident flight (ERA23LA144).',
      'timing',
      'previous_day_hours',
      'not_established',
      '"The day before" is one calendar-date boundary, not a number of hours.',
      { critical: true },
    ),
    no(
      'era23.fh',
      'criterion',
      'ERA23LA144',
      ['P9'],
      within(ANNUAL_144, null, 10),
      'timing',
      'previous_day_hours',
      'not_established',
      'The previous day settles calendar days only, never flight hours (TW-C); no passage gives flight hours.',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'era23.first',
      'summary',
      'ERA23LA144',
      ['P9', 'P10'],
      'In the Piper PA-28R-200 case, the engine lost power on the first flight after the extensive annual inspection (ERA23LA144).',
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P9: the pilot first flew a short flight to an airport that day; the engine lost power on the second leg.',
      { critical: true },
    ),
    no(
      'era23.after',
      'summary',
      'ERA23LA144',
      ['P9', 'P10'],
      'In the Piper PA-28R-200 case, the extensive annual inspection was completed the day after the accident flight (ERA23LA144).',
      'timing',
      'before_after',
      'contradicted',
      'P9: it was completed the day before the accident flight.',
      { critical: true },
    ),
    yes('era23.nozzles', 'why', 'ERA23LA144', ['P9'], 'One of the fuel injector nozzles was completely obstructed and another was partially obstructed.', 'P9.'),
    yes('wpr23.hours', 'timing', 'WPR23LA203', ['P3'], timing(HUNDRED_203, { relation: 'operating_hours', value: 60, bound: 'about' }), 'P3: about 60 hours of operation since that inspection.', {
      provenance: 'constructed',
    }),
    no(
      'wpr23.fh',
      'timing',
      'WPR23LA203',
      ['P3'],
      timing(HUNDRED_203, { relation: 'flight_hours', value: 60, bound: 'about' }),
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P3: about 60 hours of operation, not called flight hours.',
    ),
    yes(
      'cen17.records',
      'why',
      'CEN17LA316',
      ['P7'],
      'The airplane maintenance logbooks had no record of compliance with Navion Service Bulletin No. 106 A and no mention of gascolator maintenance from December 2006 to July 2017.',
      'P7.',
    ),
    no(
      'cen17.held',
      'why',
      'CEN17LA316',
      ['P7'],
      'In the postaccident vacuum test, the gascolator held the required 24 inches of vacuum.',
      'contradiction',
      'negation',
      'contradicted',
      'P7: it failed to hold the vacuum for any amount of time and leaked from both seals and the drain valve.',
    ),
    no(
      'cen24-184.sumped',
      'why',
      'CEN24LA184',
      ['P11'],
      'The airplane owner regularly sumped the quick drain gascolator for the right fuel tank.',
      'contradiction',
      'negation',
      'contradicted',
      'P11: he thought it was part of the brake system and never sumped that drain.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16e-main-rotor: WPR18LA242 (P1, P2), ERA15FA164 (P3, P4), ERA23FA070 (P5, P6),
// WPR15FA051 (P7, P8), CEN10FA291 (P9, P10), ERA13FA186 (P11, P12).

const BLADES_186 = 'the main rotor blade replacement';
const BLADES_051 = 'the reinstallation of the main rotor blades';
const HARDWARE_070 = 'the inspections of the control rod end hardware';
const WORK_291 = 'the maintenance before the postmaintenance flight';

const ROTOR: Composition = {
  outcome: 'answer',
  summary: [
    'In the Robinson R44 case near Miami, Florida, the mechanic did not properly secure the pitch link hardware of one main rotor blade after changing the main rotor blades, and the pitch link separated in flight about 1 hour of operation after the blade replacement [[case:ERA13FA186]].',
    'In the Robinson R44 case near Bountiful, Utah, the pilot, who was also a mechanic, did not properly secure the pitch link hardware of one main rotor blade, and the pitch link separated in flight during a test flight to adjust the track and balance of the blades [[case:WPR15FA051]].',
    'In the Robinson R44 case near Charlotte, North Carolina, inadequate inspections of the forward left control rod end attachment hardware let it loosen and back out, and the helicopter went out of control [[case:ERA23FA070]].',
    'In the Bell 222 case, a swashplate drive pin fractured from hydrogen embrittlement of unknown source, and the main rotor system broke up in flight about 8 minutes after the postmaintenance flight departed [[case:CEN10FA291]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['ERA13FA186', 'WPR15FA051', 'ERA23FA070', 'CEN10FA291'] }],
  cases: [
    {
      ntsbNo: 'ERA13FA186',
      why: 'The mechanic did not properly secure the pitch link hardware of one main rotor blade to the rotating swashplate after changing the main rotor blades, and the pitch link separated in flight.',
      quotes: [
        q('P12', "The mechanic's failure to properly secure the pitch link hardware of one main rotor blade to the rotating swash plate, which resulted in the pitch link separating in flight and the pilot's subsequent loss of control."),
        q('P11', 'On-scene examination of the wreckage revealed that the pitch-link-to-swash-plate connection for one of the main rotor blades was missing.'),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      chronology: { maintenance: BLADES_186, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 1, bound: 'about', passageIds: ['P11'] }] },
    },
    {
      ntsbNo: 'WPR15FA051',
      why: 'The pilot, who was also a mechanic, did not properly secure the pitch link hardware of one main rotor blade to the rotating swashplate, and the pitch link separated in flight.',
      quotes: [
        q('P8', "The pilot/mechanic's failure to properly secure the pitch link hardware of one main rotor blade to the rotating swash plate, which resulted in the pitch link separating in flight and a subsequent loss of control."),
        q('P7', 'The accident flight was a test flight to adjust the track and balance of the rotor blades.'),
      ],
      evidencePassageIds: ['P7', 'P8'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P8'] },
      chronology: { maintenance: BLADES_051, facts: [] },
    },
    {
      ntsbNo: 'ERA23FA070',
      why: 'Inadequate inspections by the pilot and by maintenance personnel let the attachment hardware of the forward left control rod end to the stationary swashplate loosen and back out, and the helicopter went out of control.',
      quotes: [
        q(
          'P6',
          'The inadequate inspections of the forward left control rod end attachment hardware to the stationary swashplate by the pilot and by maintenance personnel, resulting in an eventual loosening and backing out of the hardware and subsequent loss of helicopter control.',
        ),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      chronology: { maintenance: HARDWARE_070, facts: [] },
    },
    {
      ntsbNo: 'CEN10FA291',
      why: 'A swashplate drive pin fractured from hydrogen embrittlement of unknown source during a postmaintenance flight, which resulted in an in-flight breakup of the main rotor system.',
      quotes: [
        q('P10', 'The fracture of a swashplate drive pin as a result of hydrogen embrittlement due to an unknown source, which resulted in an in-flight breakup of the main rotor system during cruise flight.'),
        q('P9', 'The helicopter was on a postmaintenance flight when it experienced an in-flight breakup about 8 minutes after departure, collided with the ground, and exploded into flames.'),
      ],
      evidencePassageIds: ['P9', 'P10'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P9', 'P10'] },
      chronology: { maintenance: WORK_291, facts: [] },
    },
  ],
  gaps: [
    { ntsbNo: 'ERA15FA164', note: 'The supplied passages say the helicopter’s maintenance logbook had no entries for the repairs to the main rotor system.', passageIds: ['P3'] },
    { ntsbNo: 'WPR18LA242', note: 'The supplied passages do not say when the swashplate drive link or its trunnion bearing was last inspected or replaced.', passageIds: ['P1', 'P2'] },
  ],
};

const T7: BriefSpec = {
  id: 'holdout16e.main-rotor',
  bundle: 'q16e-main-rotor',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: ROTOR,
  note: 'About 1 hour of operation settles nothing (TW-H, AP-1), and no other case states a time from its maintenance: every timing decision is unknown.',
  errors: [
    {
      id: 'first',
      family: 'timing',
      mutation: 'wrong_ordinal',
      expect: 'contradicted',
      critical: true,
      note: 'P11: the accident flight was the second maintenance flight of the day.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA13FA186]]',
          'In the Robinson R44 case near Miami, Florida, the mechanic did not properly secure the pitch link hardware of one main rotor blade after changing the main rotor blades, and the pitch link separated in flight on the first maintenance flight of the day [[case:ERA13FA186]].',
        ),
    },
    {
      id: 'ten',
      family: 'contradiction',
      mutation: 'wrong_value',
      expect: 'contradicted',
      note: 'P11: about 1 hour of operation after the blade replacement, not 10.',
      edit: (c) => {
        caseOf(c, 'ERA13FA186').why =
          'The mechanic did not properly secure the pitch link hardware of one main rotor blade to the rotating swashplate after changing the main rotor blades, and the pitch link separated in flight about 10 hours of operation after the replacement.';
      },
    },
    {
      id: 'shop',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P7, P8: the pilot, who was also a mechanic, reinstalled the blades and secured the hardware; not a repair station.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR15FA051]]',
          'In the Robinson R44 case near Bountiful, Utah, a mechanic at the repair station that reworked the blades did not properly secure the pitch link hardware of one main rotor blade, and the pitch link separated in flight during a test flight to adjust the track and balance of the blades [[case:WPR15FA051]].',
        ),
    },
    {
      id: 'witness',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P11 is the investigators’ examination, not a witness’s account.',
      edit: (c) => {
        caseOf(c, 'ERA13FA186').quotes[1]!.speaker = 'witness';
      },
    },
    {
      id: 'source',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P9: investigators were unable to determine the source of the hydrogen.',
      edit: (c) => {
        caseOf(c, 'CEN10FA291').why =
          'A swashplate drive pin fractured from hydrogen embrittlement, whose source investigators traced to the pin’s plating, during a postmaintenance flight, which resulted in an in-flight breakup of the main rotor system.';
      },
    },
    {
      id: 'annual',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P5, P6: nothing says the control rod was removed at an annual inspection.',
      edit: (c) => {
        caseOf(c, 'ERA23FA070').why =
          'Maintenance personnel removed the forward left control rod during the last annual inspection, and inadequate inspections by the pilot and by maintenance personnel let its attachment hardware loosen and back out, and the helicopter went out of control.';
      },
    },
  ],
  mixed: [
    { id: 'mix-first-witness', errors: ['first', 'witness'], note: 'The wrong flight and a wrong speaker, in one case.' },
    { id: 'mix-shop-source', errors: ['shop', 'source'], note: 'A wrong actor and a negation, in two cases.' },
  ],
};

const ROTOR_CLAIMS: ClaimBatch = {
  id: 'holdout16e.main-rotor-claims',
  bundle: 'q16e-main-rotor',
  cases: ['WPR18LA242', 'ERA15FA164', 'ERA23FA070', 'WPR15FA051', 'CEN10FA291', 'ERA13FA186'],
  readings: SHORTLY,
  claims: [
    yes('era13.hours', 'timing', 'ERA13FA186', ['P11'], timing(BLADES_186, { relation: 'operating_hours', value: 1, bound: 'about' }), 'P11: about 1 hour of operation after the main rotor blade replacement.', {
      provenance: 'constructed',
    }),
    yes('era13.second', 'why', 'ERA13FA186', ['P11'], 'The accident flight was the second maintenance flight of the day.', 'P11.'),
    no(
      'era13.firstday',
      'why',
      'ERA13FA186',
      ['P11'],
      'The accident flight was the first maintenance flight of the day.',
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P11: the second maintenance flight of the day.',
      { critical: true },
    ),
    no(
      'era13.first',
      'summary',
      'ERA13FA186',
      ['P11', 'P12'],
      'In the Robinson R44 case near Miami, Florida, the pitch link separated on the first flight after the main rotor blade replacement (ERA13FA186).',
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P11: the blade change was followed by test flights, and the accident flight was the second maintenance flight of the day.',
      { critical: true },
    ),
    yes('era13.unsettled', 'criterion', 'ERA13FA186', 'all', windowUnsettled(BLADES_186, 30, 10), 'About 1 hour settles nothing (TW-H, AP-1), and no passage dates the replacement.', {
      provenance: 'constructed',
      absence: true,
      criterion: 'timing_window',
      decision: 'unknown',
    }),
    no(
      'era13.within',
      'criterion',
      'ERA13FA186',
      ['P11'],
      within(BLADES_186, 30, 10),
      'timing',
      'approximate_exact',
      'not_established',
      'P11: "about 1 hour" settles nothing under the timing rules.',
      { criterion: 'timing_window', decision: 'matches' },
    ),
    yes(
      'wpr15.torque',
      'why',
      'WPR15FA051',
      ['P7'],
      'All torque values measured on the locknuts of the three recovered pitch change link attachment bolts were lower than the maintenance manual specified.',
      'P7.',
    ),
    no(
      'wpr15.missing',
      'why',
      'WPR15FA051',
      ['P7'],
      'The torque of the missing pitch change link attachment bolt was measured and was within the maintenance manual’s specification.',
      'contradiction',
      'negation',
      'contradicted',
      'P7: the torque for the missing bolt could not be measured.',
    ),
    yes('era23.missing', 'why', 'ERA23FA070', ['P5'], 'The fastening hardware of the forward left control rod end connection to the stationary swashplate flange was missing.', 'P5.'),
    no(
      'era23.screen',
      'why',
      'ERA23FA070',
      ['P5'],
      'Examination of the engine found that the oil sump suction screen was clogged.',
      'contradiction',
      'negation',
      'contradicted',
      'P5: the oil sump suction screen was clear.',
    ),
    yes(
      'cen10.pins',
      'why',
      'CEN10FA291',
      ['P9'],
      'Both drive pins met engineering drawing requirements for material, hardness, heat treatment and plating, but there were no engineering standards for hydrogen content.',
      'P9.',
    ),
    no(
      'cen10.source',
      'why',
      'CEN10FA291',
      ['P9'],
      'Investigators determined that the hydrogen came from the plating process of the drive pin.',
      'contradiction',
      'negation',
      'contradicted',
      'P9: investigators were unable to conclusively determine the source of the hydrogen.',
    ),
    yes(
      'era15.logbook',
      'why',
      'ERA15FA164',
      ['P3'],
      'The helicopter’s maintenance logbook had no entries regarding the repairs to the main rotor system, and the chief mechanic who completed the job made no entries because he forgot.',
      'P3.',
    ),
    yes('wpr18.blades', 'why', 'WPR18LA242', ['P1'], 'Both main rotor blades were installed on the helicopter at 6,217.9 hours.', 'P1.'),
    no(
      'wpr18.since',
      'why',
      'WPR18LA242',
      ['P1'],
      'Both main rotor blades had accumulated 6,217.9 hours since they were installed on the helicopter.',
      'timing',
      'wrong_anchor',
      'not_established',
      'P1: the blades were installed at 6,217.9 hours (the helicopter’s total time then); no passage gives the time since.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16e-homebuilt-engine: CEN24LA012 (P1, P2), WPR14LA323 (P3, P4), WPR18LA250 (P5, P6),
// CEN16LA167 (P7, P8), WPR10LA483 (P9, P10), WPR15LA067 (P11, P12).

const SERVO_323 = 'the reinstallation of the fuel servo';
const ENGINE_250 = 'the engine installation';
const SURGING_067 = 'the maintenance to resolve the engine surging';
const IGNITION_012 = 'the installation of the supplemental ignition system';

const HOMEBUILT: Composition = {
  outcome: 'answer',
  summary: [
    'In the Rans S-16 case, the pilot had reinstalled the overhauled fuel servo and did not adequately tighten the fuel line’s B-nut, which came loose during takeoff on the first flight since the installation [[case:WPR14LA323]].',
    'In the Glasair Super IIS case, the throttle linkage detached from the throttle arm of the fuel injection servo because its bolt was insufficiently tightened and secured, about 91 flight hours after the engine was installed [[case:WPR18LA250]].',
    'In the amateur-built Beaver case, after the owner-builder’s maintenance to resolve a longstanding engine surging problem, the engine lost partial power during takeoff because the carburetor and fuel supply system were improperly configured [[case:WPR15LA067]].',
    'In the Tvap 4 case, an improperly installed supplemental ignition system caused a total loss of engine power [[case:CEN24LA012]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['WPR14LA323', 'WPR18LA250', 'WPR15LA067', 'CEN24LA012'] }],
  cases: [
    {
      ntsbNo: 'WPR14LA323',
      why: 'The pilot had reinstalled the fuel servo after its overhaul and did not adequately tighten the fuel line’s B-nut, which came loose during takeoff on the first flight since the installation, causing a total loss of engine power.',
      quotes: [
        q('P4', 'The fuel flow divider inlet line’s B-nut coming loose during takeoff, resulting in a total loss of engine power.'),
        // Not P3's "… and this was the first flight since the installation": "this" points at the sentence's own clause, but the excerpt policy omits it.
        q('P3', "Postaccident examination revealed that the fuel line's B-nut fitting connecting the fuel servo to the fuel flow divider was about 1 1/3 turns loose."),
      ],
      evidencePassageIds: ['P3', 'P4'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P4'] },
      symptom: { value: 'total_power_loss', passageIds: ['P4'] },
      chronology: { maintenance: SERVO_323, facts: [{ anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P3'] }] },
    },
    {
      ntsbNo: 'WPR18LA250',
      why: 'The throttle linkage detached from the throttle arm of the fuel injection servo because its bolt was insufficiently tightened and secured, and the subsequent maintenance inspection was inadequate, resulting in a total loss of engine power.',
      quotes: [
        q(
          'P6',
          'A total loss of engine power as a result of the detachment of the throttle linkage from the throttle arm of the fuel injector servo due to an insufficiently tightened and secured bolt and the subsequent inadequate maintenance inspection.',
        ),
        q('P5', 'Postaccident examination of the engine revealed that the throttle linkage had detached from the throttle arm of the fuel injection servo.'),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      symptom: { value: 'total_power_loss', passageIds: ['P6'] },
      chronology: { maintenance: ENGINE_250, facts: [{ anchor: 'relevant_maintenance', relation: 'flight_hours', value: 91, bound: 'about', passageIds: ['P5'] }] },
    },
    {
      ntsbNo: 'WPR15LA067',
      why: 'After the owner-builder’s maintenance to resolve a longstanding engine surging problem, the engine lost partial power during takeoff because the carburetor and fuel supply system were improperly configured.',
      quotes: [
        q('P12', 'The partial loss of engine power during takeoff due to an improperly configured carburetor and fuel supply system.'),
        q(
          'P11',
          "Postaccident examination revealed numerous installation and maintenance discrepancies related to the carburetor and fuel supply system, which were not in accordance with the engine manufacturer's installation and maintenance manuals.",
        ),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P11', 'P12'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P12'] },
      chronology: { maintenance: SURGING_067, facts: [] },
    },
    {
      ntsbNo: 'CEN24LA012',
      why: 'The supplemental ignition system was improperly installed, with fuses that its installation instructions did not call for, which resulted in a total loss of engine power.',
      quotes: [
        q('P2', 'The improper installation of the supplemental ignition system, which resulted in a total loss of engine power.'),
        q('P1', 'Two units of the supplemental system were installed with fuses that were not called for in the system installation instructions.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
      symptom: { value: 'total_power_loss', passageIds: ['P2'] },
      chronology: { maintenance: IGNITION_012, facts: [] },
    },
  ],
  gaps: [{ ntsbNo: 'CEN16LA167', note: 'The supplied passages do not say when the generator voltage regulator connection was last worked on.', passageIds: ['P7', 'P8'] }],
};

const T8: BriefSpec = {
  id: 'holdout16e.homebuilt-engine',
  bundle: 'q16e-homebuilt-engine',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: HOMEBUILT,
  note: 'The first flight settles no window (G6) and about 91 flight hours settle nothing (AP-1): every timing decision is unknown.',
  errors: [
    {
      id: 'zero',
      family: 'timing',
      mutation: 'zero_interval',
      expect: 'not_established',
      critical: true,
      note: 'P3: the first flight since the installation; no passage gives a time of zero hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR14LA323]]',
          'In the Rans S-16 case, the pilot had reinstalled the overhauled fuel servo and did not adequately tighten the fuel line’s B-nut, which came loose during takeoff 0 flight hours after the installation [[case:WPR14LA323]].',
        ),
    },
    {
      id: 'before',
      family: 'timing',
      mutation: 'before_after',
      expect: 'contradicted',
      critical: true,
      note: 'P5: the engine was installed about 91 flight hours before the accident flight, not after it.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR18LA250]]',
          'In the Glasair Super IIS case, the throttle linkage detached from the throttle arm of the fuel injection servo because its bolt was insufficiently tightened and secured, about 91 flight hours before the engine was installed [[case:WPR18LA250]].',
        ),
    },
    {
      id: 'first',
      family: 'timing',
      mutation: 'wrong_ordinal',
      expect: 'contradicted',
      critical: true,
      note: 'P11: earlier that morning the pilot had made the first flight since the maintenance; the accident flight came after it.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR15LA067]]',
          'In the amateur-built Beaver case, on the first flight after the owner-builder’s maintenance to resolve a longstanding engine surging problem, the engine lost partial power during takeoff because the carburetor and fuel supply system were improperly configured [[case:WPR15LA067]].',
        ),
    },
    {
      id: 'mechanic',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P3, P4: the pilot reinstalled the servo and did not tighten the B-nut, not a mechanic.',
      edit: (c) => {
        caseOf(c, 'WPR14LA323').why =
          'A mechanic had reinstalled the fuel servo after its overhaul and did not adequately tighten the fuel line’s B-nut, which came loose during takeoff on the first flight since the installation, causing a total loss of engine power.';
      },
    },
    {
      id: 'partial',
      family: 'contradiction',
      mutation: 'wrong_value',
      expect: 'contradicted',
      note: 'P1, P2: a total loss of engine power.',
      edit: (c) =>
        resentence(c, '[[case:CEN24LA012]]', 'In the Tvap 4 case, an improperly installed supplemental ignition system caused a partial loss of engine power [[case:CEN24LA012]].'),
    },
    {
      id: 'found',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P5: the error was not detected during the condition inspection; nothing says the inspection found the loose bolt.',
      edit: (c) => {
        caseOf(c, 'WPR18LA250').why =
          'The throttle linkage detached from the throttle arm of the fuel injection servo because its bolt was insufficiently tightened and secured; the condition inspection had noted the loose bolt but it was not fixed, resulting in a total loss of engine power.';
      },
    },
  ],
  mixed: [
    { id: 'mix-zero-partial', errors: ['zero', 'partial'], note: 'A zero interval and a wrong value, in two cases.' },
    { id: 'mix-before-mechanic', errors: ['before', 'mechanic'], note: 'The maintenance put after the event and a wrong actor, in two cases.' },
  ],
};

const HOMEBUILT_CLAIMS: ClaimBatch = {
  id: 'holdout16e.homebuilt-engine-claims',
  bundle: 'q16e-homebuilt-engine',
  cases: ['CEN24LA012', 'WPR14LA323', 'WPR18LA250', 'CEN16LA167', 'WPR10LA483', 'WPR15LA067'],
  readings: SHORTLY,
  claims: [
    yes('wpr14.first', 'timing', 'WPR14LA323', ['P3'], timing(SERVO_323, { relation: 'flight_ordinal', value: 1 }), 'P3: the first flight since the installation.', { provenance: 'constructed' }),
    yes('wpr14.ff', 'criterion', 'WPR14LA323', ['P3'], firstFlight(SERVO_323), 'P3 states the first flight (FF-O).', { provenance: 'constructed', criterion: 'first_flight_only', decision: 'matches' }),
    no(
      'wpr14.ffunsettled',
      'criterion',
      'WPR14LA323',
      'all',
      firstFlightUnsettled(SERVO_323),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P3 settles it: the first flight since the installation (FF-O).',
      { critical: true, absence: true, criterion: 'first_flight_only', decision: 'unknown' },
    ),
    no(
      'wpr14.window',
      'criterion',
      'WPR14LA323',
      ['P3'],
      within(SERVO_323, 30, 10),
      'timing',
      'first_flight_window',
      'not_established',
      'The first flight settles no calendar days or flight hours (G6); no passage gives either.',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'wpr14.zero',
      'timing',
      'WPR14LA323',
      ['P3'],
      timing(SERVO_323, { relation: 'calendar_days', value: 0, bound: 'exact' }),
      'timing',
      'zero_interval',
      'not_established',
      'P3: the first flight since the installation; no passage says it was the same day.',
      { critical: true },
    ),
    yes('wpr18.fh', 'timing', 'WPR18LA250', ['P5'], timing(ENGINE_250, { relation: 'flight_hours', value: 91, bound: 'about' }), 'P5: about 91 flight hours before the accident flight.', {
      provenance: 'constructed',
    }),
    no(
      'wpr18.exact',
      'timing',
      'WPR18LA250',
      ['P5'],
      timing(ENGINE_250, { relation: 'flight_hours', value: 91, bound: 'exact' }),
      'timing',
      'approximate_exact',
      'not_established',
      'P5: about 91 flight hours, not exactly 91.',
    ),
    no(
      'wpr18.after',
      'summary',
      'WPR18LA250',
      ['P5', 'P6'],
      'In the Glasair Super IIS case, the engine was installed about 91 flight hours after the accident flight (WPR18LA250).',
      'timing',
      'before_after',
      'contradicted',
      'P5: about 91 flight hours before the accident flight.',
      { critical: true },
    ),
    yes(
      'wpr18.unsettled',
      'criterion',
      'WPR18LA250',
      'all',
      windowUnsettled(ENGINE_250, 30, 10),
      'About 91 flight hours settle nothing, and 5 months are not a number of calendar days (AP-1).',
      { provenance: 'constructed', absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    yes('wpr18.unrelated', 'why', 'WPR18LA250', ['P5'], 'The investigation determined that the electrical system malfunction was unrelated to the loss of engine power.', 'P5.'),
    no(
      'wpr18.electrical',
      'why',
      'WPR18LA250',
      ['P5'],
      'Investigators found that the electrical system malfunction led to the loss of engine power.',
      'contradiction',
      'wrong_cause',
      'contradicted',
      'P5: the electrical system malfunction was unrelated to the loss of engine power.',
    ),
    yes(
      'wpr15.morning',
      'why',
      'WPR15LA067',
      ['P11'],
      'Earlier on the morning of the accident, the pilot had made the first flight since performing maintenance to resolve a longstanding engine surging problem, and the engine operated normally during that flight.',
      'P11, the pilot’s report.',
    ),
    no(
      'wpr15.first',
      'summary',
      'WPR15LA067',
      ['P11', 'P12'],
      'In the amateur-built Beaver case, the engine lost partial power on the first flight after the maintenance to resolve the engine surging (WPR15LA067).',
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P11: the first flight after the maintenance was earlier that morning, and the engine operated normally then.',
      { critical: true },
    ),
    no(
      'wpr15.ff',
      'criterion',
      'WPR15LA067',
      ['P11'],
      firstFlight(SURGING_067),
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P11: the first flight after the maintenance came earlier that morning.',
      { critical: true, criterion: 'first_flight_only', decision: 'matches' },
    ),
    yes('cen24.fuse', 'why', 'CEN24LA012', ['P1'], 'One of the fuses was blown, which disabled one of the two units of the supplemental ignition system.', 'P1.'),
    no(
      'cen16.before',
      'why',
      'CEN16LA167',
      ['P7'],
      'Before departure, the pilot found a loose connection at the generator regulator output.',
      'contradiction',
      'negation',
      'contradicted',
      'P7: he found it in a postaccident examination; he detected no electrical anomalies before departure.',
    ),
    yes(
      'wpr10.vibration',
      'why',
      'WPR10LA483',
      ['P9'],
      'The owner/pilot reported excessive engine vibration and kickback during prior startups and had not performed any remedial measures before the accident flight.',
      'P9.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16e-fuel-quantity: ERA12FA023 (P1, P2), ERA20LA297 (P3), CEN13FA075 (P4, P5),
// ERA23LA053 (P6, P7), WPR19LA243 (P8, P9, P10), WPR22LA308 (P11, P12).

const INSPECTION_023 = 'the 600-hour and annual inspection';
const FUEL_075 = 'the recent fuel system maintenance';
const MAINT_308 = 'the recent maintenance';

const FUEL_QUANTITY: Composition = {
  outcome: 'answer',
  summary: [
    'In the Socata TBM 700 case, a shielded cable of the right fuel gauge harness was not correctly soldered when the airplane was manufactured, which made the right gauge read high, and the engine lost all power from fuel starvation the day after a 600-hour and annual inspection was signed off [[case:ERA12FA023]].',
    'In the Hughes 369 case, improper maintenance of the fuel system resulted in erroneous fuel gauge indications, and together with the pilot’s inadequate fuel management it led to fuel exhaustion during a long-line hover [[case:CEN13FA075]].',
    'In the Cessna 195 case, the mechanic had removed the fuel from the wings during maintenance, and the pilot, relying on erroneous fuel gauges and the mechanic’s statement that he had added the fuel back, did not verify the fuel quantity before departure [[case:WPR22LA308]].',
  ].join(' '),
  groups: [
    { kind: 'causal', caseNumbers: ['ERA12FA023', 'CEN13FA075'] },
    { kind: 'defect_not_causal', caseNumbers: ['WPR22LA308'] },
  ],
  cases: [
    {
      ntsbNo: 'ERA12FA023',
      why: 'A shielded cable of the right fuel gauge harness was not correctly soldered when the airplane was manufactured, which gave erroneously high right-tank readings, and the engine lost all power from fuel starvation on final approach.',
      quotes: [
        q(
          'P1',
          'Examination and testing of the right fuel gauge harness revealed that a high impedance shielded cable was not correctly soldered to the shielding braid when the airplane was manufactured, which resulted in erroneous high readings of the fuel quantity in the right tank.',
        ),
        q('P2', 'The pilot’s failure to terminate the flight after observing multiple conflicting errors associated with the inaccurate right fuel quantity indication.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
      symptom: { value: 'total_power_loss', passageIds: ['P1'] },
      chronology: { maintenance: INSPECTION_023, facts: [{ anchor: 'relevant_maintenance', relation: 'previous_day', passageIds: ['P1'] }] },
    },
    {
      ntsbNo: 'CEN13FA075',
      why: 'Improper maintenance of the helicopter’s fuel system resulted in erroneous fuel gauge indications, and with the pilot’s inadequate fuel management the helicopter ran out of fuel during a long-line hover.',
      quotes: [
        q(
          'P5',
          'The improper maintenance of the helicopter fuel system that resulted in erroneous fuel gauge indications and the pilot’s inadequate fuel management, both of which resulted in fuel exhaustion during a long-line hover.',
        ),
        q('P4', 'Postaccident examination of the helicopter revealed no usable fuel on board, and fuel quantities between the fuel tank and engine were consistent with fuel exhaustion.'),
      ],
      evidencePassageIds: ['P4', 'P5'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P5'] },
      chronology: { maintenance: FUEL_075, facts: [] },
    },
    {
      ntsbNo: 'WPR22LA308',
      why: 'After maintenance during which the mechanic removed the fuel from the wings, the pilot relied on erroneous fuel gauges and on the mechanic’s word without checking the fuel visually, and the engine stopped from fuel exhaustion after departure.',
      quotes: [
        q('P12', 'The pilot’s failure to verify the fuel quantity prior to departure, which led to a loss of engine power due to fuel exhaustion.'),
        q('P11', 'The pilot checked the quantity on the fuel gauges, but they were erroneous.'),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P11', 'P12'] },
      chronology: { maintenance: MAINT_308, facts: [] },
    },
  ],
  gaps: [{ ntsbNo: 'WPR19LA243', note: 'The supplied passages attribute the fuel starvation to the pilot’s inflight fuel management and do not mention maintenance.', passageIds: ['P8', 'P9', 'P10'] }],
};

const T9: BriefSpec = {
  id: 'holdout16e.fuel-quantity',
  bundle: 'q16e-fuel-quantity',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: FUEL_QUANTITY,
  note: 'ERA12FA023 matches by TW-C (signed off the day before); the others state no time from their maintenance.',
  errors: [
    {
      id: 'hours24',
      family: 'timing',
      mutation: 'previous_day_hours',
      expect: 'not_established',
      critical: true,
      note: 'P1: the inspection was signed off the day before, one calendar-date boundary, not a number of hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA12FA023]]',
          'In the Socata TBM 700 case, a shielded cable of the right fuel gauge harness was not correctly soldered when the airplane was manufactured, which made the right gauge read high, and the engine lost all power from fuel starvation less than 24 hours after a 600-hour and annual inspection was signed off [[case:ERA12FA023]].',
        ),
    },
    {
      id: 'before',
      family: 'timing',
      mutation: 'before_after',
      expect: 'contradicted',
      critical: true,
      note: 'P1: the inspection was signed off the day before the accident, not after it.',
      edit: (c) => {
        caseOf(c, 'ERA12FA023').why =
          'A shielded cable of the right fuel gauge harness was not correctly soldered when the airplane was manufactured, which gave erroneously high right-tank readings, and the engine lost all power from fuel starvation the day before the 600-hour and annual inspection was signed off.';
      },
    },
    {
      id: 'pilotfuel',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P11: the mechanic removed the fuel from the wings during the maintenance, not the pilot.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR22LA308]]',
          'In the Cessna 195 case, the pilot had removed the fuel from the wings during maintenance, and then, relying on erroneous fuel gauges and the mechanic’s statement that he had added the fuel back, did not verify the fuel quantity before departure [[case:WPR22LA308]].',
        ),
    },
    {
      id: 'speaker',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P4 is the investigators’ examination, not the pilot’s account.',
      edit: (c) => {
        caseOf(c, 'CEN13FA075').quotes[1]!.speaker = 'pilot';
      },
    },
    {
      id: 'vacuum',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P4: a vacuum check of the fuel system was not performed after it had been opened.',
      edit: (c) => {
        caseOf(c, 'CEN13FA075').why =
          'Improper maintenance of the helicopter’s fuel system, although followed by the required vacuum check, resulted in erroneous fuel gauge indications, and with the pilot’s inadequate fuel management the helicopter ran out of fuel during a long-line hover.';
      },
    },
    {
      id: 'damaged',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P11: the gauges were erroneous; nothing says the maintenance damaged them.',
      edit: (c) => {
        caseOf(c, 'WPR22LA308').why =
          'After maintenance during which the mechanic removed the fuel from the wings and damaged the fuel gauges, the pilot relied on the erroneous gauges and on the mechanic’s word without checking the fuel visually, and the engine stopped from fuel exhaustion.';
      },
    },
  ],
  mixed: [
    { id: 'mix-hours24-speaker', errors: ['hours24', 'speaker'], note: 'The previous day given as hours and a wrong speaker, in two cases.' },
    { id: 'mix-pilotfuel-vacuum', errors: ['pilotfuel', 'vacuum'], note: 'A wrong actor and a negation, in two cases.' },
  ],
};

const FUEL_QUANTITY_CLAIMS: ClaimBatch = {
  id: 'holdout16e.fuel-quantity-claims',
  bundle: 'q16e-fuel-quantity',
  cases: ['ERA12FA023', 'ERA20LA297', 'CEN13FA075', 'ERA23LA053', 'WPR19LA243', 'WPR22LA308'],
  readings: SHORTLY,
  claims: [
    yes('era12.prev', 'timing', 'ERA12FA023', ['P1'], timing(INSPECTION_023, { relation: 'previous_day' }), 'P1: signed off the day before.', { provenance: 'constructed' }),
    yes('era12.within', 'criterion', 'ERA12FA023', ['P1'], within(INSPECTION_023, 30, 10), 'The day before is within 30 calendar days (TW-C).', {
      provenance: 'constructed',
      criterion: 'timing_window',
      decision: 'matches',
    }),
    no(
      'era12.24h',
      'summary',
      'ERA12FA023',
      ['P1', 'P2'],
      'In the Socata TBM 700 case, the 600-hour and annual inspection was signed off within 24 hours of the accident (ERA12FA023).',
      'timing',
      'previous_day_hours',
      'not_established',
      '"The day before" is one calendar-date boundary, not a number of hours.',
      { critical: true },
    ),
    no(
      'era12.fh',
      'criterion',
      'ERA12FA023',
      ['P1'],
      within(INSPECTION_023, null, 10),
      'timing',
      'previous_day_hours',
      'not_established',
      'The previous day settles calendar days only, never flight hours (TW-C); no passage gives flight hours.',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'era12.after',
      'summary',
      'ERA12FA023',
      ['P1', 'P2'],
      'In the Socata TBM 700 case, the 600-hour and annual inspection was signed off the day after the accident (ERA12FA023).',
      'timing',
      'before_after',
      'contradicted',
      'P1: signed off the day before the accident.',
      { critical: true },
    ),
    yes('era12.drained', 'why', 'ERA12FA023', ['P1'], 'During the inspection, 41 gallons was displayed for the right tank, yet 70 gallons was drained.', 'P1.'),
    no(
      'era12.harness',
      'why',
      'ERA12FA023',
      ['P1'],
      'Maintenance personnel traced the changing right-tank fuel indications to a faulty gauge harness during the inspection.',
      'contradiction',
      'wrong_cause',
      'contradicted',
      'P1: they incorrectly attributed the difference to fuel migration.',
    ),
    yes('cen13.vacuum', 'why', 'CEN13FA075', ['P4'], 'A vacuum check of the fuel system was not performed after the fuel system had been opened.', 'P4.'),
    no(
      'cen13.annunciator',
      'why',
      'CEN13FA075',
      ['P4'],
      'The low fuel quantity annunciator worked, but the pilot did not respond to it.',
      'contradiction',
      'negation',
      'contradicted',
      'P4: the low fuel quantity annunciator was inoperative.',
    ),
    yes(
      'era23.flights',
      'why',
      'ERA23LA053',
      ['P6'],
      'According to the previous owner, since filling the right fuel tank more than 1 month earlier, he had flown the airplane on two separate flights totaling 1.3 hours.',
      'P6.',
    ),
    no(
      'era23.single',
      'why',
      'ERA23LA053',
      ['P6'],
      'According to the previous owner, he flew the airplane on a single 1.3-hour flight after filling the right fuel tank.',
      'contradiction',
      'wrong_value',
      'contradicted',
      'P6: two separate flights totaling 1.3 hours.',
    ),
    yes('wpr19.gauges', 'why', 'WPR19LA243', ['P8'], 'Postaccident examination revealed that both fuel tank gauges indicated erroneous fuel quantities.', 'P8.'),
    no(
      'wpr19.cause',
      'why',
      'WPR19LA243',
      ['P10'],
      'Investigators attributed the loss of engine power to the erroneous fuel gauges.',
      'contradiction',
      'wrong_cause',
      'contradicted',
      'P10: the pilot’s improper inflight fuel management.',
    ),
    yes('era20.pc', 'attribution', 'ERA20LA297', ['P3'], said('investigators', 'A total loss of engine power due to fuel exhaustion.'), 'P3, the probable cause, first sentence.'),
    no(
      'era20.certain',
      'why',
      'ERA20LA297',
      ['P3'],
      'Investigators determined that a fatigue-fractured electrical wire in the fuel transmitter caused an inaccurate fuel quantity indication.',
      'unsupported_addition',
      'certainty_overstatement',
      'not_established',
      'P3: the fractured wire, in the tank unit or the fuel transmitter, likely resulted in an inaccurate indication.',
    ),
    yes('wpr22.word', 'why', 'WPR22LA308', ['P11'], 'The pilot stated that the mechanic told him he had added the fuel back in the wings after the maintenance.', 'P11.'),
  ],
};

export const V3_HOLDOUT_BRIEFS: readonly BriefSpec[] = [
  T1,
  T2,
  T3,
  variant(T3, 'holdout16e.fuel-cap-first', FIRST_ONLY, 'First flight only (pinned): WPR14FA135 matches by FF-O; the others state no flight after their maintenance.'),
  T4,
  variant(T4, 'holdout16e.injection-first', FIRST_ONLY, 'First flight only (pinned): CEN24LA378 matches by FF-O; about 2.1 operating hours settle no flight (ANC16LA010 unknown).'),
  T5,
  T6,
  variant(T6, 'holdout16e.gascolator-day', DAY_BEFORE, 'Within 1 calendar day (pinned): ERA23LA144 matches by TW-C; the first flight and about 60 operating hours settle no calendar days.'),
  T7,
  T8,
  T9,
  variant(T9, 'holdout16e.fuel-quantity-day', DAY_BEFORE, 'Within 1 calendar day (pinned): ERA12FA023 matches by TW-C; the others state no time from their maintenance.'),
];
export const V3_HOLDOUT_CLAIM_BATCHES: readonly ClaimBatch[] = [
  TURBO_CLAIMS,
  CRANK_CLAIMS,
  FUEL_CAP_CLAIMS,
  INJECTION_CLAIMS,
  INDUCTION_CLAIMS,
  GASCOLATOR_CLAIMS,
  ROTOR_CLAIMS,
  HOMEBUILT_CLAIMS,
  FUEL_QUANTITY_CLAIMS,
];

export { DAY_BEFORE, FIRST_ONLY, SHORTLY, firstFlightUnsettled, variant, window };
