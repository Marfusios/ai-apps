/**
 * The coded-reference questions (Track C, task 10c protocol v4) and their frozen code
 * sets. Edit a question here, then rebuild `dataset.json` with
 * `pnpm eval:retrieval:coded`; never edit relevant case numbers by hand.
 *
 * Every code identifier below was chosen by inspecting the real code distribution of
 * the answer-eligible cohort (generation 1) and is listed explicitly, modifier
 * included (`withModifiers` only spells out the ten-digit codes). A finding code reads
 * category-subcategory-section-subsection-modifier: `0303103081` is "Environmental
 * issues - Conditions/weather/phenomena - Temp/humidity/pressure - Conducive to
 * carburetor icing - Effect on equipment". An event code is the occurrence of the
 * sequence of events in any phase: `192` is "Fuel exhaustion".
 *
 * Wording follows the codes: a finding is "a finding of", or "cited in the probable
 * cause" when the clause requires `in_probable_cause` (which does not distinguish
 * cause from contributing factor); an occurrence is something the accident
 * "involved". Category filters use the recorded aircraft category (HELI includes
 * whatever was recorded as such); a phase filter is the aircraft's defining-event
 * phase group ("takeoff accidents"). `cause_factor` and description suffixes are never
 * labels.
 */
import type { Clause, CodeFamily, CodeSet, CodedParaphraseSpec, CodedQuestionSpec } from './coded.js';

/** The ten-digit finding codes of one eight-digit finding with each listed modifier. */
const withModifiers = (finding: string, modifiers: readonly string[]): string[] => modifiers.map((m) => `${finding}${m}`);
const finding = (codes: readonly string[], inProbableCause: boolean): Clause => ({ kind: 'finding', codes: [...codes], inProbableCause });
const event = (...codes: string[]): Clause => ({ kind: 'event', codes });
const one = (clause: Clause): CodeSet => ({ clauses: [clause], attribution: 'same-aircraft' });
const sameAircraft = (...clauses: Clause[]): CodeSet => ({ clauses, attribution: 'same-aircraft' });

// ---------------------------------------------------------------------------
// Frozen code sets (every modifier seen in the cohort unless noted)

/** Environmental issues - Conditions/weather/phenomena - Temp/humidity/pressure - Conducive to carburetor icing. */
const CARB_ICING = withModifiers('03031030', ['00', '81', '82', '84', '85', '86', '87', '91', '99']);
/** ... - Temp/humidity/pressure - High density altitude. */
const DENSITY_ALTITUDE = withModifiers('03031020', ['81', '82', '84', '85', '87', '91', '92', '99']);
/** ... - Temp/humidity/pressure - Conducive to structural icing. */
const STRUCTURAL_ICING = withModifiers('03031025', ['81', '82', '83', '84', '85', '86', '87', '91', '92', '99']);
/** ... - Wind - Gusts. */
const GUSTS = withModifiers('03034045', ['81', '82', '83', '84', '85', '86', '87', '88', '89', '91', '99']);
/** ... - Wind - Tailwind. */
const TAILWIND = withModifiers('03034015', ['81', '82', '84', '85', '86', '87', '89', '91', '92', '99']);

