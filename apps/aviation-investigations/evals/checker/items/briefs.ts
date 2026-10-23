/**
 * Complete briefs: compositions as the answer model would write them for real retrieval
 * bundles (passage aliases, as the model sees them), rendered into check inputs by the
 * production code. Each supported brief is wholly supported (every rendered claim
 * model-reviewed against the complete supplied passages; claims that say "under the
 * timing rules" by those rules). Each error variant edits one field so that exactly one
 * rendered claim changes (the builder refuses anything else): that claim is the brief's
 * one known error.
 *
 * Reading variants of a composition are separate supported briefs (the criteria claims
 * differ); errors are put into the main variant only.
 */
import type { ReadingState } from '../../../server/briefs/clarify.js';
import { splitSentences } from '../../../server/briefs/sentences.js';
import type { ComposeOutput } from '../../../shared/contracts/briefs.js';
import type { BriefSpec } from '../types.js';

type Composition = ComposeOutput;
type Case = Composition['cases'][number];
type Speaker = Case['quotes'][number]['speaker'];

const q = (passageId: string, quote: string, speaker: Speaker = 'investigators') => ({ passageId, quote, speaker });
const window = (days: number | null, flightHours: number | null, pinned = false): ReadingState => ({ timingWindow: { value: { days, flightHours }, pinned } });
const SHORTLY = window(30, 10);
const FIRST_ONLY: ReadingState = { firstFlightOnly: { value: true, pinned: false } };

const caseOf = (c: Composition, ntsbNo: string): Case => {
  const k = c.cases.find((x) => x.ntsbNo === ntsbNo);
  if (!k) throw new Error(`no case ${ntsbNo}`);
  return k;
};
/** Replace one summary sentence (as the validator splits it, matched by a unique fragment) with another. */
const resentence = (c: Composition, fragment: string, sentence: string) => {
  const parts = splitSentences(c.summary);
  const at = parts.flatMap((s, i) => (s.includes(fragment) ? [i] : []));
  if (at.length !== 1) throw new Error(`no unique sentence with "${fragment}"`);
  parts[at[0]!] = sentence;
  c.summary = parts.join(' ');
};

// ---------------------------------------------------------------------------
// Development

/** q-power-loss-maintenance (the paid run's bundle): the brief the paid run should have produced. */
const POWER_LOSS: Composition = {
  outcome: 'answer',
  summary: [
    'In the Grumman AA-5 case, the mechanic completed an annual inspection immediately before the flight but did not adequately inspect the fuel system, and fuel contamination caused a partial loss of engine power in the initial climb [[case:CEN15FA269]].',
    "In the Vans RV-6 case, the engine lost all power on the third flight after new engine systems were installed, and investigators attributed the loss to the pilot's failure to properly secure an alternator ground cable swage [[case:WPR18LA021]].",
    'In the Zenith CH-650 and Boeing PT-17 cases, investigators attributed the power losses to improper maintenance of the fuel system and of the magneto, but the passages do not say how long after that maintenance the engines failed [[case:ERA20LA050]] [[case:WPR23LA307]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['CEN15FA269', 'WPR18LA021', 'ERA20LA050', 'WPR23LA307'] }],
  cases: [
    {
      ntsbNo: 'CEN15FA269',
      why: "A mechanic's annual inspection completed immediately before the flight did not find fuel contamination that caused a partial loss of engine power in the initial climb.",
      quotes: [
        q(
          'P4',
          'Based on the amount of fuel contamination observed after the accident, the mechanic did not adequately inspect the entire fuel system during the annual inspection that he completed immediately before the flight.',
        ),
        q('P5', "Also causal was the mechanic's inadequate inspection of the airplane fuel system, which resulted in the partial loss of engine power due to fuel contamination."),
      ],
      evidencePassageIds: ['P4', 'P5'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P5'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P5'] },
      chronology: { maintenance: 'the annual inspection', facts: [{ anchor: 'relevant_maintenance', relation: 'immediately_before', passageIds: ['P4'] }] },
    },
    {
      ntsbNo: 'WPR18LA021',
      why: 'On the third flight after new engine systems were installed, an improperly secured alternator ground cable swage led to problems with the electrical system or electronic engine controls and a total loss of engine power.',
      quotes: [
        q(
          'P7',
          'The pilot’s failure to properly secure an alternator ground cable swage that led to problems with the electrical system and/or electronic engine controls, which resulted in a total loss of engine power.',
        ),
        q('P6', 'The airborne segment of the first flight subsequent to the installation of the new engine systems lasted about 5 minutes.'),
      ],
      evidencePassageIds: ['P7'],
      symptom: { value: 'total_power_loss', passageIds: ['P7'] },
      chronology: {
        maintenance: 'the installation of the new engine systems',
        facts: [
          { anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 3, passageIds: ['P6'] },
          { anchor: 'other', other: 'the second flight', relation: 'calendar_days', value: 2, bound: 'exact', passageIds: ['P6'] },
        ],
      },
    },
    {
      ntsbNo: 'ERA20LA050',
      why: 'Investigators attributed a total loss of engine power to improper maintenance practices on the fuel system that caused fuel starvation.',
      quotes: [q('P3', 'Improper maintenance practices on the fuel system causing fuel starvation and a total loss of engine power.')],
      evidencePassageIds: ['P2', 'P3'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P3'] },
      symptom: { value: 'total_power_loss', passageIds: ['P3'] },
      chronology: { maintenance: 'the fuel system maintenance', facts: [] },
    },
    {
      ntsbNo: 'WPR23LA307',
      why: 'Investigators attributed a partial loss of engine power in the initial climb to improper maintenance of the magneto.',
      quotes: [q('P1', 'A partial loss of engine power during the initial climb out due to improper maintenance of the magneto.')],
      evidencePassageIds: ['P1'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P1'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P1'] },
      chronology: { maintenance: 'the magneto maintenance', facts: [] },
    },
  ],
  gaps: [{ ntsbNo: 'CEN24LA107', note: 'The supplied passage gives a loss of engine power after takeoff for undetermined reasons and does not mention maintenance.', passageIds: ['P8'] }],
};

