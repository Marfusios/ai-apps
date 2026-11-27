/**
 * Task 16d held-out set (dataset v2, held-out split): nine real retrieval bundles
 * (`QUESTIONS_16D`; the oil-line bundle is not used because it shares a case with 16c) whose
 * cases are in neither 16c split, built and label-frozen before any 16d checker output was
 * seen. Each bundle brings one brief as compose.v7 would write it (standalone case
 * sentences, no restated absences, operating hours apart from flight hours, other anchors
 * kept), model-reviewed claim by claim against every supplied passage of its cases and
 * against the passages each claim cites (a why line is checked against its quotes'
 * passages); one-error variants over the four families; two mixed-error variants; reading
 * variants where the timing allows; and a claim batch of controls and mutations. The
 * critical timing mutations (`HELDOUT_V2.criticalTimingMutations`, 16c review M8) are each
 * in at least two bundles.
 *
 * Readings are chosen so that no decision rests on the case header's date: a passage date
 * and the header date are never combined into an interval (the header supports only the
 * case's identity), so readings whose "do not settle" claim a date difference could
 * dispute are left out. Labels that follow a stated rule rather than likelihood (the first
 * flight, "about N" and operating hours settle no window: G6, AP-1, TW-H) say so in their
 * notes; the check prompt states the same rules.
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
// q16d-magneto: WPR12LA092 (P1, P2), WPR24LA060 (P3, P4), CEN15LA233 (P5, P6),
// WPR09FA398 (P7, P8), WPR15LA262 (P9, P10), CEN22LA344 (P11, P12).

const MAGNETO: Composition = {
  outcome: 'answer',
  summary: [
    "In the Mooney M20J case, investigators found that improper spacing of the magneto's breaker point contact assemblies led to a loss of engine ignition during cruise flight and a total loss of engine power [[case:WPR24LA060]].",
    'In the Cessna T206H case, maintenance personnel used a drill bit instead of a timing pin when installing the magneto, and a section of the bit that broke off ultimately led to the magneto failure [[case:CEN15LA233]].',
    "In the Cessna 152 case, investigators found that the left magneto failed because its drive gear was improperly assembled during installation, and that inadequate maintenance left the right magneto's internal timing improper, resulting in a partial loss of engine power [[case:WPR09FA398]].",
    "In the Vans RV-7A case, investigators found that an improper overhaul of the right magneto eliminated the ignition system's redundancy, so the engine lost power when the left magneto failed during aerobatic flight maneuvers [[case:WPR15LA262]].",
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['WPR24LA060', 'CEN15LA233', 'WPR09FA398', 'WPR15LA262'] }],
  cases: [
    {
      ntsbNo: 'WPR24LA060',
      why: "Investigators attributed a total loss of engine power during cruise flight to improper spacing of the magneto's breaker point contact assemblies.",
      quotes: [
        q('P4', 'Improper spacing of the magneto’s breaker point contact assemblies, which led to a loss of engine ignition during cruise flight and resulted in a total loss of engine power.'),
        q('P3', 'A review of the airplane’s maintenance logs showed that during the last annual inspection the magneto-to-engine timing was checked.'),
      ],
      evidencePassageIds: ['P4'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P3'] },
      symptom: { value: 'total_power_loss', passageIds: ['P4'] },
      chronology: { maintenance: 'the last annual inspection', facts: [] },
    },
    {
      ntsbNo: 'CEN15LA233',
      why: 'Maintenance personnel used a drill bit instead of a timing pin when installing the magneto; a section of the bit broke off and ultimately led to the magneto failure and the loss of engine power.',
      // Not P5's "A section of a drill bit … was among the pieces found inside the magneto": the case has an original and a replacement magneto, so "the magneto" needs its context.
      quotes: [
        q(
          'P6',
          "Contributing to the accident was maintenance personnel's improper use of a drill bit instead of a timing pin during magneto installation, which resulted in a section of the drill bit breaking off and ultimately to the magneto failure.",
        ),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      chronology: { maintenance: 'the magneto installation', facts: [] },
    },
    {
      ntsbNo: 'WPR09FA398',
      why: "Investigators found that the left magneto failed after its drive gear was improperly assembled during installation, and that the right magneto's improper internal timing from inadequate maintenance contributed to a partial loss of engine power.",
      quotes: [
        q(
          'P8',
          'Also causal was the failure of the left magneto due to improper assembly of the drive gear during installation on the engine, and the improper internal timing of the right magneto due to inadequate maintenance that reduced the ability of the magneto to produce an adequate spark, resulting in a partial loss of engine power.',
        ),
      ],
      evidencePassageIds: ['P8'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P8'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P8'] },
      chronology: { maintenance: 'the magneto drive gear installation', facts: [] },
    },
    {
      ntsbNo: 'WPR15LA262',
      why: "An improper overhaul of the right magneto eliminated the ignition system's redundancy, and the engine lost power when the left magneto failed during aerobatic flight maneuvers.",
      quotes: [q('P10', 'Improper overhaul of the right magneto, which eliminated system redundancy, and resulted in a loss of engine power when the left magneto failed during aerobatic flight maneuvers.')],
      evidencePassageIds: ['P10'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P10'] },
      chronology: { maintenance: 'the overhaul of the right magneto', facts: [] },
    },
  ],
  gaps: [
    {
      ntsbNo: 'WPR12LA092',
      note: 'The supplied passages say the magneto was last overhauled on July 18, 1989, and mention no magneto work after that before the accident.',
      passageIds: ['P1'],
    },
  ],
};

const H1: BriefSpec = {
  id: 'holdout16d.magneto',
  bundle: 'q16d-magneto',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: MAGNETO,
  note: 'No case states a time from its maintenance: every timing decision is unknown.',
  errors: [
    {
      id: 'actor',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P6: maintenance personnel used the drill bit, not the pilot.',
      edit: (c) => {
        caseOf(c, 'CEN15LA233').why =
          'The pilot used a drill bit instead of a timing pin when installing the magneto; a section of the bit broke off and ultimately led to the magneto failure and the loss of engine power.';
      },
    },
    {
      id: 'hobbs',
      family: 'timing',
      mutation: 'fabricated_interval',
      expect: 'not_established',
      critical: true,
      note: 'P5: the magneto was replaced at a Hobbs time of 98.0 hours; no passage gives the time from that replacement to the accident.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN15LA233]]',
          'In the Cessna T206H case, the magneto failed 98 flight hours after maintenance personnel installed it using a drill bit instead of a timing pin [[case:CEN15LA233]].',
        ),
    },
    {
      id: 'total',
      family: 'contradiction',
      mutation: 'wrong_value',
      expect: 'contradicted',
      note: 'P8: a partial loss of engine power.',
      edit: (c) => {
        caseOf(c, 'WPR09FA398').symptom = { value: 'total_power_loss', passageIds: ['P8'] };
      },
    },
    {
      id: 'annual',
      family: 'unsupported_addition',
      mutation: 'causal_overstatement',
      expect: 'not_established',
      note: 'P3: during the last annual inspection the timing was checked and the service history could not be determined; nothing says the inspection misadjusted the contacts.',
      edit: (c) => {
        caseOf(c, 'WPR24LA060').why =
          "During the last annual inspection, the magneto's breaker point contact assemblies were spaced improperly, which led to a total loss of engine power during cruise flight.";
      },
    },
    {
      id: 'subject',
      family: 'attribution',
      mutation: 'quote_context_loss',
      expect: 'not_established',
      note: 'The excerpt drops "Improper overhaul of the right magneto": it no longer says what eliminated the redundancy.',
      edit: (c) => {
        caseOf(c, 'WPR15LA262').quotes[0] = q('P10', 'which eliminated system redundancy, and resulted in a loss of engine power when the left magneto failed during aerobatic flight maneuvers.');
      },
    },
  ],
  mixed: [
    { id: 'mix-actor-hobbs', errors: ['actor', 'hobbs'], note: 'Two errors about one case: the wrong actor in its why line and a fabricated interval in its summary sentence.' },
    { id: 'mix-total-subject', errors: ['total', 'subject'], note: 'A wrong symptom in one case and a context-losing excerpt in another.' },
  ],
};

// ---------------------------------------------------------------------------
// q16d-carburetor: WPR18LA196 (P1, P2), ERA24LA380 (P3, P4, P5), CEN24LA313 (P6),
// ERA09LA221 (P7), ERA24LA257 (P8, P9), WPR19LA102 (P10, P11, P12).

const CARBURETOR: Composition = {
  outcome: 'answer',
  summary: [
    'In the Cessna 172 case, the engine lost partial power in the climb after takeoff 37.8 flight hours after an annual inspection, and investigators attributed the loss to an improperly maintained carburetor [[case:WPR19LA102]].',
    "In the Piper PA32 case, a carburetor that had been in service for more than 43 years as an on-condition item had undetected worn internal parts that restricted the float's movement, resulting in fuel starvation [[case:ERA24LA380]].",
    'In the Grumman G164 case, investigators attributed a partial loss of engine power to the improper overhaul of the carburetor together with a malfunction of the left magneto [[case:CEN24LA313]].',
    'In the Piper PA28 case, corrosion and loose corrosion debris in the carburetor contaminated the fuel and caused a partial loss of engine power during initial climb [[case:ERA24LA257]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['WPR19LA102', 'ERA24LA380', 'CEN24LA313', 'ERA24LA257'] }],
  cases: [
    {
      ntsbNo: 'WPR19LA102',
      why: 'Investigators attributed a partial loss of engine power in the climb after takeoff to an improperly maintained carburetor.',
      quotes: [
        q('P12', 'The partial loss of engine power due to an improperly maintained carburetor.'),
        q('P11', 'Examination of the carburetor revealed multiple maintenance-related discrepancies, including an incorrectly adjusted float and a loose carburetor bowl.'),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P11'] },
      chronology: {
        maintenance: 'the annual inspection on November 13, 2018',
        facts: [{ anchor: 'relevant_maintenance', relation: 'flight_hours', value: 37.8, bound: 'exact', passageIds: ['P10'] }],
      },
    },
    {
      ntsbNo: 'ERA24LA380',
      why: 'Undetected worn internal parts of a carburetor that had been in service for more than 43 years restricted the float, which resulted in fuel starvation and a loss of engine power during takeoff.',
      quotes: [
        q('P5', 'The undetected worn internal parts of the on-condition carburetor, which restricted movement of the float, resulting in fuel starvation.'),
        q(
          'P4',
          'Although the carburetor had been in service for more than 43 years, it was considered an on-condition item for Part 91 operators and, as such, was not subject to a set overhaul period based on calendar or operational time.',
        ),
      ],
      evidencePassageIds: ['P4', 'P5'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P3'] },
      chronology: { maintenance: 'the installation of the zero-time carburetor on April 26, 1981', facts: [] },
    },
    {
      ntsbNo: 'CEN24LA313',
      why: 'Investigators attributed a partial loss of engine power to the improper overhaul of the carburetor and a malfunction of the left magneto.',
      quotes: [q('P6', 'The improper overhaul of the carburetor and the malfunction of left magneto which resulted in a partial loss of engine power.')],
      evidencePassageIds: ['P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P6'] },
      chronology: { maintenance: 'the carburetor overhaul', facts: [] },
    },
    {
      ntsbNo: 'ERA24LA257',
      why: 'Corrosion and loose corrosion debris in the carburetor contaminated the fuel and restricted fuel flow, causing a partial loss of engine power during initial climb.',
      quotes: [
        q('P9', 'A partial loss of engine power during initial climb due to fuel contamination that resulted from corrosion and loose corrosion debris in the carburetor, which restricted fuel flow to the engine.'),
      ],
      evidencePassageIds: ['P9'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P8'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P9'] },
      chronology: { maintenance: 'the last annual inspection on March 1, 2024', facts: [] },
    },
  ],
  gaps: [{ ntsbNo: 'ERA09LA221', note: 'The supplied passage gives only the probable cause and does not say when the carburetor was mounted or by whom.', passageIds: ['P7'] }],
};

const FIFTY_HOURS = window(null, 50, true);

const H2: BriefSpec = {
  id: 'holdout16d.carburetor',
  bundle: 'q16d-carburetor',
  mechanicalCause: true,
  readings: FIFTY_HOURS,
  composition: CARBURETOR,
  note: 'Within 50 flight hours (pinned): WPR19LA102 matches by TW-N (37.8 flight hours); the others state no flight hours.',
  errors: [
    {
      id: 'days',
      family: 'timing',
      mutation: 'unit_swap',
      expect: 'not_established',
      note: 'P10: 37.8 flight hours, not days.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR19LA102]]',
          'In the Cessna 172 case, the engine lost partial power in the climb after takeoff 37.8 days after an annual inspection, and investigators attributed the loss to an improperly maintained carburetor [[case:WPR19LA102]].',
        ),
    },
    {
      id: 'before',
      family: 'timing',
      mutation: 'before_after',
      expect: 'contradicted',
      critical: true,
      note: 'P10: the annual inspection came 37.8 flight hours before the accident, not after the power loss.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR19LA102]]',
          'In the Cessna 172 case, an annual inspection was done 37.8 flight hours after the engine lost partial power in the climb after takeoff, and investigators attributed the loss to an improperly maintained carburetor [[case:WPR19LA102]].',
        ),
    },
    {
      id: 'speaker',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P4 is the investigators’ analysis, not the pilot’s account.',
      edit: (c) => {
        caseOf(c, 'ERA24LA380').quotes[1]!.speaker = 'pilot';
      },
    },
    {
      id: 'negation',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P6: the improper overhaul of the carburetor is part of the probable cause.',
      edit: (c) => {
        caseOf(c, 'CEN24LA313').why = 'Investigators attributed a partial loss of engine power to a malfunction of the left magneto and found that the carburetor had been overhauled properly.';
      },
    },
    {
      id: 'missed',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P8 dates the last annual inspection; nothing says it missed the corrosion.',
      edit: (c) => {
        caseOf(c, 'ERA24LA257').why =
          'Corrosion debris that the last annual inspection missed contaminated the fuel in the carburetor and restricted fuel flow, causing a partial loss of engine power during initial climb.';
      },
    },
  ],
  mixed: [
    { id: 'mix-days-negation', errors: ['days', 'negation'], note: 'A unit swap and a negation, in two cases.' },
    { id: 'mix-speaker-missed', errors: ['speaker', 'missed'], note: 'A wrong speaker and an added detail, in two cases.' },
  ],
};

const MAGNETO_REPAIR = 'the magneto inspection and maintenance at the repair facility';

const MAGNETO_CLAIMS: ClaimBatch = {
  id: 'holdout16d.magneto-claims',
  bundle: 'q16d-magneto',
  cases: ['WPR12LA092', 'WPR24LA060', 'CEN15LA233', 'WPR09FA398', 'WPR15LA262', 'CEN22LA344'],
  readings: SHORTLY,
  claims: [
    yes(
      'wpr15.uneven',
      'why',
      'WPR15LA262',
      ['P9'],
      'About 20 flight hours before the accident, the pilot was experiencing uneven engine operation in backup mode, and he then sent the magnetos to a repair facility for a 500-hour inspection and maintenance.',
      'P9, the pilot’s report.',
    ),
    no(
      'wpr15.anchor',
      'timing',
      'WPR15LA262',
      ['P9'],
      timing(MAGNETO_REPAIR, { relation: 'flight_hours', value: 20, bound: 'about' }),
      'timing',
      'wrong_anchor',
      'not_established',
      'P9: the 20 flight hours are from when the pilot noticed the uneven operation, before he sent the magnetos away; no time from the maintenance is given.',
    ),
    yes('wpr15.reinstalled', 'why', 'WPR15LA262', ['P9'], 'The pilot reinstalled the magnetos and performed the engine-to-magneto timing adjustments with the T-300 timing system.', 'P9.'),
    no(
      'wpr15.shop',
      'why',
      'WPR15LA262',
      ['P9'],
      'The repair facility reinstalled the magnetos on the engine and adjusted the engine-to-magneto timing.',
      'attribution',
      'wrong_actor',
      'contradicted',
      'P9: the pilot reinstalled them and made the timing adjustments.',
    ),
    no(
      'wpr15.circumstances',
      'attribution',
      'WPR15LA262',
      ['P9'],
      said('investigators', 'Under these circumstances, the internal relays de-energize, and the magneto reverts to the fixed ignition timing angle utilizing its contact points and ignition coil.'),
      'attribution',
      'quote_context_loss',
      'not_established',
      'P9: "these circumstances" are described before the supplied text; read alone the excerpt does not say when the relays de-energize.',
      { critical: true },
    ),
    yes(
      'wpr12.hours',
      'why',
      'WPR12LA092',
      ['P1'],
      'The engine maintenance records showed that the magneto was last overhauled on July 18, 1989, and had accumulated 324.65 hours since that overhaul.',
      'P1.',
    ),
    no(
      'wpr12.flight',
      'why',
      'WPR12LA092',
      ['P1'],
      'The magneto had accumulated 324.65 flight hours since its last overhaul on July 18, 1989.',
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P1: 324.65 hours since overhaul, not called flight hours (16c review M4).',
    ),
    no(
      'wpr12.right',
      'why',
      'WPR12LA092',
      ['P1'],
      'In the bench test, the right magneto produced spark on only one post.',
      'contradiction',
      'wrong_value',
      'contradicted',
      'P1: the right magneto produced spark on all posts; the left one on one post.',
    ),
    yes('cen15.hobbs', 'why', 'CEN15LA233', ['P5'], 'The engine’s maintenance records showed that the left magneto had been replaced at a Hobbs time of 98.0 hours.', 'P5.'),
    no(
      'cen15.original',
      'why',
      'CEN15LA233',
      ['P5'],
      'On the bench test machine, the original left magneto failed to produce spark on all terminals.',
      'contradiction',
      'negation',
      'contradicted',
      'P5: the original magneto appeared operational; the replacement magneto on the engine at the time of the accident failed.',
    ),
    no(
      'wpr24.history',
      'why',
      'WPR24LA060',
      ['P3'],
      'The maintenance logs showed that the magneto had been overhauled during the last annual inspection.',
      'unsupported_addition',
      'added_detail',
      'not_established',
      'P3: the magneto-to-engine timing was checked then, and a definitive magneto service history could not be determined.',
    ),
    yes(
      'cen22.tach',
      'why',
      'CEN22LA344',
      ['P11'],
      'The tachometer read 2,876.6 hours at the time of the accident; an invoice dated May 22, 2021, at a tachometer time of 2,876.2 hours, showed that the magneto was removed and replaced for a 500-hour inspection.',
      'P11.',
    ),
    no(
      'cen22.flight',
      'summary',
      'CEN22LA344',
      ['P11', 'P12'],
      'In the Piper PA-32RT-300T case, the engine lost power 0.4 flight hours after the magneto was reinstalled (CEN22LA344).',
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P11 gives tachometer readings, not flight hours; their difference is not a stated flight time (16c review M4).',
    ),
    no(
      'cen22.logbook',
      'why',
      'CEN22LA344',
      ['P11'],
      'The engine logbook recorded the magneto’s removal and installation for its 500-hour inspection.',
      'contradiction',
      'negation',
      'contradicted',
      'P11: there were no corresponding entries in the engine logbook.',
    ),
    yes(
      'cen22.pc',
      'attribution',
      'CEN22LA344',
      ['P12'],
      said('investigators', 'Maintenance personnel’s inadequate maintenance of the magneto, which resulted in a loss of engine ignition, a loss of engine power, and a subsequent forced landing.'),
      'P12, the probable cause, whole.',
    ),
  ],
};

const CARB_ANNUAL_102 = 'the annual inspection on November 13, 2018';

const CARBURETOR_CLAIMS: ClaimBatch = {
  id: 'holdout16d.carburetor-claims',
  bundle: 'q16d-carburetor',
  cases: ['WPR18LA196', 'ERA24LA380', 'CEN24LA313', 'ERA09LA221', 'ERA24LA257', 'WPR19LA102'],
  readings: FIFTY_HOURS,
  claims: [
    yes('wpr19.fh', 'timing', 'WPR19LA102', ['P10'], timing(CARB_ANNUAL_102, { relation: 'flight_hours', value: 37.8, bound: 'exact' }), 'P10: 37.8 flight hours prior to the accident.', {
      provenance: 'constructed',
    }),
    no(
      'wpr19.unsettled',
      'criterion',
      'WPR19LA102',
      'all',
      windowUnsettled(CARB_ANNUAL_102, null, 50),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P10 settles it: 37.8 flight hours are within 50 (TW-N).',
      { critical: true, absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    yes('wpr19.engine', 'why', 'WPR19LA102', ['P10'], 'The engine was last overhauled in January 2000, about 1,587.8 flight hours before the accident.', 'P10.'),
    no(
      'wpr19.carb',
      'why',
      'WPR19LA102',
      ['P10'],
      'The carburetor was overhauled with the engine in January 2000, about 1,587.8 flight hours before the accident.',
      'unsupported_addition',
      'added_detail',
      'not_established',
      'P10: the records did not indicate that the carburetor was overhauled then (and P11’s "at least 19 years" does not rule it out either way).',
    ),
    yes(
      'era24.earlier',
      'why',
      'ERA24LA380',
      ['P4'],
      'The pilot had flown the airplane on two uneventful flights earlier that day before the engine lost power during takeoff on another flight.',
      'P4.',
    ),
    no(
      'era24.first',
      'summary',
      'ERA24LA380',
      ['P3', 'P4', 'P5'],
      'In the Piper PA32 case, the engine lost power during takeoff on the airplane’s first flight of the day (ERA24LA380).',
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P4: two flights earlier that day came first.',
      { critical: true },
    ),
    yes('wpr18.maint', 'maintenance', 'WPR18LA196', ['P2'], MAINTAINED.investigator_attributed, 'P2: a loose primary venturi due to improper maintenance contributed.'),
    no(
      'wpr18.cause',
      'why',
      'WPR18LA196',
      ['P2'],
      'Investigators attributed the accident to the loose primary venturi alone, not to the pilot.',
      'contradiction',
      'wrong_cause',
      'contradicted',
      'P2: the probable cause is the pilot’s failure to maintain airspeed; the loose venturi contributed.',
    ),
    yes('era24b.cleaned', 'why', 'ERA24LA257', ['P8'], 'On October 20, 2021, the carburetor had been removed and its bowl and inlet screen cleaned.', 'P8.'),
    no(
      'era24b.drained',
      'why',
      'ERA24LA257',
      ['P8'],
      'During the last annual inspection, on March 1, 2024, the carburetor bowl was drained and its screen inspected as the service manual requires.',
      'unsupported_addition',
      'added_detail',
      'not_established',
      'P8: the service manual calls for it, but nothing says it was done at the last annual inspection.',
    ),
    yes(
      'cen24.pc',
      'attribution',
      'CEN24LA313',
      ['P6'],
      said('investigators', 'The improper overhaul of the carburetor and the malfunction of left magneto which resulted in a partial loss of engine power.'),
      'P6, the probable cause, whole.',
    ),
    no(
      'cen24.witness',
      'attribution',
      'CEN24LA313',
      ['P6'],
      said('witness', 'The improper overhaul of the carburetor and the malfunction of left magneto which resulted in a partial loss of engine power.'),
      'attribution',
      'wrong_speaker',
      'contradicted',
      'P6 is the probable cause, not a witness’s account.',
    ),
    yes('era09.class', 'classification', 'ERA09LA221', ['P7'], CLASSIFIED.causal, 'P7: the carburetor not secured to its mounting pad caused the partial loss of power.'),
  ],
};

// ---------------------------------------------------------------------------
// q16d-propeller: ERA12IA459 (P1, P2), ERA16LA295 (P3, P4), WPR13LA184 (P5, P6),
// WPR20LA144 (P7, P8), ERA20LA077 (P9, P10), CEN13LA258 (P11, P12).

const PROP_OVERHAUL = 'the most recent overhaul of the propeller blades';
const PROP_GOVERNOR = 'the overhaul of the propeller and governor';

const PROPELLER: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper PA34 case, investigators found that maintenance personnel had not complied with an airworthiness directive for the propeller, and the right propeller hub failed from fatigue [[case:ERA16LA295]].',
    'In the Beech A36TC case, investigators attributed the accident to an improper overhaul of the propeller that resulted in the installation of an incorrect actuating pin, which later failed from fatigue [[case:WPR13LA184]].',
    'In the Velocity Elite RG case, the propeller pitch change electric motor failed and left the propeller at an improper setting for takeoff, and investigators also found the maintenance and inspection of the propeller system inadequate [[case:ERA20LA077]].',
    'In the Socata TB10 case, the tip of a propeller blade separated in flight from a fatigue fracture; the blades had been overhauled twice in the 3 years before the incident, most recently 18 months before it [[case:ERA12IA459]].',
    'In the Mooney M20J case, the propeller and its governor had been overhauled about 1.5 hours before the accident flight, and the engine lost all power from oil starvation for reasons investigators could not determine [[case:WPR20LA144]].',
    'In the Cessna 182T case, an overhauled propeller had been installed on April 17, 2013, and investigators could not determine why propeller control was lost, as postaccident examinations revealed no anomalies that would have precluded normal operation [[case:CEN13LA258]].',
  ].join(' '),
  groups: [
    { kind: 'causal', caseNumbers: ['ERA16LA295', 'WPR13LA184', 'ERA20LA077', 'ERA12IA459', 'WPR20LA144'] },
    { kind: 'no_fault', caseNumbers: ['CEN13LA258'] },
  ],
  cases: [
    {
      ntsbNo: 'ERA16LA295',
      why: 'Maintenance personnel did not comply with an airworthiness directive that required repetitive eddy current inspections around the lubrication holes of the propeller hub blade sockets, and the right propeller hub failed from a fatigue fracture along a grease-fitting hole.',
      // Not P3's "Metallurgical examination of the propeller hub revealed …": on a twin, "the propeller hub" needs the sentence before it to say which.
      quotes: [
        q('P4', 'Maintenance personnel’s failure to comply with an airworthiness directive for the propeller, which resulted in a propeller hub failure due to fatigue.'),
        q('P3', 'The right propeller had been overhauled about 14 months before the accident and had accrued about 440 hours at the time of the accident.'),
      ],
      evidencePassageIds: ['P3', 'P4'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P4'] },
      // "About 14 months" is not a number of calendar days, and whether the 440 hours are since the overhaul is not certain: no fact.
      chronology: { maintenance: 'the overhaul of the right propeller', facts: [] },
    },
    {
      ntsbNo: 'WPR13LA184',
      why: 'An improper overhaul of the propeller resulted in the installation of an incorrect actuating pin and deformation of the ferrule hole, which led to the pin’s fatigue failure; multiple owners and maintenance technicians had not complied with the manufacturer’s recommended overhaul interval.',
      quotes: [
        q('P6', 'The improper overhaul of the propeller, which resulted in the installation of an incorrect propeller actuating pin and deformation of the ferrule hole and led to the pin’s fatigue failure.'),
        q('P5', 'The most recent airplane annual inspection, and propeller 100-hour inspection, was completed in October 2011.'),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      chronology: { maintenance: 'the improper overhaul of the propeller', facts: [] },
    },
    {
      ntsbNo: 'ERA20LA077',
      why: 'The propeller pitch change motor failed and left the propeller at an improper setting for takeoff, leading to a runway overrun; the propeller system’s maintenance and inspection were inadequate, and the pilot did not follow the manufacturer’s pretakeoff guidance.',
      quotes: [q('P10', 'A failure of the propeller pitch change electric motor, which resulted in an improper setting for takeoff and a subsequent runway overrun.')],
      evidencePassageIds: ['P9', 'P10'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P10'] },
      chronology: { maintenance: 'the maintenance and inspection of the propeller system', facts: [] },
    },
    {
      ntsbNo: 'ERA12IA459',
      why: 'The tip of one propeller blade separated during departure because of a fatigue fracture; the blades had been overhauled twice in the 3 years before the incident, the first time after a propeller strike.',
      quotes: [
        q('P2', 'The in-flight separation of the propeller blade tip due to a fatigue fracture.'),
        q('P1', 'The incident propeller blades were overhauled twice in the 3 years before the incident.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P1', 'P2'] },
      chronology: { maintenance: PROP_OVERHAUL, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 852, bound: 'exact', passageIds: ['P1'] }] },
    },
    {
      ntsbNo: 'WPR20LA144',
      why: 'The engine lost all power from oil starvation for reasons investigators could not determine; the propeller and governor had been overhauled about 1.5 hours before the accident flight and reinstalled by the pilot and his mechanic.',
      quotes: [
        q('P8', 'A total loss of engine power due to oil starvation for reasons that could not be determined due to a lack of available evidence, which resulted in impact with terrain during a subsequent forced landing.'),
        // Not "The propeller and propeller governor were subsequently overhauled …": "subsequently" needs the sentence before it.
        q('P7', 'The pilot’s mechanic and the pilot reinstalled the overhauled propeller and governor after they were returned from the overhaul facility.'),
      ],
      evidencePassageIds: ['P7', 'P8'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P7', 'P8'] },
      symptom: { value: 'total_power_loss', passageIds: ['P8'] },
      chronology: { maintenance: PROP_GOVERNOR, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 1.5, bound: 'about', passageIds: ['P7'] }] },
    },
    {
      ntsbNo: 'CEN13LA258',
      // The why line is checked against its quotes' passages: the installation date (P11) stays in the summary sentence.
      why: 'Propeller control was lost for reasons investigators could not determine, as postaccident examinations revealed no anomalies that would have precluded normal operation.',
      quotes: [
        q(
          'P12',
          'The loss of propeller control for reasons that could not be determined because postaccident examinations revealed no anomalies that would have precluded normal operation and the airplane’s subsequent collision with power lines during the forced landing.',
        ),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P11', 'P12'] },
      chronology: { maintenance: 'the installation of the overhauled propeller on April 17, 2013', facts: [] },
    },
  ],
  gaps: [],
};

const H3: BriefSpec = {
  id: 'holdout16d.propeller',
  bundle: 'q16d-propeller',
  mechanicalCause: true,
  readings: {},
  composition: PROPELLER,
  note: 'No reading: the passages give months and operating hours, which settle no window (a reading here would rest on the case headers’ dates).',
  errors: [
    {
      id: 'hours',
      family: 'timing',
      mutation: 'operating_hours_as_flight_hours',
      expect: 'not_established',
      note: 'P7: about 1.5 hours prior to the accident flight; no passage calls them flight hours (16c review M4).',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR20LA144]]',
          'In the Mooney M20J case, the propeller and its governor had been overhauled about 1.5 flight hours before the accident flight, and the engine lost all power from oil starvation for reasons investigators could not determine [[case:WPR20LA144]].',
        ),
    },
    {
      id: 'after',
      family: 'timing',
      mutation: 'before_after',
      expect: 'contradicted',
      critical: true,
      note: 'P1: the most recent overhaul came 18 months before the incident, not after it.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA12IA459]]',
          'In the Socata TB10 case, the tip of a propeller blade separated in flight from a fatigue fracture 18 months before the blades’ most recent overhaul [[case:ERA12IA459]].',
        ),
    },
    {
      id: 'actor',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P10: the pilot, not a mechanic, did not follow the pretakeoff guidance.',
      edit: (c) => {
        caseOf(c, 'ERA20LA077').why =
          'The propeller pitch change motor failed and left the propeller at an improper setting for takeoff, leading to a runway overrun; the propeller system’s maintenance and inspection were inadequate, and a mechanic did not follow the manufacturer’s pretakeoff guidance.';
      },
    },
    {
      id: 'speaker',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P12 is the probable cause, not a witness’s account.',
      edit: (c) => {
        caseOf(c, 'CEN13LA258').quotes[0]!.speaker = 'witness';
      },
    },
    {
      id: 'thrice',
      family: 'contradiction',
      mutation: 'wrong_value',
      expect: 'contradicted',
      note: 'P1: overhauled twice in the 3 years before the incident.',
      edit: (c) => {
        caseOf(c, 'ERA12IA459').why =
          'The tip of one propeller blade separated during departure because of a fatigue fracture; the blades had been overhauled three times in the 3 years before the incident, the first time after a propeller strike.';
      },
    },
    {
      id: 'missed',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P3: the 100-hour inspection about 3 months before included both propellers; nothing says a crack was there to miss.',
      edit: (c) => {
        caseOf(c, 'ERA16LA295').why =
          'Maintenance personnel did not comply with an airworthiness directive that required repetitive eddy current inspections around the lubrication holes of the propeller hub blade sockets, and the 100-hour inspection about 3 months before the accident missed a fatigue crack in the right propeller hub.';
      },
    },
  ],
  mixed: [
    { id: 'mix-hours-actor', errors: ['hours', 'actor'], note: 'Operating hours given as flight hours and a wrong actor, in two cases.' },
    { id: 'mix-after-missed', errors: ['after', 'missed'], note: 'A reversed order and an added detail, in two cases.' },
  ],
};

const PROPELLER_CLAIMS: ClaimBatch = {
  id: 'holdout16d.propeller-claims',
  bundle: 'q16d-propeller',
  cases: ['ERA12IA459', 'ERA16LA295', 'WPR13LA184', 'WPR20LA144', 'ERA20LA077', 'CEN13LA258'],
  readings: SHORTLY,
  claims: [
    yes('era12.hours', 'timing', 'ERA12IA459', ['P1'], timing(PROP_OVERHAUL, { relation: 'operating_hours', value: 852, bound: 'exact' }), 'P1: 852 hours since the most recent overhaul, not called flight hours.', {
      provenance: 'constructed',
    }),
    no(
      'era12.flight',
      'timing',
      'ERA12IA459',
      ['P1'],
      timing(PROP_OVERHAUL, { relation: 'flight_hours', value: 852, bound: 'exact' }),
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P1 counts 852 hours without calling them flight hours (16c review M4).',
    ),
    no(
      'era12.context',
      'attribution',
      'ERA12IA459',
      ['P1'],
      said('investigators', 'This postfracture damage also precluded determination of fatigue crack growthe timing or propagation.'),
      'attribution',
      'quote_context_loss',
      'not_established',
      'P1: "This postfracture damage" is the damage to the blade’s leading edge from removal or shipment, named in the sentence before; read alone the excerpt does not say what it is about.',
      { critical: true },
    ),
    yes('wpr20.hours', 'timing', 'WPR20LA144', ['P7'], timing(PROP_GOVERNOR, { relation: 'operating_hours', value: 1.5, bound: 'about' }), 'P7: about 1.5 hours prior to the accident flight, not called flight hours.', {
      provenance: 'constructed',
    }),
    yes(
      'wpr20.reinstall',
      'why',
      'WPR20LA144',
      ['P7'],
      'The pilot and his mechanic reinstalled the overhauled propeller and governor, and the pilot reported that they made several adjustments to the governor while attempting to reach the engine’s rated rpm.',
      'P7: the reinstallation, and the adjustments as the pilot’s statement.',
    ),
    no(
      'wpr20.facility',
      'why',
      'WPR20LA144',
      ['P7'],
      'The overhaul facility reinstalled the overhauled propeller and governor on the airplane and adjusted the governor.',
      'attribution',
      'wrong_actor',
      'contradicted',
      'P7: the pilot’s mechanic and the pilot reinstalled them and made the adjustments.',
    ),
    yes('era20.order', 'why', 'ERA20LA077', ['P9'], 'Ten days before the accident, the pilot ordered another gear motor from the propeller manufacturer.', 'P9.'),
    no(
      'era20.installed',
      'why',
      'ERA20LA077',
      ['P9'],
      'A new propeller gear motor was installed on the airplane ten days before the accident.',
      'timing',
      'wrong_anchor',
      'not_established',
      'P9: the pilot ordered a gear motor ten days before; no entry records the installation of any of the parts.',
    ),
    yes(
      'era16.ad',
      'why',
      'ERA16LA295',
      ['P3'],
      'An airworthiness directive issued about 8 years before the accident required eddy current inspections of the area around the lubrication holes of the propeller hub blade sockets every 100 flight hours.',
      'P3.',
    ),
    no(
      'era16.complied',
      'why',
      'ERA16LA295',
      ['P3'],
      'Maintenance records documented that the airworthiness directive was complied with on the overhauled right propeller hub.',
      'contradiction',
      'negation',
      'contradicted',
      'P3: the records did not reveal any such documentation.',
    ),
    yes('cen13.class', 'classification', 'CEN13LA258', ['P12'], CLASSIFIED.no_fault, 'P12: postaccident examinations revealed no anomalies that would have precluded normal operation.'),
    no(
      'cen13.water',
      'why',
      'CEN13LA258',
      ['P11', 'P12'],
      'Water in the propeller piston assembly caused the loss of propeller control.',
      'unsupported_addition',
      'causal_overstatement',
      'contradicted',
      'P11 reports a liquid consistent with water along with oil in the piston assembly; P12: the reasons could not be determined and nothing found would have precluded normal operation.',
    ),
    no(
      'wpr13.tso',
      'timing',
      'WPR13LA184',
      ['P5'],
      timing('the improper overhaul of the propeller', { relation: 'operating_hours', value: 1310.5, bound: 'exact' }),
      'timing',
      'wrong_anchor',
      'not_established',
      'P5: 1,310.53 hours since overhaul at the October 2011 inspection, not at the accident.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16d-day-after-part: ERA15LA123 (P1, P2), ERA19LA074 (P3, P4), ERA19LA143 (P5, P6),
// ERA22FA223 (P7, P8), CEN23LA261 (P9, P10), CEN14FA434 (P11, P12).

const DAY_BEFORE = window(1, null, true);
const TEN_FLIGHT_HOURS = window(null, 10, true);
const ANNUAL_143 = 'the annual inspection';
const CYLINDERS_434 = 'the replacement of the Nos. 4 and 6 cylinders';
const FUEL_261 = 'the fuel and fuel filter replacement';
const UNITS_074 = 'the replacement of the throttle and metering unit, fuel pump and manifold valve';
const WORK_223 = 'the engine work six days before the accident';

const DAY_AFTER: Composition = {
  outcome: 'answer',
  summary: [
    'In the Cessna 175 case, the pilot, who was also a mechanic, performed an annual inspection the day before the accident and staked a stuck exhaust valve instead of removing the cylinder, and the engine lost all power from a stuck exhaust valve [[case:ERA19LA143]].',
    'In the Piper PA 32-300 case, the pilot and a passenger who held a mechanic certificate were seen replacing two of the engine’s cylinders the evening before the accident, and the engine lost partial power for reasons that could not be determined because thermal damage prevented a complete examination [[case:CEN14FA434]].',
    'In the Quad City Challenger case, the pilot replaced the fuel and the fuel filter the day before the accident, and on the second flight of the accident day the engine failed when its power takeoff piston seized from inadequate maintenance of the lubrication system [[case:CEN23LA261]].',
    'In the Diamond DA20 case, the pilot, also a mechanic, replaced the throttle and metering unit, the engine-driven fuel pump and the manifold valve with overhauled units on the day of the accident, and the engine then lost partial power because debris obstructed the metering plug orifice in the throttle and metering unit [[case:ERA19LA074]].',
  ].join(' '),
  groups: [
    { kind: 'causal', caseNumbers: ['ERA19LA143', 'CEN23LA261', 'ERA19LA074'] },
    { kind: 'insufficient', caseNumbers: ['CEN14FA434'] },
  ],
  cases: [
    {
      ntsbNo: 'ERA19LA143',
      why: 'The pilot, also a mechanic, performed an annual inspection the day before the accident and staked a stuck exhaust valve instead of removing the cylinder; the engine later lost all power from a stuck exhaust valve.',
      quotes: [
        q('P6', 'The total loss of engine power due to a stuck engine exhaust valve.'),
        q('P5', 'The pilot, who was also an airframe and engine mechanic, performed an annual inspection on the airplane the day before the accident.'),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6', 'P5'] },
      symptom: { value: 'total_power_loss', passageIds: ['P6'] },
      chronology: {
        maintenance: ANNUAL_143,
        facts: [
          { anchor: 'relevant_maintenance', relation: 'previous_day', passageIds: ['P5'] },
          { anchor: 'other', other: 'the second staking of the valve', relation: 'same_day', passageIds: ['P5'] },
        ],
      },
    },
    {
      ntsbNo: 'CEN14FA434',
      why: 'The pilot and a passenger who held a mechanic certificate were seen replacing the engine’s Nos. 4 and 6 cylinders the evening before the accident; the engine lost partial power for reasons that could not be determined because thermal damage prevented a complete examination.',
      quotes: [
        q('P12', 'The partial loss of engine power for reasons that could not be determined because thermal damage to the engine prevented a complete examination.'),
        q('P11', "The evening before the accident, the pilot and the passenger, who held a mechanic certificate, were seen replacing the engine's Nos. 4 and 6 cylinders."),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P11', 'P12'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P12'] },
      chronology: { maintenance: CYLINDERS_434, facts: [{ anchor: 'relevant_maintenance', relation: 'previous_day', passageIds: ['P11'] }] },
    },
    {
      ntsbNo: 'CEN23LA261',
      why: 'Inadequate maintenance of the lubrication system led to a lack of oil lubrication, a seizure of the power takeoff piston and an engine failure.',
      // Not P9's "On the second flight, …": "the second flight" needs the sentences before it (the second flight of the accident day).
      quotes: [q('P10', 'A seizure of the power takeoff piston due to inadequate maintenance to the lubrication system, which resulted in a lack of oil lubrication and subsequent engine failure.')],
      evidencePassageIds: ['P9', 'P10'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P10'] },
      // "On the second flight" counts the accident day's flights; whether he flew after the work the day before is not stated, so no flight after the work is given.
      chronology: { maintenance: FUEL_261, facts: [{ anchor: 'relevant_maintenance', relation: 'previous_day', passageIds: ['P9'] }] },
    },
    {
      ntsbNo: 'ERA19LA074',
      why: 'On the day of the accident, the pilot, also a mechanic, replaced the throttle and metering unit, the engine-driven fuel pump and the manifold valve with overhauled units, and the engine lost partial power because debris obstructed the metering plug orifice in the throttle and metering unit.',
      quotes: [
        q('P4', 'A partial loss of engine power due to debris obstructing the metering plug orifice in the throttle and metering unit.'),
        q('P3', 'The accident pilot/mechanic replaced the throttle and metering unit, the engine-driven fuel pump, and the manifold valve with overhauled units.'),
      ],
      evidencePassageIds: ['P3', 'P4'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P3', 'P4'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P4'] },
      chronology: { maintenance: UNITS_074, facts: [{ anchor: 'relevant_maintenance', relation: 'same_day', passageIds: ['P3'] }] },
    },
  ],
  gaps: [{ ntsbNo: 'ERA22FA223', note: 'The supplied passages date the engine work six days before the accident and describe no part replaced after it.', passageIds: ['P7'] }],
};

const H4: BriefSpec = {
  id: 'holdout16d.day-after',
  bundle: 'q16d-day-after-part',
  mechanicalCause: true,
  readings: DAY_BEFORE,
  composition: DAY_AFTER,
  note: 'Within 1 calendar day (pinned): the day before and the same day match by TW-C; ERA22FA223 (six days) is a gap, not a presented case.',
  errors: [
    {
      id: 'hours24',
      family: 'timing',
      mutation: 'previous_day_hours',
      expect: 'not_established',
      critical: true,
      note: 'P5: the day before is one calendar-date boundary, not "less than 24 hours".',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA19LA143]]',
          'In the Cessna 175 case, the pilot, who was also a mechanic, performed an annual inspection less than 24 hours before the accident flight and staked a stuck exhaust valve instead of removing the cylinder, and the engine lost all power from a stuck exhaust valve [[case:ERA19LA143]].',
        ),
    },
    {
      id: 'first',
      family: 'timing',
      mutation: 'wrong_ordinal',
      expect: 'contradicted',
      critical: true,
      note: 'P9: he flew for about 20 minutes on the accident day before the flight on which the engine failed.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN23LA261]]',
          'In the Quad City Challenger case, the pilot replaced the fuel and the fuel filter the day before the accident, and on the first flight after that work the engine failed when its power takeoff piston seized from inadequate maintenance of the lubrication system [[case:CEN23LA261]].',
        ),
    },
    {
      id: 'previous',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P3: the accident pilot/mechanic replaced the units, not the previous pilot.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA19LA074]]',
          'In the Diamond DA20 case, the previous pilot replaced the throttle and metering unit, the engine-driven fuel pump and the manifold valve with overhauled units on the day of the accident, and the engine then lost partial power because debris obstructed the metering plug orifice in the throttle and metering unit [[case:ERA19LA074]].',
        ),
    },
    {
      id: 'witness',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P12 is the probable cause, not a witness’s account.',
      edit: (c) => {
        caseOf(c, 'CEN14FA434').quotes[0]!.speaker = 'witness';
      },
    },
    {
      id: 'still',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P3: when the debris was removed, the engine ran normally.',
      edit: (c) => {
        caseOf(c, 'ERA19LA074').why =
          'On the day of the accident, the pilot, also a mechanic, replaced the throttle and metering unit, the engine-driven fuel pump and the manifold valve with overhauled units; the engine lost partial power and still ran rough after the debris was removed from the metering plug orifice.';
      },
    },
    {
      id: 'cylinders',
      family: 'unsupported_addition',
      mutation: 'causal_overstatement',
      expect: 'not_established',
      note: 'P12: the reasons for the partial loss of power could not be determined; nothing says the replaced cylinders failed.',
      edit: (c) => {
        caseOf(c, 'CEN14FA434').why =
          'The pilot and a passenger who held a mechanic certificate replaced the engine’s Nos. 4 and 6 cylinders the evening before the accident, and the newly installed cylinders failed, causing the partial loss of engine power.';
      },
    },
    {
      id: 'undated',
      family: 'timing',
      mutation: 'settled_as_unknown',
      expect: 'contradicted',
      critical: true,
      note: 'P7: the engine work was done six days before the accident.',
      edit: (c) => {
        c.gaps[0]!.note = 'The supplied passages do not say when the engine was last worked on before the accident.';
      },
    },
  ],
  mixed: [
    { id: 'mix-hours24-still', errors: ['hours24', 'still'], note: 'The previous day given as hours and a negation, in two cases.' },
    { id: 'mix-first-cylinders', errors: ['first', 'cylinders'], note: 'The wrong flight and a causal overstatement, in two cases.' },
  ],
};

const DAY_AFTER_CLAIMS: ClaimBatch = {
  id: 'holdout16d.day-after-claims',
  bundle: 'q16d-day-after-part',
  cases: ['ERA15LA123', 'ERA19LA074', 'ERA19LA143', 'ERA22FA223', 'CEN23LA261', 'CEN14FA434'],
  readings: DAY_BEFORE,
  claims: [
    yes('era19-143.prev', 'timing', 'ERA19LA143', ['P5'], timing(ANNUAL_143, { relation: 'previous_day' }), 'P5: the annual inspection the day before the accident.', { provenance: 'constructed' }),
    no(
      'era19-143.24h',
      'summary',
      'ERA19LA143',
      ['P5', 'P6'],
      'In the Cessna 175 case, the annual inspection was completed less than 24 hours before the engine lost power (ERA19LA143).',
      'timing',
      'previous_day_hours',
      'not_established',
      '"The day before" is one calendar-date boundary, not a number of hours.',
      { critical: true },
    ),
    no(
      'era19-143.fh',
      'criterion',
      'ERA19LA143',
      ['P5'],
      within(ANNUAL_143, null, 10),
      'timing',
      'previous_day_hours',
      'not_established',
      'The previous day settles calendar days only, never flight hours (TW-C); no passage gives flight hours.',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    yes('era19-143.within', 'criterion', 'ERA19LA143', ['P5'], within(ANNUAL_143, 1, null), 'The day before is within a one-calendar-day window (TW-C).', {
      provenance: 'constructed',
      criterion: 'timing_window',
      decision: 'matches',
    }),
    yes('cen14.prev', 'timing', 'CEN14FA434', ['P11'], timing(CYLINDERS_434, { relation: 'previous_day' }), 'P11: the evening before the accident.', { provenance: 'constructed' }),
    no(
      'cen14.24h',
      'summary',
      'CEN14FA434',
      ['P11', 'P12'],
      'In the Piper PA 32-300 case, the Nos. 4 and 6 cylinders were replaced within 24 hours of the accident flight (CEN14FA434).',
      'timing',
      'previous_day_hours',
      'not_established',
      'P11: the evening before the accident; the times of day are not given, so the elapsed hours are not either.',
      { critical: true },
    ),
    yes(
      'cen14.unsettled',
      'criterion',
      'CEN14FA434',
      'all',
      windowUnsettled(CYLINDERS_434, null, 10),
      'The previous day settles no flight hours, and no passage gives any (TW-C).',
      { provenance: 'constructed', absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    no(
      'cen23.first',
      'criterion',
      'CEN23LA261',
      ['P9'],
      firstFlight(FUEL_261),
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P9: on the accident day he flew about 20 minutes first; the engine failed on the second flight.',
      { critical: true, criterion: 'first_flight_only', decision: 'matches' },
    ),
    yes(
      'cen23.later',
      'criterion',
      'CEN23LA261',
      ['P9'],
      'Under the timing rules, the event happened on a later flight, not on the first flight after the relevant maintenance (the fuel and fuel filter replacement).',
      'P9: a 20-minute flight on the accident day came after the work and before the accident flight.',
      { provenance: 'constructed', criterion: 'first_flight_only', decision: 'does_not_match' },
    ),
    no(
      'cen23.before',
      'summary',
      'CEN23LA261',
      ['P9', 'P10'],
      'In the Quad City Challenger case, the pilot replaced the fuel filter the day after the engine failed (CEN23LA261).',
      'timing',
      'before_after',
      'contradicted',
      'P9: he replaced the fuel filter the day before the accident.',
      { critical: true },
    ),
    yes('cen23.hoses', 'why', 'CEN23LA261', ['P9'], 'According to the pilot, the hoses had not been replaced since 2009, and the engine manufacturer’s maintenance manual states that all lubrication system hoses must be replaced every 5 years.', 'P9.'),
    yes('era22.days', 'timing', 'ERA22FA223', ['P7'], timing(WORK_223, { relation: 'calendar_days', value: 6, bound: 'exact' }), 'P7: six days before the accident.', { provenance: 'constructed' }),
    yes('era22.within', 'criterion', 'ERA22FA223', ['P7'], within(WORK_223, 30, 10), 'Six calendar days are within 30 (TW-N).', {
      provenance: 'constructed',
      criterion: 'timing_window',
      decision: 'matches',
    }),
    no(
      'era22.unsettled',
      'criterion',
      'ERA22FA223',
      'all',
      windowUnsettled(WORK_223, 30, 10),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P7 settles it: six calendar days are within 30 (TW-N).',
      { critical: true, absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    no(
      'era22.tach',
      'why',
      'ERA22FA223',
      ['P7'],
      'About 22 flight hours passed between the first logbook entry about the engine backfiring and the accident.',
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P7: about 22 hours tachometer time, not flight hours (16c review M4).',
    ),
    yes('era19-074.same', 'timing', 'ERA19LA074', ['P3'], timing(UNITS_074, { relation: 'same_day' }), 'P3: the units were installed on the day of the accident.', { provenance: 'constructed' }),
    yes(
      'era19-074.debris',
      'why',
      'ERA19LA074',
      ['P3'],
      'Debris similar in composition to torque putty was lodged in the metering plug orifice of the throttle and metering unit, obstructing about 90% of the opening.',
      'P3.',
    ),
    no(
      'era19-074.when',
      'why',
      'ERA19LA074',
      ['P3'],
      'Investigators determined that the debris entered the fuel system during the maintenance performed on the day of the accident.',
      'unsupported_addition',
      'causal_overstatement',
      'contradicted',
      'P3: it could not be determined whether it was introduced then, during a previous maintenance event, or both.',
    ),
    yes(
      'era15.pc',
      'attribution',
      'ERA15LA123',
      ['P2'],
      said('investigators', 'The mechanic’s failure to detect the incorrect dry valve tappet clearances while troubleshooting ongoing engine issues, which resulted in partial loss of engine power during takeoff.'),
      'P2, the probable cause, first sentence: it names what it is about.',
    ),
    no(
      'era15.this',
      'attribution',
      'ERA15LA123',
      ['P1'],
      said('investigators', 'This was believed to solve the rough running engine issue.'),
      'attribution',
      'quote_context_loss',
      'not_established',
      'P1: "This" is the replacement of the magnetos’ internal components, named in the sentences before; read alone the excerpt does not say what was believed to solve the issue.',
      { critical: true },
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16d-helicopter: WPR22LA340 (P1, P2), CEN13LA321 (P3, P4), WPR20LA211 (P5, P6),
// ERA16LA015 (P7, P8), CEN09LA198 (P9, P10), ERA22FA257 (P11, P12).

const GEARBOX_321 = 'the maintenance that removed and reinstalled the tail rotor gear box';
const TAIL_257 = 'the tail rotor installation and balancing work';
const DRIVESHAFT_198 = 'the reattachment of the tail rotor drive shaft';
const THIRTY_DAYS = window(30, null, true);

const HELICOPTER: Composition = {
  outcome: 'answer',
  summary: [
    'In the Bell 206-L4 case, on the helicopter’s first flight after extensive maintenance, the tail rotor drive shaft partially disconnected because maintenance personnel had not ensured adequate torque of a drive shaft coupling bolt [[case:CEN13LA321]].',
    'In the Bell 407 case, the accident flight was the first flight after maintenance on the tail rotor, and investigators found that maintenance personnel had not properly secured the tail rotor crosshead drive plate, which led to the loss of tail rotor antitorque [[case:ERA22FA257]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['CEN13LA321', 'ERA22FA257'] }],
  cases: [
    {
      ntsbNo: 'CEN13LA321',
      why: 'On the first flight after maintenance that included removing and reinstalling the tail rotor gear box, the tail rotor drive shaft partially disconnected because maintenance personnel had not ensured adequate torque of a coupling bolt.',
      quotes: [
        q('P4', 'Failure of maintenance personnel to ensure adequate torque of a tailrotor drive shaft coupling bolt, which resulted in the partial disconnection of the drive shaft.'),
        q('P3', 'The helicopter was on its first flight after extensive maintenance.'),
      ],
      evidencePassageIds: ['P3', 'P4'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P4'] },
      chronology: {
        maintenance: GEARBOX_321,
        facts: [
          { anchor: 'relevant_maintenance', relation: 'flight_hours', value: 0.7, bound: 'about', passageIds: ['P3'] },
          { anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P3'] },
        ],
      },
    },
    {
      ntsbNo: 'ERA22FA257',
      why: 'Maintenance personnel did not properly secure the tail rotor crosshead drive plate, and neither they, the maintenance pilot nor the accident pilot detected the error, which led to the loss of tail rotor antitorque on the first flight after the work.',
      // Not P11's "The accident flight was the first flight after completion of this work.": "this work" needs the sentences before it.
      quotes: [
        q(
          'P12',
          'The failure of maintenance personnel to properly secure the tail rotor crosshead drive plate and the failure of maintenance personnel, the maintenance pilot, and the accident pilot to detect the error, which led to the helicopter’s loss of tail rotor antitorque.',
        ),
        q(
          'P11',
          'Postaccident examination revealed that the tail rotor crosshead drive plate, which was positioned behind the pitch change rod attachment nut, was not bolted to the tail rotor crosshead, as prescribed in the maintenance manual.',
        ),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      chronology: { maintenance: TAIL_257, facts: [{ anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P11'] }] },
    },
  ],
  gaps: [
    {
      ntsbNo: 'CEN09LA198',
      note: 'The supplied passages do not put the failure on the first flight after the work: a 0.2-hour maintenance flight check came first, and the failure happened on the first engine start after the return to service.',
      passageIds: ['P9'],
    },
  ],
};

const H5: BriefSpec = {
  id: 'holdout16d.helicopter',
  bundle: 'q16d-helicopter',
  mechanicalCause: true,
  readings: FIRST_ONLY,
  composition: HELICOPTER,
  note: 'First flight only (pinned): CEN13LA321 and ERA22FA257 match by FF-O; CEN09LA198 (a check flight came first) is a gap, not a presented case.',
  errors: [
    {
      id: 'zero',
      family: 'timing',
      mutation: 'zero_interval',
      expect: 'not_established',
      critical: true,
      note: 'P3: the first flight after the maintenance is not a zero-day interval (Z-1); no passage dates either.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN13LA321]]',
          'In the Bell 206-L4 case, on the helicopter’s first flight after extensive maintenance, zero days after that work, the tail rotor drive shaft partially disconnected because maintenance personnel had not ensured adequate torque of a drive shaft coupling bolt [[case:CEN13LA321]].',
        ),
    },
    {
      id: 'second',
      family: 'timing',
      mutation: 'wrong_ordinal',
      expect: 'contradicted',
      critical: true,
      note: 'P11: the accident flight was the first flight after completion of the work.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA22FA257]]',
          'In the Bell 407 case, the accident flight was the second flight after maintenance on the tail rotor, and investigators found that maintenance personnel had not properly secured the tail rotor crosshead drive plate, which led to the loss of tail rotor antitorque [[case:ERA22FA257]].',
        ),
    },
    {
      id: 'exact',
      family: 'timing',
      mutation: 'approximate_exact',
      expect: 'not_established',
      note: 'P3: about 0.7 flight hours, not exactly 0.7.',
      edit: (c) => {
        caseOf(c, 'CEN13LA321').chronology!.facts[0]!.bound = 'exact';
      },
    },
    {
      id: 'pilot',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P12: maintenance personnel did not secure the drive plate; the accident pilot failed to detect the error.',
      edit: (c) => {
        caseOf(c, 'ERA22FA257').why =
          'The accident pilot did not properly secure the tail rotor crosshead drive plate, and neither maintenance personnel nor the maintenance pilot detected the error, which led to the loss of tail rotor antitorque on the first flight after the work.';
      },
    },
    {
      id: 'context',
      family: 'attribution',
      mutation: 'quote_context_loss',
      expect: 'not_established',
      critical: true,
      note: 'P11: "this work" is the tail rotor installation and balancing runs of the sentences before; read alone the excerpt does not say after what.',
      edit: (c) => {
        caseOf(c, 'ERA22FA257').quotes[1] = q('P11', 'The accident flight was the first flight after completion of this work.');
      },
    },
    {
      id: 'secured',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P3: one bolt had backed out of the drive shaft and its nut was missing.',
      edit: (c) => {
        caseOf(c, 'CEN13LA321').why =
          'On the first flight after maintenance that included removing and reinstalling the tail rotor gear box, the tail rotor drive shaft partially disconnected although both coupling bolts remained secured by their nuts.';
      },
    },
    {
      id: 'flagged',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'Nothing says anyone flagged the bolt before the flight.',
      edit: (c) => {
        caseOf(c, 'CEN13LA321').why =
          'On the first flight after maintenance that included removing and reinstalling the tail rotor gear box, the tail rotor drive shaft partially disconnected because maintenance personnel had not ensured adequate torque of a coupling bolt that an inspector had flagged before the flight.';
      },
    },
  ],
  mixed: [
    { id: 'mix-zero-pilot', errors: ['zero', 'pilot'], note: 'A zero interval and a wrong actor, in two cases.' },
    { id: 'mix-second-secured', errors: ['second', 'secured'], note: 'The wrong flight and a negation, in two cases.' },
  ],
};

const HELICOPTER_CLAIMS: ClaimBatch = {
  id: 'holdout16d.helicopter-claims',
  bundle: 'q16d-helicopter',
  cases: ['WPR22LA340', 'CEN13LA321', 'WPR20LA211', 'ERA16LA015', 'CEN09LA198', 'ERA22FA257'],
  readings: FIRST_ONLY,
  claims: [
    yes('cen13.ff', 'timing', 'CEN13LA321', ['P3'], timing(GEARBOX_321, { relation: 'flight_ordinal', value: 1 }), 'P3: its first flight after the maintenance.', { provenance: 'constructed' }),
    yes('cen13.fh', 'timing', 'CEN13LA321', ['P3'], timing(GEARBOX_321, { relation: 'flight_hours', value: 0.7, bound: 'about' }), 'P3: about 0.7 flight hours since the most recent maintenance.', {
      provenance: 'constructed',
    }),
    no(
      'cen13.zero',
      'timing',
      'CEN13LA321',
      ['P3'],
      timing(GEARBOX_321, { relation: 'calendar_days', value: 0, bound: 'exact' }),
      'timing',
      'zero_interval',
      'not_established',
      'The first flight after the maintenance is not a zero-day interval (Z-1); no passage dates the maintenance.',
      { critical: true },
    ),
    no(
      'cen13.ff-unsettled',
      'criterion',
      'CEN13LA321',
      'all',
      firstFlightUnsettled(GEARBOX_321),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P3 settles it: the helicopter was on its first flight after the maintenance (FF-O).',
      { critical: true, absence: true, criterion: 'first_flight_only', decision: 'unknown' },
    ),
    yes(
      'cen13.window-unsettled',
      'criterion',
      'CEN13LA321',
      'all',
      windowUnsettled(GEARBOX_321, 30, 10),
      'Under the stated rules (AP-1, FF-O), "about 0.7 flight hours" and the first flight settle no window; the check prompt states the same rule ("not reading … about N as a number"). The label follows the rule, not likelihood.',
      { provenance: 'constructed', absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    yes('era22.ff', 'timing', 'ERA22FA257', ['P11'], timing(TAIL_257, { relation: 'flight_ordinal', value: 1 }), 'P11: the first flight after completion of the work.', { provenance: 'constructed' }),
    no(
      'era22.second',
      'timing',
      'ERA22FA257',
      ['P11'],
      timing(TAIL_257, { relation: 'flight_ordinal', value: 2 }),
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P11: the accident flight was the first flight after the work.',
      { critical: true },
    ),
    no(
      'era22.window',
      'criterion',
      'ERA22FA257',
      ['P11'],
      within(TAIL_257, 30, 10),
      'timing',
      'first_flight_window',
      'not_established',
      'The first flight alone never settles a calendar-day or flight-hour window, and no passage dates the work.',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'era22.zero',
      'timing',
      'ERA22FA257',
      ['P11'],
      timing(TAIL_257, { relation: 'flight_hours', value: 0, bound: 'exact' }),
      'timing',
      'zero_interval',
      'not_established',
      'The event happened during the first flight after the work: not zero flight hours after it (Z-1).',
      { critical: true },
    ),
    yes('era22.window-unsettled', 'criterion', 'ERA22FA257', 'all', windowUnsettled(TAIL_257, 30, 10), 'No passage gives a time between the work and the accident flight.', {
      provenance: 'constructed',
      absence: true,
      criterion: 'timing_window',
      decision: 'unknown',
    }),
    no(
      'cen09.first',
      'criterion',
      'CEN09LA198',
      ['P9'],
      firstFlight(DRIVESHAFT_198),
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P9: a 0.2-hour maintenance flight check came after the work and before the engine start on which the failure happened.',
      { critical: true, criterion: 'first_flight_only', decision: 'matches' },
    ),
    no(
      'cen09.before',
      'summary',
      'CEN09LA198',
      ['P9', 'P10'],
      'In the Bell 206 case, the 0.2-hour maintenance flight check was conducted after the tail rotor driveshaft failed (CEN09LA198).',
      'timing',
      'before_after',
      'contradicted',
      'P9: the flight check came before the return to service; the failure happened at the first engine start after it.',
      { critical: true },
    ),
    yes(
      'cen09.check',
      'why',
      'CEN09LA198',
      ['P9'],
      'A 0.2-hour maintenance flight check was conducted before the helicopter was returned to service, and the tail rotor driveshaft and coupling severed on the first engine start after the return to service.',
      'P9.',
    ),
    yes(
      'cen09.pc',
      'attribution',
      'CEN09LA198',
      ['P10'],
      said('investigators', "The failure of the tail rotor driveshaft and coupling during engine start due to the mechanic's failure to properly reattach the tail rotor driveshaft and coupling during maintenance."),
      'P10, the probable cause, whole.',
    ),
    no(
      'wpr22.recent',
      'why',
      'WPR22LA340',
      ['P1'],
      'The maintenance records showed recent work on the tail rotor drive shaft that required disassembly and reassembly of the failed flex coupling.',
      'contradiction',
      'negation',
      'contradicted',
      'P1: there had been no recent work that would have required it.',
    ),
    yes('wpr22.ring', 'why', 'WPR22LA340', ['P1'], 'The tail rotor drive shaft flange was likely attached directly to the air conditioning pulley flange without a drive ring.', 'P1 ("likely" kept).'),
    no(
      'era16.hours',
      'why',
      'ERA16LA015',
      ['P7'],
      'The operator removed and reinstalled tail rotor driveshaft S1 during a modification about 490 flight hours before the accident.',
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P7: "about 490 hours earlier", not called flight hours (16c review M4).',
    ),
    yes(
      'era16.pc',
      'attribution',
      'ERA16LA015',
      ['P8'],
      said(
        'investigators',
        'The improper installation by company maintenance personnel of the securing hardware of a tail rotor driveshaft section, which resulted in that section of tail rotor driveshaft disconnecting and a complete loss of tail rotor thrust.',
      ),
      'P8, the probable cause, whole.',
    ),
    no(
      'era16.pilot',
      'attribution',
      'ERA16LA015',
      ['P8'],
      said(
        'pilot',
        'The improper installation by company maintenance personnel of the securing hardware of a tail rotor driveshaft section, which resulted in that section of tail rotor driveshaft disconnecting and a complete loss of tail rotor thrust.',
      ),
      'attribution',
      'wrong_speaker',
      'contradicted',
      'P8 is the probable cause, not the pilot’s account.',
    ),
    no(
      'wpr20.rigging',
      'why',
      'WPR20LA211',
      ['P5', 'P6'],
      'Investigators attributed the loss of control to the repeated re-rigging of the tail rotor assembly.',
      'unsupported_addition',
      'causal_overstatement',
      'contradicted',
      'P6: a flight control malfunction from a hydraulic hardover or a flight control stiffness event; P5 reports the re-rigging without linking it to the accident.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16d-fuel-selector: ERA21LA328 (P1, P2), ERA16LA152 (P3, P4), ERA09LA081 (P5),
// CEN24LA102 (P6, P7, P8), WPR15LA153 (P9, P10), WPR13LA098 (P11, P12).

const COVER_328 = 'the installation of the fuel selector valve cover';
const VALVE_152 = 'the last examination of the fuel selector valve';
const ANNUAL_098 = 'the annual inspection';
const HANDLE_153 = 'the installation of the fuel selector valve handle';
const HUNDRED_FLIGHT_HOURS = window(null, 100, true);

const SELECTOR: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper PA-28-140 case near Orlando, Florida, a mechanic installed a fuel selector valve cover 8 days before the accident, and investigators attributed the total loss of engine power to fuel starvation from improper maintenance of the fuel selector valve and its cover [[case:ERA21LA328]].',
    'In the Piper PA 28-140 case near Bayport, New York, the fuel selector valve’s internal components were not installed in the order the service manual outlined, and investigators attributed the total loss of engine power to maintenance personnel’s improper installation and maintenance of the valve [[case:ERA16LA152]].',
    'In the Cessna 172F case, the accident flight was the first flight after an annual inspection, and investigators found that maintenance personnel had improperly installed the fuel selector handle, which led to fuel starvation and a total loss of engine power during initial climb [[case:WPR13LA098]].',
    'In the Cessna 170B case, the fuel selector valve handle had been installed 180 degrees from its correct position, and investigators attributed the fuel starvation and loss of engine power to maintenance personnel’s incorrect installation of the handle [[case:WPR15LA153]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['ERA21LA328', 'ERA16LA152', 'WPR13LA098', 'WPR15LA153'] }],
  cases: [
    {
      ntsbNo: 'ERA21LA328',
      why: 'Eight days before the accident, a mechanic installed the fuel selector valve cover, which was found improperly installed; investigators attributed the total loss of engine power to fuel starvation from improper maintenance of the fuel selector valve and its cover.',
      quotes: [
        q('P2', 'A total loss of engine power due to fuel starvation that resulted from improper maintenance of the fuel selector valve and fuel selector valve cover.'),
        q('P1', 'Maintenance records indicated that 8 days before the accident, a mechanic installed a fuel selector valve cover and certified that all work was accomplished in accordance with the manufacturer’s maintenance manual.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
      symptom: { value: 'total_power_loss', passageIds: ['P2'] },
      chronology: {
        maintenance: COVER_328,
        facts: [
          { anchor: 'relevant_maintenance', relation: 'calendar_days', value: 8, bound: 'exact', passageIds: ['P1'] },
          { anchor: 'other', other: 'the 100-hour inspection', relation: 'calendar_days', value: 20, bound: 'exact', passageIds: ['P1'] },
          { anchor: 'other', other: 'the FAA inspector’s inspection', relation: 'calendar_days', value: 13, bound: 'exact', passageIds: ['P1'] },
        ],
      },
    },
    {
      ntsbNo: 'ERA16LA152',
      why: 'The fuel selector valve was loose and did not fit securely into its detents, and investigators attributed the total loss of engine power from fuel starvation to maintenance personnel’s improper installation and maintenance of the valve.',
      // Not "The valve was examined about 98.1 hours before the accident …": read alone, "the valve" does not say which valve.
      quotes: [
        q('P4', 'Maintenance personnel’s improper installation and maintenance of the fuel selector valve, which resulted in a total loss of engine power due to fuel starvation.'),
        q('P3', 'Postaccident examination of the airplane revealed that the fuel selector valve was loose and did not fit securely into its respective detents.'),
      ],
      evidencePassageIds: ['P3', 'P4'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P4'] },
      symptom: { value: 'total_power_loss', passageIds: ['P4'] },
      chronology: { maintenance: VALVE_152, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 98.1, bound: 'about', passageIds: ['P3'] }] },
    },
    {
      ntsbNo: 'WPR13LA098',
      why: 'The accident flight was the first flight after an annual inspection during which the mechanic had taken off the fuel selector handle, and maintenance personnel’s improper installation of the handle led to fuel starvation and a total loss of engine power during initial climb.',
      quotes: [
        q('P12', 'A total loss of engine power during initial climb due to fuel starvation, which resulted from maintenance personnel’s improper installation of the fuel selector handle.'),
        q('P11', 'The airplane had recently undergone an annual inspection, and the accident flight was the first flight since that maintenance was performed.'),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      symptom: { value: 'total_power_loss', passageIds: ['P12'] },
      chronology: {
        maintenance: ANNUAL_098,
        facts: [
          { anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P11'] },
          { anchor: 'relevant_maintenance', relation: 'words', passageIds: ['P11'] },
        ],
      },
    },
    {
      ntsbNo: 'WPR15LA153',
      why: 'Maintenance personnel’s incorrect installation of the fuel selector valve handle led to fuel starvation, a loss of engine power and a forced hard landing; the pilot’s failure to follow the manufacturer’s checklist contributed.',
      quotes: [q('P10', 'Maintenance personnel’s incorrect installation of the fuel selector valvehandle, which resulted in fuel starvation, a loss of engine power, and a forced hard landing.')],
      evidencePassageIds: ['P9', 'P10'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P10'] },
      chronology: { maintenance: HANDLE_153, facts: [] },
    },
  ],
  gaps: [
    { ntsbNo: 'ERA09LA081', note: 'The supplied passage of this case mentions no maintenance: it attributes the fuel starvation to the pilot’s incorrect positioning of the fuel selector valve.', passageIds: ['P5'] },
    { ntsbNo: 'CEN24LA102', note: 'The supplied passages do not say when the fuel selector valve was installed 180 degrees from its correct orientation.', passageIds: ['P6', 'P7'] },
  ],
};

const H6: BriefSpec = {
  id: 'holdout16d.selector',
  bundle: 'q16d-fuel-selector',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: SELECTOR,
  note: 'Within 30 calendar days or 10 flight hours: ERA21LA328 matches by TW-N (8 days); ERA16LA152 gives operating hours only (TW-H), WPR13LA098 the first flight and "recently", WPR15LA153 nothing: unknown.',
  errors: [
    {
      id: 'thirteen',
      family: 'timing',
      mutation: 'wrong_anchor',
      expect: 'contradicted',
      note: 'P1: 13 days before the accident is the FAA inspector’s inspection; the cover was installed 8 days before.',
      edit: (c) => {
        caseOf(c, 'ERA21LA328').chronology!.facts[0]!.value = 13;
      },
    },
    {
      id: 'flight-hours',
      family: 'timing',
      mutation: 'operating_hours_as_flight_hours',
      expect: 'not_established',
      note: 'P3: "about 98.1 hours", not called flight hours (16c review M4).',
      edit: (c) => {
        caseOf(c, 'ERA16LA152').chronology!.facts[0]!.relation = 'flight_hours';
      },
    },
    {
      id: 'second',
      family: 'timing',
      mutation: 'wrong_ordinal',
      expect: 'contradicted',
      critical: true,
      note: 'P11: the accident flight was the first flight since the annual inspection.',
      edit: (c) => {
        caseOf(c, 'WPR13LA098').chronology!.facts[0]!.value = 2;
      },
    },
    {
      id: 'owner',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P1: a mechanic installed the cover, at the direction of the operator/owner.',
      edit: (c) => {
        caseOf(c, 'ERA21LA328').why =
          'Eight days before the accident, the airplane’s owner installed the fuel selector valve cover, which was found improperly installed; investigators attributed the total loss of engine power to fuel starvation from improper maintenance of the fuel selector valve and its cover.';
      },
    },
    {
      id: 'excerpt',
      family: 'attribution',
      mutation: 'misleading_excerpt',
      expect: 'not_established',
      note: 'P11: the sentence goes on "but he did not check it after finishing the annual inspection"; the excerpt drops that, and "He" (the mechanic) too.',
      edit: (c) => {
        caseOf(c, 'WPR13LA098').quotes[1] = q('P11', 'He checked the "off" position when receiving the airplane');
      },
    },
    {
      id: 'leak',
      family: 'contradiction',
      mutation: 'wrong_cause',
      expect: 'contradicted',
      note: 'P3, P4: the valve allowed a position between detents and fuel starvation; the staining consistent with a fuel leak is not the cause.',
      edit: (c) => {
        caseOf(c, 'ERA16LA152').why =
          'The fuel selector valve was loose and leaking, and investigators attributed the total loss of engine power to the fuel leak at the valve rather than to fuel starvation.';
      },
    },
    {
      id: 'drilled',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'contradicted',
      note: 'P9: the investigation could not determine when the hole was drilled.',
      edit: (c) => {
        caseOf(c, 'WPR15LA153').why =
          'Maintenance personnel’s incorrect installation of the fuel selector valve handle, through a hole drilled during the most recent repair work, led to fuel starvation, a loss of engine power and a forced hard landing.';
      },
    },
  ],
  mixed: [
    { id: 'mix-owner-second', errors: ['owner', 'second'], note: 'A wrong actor and the wrong flight, in two cases.' },
    { id: 'mix-hours-leak', errors: ['flight-hours', 'leak'], note: 'Operating hours given as flight hours and a wrong cause, in one case.' },
  ],
};

const SELECTOR_CLAIMS: ClaimBatch = {
  id: 'holdout16d.selector-claims',
  bundle: 'q16d-fuel-selector',
  cases: ['ERA21LA328', 'ERA16LA152', 'ERA09LA081', 'CEN24LA102', 'WPR15LA153', 'WPR13LA098'],
  readings: SHORTLY,
  claims: [
    yes('era21.days', 'timing', 'ERA21LA328', ['P1'], timing(COVER_328, { relation: 'calendar_days', value: 8, bound: 'exact' }), 'P1: 8 days before the accident.', { provenance: 'constructed' }),
    yes('era21.within', 'criterion', 'ERA21LA328', ['P1'], within(COVER_328), 'Eight calendar days are within 30 (TW-N).', {
      provenance: 'constructed',
      criterion: 'timing_window',
      decision: 'matches',
    }),
    no(
      'era21.unsettled',
      'criterion',
      'ERA21LA328',
      'all',
      windowUnsettled(COVER_328),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P1 settles it: 8 calendar days are within 30 (TW-N).',
      { critical: true, absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    no(
      'era21.after',
      'summary',
      'ERA21LA328',
      ['P1', 'P2'],
      'In the Piper PA-28-140 case near Orlando, Florida, a mechanic installed the fuel selector valve cover 8 days after the accident (ERA21LA328).',
      'timing',
      'before_after',
      'contradicted',
      'P1: 8 days before the accident.',
      { critical: true },
    ),
    yes('wpr13.ff', 'timing', 'WPR13LA098', ['P11'], timing(ANNUAL_098, { relation: 'flight_ordinal', value: 1 }), 'P11: the first flight since the annual inspection.', { provenance: 'constructed' }),
    yes('wpr13.words', 'timing', 'WPR13LA098', ['P11'], timing(ANNUAL_098, { relation: 'words' }), 'P11: "recently", without a number.', { provenance: 'constructed' }),
    no(
      'wpr13.zero',
      'timing',
      'WPR13LA098',
      ['P11'],
      timing(ANNUAL_098, { relation: 'flight_hours', value: 0, bound: 'exact' }),
      'timing',
      'zero_interval',
      'not_established',
      'The first flight after the inspection is not zero flight hours after it (Z-1).',
      { critical: true },
    ),
    no(
      'wpr13.window',
      'criterion',
      'WPR13LA098',
      ['P11'],
      within(ANNUAL_098),
      'timing',
      'first_flight_window',
      'not_established',
      'The first flight and "recently" settle no calendar-day or flight-hour window (G6).',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'wpr13.checked',
      'why',
      'WPR13LA098',
      ['P11'],
      'The mechanic checked the fuel selector’s "off" position again after finishing the annual inspection.',
      'contradiction',
      'negation',
      'contradicted',
      'P11: he did not check it after finishing the annual inspection.',
    ),
    yes(
      'wpr13.pin',
      'why',
      'WPR13LA098',
      ['P11'],
      'The fuel selector handle could be installed 180 degrees out of alignment only because the spring pin attaching it to the shaft had been modified.',
      'P11.',
    ),
    no(
      'wpr13.magneto',
      'why',
      'WPR13LA098',
      ['P11'],
      'A worn magneto that was not producing an adequate spark caused the total loss of engine power.',
      'contradiction',
      'wrong_cause',
      'contradicted',
      'P11: the magneto’s failure was unlikely related to the total loss of engine power.',
    ),
    yes('era16.hours', 'timing', 'ERA16LA152', ['P3'], timing(VALVE_152, { relation: 'operating_hours', value: 98.1, bound: 'about' }), 'P3: about 98.1 hours, not called flight hours.', {
      provenance: 'constructed',
    }),
    no(
      'era16.washer',
      'why',
      'ERA16LA152',
      ['P3'],
      'When the fuel selector valve was last examined, its position washer was replaced.',
      'contradiction',
      'wrong_value',
      'contradicted',
      'P3: only an O-ring was replaced then.',
    ),
    yes(
      'cen24.when',
      'why',
      'CEN24LA102',
      ['P6'],
      'The airframe maintenance records did not show when the fuel selector valve was installed incorrectly, and there was no record of any recent work on the valve.',
      'P6.',
    ),
    yes('cen24.class', 'classification', 'CEN24LA102', ['P6', 'P8'], CLASSIFIED.defect_not_causal, 'P6: the valve installed 180 degrees from its correct orientation; P8: the probable cause is fuel exhaustion.'),
    no(
      'cen24.cause',
      'why',
      'CEN24LA102',
      ['P6', 'P8'],
      'Investigators attributed the total loss of engine power to the fuel selector valve installed 180 degrees from its correct orientation.',
      'unsupported_addition',
      'causal_overstatement',
      'contradicted',
      'P8: the probable cause is fuel exhaustion; no passage links the reversed valve to the loss of power.',
    ),
    yes('era09.none', 'maintenance', 'ERA09LA081', 'all', MAINTAINED.no_evidence, 'P5 is the probable cause only: the pilot’s positioning of the fuel selector valve.', { absence: true }),
    yes('wpr15.checklist', 'attribution', 'WPR15LA153', ['P10'], said('investigators', "Contributing to the accident was the pilot's failure to follow the manufacturer's checklist."), 'P10, second sentence.'),
    no(
      'wpr15.when',
      'why',
      'WPR15LA153',
      ['P9'],
      'The investigation determined that the extra hole in the operating arm and handle was drilled during the repair work completed before the accident flight.',
      'unsupported_addition',
      'added_detail',
      'contradicted',
      'P9: the investigation could not determine when the hole was drilled.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16d-rotorcraft-engine: ERA21FA130 (P1, P2), ERA10LA284 (P3, P4), ERA09FA355 (P5, P6),
// CEN10CA138 (P7, P8), WPR09FA072 (P9, P10), CEN10LA431 (P11, P12).

const ANNUAL_431 = 'the annual inspection and engine installation on July 21, 2010';
const INSPECTION_130 = 'the last 300-hour engine inspection';
const HUNDRED_355 = 'the last 100-hour inspection';
const ANNUAL_138 = 'the annual inspection';

const ROTOR: Composition = {
  outcome: 'answer',
  summary: [
    'In the Bell 47G-4A case, the operator installed an engine during the annual maintenance inspection, and after 5.2 hours of operation recorded by the hour meter the engine lost all power from a high-cycle fatigue fracture of a first-stage compressor blade whose reason could not be determined [[case:CEN10LA431]].',
    'In the Bell 206 case, the engine lost all power when two stage 3 compressor blades failed from fatigue, and investigators found that maintenance personnel had not inspected the compressor at the interval recommended for corrosive environments [[case:ERA21FA130]].',
    'In the Schweizer 269C-1 case, the engine lost power because maintenance personnel had improperly installed the right magneto, and the last 100-hour inspection, about 29 hours before the accident, had not detected the improper hardware or the fractured clamping flange [[case:ERA09FA355]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['CEN10LA431', 'ERA21FA130', 'ERA09FA355'] }],
  cases: [
    {
      ntsbNo: 'CEN10LA431',
      why: 'The engine installed during the annual maintenance inspection lost all power after 5.2 hours of recorded operation, from a high-cycle fatigue fracture of a first-stage compressor blade whose reason could not be determined.',
      quotes: [
        q('P12', 'The total loss of engine power due to a high-cycle fatigue fracture of a first-stage compressor blade.'),
        q('P11', 'At the accident site, the recording hour meter reading was 328.7 hours, which indicated that the helicopter was operated for 5.2 hours since the last annual maintenance inspection.'),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P11', 'P12'] },
      symptom: { value: 'total_power_loss', passageIds: ['P12'] },
      // The accident date is only in the case header: no calendar days from the inspection date.
      chronology: { maintenance: ANNUAL_431, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 5.2, bound: 'exact', passageIds: ['P11'] }] },
    },
    {
      ntsbNo: 'ERA21FA130',
      why: 'Two stage 3 compressor blades failed from fatigue and caused a total loss of engine power; the last 300-hour engine inspection had been completed about 3 years and 800 flight hours before the accident.',
      quotes: [
        q('P2', 'A total loss of engine power due to fatigue failure of two of the stage 3 compressor blades.'),
        q('P1', 'The engine logbook showed that a 300-hour engine inspection was completed about 3 years and 800 flight hours before the accident.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
      symptom: { value: 'total_power_loss', passageIds: ['P2'] },
      chronology: { maintenance: INSPECTION_130, facts: [{ anchor: 'relevant_maintenance', relation: 'flight_hours', value: 800, bound: 'about', passageIds: ['P1'] }] },
    },
    {
      ntsbNo: 'ERA09FA355',
      why: 'Maintenance personnel improperly installed the right magneto, which caused the loss of engine power, and the mechanic’s inadequate 100-hour inspection missed the improper hardware at both magnetos and the fractured clamping flange.',
      // Not P5's "… the last 100-Hour inspection was approximately 29 hours earlier.": read alone, "earlier" does not say than what.
      quotes: [
        q('P6', 'A loss of engine power due to the improper installation of the right magneto by maintenance personnel resulting in subsequent loss of engine power.'),
        q('P5', 'The engine was removed from the helicopter and test run after proper timing of the right magneto; no discrepancies were noted.'),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      chronology: { maintenance: HUNDRED_355, facts: [{ anchor: 'relevant_maintenance', relation: 'operating_hours', value: 29, bound: 'about', passageIds: ['P5'] }] },
    },
  ],
  gaps: [
    {
      ntsbNo: 'WPR09FA072',
      note: 'The supplied passages of this case mention no maintenance before the accident: they report postaccident examinations and give no reason for the partial loss of engine power.',
      passageIds: ['P9', 'P10'],
    },
  ],
};

const H7: BriefSpec = {
  id: 'holdout16d.rotor',
  bundle: 'q16d-rotorcraft-engine',
  mechanicalCause: true,
  readings: {},
  composition: ROTOR,
  note: 'No reading: the passages give operating hours, approximate flight hours and an inspection date whose interval to the accident only the case header could settle.',
  errors: [
    {
      id: 'flight-hours',
      family: 'timing',
      mutation: 'operating_hours_as_flight_hours',
      expect: 'not_established',
      note: 'P11: 5.2 hours of recording hour meter time, not flight hours (16c review M4).',
      edit: (c) => {
        caseOf(c, 'CEN10LA431').chronology!.facts[0]!.relation = 'flight_hours';
      },
    },
    {
      id: 'one-month',
      family: 'timing',
      mutation: 'wrong_anchor',
      expect: 'contradicted',
      note: 'P1: about 1 month before the accident was the most recent inspection, whose paperwork shows no 300-hour inspection; the last 300-hour inspection was about 3 years before.',
      edit: (c) => {
        caseOf(c, 'ERA21FA130').why =
          'Two stage 3 compressor blades failed from fatigue and caused a total loss of engine power; the last 300-hour engine inspection had been completed about 1 month before the accident.';
      },
    },
    {
      id: 'after',
      family: 'timing',
      mutation: 'before_after',
      expect: 'contradicted',
      critical: true,
      note: 'P5: the last 100-hour inspection was about 29 hours before the accident, not after the loss of power.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA09FA355]]',
          'In the Schweizer 269C-1 case, the engine lost power because maintenance personnel had improperly installed the right magneto, and the last 100-hour inspection was done about 29 hours after the loss of engine power [[case:ERA09FA355]].',
        ),
    },
    {
      id: 'pilot',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P6: maintenance personnel installed the right magneto improperly, not the student pilot.',
      edit: (c) => {
        caseOf(c, 'ERA09FA355').why =
          'The student pilot improperly installed the right magneto, which caused the loss of engine power, and the mechanic’s inadequate 100-hour inspection missed the improper hardware at both magnetos and the fractured clamping flange.';
      },
    },
    {
      id: 'earlier',
      family: 'attribution',
      mutation: 'quote_context_loss',
      expect: 'not_established',
      critical: true,
      note: 'P5: "approximately 29 hours earlier" needs the surrounding text to say earlier than what.',
      edit: (c) => {
        caseOf(c, 'ERA09FA355').quotes[1] = q('P5', 'The engine had been inspected three times since the overhauled engine was installed; the last 100-Hour inspection was approximately 29 hours earlier.');
      },
    },
    {
      id: 'fod',
      family: 'contradiction',
      mutation: 'wrong_cause',
      expect: 'contradicted',
      note: 'P12: the reason for the fracture could not be determined.',
      edit: (c) => {
        caseOf(c, 'CEN10LA431').why =
          'The engine installed during the annual maintenance inspection lost all power after 5.2 hours of recorded operation, from a fatigue fracture of a first-stage compressor blade that investigators traced to foreign object damage.';
      },
    },
    {
      id: 'pitting',
      family: 'unsupported_addition',
      mutation: 'causal_overstatement',
      expect: 'contradicted',
      note: 'P1: no evidence of pitting corrosion was found, only surface corrosion.',
      edit: (c) => {
        caseOf(c, 'ERA21FA130').why =
          'Pitting corrosion initiated fatigue fractures in two stage 3 compressor blades, which caused a total loss of engine power; the last 300-hour engine inspection had been completed about 3 years and 800 flight hours before the accident.';
      },
    },
  ],
  mixed: [
    { id: 'mix-hours-pilot', errors: ['flight-hours', 'pilot'], note: 'Hour-meter time given as flight hours and a wrong actor, in two cases.' },
    { id: 'mix-after-pitting', errors: ['after', 'pitting'], note: 'A reversed order and a causal overstatement, in two cases.' },
  ],
};

const ROTOR_CLAIMS: ClaimBatch = {
  id: 'holdout16d.rotor-claims',
  bundle: 'q16d-rotorcraft-engine',
  cases: ['ERA21FA130', 'ERA10LA284', 'ERA09FA355', 'CEN10CA138', 'WPR09FA072', 'CEN10LA431'],
  readings: SHORTLY,
  claims: [
    yes(
      'cen10c.next',
      'why',
      'CEN10CA138',
      ['P7'],
      'The accident flight was another maintenance test flight, flown on the day after the maintenance test flight that followed the annual inspection.',
      'P7.',
    ),
    no(
      'cen10c.24h',
      'summary',
      'CEN10CA138',
      ['P7', 'P8'],
      'In the Enstrom 280FX case, the accident flight departed less than 24 hours after the first maintenance test flight ended (CEN10CA138).',
      'timing',
      'previous_day_hours',
      'not_established',
      'P7: "on the following day" is one calendar-date boundary, not a number of hours; no times are given.',
      { critical: true },
    ),
    yes(
      'cen10c.between',
      'timing',
      'CEN10CA138',
      ['P7'],
      timing(ANNUAL_138, { relation: 'intervening_flights', value: 1, bound: 'at_least' }),
      'P7: a maintenance test flight after the annual inspection came before the accident flight.',
      { provenance: 'constructed' },
    ),
    no(
      'cen10c.first',
      'criterion',
      'CEN10CA138',
      ['P7'],
      firstFlight(ANNUAL_138),
      'timing',
      'wrong_ordinal',
      'contradicted',
      'P7: the pilot flew a maintenance test flight after the annual inspection; the accident flight was another one, the following day.',
      { critical: true, criterion: 'first_flight_only', decision: 'matches' },
    ),
    yes(
      'cen10c.connector',
      'why',
      'CEN10CA138',
      ['P7'],
      'An electrical connector from the right fuel tank sending unit was found disconnected, which would have given a false full indication of fuel quantity.',
      'P7.',
    ),
    no(
      'cen10c.cause',
      'why',
      'CEN10CA138',
      ['P8'],
      'Investigators attributed the loss of engine power to the disconnected fuel tank sending unit rather than to the pilots’ preflight inspection.',
      'contradiction',
      'wrong_cause',
      'contradicted',
      'P8: the inadequate preflight inspection by both pilots caused the fuel exhaustion; the sending unit contributed.',
    ),
    yes('cen10l.hours', 'timing', 'CEN10LA431', ['P11'], timing(ANNUAL_431, { relation: 'operating_hours', value: 5.2, bound: 'exact' }), 'P11: 5.2 hours by the recording hour meter.', {
      provenance: 'constructed',
    }),
    yes(
      'cen10l.engine',
      'why',
      'CEN10LA431',
      ['P11'],
      'The operator installed the engine during the annual maintenance inspection on July 21, 2010; it had not been in service since it was removed from N3094G on March 24, 2009.',
      'P11.',
    ),
    no(
      'cen10l.new',
      'why',
      'CEN10LA431',
      ['P11'],
      'The engine the operator installed during the annual maintenance inspection had just been overhauled.',
      'contradiction',
      'wrong_value',
      'contradicted',
      'P11: the engine had 2,026.8 hours since overhaul at the time of the annual maintenance inspection.',
    ),
    yes(
      'era21f.paperwork',
      'why',
      'ERA21FA130',
      ['P1'],
      'Paperwork from the two most recent inspections, about 11 months and 1 month before the accident, did not indicate that the 300-hour inspection had been performed.',
      'P1.',
    ),
    no(
      'era21f.exact',
      'timing',
      'ERA21FA130',
      ['P1'],
      timing(INSPECTION_130, { relation: 'flight_hours', value: 800, bound: 'exact' }),
      'timing',
      'approximate_exact',
      'not_established',
      'P1: about 800 flight hours.',
    ),
    yes('era09f.hours', 'timing', 'ERA09FA355', ['P5'], timing(HUNDRED_355, { relation: 'operating_hours', value: 29, bound: 'about' }), 'P5: approximately 29 hours, not called flight hours.', {
      provenance: 'constructed',
    }),
    no(
      'era09f.flight',
      'timing',
      'ERA09FA355',
      ['P5'],
      timing(HUNDRED_355, { relation: 'flight_hours', value: 29, bound: 'about' }),
      'timing',
      'operating_hours_as_flight_hours',
      'not_established',
      'P5: "approximately 29 hours earlier", not called flight hours (16c review M4).',
    ),
    no(
      'era09f.points',
      'why',
      'ERA09FA355',
      ['P5'],
      'During the last 100-hour inspection, the mechanic checked the magneto breaker points for pitting and minimum gap as the engine manufacturer’s guide specifies.',
      'contradiction',
      'negation',
      'contradicted',
      'P5: he did not check them.',
    ),
    yes(
      'era10.overdue',
      'why',
      'ERA10LA284',
      ['P3'],
      'The failed rear engine had 2,404.3 hours in service, although the engine manufacturer called for an overhaul at 1,500 hours.',
      'P3.',
    ),
    no(
      'era10.only',
      'why',
      'ERA10LA284',
      ['P4'],
      'Investigators attributed the accident to the inadequate maintenance and inspection of the rear engine, not to the pilot.',
      'contradiction',
      'wrong_cause',
      'contradicted',
      'P4: the probable cause is the pilot’s failure to follow the engine-out procedures; the maintenance contributed.',
    ),
    yes('wpr09.reason', 'why', 'WPR09FA072', ['P10'], 'The reason for the partial loss of engine power during landing was not determined.', 'P10.'),
    no(
      'wpr09.leaks',
      'why',
      'WPR09FA072',
      ['P9', 'P10'],
      'Investigators determined that leaks at the temperature compensator and the PX acceleration bellows caused the partial loss of engine power.',
      'unsupported_addition',
      'causal_overstatement',
      'contradicted',
      'P9: the engine reached full power in the test cell with the fittings untightened, and no pre-existing condition was found; P10: the reason is undetermined.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16d-throttle: ANC11CA075 (P1, P2), ERA13LA342 (P3, P4), ERA13LA148 (P5, P6),
// WPR19LA065 (P7, P8), ERA20LA044 (P9, P10), CEN21LA175 (P11, P12).

const ENGINE_342 = 'the most recent engine maintenance';
const ANNUAL_148 = 'the last annual inspection';
const ANNUAL_065 = 'the most recent annual inspection';
const CARB_175 = 'the carburetor replacement';
const CARB_044 = 'the carburetor overhaul and reinstallation';
const DOM_075 = 'the director of maintenance’s throttle linkage work';

const THROTTLE: Composition = {
  outcome: 'answer',
  summary: [
    'In the Mooney M20J case, the throttle linkage came loose 6 days and 1 flight hour after the most recent engine maintenance, and investigators attributed the partial loss of engine power to the improper installation and inspection of the throttle linkage by maintenance personnel [[case:ERA13LA342]].',
    'In the Piper PA-32-300 case, maintenance personnel had installed a cotter pin of incorrect length on the throttle linkage clevis pin at an undetermined time, and the pin came loose less than 1 flight hour after the last annual inspection [[case:ERA13LA148]].',
    'In the Piper PA28 case, the mechanic had removed and reinstalled the throttle cable during the most recent annual inspection, and investigators attributed the partial loss of engine power to his failure to properly secure the throttle lever locking nut and cotter pin [[case:WPR19LA065]].',
    'In the Piper PA-28-140 case, the carburetor had been replaced about 23 flight hours before the accident, and investigators attributed the partial loss of engine power to inadequate maintenance at that time, which left the throttle cable improperly installed [[case:CEN21LA175]].',
    'In the Piper PA-32-301 case, the throttle linkage disconnected on a postmaintenance check flight, and investigators attributed the partial loss of engine power to the disconnected linkage and the maintenance director’s inadequate inspection of it during maintenance [[case:ANC11CA075]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['ERA13LA342', 'ERA13LA148', 'WPR19LA065', 'CEN21LA175', 'ANC11CA075'] }],
  cases: [
    {
      ntsbNo: 'ERA13LA342',
      why: 'The throttle linkage came loose 6 days and 1 flight hour after the most recent engine maintenance, and investigators attributed the partial loss of engine power to the improper installation and inspection of the throttle linkage by maintenance personnel.',
      quotes: [
        q('P4', 'The improper installation and inspection of the throttle linkage by maintenance personnel, which resulted in the throttle linkage coming loose and a subsequent partial loss of engine power.'),
        q('P3', 'The most recent engine maintenance was performed 6 days and 1 flight hour before the accident by the same mechanic.'),
      ],
      evidencePassageIds: ['P3', 'P4'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P4'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P4'] },
      chronology: {
        maintenance: ENGINE_342,
        facts: [
          { anchor: 'relevant_maintenance', relation: 'calendar_days', value: 6, bound: 'exact', passageIds: ['P3'] },
          { anchor: 'relevant_maintenance', relation: 'flight_hours', value: 1, bound: 'exact', passageIds: ['P3'] },
        ],
      },
    },
    {
      ntsbNo: 'ERA13LA148',
      why: 'Maintenance personnel installed a cotter pin of incorrect length on the throttle linkage clevis pin at an undetermined time; the pin came loose and the pilot lost throttle control less than 1 flight hour after the last annual inspection.',
      quotes: [
        q('P6', 'The installation of an incorrect length of cotter pin on the throttle linkage clevis pin by maintenance personnel at an undetermined time, which resulted in the pin coming loose and the loss of throttle control.'),
        q('P5', 'The last annual inspection occurred 2 weeks and less than 1 flight hour before the accident.'),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      chronology: { maintenance: ANNUAL_148, facts: [{ anchor: 'relevant_maintenance', relation: 'flight_hours', value: 1, bound: 'at_most', passageIds: ['P5'] }] },
    },
    {
      ntsbNo: 'WPR19LA065',
      why: 'The mechanic removed and reinstalled the throttle cable during the most recent annual inspection, and the partial loss of engine power resulted from his failure to properly secure the throttle lever locking nut and cotter pin.',
      quotes: [
        q('P8', 'A partial loss of engine power due to the mechanic’s failure to properly secure the throttle lever locking nut and cotter pin.'),
        q(
          'P7',
          'A review of the maintenance log books and an interview with the mechanic revealed that the throttle cable had been removed and subsequently reinstalled onto the carburetor as part of the most recent annual inspection, which was completed about 1 month before the accident.',
        ),
      ],
      evidencePassageIds: ['P7', 'P8'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P8'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P8'] },
      // "About 1 month" is not a number of calendar days: no fact.
      chronology: { maintenance: ANNUAL_065, facts: [] },
    },
    {
      ntsbNo: 'CEN21LA175',
      why: 'Inadequate maintenance when the carburetor was replaced left the throttle cable improperly installed, which resulted in a partial loss of engine power; the annual inspection that followed did not detect it.',
      quotes: [
        q('P12', 'Inadequate maintenance at the time the carburetor was replaced, which resulted in the improperly installed throttle cable and a partial loss of engine power.'),
        q('P11', 'The airplane maintenance records indicated that the carburetor was replaced about 23 flight hours before the accident.'),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P12'] },
      chronology: {
        maintenance: CARB_175,
        facts: [
          { anchor: 'relevant_maintenance', relation: 'flight_hours', value: 23, bound: 'about', passageIds: ['P11'] },
          { anchor: 'other', other: 'the annual inspection', relation: 'flight_hours', value: 11, bound: 'about', passageIds: ['P11'] },
        ],
      },
    },
    {
      ntsbNo: 'ANC11CA075',
      why: 'On a postmaintenance check flight, a self-locking nut was missing from the throttle linkage arm and the throttle cable disconnected; investigators also cited the maintenance director’s inadequate inspection of the throttle linkage during maintenance.',
      quotes: [
        q(
          'P2',
          "A partial loss of engine power while on approach to land due to a disconnected throttle control linkage, and the maintenance director's inadequate inspection of the throttle linkage during maintenance.",
        ),
        q('P1', 'A postaccident engine examination revealed that a self-locking nut was missing from the throttle linkage arm, resulting in the disconnection of the throttle cable.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P2'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P2'] },
      chronology: { maintenance: DOM_075, facts: [] },
    },
  ],
  gaps: [
    {
      ntsbNo: 'ERA20LA044',
      note: 'The supplied passages put the carburetor’s overhaul and reinstallation more than 13 months and at least 192 flight hours before the accident, and record no later work on the throttle or mixture control cables.',
      passageIds: ['P9'],
    },
  ],
};

const H8: BriefSpec = {
  id: 'holdout16d.throttle',
  bundle: 'q16d-throttle',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: THROTTLE,
  note: 'Within 30 calendar days or 10 flight hours: ERA13LA342 (6 days, 1 flight hour) and ERA13LA148 (less than 1 flight hour) match by TW-N; CEN21LA175 (about 23 flight hours, no days), WPR19LA065 and ANC11CA075 (nothing stated) are unknown; ERA20LA044 (outside) is a gap.',
  errors: [
    {
      id: 'unit',
      family: 'timing',
      mutation: 'unit_swap',
      expect: 'contradicted',
      note: 'P5: less than 1 flight hour and 2 weeks; not at most 1 calendar day.',
      edit: (c) => {
        caseOf(c, 'ERA13LA148').chronology!.facts[0]!.relation = 'calendar_days';
      },
    },
    {
      id: 'before',
      family: 'timing',
      mutation: 'before_after',
      expect: 'contradicted',
      critical: true,
      note: 'P11: the carburetor was replaced about 23 flight hours before the accident.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN21LA175]]',
          'In the Piper PA-28-140 case, the carburetor was replaced about 23 flight hours after the loss of engine power, and investigators attributed that loss to inadequate maintenance of the throttle cable [[case:CEN21LA175]].',
        ),
    },
    {
      id: 'undated',
      family: 'timing',
      mutation: 'settled_as_unknown',
      expect: 'contradicted',
      critical: true,
      note: 'P9: more than 13 months and a minimum of 192 flight hours before the accident.',
      edit: (c) => {
        c.gaps[0]!.note = 'The supplied passages do not say how long before the accident the carburetor was overhauled and reinstalled.';
      },
    },
    {
      id: 'pilot',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P1, P2: the director of maintenance worked on and inspected the linkage.',
      edit: (c) => {
        caseOf(c, 'ANC11CA075').why =
          'On a postmaintenance check flight, a self-locking nut was missing from the throttle linkage arm and the throttle cable disconnected; investigators also cited the pilot’s inadequate inspection of the throttle linkage during maintenance.';
      },
    },
    {
      id: 'speaker',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P4 is the probable cause, not the pilot’s account.',
      edit: (c) => {
        caseOf(c, 'ERA13LA342').quotes[0]!.speaker = 'pilot';
      },
    },
    {
      id: 'tight',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P7: the lock nut was finger-tight and its cotter pin was absent.',
      edit: (c) => {
        caseOf(c, 'WPR19LA065').why =
          'The mechanic removed and reinstalled the throttle cable during the most recent annual inspection; examination found the throttle lever lock nut tight and its cotter pin in place.';
      },
    },
    {
      id: 'annual',
      family: 'unsupported_addition',
      mutation: 'causal_overstatement',
      expect: 'contradicted',
      note: 'P6: the cotter pin was installed at an undetermined time; P5: the records did not show when it was replaced.',
      edit: (c) => {
        caseOf(c, 'ERA13LA148').why =
          'The mechanic installed a cotter pin of incorrect length on the throttle linkage clevis pin during the last annual inspection; the pin came loose and the pilot lost throttle control less than 1 flight hour later.';
      },
    },
  ],
  mixed: [
    { id: 'mix-before-pilot', errors: ['before', 'pilot'], note: 'A reversed order and a wrong actor, in two cases.' },
    { id: 'mix-unit-tight', errors: ['unit', 'tight'], note: 'A unit swap and a negation, in two cases.' },
  ],
};

const THROTTLE_CLAIMS: ClaimBatch = {
  id: 'holdout16d.throttle-claims',
  bundle: 'q16d-throttle',
  cases: ['ANC11CA075', 'ERA13LA342', 'ERA13LA148', 'WPR19LA065', 'ERA20LA044', 'CEN21LA175'],
  readings: SHORTLY,
  claims: [
    yes('era13.days', 'timing', 'ERA13LA342', ['P3'], timing(ENGINE_342, { relation: 'calendar_days', value: 6, bound: 'exact' }), 'P3: 6 days before the accident.', { provenance: 'constructed' }),
    yes('era13.fh', 'timing', 'ERA13LA342', ['P3'], timing(ENGINE_342, { relation: 'flight_hours', value: 1, bound: 'exact' }), 'P3: 1 flight hour before the accident.', { provenance: 'constructed' }),
    yes('era13.within', 'criterion', 'ERA13LA342', ['P3'], within(ENGINE_342), 'Six calendar days and 1 flight hour are within the window (TW-N).', {
      provenance: 'constructed',
      criterion: 'timing_window',
      decision: 'matches',
    }),
    no(
      'era13.unsettled',
      'criterion',
      'ERA13LA342',
      'all',
      windowUnsettled(ENGINE_342),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P3 settles it: 6 days and 1 flight hour (TW-N).',
      { critical: true, absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    no(
      'era13.area',
      'why',
      'ERA13LA342',
      ['P3'],
      'During the most recent engine maintenance, the mechanic worked on the throttle linkage and the throttle body arm.',
      'contradiction',
      'negation',
      'contradicted',
      'P3: no maintenance was conducted in that area; the starter was overhauled.',
    ),
    yes('era13x.fh', 'timing', 'ERA13LA148', ['P5'], timing(ANNUAL_148, { relation: 'flight_hours', value: 1, bound: 'at_most' }), 'P5: less than 1 flight hour.', { provenance: 'constructed' }),
    no(
      'era13x.unsettled',
      'criterion',
      'ERA13LA148',
      'all',
      windowUnsettled(ANNUAL_148),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P5 settles it: less than 1 flight hour, and 2 weeks.',
      { critical: true, absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    no(
      'era13x.after',
      'summary',
      'ERA13LA148',
      ['P5', 'P6'],
      'In the Piper PA-32-300 case, the last annual inspection took place 2 weeks after the loss of throttle control (ERA13LA148).',
      'timing',
      'before_after',
      'contradicted',
      'P5: 2 weeks before the accident.',
      { critical: true },
    ),
    yes('cen21.fh', 'timing', 'CEN21LA175', ['P11'], timing(CARB_175, { relation: 'flight_hours', value: 23, bound: 'about' }), 'P11: about 23 flight hours.', { provenance: 'constructed' }),
    no(
      'cen21.anchor',
      'timing',
      'CEN21LA175',
      ['P11'],
      timing(CARB_175, { relation: 'flight_hours', value: 11, bound: 'about' }),
      'timing',
      'wrong_anchor',
      'contradicted',
      'P11: about 11 flight hours is the time since the annual inspection; the carburetor was replaced about 23 flight hours before.',
    ),
    yes(
      'cen21.unsettled',
      'criterion',
      'CEN21LA175',
      'all',
      windowUnsettled(CARB_175),
      'No calendar days are stated, and about 23 flight hours is not within 10 either way: the window stays open.',
      { provenance: 'constructed', absence: true, criterion: 'timing_window', decision: 'unknown' },
    ),
    no(
      'cen21.window',
      'criterion',
      'CEN21LA175',
      ['P11'],
      within(CARB_175, null, 10),
      'timing',
      'wrong_window',
      'contradicted',
      'P11: about 23 flight hours, beyond 10.',
      { criterion: 'timing_window', decision: 'matches' },
    ),
    yes(
      'wpr19.annual',
      'why',
      'WPR19LA065',
      ['P7'],
      'The throttle cable had been removed and reinstalled onto the carburetor during the most recent annual inspection, about 1 month before the accident.',
      'P7.',
    ),
    no(
      'wpr19.days',
      'timing',
      'WPR19LA065',
      ['P7'],
      timing(ANNUAL_065, { relation: 'calendar_days', value: 30, bound: 'exact' }),
      'timing',
      'approximate_exact',
      'not_established',
      'P7: about 1 month, not exactly 30 calendar days.',
    ),
    yes(
      'anc11.dom',
      'why',
      'ANC11CA075',
      ['P1'],
      'While troubleshooting a recurring complaint of low manifold pressure, the director of maintenance removed the cotter pin from the castellated nut connecting the throttle linkage to the fuel control servo, tightened the nut and reinstalled the cotter pin.',
      'P1, the director of maintenance’s report.',
    ),
    no(
      'anc11.same',
      'why',
      'ANC11CA075',
      ['P1'],
      'The nut found missing from the throttle linkage was the castellated nut that the director of maintenance had tightened.',
      'contradiction',
      'wrong_value',
      'contradicted',
      'P1: the missing self-locking nut was on the other end of the throttle linkage arm, about 2 inches from the castellated nut he tightened.',
    ),
    yes('era20.fh', 'timing', 'ERA20LA044', ['P9'], timing(CARB_044, { relation: 'flight_hours', value: 192, bound: 'at_least' }), 'P9: a minimum of 192 flight hours.', { provenance: 'constructed' }),
    no(
      'era20.window',
      'criterion',
      'ERA20LA044',
      ['P9'],
      within(CARB_044),
      'timing',
      'wrong_window',
      'contradicted',
      'P9: more than 13 months and a minimum of 192 flight hours.',
      { criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'era13.nut',
      'attribution',
      'ERA13LA342',
      ['P3'],
      said('investigators', 'The nut then gradually loosened and fell off, which allowed the bolt to become loose.'),
      'attribution',
      'quote_context_loss',
      'not_established',
      'P3: "The nut" is the throttle linkage nut whose cotter pin was not reinstalled, in the sentence before; read alone the excerpt does not say which nut or bolt.',
    ),
  ],
};

// ---------------------------------------------------------------------------
// q16d-controls: CEN15IA079 (P1, P2), ERA14LA015 (P3, P4), ERA23LA002 (P5), ERA20CA246 (P6),
// ANC14FA050 (P7, P8, P9), WPR15FA158 (P10, P11, P12).

const WORK_050 = 'the maintenance and modification over several years';
const CABLES_015 = 'the elevator cable replacement during the annual inspection';

const CONTROLS: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper PA 12 case, the accident flight was the airplane’s first flight after maintenance and modification over several years, and its elevator control cables had been rigged in reverse [[case:ANC14FA050]].',
    'In the Piper PA-22-135 case, the mechanics replaced the elevator cables during the annual inspection, and investigators attributed the accident to the reverse rigging of the cables by maintenance personnel, their failure to verify it, and the pilot’s inadequate preflight check [[case:ERA14LA015]].',
    'In the Aeronca 7AC case, investigators attributed the accident to the reverse rigging of the elevator cables by maintenance personnel, their failure to verify the rigging during post-maintenance checks and the pilot’s inadequate preflight check [[case:ERA23LA002]].',
    'In the Piper PA22 case, the mechanic had rigged the aileron control cables incorrectly, which reversed the pilot’s aileron inputs during the takeoff [[case:ERA20CA246]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['ANC14FA050', 'ERA14LA015', 'ERA23LA002', 'ERA20CA246'] }],
  cases: [
    {
      ntsbNo: 'ANC14FA050',
      why: 'On the airplane’s first flight after maintenance and modification over several years, its elevator control cables were rigged in reverse, and the pilot’s preflight inspection did not detect the misrigging.',
      quotes: [
        q('P9', 'The incorrect (reverse) rigging of the elevator control cables, and the pilot’s inadequate preflight inspection, which failed to detect the misrigging.'),
        q('P8', "The accident flight was the airplane's first flight after undergoing maintenance and modification over the course of several years."),
      ],
      evidencePassageIds: ['P7', 'P8', 'P9'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P9', 'P8'] },
      chronology: { maintenance: WORK_050, facts: [{ anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P8'] }] },
    },
    {
      ntsbNo: 'ERA14LA015',
      why: 'The mechanics replaced the frayed elevator cables during the annual inspection and rigged them in reverse, and neither their postmaintenance checks nor the pilot’s preflight check detected it.',
      // Not "… the left hand and right hand elevator cables were replaced at that time.": "at that time" needs the sentence before it.
      quotes: [
        q('P4', "The incorrect (reverse) rigging of the elevator cables by maintenance personnel and their subsequent failure to verify that the rigging was correct during postmaintenance checks and the pilot's inadequate preflight check."),
        q('P3', 'Examination of the airplane by a Federal Aviation Administration inspector revealed that the elevator control cables moved the opposite direction as commanded.'),
      ],
      evidencePassageIds: ['P3', 'P4'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P4'] },
      chronology: { maintenance: CABLES_015, facts: [] },
    },
    {
      ntsbNo: 'ERA23LA002',
      why: 'Maintenance personnel rigged the elevator cables in reverse and did not verify the rigging during post-maintenance checks, and the pilot’s preflight check did not detect it.',
      quotes: [
        q('P5', "The incorrect (reverse) rigging of the elevator cables by maintenance personnel and their subsequent failure to verify that the rigging was correct during post-maintenance checks and the pilot's inadequate preflight check."),
      ],
      evidencePassageIds: ['P5'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P5'] },
      chronology: { maintenance: 'the rigging of the elevator cables', facts: [] },
    },
    {
      ntsbNo: 'ERA20CA246',
      why: 'The mechanic rigged the aileron control cables incorrectly, which reversed the pilot’s aileron inputs during the takeoff; the mechanic’s post-maintenance inspection and the pilot’s preflight inspection and before takeoff check did not detect it.',
      quotes: [q('P6', 'The mechanic’s incorrect rigging of the aileron control cables, which resulted in a reversal of aileron control inputs applied by the pilot during the takeoff.')],
      evidencePassageIds: ['P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      chronology: { maintenance: 'the rigging of the aileron control cables', facts: [] },
    },
  ],
  gaps: [
    {
      ntsbNo: 'WPR15FA158',
      note: 'The supplied passages call the accident flight a local post-maintenance test flight but do not say whether it was the first flight after the aileron cables were replaced.',
      passageIds: ['P11'],
    },
    {
      ntsbNo: 'CEN15IA079',
      note: 'The supplied passages call the flight a postmaintenance test flight but do not say whether it was the first flight after the elevator trim actuator was replaced.',
      passageIds: ['P1'],
    },
  ],
};

const H9: BriefSpec = {
  id: 'holdout16d.controls',
  bundle: 'q16d-controls',
  mechanicalCause: true,
  readings: FIRST_ONLY,
  composition: CONTROLS,
  note: 'First flight only (pinned): ANC14FA050 matches by FF-O; the other presented cases state no flight and stay unknown; the two test flights are gaps (not stated as the first flight).',
  errors: [
    {
      id: 'zero',
      family: 'timing',
      mutation: 'zero_interval',
      expect: 'not_established',
      critical: true,
      note: 'P8: the first flight after the maintenance is not zero flight hours after it (Z-1).',
      edit: (c) =>
        resentence(
          c,
          '[[case:ANC14FA050]]',
          'In the Piper PA 12 case, the accident flight was the airplane’s first flight, zero flight hours after maintenance and modification over several years, and its elevator control cables had been rigged in reverse [[case:ANC14FA050]].',
        ),
    },
    {
      id: 'second',
      family: 'timing',
      mutation: 'wrong_ordinal',
      expect: 'contradicted',
      critical: true,
      note: 'P8: the accident flight was the first flight after the maintenance and modification.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ANC14FA050]]',
          'In the Piper PA 12 case, the accident flight was the airplane’s second flight after maintenance and modification over several years, and its elevator control cables had been rigged in reverse [[case:ANC14FA050]].',
        ),
    },
    {
      id: 'pilot',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P6: the mechanic rigged the aileron cables; the pilot’s checks failed to detect it.',
      edit: (c) => {
        caseOf(c, 'ERA20CA246').why =
          'The pilot rigged the aileron control cables incorrectly, which reversed his aileron inputs during the takeoff; the mechanic’s post-maintenance inspection did not detect it.';
      },
    },
    {
      id: 'context',
      family: 'attribution',
      mutation: 'quote_context_loss',
      expect: 'not_established',
      critical: true,
      note: 'P3: "at that time" is the annual inspection, named in the sentences around it; read alone the excerpt does not say when.',
      edit: (c) => {
        caseOf(c, 'ERA14LA015').quotes[1] = q('P3', 'The airframe maintenance records indicated that the left hand and right hand elevator cables were replaced at that time.');
      },
    },
    {
      id: 'verified',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P5: maintenance personnel failed to verify the rigging.',
      edit: (c) => {
        caseOf(c, 'ERA23LA002').why = 'Maintenance personnel rigged the elevator cables in reverse although they verified the rigging during post-maintenance checks; the pilot’s preflight check did not detect it.';
      },
    },
    {
      id: 'himself',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'P8: the pilot often performed maintenance on the airplane, but no one knew who performed the maintenance on the elevator controls.',
      edit: (c) => {
        caseOf(c, 'ANC14FA050').why =
          'On the airplane’s first flight after maintenance and modification over several years, its elevator control cables, which the pilot had rigged himself, were reversed, and his preflight inspection did not detect it.';
      },
    },
  ],
  mixed: [
    { id: 'mix-zero-pilot', errors: ['zero', 'pilot'], note: 'A zero interval and a wrong actor, in two cases.' },
    { id: 'mix-context-verified', errors: ['context', 'verified'], note: 'A context-losing excerpt and a negation, in two cases.' },
  ],
};

const CONTROLS_CLAIMS: ClaimBatch = {
  id: 'holdout16d.controls-claims',
  bundle: 'q16d-controls',
  cases: ['CEN15IA079', 'ERA14LA015', 'ERA23LA002', 'ERA20CA246', 'ANC14FA050', 'WPR15FA158'],
  readings: FIRST_ONLY,
  claims: [
    yes('anc14.ff', 'timing', 'ANC14FA050', ['P8'], timing(WORK_050, { relation: 'flight_ordinal', value: 1 }), 'P8: the first flight after the maintenance and modification.', { provenance: 'constructed' }),
    yes('anc14.ff-match', 'criterion', 'ANC14FA050', ['P8'], firstFlight(WORK_050), 'P8: the first flight (FF-O).', {
      provenance: 'constructed',
      criterion: 'first_flight_only',
      decision: 'matches',
    }),
    no(
      'anc14.window',
      'criterion',
      'ANC14FA050',
      ['P8'],
      within(WORK_050),
      'timing',
      'first_flight_window',
      'not_established',
      'The first flight alone never settles a calendar-day or flight-hour window (G6); the work spanned several years and no completion date is given.',
      { critical: true, criterion: 'timing_window', decision: 'matches' },
    ),
    no(
      'anc14.zero',
      'timing',
      'ANC14FA050',
      ['P8'],
      timing(WORK_050, { relation: 'calendar_days', value: 0, bound: 'exact' }),
      'timing',
      'zero_interval',
      'not_established',
      'The first flight after the work is not a zero-day interval (Z-1).',
      { critical: true },
    ),
    no(
      'anc14.ff-unsettled',
      'criterion',
      'ANC14FA050',
      'all',
      firstFlightUnsettled(WORK_050),
      'timing',
      'settled_as_unknown',
      'contradicted',
      'P8 settles it: the accident flight was the first flight after the maintenance and modification (FF-O).',
      { critical: true, absence: true, criterion: 'first_flight_only', decision: 'unknown' },
    ),
    no(
      'cen15.pilot',
      'why',
      'CEN15IA079',
      ['P1'],
      'The pilot replaced the elevator trim actuator before the postmaintenance test flight.',
      'attribution',
      'wrong_actor',
      'contradicted',
      'P1: the airframe and powerplant mechanic replaced it.',
    ),
    yes(
      'cen15.reversed',
      'why',
      'CEN15IA079',
      ['P1'],
      'Moving the elevator trim wheel to the full nose-down position moved the elevator trim tab down, which would place the airplane in a nose-up configuration: the elevator trim control was reversed.',
      'P1.',
    ),
    no(
      'cen15.checked',
      'why',
      'CEN15IA079',
      ['P1'],
      'During his postmaintenance inspection, the mechanic made sure that the trim tabs moved in the correct direction.',
      'contradiction',
      'negation',
      'contradicted',
      'P1: he did not ensure it.',
    ),
    yes(
      'wpr15.cables',
      'why',
      'WPR15FA158',
      ['P11'],
      'Four aileron cables had been replaced during the maintenance, and the aileron balance and drive cables in the right wing had been misrouted and interchanged at the wing root.',
      'P11.',
    ),
    no(
      'wpr15.confirmed',
      'why',
      'WPR15FA158',
      ['P10', 'P11'],
      'A second mechanic confirmed the correct operation of the ailerons before the flight.',
      'contradiction',
      'negation',
      'contradicted',
      'P10: the other mechanic was never asked to, nor did he, confirm it; P11: he denied conducting such a check.',
    ),
    yes(
      'era14.pc',
      'attribution',
      'ERA14LA015',
      ['P4'],
      said(
        'investigators',
        "The incorrect (reverse) rigging of the elevator cables by maintenance personnel and their subsequent failure to verify that the rigging was correct during postmaintenance checks and the pilot's inadequate preflight check.",
      ),
      'P4, the probable cause, whole.',
    ),
    no(
      'era14.handbook',
      'why',
      'ERA14LA015',
      ['P3'],
      'The airplane’s operating instructions did not ask the pilot to check the controls before flight.',
      'contradiction',
      'negation',
      'contradicted',
      'P3: the preflight instructions say the pilot should ascertain that all controls operate normally and are in proper position.',
    ),
    no(
      'era20.landing',
      'why',
      'ERA20CA246',
      ['P6'],
      'The reversed aileron control inputs occurred during the landing.',
      'contradiction',
      'wrong_value',
      'contradicted',
      'P6: during the takeoff.',
    ),
    yes(
      'era23.pc',
      'attribution',
      'ERA23LA002',
      ['P5'],
      said(
        'investigators',
        "The incorrect (reverse) rigging of the elevator cables by maintenance personnel and their subsequent failure to verify that the rigging was correct during post-maintenance checks and the pilot's inadequate preflight check.",
      ),
      'P5, the probable cause, whole.',
    ),
  ],
};

export const V2_HOLDOUT_CLAIM_BATCHES: readonly ClaimBatch[] = [
  MAGNETO_CLAIMS,
  CARBURETOR_CLAIMS,
  PROPELLER_CLAIMS,
  DAY_AFTER_CLAIMS,
  HELICOPTER_CLAIMS,
  SELECTOR_CLAIMS,
  ROTOR_CLAIMS,
  THROTTLE_CLAIMS,
  CONTROLS_CLAIMS,
];
export const V2_HOLDOUT_BRIEFS: readonly BriefSpec[] = [
  H1,
  H2,
  variant(H2, 'holdout16d.carburetor-any', {}, 'No reading: no criterion claims.'),
  H3,
  H4,
  variant(H4, 'holdout16d.day-after-hours', TEN_FLIGHT_HOURS, 'Within 10 flight hours (pinned): the day before and the same day settle no flight hours (TW-C), so every timing decision is unknown.'),
  H5,
  variant(H5, 'holdout16d.helicopter-days', THIRTY_DAYS, 'Within 30 calendar days (pinned): no passage dates the work, and the first flight and flight hours settle no calendar days, so both decisions are unknown.'),
  H6,
  variant(H6, 'holdout16d.selector-hours', HUNDRED_FLIGHT_HOURS, 'Within 100 flight hours (pinned): calendar days, about 98.1 operating hours, the first flight and "recently" settle no flight hours, so every timing decision is unknown.'),
  H7,
  H8,
  H9,
];

export { FIRST_ONLY, SHORTLY, variant, window };
