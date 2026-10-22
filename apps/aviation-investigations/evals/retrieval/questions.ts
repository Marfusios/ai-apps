/**
 * The silver retrieval questions and their derivation rules (amendment A13). Edit a
 * rule here, then rebuild `dataset.json` with `pnpm eval:retrieval:silver`; never edit
 * expected case numbers by hand.
 *
 * Patterns are PostgreSQL case-insensitive regular expressions (`~*`, ARE syntax; `\y`
 * is a word boundary) matched against one section's text at a time. Filters are what
 * the scope stage would extract from the question text; a question that names an
 * aircraft category has a single-aircraft rule (see `silver.ts`).
 *
 * The rules are deliberately narrow so each derives at most 20 cases. They are silver
 * labels: keyword rules miss paraphrases and can include near misses, which is what
 * expert adjudication is for.
 */
import type { QuestionSpec } from './silver.js';

const PC = ['probable_cause'] as const;
const AN = ['analysis'] as const;
const NARR = ['analysis', 'factual'] as const;
const PC_AN = ['probable_cause', 'analysis'] as const;
const r = String.raw;

const POWER_LOSS = r`loss of (engine )?power|lost (engine )?power|engine (lost power|stopped)`;
const UNDETERMINED_POWER_LOSS = r`loss of (engine )?power for (undetermined|unknown) reasons`;
const UNDETERMINED = r`undetermined|could not be determined|unknown|unable to be determined`;
const MAINTENANCE_FAULT = r`maintenance personnel|mechanic|improper(ly)? (maintenance|install|secur|torqu|assembl|rig)`;
const NO_ANOMALIES = r`no (evidence of )?(pre-?(impact|accident) )?(mechanical )?(anomalies|malfunctions|discrepancies)`;
const RECENT_HOURS = r`\y([0-9]|1[0-9])(\.\d+)? (flight |tach |hobbs |operating )?hours (before|prior to|earlier|since)`;
const FIRST_FLIGHT = r`first flight (after|following|since) (the |its )?(maintenance|annual|inspection|overhaul|installation|repair|restoration|engine)`;
const MIDAIR = r`midair|mid-air|see and avoid`;