/** q-first-flight-annual, read as the first flight only. */
const FIRST_FLIGHT: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper PA-14 case, the engine lost power just after takeoff on the first flight after the annual inspection, and investigators could not determine why [[case:ANC21LA096]].',
    'In the Cessna P210N case, the engine ran rough on the first flight since the annual inspection because fuel lines loosened in flight, likely because the mechanic did not tighten them adequately after removing them during the inspection [[case:WPR14LA118]].',
    'In the Champion 7EC case, an inadequate annual inspection missed a deteriorated fuel line and a misrigged fuel selector, but the passages describe the accident flight as the first after a period of inactivity, not as the first after the inspection [[case:CEN16LA251]].',
  ].join(' '),
  groups: [
    { kind: 'causal', caseNumbers: ['WPR14LA118', 'CEN16LA251'] },
    { kind: 'no_fault', caseNumbers: ['ANC21LA096'] },
  ],
  cases: [
    {
      ntsbNo: 'ANC21LA096',
      why: "The engine lost power just after takeoff on the first flight after the airplane's annual inspection, and examination found no anomalies that would explain it.",
      quotes: [
        q('P1', 'The accident flight was the first flight after the airplane’s annual inspection.'),
        q('P2', 'A total loss of engine power during takeoff for reasons that could not be determined based on the available information.'),
      ],
      evidencePassageIds: ['P1'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P1'] },
      symptom: { value: 'total_power_loss', passageIds: ['P2'] },
      chronology: { maintenance: 'the annual inspection', facts: [{ anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P1'] }] },
    },
    {
      ntsbNo: 'WPR14LA118',
      why: 'On the first flight since its annual inspection, fuel lines that the mechanic had likely not tightened adequately loosened in flight, and the engine ran rough from fuel starvation.',
      quotes: [
        q('P6', 'Fuel starvation due to the in-flight loosening of the fuel lines attached to the fuel flow indicator as a result of inadequate maintenance.'),
        q('P5', 'It is likely that the mechanic failed to adequately tighten the fuel lines when he reinstalled them.'),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      symptom: { value: 'rough_running', passageIds: ['P5'] },
      chronology: {
        maintenance: 'the annual inspection',
        facts: [
          { anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P5'] },
          { anchor: 'relevant_maintenance', relation: 'calendar_days', value: 42, bound: 'about', passageIds: ['P5'] },
        ],
      },
    },
    {
      ntsbNo: 'CEN16LA251',
      why: 'An inadequate annual inspection failed to detect a deteriorated fuel line and a misrigged fuel selector, which resulted in fuel starvation and a total loss of engine power on the first flight after an extended period of inactivity.',
      quotes: [
        q(
          'P12',
          'The inadequate annual inspection of the fuel system that failed to detect a deteriorated fuel line and a misrigged fuel selector, which resulted in fuel starvation and a subsequent total loss of engine power.',
        ),
        q('P11', 'The airline transport pilot was conducting the first flight in the airplane after an extended period of inactivity.'),
      ],
      evidencePassageIds: ['P11', 'P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      symptom: { value: 'total_power_loss', passageIds: ['P12'] },
      chronology: {
        maintenance: 'the annual inspection',
        facts: [
          { anchor: 'relevant_maintenance', relation: 'words', passageIds: ['P11'] },
          { anchor: 'other', other: 'an extended period of inactivity', relation: 'flight_ordinal', value: 1, passageIds: ['P11'] },
        ],
      },
    },
  ],
  gaps: [],
};

/** q-day-after-maintenance. */
const DAY_AFTER: Composition = {
  outcome: 'answer',
  summary: [
    'In the Cessna 150F case, the engine lost all power on the first flight after a major overhaul and annual inspection, because the mechanic had installed the No. 1 cylinder rocker arms improperly [[case:NYC08LA137]].',
    'In the Diamond DA20 case, the mechanic did not properly secure the oil sump drain plug during a 100-hour inspection, but the passage does not say how long after the inspection the engine failed [[case:ERA21LA250]].',
    'In the Beech A35 case, a mechanic worked on the airplane the day before the accident and told the pilot not to fly until an oil line was replaced, and the spinner bulkhead separated during takeoff from fatigue cracking [[case:WPR18FA171]].',
    'In the Piper PA-32R case, a stabilator control cable turnbuckle separated from stress corrosion cracking about 1 flight hour after the annual inspection [[case:CEN11LA048]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['NYC08LA137', 'ERA21LA250', 'WPR18FA171', 'CEN11LA048'] }],
  cases: [
    {
      ntsbNo: 'NYC08LA137',
      why: 'On the first flight after a major engine overhaul and annual inspection, improperly installed rocker arms starved the No. 1 cylinder of oil and the engine lost all power.',
      quotes: [
        q('P11', "The mechanic's improper maintenance installation of the No. 1 cylinder rocker arms which led to oil starvation and a loss of engine power."),
        q('P10', 'The accident flight was the first flight after the work was completed.'),
      ],
      evidencePassageIds: ['P10', 'P11'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P11'] },
      symptom: { value: 'total_power_loss', passageIds: ['P10'] },
      chronology: {
        maintenance: 'the major engine overhaul and annual inspection',
        facts: [{ anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P10'] }],
      },
    },
    {
      ntsbNo: 'ERA21LA250',
      why: 'The mechanic did not properly secure the oil sump drain plug during a 100-hour inspection, and the engine lost all power from oil starvation.',
      quotes: [
        q(
          'P3',
          'The mechanic’s failure to properly secure the oil sump drain plug during a 100-hour maintenance inspection, which resulted in a total loss of engine power due to oil starvation.',
        ),
      ],
      evidencePassageIds: ['P3'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P3'] },
      symptom: { value: 'total_power_loss', passageIds: ['P3'] },
      chronology: { maintenance: 'the 100-hour inspection', facts: [] },
    },
    {
      ntsbNo: 'WPR18FA171',
      why: 'The spinner bulkhead separated during takeoff from fatigue cracking, and the pilot lost control during an attempted return; he had flown an airplane that was not airworthy.',
      quotes: [
        q(
          'P2',
          "The pilot's failure to maintain airplane control during an attempted return to the airport following the separation of the spinner bulkhead during takeoff as a result of fatigue cracking.",
        ),
      ],
      evidencePassageIds: ['P2'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P1', 'P2'] },
      chronology: {
        maintenance: "the mechanic's work on the airplane",
        facts: [{ anchor: 'relevant_maintenance', relation: 'previous_day', passageIds: ['P1'] }],
      },
    },
    {
      ntsbNo: 'CEN11LA048',
      why: 'A stabilator control cable turnbuckle separated from stress corrosion cracking during takeoff, and the airplane went out of control.',
      quotes: [
        q('P5', 'The separation of a stabilator control cable turnbuckle due to stress corrosion cracking, which resulted in a loss of airplane control during takeoff.'),
        q('P4', 'The airplane had accumulated about 1 hour of flight time since the previous annual inspection.'),
      ],
      evidencePassageIds: ['P5'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P4', 'P5'] },
      chronology: {
        maintenance: 'the annual inspection completed on November 1, 2009',
        facts: [{ anchor: 'relevant_maintenance', relation: 'flight_hours', value: 1, bound: 'about', passageIds: ['P4'] }],
      },
    },
  ],
  gaps: [],
};

/** q-midair-two-airplanes, as a question that is not about a mechanical cause (one `examples` group). */
const MIDAIR_EXAMPLES: Composition = {
  outcome: 'answer',
  summary: [
    "In the air race case, the race 13 airplane collided with race 37 while overtaking it, and investigators cited the race 13 pilot's failure to maintain clearance [[case:WPR18LA267]].",
    'In the formation flight case, the Navion in the number four position struck the Yak-52 from underneath during a left turn [[case:WPR23LA129]].',
    'Two powered parachutes collided in an airpark traffic pattern after neither pilot saw the other in time or used a radio [[case:CEN13LA506]].',
    "In the balloon case, the higher Balony balloon's basket struck the lower Balloon Works balloon's envelope during a competition ascent, and investigators cited the Balony pilot's failure to see and avoid it [[case:GAA15CA157]].",
  ].join(' '),
  groups: [{ kind: 'examples', caseNumbers: ['WPR18LA267', 'WPR23LA129', 'CEN13LA506', 'GAA15CA157'] }],
  cases: [
    {
      ntsbNo: 'WPR18LA267',
      why: 'During a closed course air race, the race 13 pilot failed to keep clear of race 37 while overtaking it, and the airplanes collided.',
      quotes: [
        q('P5', "The pilot of the race 13 airplane's failure to maintain clearance from the race 37 airplane during the closed course air race."),
        q('P4', 'The pilot of race 13 failed to maintain adequate separation from race 37 while overtaking the other airplane.'),
      ],
      evidencePassageIds: ['P4', 'P5'],
    },
    {
      ntsbNo: 'WPR23LA129',
      why: 'In a four-airplane formation turn, the number four airplane rose into the number three airplane from underneath.',
      quotes: [
        q(
          'P9',
          'The pilot of the Ryan Navion’s failure to maintain visual sight of and clearance from another airplane during a formation flight, which resulted in a mid-air collision.',
        ),
        q('P8', 'When the pilot of the number four airplane “felt to level off”, his airplane collided with the number three airplane from underneath.', 'pilot'),
      ],
      evidencePassageIds: ['P8', 'P9'],
    },
    {
      ntsbNo: 'CEN13LA506',
      why: 'Two powered parachutes collided in midair while flying the pattern at a private airpark; neither pilot used a radio or noticed the other until immediately before the collision.',
      quotes: [
        q(
          'P7',
          'The failure of both pilots, one of whom was noncertificated, to maintain adequate visual lookout while maneuvering to land, which resulted in a midair collision.',
        ),
        q('P6', 'Neither pilot was using their handheld radio to broadcast their intended traffic patterns.'),
      ],
      evidencePassageIds: ['P6', 'P7'],
    },
    {
      ntsbNo: 'GAA15CA157',
      why: 'The basket of the higher Balony balloon collided with the envelope of the Balloon Works balloon below it during an ascent.',
      quotes: [
        q(
          'P12',
          'The failure of the Balony balloon pilot to see and avoid the Balloon Works balloon during an ascent, which resulted in the basket of the Balony balloon colliding vertically with the envelope of the Balloon Works balloon.',
        ),
        q(
          'P11',
          'The Balloon Works balloon pilot, who was lower than the Balony balloon during the ascent, reported that his envelope collided vertically with the basket of the Balony balloon, about 2,000 feet above the ground.',
          'pilot',
        ),
      ],
      evidencePassageIds: ['P11', 'P12'],
    },
  ],
  gaps: [],
};

/** q-midair-two-airplanes as asked (one airplane had just had maintenance): an abstention with gap notes. */
const MIDAIR_ABSTAIN: Composition = {
  outcome: 'no_supported_match',
  summary: '',
  groups: [],
  cases: [],
  gaps: [
    { ntsbNo: 'WPR23LA129', note: 'The supplied passages describe a formation midair collision and do not mention maintenance of either airplane.', passageIds: ['P8', 'P9'] },
    {
      ntsbNo: 'GAA17CA458',
      note: 'The supplied passages describe a collision while taxiing after the lead airplane’s engine quit, and do not mention maintenance.',
      passageIds: ['P1'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Held out

/** q-oil-change. */
const OIL_CHANGE: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper PA46 case, the engine lost power from oil starvation after the oil suction screen plug, removed and reinstalled during a turbocharger replacement and oil change at most 11 days earlier, was left loose without safety wire [[case:CEN23LA246]].',
    'In the Piper PA-28-180 case, the engine lost all power on the first flight after a 100-hour inspection because the mechanic had not applied the appropriate torque to the oil filter [[case:ERA12LA469]].',
    'In the Bellanca 17-30A and Cirrus SR22 cases, investigators linked the power losses to an unsecured oil filter adapter and to a missed oil filter examination, but the passages give no time from that maintenance to the failure [[case:CEN24LA152]] [[case:CEN19LA320]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['CEN23LA246', 'ERA12LA469', 'CEN24LA152', 'CEN19LA320'] }],
  cases: [
    {
      ntsbNo: 'CEN23LA246',
      why: 'A mechanic who replaced the turbocharger and the engine oil did not properly secure the oil suction screen plug, and the resulting oil leak starved the engine of oil.',
      quotes: [
        q(
          'P8',
          'The mechanic’s failure to properly secure the oil suction screen plug during recent maintenance, which resulted in an oil leak and subsequent loss of engine power due to oil starvation.',
        ),
        q('P7', 'Eleven days before the accident flight, the pilot observed decreased engine manifold pressure and a partial loss of engine power.'),
      ],
      evidencePassageIds: ['P7', 'P8'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P8'] },
      symptom: { value: 'total_power_loss', passageIds: ['P7'] },
      chronology: {
        maintenance: 'the turbocharger replacement and oil change',
        facts: [{ anchor: 'relevant_maintenance', relation: 'calendar_days', value: 11, bound: 'at_most', passageIds: ['P7'] }],
      },
    },
    {
      ntsbNo: 'ERA12LA469',
      why: 'On the first flight after a 100-hour inspection, the engine lost all power from oil exhaustion because the mechanic had not applied the appropriate torque to the oil filter.',
      quotes: [
        q('P6', "A total loss of engine power as a result of oil exhaustion due to the mechanic's failure to apply appropriate torque to the oil filter."),
        q('P5', 'The accident flight was the first following a 100-hour maintenance inspection.'),
      ],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      symptom: { value: 'total_power_loss', passageIds: ['P6'] },
      chronology: { maintenance: 'the 100-hour inspection', facts: [{ anchor: 'relevant_maintenance', relation: 'flight_ordinal', value: 1, passageIds: ['P5'] }] },
    },
    {
      ntsbNo: 'CEN24LA152',
      why: 'Maintenance personnel did not properly secure the oil filter adapter when replacing its gasket, and the engine lost its oil and then all power.',
      quotes: [
        q(
          'P4',
          'Maintenance personnel’s failure to properly secure the oil filter adapter when replacing the oil filter adapter gasket which resulted in the filter becoming loose, resulting in the loss of engine oil, and the subsequent total loss of engine power.',
        ),
      ],
      evidencePassageIds: ['P4'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P4'] },
      symptom: { value: 'total_power_loss', passageIds: ['P4'] },
      chronology: { maintenance: 'the oil filter adapter gasket replacement', facts: [] },
    },
    {
      ntsbNo: 'CEN19LA320',
      why: "The No. 1 connecting rod separated after its piston pin bushing migrated, and the mechanic's failure to follow guidance during the latest oil change contributed.",
      quotes: [
        q('P12', 'A catastrophic engine failure and forced landing due to the separation of the No. 1 connecting rod as a result of migration of the connecting rod piston pin bushing.'),
        q(
          'P12',
          'Contributing to the accident was the mechanic’s failure to follow manufacturer guidance during the most recent oil change, which likely would have detected bushing material lost from the rod piston pin, which would have indicated impending migration and connecting rod failure.',
        ),
      ],
      evidencePassageIds: ['P12'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P12'] },
      symptom: { value: 'total_power_loss', passageIds: ['P11'] },
      chronology: { maintenance: 'the most recent oil change', facts: [] },
    },
  ],
  gaps: [
    {
      ntsbNo: 'ERA11FA414',
      note: 'The supplied passages give no date for the accident, so the time since the owner’s oil change on July 6, 2011 is not stated.',
      passageIds: ['P1'],
    },
  ],
};

/** q-engine-replaced. */
const ENGINE_REPLACED: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper PA-46-350P case, two engine through bolts and the No. 2 cylinder studs failed from fatigue about 198 hours after all six cylinders were replaced, but investigators did not establish whether the installation or service wear reduced the clamping force [[case:CEN17LA292]].',
    "In the Cessna 172N and Piper PA-46-310P cases, investigators attributed the power losses to an overhaul facility's improper installation of connecting rod bolts and to a mechanic's unsecured fuel lines after a starter adapter replacement [[case:CEN10LA123]] [[case:ERA10IA147]].",
    'In the Piper PA-28RT-201T case, a crankshaft counterweight failed from fatigue about 1,130 hours and about 19 years after the last overhaul, and investigators found improper bushing installation during that overhaul not likely [[case:ERA15LA377]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['CEN17LA292', 'CEN10LA123', 'ERA10IA147', 'ERA15LA377'] }],
  cases: [
    {
      ntsbNo: 'CEN17LA292',
      why: 'About 198 hours after all six cylinders were replaced, fatigue failures of two through bolts and the No. 2 cylinder studs caused a total loss of engine power in cruise flight.',
      quotes: [
        q('P7', 'The total loss of engine power, which resulted from fatigue failure of two engine through bolts and the No. 2 cylinder attachment studs due to the lack of sufficient clamping force.'),
        q('P6', 'The engine failure occurred about 198 hours after the cylinders were replaced.'),
      ],
      evidencePassageIds: ['P6', 'P7'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P6'] },
      symptom: { value: 'total_power_loss', passageIds: ['P7'] },
      chronology: {
        maintenance: 'the replacement of all 6 cylinders',
        facts: [{ anchor: 'relevant_maintenance', relation: 'flight_hours', value: 198, bound: 'about', passageIds: ['P6'] }],
      },
    },
    {
      ntsbNo: 'CEN10LA123',
      why: "The overhaul facility's improper installation of the connecting rod bolts during a recent overhaul led to their failure and a total loss of engine power.",
      quotes: [
        q(
          'P1',
          "A total loss of engine power due to the failure of the bolts that held in place the connecting rods to the engine's No. 3 and No. 4 cylinders as a result of the engine overhaul facility's improper installation of the bolts during a recent overhaul.",
        ),
      ],
      evidencePassageIds: ['P1'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P1'] },
      symptom: { value: 'total_power_loss', passageIds: ['P1'] },
      chronology: { maintenance: 'the recent overhaul', facts: [{ anchor: 'relevant_maintenance', relation: 'words', passageIds: ['P1'] }] },
    },
    {
      ntsbNo: 'ERA10IA147',
      why: 'After replacing the starter adapter, the mechanic did not properly secure the fuel control unit fuel lines, and the engine lost power.',
      quotes: [q('P5', 'A loss of engine power due to the mechanic’s failure to properly secure the fuel control unit fuel lines after replacement of the starter adapter.')],
      evidencePassageIds: ['P5'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P5'] },
      chronology: { maintenance: 'the starter adapter replacement', facts: [] },
    },
    {
      ntsbNo: 'ERA15LA377',
      why: 'A rear crankshaft counterweight separated from fatigue cracking consistent with a loose bushing, and the engine lost all power in cruise flight.',
      quotes: [
        q('P10', 'The fatigue failure of a crankshaft counterweight, which resulted in a total loss of engine power during cruise flight.'),
        q(
          'P9',
          'Although the failure mode evidence was consistent with a loose bushing, it was not likely due to improper installation given that the engine had operated for almost 7 years beyond its 12-year recommended TBO.',
        ),
      ],
      evidencePassageIds: ['P9', 'P10'],
      maintenance: { relation: 'preceding_not_established', passageIds: ['P9'] },
      symptom: { value: 'total_power_loss', passageIds: ['P10'] },
      chronology: {
        maintenance: 'the last overhaul',
        facts: [{ anchor: 'relevant_maintenance', relation: 'flight_hours', value: 1130, bound: 'about', passageIds: ['P9'] }],
      },
    },
  ],
  gaps: [],
};

/** q-fuel-line-fitting. */
const FUEL_LINE: Composition = {
  outcome: 'answer',
  summary: [
    'In the Piper PA-28R-200 case, maintenance a few days before the accident repositioned the fuel line to the engine-driven fuel pump, and the B-nut at the pump inlet was found loose after the engine lost power from fuel starvation [[case:WPR25LA046]].',
    'In the Piper PA-28 and Cessna TU206F cases, investigators attributed the power losses to a fuel hose B-nut that maintenance personnel had not tightened properly during an engine installation and to a loose fuel line fitting from an inadequate maintenance installation [[case:ERA09LA163]] [[case:LAX08LA269]].',
    'In the Schweizer G-164B case, an improperly fabricated fuel hose was blocked by a flap of its own inner wall, which starved the engine of fuel during takeoff [[case:WPR14LA201]].',
  ].join(' '),
  groups: [{ kind: 'causal', caseNumbers: ['WPR25LA046', 'ERA09LA163', 'LAX08LA269', 'WPR14LA201'] }],
  cases: [
    {
      ntsbNo: 'WPR25LA046',
      why: 'A few days after maintenance repositioned the fuel line to the engine-driven fuel pump, the B-nut at the pump inlet was loose and the engine lost power from fuel starvation.',
      quotes: [
        q('P2', 'A loss of engine power due to fuel starvation resulting from a loose B-nut at the engine-driven fuel-pump inlet.'),
        q('P1', 'The airplane had undergone maintenance a few days before the accident, which included repositioning the fuel line to the engine-driven fuel pump.'),
      ],
      evidencePassageIds: ['P1', 'P2'],
      chronology: { maintenance: 'the fuel line repositioning', facts: [{ anchor: 'relevant_maintenance', relation: 'words', passageIds: ['P1'] }] },
    },
    {
      ntsbNo: 'ERA09LA163',
      why: 'Maintenance personnel did not properly tighten a fuel hose B-nut during the engine installation, and the engine lost power.',
      quotes: [q('P6', 'A loss of engine power due to the improper tightening of a fuel hose B-nut by maintenance personnel during engine installation.')],
      evidencePassageIds: ['P5', 'P6'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P6'] },
      chronology: { maintenance: 'the engine installation', facts: [] },
    },
    {
      ntsbNo: 'LAX08LA269',
      why: 'A loose fuel line fitting from an inadequate maintenance installation caused a partial loss of engine power during the initial takeoff climb.',
      quotes: [q('P3', 'A loose fuel line fitting that resulted in a partial loss of engine power during the initial takeoff climb.')],
      evidencePassageIds: ['P3'],
      maintenance: { relation: 'investigator_attributed', passageIds: ['P3'] },
      symptom: { value: 'partial_power_loss', passageIds: ['P3'] },
      chronology: { maintenance: 'the installation of the fitting', facts: [] },
    },
    {
      ntsbNo: 'WPR14LA201',
      why: 'An improperly fabricated fuel hose, which the assembler did not verify was clear, caused fuel starvation and a total loss of engine power during takeoff.',
      quotes: [
        q(
          'P12',
          'The assembler’s improper fabrication of a fuel line (hose) and the subsequent failure to verify that it was not occluded, which resulted in fuel starvation and a total loss of engine power during takeoff.',
        ),
      ],
      evidencePassageIds: ['P11', 'P12'],
      symptom: { value: 'total_power_loss', passageIds: ['P12'] },
      chronology: { maintenance: 'the fabrication of the fuel hose', facts: [] },
    },
  ],
  gaps: [{ ntsbNo: 'CEN12CA075', note: 'The supplied passage names a loose fuel line fitting but does not say whether maintenance left it loose.', passageIds: ['P4'] }],
};

/** q-midair-maintenance, as a question that is not about a mechanical cause. */
const MIDAIR_HOLDOUT: Composition = {
  outcome: 'answer',
  summary: [
    'In the Cessna 150M and F-16 case, investigators found that the approach controller did not resolve the conflict between the two airplanes, with the limits of see-and-avoid contributing [[case:ERA15MA259]].',
    'In the other three cases, investigators found that both pilots, or both flight instructors, failed to see and avoid each other [[case:WPR13LA004]] [[case:CEN10LA099]] [[case:WPR12LA250]].',
  ].join(' '),
  groups: [{ kind: 'examples', caseNumbers: ['ERA15MA259', 'WPR13LA004', 'CEN10LA099', 'WPR12LA250'] }],
  cases: [
    {
      ntsbNo: 'ERA15MA259',
      why: 'The approach controller did not provide an appropriate resolution to the conflict between the F-16 and the Cessna.',
      quotes: [q('P2', "The approach controller's failure to provide an appropriate resolution to the conflict between the F-16 and the Cessna.")],
      evidencePassageIds: ['P2'],
    },
    {
      ntsbNo: 'WPR13LA004',
      why: 'Both flight instructors failed to see and avoid the other airplane while giving instrument flight training.',
      quotes: [q('P3', 'The failure of both flight instructors to see and avoid the other airplane while providing instrument flight training, which resulted in a midair collision.')],
      evidencePassageIds: ['P3'],
    },
    {
      ntsbNo: 'CEN10LA099',
      why: 'Both pilots failed to see and avoid the other aircraft while maneuvering at low altitude.',
      quotes: [q('P8', 'The failure of both pilots to see and avoid the other aircraft, which resulted in a midair collision while maneuvering at low altitude.')],
      evidencePassageIds: ['P8'],
    },
    {
      ntsbNo: 'WPR12LA250',
      why: 'Both pilots failed to see and avoid each other.',
      quotes: [q('P5', 'The failure of both pilots to see and avoid each other, which resulted in a midair collision.')],
      evidencePassageIds: ['P5'],
    },
  ],
  gaps: [{ ntsbNo: 'WPR19FA145', note: 'The supplied passage gives only the probable cause and does not mention maintenance of either airplane.', passageIds: ['P6'] }],
};

// ---------------------------------------------------------------------------

const variant = (base: BriefSpec, id: string, readings: ReadingState, note: string): BriefSpec => ({ ...base, id, readings, note, errors: [] });

const B1: BriefSpec = {
  id: 'dev.b1',
  bundle: 'q-power-loss-maintenance',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: POWER_LOSS,
  note: 'The paid run’s question and bundle; CEN15FA269 (the case it had to withhold) matches by rule TW-I.',
  errors: [
    {
      id: 'anchor',
      family: 'timing',
      mutation: 'wrong_anchor',
      expect: 'not_established',
      critical: true,
      note: 'The paid run’s regression (claims 10, 14): two days after the second flight read as two days after the installation.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR18LA021]]',
          "In the Vans RV-6 case, the engine lost all power two days after new engine systems were installed, and investigators attributed the loss to the pilot's failure to properly secure an alternator ground cable swage [[case:WPR18LA021]].",
        ),
    },
    {
      id: 'led-to',
      family: 'unsupported_addition',
      mutation: 'causal_overstatement',
      expect: 'not_established',
      critical: true,
      note: 'The paid run’s regression (claim 0): an inspection that missed the contamination presented as its cause.',
      edit: (c) => {
        caseOf(c, 'CEN15FA269').why =
          "A mechanic's annual inspection completed immediately before the flight led to fuel contamination that caused a partial loss of engine power in the initial climb.";
      },
    },
    {
      id: 'speaker',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'An analysis sentence presented as the pilot’s account.',
      edit: (c) => {
        caseOf(c, 'CEN15FA269').quotes[0]!.speaker = 'pilot';
      },
    },
    {
      id: 'symptom',
      family: 'contradiction',
      mutation: 'wrong_value',
      expect: 'contradicted',
      note: 'P1: a partial loss of engine power.',
      edit: (c) => {
        caseOf(c, 'WPR23LA307').symptom = { value: 'total_power_loss', passageIds: ['P1'] };
      },
    },
  ],
};

const B2: BriefSpec = {
  id: 'dev.b2',
  bundle: 'q-first-flight-annual',
  mechanicalCause: true,
  readings: FIRST_ONLY,
  composition: FIRST_FLIGHT,
  note: 'First flight only: two cases match (FF-O); CEN16LA251’s first flight is after inactivity, so it stays unconfirmed.',
  errors: [
    {
      id: 'anchor',
      family: 'timing',
      mutation: 'wrong_anchor',
      expect: 'not_established',
      note: 'P11: the first flight after inactivity, not after the inspection.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN16LA251]]',
          'In the Champion 7EC case, the accident flight was the first flight after an annual inspection that missed a deteriorated fuel line and a misrigged fuel selector [[case:CEN16LA251]].',
        ),
    },
    {
      id: 'negation',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P1: the examination found no anomalies.',
      edit: (c) => {
        caseOf(c, 'ANC21LA096').why =
          "The engine lost power just after takeoff on the first flight after the airplane's annual inspection, and examination found fuel system anomalies that explain it.";
      },
    },
    {
      id: 'excerpt',
      family: 'attribution',
      mutation: 'misleading_excerpt',
      expect: 'not_established',
      note: 'P5: the lines were tightened during the postaccident examination; the excerpt drops when and by whom.',
      edit: (c) => {
        caseOf(c, 'WPR14LA118').quotes[1] = q('P5', 'these lines were tightened about 1.5 turns');
      },
    },
    {
      id: 'unit',
      family: 'timing',
      mutation: 'unit_swap',
      expect: 'not_established',
      note: 'P5: about 6 weeks (calendar time), not flight hours.',
      edit: (c) => {
        caseOf(c, 'WPR14LA118').chronology!.facts[1] = { anchor: 'relevant_maintenance', relation: 'flight_hours', value: 42, bound: 'about', passageIds: ['P5'] };
      },
    },
  ],
};

const B3: BriefSpec = {
  id: 'dev.b3',
  bundle: 'q-day-after-maintenance',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: DAY_AFTER,
  note: 'WPR18FA171 matches by TW-C (the day before); the others stay unconfirmed (first flight, no time, about 1 hour).',
  errors: [
    {
      id: '24h',
      family: 'timing',
      mutation: 'previous_day_hours',
      expect: 'not_established',
      note: '"The day before" is a calendar date, not a number of hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR18FA171]]',
          'In the Beech A35 case, a mechanic worked on the airplane less than 24 hours before the accident and told the pilot not to fly until an oil line was replaced, and the spinner bulkhead separated during takeoff from fatigue cracking [[case:WPR18FA171]].',
        ),
    },
    {
      id: 'part',
      family: 'contradiction',
      mutation: 'wrong_value',
      expect: 'contradicted',
      note: 'P3: the oil sump drain plug, not the oil filter.',
      edit: (c) => {
        caseOf(c, 'ERA21LA250').why = 'The mechanic did not properly secure the oil filter during a 100-hour inspection, and the engine lost all power from oil starvation.';
      },
    },
    {
      id: 'actor',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P10, P11: the mechanic (the pilot’s friend) installed them.',
      edit: (c) =>
        resentence(
          c,
          '[[case:NYC08LA137]]',
          'In the Cessna 150F case, the engine lost all power on the first flight after a major overhaul and annual inspection, because the pilot had installed the No. 1 cylinder rocker arms improperly [[case:NYC08LA137]].',
        ),
    },
    {
      id: 'missed',
      family: 'unsupported_addition',
      mutation: 'added_detail',
      expect: 'not_established',
      note: 'No passage says the annual inspection missed the cracking.',
      edit: (c) => {
        caseOf(c, 'CEN11LA048').why =
          'A stabilator control cable turnbuckle that the annual inspection had missed separated from stress corrosion cracking during takeoff, and the airplane went out of control.';
      },
    },
  ],
};

const B4: BriefSpec = {
  id: 'dev.b4',
  bundle: 'q-midair-two-airplanes',
  mechanicalCause: false,
  readings: {},
  composition: MIDAIR_EXAMPLES,
  note: 'Multi-aircraft events, event-scoped passages: who did what to which aircraft.',
  errors: [
    {
      id: 'swap',
      family: 'attribution',
      mutation: 'wrong_aircraft',
      expect: 'contradicted',
      note: 'P4, P5: race 13 overtook race 37.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR18LA267]]',
          "In the air race case, the race 37 airplane collided with race 13 while overtaking it, and investigators cited the race 37 pilot's failure to maintain clearance [[case:WPR18LA267]].",
        ),
    },
    {
      id: 'speaker',
      family: 'attribution',
      mutation: 'wrong_speaker',
      expect: 'contradicted',
      note: 'P11: the Balloon Works pilot’s report, not a witness’s.',
      edit: (c) => {
        caseOf(c, 'GAA15CA157').quotes[1]!.speaker = 'witness';
      },
    },
    {
      id: 'negation',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P6: neither pilot was using a radio.',
      edit: (c) => {
        caseOf(c, 'CEN13LA506').why =
          'Two powered parachutes collided in midair while flying the pattern at a private airpark; both pilots were broadcasting their traffic patterns by radio, but neither noticed the other until immediately before the collision.';
      },
    },
  ],
};

const B4_ABSTAIN: BriefSpec = {
  id: 'dev.b4-abstain',
  bundle: 'q-midair-two-airplanes',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: MIDAIR_ABSTAIN,
  note: 'The question as asked: no case shows maintenance, so an abstention whose gap notes are absence claims.',
  errors: [
    {
      id: 'gap',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P1: the lead airplane stopped because its engine quit.',
      edit: (c) => {
        c.gaps[1] = { ntsbNo: 'GAA17CA458', note: 'The supplied passages describe a collision while taxiing and do not say why the lead airplane stopped.', passageIds: ['P1'] };
      },
    },
  ],
};

const B5: BriefSpec = {
  id: 'holdout.b5',
  bundle: 'q-oil-change',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: OIL_CHANGE,
  note: 'CEN23LA246 matches by TW-N (at most 11 days); the others stay unconfirmed.',
  errors: [
    {
      id: 'unit',
      family: 'timing',
      mutation: 'unit_swap',
      expect: 'not_established',
      note: 'P7: days, not flight hours.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN23LA246]]',
          'In the Piper PA46 case, the engine lost power from oil starvation after the oil suction screen plug, removed and reinstalled during a turbocharger replacement and oil change at most 11 flight hours earlier, was left loose without safety wire [[case:CEN23LA246]].',
        ),
    },
    {
      id: 'certainty',
      family: 'unsupported_addition',
      mutation: 'certainty_overstatement',
      expect: 'not_established',
      note: 'P12: the examination likely would have detected bushing material; nothing says it would have prevented the failure.',
      edit: (c) => {
        caseOf(c, 'CEN19LA320').why =
          'The No. 1 connecting rod separated after its piston pin bushing migrated, a failure that examining the oil filter during the latest oil change would have prevented.';
      },
    },
    {
      id: 'negation',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P4: the adapter was not properly secured.',
      edit: (c) => {
        caseOf(c, 'CEN24LA152').why =
          'Maintenance personnel properly secured the oil filter adapter when replacing its gasket, but the filter still came loose, and the engine lost its oil and then all power.';
      },
    },
  ],
};

const B6: BriefSpec = {
  id: 'holdout.b6',
  bundle: 'q-engine-replaced',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: ENGINE_REPLACED,
  note: 'Approximate hours and wording only: every case stays unconfirmed.',
  errors: [
    {
      id: 'anchor',
      family: 'timing',
      mutation: 'wrong_anchor',
      expect: 'contradicted',
      note: 'P6: about 825 hours after the overhaul the cylinders were replaced; the failure came about 198 hours after that.',
      edit: (c) =>
        resentence(
          c,
          '[[case:CEN17LA292]]',
          'In the Piper PA-46-350P case, two engine through bolts and the No. 2 cylinder studs failed from fatigue about 825 hours after all six cylinders were replaced, but investigators did not establish whether the installation or service wear reduced the clamping force [[case:CEN17LA292]].',
        ),
    },
    {
      id: 'negation',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P9: improper installation was not likely.',
      edit: (c) =>
        resentence(
          c,
          '[[case:ERA15LA377]]',
          'In the Piper PA-28RT-201T case, a crankshaft counterweight failed from fatigue about 1,130 hours and about 19 years after the last overhaul, and investigators found improper bushing installation during that overhaul likely [[case:ERA15LA377]].',
        ),
    },
    {
      id: 'actor',
      family: 'attribution',
      mutation: 'wrong_actor',
      expect: 'contradicted',
      note: 'P5: the mechanic.',
      edit: (c) => {
        caseOf(c, 'ERA10IA147').why = 'After replacing the starter adapter, the pilot did not properly secure the fuel control unit fuel lines, and the engine lost power.';
      },
    },
    {
      id: 'torque',
      family: 'unsupported_addition',
      mutation: 'causal_overstatement',
      expect: 'not_established',
      note: 'P6: insufficient torque at installation is one of two possibilities.',
      edit: (c) => {
        caseOf(c, 'CEN17LA292').why =
          'About 198 hours after all six cylinders were replaced, through bolts that the mechanic had not torqued enough failed from fatigue and caused a total loss of engine power in cruise flight.';
      },
    },
  ],
};

const B7: BriefSpec = {
  id: 'holdout.b7',
  bundle: 'q-fuel-line-fitting',
  mechanicalCause: true,
  readings: SHORTLY,
  composition: FUEL_LINE,
  note: '"A few days" is wording without a number: every case stays unconfirmed.',
  errors: [
    {
      id: 'words',
      family: 'timing',
      mutation: 'words_number',
      expect: 'not_established',
      note: 'P1: "a few days", not 3.',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR25LA046]]',
          'In the Piper PA-28R-200 case, maintenance 3 days before the accident repositioned the fuel line to the engine-driven fuel pump, and the B-nut at the pump inlet was found loose after the engine lost power from fuel starvation [[case:WPR25LA046]].',
        ),
    },
    {
      id: 'value',
      family: 'contradiction',
      mutation: 'wrong_value',
      expect: 'contradicted',
      note: 'P3: a partial loss of engine power.',
      edit: (c) => {
        caseOf(c, 'LAX08LA269').why = 'A loose fuel line fitting from an inadequate maintenance installation caused a total loss of engine power during the initial takeoff climb.';
      },
    },
    {
      id: 'excerpt',
      family: 'attribution',
      mutation: 'quote_context_loss',
      expect: 'not_established',
      note: 'The excerpt drops what could be rotated.',
      edit: (c) => {
        caseOf(c, 'WPR25LA046').quotes[1] = q('P1', 'could be rotated approximately one-half turn by hand before the fitting came off');
      },
    },
  ],
};

const B8: BriefSpec = {
  id: 'holdout.b8',
  bundle: 'q-midair-maintenance',
  mechanicalCause: false,
  readings: {},
  composition: MIDAIR_HOLDOUT,
  note: 'Multi-aircraft events, probable causes only.',
  errors: [
    {
      id: 'one',
      family: 'attribution',
      mutation: 'wrong_aircraft',
      expect: 'contradicted',
      note: 'P3, P5, P8: both pilots (both flight instructors).',
      edit: (c) =>
        resentence(
          c,
          '[[case:WPR13LA004]]',
          'In the other three cases, investigators found that only one of the pilots failed to see and avoid the other aircraft [[case:WPR13LA004]] [[case:CEN10LA099]] [[case:WPR12LA250]].',
        ),
    },
    {
      id: 'gap',
      family: 'contradiction',
      mutation: 'negation',
      expect: 'contradicted',
      note: 'P6: both pilots failed to see and avoid the other airplane.',
      edit: (c) => {
        c.gaps[0] = { ntsbNo: 'WPR19FA145', note: 'The supplied passage does not say why the two airplanes collided.', passageIds: ['P6'] };
      },
    },
  ],
};

export const BRIEFS: readonly BriefSpec[] = [
  B1,
  variant(B1, 'dev.b1-hours', window(null, 10), 'Flight hours only: TW-I settles no hours, so CEN15FA269 stays unconfirmed too.'),
  B2,
  B3,
  variant(B3, 'dev.b3-week', window(7, null, true), 'Seven calendar days: the day before still matches (TW-C).'),
  B4,
  B4_ABSTAIN,
  B5,
  variant(B5, 'holdout.b5-week', window(7, null, true), 'Seven calendar days: at most 11 days settles nothing (TW-N).'),
  B6,
  variant(B6, 'holdout.b6-first', FIRST_ONLY, 'First flight only: no case states which flight.'),
  B7,
  variant(B7, 'holdout.b7-first', FIRST_ONLY, 'First flight only: no case states which flight.'),
  B8,
];