/** Aircraft - Aircraft systems - Fuel system - every subsection, modifiers Failure (01) and Malfunction (02) only. */
const FUEL_SYSTEM_FAILURE = [
  '0102280001', '0102280002', '0102281001', '0102281002', '0102282001', '0102282002', '0102282101', '0102282102',
  '0102282201', '0102282202', '0102282301', '0102282302', '0102282402', '0102284001', '0102284002', '0102284101',
  '0102284102', '0102284201', '0102284202', '0102284401', '0102284402', '0102289701', '0102289702',
];
/** ... - Fuel system - Fuel selector/shutoff valve - Incorrect use/operation (11) only. */
const FUEL_SELECTOR_MISUSE = ['0102282311'];
/** ... - Landing gear system - Gear extension and retract sys - Not used/operated (10) only. */
const GEAR_NOT_OPERATED = ['0102323010'];
/** ... - Landing gear system - Gear extension and retract sys - Failure (01), Malfunction (02). */
const GEAR_FAILURE = withModifiers('01023230', ['01', '02']);
/** Aircraft power plant - Engine (reciprocating) - Recip engine power section - Failure (01), Fatigue/wear/corrosion (06). */
const RECIP_POWER_SECTION = withModifiers('01058520', ['01', '06']);
/** ... - Engine (reciprocating) - Recip eng cyl section - Failure (01), Fatigue/wear/corrosion (06). */
const RECIP_CYLINDER = withModifiers('01058530', ['01', '06']);
/** ... - Engine (turbine/turboprop) - Compressor section and Turbine section - Failure (01), Fatigue/wear/corrosion (06). */
const TURBINE_SECTIONS = [...withModifiers('01057230', ['01', '06']), ...withModifiers('01057250', ['01', '06'])];
/** ... - Ignition system - Magneto/distributor - Failure (01), Malfunction (02). */
const MAGNETO_FAILURE = withModifiers('01057414', ['01', '02']);

/** Every Personnel issues finding (category 02) whose modifier is Maintenance personnel (41), as seen in the cohort. */
const MAINTENANCE_PERSONNEL = [
  '0201350041', '0202151041', '0202152041', '0202152541', '0202154541', '0203101041', '0203102541', '0203153041',
  '0203201041', '0203201541', '0204100041', '0204101041', '0204101541', '0204102541', '0204103041', '0204103541',
  '0204104041', '0204151041', '0204151541', '0204152041', '0204152541', '0205000041', '0206000041', '0206100041',
  '0206150041', '0206151541', '0206152041', '0206200041', '0206201041', '0206201541', '0206202041', '0206202541',
  '0206203041', '0206203541', '0206204041', '0206251541', '0206301541', '0206302041', '0206303241', '0206303541',
  '0206351041', '0206351541', '0206353541',
];
/** Personnel issues - Task performance - Inspection - (general), Post maintenance inspection, Scheduled/routine inspection - Maintenance personnel. */
const MAINTENANCE_INSPECTION = ['0206150041', '0206151541', '0206152041'];
/** Personnel issues - Task performance - Inspection - Preflight inspection - Pilot. */
const PILOT_PREFLIGHT = ['0206151044'];
/** Personnel issues - Action/decision - Info processing/decision - Decision making/judgment - Pilot. */
const PILOT_DECISION = ['0204152044'];
/** ... - Decision making/judgment - Instructor/check pilot. */
const INSTRUCTOR_DECISION = ['0204152040'];
/** Personnel issues - Task performance - Planning/preparation - Fuel planning - Pilot. */
const PILOT_FUEL_PLANNING = ['0206103044'];

/**
 * The sets above that were frozen from what generation 1's cohort holds. The builder
 * and the runner warn when a target generation holds a code of the same kind outside
 * the frozen list (`familyWarnings`); the sets never grow by themselves.
 */
export const CODE_FAMILIES: readonly CodeFamily[] = [
  { name: 'Conducive to carburetor icing, every modifier', pattern: '^03031030[0-9]{2}$', codes: CARB_ICING },
  { name: 'High density altitude, every modifier', pattern: '^03031020[0-9]{2}$', codes: DENSITY_ALTITUDE },
  { name: 'Conducive to structural icing, every modifier', pattern: '^03031025[0-9]{2}$', codes: STRUCTURAL_ICING },
  { name: 'Wind - Gusts, every modifier', pattern: '^03034045[0-9]{2}$', codes: GUSTS },
  { name: 'Wind - Tailwind, every modifier', pattern: '^03034015[0-9]{2}$', codes: TAILWIND },
  { name: 'Fuel system, every subsection, Failure or Malfunction', pattern: '^010228[0-9]{2}0[12]$', codes: FUEL_SYSTEM_FAILURE },
  { name: 'Personnel issues with the Maintenance personnel modifier', pattern: '^02[0-9]{6}41$', codes: MAINTENANCE_PERSONNEL },
];

