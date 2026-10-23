/**
 * The narrative-relevance development questions (Track N, task 10c protocol v4). Edit a
 * question here, then rebuild `dataset.json` with `pnpm eval:retrieval:narrative build`;
 * never edit cohort case numbers by hand.
 *
 * How they were written: from general knowledge of the kinds of events NTSB reports
 * describe, worded as a reader would ask, with the precise criteria in the rubric. The
 * filters were chosen from aggregate cohort counts only (how many answer-eligible cases
 * a filter reaches); no case record was read to write a question or a rubric, and none
 * comes from a case inspected in Track C or in the phase A diagnostics. Bounded cohorts
 * use filters that limit the answer-eligible cohort to at most 150 cases (the builder
 * checks it), so every one of their cases is judged and Recall@20 is defined.
 *
 * Shared rubric conventions (the judge prompt states them once, for every question):
 * the record is the case's complete imported evidence (every narrative section, the
 * findings and the occurrences); the investigators' statements are the narrative text
 * not attributed to someone, the findings and the probable cause, while "the pilot
 * reported" introduces the pilot's account; grades are decided in order (2 when every
 * condition is stated, otherwise 1 when the grade-1 description fits, otherwise 0); in an
 * event with several aircraft each condition must hold for the aircraft the question is
 * about; clocks and calendar time are never converted into one another.
 *
 * Related codes (Track C code sets) add their coded positives under the question's
 * filters to the pool and log candidate code-narrative discrepancies; they never label
 * anything. A finding code reads category-subcategory-section-subsection-modifier.
 */
import type { Clause, CodeSet } from '../coded/coded.js';
import type { NarrativeParaphraseSpec, NarrativeQuestionSpec } from './spec.js';

const finding = (codes: readonly string[], inProbableCause = false): Clause => ({ kind: 'finding', codes: [...codes], inProbableCause });
const one = (clause: Clause): CodeSet => ({ clauses: [clause], attribution: 'same-aircraft' });
const withModifiers = (prefix: string, modifiers: readonly string[]): string[] => modifiers.map((m) => `${prefix}${m}`);

/** Environmental issues - Physical environment - Object/animal/substance - Wire, every modifier seen. */
const WIRE = withModifiers('03022032', ['81', '82', '84', '85', '86', '87', '91', '99']);
/** Aircraft - Aircraft systems - Landing gear system - Gear extension and retract sys: Failure, Malfunction, Inoperative. */
const GEAR_EXTENSION_FAILURE = withModifiers('01023230', ['01', '02', '26']);
/**
 * Aircraft - Aircraft propeller/rotor - Tail rotor drive system: (general), drive shaft and gearbox, each with
 * Failure, Malfunction, Damaged/degraded or Fatigue/wear/corrosion where the cohort holds it.
 */
const TAIL_ROTOR_DRIVE = [
  ...withModifiers('01046500', ['01', '02', '05']),
  ...withModifiers('01046510', ['01', '02', '05', '06']),
  ...withModifiers('01046520', ['01', '02', '05', '06']),
];

const POWER_LOSS_RECORDED =
  'A loss of engine power the pilot reported counts as reported unless the investigators dispute it.';

/**
 * How the rubrics are built (fix round 1): grade 2 lists every condition; grade 1 starts
 * "Grade 2 does not hold" and describes the partial cases; grade 0 is "anything else",
 * with the contrasts named. The judge prompt decides in that order (2, then 1, then 0),
 * so the branches never overlap. Intervals keep their clock: flight, Hobbs, tachometer
 * and engine hours and calendar time are never converted into one another, and a number
 * of flights is never worked out from hours (or hours from a number of flights).
 */
const CLOCKS =
  'Hours are never converted between clocks, and never worked out from calendar time or from a number of flights.';

