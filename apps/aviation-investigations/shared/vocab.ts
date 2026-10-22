/**
 * Display vocabularies for the coded NTSB fields the interface shows, transcribed
 * from the eADMSPUB data dictionary in the 2026-10-16 avall.mdb snapshot (public
 * US government data). Fixed product labels are used where the dictionary's own
 * meanings are truncated ("Control flight into terr/obj"). Codes are upper-case.
 *
 * `codeLabel`-style lookups fall back to the raw code, so a vocabulary change in a
 * later snapshot shows the code instead of failing. The facet vocabularies in
 * `shared/contracts/search.ts` are built from these tables.
 */

export type Vocabulary = Readonly<Record<string, string>>;

/** `events.ev_type`. */
export const EVENT_TYPE: Vocabulary = { ACC: 'Accident', INC: 'Incident', OCC: 'Occurrence', UNK: 'Unknown event type' };

/** `aircraft.acft_category`. WSFT and PPAR appear in the data with blank dictionary codes. */
export const AIRCRAFT_CATEGORY: Vocabulary = {
  AIR: 'Airplane',
  HELI: 'Helicopter',
  GLI: 'Glider',
  BALL: 'Balloon',
  BLIM: 'Blimp',
  GYRO: 'Gyrocraft',
  PLFT: 'Powered-lift',
  ULTR: 'Ultralight',
  WSFT: 'Weight-shift',
  PPAR: 'Powered parachute',
  UNK: 'Unknown',
};

/** Noun used in headlines for a category other than airplane. */
export const CATEGORY_NOUN: Vocabulary = {
  HELI: 'helicopter',
  GLI: 'glider',
  BALL: 'balloon',
  BLIM: 'blimp',
  GYRO: 'gyroplane',
  PLFT: 'powered-lift aircraft',
  ULTR: 'ultralight',
  WSFT: 'weight-shift aircraft',
  PPAR: 'powered parachute',
};

/** `aircraft.far_part`: the operating rules. */
export const FAR_PART: Vocabulary = {
  '091': 'Part 91',
  '091F': 'Part 91F special flight',
  '091K': 'Part 91K fractional',
  '103': 'Part 103 ultralight',
  '105': 'Part 105 parachute jumping',
  '121': 'Part 121 air carrier',
  '125': 'Part 125',
  '127': 'Part 127',
  '129': 'Part 129 foreign',
  '133': 'Part 133 external load',
  '135': 'Part 135 air taxi and commuter',
  '137': 'Part 137 agricultural',
  '141': 'Part 141 pilot school',
  ARMF: 'Armed forces',
  NUSC: 'Non-US commercial',
  NUSN: 'Non-US non-commercial',
  PUBF: 'Public use, federal',
  PUBL: 'Public use, local',
  PUBS: 'Public use, state',
  PUBU: 'Public use',
  UNK: 'Unknown operation',
};

/** `aircraft.type_fly`: the purpose of the flight (the data also uses the PUBF/PUBL/PUBS public-use codes). */
export const FLIGHT_PURPOSE: Vocabulary = {
  AAPL: 'Aerial application',
  ADRP: 'Air drop',
  AIRM: 'Air medical',
  AOBV: 'Aerial observation',
  ASHO: 'Air race or show',
  ATXA: 'Air taxi, non-scheduled',
  ATXC: 'Air taxi, commuter',
  ATXO: 'Air taxi, large aircraft',
  ATXS: 'Air taxi, scheduled',
  BANT: 'Banner tow',
  BUS: 'Business',
  CRGO: 'All-cargo',
  EXEC: 'Executive/corporate',
  EXLD: 'External load',
  FERY: 'Ferry',
  FIRF: 'Firefighting',
  FLTS: 'Flight test',
  GLDT: 'Glider tow',
  HIRE: 'For hire',
  ILGL: 'Illegal operation',
  INDS: 'Industrial special',
  INST: 'Instructional',
  OTH: 'Other',
  OWRK: 'Other work use',
  PERS: 'Personal',
  POSI: 'Positioning',
  PUBF: 'Public use, federal',
  PUBL: 'Public use, local',
  PUBS: 'Public use, state',
  PUBU: 'Public use',
  SCAC: 'Scheduled air carrier',
  SCRH: 'Scheduled helicopter carrier',
  SITE: 'Sightseeing',
  SKYD: 'Skydiving',
  SUPP: 'Supplemental',
  TVLC: 'Travel club',
  UNK: 'Unknown purpose',
};

