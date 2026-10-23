/**
 * The checker calibration's questions (Task 16c): each brings a real retrieval bundle
 * (hybrid retrieval over the served passages index, `pnpm eval:checker retrieve`), the
 * production shape of what the checker is given. `keywordText` stands in for the scope
 * stage's keyword text (the BM25 channel); the dense channel embeds the question, as the
 * pipeline does. A question's bundle is assigned to the development or the held-out split
 * with every case in it: no case appears in both splits.
 */
export interface CalibrationQuestion {
  id: string;
  split: 'dev' | 'holdout';
  question: string;
  keywordText: string;
}

export const QUESTIONS: readonly CalibrationQuestion[] = [
  {
    id: 'q-power-loss-maintenance',
    split: 'dev',
    question: 'Engine power loss shortly after maintenance',
    // The paid run's scope output (rerun at efe27ce).
    keywordText: 'engine power loss after maintenance mechanic fuel pump carburetor maintenance error',
  },
  {
    id: 'q-first-flight-annual',
    split: 'dev',
    question: 'Accidents on the first flight after an annual inspection',
    keywordText: 'first flight after annual inspection engine power loss accident',
  },
  {
    id: 'q-day-after-maintenance',
    split: 'dev',
    question: 'Engine failure the day after maintenance was completed',
    keywordText: 'engine failure maintenance completed previous day annual inspection',
  },
  {
    id: 'q-midair-two-airplanes',
    split: 'dev',
    question: 'Two airplanes collided and one had just had maintenance',
    keywordText: 'collided midair two airplanes maintenance inspection',
  },
  {
    id: 'q-midair-first-flight',
    split: 'dev',
    question: 'Midair collision on the first flight after an annual inspection',
    keywordText: 'midair collision first flight after annual inspection both airplanes',
  },
  {
    id: 'q-oil-change',
    split: 'holdout',
    question: 'Loss of oil after an oil change',
    keywordText: 'oil loss oil change oil filler cap oil filter not secured maintenance',
  },
  {
    id: 'q-engine-replaced',
    split: 'holdout',
    question: 'Power loss after the engine was replaced or overhauled',
    keywordText: 'engine replaced overhauled power loss hours after installation',
  },
  {
    id: 'q-fuel-line-fitting',
    split: 'holdout',
    question: 'Loose fuel line fitting found after recent maintenance',
    keywordText: 'loose fuel line fitting torque maintenance power loss',
  },
  {
    id: 'q-midair-maintenance',
    split: 'holdout',
    question: 'Midair collisions where one of the airplanes had recent maintenance',
    keywordText: 'midair collision annual inspection maintenance first flight',
  },
];

/**
 * Task 16d's held-out questions: maintenance topics the 16c questions did not ask, so their
 * bundles' cases can be disjoint from both 16c splits (the builder refuses a held-out case
 * that was in either). Retrieved with `retrieve --questions 16d`; a bundle that shares a
 * case with 16c is not used.
 */
export const QUESTIONS_16D: readonly CalibrationQuestion[] = [
  {
    id: 'q16d-magneto',
    split: 'holdout',
    question: 'Engine problems after a magneto was replaced or its timing was set',
    keywordText: 'magneto replaced magneto timing ignition engine power loss after maintenance',
  },
  {
    id: 'q16d-carburetor',
    split: 'holdout',
    question: 'Power loss after the carburetor was overhauled or reinstalled',
    keywordText: 'carburetor overhauled reinstalled float bowl power loss maintenance',
  },
  {
    id: 'q16d-propeller',
    split: 'holdout',
    question: 'Propeller failures after propeller maintenance',
    keywordText: 'propeller blade separated propeller overhaul maintenance governor',
  },
  {
    id: 'q16d-landing-gear',
    split: 'holdout',
    question: 'Landing gear problems after the landing gear was serviced or repaired',
    keywordText: 'landing gear collapse actuator repaired serviced maintenance retraction',
  },
  {
    id: 'q16d-controls',
    split: 'holdout',
    question: 'Flight controls rigged or connected incorrectly during maintenance',
    keywordText: 'flight control cables reversed misrigged rigging elevator aileron maintenance',
  },
  {
    id: 'q16d-throttle',
    split: 'holdout',
    question: 'Throttle or mixture linkage that came apart after maintenance',
    keywordText: 'throttle cable mixture linkage disconnected cotter pin nut maintenance',
  },
  {
    id: 'q16d-helicopter',
    split: 'holdout',
    question: 'Helicopter tail rotor or drive system failures after maintenance',
    keywordText: 'helicopter tail rotor drive shaft maintenance failure installation',
  },
  {
    id: 'q16d-fire',
    split: 'holdout',
    question: 'Engine fires after maintenance on the engine',
    keywordText: 'engine fire fuel leak maintenance fitting fire in flight',
  },
  {
    id: 'q16d-cylinder',
    split: 'holdout',
    question: 'Cylinder failures after a cylinder was replaced',
    keywordText: 'cylinder replaced cylinder head separated hold down nuts torque power loss',
  },
  {
    id: 'q16d-fuel-water',
    split: 'holdout',
    question: 'Water or debris in the fuel after maintenance or refueling',
    keywordText: 'water in fuel contamination fuel tank sump debris maintenance power loss',
  },
  {
    id: 'q16d-exhaust',
    split: 'holdout',
    question: 'Exhaust system failures after an inspection',
    keywordText: 'exhaust muffler cracked exhaust stack separated annual inspection',
  },
  {
    id: 'q16d-fuel-selector',
    split: 'holdout',
    question: 'Fuel starvation from a fuel selector or fuel valve after maintenance',
    keywordText: 'fuel selector valve fuel starvation maintenance installed incorrectly',
  },
  {
    id: 'q16d-spark-plugs',
    split: 'holdout',
    question: 'Rough running after spark plugs or ignition leads were serviced',
    keywordText: 'spark plugs ignition harness leads rough running maintenance',
  },
  {
    id: 'q16d-oil-line',
    split: 'holdout',
    question: 'Oil line or oil cooler failures after maintenance',
    keywordText: 'oil line oil cooler hose loose fitting oil leak maintenance power loss',
  },
  {
    id: 'q16d-fuel-pump',
    split: 'holdout',
    question: 'Engine-driven fuel pump problems after it was replaced',
    keywordText: 'engine driven fuel pump replaced installed power loss fuel pressure',
  },
  {
    id: 'q16d-rotorcraft-engine',
    split: 'holdout',
    question: 'Helicopter engine power loss after an engine change or inspection',
    keywordText: 'helicopter engine power loss engine change inspection maintenance',
  },
  {
    // Added before any 16d checker output (16c review M8): the other bundles state the previous calendar day only once.
    id: 'q16d-day-after-part',
    split: 'holdout',
    question: 'Engine trouble on the day after an engine part was replaced',
    keywordText: 'replaced the day before the accident engine part installed run-up',
  },
];