const FUEL_EXHAUSTION = event('192');
const FUEL_STARVATION = event('191');
const MIDAIR = event('250');
const LOSS_OF_CONTROL_IN_FLIGHT = event('240');
const CFIT = event('120');

// ---------------------------------------------------------------------------
// Questions

export const CODED_QUESTIONS: readonly CodedQuestionSpec[] = [
  // -------------------------------------------------------------------------
  // Environment
  {
    id: 'env-carb-icing-cause-michigan',
    question: 'In Michigan, which accidents have a probable cause that cites conditions conducive to carburetor icing?',
    area: 'environment',
    class: 'narrow',
    filters: { state: ['MI'] },
    codeSet: one(finding(CARB_ICING, true)),
    wording: ['conditions conducive to carburetor icing'],
    note: 'Every modifier of "Conducive to carburetor icing", cited in the probable cause. The code records conditions, not confirmed ice.',
  },
  {
    id: 'env-carb-icing-texas',
    question: 'Which accidents in Texas have a finding of conditions conducive to carburetor icing?',
    area: 'environment',
    class: 'broad',
    filters: { state: ['TX'] },
    codeSet: one(finding(CARB_ICING, false)),
    wording: ['conditions conducive to carburetor icing'],
    note: 'Every modifier of "Conducive to carburetor icing", anywhere in the findings. The code records conditions, not confirmed ice.',
  },
  {
    id: 'env-density-altitude-helicopters',
    question: 'Which helicopter accidents have a finding of high density altitude?',
    area: 'environment',
    class: 'broad',
    filters: { category: ['HELI'] },
    codeSet: one(finding(DENSITY_ALTITUDE, false)),
    wording: ['high density altitude'],
    note: 'Every modifier of "High density altitude" on an aircraft recorded as a helicopter (HELI).',
  },
  {
    id: 'env-structural-icing-colorado',
    question: 'Which Colorado accidents have a finding of conditions conducive to structural icing?',
    area: 'environment',
    class: 'narrow',
    filters: { state: ['CO'] },
    codeSet: one(finding(STRUCTURAL_ICING, false)),
    wording: ['conditions conducive to structural icing'],
    note: 'Every modifier of "Conducive to structural icing". The code records conditions, not ice found on the airframe.',
  },
  {
    id: 'env-gusts-cause-california',
    question: 'In California, which accidents have a probable cause that cites wind gusts?',
    area: 'environment',
    class: 'broad',
    filters: { state: ['CA'] },
    codeSet: one(finding(GUSTS, true)),
    wording: ['wind gusts'],
    note: 'Every modifier of "Wind - Gusts", cited in the probable cause.',
  },
  {
    id: 'env-gusts-cause-gyroplanes',
    question: 'Which gyroplane accidents have a probable cause that cites wind gusts?',
    area: 'environment',
    class: 'narrow',
    filters: { category: ['GYRO'] },
    codeSet: one(finding(GUSTS, true)),
    wording: ['wind gusts'],
    note: 'Every modifier of "Wind - Gusts", cited in the probable cause, on an aircraft recorded as a gyrocraft (GYRO).',
  },
  {
    id: 'env-tailwind-cause-landing-utah',
    question: 'In Utah, which landing accidents have a probable cause that cites a tailwind?',
    area: 'environment',
    class: 'narrow',
    filters: { state: ['UT'], phase: ['landing'] },
    codeSet: one(finding(TAILWIND, true)),
    wording: ['tailwind'],
    note: 'Every modifier of "Wind - Tailwind", cited in the probable cause, on an aircraft whose defining event was in the landing phase.',
  },
  {
    id: 'env-loss-of-control-gusts-cause-2016',
    question: 'In 2016, which accidents involved a loss of control in flight, with a probable cause that cites wind gusts?',
    area: 'environment',
    class: 'narrow',
    filters: { yearFrom: 2016, yearTo: 2016 },
    codeSet: sameAircraft(LOSS_OF_CONTROL_IN_FLIGHT, finding(GUSTS, true)),
    wording: ['loss of control in flight', 'wind gusts'],
    note: 'One aircraft carries both the "Loss of control in flight" occurrence and a "Wind - Gusts" finding cited in the probable cause.',
  },

  // -------------------------------------------------------------------------
  // Aircraft systems
  {
    id: 'sys-fuel-system-failure-helicopters',
    question: 'Which helicopter accidents have a finding of a failure or malfunction in the fuel system?',
    area: 'aircraft_systems',
    class: 'narrow',
    filters: { category: ['HELI'] },
    codeSet: one(finding(FUEL_SYSTEM_FAILURE, false)),
    wording: ['failure or malfunction', 'fuel system'],
    note: 'Every "Aircraft systems - Fuel system" subsection with the Failure or Malfunction modifier only (not incorrect use, maintenance or damage).',
  },
  {
    id: 'sys-fuel-system-failure-airplanes-2008-2012',
    question: 'From 2008 to 2012, which airplane accidents have a finding of a failure or malfunction in the fuel system?',
    area: 'aircraft_systems',
    class: 'broad',
    filters: { category: ['AIR'], yearFrom: 2008, yearTo: 2012 },
    codeSet: one(finding(FUEL_SYSTEM_FAILURE, false)),
    wording: ['failure or malfunction', 'fuel system'],
    note: 'Every "Aircraft systems - Fuel system" subsection with the Failure or Malfunction modifier, on an airplane.',
  },
  {
    id: 'sys-fuel-selector-misuse-2023-2026',
    question: 'From 2023 to 2026, which accidents have a finding of incorrect use or operation of the fuel selector/shutoff valve?',
    area: 'aircraft_systems',
    class: 'narrow',
    filters: { yearFrom: 2023, yearTo: 2026 },
    codeSet: one(finding(FUEL_SELECTOR_MISUSE, false)),
    wording: ['incorrect use or operation', 'fuel selector'],
    note: 'Only the Incorrect use/operation modifier of the fuel selector/shutoff valve; unintentional use and not used/operated are left out.',
  },
  {
    id: 'sys-gear-not-operated-2023-2026',
    question: 'From 2023 to 2026, which accidents have a finding that the landing gear extension and retraction system was not used or operated?',
    area: 'aircraft_systems',
    class: 'broad',
    filters: { yearFrom: 2023, yearTo: 2026 },
    codeSet: one(finding(GEAR_NOT_OPERATED, false)),
    wording: ['landing gear extension and retraction system', 'not used or operated'],
    note: 'Only the Not used/operated modifier of the gear extension and retraction system.',
  },
  {
    id: 'sys-gear-failure-oregon',
    question: 'In Oregon, which accidents have a finding of a failure or malfunction of the landing gear extension and retraction system?',
    area: 'aircraft_systems',
    class: 'narrow',
    filters: { state: ['OR'] },
    codeSet: one(finding(GEAR_FAILURE, false)),
    wording: ['failure or malfunction', 'landing gear extension and retraction system'],
    note: 'Failure and Malfunction modifiers of the gear extension and retraction system.',
  },
  {
    id: 'sys-recip-power-section-arizona',
    question: 'In Arizona, which accidents have a finding of failure or of fatigue, wear or corrosion in the reciprocating engine power section?',
    area: 'aircraft_systems',
    class: 'narrow',
    filters: { state: ['AZ'] },
    codeSet: one(finding(RECIP_POWER_SECTION, false)),
    wording: ['fatigue, wear or corrosion', 'reciprocating engine power section'],
    note: 'Failure and Fatigue/wear/corrosion modifiers of the reciprocating engine power section (other modifiers such as incorrect service are left out).',
  },
  {
    id: 'sys-recip-cylinder-california',
    question: 'Which accidents in California have a finding of failure or of fatigue, wear or corrosion in the reciprocating engine cylinder section?',
    area: 'aircraft_systems',
    class: 'broad',
    filters: { state: ['CA'] },
    codeSet: one(finding(RECIP_CYLINDER, false)),
    wording: ['fatigue, wear or corrosion', 'reciprocating engine cylinder section'],
    note: 'Failure and Fatigue/wear/corrosion modifiers of the reciprocating engine cylinder section.',
  },
  {
    id: 'sys-turbine-sections-helicopters-2008-2012',
    question: 'From 2008 to 2012, which helicopter accidents have a finding of failure or of fatigue, wear or corrosion in the compressor or turbine section of a turbine engine?',
    area: 'aircraft_systems',
    class: 'narrow',
    filters: { category: ['HELI'], yearFrom: 2008, yearTo: 2012 },
    codeSet: one(finding(TURBINE_SECTIONS, false)),
    wording: ['fatigue, wear or corrosion', 'compressor or turbine section'],
    note: 'Failure and Fatigue/wear/corrosion modifiers of the turbine engine compressor and turbine sections.',
  },
  {
    id: 'sys-magneto-failure-2014-2016',
    question: 'From 2014 to 2016, which accidents have a finding of a failure or malfunction of a magneto/distributor?',
    area: 'aircraft_systems',
    class: 'narrow',
    filters: { yearFrom: 2014, yearTo: 2016 },
    codeSet: one(finding(MAGNETO_FAILURE, false)),
    wording: ['failure or malfunction', 'magneto/distributor'],
    note: 'Failure and Malfunction modifiers of "Ignition system - Magneto/distributor".',
  },

  // -------------------------------------------------------------------------
  // Personnel
  {
    id: 'per-maintenance-personnel-cause-hawaii',
    question: 'In Hawaii, which accidents have a probable cause in which investigators cited maintenance personnel?',
    area: 'personnel',
    class: 'narrow',
    filters: { state: ['HI'] },
    codeSet: one(finding(MAINTENANCE_PERSONNEL, true)),
    wording: ['investigators cited maintenance personnel'],
    note: 'Every Personnel issues finding with the Maintenance personnel modifier, cited in the probable cause.',
  },
  {
    id: 'per-maintenance-personnel-cause-washington',
    question: 'In Washington, which accidents have a probable cause in which investigators cited maintenance personnel?',
    area: 'personnel',
    class: 'broad',
    filters: { state: ['WA'] },
    codeSet: one(finding(MAINTENANCE_PERSONNEL, true)),
    wording: ['investigators cited maintenance personnel'],
    note: 'Every Personnel issues finding with the Maintenance personnel modifier, cited in the probable cause.',
  },
  {
    id: 'per-maintenance-inspection-pennsylvania',
    question: 'In Pennsylvania, which accidents have a finding about inspections performed by maintenance personnel?',
    area: 'personnel',
    class: 'narrow',
    filters: { state: ['PA'] },
    codeSet: one(finding(MAINTENANCE_INSPECTION, false)),
    wording: ['inspections performed by maintenance personnel'],
    note: 'Task performance - Inspection (general, post-maintenance, scheduled/routine) with the Maintenance personnel modifier.',
  },
  {
    id: 'per-maintenance-inspection-florida',
    question: 'Which accidents in Florida have a finding about inspections performed by maintenance personnel?',
    area: 'personnel',
    class: 'broad',
    filters: { state: ['FL'] },
    codeSet: one(finding(MAINTENANCE_INSPECTION, false)),
    wording: ['inspections performed by maintenance personnel'],
    note: 'Task performance - Inspection (general, post-maintenance, scheduled/routine) with the Maintenance personnel modifier.',
  },
  {
    id: 'per-preflight-cause-gliders',
    question: "Which glider accidents have a probable cause that cites the pilot's preflight inspection?",
    area: 'personnel',
    class: 'narrow',
    filters: { category: ['GLI'] },
    codeSet: one(finding(PILOT_PREFLIGHT, true)),
    wording: ["the pilot's preflight inspection"],
    note: 'Task performance - Inspection - Preflight inspection - Pilot, cited in the probable cause, on a glider.',
  },
  {
    id: 'per-preflight-cause-alaska',
    question: "In Alaska, which accidents have a probable cause that cites the pilot's preflight inspection?",
    area: 'personnel',
    class: 'broad',
    filters: { state: ['AK'] },
    codeSet: one(finding(PILOT_PREFLIGHT, true)),
    wording: ["the pilot's preflight inspection"],
    note: 'Task performance - Inspection - Preflight inspection - Pilot, cited in the probable cause.',
  },
  {
    id: 'per-pilot-decision-cause-weight-shift',
    question: "Which weight-shift-control aircraft accidents have a probable cause that cites the pilot's decision making?",
    area: 'personnel',
    class: 'broad',
    filters: { category: ['WSFT'] },
    codeSet: one(finding(PILOT_DECISION, true)),
    wording: ["the pilot's decision making"],
    note: 'Action/decision - Decision making/judgment - Pilot, cited in the probable cause, on a weight-shift-control aircraft.',
  },
  {
    id: 'per-instructor-decision-cause-helicopters',
    question: "Which helicopter accidents have a probable cause that cites the flight instructor's or check pilot's decision making?",
    area: 'personnel',
    class: 'narrow',
    filters: { category: ['HELI'] },
    codeSet: one(finding(INSTRUCTOR_DECISION, true)),
    wording: ["check pilot's decision making"],
    note: 'Action/decision - Decision making/judgment - Instructor/check pilot, cited in the probable cause, on a helicopter.',
  },

  // -------------------------------------------------------------------------
  // Occurrences
  {
    id: 'occ-fuel-exhaustion-georgia',
    question: 'Which accidents in Georgia involved fuel exhaustion?',
    area: 'occurrence',
    class: 'broad',
    filters: { state: ['GA'] },
    codeSet: one(FUEL_EXHAUSTION),
    wording: ['fuel exhaustion'],
    note: 'The "Fuel exhaustion" occurrence in any phase of the sequence of events.',
  },
  {
    id: 'occ-fuel-exhaustion-helicopters-2008-2012',
    question: 'From 2008 to 2012, which helicopter accidents involved fuel exhaustion?',
    area: 'occurrence',
    class: 'narrow',
    filters: { category: ['HELI'], yearFrom: 2008, yearTo: 2012 },
    codeSet: one(FUEL_EXHAUSTION),
    wording: ['fuel exhaustion'],
    note: 'The "Fuel exhaustion" occurrence on a helicopter.',
  },
  {
    id: 'occ-fuel-starvation-minnesota',
    question: 'Which accidents in Minnesota involved fuel starvation?',
    area: 'occurrence',
    class: 'narrow',
    filters: { state: ['MN'] },
    codeSet: one(FUEL_STARVATION),
    wording: ['fuel starvation'],
    note: 'The "Fuel starvation" occurrence in any phase.',
  },
  {
    id: 'occ-fuel-starvation-takeoff',
    question: 'Which takeoff accidents involved fuel starvation?',
    area: 'occurrence',
    class: 'broad',
    filters: { phase: ['takeoff'] },
    codeSet: one(FUEL_STARVATION),
    wording: ['fuel starvation'],
    note: 'The "Fuel starvation" occurrence on an aircraft whose defining event was in the takeoff phase.',
  },
  {
    id: 'occ-midair-nevada',
    question: 'Which accidents in Nevada involved a midair collision?',
    area: 'occurrence',
    class: 'narrow',
    filters: { state: ['NV'] },
    codeSet: one(MIDAIR),
    wording: ['midair collision'],
    note: 'The "Midair collision" occurrence on any aircraft of the event.',
  },
  {
    id: 'occ-midair-helicopters',
    question: 'Which midair collisions were between helicopters?',
    area: 'occurrence',
    class: 'narrow',
    filters: { category: ['HELI'] },
    codeSet: one(MIDAIR),
    wording: ['midair collision'],
    note: 'The "Midair collision" occurrence on a helicopter under the helicopter filter: only events whose every aircraft is a helicopter are reachable (passages-v2); mixed events are recorded as unreachable.',
  },
  {
    id: 'occ-cfit-utah',
    question: 'Which accidents in Utah involved controlled flight into terrain or an object?',
    area: 'occurrence',
    class: 'broad',
    filters: { state: ['UT'] },
    codeSet: one(CFIT),
    wording: ['controlled flight into terrain'],
    note: 'The "Controlled flight into terr/obj (CFIT)" occurrence.',
  },
  {
    id: 'occ-loss-of-control-gyroplanes',
    question: 'Which gyroplane accidents involved a loss of control in flight?',
    area: 'occurrence',
    class: 'broad',
    filters: { category: ['GYRO'] },
    codeSet: one(LOSS_OF_CONTROL_IN_FLIGHT),
    wording: ['loss of control in flight'],
    note: 'The "Loss of control in flight" occurrence on a gyrocraft.',
  },
  {
    id: 'occ-fuel-exhaustion-fuel-planning-cause-oklahoma',
    question: "In Oklahoma, which accidents involved fuel exhaustion, with a probable cause that cites the pilot's fuel planning?",
    area: 'occurrence',
    class: 'narrow',
    filters: { state: ['OK'] },
    codeSet: sameAircraft(FUEL_EXHAUSTION, finding(PILOT_FUEL_PLANNING, true)),
    wording: ['fuel exhaustion', "the pilot's fuel planning"],
    note: 'One aircraft carries both the "Fuel exhaustion" occurrence and "Planning/preparation - Fuel planning - Pilot" cited in the probable cause.',
  },
];