/** `aircraft.damage`. */
export const DAMAGE: Vocabulary = {
  DEST: 'Destroyed',
  SUBS: 'Substantial damage',
  MINR: 'Minor damage',
  NONE: 'No damage',
  UNK: 'Unknown damage',
};

/** `engines.eng_type`. */
export const ENGINE_TYPE: Vocabulary = {
  REC: 'Reciprocating',
  TP: 'Turboprop',
  TF: 'Turbofan',
  TJ: 'Turbojet',
  TS: 'Turboshaft',
  UNK: 'Unknown engine',
};

/** `engines.carb_fuel_injection`. */
export const FUEL_SYSTEM: Vocabulary = { CARB: 'Carburetor', FINJ: 'Fuel injection', UNK: 'Unknown' };

/** `events.sky_cond_ceil`. */
export const SKY_CEILING: Vocabulary = {
  BKN: 'Broken',
  OVC: 'Overcast',
  OBSC: 'Obscured',
  VV: 'Indefinite (vertical visibility)',
  NONE: 'None',
  UNK: 'Unknown',
};

/** `events.sky_cond_nonceil`. */
export const SKY_NON_CEILING: Vocabulary = {
  CLER: 'Clear',
  FEW: 'Few',
  SCAT: 'Scattered',
  BKNT: 'Thin broken',
  OVCT: 'Thin overcast',
  POBS: 'Partial obscuration',
  NONE: 'None',
  UNK: 'Unknown',
};

/** `events.wx_int_precip`. */
export const PRECIPITATION: Vocabulary = { LGT: 'Light', MOD: 'Moderate', HVY: 'Heavy', UNK: 'Unknown' };

/** `events.ev_tmzn`, as recorded. */
export const TIME_ZONE: Vocabulary = {
  ADT: 'Atlantic daylight time',
  AST: 'Atlantic standard time',
  BST: 'Bering standard time',
  CDT: 'Central daylight time',
  CST: 'Central standard time',
  EDT: 'Eastern daylight time',
  EST: 'Eastern standard time',
  HDT: 'Hawaii daylight time',
  HST: 'Hawaii standard time',
  MDT: 'Mountain daylight time',
  MST: 'Mountain standard time',
  PDT: 'Pacific daylight time',
  PST: 'Pacific standard time',
  UTC: 'UTC',
  YDT: 'Yukon daylight time',
  YST: 'Yukon standard time',
};

/**
 * `events.ev_state`: the dictionary's US states, territories and US-administered
 * waters (the code list also holds some foreign countries; those are not states
 * of a US record and are left to the raw-code fallback).
 */
export const US_STATE: Vocabulary = {
  AK: 'Alaska', AL: 'Alabama', AR: 'Arkansas', AZ: 'Arizona', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DC: 'District of Columbia', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', IA: 'Iowa', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', MA: 'Massachusetts', MD: 'Maryland', ME: 'Maine',
  MI: 'Michigan', MN: 'Minnesota', MO: 'Missouri', MS: 'Mississippi', MT: 'Montana',
  NC: 'North Carolina', ND: 'North Dakota', NE: 'Nebraska', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NV: 'Nevada', NY: 'New York', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VA: 'Virginia', VT: 'Vermont',
  WA: 'Washington', WI: 'Wisconsin', WV: 'West Virginia', WY: 'Wyoming',
  PR: 'Puerto Rico', RQ: 'Puerto Rico', VI: 'US Virgin Islands', VQ: 'US Virgin Islands',
  GU: 'Guam', AQ: 'American Samoa', CQ: 'Northern Mariana Islands', KQ: 'Kingman Reef',
  WQ: 'Wake Island', PS: 'Trust Territory of the Pacific Islands',
  AO: 'Atlantic Ocean', PO: 'Pacific Ocean', GM: 'Gulf of America', CB: 'Caribbean Sea', UN: 'Unknown',
};