/**
 * Task 16e's held-out questions: maintenance topics no earlier question asked, retrieved
 * under `retrieval.v2` (the production default, with its cases-index channel) with
 * `retrieve --questions 16e`. A bundle that holds a case of any earlier split (16c, 16d) is
 * not used, as the protocol (`protocol.v3.ts`, `HELDOUT_V3`) pre-registers: the first nine
 * usable bundles in this order, and more only to cover a critical timing mutation.
 */
export const QUESTIONS_16E: readonly CalibrationQuestion[] = [
  {
    id: 'q16e-turbocharger',
    split: 'holdout',
    question: 'Engine power loss after turbocharger or wastegate maintenance',
    keywordText: 'turbocharger wastegate exhaust bypass maintenance replaced power loss',
  },
  {
    id: 'q16e-crankshaft',
    split: 'holdout',
    question: 'Crankshaft or connecting rod failures after an engine overhaul',
    keywordText: 'crankshaft connecting rod failure overhaul rebuilt engine bearing',
  },
  {
    id: 'q16e-fuel-cap',
    split: 'holdout',
    question: 'Fuel caps or fuel tank vents left open or blocked after servicing',
    keywordText: 'fuel cap missing fuel tank vent blocked servicing fuel siphoned',
  },
  {
    id: 'q16e-valve',
    split: 'holdout',
    question: 'Engine valve or valve train failures after cylinder work',
    keywordText: 'exhaust valve stuck valve guide rocker arm pushrod cylinder maintenance',
  },
  {
    id: 'q16e-injection',
    split: 'holdout',
    question: 'Fuel injection servo or nozzle problems after maintenance',
    keywordText: 'fuel injection servo nozzle flow divider maintenance power loss',
  },
  {
    id: 'q16e-induction',
    split: 'holdout',
    question: 'Air filter or induction system blockage after maintenance',
    keywordText: 'air filter induction intake blocked maintenance engine power',
  },
  {
    id: 'q16e-gascolator',
    split: 'holdout',
    question: 'Gascolator or fuel strainer left loose after maintenance',
    keywordText: 'gascolator fuel strainer bowl loose leak maintenance',
  },
  {
    id: 'q16e-primer',
    split: 'holdout',
    question: 'Engine primer left unlocked or primer line leaking after maintenance',
    keywordText: 'primer unlocked primer line leak rich mixture maintenance',
  },
  {
    id: 'q16e-p-lead',
    split: 'holdout',
    question: 'Magneto ground wire or ignition switch problems after maintenance',
    keywordText: 'p-lead magneto ground wire ignition switch maintenance engine quit',
  },
  {
    id: 'q16e-main-rotor',
    split: 'holdout',
    question: 'Helicopter main rotor or swashplate problems after maintenance',
    keywordText: 'main rotor swashplate pitch link bolt helicopter maintenance',
  },
  {
    id: 'q16e-trim',
    split: 'holdout',
    question: 'Trim tab or trim system problems after maintenance',
    keywordText: 'trim tab trim cable actuator reversed maintenance control',
  },
  {
    id: 'q16e-homebuilt-engine',
    split: 'holdout',
    question: 'Power loss on an amateur-built airplane after its engine installation',
    keywordText: 'experimental amateur built engine installation first flight power loss',
  },
  {
    id: 'q16e-oil-cap',
    split: 'holdout',
    question: 'Oil cap or dipstick not secured after an inspection',
    keywordText: 'oil cap dipstick not secured oil loss inspection',
  },
  {
    id: 'q16e-fuel-quantity',
    split: 'holdout',
    question: 'Fuel quantity gauges wrong after maintenance and the engine ran out of fuel',
    keywordText: 'fuel quantity gauge indication inaccurate maintenance fuel exhaustion',
  },
  {
    id: 'q16e-mount',
    split: 'holdout',
    question: 'Engine mount or engine baffle problems found after maintenance',
    keywordText: 'engine mount bolt cracked baffle maintenance vibration',
  },
  {
    id: 'q16e-seaplane',
    split: 'holdout',
    question: 'Seaplane or float problems after maintenance',
    keywordText: 'float seaplane water rudder leak maintenance',
  },
];