export const NARRATIVE_QUESTIONS: readonly NarrativeQuestionSpec[] = [
  // -------------------------------------------------------------------------
  // Bounded cohorts (every case judged)
  {
    id: 'ng-skydiving-power-loss-no-anomaly',
    question: 'Which skydiving flights lost engine power even though the engine examination afterwards found nothing mechanically wrong?',
    tags: ['negation', 'mechanical', 'aircraft_filter'],
    type: 'bounded-cohort',
    filters: { purpose: ['SKYD'] },
    rubric: {
      relevant:
        'The record reports a loss of engine power (total or partial) during the flight, AND the investigators state that their examination of the engine (a visual examination, a teardown or a test run) found no mechanical malfunction, failure or anomaly that existed before the accident (for example, "no preimpact mechanical malfunctions or anomalies that would have precluded normal operation"). Why power was lost may be undetermined or something other than an engine defect (fuel, ice, the way the engine was operated). ' +
        POWER_LOSS_RECORDED,
      partial:
        'Grade 2 does not hold, the record reports a loss of engine power, and no pre-existing engine malfunction, failure or anomaly was found: the engine was not examined, could be examined only in part (fire or impact damage), the "no anomalies" statement covers only the airframe or only part of the engine, or the only statement that nothing was wrong is the pilot\'s own (for example, "the pilot reported no mechanical malfunctions"). Also partial: the investigators found nothing wrong with the engine but doubt that power was lost.',
      notRelevant:
        'Anything else, including: no loss of engine power is reported; or an examination found an engine malfunction, failure, damage or wear that existed before the accident (for example, a fractured connecting rod, a failed magneto, a stuck valve), whatever else the record says.',
      edgeCases: [
        { situation: 'Fuel exhaustion caused the power loss, and the examination found no mechanical anomaly with the engine.', grade: 2, why: "The question is about the engine's mechanical condition, not about why power was lost." },
        { situation: 'The engine lost power on climb-out and was destroyed by the post-crash fire, so it could not be examined.', grade: 1, why: 'The examination result is unknown.' },
        { situation: 'The engine lost power; the examination found a fatigue fracture of the crankshaft.', grade: 0, why: 'A pre-existing mechanical failure was found.' },
        { situation: 'The pilot reported a partial loss of power; the engine later ran at full power on a test stand with no anomalies.', grade: 2, why: 'A reported power loss and an examination, including the test run, that found nothing wrong.' },
        { situation: 'The pilot reported a total loss of power and said the airplane had no mechanical problems before the flight; the record describes no examination.', grade: 1, why: "The pilot's statement is not the investigators' examination." },
        { situation: 'The examination found water in the fuel strainer and no mechanical anomaly with the engine itself.', grade: 2, why: 'Contaminated fuel is not a mechanical defect of the engine.' },
        { situation: 'The airplane stalled during the jump run; the engine was producing power at impact and nothing was wrong with it.', grade: 0, why: 'No loss of engine power.' },
      ],
    },
    lure: 'skydiving airplane engine lost power examination revealed fractured failed cylinder crankshaft magneto',
    note: 'Purpose SKYD (skydiving) bounds the cohort. The negation is the examination finding nothing wrong; the contrast is an examination that found the failure. Fuel-related reasons are allowed on purpose: the rubric asks about the engine, not about the cause.',
  },
  {
    id: 'cu-air-show-undetermined',
    question: 'Which air show or air race flights crashed for a reason the investigation could not determine?',
    tags: ['causal_uncertainty', 'operational', 'aircraft_filter'],
    type: 'bounded-cohort',
    filters: { purpose: ['ASHO'] },
    rubric: {
      relevant:
        'The accident happened on an air show or air race flight (a performance, a practice for one, or the race), AND the investigators state that they could not determine why it happened (why the aircraft departed controlled flight, struck the ground or an obstacle, collided, broke up or lost power), and they name no reason as likely or most likely (for example, "for reasons that could not be determined", "the investigation could not determine why the pilot did not recover").',
      partial:
        'Grade 2 does not hold, and the investigators give a likely, probable or possible reason without establishing it ("likely", "may have", "could not be ruled out"), including when they say the reason could not be determined but name a most likely one; or they name several possible reasons and decide on none of them while calling one more likely; or the record states no reason at all and does not say that the reason was undetermined.',
      notRelevant:
        "Anything else, including: the investigators established the reason (for example, the pilot's failure to maintain altitude or clearance during a maneuver, an aerodynamic stall, a structural failure found at examination, fuel exhaustion), even when some details remain unknown.",
      edgeCases: [
        { situation: 'The airplane did not recover from a vertical downline, and the investigation could not determine why the pilot did not begin the recovery.', grade: 2, why: 'Explicitly undetermined, no likely reason named.' },
        { situation: 'The investigation could not determine whether a control jam or the pilot\'s incapacitation caused the loss of control, and named neither as more likely.', grade: 2, why: 'Undetermined between alternatives.' },
        { situation: 'The pilot likely experienced G-induced loss of consciousness during the pull-up.', grade: 1, why: 'A likely reason, not an established one.' },
        { situation: 'The reason for the loss of control could not be determined, although pilot incapacitation was the most likely explanation.', grade: 1, why: 'A most likely reason is named.' },
        { situation: "The pilot's failure to maintain adequate altitude while performing a low-level roll.", grade: 0, why: 'An established reason.' },
      ],
    },
    lure: 'air show aerobatic maneuver pilot failure to maintain altitude excessive load factor aerodynamic stall probable cause',
    note: 'Purpose ASHO (air race or show) bounds the cohort. Causal uncertainty about why an air show or race flight crashed, not limited to engine power. Fix round 1: replaces the banner-tow power-loss question so that fewer families turn on engine power (review M12).',
  },
  {
    id: 'mc-ag-arkansas-engine-after-maintenance',
    question: 'Which agricultural flights in Arkansas lost engine power within 25 hours of operation after maintenance on the engine?',
    tags: ['maintenance_chronology', 'mechanical', 'aircraft_filter'],
    type: 'bounded-cohort',
    filters: { far_part: ['137'], state: ['AR'] },
    rubric: {
      relevant:
        'The record reports a loss of engine power (total or partial), AND maintenance on that engine: an overhaul, a repair, an adjustment, or a part or accessory replaced or installed (an annual, 100-hour or other inspection counts only when the record says it included such work on the engine), AND an interval of 25 hours or less between that maintenance and the power loss on one of the aircraft\'s clocks: flight hours, tachometer hours, Hobbs hours or the engine\'s hours since the work, with both ends read on the same clock (for example, a tachometer reading at the work and another at the accident) and no other clock the record gives above 25 hours; or the power loss happened on the first flight after the work and the record states how long that flight had lasted. The investigators need not link the maintenance to the power loss. ' +
        POWER_LOSS_RECORDED,
      partial:
        'Grade 2 does not hold, but the record reports a loss of engine power and maintenance on the engine (or an inspection that may have included it) before the accident, and the interval is not shown to be more than 25 hours on any clock: it is given only in calendar time ("two weeks before"), as an approximate value near the limit ("about 25 hours"), only as a number of flights or as the first flight without that flight\'s duration, from readings on two different clocks, by two clocks on either side of 25 hours, or not at all; or the only maintenance within 25 hours is a general inspection whose engine work the record does not describe.',
      notRelevant:
        `Anything else, including: no loss of engine power; no maintenance on the engine is stated; the stated interval since the engine maintenance is more than 25 hours on the clock the record uses; or the maintenance concerned only the airframe, the propeller or other systems that are not part of the engine. ${CLOCKS}`,
      edgeCases: [
        { situation: 'The engine had accumulated 12.4 hours since a major overhaul when it lost power.', grade: 2, why: "An interval of 25 hours or less on the engine's own clock." },
        { situation: 'The overhauled engine was installed at a tachometer time of 3,402.1 hours, and the tachometer read 3,420.6 hours at the accident.', grade: 2, why: '18.5 hours, both ends on the tachometer.' },
        { situation: 'A cylinder was replaced about 40 flight hours before the power loss.', grade: 0, why: 'More than 25 hours.' },
        { situation: 'The last 100-hour inspection was 6 hours before the accident; the record does not describe any engine work during it.', grade: 1, why: 'A general inspection whose engine work is not described.' },
        { situation: 'The fuel control unit was replaced, and the power loss happened on the first flight afterwards; how long the flight had lasted is not stated.', grade: 1, why: 'A first flight without its duration does not state the interval.' },
        { situation: 'The magneto was replaced at a Hobbs reading of 1,200.0; the tachometer read 2,215.4 at the accident.', grade: 1, why: 'Readings on different clocks are never compared.' },
        { situation: 'The engine had 15 hours since overhaul, but the airplane struck a power line and no loss of engine power is reported.', grade: 0, why: 'No loss of engine power.' },
      ],
    },
    lure: 'agricultural airplane engine overhauled years before the accident total time since overhaul hours engine power',
    note: 'Part 137 (agricultural) in Arkansas bounds the cohort. Maintenance chronology: an interval of 25 hours or less on one of the record\'s clocks, never converted; calendar time, flight counts, a first flight without its duration and mixed clocks are partial. Fix round 1: reworded from "25 flight hours", which other clocks could not establish (gate item 1).',
  },
  {
    id: 'op-balloon-power-lines',
    question: 'Which hot air balloon flights since 2018 struck power lines?',
    tags: ['operational', 'aircraft_filter'],
    type: 'bounded-cohort',
    filters: { category: ['BALL'], yearFrom: 2018 },
    rubric: {
      relevant:
        'During the flight, including the approach and landing, the balloon (envelope, basket, burner frame or its lines) contacted power lines, utility wires or their poles.',
      partial:
        'Grade 2 does not hold, and either power lines are part of the accident sequence without stated contact (for example, the pilot descended steeply or landed hard to avoid them), or the balloon contacted wires that the record does not identify as power or utility lines (a fence wire, a guy wire, an antenna cable).',
      notRelevant: 'Anything else: no contact with wires, and power lines play no part in the accident sequence.',
      edgeCases: [
        { situation: 'On the landing approach the basket struck power lines, which arced and burned the load tapes.', grade: 2, why: 'Contact with power lines.' },
        { situation: 'To avoid power lines the pilot made a fast descent and the basket tipped over on landing.', grade: 1, why: 'Power lines shaped the sequence, but there was no contact.' },
        { situation: 'The envelope snagged on a tree and the basket was dragged across a field.', grade: 0, why: 'No wires involved.' },
        { situation: 'The basket caught a barbed-wire fence on landing.', grade: 1, why: 'A wire, but not a power or utility line.' },
      ],
    },
    lure: 'hot air balloon hard landing high winds basket tipped over passengers injured landing site',
    relatedCodes: one(finding(WIRE)),
    note: 'Category BALL from 2018 bounds the cohort. Operational: wire strikes, a known balloon hazard. Related codes: the Wire finding (every modifier seen); its coded positives join the pool and disagreements are logged, never labels.',
  },
  {
    id: 'op-external-load-line-strike',
    question: 'Which external-load helicopter flights had the longline, sling or load strike the helicopter?',
    tags: ['operational', 'aircraft_filter'],
    type: 'bounded-cohort',
    filters: { purpose: ['EXLD'] },
    rubric: {
      relevant:
        'During an external-load operation, the longline, sling, cargo-hook equipment or the load itself contacted the helicopter (main rotor, tail rotor, skids, fuselage or tail boom).',
      partial:
        'Grade 2 does not hold, and either contact with the helicopter is suspected but not established ("likely", "may have"), or the line or load became entangled with, or snagged on, trees, terrain or structures and that caused the accident without the line or load contacting the helicopter.',
      notRelevant:
        'Anything else: the line or load neither contacted the helicopter nor snagged on anything in the accident sequence (for example, an engine power loss, a loss of control in the hover, a load dropped without further consequence).',
      edgeCases: [
        { situation: 'After the load was released, the empty longline rose into the tail rotor.', grade: 2, why: 'The line contacted the helicopter.' },
        { situation: 'The load snagged a tree during the lift and the helicopter rolled over.', grade: 1, why: 'An entanglement without contact with the helicopter.' },
        { situation: 'The engine lost power during the lift and the pilot released the load before landing.', grade: 0, why: 'The line and load played no part beyond being released.' },
        { situation: 'The tail rotor damage was consistent with a longline strike, but the investigators could not determine whether it happened before the impact.', grade: 1, why: 'Contact suspected, not established.' },
      ],
    },
    lure: 'external load helicopter engine power loss load released autorotation hover loss of control',
    note: 'Purpose EXLD (external load) bounds the cohort. Operational: the line or load striking the helicopter; entanglement with obstacles is partial.',
  },
  {
    id: 'me-powered-parachute-propeller-strike',
    question: 'Which powered parachute accidents involved the wing, its lines or loose gear getting into the propeller?',
    tags: ['mechanical', 'operational', 'aircraft_filter'],
    type: 'bounded-cohort',
    filters: { category: ['PPAR'] },
    rubric: {
      relevant:
        'The parachute wing (canopy), its suspension or steering lines, or an object carried on the aircraft or by an occupant (clothing, a strap, a helmet, a bag) contacted or became entangled in the propeller, in flight or during the takeoff or landing roll.',
      partial:
        'Grade 2 does not hold, and either the propeller was damaged while the aircraft was operating by something the record does not identify, or contact of the wing, its lines or carried objects with the propeller is suspected but not established.',
      notRelevant:
        "Anything else, including: no contact with or entanglement in the propeller by the wing, its lines or carried objects (for example, a wing collapse, a hard landing, a collision with an obstacle), even when the propeller was damaged when the aircraft hit the ground; or a person's body, not a carried object, contacted the propeller.",
      edgeCases: [
        { situation: 'During the takeoff roll a steering line was drawn into the propeller and the wing collapsed.', grade: 2, why: 'A line in the propeller.' },
        { situation: 'The propeller was damaged when the aircraft nosed over on landing.', grade: 0, why: 'Impact damage only.' },
        { situation: "The pilot's jacket came loose in flight and struck the propeller.", grade: 2, why: 'Loose gear contacted the propeller.' },
        { situation: 'The propeller blades were broken in flight, and the investigators could not determine what struck them.', grade: 1, why: 'Propeller damage from an unidentified source.' },
        { situation: "The passenger's foot slipped off the footrest into the propeller arc.", grade: 0, why: 'A body part, not the wing, its lines or carried gear.' },
      ],
    },
    lure: 'powered parachute wing collapsed turbulence hard landing propeller damaged impact terrain',
    note: 'Category PPAR (powered parachute) bounds the cohort. Mechanical and operational: wing, line or gear contact with the propeller; impact damage alone is not relevant.',
  },

  // -------------------------------------------------------------------------
  // Broad questions (judged on a pool)
  {
    id: 'ng-carb-icing-not-conducive',
    question: 'Which airplane engine power losses happened in weather that was not conducive to carburetor icing?',
    tags: ['negation', 'mechanical', 'aircraft_filter'],
    type: 'broad',
    filters: { category: ['AIR'], engine: ['REC'] },
    rubric: {
      relevant:
        'The record reports a loss of engine power (total or partial), AND states that the weather conditions at the time (temperature and dew point, or the carburetor icing probability chart) were not conducive or not favorable to carburetor icing at the power setting in use. ' +
        POWER_LOSS_RECORDED,
      partial:
        "Grade 2 does not hold, the record reports a loss of engine power and discusses carburetor icing, and the conditions are not stated as conducive at the power setting in use: the statement is mixed or qualified without saying which power setting applied (for example, conducive at glide power but not at cruise power, with the setting in use not stated), or carburetor icing is ruled out for a reason other than the weather (the engine was fuel injected, carburetor heat was applied).",
      notRelevant:
        'Anything else, including: no loss of engine power; the conditions were conducive to carburetor icing at the power setting in use; or carburetor icing is not discussed.',
      edgeCases: [
        { situation: 'Power loss in cruise; the temperature and dew point were "not conducive to carburetor icing at any power setting".', grade: 2, why: 'Explicitly not conducive.' },
        { situation: 'Power loss during the descent; "conditions were conducive to serious carburetor icing at glide power".', grade: 0, why: 'Conducive at the power setting in use.' },
        { situation: 'Power loss in cruise; the chart showed icing only at glide power, not at cruise power.', grade: 2, why: 'Not conducive at the cruise power in use.' },
        { situation: 'Power loss; the engine was fuel injected, so carburetor icing could not occur.', grade: 1, why: 'Icing ruled out, but not by the weather.' },
      ],
    },
    lure: 'loss of engine power temperature dew point conditions conducive to serious carburetor icing at glide power',
    note: 'Airplanes with reciprocating engines. Negation against the coded concept: Track C labels "conducive to carburetor icing"; here the relevant cases say the opposite, and the conducive cases are the hard negatives.',
  },
  {
    id: 'ng-gear-collapse-no-defect',
    question: 'Which airplane landing gear collapses happened even though no pre-existing defect was found in the gear?',
    tags: ['negation', 'mechanical', 'aircraft_filter'],
    type: 'broad',
    filters: { category: ['AIR'], yearFrom: 2010 },
    rubric: {
      relevant:
        'A landing gear leg (main, nose or tail) collapsed, folded or retracted during the landing, takeoff or ground operation, AND the investigators state that their examination of that gear found no pre-existing defect, malfunction or anomaly (for example, "no evidence of a preimpact mechanical malfunction of the landing gear").',
      partial:
        "Grade 2 does not hold, a landing gear leg collapsed, folded or retracted, and no pre-existing defect of it was found: the examination result is general or limited (\"no anomalies with the airplane\" without naming the gear), the gear was not examined, the record only attributes the collapse to the landing (a hard landing, a side load, a loss of directional control), or the only statement that nothing was wrong is the pilot's own (for example, \"the pilot reported no preaccident mechanical malfunctions or failures\").",
      notRelevant:
        'Anything else, including: no gear collapse; the examination found a defect or failure that existed before the accident (a fatigue crack, corrosion, a failed actuator, improper rigging or maintenance); or a gear-up landing in which the gear was never extended (not a collapse).',
      edgeCases: [
        { situation: 'The nose gear collapsed after a hard landing; examination revealed no preimpact anomalies with the nose gear.', grade: 2, why: 'A collapse with an examination of that gear that found nothing.' },
        { situation: 'The right main gear collapsed; the trunnion had a pre-existing fatigue crack.', grade: 0, why: 'A pre-existing defect was found.' },
        { situation: 'The pilot forgot to extend the gear and landed gear up.', grade: 0, why: 'Not a collapse.' },
        { situation: 'The left main gear collapsed during a ground loop; the gear was not examined.', grade: 1, why: 'Collapse without an examination result.' },
        { situation: 'The nose gear collapsed on landing; the pilot reported no preaccident mechanical malfunctions or failures, and the record describes no examination.', grade: 1, why: "The pilot's statement is not the investigators' examination." },
      ],
    },
    lure: 'landing gear collapsed fatigue crack fracture corrosion trunnion actuator failed examination revealed',
    note: 'Airplanes since 2010. Negation: an examination that found no defect; the contrast is a found defect, and a gear-up landing is not a collapse.',
  },
  {
    id: 'mc-first-flight-after-annual',
    question: 'Which accidents happened on the first flight after an annual inspection?',
    tags: ['maintenance_chronology'],
    type: 'broad',
    filters: {},
    rubric: {
      relevant:
        'The record states that the accident flight was the first flight after an annual inspection (or a condition inspection, its equivalent for an amateur-built or light-sport aircraft): explicitly ("the first flight since the annual"), as the test or return-to-service flight right after it, or by stating that the aircraft had not flown since the inspection was completed.',
      partial:
        'Grade 2 does not hold, and either: the record states exactly one flight after the annual inspection before the accident flight (the accident flight was the second); the record does not say whether the aircraft had flown since an annual inspection that it states was completed within the 7 days, or within 5 hours on one stated clock, before the accident; or the accident flight was the first flight after a 100-hour, progressive or other inspection that the record does not call an annual or condition inspection.',
      notRelevant:
        'Anything else, including: the record states two or more flights after the annual inspection before the accident flight; the annual inspection is not stated as completed within those 7 days or 5 hours, and the record does not say the accident flight was the first after it; no annual inspection is described; or the accident flight was the first after other maintenance that the record does not call an inspection. Flights are never worked out from hours or days: only a stated number of flights, a stated earlier flight, or a statement that the aircraft had not flown counts.',
      edgeCases: [
        { situation: 'The annual inspection was signed off on the morning of the accident, and the accident flight was the post-inspection test flight.', grade: 2, why: 'First flight after the annual.' },
        { situation: 'The mechanic flew a 0.3-hour test flight after the annual the day before; the owner\'s flight the next day was the accident flight.', grade: 1, why: 'The second flight after the annual.' },
        { situation: 'The annual inspection was completed 3 days before the accident; the record does not say whether the airplane had flown since.', grade: 1, why: 'A recent annual, the flight count not stated.' },
        { situation: 'The annual inspection was completed 2 months before the accident; the record says nothing about flights since.', grade: 0, why: 'Not within 7 days, and no first flight stated.' },
        { situation: 'The annual inspection was completed 11 months before the accident, and the airplane had not been flown since then.', grade: 2, why: 'Not flown since the annual: the accident flight was the first.' },
        { situation: 'The accident was the first flight after the engine was replaced; no inspection is mentioned.', grade: 0, why: 'Other maintenance, not an annual inspection.' },
      ],
    },
    lure: 'annual inspection completed months before the accident airplane flown hours since the last annual inspection',
    note: 'No filters: the whole answer-eligible cohort. Maintenance chronology anchored on the annual inspection: the flight ordinal must be stated, never inferred from hours; the first flight after other maintenance is a distractor.',
  },
  {
    id: 'mc-helicopter-control-rotor-maintenance-10h',
    question: 'Which helicopter accidents happened within 10 hours of operation after maintenance on the flight controls or rotor system?',
    tags: ['maintenance_chronology', 'mechanical', 'aircraft_filter'],
    type: 'broad',
    filters: { category: ['HELI'] },
    rubric: {
      relevant:
        "The record states maintenance (a repair, a replacement, an adjustment or rigging, or an installation) on a flight control component (cyclic, collective, pedals, servos, control linkages, swashplate) or a rotor system component (main or tail rotor blades, hubs, pitch links, gearboxes, drive shafts), AND an interval of 10 hours or less between that maintenance and the accident on one of the aircraft's clocks (flight hours, the hour meter, Hobbs or tachometer hours), with both ends read on the same clock and no other clock the record gives above 10 hours; or the accident happened on the first flight after the work and the record states how long that flight had lasted. A link to the accident is not required.",
      partial:
        'Grade 2 does not hold, but such maintenance (or a general inspection) is stated before the accident and the interval is not shown to be more than 10 hours on any clock: it is given only in calendar time ("three days before"), as an approximate value near the limit ("about 10 hours"), only as a number of flights or as the first flight without that flight\'s duration, from readings on two different clocks, by two clocks on either side of 10 hours, or not at all; or the only maintenance within 10 hours is a general inspection (annual, 100-hour) whose work on the controls or rotor system the record does not describe.',
      notRelevant:
        `Anything else, including: no maintenance on the flight controls or rotor system is stated; the interval since it is more than 10 hours on the clock the record uses; or the maintenance concerned only the engine, the airframe or the avionics. ${CLOCKS}`,
      edgeCases: [
        { situation: 'The tail rotor pitch link bearings were replaced 2.1 flight hours before the accident.', grade: 2, why: 'Rotor system work inside the window.' },
        { situation: 'The main rotor blades were installed at a Hobbs reading of 412.0, and the Hobbs meter read 418.6 at the accident.', grade: 2, why: '6.6 hours, both ends on one clock.' },
        { situation: 'The main rotor blades were replaced about 300 flight hours before the accident.', grade: 0, why: 'Clearly outside the window.' },
        { situation: 'A 100-hour inspection was done 4 flight hours before the accident; no control or rotor work is described.', grade: 1, why: 'A general inspection without stated control or rotor work.' },
        { situation: 'The cyclic friction was adjusted the day before; the hours flown since are not stated.', grade: 1, why: 'Calendar time only.' },
      ],
    },
    lure: 'helicopter main rotor blades replaced hundreds of hours before the accident maintenance records total time',
    note: 'Helicopters. Maintenance chronology with a component scope (controls or rotor system); engine-only work is excluded. Fix round 1: reworded from "10 flight hours" (gate item 1).',
  },
  {
    id: 'cu-inflight-fire-origin-undetermined',
    question: 'Which in-flight fires had an origin the investigators could not determine?',
    tags: ['causal_uncertainty', 'mechanical'],
    type: 'broad',
    filters: {},
    rubric: {
      relevant:
        'A fire, or smoke from a fire, occurred in flight before any impact (in the engine compartment, the cabin, a wing or elsewhere on the aircraft), AND the investigators state that its origin or source could not be determined, and name no source as likely or most likely.',
      partial:
        'Grade 2 does not hold, an in-flight fire is reported, and its origin was not established: the investigators give a likely or possible source without establishing it (including when they say the origin could not be determined but name a most likely source), name several possible sources and decide on none of them while calling one more likely, or the record does not discuss where the fire started.',
      notRelevant:
        'Anything else, including: no fire before the impact (a fire that started only after the impact, or no fire at all); or the investigators established the source (for example, fuel leaking onto the exhaust, a chafed wire arcing, a failed cabin heater).',
      edgeCases: [
        { situation: 'Smoke filled the cockpit in cruise; the fire damage was too extensive to determine where the fire originated.', grade: 2, why: 'An in-flight fire of undetermined origin.' },
        { situation: 'A postimpact fire consumed the fuselage.', grade: 0, why: 'No fire before the impact.' },
        { situation: 'The in-flight fire most likely originated at a cracked exhaust stack, but this could not be confirmed.', grade: 1, why: 'A likely source is named.' },
        { situation: 'Fuel leaking from a loose fitting sprayed onto the hot exhaust and ignited in flight.', grade: 0, why: 'The source was established.' },
      ],
    },
    lure: 'postimpact fire consumed the fuselage fire started after the impact ruptured fuel tank',
    note: 'No filters. Causal uncertainty about where an in-flight fire started; postimpact fires and established sources are the contrast. Fix round 1: replaces the airplane power-loss question so that fewer families turn on engine power (review M12).',
  },
  {
    id: 'cu-competing-explanations',
    question: 'In which accidents did investigators name more than one possible cause without deciding which it was?',
    tags: ['causal_uncertainty'],
    type: 'broad',
    filters: {},
    rubric: {
      relevant:
        'The analysis or the probable cause names two or more alternative explanations for the same failure or event, and states or makes clear that the investigation could not determine which of them occurred, without naming one as more likely (for example, "the loss of power was due to either carburetor icing or fuel contamination").',
      partial:
        'Grade 2 does not hold, and either one cause is given as likely or possible (alone, or as the more likely of the alternatives named), or alternatives are discussed in the analysis but the probable cause settles on one of them.',
      notRelevant: 'Anything else, including: the investigators determined a single cause; or the cause is undetermined and no candidate explanations are named.',
      edgeCases: [
        { situation: '"The partial loss of engine power due to either carburetor icing or fuel contamination."', grade: 2, why: 'Two alternatives left open.' },
        { situation: '"The pilot\'s loss of control, likely due to spatial disorientation."', grade: 1, why: 'One likely cause, no alternative.' },
        { situation: '"The pilot\'s failure to maintain airspeed, which resulted in an aerodynamic stall."', grade: 0, why: 'A single determined cause.' },
        { situation: 'The analysis weighs a fuel leak against a blocked fuel line, and the probable cause cites the blocked line.', grade: 1, why: 'Alternatives discussed, then one settled on.' },
        { situation: 'The analysis names fuel contamination and carburetor icing as possible causes and calls carburetor icing more likely.', grade: 1, why: 'One alternative named as more likely.' },
      ],
    },
    lure: 'the probable cause was determined to be the pilot failure to maintain adequate airspeed resulting in an aerodynamic stall',
    note: 'No filters: the whole answer-eligible cohort. Causal uncertainty between named alternatives, as opposed to a single likely cause or a fully undetermined one.',
  },
  {
    id: 'pv-pilot-reported-failure-not-confirmed',
    question: 'In which accidents did the pilot report a mechanical failure that the investigation did not confirm?',
    tags: ['pilot_vs_investigator', 'negation'],
    type: 'broad',
    filters: { yearFrom: 2010 },
    rubric: {
      relevant:
        "The record gives the pilot's (or another crew member's) report that a specific mechanical problem occurred (for example, a loss of engine power, a brake failure, jammed controls, a landing gear or instrument malfunction), AND the investigators state that examination or testing found no evidence of that problem, or found the system working.",
      partial:
        'Grade 2 does not hold, the pilot (or crew) reported a mechanical problem, and the investigation did not confirm it: the system could not be examined, the investigators leave it unresolved without saying whether evidence was found, or they found a different problem without addressing the one reported.',
      notRelevant:
        "Anything else, including: the investigation confirmed the problem the pilot reported; or no crew member reported a mechanical problem (a report only by a witness, a mechanic or the operator does not count, and neither does the pilot's statement that there were no mechanical problems).",
      edgeCases: [
        { situation: 'The pilot reported that the brakes failed; examination found that the brake system operated normally.', grade: 2, why: 'Reported failure, examination found it working.' },
        { situation: 'The pilot reported a total loss of engine power; the engine test-ran without anomalies.', grade: 2, why: 'Reported failure not confirmed.' },
        { situation: 'The pilot reported a loss of engine power; examination found a failed magneto.', grade: 0, why: 'The investigation confirmed a failure.' },
        { situation: 'A witness reported the engine sputtering; the pilot reported no problem.', grade: 0, why: 'No crew report of a mechanical problem.' },
        { situation: 'The pilot reported that the landing gear would not extend; the gear system was not examined.', grade: 1, why: 'Reported problem left unresolved.' },
      ],
    },
    lure: 'pilot reported engine failure examination confirmed fractured failed component found consistent with pilot report',
    note: "Since 2010. Pilot-versus-investigator attribution: the pilot's account of a failure against the investigators' examination; a confirmed failure is the contrast.",
  },
  {
    id: 'pv-recorded-data-contradicts-pilot',
    question: "Which accidents had a pilot's account of the flight that recorded data, such as GPS or engine monitor data, contradicted?",
    tags: ['pilot_vs_investigator'],
    type: 'broad',
    filters: { yearFrom: 2012 },
    rubric: {
      relevant:
        "The record gives the pilot's (or crew's) account of something about the flight (altitude, airspeed, fuel state, engine behavior, flight path or the sequence of events), AND data recorded by a device (GPS, ADS-B or radar data, an engine monitor, a flight data recorder, video) about the same thing show something different, whether or not the record points out the difference.",
      partial:
        "Grade 2 does not hold, and either the pilot's (or crew's) account is contradicted only by witnesses or by physical evidence, with no recorded data contradicting it, or recorded data contradict an account given by someone else (a passenger, the operator).",
      notRelevant: "Anything else, including: the record gives no account by the pilot or crew; the recorded data agree with the account; or nothing contradicts the account.",
      edgeCases: [
        { situation: 'The pilot said he climbed to 3,000 ft; ADS-B data showed the airplane never exceeded 900 ft; the record does not comment on the difference.', grade: 2, why: 'Recorded data contradict the account; the difference need not be pointed out.' },
        { situation: 'The pilot reported a loss of engine power; engine monitor data showed normal engine parameters until impact.', grade: 2, why: 'Recorded data contradict the account.' },
        { situation: 'A witness saw the airplane flying lower than the pilot reported; no recorded data were available.', grade: 1, why: 'Contradicted by a witness, not by recorded data.' },
        { situation: "GPS data matched the pilot's description of the approach.", grade: 0, why: 'No contradiction.' },
      ],
    },
    lure: 'GPS data consistent with the pilot account engine monitor data recorded flight track matched',
    note: 'Since 2012, when portable recorders became common. Pilot-versus-investigator attribution through recorded data.',
  },
  {
    id: 'pv-helicopter-tail-rotor-claim',
    question: 'Which helicopter accidents involved a pilot reporting a tail rotor failure that investigators did not find?',
    tags: ['pilot_vs_investigator', 'mechanical', 'aircraft_filter'],
    type: 'broad',
    filters: { category: ['HELI'] },
    rubric: {
      relevant:
        'The pilot (or crew) stated that a tail rotor component or the tail rotor drive failed or malfunctioned (a failure claim, such as "the tail rotor failed" or "we lost tail rotor drive"), AND the investigators found no failure or malfunction of the tail rotor system (including when they attribute the yaw to loss of tail rotor effectiveness, the flight conditions or the pilot\'s technique).',
      partial:
        'Grade 2 does not hold, no failure of the tail rotor system was found, and either the pilot made a failure claim that the record does not settle (the system could not be examined, or impact or fire damage prevented a determination), or the pilot reported a loss of yaw or tail rotor control without claiming that anything failed (for example, reporting a loss of tail rotor effectiveness) and the investigators found no failure.',
      notRelevant: 'Anything else, including: the investigation found a failure or malfunction of the tail rotor system; or the pilot reported no tail rotor or yaw control problem.',
      edgeCases: [
        { situation: 'The pilot reported a tail rotor failure; examination established tail rotor drive continuity and the investigators attributed the spin to loss of tail rotor effectiveness.', grade: 2, why: 'Reported failure not found.' },
        { situation: 'The pilot reported a loss of tail rotor control; the tail rotor drive shaft had fractured from fatigue.', grade: 0, why: 'A failure was found.' },
        { situation: 'The pilot said "something broke" in the tail rotor; the tail boom was destroyed and continuity could not be established.', grade: 1, why: 'A failure claim the record does not settle.' },
        { situation: 'The pilot reported that he experienced a loss of tail rotor effectiveness in a gusty tailwind; examination found no anomalies.', grade: 1, why: 'A reported loss of yaw control, not a failure claim.' },
      ],
    },
    lure: 'helicopter tail rotor drive shaft fractured fatigue failure confirmed examination tail rotor gearbox failed',
    note: 'Helicopters. Pilot-versus-investigator attribution on a mechanical claim; a confirmed tail rotor failure is the contrast, and a reported loss of control without a failure claim is partial.',
  },
  {
    id: 'ma-airplane-collision-student-pilot',
    question: 'In which collisions between two airplanes was one of them flown by a student pilot?',
    tags: ['multi_aircraft', 'aircraft_filter'],
    type: 'broad',
    filters: { category: ['AIR'] },
    rubric: {
      relevant:
        'Two or more airplanes collided (in flight or on the ground), AND the record states that one of the colliding airplanes was flown by a student pilot (a person the record calls a student pilot, or who held a student pilot certificate), solo or with an instructor on board.',
      partial:
        'Grade 2 does not hold, two airplanes collided, and one of the colliding airplanes was on an instructional flight, but the record does not say whether the person receiving instruction was a student pilot or a certificated pilot.',
      notRelevant:
        'Anything else, including: only one aircraft was involved, or the collision was with a vehicle, an object or an animal; the person receiving instruction is identified as a certificated pilot (private or higher) receiving a flight review, a proficiency check or training for a rating, even when the flight\'s purpose is given as instructional; or a student pilot was on board only as a passenger, or in an aircraft that did not collide.',
      edgeCases: [
        { situation: "A solo student pilot's airplane collided with another airplane on final approach.", grade: 2, why: 'A student flew one of the colliding airplanes.' },
        { situation: 'A student pilot on a solo flight struck a deer on landing.', grade: 0, why: 'Not a collision between airplanes.' },
        { situation: 'Two airplanes collided on the runway; one pilot, who held a private pilot certificate, was receiving a flight review.', grade: 0, why: 'A flight review of a certificated pilot is not student instruction.' },
        { situation: 'Two airplanes collided; one was on an instructional flight, but the record does not say what certificate the pilot receiving instruction held.', grade: 1, why: 'Student involvement not established.' },
      ],
    },
    lure: 'student pilot solo flight landing accident bounced runway excursion flight instructor endorsement',
    note: 'Airplanes only: a multi-aircraft event qualifies only when every aircraft is an airplane (the passages-v2 qualification). Cross-aircraft attribution: the student must be flying one of the colliding airplanes; the header purpose "Instructional" alone does not make a student pilot.',
  },
  {
    id: 'ma-taxiing-strikes-stationary',
    question: 'Which ground collisions happened when a taxiing aircraft struck a parked or stopped aircraft?',
    tags: ['multi_aircraft', 'operational'],
    type: 'broad',
    filters: {},
    rubric: {
      relevant:
        'An aircraft taxiing under its own power struck another aircraft that was parked, stopped or holding still at the time (its propeller or rotor striking the other aircraft included).',
      partial:
        'Grade 2 does not hold, and two aircraft collided on the ground but the record does not make clear which one was moving or whether the other was stopped; or both were moving; or the moving aircraft was on its takeoff or landing roll, or being towed or pushed, rather than taxiing.',
      notRelevant: 'Anything else, including a midair collision, or a collision on the ground with a vehicle, a building, a fence or another object.',
      edgeCases: [
        { situation: "While taxiing to the ramp, the airplane's propeller struck a parked helicopter.", grade: 2, why: 'Taxiing aircraft struck a parked aircraft.' },
        { situation: 'During the landing roll the airplane struck an airplane holding short of the runway.', grade: 1, why: 'A landing roll, not taxiing.' },
        { situation: "The taxiing airplane's wing struck a hangar.", grade: 0, why: 'Not another aircraft.' },
        { situation: 'Two airplanes taxiing in opposite directions touched wingtips.', grade: 1, why: 'Neither aircraft was stopped.' },
      ],
    },
    lure: 'airplane taxiing struck hangar fence vehicle fuel truck sign wing damaged while taxiing to the ramp',
    note: 'No filters: the multi-aircraft events are a small part of the cohort. Attribution of which aircraft moved.',
  },
  {
    id: 'ma-midair-pattern-nontowered',
    question: 'Which midair collisions between airplanes happened in the traffic pattern at an airport without an operating control tower?',
    tags: ['multi_aircraft', 'operational', 'aircraft_filter'],
    type: 'broad',
    filters: { category: ['AIR'] },
    rubric: {
      relevant:
        'Two airplanes collided in flight, AND the record places the collision in or next to an airport traffic pattern (upwind, crosswind, downwind, base, final, or entering the pattern), AND that airport had no operating control tower at the time: the record calls it non-towered or uncontrolled, says the tower was closed, or says the pilots were making position reports on the common traffic advisory frequency (CTAF), which is used where no tower is operating.',
      partial:
        'Grade 2 does not hold, and either a midair collision happened in or next to an airport traffic pattern where the record does not say whether a control tower was operating, or a midair collision happened near a non-towered airport but outside its pattern.',
      notRelevant: "Anything else, including: not a midair collision; a midair away from any airport traffic pattern (en route, a practice area); or the airport's control tower was operating.",
      edgeCases: [
        { situation: 'Two airplanes collided on final approach to a non-towered airport.', grade: 2, why: 'Pattern, non-towered.' },
        { situation: 'Two airplanes collided on base leg while both pilots were announcing their positions on the common traffic advisory frequency; the record does not mention a tower.', grade: 2, why: 'CTAF position reports: no tower was operating.' },
        { situation: 'Two airplanes collided on the downwind leg; the record says nothing about a tower or the radio frequency.', grade: 1, why: 'Tower status unknown.' },
        { situation: 'Two airplanes collided on final at a towered airport while the tower was open.', grade: 0, why: 'An operating tower.' },
        { situation: 'Two airplanes came close in the pattern but did not touch.', grade: 0, why: 'No collision.' },
      ],
    },
    lure: 'midair collision en route cruise flight practice area two airplanes collided level flight control tower',
    note: 'Airplanes only (every aircraft of the event must be an airplane). Multi-aircraft with an operational condition.',
  },
  {
    id: 'op-night-vfr-into-clouds',
    question: 'Which night flights under visual flight rules continued into clouds or fog before crashing?',
    tags: ['operational'],
    type: 'broad',
    filters: { light: ['NITE', 'NDRK', 'NBRT'] },
    rubric: {
      relevant:
        'The flight was at night and under visual flight rules (no instrument flight plan or clearance), AND the record states that the aircraft entered or continued into clouds, fog or instrument meteorological conditions (restricted visibility) before the accident.',
      partial:
        'Grade 2 does not hold, the flight was under visual flight rules, and either it was at night in deteriorating weather where entry into clouds or IMC is likely but not stated (for example, low ceilings along the route), or it entered IMC at dusk or dawn where the record does not say it was night.',
      notRelevant:
        'Anything else, including: the flight was on an instrument flight plan or clearance; no entry into clouds, fog or IMC is described and none is likely; or the accident happened in visual conditions (for example, a night landing accident in clear weather).',
      edgeCases: [
        { situation: 'The pilot, who held no instrument rating, departed at night without a flight plan into an area of low clouds and lost control after entering the clouds.', grade: 2, why: 'Night, VFR, entered clouds.' },
        { situation: 'The pilot was on an IFR flight plan and crashed during the instrument approach in fog.', grade: 0, why: 'Not a VFR flight.' },
        { situation: 'Night VFR flight; ceilings along the route were 500 ft overcast and the airplane struck terrain, but the record does not say it entered clouds.', grade: 1, why: 'Entry into IMC likely, not stated.' },
        { situation: 'A night landing in clear weather ended in a runway excursion.', grade: 0, why: 'No clouds or IMC.' },
      ],
    },
    lure: 'night instrument flight rules approach clouds fog instrument landing system clearance IFR flight plan',
    note: 'Light conditions night, night dark and night bright (event facet; the header shows them). Operational: VFR into IMC at night; IFR flights are the contrast.',
  },
  {
    id: 'me-gear-up-mechanical',
    question: 'Since 2015, which airplanes landed with the landing gear up because a mechanical, hydraulic or electrical problem kept it from extending?',
    tags: ['mechanical', 'aircraft_filter'],
    type: 'broad',
    filters: { category: ['AIR'], yearFrom: 2015 },
    rubric: {
      relevant:
        'The airplane landed (or attempted to land) with one or more landing gear legs not extended or not locked, AND the investigators found a mechanical, hydraulic or electrical malfunction or failure that prevented normal extension or locking (for example, a failed motor, actuator, pump or cable, or a fault that opened a circuit breaker), AND the record does not say that the pilot failed to use a published emergency extension that would have extended the gear.',
      partial:
        'Grade 2 does not hold, the airplane landed with gear not extended or not locked, and either the pilot reported a malfunction that the investigators did not or could not examine (no finding either way), or a malfunction was found but the record says the pilot did not use the published emergency extension procedure, which would have extended the gear, so both contributed.',
      notRelevant:
        'Anything else, including: the pilot did not extend the landing gear (forgot, was distracted, misread the indications) and no malfunction was found, including when the gear extended normally when tested after the accident; the gear extended and then collapsed; or there was no gear-up landing.',
      edgeCases: [
        { situation: "The landing gear motor's brushes were worn out and the gear would not extend; the emergency extension also failed.", grade: 2, why: 'A mechanical failure prevented extension.' },
        { situation: 'The pilot reported the gear would not extend; after the accident the gear extended normally on jacks.', grade: 0, why: 'No malfunction was found.' },
        { situation: 'The pilot became distracted by traffic and did not extend the gear.', grade: 0, why: 'Pilot omission.' },
        { situation: 'A hydraulic line had chafed through and the gear extended only partly; the pilot did not use the hand pump as published.', grade: 1, why: 'Malfunction and procedure both contributed.' },
      ],
    },
    lure: 'pilot did not extend the landing gear distracted forgot gear warning horn checklist gear-up landing',
    relatedCodes: one(finding(GEAR_EXTENSION_FAILURE)),
    note: 'Airplanes since 2015. Mechanical cause against pilot omission. Related codes: the gear extension and retraction system coded Failure, Malfunction or Inoperative (anywhere).',
  },
  {
    id: 'me-helicopter-tail-rotor-drive-failure',
    question: 'Which helicopters lost tail rotor drive in flight because a drive shaft, coupling or gearbox failed?',
    tags: ['mechanical', 'aircraft_filter'],
    type: 'broad',
    filters: { category: ['HELI'] },
    rubric: {
      relevant:
        'In flight (including the hover), the tail rotor lost its drive, AND the investigators identified the failure of a tail rotor drive component (a drive shaft or its sections, a coupling, a hanger bearing, the intermediate or tail rotor gearbox, splines) as the reason.',
      partial:
        'Grade 2 does not hold, and either the tail rotor lost its drive in flight but the failed drive component was not identified, or its failure is suspected but not established; or a drive component failure was found but it happened on the ground, or the record cannot say whether it happened before the impact.',
      notRelevant:
        'Anything else, including: the tail rotor drive was lost because the tail rotor or tail boom struck something (an object, terrain, the main rotor); loss of tail rotor effectiveness without a component failure; a failure of a tail rotor blade, hub or pitch link rather than of the drive; or no loss of tail rotor drive.',
      edgeCases: [
        { situation: 'The tail rotor drive shaft failed in flight from a fatigue crack at a hanger bearing.', grade: 2, why: 'A drive component failure caused the loss of drive.' },
        { situation: 'The tail rotor struck a tree during the approach and the helicopter spun.', grade: 0, why: 'A strike, not a drive failure.' },
        { situation: 'The pilot lost directional control in a crosswind hover; no mechanical anomaly was found.', grade: 0, why: 'Loss of tail rotor effectiveness, no failure.' },
        { situation: 'The tail rotor gearbox output shaft was fractured, but the investigators could not determine whether it fractured before the impact.', grade: 1, why: 'Failure suspected, not established.' },
        { situation: 'A tail rotor pitch link fractured in flight and the helicopter lost yaw control.', grade: 0, why: 'A pitch-control failure, not the drive.' },
      ],
    },
    lure: 'helicopter tail rotor struck tree object terrain loss of tail rotor effectiveness spun hover',
    relatedCodes: one(finding(TAIL_ROTOR_DRIVE)),
    note: 'Helicopters. Mechanical: an identified drive component failure; tail rotor strikes, loss of tail rotor effectiveness and blade or pitch link failures are the contrast. Related codes: the tail rotor drive system failures (anywhere).',
  },
];