/**
 * `Events_Sequence.phase_no` (the `NNNxxx` rows of the occurrence-code dictionary),
 * in the dictionary's spelling with a product hyphen style.
 */
export const PHASE_CODE: Vocabulary = {
  '100': 'Prior to flight',
  '150': 'Standing',
  '151': 'Standing, engines not operating',
  '152': 'Standing, engine start-up',
  '153': 'Standing, engines operating',
  '154': 'Standing, engine shutdown',
  '200': 'Pushback/towing',
  '201': 'Pushback/tow, engine not operating',
  '202': 'Pushback/tow, engine start-up',
  '203': 'Pushback/tow, engine operating',
  '204': 'Pushback/tow, engine shutdown',
  '250': 'Taxi',
  '251': 'Taxi to runway',
  '252': 'Taxi into takeoff position',
  '253': 'Taxi from runway',
  '300': 'Takeoff',
  '301': 'Rejected takeoff',
  '350': 'Initial climb',
  '400': 'En route',
  '401': 'En route, climb to cruise',
  '402': 'En route, cruise',
  '403': 'En route, change of cruise level',
  '404': 'En route, descent',
  '405': 'En route, holding (IFR)',
  '450': 'Maneuvering',
  '451': 'Maneuvering, aerobatics',
  '452': 'Maneuvering, low-altitude flying',
  '453': 'Maneuvering, hover',
  '500': 'Approach',
  '501': 'Approach, IFR initial approach',
  '502': 'Approach, IFR final approach',
  '503': 'Approach, circling (IFR)',
  '504': 'Approach, IFR missed approach',
  '505': 'Approach, VFR pattern crosswind',
  '506': 'Approach, VFR pattern downwind',
  '507': 'Approach, VFR pattern base',
  '508': 'Approach, VFR pattern final',
  '509': 'Approach, VFR go-around',
  '550': 'Landing',
  '551': 'Landing, flare/touchdown',
  '552': 'Landing, landing roll',
  '553': 'Landing, aborted after touchdown',
  '600': 'Emergency descent',
  '601': 'Autorotation',
  '650': 'Uncontrolled descent',
  '700': 'Post-impact',
  '750': 'After landing',
  '800': 'Other',
  '990': 'Unknown',
};

/**
 * `Events_Sequence.eventsoe_no` (the `xxxNNN` rows of the occurrence-code
 * dictionary). Truncated dictionary meanings are spelled out.
 */