export const QUESTIONS: readonly QuestionSpec[] = [
  // -------------------------------------------------------------------------
  // Seed cases (DATA_REVIEW.md), each alongside other cases its rule derives.
  {
    id: 'seed-2008-power-loss-after-maintenance',
    question: 'Find 2008 investigations involving engine power loss shortly after maintenance, an overhaul or a part replacement.',
    tags: ['seed', 'maintenance_timing'],
    filters: { yearFrom: 2008, yearTo: 2008 },
    criteria: {
      years: [2008, 2008],
      text: [
        { in: [...PC_AN], pattern: POWER_LOSS },
        {
          in: [...AN],
          pattern: r`(maintenance|overhaul|installed|replaced|inspection)[^.]{0,120}\y(\d+(\.\d+)?|one|two|three|several|few) (flight )?(hours|days|weeks|months) (prior to|before) the accident`,
        },
      ],
    },
    note: 'The motivating question (DESIGN §2) in 2008: a power loss plus an analysis sentence that dates maintenance, an overhaul, an installation or an inspection before the accident. Includes DFW08TA066 and NYC08LA106. Check that the dated work concerns the failed system.',
  },
  {
    id: 'seed-2008-unexplained-after-maintenance',
    question: 'Which 2008 engine power losses followed maintenance or test flights but stayed unexplained, with examinations finding no anomalies?',
    tags: ['seed', 'causal_uncertainty', 'negation'],
    filters: { yearFrom: 2008, yearTo: 2008 },
    criteria: {
      years: [2008, 2008],
      text: [
        { in: [...PC], pattern: UNDETERMINED_POWER_LOSS },
        { in: [...NARR], pattern: r`maintenance|test flight` },
        { in: [...AN], pattern: r`no (mechanical )?(anomalies|discrepancies|problems)` },
      ],
    },
    note: 'Undetermined power loss, maintenance or test flights mentioned, and a negative finding in the analysis. Includes DEN08LA103 and MIA08LA156. Check that the maintenance preceded the accident flight.',
  },

  // -------------------------------------------------------------------------
  // Negation
  {
    id: 'neg-carb-heat-alaska',
    question: 'In Alaska, which carburetor icing accidents happened because the pilot did not use carburetor heat?',
    tags: ['negation'],
    filters: { state: ['AK'] },
    criteria: {
      states: ['AK'],
      text: [
        { in: [...PC], pattern: r`carburetor ic` },
        { in: [...PC_AN], pattern: r`(did not|failure to|failed to|not) (use|apply|activate)[^.]{0,30}carburetor heat` },
      ],
    },
    note: 'Carburetor ice in the probable cause and a negated use of carburetor heat in the cause or analysis.',
  },
  {
    id: 'neg-stall-warning-silent',
    question: 'Between 2008 and 2014, find stall accidents where the stall warning did not sound or was not working.',
    tags: ['negation'],
    filters: { yearFrom: 2008, yearTo: 2014 },
    criteria: {
      years: [2008, 2014],
      text: [
        {
          in: [...NARR],
          pattern: r`(did not|didn.t|never|was not|wasn.t) (hear|sound|activate|work)[^.]{0,30}stall warning|stall warning[^.]{0,40}(did not|didn.t|never|was not|wasn.t|failed to) (sound|activate|work|function|operate)|no stall warning`,
        },
      ],
    },
    note: 'A negated stall warning in the narrative. Check that a stall was part of the accident sequence.',
  },
  {
    id: 'neg-gear-warning-silent',
    question: 'Landing gear accidents where the gear warning horn did not sound.',
    tags: ['negation'],
    filters: {},
    criteria: {
      text: [
        { in: [...PC], pattern: r`gear` },
        {
          in: [...NARR],
          pattern: r`(gear|landing gear) warning (horn |system |light )?(did not|didn.t|never|was not|wasn.t|failed to) (sound|activate|work|function|operate|illuminate)`,
        },
      ],
    },
    note: 'Gear in the probable cause and a gear warning that did not sound or work in the narrative.',
  },
  {
    id: 'neg-no-shoulder-harness',
    question: 'Accidents where an occupant was not wearing the available shoulder harness.',
    tags: ['negation'],
    filters: {},
    criteria: {
      text: [
        {
          in: [...PC_AN],
          pattern: r`(not|without) (wearing|using|use)[^.]{0,25}shoulder harness|shoulder harness[^.]{0,30}(was not|were not) (worn|used)`,
        },
      ],
    },
    note: 'A negated shoulder harness use in the cause or analysis.',
  },
  {
    id: 'neg-helicopter-elt-silent',
    question: 'Helicopter accidents where the emergency locator transmitter did not activate.',
    tags: ['negation'],
    filters: { category: ['HELI'] },
    criteria: {
      categoryAny: ['HELI'],
      maxAircraft: 1,
      text: [{ in: [...NARR], pattern: r`ELT[^.]{0,40}(did not|didn.t|failed to) activate` }],
    },
    note: 'Single helicopter; the narrative says the ELT did not activate.',
  },
  {
    id: 'neg-runway-lights-off',
    question: 'Accidents where the runway lights were off, had not been activated, or were not working.',
    tags: ['negation'],
    filters: {},
    criteria: {
      text: [
        {
          in: [...NARR],
          pattern: r`runway (edge )?lights[^.]{0,60}(were not|was not|weren.t|had not been|were off|inoperative)`,
        },
      ],
    },
    note: 'Negated or inoperative runway lights in the narrative. Check that the lighting mattered to the accident.',
  },
  {
    id: 'neg-no-weather-briefing',
    question: 'Fatal accidents in instrument conditions from 2015 to 2020 where the pilot did not obtain a weather briefing.',
    tags: ['negation'],
    filters: { injury: ['FATL'], yearFrom: 2015, yearTo: 2020 },
    criteria: {
      years: [2015, 2020],
      injury: ['FATL'],
      text: [
        { in: [...PC], pattern: r`instrument meteorological|IMC` },
        {
          in: [...PC_AN],
          pattern: r`did not (obtain|receive|request)[^.]{0,30}(weather )?briefing|no (record|evidence) of (a|the pilot obtaining|him obtaining) [^.]{0,30}briefing`,
        },
      ],
    },
    note: 'Instrument conditions in the probable cause and no weather briefing obtained (or no record of one) in the cause or analysis.',
  },
  {
    id: 'neg-fuel-not-checked',
    question: 'Fuel exhaustion accidents from 2016 to 2018 where the pilot did not check or verify the fuel on board.',
    tags: ['negation'],
    filters: { yearFrom: 2016, yearTo: 2018 },
    criteria: {
      years: [2016, 2018],
      text: [
        { in: [...PC], pattern: r`fuel exhaustion` },
        { in: [...PC_AN], pattern: r`(did not|failed to|not) (visually )?(check|verify|confirm|inspect|monitor)[^.]{0,40}fuel` },
      ],
    },
    note: 'Fuel exhaustion in the probable cause and a negated fuel check in the cause or analysis.',
  },
  {
    id: 'neg-helicopter-uncertificated-pilot',
    question: 'Helicopter accidents where the pilot did not hold a pilot certificate.',
    tags: ['negation', 'operational'],
    filters: { category: ['HELI'] },
    criteria: {
      categoryAny: ['HELI'],
      maxAircraft: 1,
      text: [
        {
          in: [...PC_AN],
          pattern: r`did not (hold|possess|have) (a|any) (valid |current )?(pilot|airman) certificate|was not (a )?certificated pilot|non-?certificated pilot|did not hold a pilot|no (pilot|rotorcraft) certificate`,
        },
      ],
    },
    note: 'Single helicopter; the cause or analysis says the pilot held no pilot certificate. Check student or expired certificates.',
  },
  {
    id: 'neg-helicopter-no-anomalies',
    question: 'Helicopter engine power losses from 2008 to 2015 where examination found no anomalies and the reason stayed undetermined.',
    tags: ['negation', 'causal_uncertainty'],
    filters: { category: ['HELI'], yearFrom: 2008, yearTo: 2015 },
    criteria: {
      years: [2008, 2015],
      categoryAny: ['HELI'],
      maxAircraft: 1,
      text: [
        { in: [...PC], pattern: UNDETERMINED_POWER_LOSS },
        { in: [...NARR], pattern: NO_ANOMALIES },
      ],
    },
    note: 'Single helicopter, undetermined power loss, and a negative examination in the narrative.',
  },

  // -------------------------------------------------------------------------
  // Causal uncertainty
  {
    id: 'unc-inflight-fire',
    question: 'In-flight fires from 2008 to 2014 whose origin investigators could not determine.',
    tags: ['causal_uncertainty'],
    filters: { yearFrom: 2008, yearTo: 2014 },
    criteria: {
      years: [2008, 2014],
      text: [
        { in: [...PC], pattern: r`in-?flight fire|fire in flight` },
        { in: [...PC], pattern: UNDETERMINED },
      ],
    },
    note: 'An in-flight fire and an undetermined element in the probable cause. Check that the undetermined part is the fire origin.',
  },
  {
    id: 'unc-incapacitation',
    question: 'Accidents where the pilot was probably incapacitated but the reason could not be determined.',
    tags: ['causal_uncertainty'],
    filters: {},
    criteria: { text: [{ in: [...PC], pattern: r`incapacitat` }, { in: [...PC], pattern: r`undetermined|unknown|could not be determined` }] },
    note: 'Incapacitation and an undetermined or unknown element in the probable cause.',
  },
  {
    id: 'unc-inflight-breakup',
    question: 'In-flight breakups where investigators could not determine why the structure failed.',
    tags: ['causal_uncertainty'],
    filters: {},
    criteria: {
      text: [
        { in: [...PC], pattern: r`in-?flight (breakup|break-up|structural failure)` },
        { in: [...PC], pattern: r`undetermined|could not be determined|unknown` },
      ],
    },
    note: 'An in-flight breakup or structural failure and an undetermined element in the probable cause.',
  },
  {
    id: 'unc-helicopter-tail-rotor',
    question: 'Helicopter accidents involving the tail rotor where the reason for the failure or loss of control was undetermined.',
    tags: ['causal_uncertainty', 'mechanical'],
    filters: { category: ['HELI'] },
    criteria: {
      categoryAny: ['HELI'],
      maxAircraft: 1,
      text: [
        { in: [...PC], pattern: r`tail rotor` },
        { in: [...PC], pattern: r`undetermined|unknown reasons|could not be determined` },
      ],
    },
    note: 'Single helicopter; tail rotor and an undetermined element in the probable cause.',
  },
  {
    id: 'unc-carb-ice-likely',
    question: 'Engine power losses that investigators attributed only probably or likely to carburetor icing.',
    tags: ['causal_uncertainty'],
    filters: {},
    criteria: {
      text: [
        { in: [...PC], pattern: r`carburetor ic` },
        { in: [...PC], pattern: r`\y(likely|possibl[ey]|probabl[ey]|most likely)\y` },
      ],
    },
    note: 'Carburetor ice qualified as likely or possible in the probable cause.',
  },
  {
    id: 'unc-fuel-contamination-suspected',
    question: 'Unexplained engine power losses where fuel contamination was considered but not confirmed as the cause.',
    tags: ['causal_uncertainty', 'negation'],
    filters: {},
    criteria: {
      text: [
        { in: [...PC], pattern: UNDETERMINED_POWER_LOSS },
        { in: [...AN], pattern: r`contaminat` },
      ],
    },
    note: 'Undetermined power loss with contamination discussed in the analysis. Check that contamination was examined, not just mentioned.',
  },
  {
    id: 'unc-loss-of-control-undetermined',
    question: 'Accidents in 2008 and 2009 where the airplane or helicopter went out of control for reasons that could not be determined.',
    tags: ['causal_uncertainty'],
    filters: { yearFrom: 2008, yearTo: 2009 },
    criteria: {
      years: [2008, 2009],
      text: [{ in: [...PC], pattern: r`loss of (aircraft )?control for (undetermined|unknown) reasons` }],
    },
    note: 'The probable cause names a loss of control for undetermined or unknown reasons.',
  },
  {
    id: 'unc-wreckage-not-recovered-water',
    question: 'Accidents over water from 2020 to 2022 where the wreckage was not recovered and the cause stayed undetermined.',
    tags: ['causal_uncertainty'],
    filters: { yearFrom: 2020, yearTo: 2022 },
    criteria: {
      years: [2020, 2022],
      text: [
        { in: [...PC], pattern: r`undetermined|could not be determined` },
        { in: [...NARR], pattern: r`(wreckage|airplane|helicopter|engine)[^.]{0,40}(was|were|has|have) not (been )?(recovered|located|found)` },
        { in: [...NARR], pattern: r`ocean|gulf|lake|\ybay\y|\ysea\y|water` },
      ],
    },
    note: 'Undetermined cause, unrecovered wreckage and water in the narrative. Check that the wreckage went into water.',
  },

  // -------------------------------------------------------------------------
  // Maintenance timing
  {
    id: 'mt-inspected-within-3-days',
    question: 'Accidents from 2015 to 2017 caused by maintenance errors on aircraft that had been inspected within the previous three days.',
    tags: ['maintenance_timing'],
    filters: { yearFrom: 2015, yearTo: 2017 },
    criteria: {
      years: [2015, 2017],
      inspectedWithinDays: 3,
      text: [{ in: [...PC], pattern: MAINTENANCE_FAULT }],
    },
    note: 'Structured: last inspection date at most 3 days before the event; the probable cause blames maintenance. The inspection is the recorded one, not necessarily the faulty work (DESIGN §3).',
  },
  {
    id: 'mt-within-5-hours-of-inspection',
    question: 'Accidents blamed on maintenance errors within 5 flight hours of the aircraft\'s last inspection.',
    tags: ['maintenance_timing'],
    filters: {},
    criteria: { hoursSinceInspectionMax: 5, text: [{ in: [...PC], pattern: MAINTENANCE_FAULT }] },
    note: 'Structured: airframe hours minus hours at last inspection at most 5; the probable cause blames maintenance.',
  },
  {
    id: 'mt-overhaul-recent-2008-2014',
    question: 'Engine failures between 2008 and 2014 that occurred within 20 operating hours after an overhaul.',
    tags: ['maintenance_timing', 'mechanical'],
    filters: { yearFrom: 2008, yearTo: 2014 },
    criteria: {
      years: [2008, 2014],
      text: [
        { in: [...NARR], pattern: r`overhaul[^.]{0,100}${RECENT_HOURS}` },
        { in: [...PC], pattern: r`loss of engine power|power loss|engine failure|failure of the` },
      ],
    },
    note: 'An overhaul sentence with fewer than 20 hours before or since, and a power loss or failure in the probable cause. Check that the overhauled part is the failed one.',
  },
  {
    id: 'mt-overhaul-recent-2015-2026',
    question: 'Since 2015, which power losses or component failures came less than 20 hours after the engine or part was overhauled?',
    tags: ['maintenance_timing', 'mechanical'],
    filters: { yearFrom: 2015, yearTo: 2026 },
    criteria: {
      years: [2015, 2026],
      text: [
        { in: [...NARR], pattern: r`overhaul[^.]{0,100}${RECENT_HOURS}` },
        { in: [...PC], pattern: r`loss of engine power|power loss|engine failure|failure of the` },
      ],
    },
    note: 'As mt-overhaul-recent-2008-2014, for 2015 onwards.',
  },
  {
    id: 'mt-first-flight-after-maintenance-2008-2014',
    question: 'Accidents from 2008 to 2014 on the first flight after maintenance, an overhaul or a repair, where the maintenance was implicated.',
    tags: ['maintenance_timing'],
    filters: { yearFrom: 2008, yearTo: 2014 },
    criteria: {
      years: [2008, 2014],
      text: [
        { in: [...NARR], pattern: FIRST_FLIGHT },
        { in: [...PC], pattern: r`maintenance|mechanic|install` },
      ],
    },
    note: 'A "first flight after/since maintenance" sentence and maintenance in the probable cause.',
  },
  {
    id: 'mt-first-flight-after-maintenance-2015-2026',
    question: 'Since 2015, which accidents happened on the first flight after work on the aircraft, with the work cited in the probable cause?',
    tags: ['maintenance_timing'],
    filters: { yearFrom: 2015, yearTo: 2026 },
    criteria: {
      years: [2015, 2026],
      text: [
        { in: [...NARR], pattern: FIRST_FLIGHT },
        { in: [...PC], pattern: r`maintenance|mechanic|install` },
      ],
    },
    note: 'As mt-first-flight-after-maintenance-2008-2014, for 2015 onwards.',
  },
  {
    id: 'mt-maintenance-within-30-days',
    question: 'Accidents caused by faulty maintenance that had been done within the 30 days before the accident.',
    tags: ['maintenance_timing'],
    filters: {},
    criteria: {
      text: [
        { in: [...NARR], pattern: r`(maintenance|repair|replaced|installed|overhaul)[^.]{0,80}\y([1-9]|[12][0-9]|30) days (before|prior to) the accident` },
        { in: [...PC], pattern: r`maintenance personnel|mechanic|improper(ly)? (maintenance|install)` },
      ],
    },
    note: 'A narrative sentence dating maintenance 1 to 30 days before the accident and maintenance blamed in the probable cause.',
  },
  {
    id: 'mt-inspected-within-30-days-power-loss',
    question: 'In 2008 and 2009, engine power losses linked to maintenance on aircraft inspected within the previous 30 days.',
    tags: ['maintenance_timing'],
    filters: { yearFrom: 2008, yearTo: 2009 },
    criteria: {
      years: [2008, 2009],
      inspectedWithinDays: 30,
      text: [
        { in: [...PC], pattern: r`loss of engine power|power loss` },
        { in: [...PC], pattern: r`maintenance personnel|mechanic|improper(ly)? (maintenance|install)` },
      ],
    },
    note: 'Structured: last inspection at most 30 days before; power loss and a maintenance fault in the probable cause. The inspection is the recorded one, not necessarily the faulty work (DESIGN §3).',
  },

  // -------------------------------------------------------------------------
  // Multi-aircraft events (no aircraft filter: their passages are event-scoped)
  {
    id: 'ma-helicopter-and-airplane',
    question: 'Collisions or near collisions between a helicopter and an airplane.',
    tags: ['multi_aircraft'],
    filters: {},
    criteria: {
      minAircraft: 2,
      categoriesAll: ['HELI', 'AIR'],
      text: [{ in: [...PC], pattern: r`collision|see and avoid|separation` }],
    },
    note: 'Structured: a helicopter and an airplane in one event; collision, see-and-avoid or separation in the probable cause.',
  },
  {
    id: 'ma-glider-and-another-aircraft',
    question: 'Accidents involving a glider and another aircraft, such as tow plane mishaps or collisions.',
    tags: ['multi_aircraft'],
    filters: {},
    criteria: { minAircraft: 2, categoriesAll: ['GLI'] },
    note: 'Structured only: an event with a glider and at least one other aircraft.',
  },
  {
    id: 'ma-formation-flight',
    question: 'Collisions between aircraft flying in formation.',
    tags: ['multi_aircraft'],
    filters: {},
    criteria: { minAircraft: 2, text: [{ in: [...PC], pattern: r`formation` }] },
    note: 'Several aircraft and formation flight in the probable cause.',
  },
  {
    id: 'ma-taxi-collision-atc',
    question: 'Ground collisions between aircraft while taxiing where air traffic control instructions played a part.',
    tags: ['multi_aircraft'],
    filters: {},
    criteria: {
      minAircraft: 2,
      text: [
        { in: [...PC], pattern: r`taxi` },
        { in: [...PC], pattern: r`controller|tower` },
      ],
    },
    note: 'Several aircraft; taxiing and a controller or tower in the probable cause.',
  },
  {
    id: 'ma-two-helicopters',
    question: 'Accidents and collisions involving two helicopters.',
    tags: ['multi_aircraft'],
    filters: {},
    criteria: { minAircraft: 2, categoryEvery: 'HELI' },
    note: 'Structured only: an event whose aircraft are all helicopters, at least two.',
  },
  {
    id: 'ma-runway-incursion',
    question: 'Between 2008 and 2016, runway incursions where an aircraft was cleared onto or across a runway another aircraft was using.',
    tags: ['multi_aircraft'],
    filters: { yearFrom: 2008, yearTo: 2016 },
    criteria: {
      years: [2008, 2016],
      minAircraft: 2,
      text: [
        { in: [...PC], pattern: r`runway` },
        { in: [...PC], pattern: r`incursion|clearance|cleared|line up and wait|position and hold` },
      ],
    },
    note: 'Several aircraft; runway and a clearance or incursion in the probable cause. Includes incidents (no collision).',
  },
  {
    id: 'ma-agricultural-firefighting',
    question: 'Collisions between aircraft working together on agricultural application or firefighting missions.',
    tags: ['multi_aircraft'],
    filters: {},
    criteria: {
      minAircraft: 2,
      text: [{ in: [...PC, ...NARR], pattern: r`fire ?fight|firefighting|aerial application|agricultural` }],
    },
    note: 'Several aircraft; firefighting or agricultural work in any section.',
  },
  {
    id: 'ma-alaska',
    question: 'Accidents in Alaska from 2008 to 2016 that involved more than one aircraft.',
    tags: ['multi_aircraft'],
    filters: { state: ['AK'], yearFrom: 2008, yearTo: 2016 },
    criteria: { states: ['AK'], years: [2008, 2016], minAircraft: 2 },
    note: 'Structured only: Alaska, 2008 to 2016, at least two aircraft.',
  },
  {
    id: 'ma-traffic-pattern-midair',
    question: 'Midair collisions in the airport traffic pattern from 2012 to 2018.',
    tags: ['multi_aircraft'],
    filters: { yearFrom: 2012, yearTo: 2018 },
    criteria: {
      years: [2012, 2018],
      minAircraft: 2,
      text: [
        { in: [...PC], pattern: MIDAIR },
        { in: [...PC_AN], pattern: r`traffic pattern` },
      ],
    },
    note: 'Several aircraft; midair or see-and-avoid in the probable cause and the traffic pattern in the cause or analysis.',
  },
  {
    id: 'ma-skydiving',
    question: 'Accidents between aircraft during skydiving or parachute operations.',
    tags: ['multi_aircraft'],
    filters: {},
    criteria: { minAircraft: 2, text: [{ in: [...PC_AN], pattern: r`parachut|skydiv` }] },
    note: 'Several aircraft; parachute or skydiving in the cause or analysis.',
  },
  {
    id: 'ma-balloon-and-another-aircraft',
    question: 'Accidents involving a hot air balloon and another aircraft.',
    tags: ['multi_aircraft'],
    filters: {},
    criteria: { minAircraft: 2, categoriesAll: ['BALL'] },
    note: 'Structured only: a balloon and at least one other aircraft in one event.',
  },

  // -------------------------------------------------------------------------
  // Mechanical and operational
  {
    id: 'mech-crankshaft-fatigue',
    question: 'Crankshaft fatigue fractures that caused engine failures between 2008 and 2012.',
    tags: ['mechanical'],
    filters: { yearFrom: 2008, yearTo: 2012 },
    criteria: { years: [2008, 2012], text: [{ in: [...PC], pattern: r`crankshaft` }, { in: [...PC], pattern: r`fatigue` }] },
    note: 'Crankshaft and fatigue in the probable cause.',
  },
  {
    id: 'mech-water-in-fuel',
    question: 'Engine power losses in 2008 and 2009 caused by water in the fuel.',
    tags: ['mechanical'],
    filters: { yearFrom: 2008, yearTo: 2009 },
    criteria: {
      years: [2008, 2009],
      text: [{ in: [...PC], pattern: r`water (contamination|in the fuel|contaminat)|fuel contaminated with water|water-contaminated` }],
    },
    note: 'Water contamination of fuel in the probable cause.',
  },
  {
    id: 'mech-helicopter-carburetor-icing',
    question: 'Helicopter accidents caused by carburetor icing.',
    tags: ['mechanical'],
    filters: { category: ['HELI'] },
    criteria: { categoryAny: ['HELI'], maxAircraft: 1, text: [{ in: [...PC], pattern: r`carburetor ic` }] },
    note: 'Single helicopter; carburetor ice in the probable cause.',
  },
  {
    id: 'mech-weight-shift-wing-failure',
    question: 'Weight-shift-control trike accidents where the wing failed or separated.',
    tags: ['mechanical'],
    filters: { category: ['WSFT'] },
    criteria: {
      categoryAny: ['WSFT'],
      maxAircraft: 1,
      text: [{ in: [...PC], pattern: r`wing` }, { in: [...PC], pattern: r`fail|fractur|separat` }],
    },
    note: 'Single weight-shift aircraft; wing and a failure, fracture or separation in the probable cause.',
  },
  {
    id: 'mech-cotter-pin-safety-wire',
    question: 'Maintenance errors where a cotter pin or safety wire was missing or not installed.',
    tags: ['mechanical'],
    filters: {},
    criteria: {
      text: [
        { in: [...PC], pattern: r`cotter pin|safety wire|safety-wire` },
        { in: [...PC], pattern: r`maintenance|mechanic|install` },
      ],
    },
    note: 'Cotter pin or safety wire with maintenance or installation in the probable cause.',
  },
  {
    id: 'mech-oil-cap-unsecured',
    question: 'Accidents where an oil filler cap or dipstick was left loose or unsecured, leading to oil loss.',
    tags: ['mechanical'],
    filters: {},
    criteria: { text: [{ in: [...PC], pattern: r`oil (filler )?cap|dipstick` }] },
    note: 'Oil cap or dipstick in the probable cause.',
  },
  {
    id: 'mech-control-rigging',
    question: 'Accidents caused by flight controls or trim that were rigged or connected incorrectly.',
    tags: ['mechanical'],
    filters: {},
    criteria: {
      text: [
        { in: [...PC], pattern: r`revers|rigg` },
        { in: [...PC], pattern: r`flight control|aileron|elevator|rudder|trim` },
      ],
    },
    note: 'Reversed or rigging and a flight control surface in the probable cause.',
  },
  {
    id: 'mech-loose-fitting',
    question: 'Engine problems caused by a loose B-nut, fuel line or oil line fitting after maintenance.',
    tags: ['mechanical'],
    filters: {},
    criteria: {
      text: [
        { in: [...PC], pattern: r`b-nut|fitting|fuel line|oil line` },
        { in: [...PC], pattern: r`loose|not (properly )?(tightened|torqued|secured|safetied)` },
        { in: [...PC], pattern: r`maintenance|mechanic|install` },
      ],
    },
    note: 'A fitting or line, a loose or untorqued condition, and maintenance in the probable cause.',
  },
  {
    id: 'op-balloon-power-lines',
    question: 'Hot air balloon flights from 2015 to 2020 that contacted power lines or wires.',
    tags: ['operational'],
    filters: { category: ['BALL'], yearFrom: 2015, yearTo: 2020 },
    criteria: {
      years: [2015, 2020],
      categoryAny: ['BALL'],
      maxAircraft: 1,
      text: [{ in: [...PC], pattern: r`power ?line|wire` }],
    },
    note: 'Single balloon; power line or wire in the probable cause.',
  },
  {
    id: 'op-density-altitude-colorado',
    question: 'Colorado accidents from 2008 to 2015 where high density altitude reduced aircraft performance.',
    tags: ['operational'],
    filters: { state: ['CO'], yearFrom: 2008, yearTo: 2015 },
    criteria: { states: ['CO'], years: [2008, 2015], text: [{ in: [...PC], pattern: r`density altitude` }] },
    note: 'Colorado; density altitude in the probable cause.',
  },
  {
    id: 'op-helicopter-bird-strike',
    question: 'Helicopter bird strikes between 2008 and 2022.',
    tags: ['operational'],
    filters: { category: ['HELI'], yearFrom: 2008, yearTo: 2022 },
    criteria: {
      years: [2008, 2022],
      categoryAny: ['HELI'],
      maxAircraft: 1,
      text: [{ in: [...PC], pattern: r`\ybird|\ygeese|\yvulture|\yhawk|\yduck` }],
    },
    note: 'Single helicopter; a bird in the probable cause.',
  },
  {
    id: 'op-gyroplane-oscillation',
    question: 'Gyroplane accidents involving pilot-induced oscillation, porpoising or rotor blade flapping.',
    tags: ['operational'],
    filters: { category: ['GYRO'] },
    criteria: {
      categoryAny: ['GYRO'],
      maxAircraft: 1,
      text: [{ in: [...PC], pattern: r`porpois|pilot-induced|oscillat|teeter|blade flap|rotor (blade )?flap|retreating blade` }],
    },
    note: 'Single gyroplane; oscillation, porpoising or blade flapping in the probable cause.',
  },
  {
    id: 'op-agricultural-wire-strike-texas',
    question: 'Agricultural application flights in Texas that hit wires or power lines.',
    tags: ['operational'],
    filters: { state: ['TX'] },
    criteria: { states: ['TX'], purposeAny: ['AAPL'], text: [{ in: [...PC], pattern: r`wire|power line` }] },
    note: 'Texas; an aircraft on an aerial application flight; wire or power line in the probable cause.',
  },
  {
    id: 'op-glider-winch-launch',
    question: 'Glider accidents during winch launches.',
    tags: ['operational'],
    filters: { category: ['GLI'] },
    criteria: { categoryAny: ['GLI'], maxAircraft: 1, text: [{ in: [...PC_AN], pattern: r`winch` }] },
    note: 'Single glider; winch in the cause or analysis.',
  },
  {
    id: 'op-helicopter-mast-bumping',
    question: 'Helicopter accidents involving mast bumping.',
    tags: ['operational'],
    filters: { category: ['HELI'] },
    criteria: { categoryAny: ['HELI'], maxAircraft: 1, text: [{ in: [...PC], pattern: r`mast bump` }] },
    note: 'Single helicopter; mast bumping in the probable cause.',
  },
  {
    id: 'op-amphibian-gear-down-water',
    question: 'Amphibious floatplanes that landed on water with the landing gear extended.',
    tags: ['operational'],
    filters: {},
    criteria: {
      text: [
        { in: [...PC], pattern: r`amphib|float` },
        { in: [...PC], pattern: r`landing gear|wheels` },
        { in: [...PC], pattern: r`water` },
      ],
    },
    note: 'Amphibian or floats, landing gear or wheels, and water in the probable cause. Check that the gear was extended.',
  },
  {
    id: 'op-structural-icing',
    question: 'Accidents from 2008 to 2015 caused by airframe or structural icing.',
    tags: ['operational'],
    filters: { yearFrom: 2008, yearTo: 2015 },
    criteria: { years: [2008, 2015], text: [{ in: [...PC], pattern: r`structural ic(e|ing)|airframe ic(e|ing)` }] },
    note: 'Structural or airframe ice in the probable cause.',
  },
];