// ---------------------------------------------------------------------------
// Paraphrases: the original's code set, filters and labels, without the code vocabulary

export const CODED_PARAPHRASES: readonly CodedParaphraseSpec[] = [
  {
    id: 'para-carb-icing-cause-michigan',
    of: 'env-carb-icing-cause-michigan',
    question: "In Michigan, which accidents does the official cause statement tie to weather in which ice could form in the throat of a piston engine's fuel-air mixing device?",
    avoids: ['carburetor', 'icing', 'conducive', 'probable cause'],
  },
  {
    id: 'para-density-altitude-helicopters',
    of: 'env-density-altitude-helicopters',
    question: 'Which helicopter accidents involved air made thin by heat, humidity or elevation?',
    avoids: ['density', 'altitude'],
  },
  {
    id: 'para-fuel-system-failure-helicopters',
    of: 'sys-fuel-system-failure-helicopters',
    question: "Which helicopter accidents involved a part of the aircraft's fuel storage, delivery or quantity-indicating equipment breaking down or not working as designed?",
    avoids: ['fuel system', 'failure', 'malfunction'],
  },
  {
    id: 'para-maintenance-personnel-cause-hawaii',
    of: 'per-maintenance-personnel-cause-hawaii',
    question: 'In Hawaii, which accidents does the official cause statement attribute in part to the work of mechanics or repair technicians?',
    avoids: ['maintenance', 'personnel', 'probable cause'],
  },
  {
    id: 'para-preflight-cause-alaska',
    of: 'per-preflight-cause-alaska',
    question: "In Alaska, which accidents does the official cause statement tie to the pilot's walk-around check of the aircraft before departure?",
    avoids: ['preflight', 'inspection', 'probable cause'],
  },
  {
    id: 'para-fuel-exhaustion-georgia',
    of: 'occ-fuel-exhaustion-georgia',
    question: 'Which accidents in Georgia involved the aircraft running completely out of usable fuel?',
    avoids: ['exhaustion'],
  },
  {
    id: 'para-fuel-starvation-minnesota',
    of: 'occ-fuel-starvation-minnesota',
    question: 'Which accidents in Minnesota involved usable fuel remaining on board but not reaching the engine?',
    avoids: ['starvation'],
  },
  {
    id: 'para-midair-nevada',
    of: 'occ-midair-nevada',
    question: 'Which accidents in Nevada involved two aircraft colliding with each other while airborne?',
    avoids: ['midair', 'mid-air'],
  },
  {
    id: 'para-cfit-utah',
    of: 'occ-cfit-utah',
    question: "Which accidents in Utah involved an airworthy aircraft, under the pilot's control, being flown unintentionally into the ground, water or an obstacle?",
    avoids: ['controlled flight', 'cfit', 'terrain'],
  },
];