/**
 * Paraphrases: reworded for retrieval only, judged against their original question and
 * rubric (one set of judgments per family).
 */
export const NARRATIVE_PARAPHRASES: readonly NarrativeParaphraseSpec[] = [
  {
    id: 'para-inflight-fire-origin-undetermined',
    of: 'cu-inflight-fire-origin-undetermined',
    question: 'Which aircraft caught fire while flying, without anyone figuring out what started it?',
    note: 'Lay wording of an undetermined fire origin: no "in-flight fire", "origin", "investigators" or "determine".',
  },
  {
    id: 'para-first-flight-after-annual',
    of: 'mc-first-flight-after-annual',
    question: 'Which aircraft crashed the very first time they flew after coming out of their yearly inspection?',
    note: 'Lay wording: "yearly inspection" for annual inspection.',
  },
  {
    id: 'para-pilot-reported-failure-not-confirmed',
    of: 'pv-pilot-reported-failure-not-confirmed',
    question: 'When did a pilot say something on the aircraft broke, but the examiners found it working fine?',
    note: 'Lay wording without "mechanical failure", "report" or "investigation".',
  },
  {
    id: 'para-powered-parachute-propeller-strike',
    of: 'me-powered-parachute-propeller-strike',
    question: 'Which powered parachutes got their canopy lines or other gear sucked into the prop?',
    note: 'A paraphrase of a bounded cohort, so its Recall@20 is defined once the cohort is judged.',
  },
];