export const EVENT_CODE: Vocabulary = {
  '000': 'Unknown or undetermined',
  '010': 'Aircraft loading event',
  '020': 'Aircraft servicing event',
  '030': 'Preflight or dispatch event',
  '040': 'Aircraft maintenance event',
  '050': 'Aircraft inspection event',
  '060': 'Attempted remediation/recovery',
  '070': 'Airport occurrence',
  '080': 'Ground handling event',
  '081': 'Aircraft, propeller or rotor contact with person',
  '082': 'Propeller, jet or rotor blast/suction',
  '090': 'Abnormal runway contact',
  '091': 'Tailstrike',
  '092': 'Hard landing',
  '093': 'Dragged wing, rotor, float or other',
  '094': 'Landing gear collapse',
  '095': 'Landing gear not configured',
  '096': 'Nose over/nose down',
  '097': 'Roll over',
  '100': 'Air traffic event',
  '110': 'Cabin safety event',
  '120': 'Controlled flight into terrain/object (CFIT)',
  '130': 'Emergency descent initiated',
  '140': 'Engine shutdown',
  '150': 'Fire/smoke (non-impact)',
  '160': 'Explosion (non-impact)',
  '170': 'Fire/smoke (post-impact)',
  '180': 'Explosion (post-impact)',
  '190': 'Fuel related',
  '191': 'Fuel starvation',
  '192': 'Fuel exhaustion',
  '193': 'Fuel contamination',
  '194': 'Wrong fuel',
  '200': 'Ground collision',
  '210': 'Icing encounter',
  '220': 'Low altitude operations',
  '230': 'Loss of control on ground',
  '231': 'Dynamic rollover',
  '232': 'Ground resonance',
  '240': 'Loss of control in flight',
  '241': 'Aerodynamic stall/spin',
  '242': 'Loss of tail rotor effectiveness',
  '243': 'Retreating blade stall',
  '244': 'Settling with power/vortex ring state',
  '245': 'Mast bumping',
  '250': 'Midair collision',
  '260': 'Near midair collision',
  '270': 'Abrupt maneuver',
  '271': 'Inflight upset',
  '280': 'Course deviation',
  '290': 'Altitude deviation',
  '300': 'Runway excursion',
  '310': 'Runway incursion, animal',
  '320': 'Runway incursion, vehicle/aircraft/person',
  '330': 'System/component malfunction (non-power)',
  '331': 'Pressurization/environmental system malfunction',
  '332': 'Electrical system malfunction',
  '333': 'Flight control system malfunction',
  '334': 'Flight instrument malfunction',
  '335': 'Navigation system malfunction',
  '336': 'Communication system malfunction',
  '337': 'Aircraft structural failure',
  '338': 'Part(s) separation from aircraft',
  '340': 'Powerplant system/component malfunction',
  '341': 'Loss of engine power (total)',
  '342': 'Loss of engine power (partial)',
  '343': 'Uncontained engine failure',
  '350': 'Security/criminal event',
  '360': 'Turbulence encounter',
  '361': 'Wake turbulence encounter',
  '362': 'Clear air turbulence encounter',
  '370': 'Landing area undershoot',
  '380': 'Landing area overshoot',
  '390': 'Windshear or thunderstorm',
  '400': 'Other weather encounter',
  '401': 'VFR encounter with IMC',
  '402': 'Loss of visual reference',
  '410': 'Terrain avoidance alert',
  '420': 'Collision avoidance alert',
  '430': 'Stall warning/stick shaker/pusher',
  '440': 'Off-field or emergency landing',
  '441': 'Ditching',
  '450': 'Hazardous material leak/spill',
  '460': 'Evacuation',
  '470': 'Collision with terrain/object (non-CFIT)',
  '480': 'External load event (rotorcraft)',
  '490': 'Collision during takeoff/landing',
  '500': 'Loss of lift',
  '510': 'Glider tow event',
  '600': 'Simulated/training event',
  '900': 'Miscellaneous/other',
  '901': 'Birdstrike',
  '990': 'Missing aircraft',
};

/**
 * Event codes that are an impact with terrain, water or an object on the surface;
 * the flight profile marks them with an ✕ on the ground line (UI_DESIGN §2.5). A
 * midair collision is not one: it happens at the phase's height.
 */
export const IMPACT_EVENT_CODES: ReadonlySet<string> = new Set(['120', '200', '441', '470', '490']);

/** Label for a code: the vocabulary's label, `blankLabel` for blank, else the raw code. */
export function vocabLabel(vocabulary: Vocabulary, code: string | null | undefined, blankLabel = 'Not reported'): string {
  const key = (code ?? '').trim().toUpperCase();
  if (key === '') return blankLabel;
  return Object.hasOwn(vocabulary, key) ? (vocabulary[key] as string) : key;
}
