/**
 * NTSB code vocabularies: flight-phase groups, flag values, and display labels for
 * the injury, light and basic-weather codes. Codes are verified against the
 * 2026-10-16 avall.mdb snapshot and its embedded eADMSPUB_DataDictionary.
 */

export type PhaseGroup =
  | 'prior_to_flight'
  | 'standing'
  | 'pushback'
  | 'taxi'
  | 'takeoff'
  | 'initial_climb'
  | 'en_route'
  | 'maneuvering'
  | 'approach'
  | 'landing'
  | 'emergency_descent'
  | 'uncontrolled_descent'
  | 'post_impact'
  | 'after_landing'
  | 'other'
  | 'unknown';

/** Phase groups in flight order; `unknown` last. Use for facet and chart ordering. */
export const PHASE_GROUPS: readonly PhaseGroup[] = [
  'prior_to_flight',
  'standing',
  'pushback',
  'taxi',
  'takeoff',
  'initial_climb',
  'en_route',
  'maneuvering',
  'approach',
  'landing',
  'emergency_descent',
  'uncontrolled_descent',
  'post_impact',
  'after_landing',
  'other',
  'unknown',
];

export const PHASE_LABEL: Readonly<Record<PhaseGroup, string>> = {
  prior_to_flight: 'Prior to flight',
  standing: 'Standing',
  pushback: 'Pushback/towing',
  taxi: 'Taxi',
  takeoff: 'Takeoff',
  initial_climb: 'Initial climb',
  en_route: 'En route',
  maneuvering: 'Maneuvering',
  approach: 'Approach',
  landing: 'Landing',
  emergency_descent: 'Emergency descent',
  uncontrolled_descent: 'Uncontrolled descent',
  post_impact: 'Post-impact',
  after_landing: 'After landing',
  other: 'Other',
  unknown: 'Unknown',
};

/**
 * Inclusive `Events_Sequence.phase_no` ranges. Every phase code in the snapshot falls
 * in one of them; anything else (including the dictionary's 204, never used) and 990
 * map to `unknown`.
 */
const PHASE_RANGES: readonly (readonly [number, number, PhaseGroup])[] = [
  [100, 100, 'prior_to_flight'],
  [150, 154, 'standing'],
  [200, 203, 'pushback'],
  [250, 253, 'taxi'],
  [300, 301, 'takeoff'],
  [350, 350, 'initial_climb'],
  [400, 405, 'en_route'],
  [450, 453, 'maneuvering'],
  [500, 509, 'approach'],
  [550, 553, 'landing'],
  [600, 601, 'emergency_descent'],
  [650, 650, 'uncontrolled_descent'],
  [700, 700, 'post_impact'],
  [750, 750, 'after_landing'],
  [800, 800, 'other'],
];

export function phaseGroupOf(phaseNo: number): PhaseGroup {
  if (!Number.isInteger(phaseNo)) return 'unknown';
  for (const [lo, hi, group] of PHASE_RANGES) {
    if (phaseNo >= lo && phaseNo <= hi) return group;
  }
  return 'unknown';
}

/** Sort and deduplicate phase groups into `PHASE_GROUPS` order. */
export function orderPhaseGroups(groups: Iterable<PhaseGroup>): PhaseGroup[] {
  const present = new Set(groups);
  return PHASE_GROUPS.filter((g) => present.has(g));
}

/**
 * The actual vocabulary of each decoded flag column (amendment A8). A value outside
 * it is an error for the caller to record; JavaScript truthiness is never used.
 * `afm_hrs_since` is exported as Y/N although the dictionary documents ACCI/INSP
 * codes, so the flag is kept as recorded and its meaning is not interpreted.
 * `homebuilt` also allows the dictionary's U (unknown), decoded as null.
 */
export const FLAG_VOCABULARY = {
  defining_ev: { '1': true, '0': false },
  afm_hrs_since: { Y: true, N: false },
  cm_inpc: { T: true, F: false },
  homebuilt: { Y: true, N: false, U: null },
} as const satisfies Record<string, Readonly<Record<string, boolean | null>>>;

export type FlagColumn = keyof typeof FLAG_VOCABULARY;

const FLAG_MAPS: Readonly<Record<FlagColumn, ReadonlyMap<string, boolean | null>>> = {
  defining_ev: new Map(Object.entries(FLAG_VOCABULARY.defining_ev)),
  afm_hrs_since: new Map(Object.entries(FLAG_VOCABULARY.afm_hrs_since)),
  cm_inpc: new Map(Object.entries(FLAG_VOCABULARY.cm_inpc)),
  homebuilt: new Map(Object.entries(FLAG_VOCABULARY.homebuilt)),
};

export type FlagResult = { ok: true; value: boolean | null } | { ok: false; raw: string };

/** Decode one flag field. Blank (empty or whitespace) is null; matching is exact after trimming. */
export function decodeFlag(column: FlagColumn, raw: string | null | undefined): FlagResult {
  const value = (raw ?? '').trim();
  if (value === '') return { ok: true, value: null };
  const map = FLAG_MAPS[column];
  if (!map.has(value)) return { ok: false, raw: raw ?? '' };
  return { ok: true, value: map.get(value) ?? null };
}

/** Event columns with display labels. */
export type LabelledColumn = 'ev_highest_injury' | 'light_cond' | 'wx_cond_basic';
export type CodeLabels = Readonly<Record<LabelledColumn, Readonly<Record<string, string>>>>;

/** Label for a blank code: the field was not filled in. */
export const NOT_REPORTED_LABEL = 'Not reported';

/**
 * Product labels for the codes observed in the snapshot (verified against the
 * dictionary's ct_inj_ix, ct_light_cond and ct_wx_cond_b). Fixed labels are used
 * because some dictionary meanings are truncated ("Visual Meteorological Cond").
 * Keys are upper-case; the source spells unknown weather as `Unk`.
 */
export const DEFAULT_CODE_LABELS: CodeLabels = {
  ev_highest_injury: { FATL: 'Fatal', SERS: 'Serious', MINR: 'Minor', NONE: 'None', UNK: 'Unknown' },
  light_cond: {
    DAYL: 'Day',
    DAWN: 'Dawn',
    DUSK: 'Dusk',
    NITE: 'Night',
    NDRK: 'Night, dark',
    NBRT: 'Night, bright',
    NR: 'Not reported',
  },
  wx_cond_basic: { VMC: 'VMC', IMC: 'IMC', UNK: 'Unknown' },
};

/** Display label: the mapped label, `Not reported` for blank, else the raw code itself. */
export function codeLabel(column: LabelledColumn, code: string | null, labels: CodeLabels = DEFAULT_CODE_LABELS): string {
  const key = (code ?? '').trim().toUpperCase();
  if (key === '') return NOT_REPORTED_LABEL;
  const map = labels[column];
  return Object.hasOwn(map, key) ? (map[key] as string) : (code ?? '').trim();
}

export interface DictionaryCodeRow {
  readonly table: string;
  readonly column: string;
  readonly code_iaids: string;
  readonly meaning: string;
}

export interface ResolvedCodeLabels {
  labels: CodeLabels;
  source: 'fixed' | 'fixed+dictionary';
  /** Dictionary codes the fixed map lacked; their dictionary meaning is used as the label. */
  addedFromDictionary: { column: LabelledColumn; code: string; meaning: string }[];
}

const LABELLED_COLUMNS: readonly LabelledColumn[] = ['ev_highest_injury', 'light_cond', 'wx_cond_basic'];

/**
 * Merge the fixed labels with the `eadmspub_datadictionary` rows when that table is
 * available: fixed labels win, dictionary codes the fixed map lacks are added and
 * reported so a vocabulary change is visible at load time.
 */
export function resolveCodeLabels(dictionary: readonly DictionaryCodeRow[] | undefined): ResolvedCodeLabels {
  if (!dictionary) return { labels: DEFAULT_CODE_LABELS, source: 'fixed', addedFromDictionary: [] };
  const merged: Record<LabelledColumn, Record<string, string>> = {
    ev_highest_injury: { ...DEFAULT_CODE_LABELS.ev_highest_injury },
    light_cond: { ...DEFAULT_CODE_LABELS.light_cond },
    wx_cond_basic: { ...DEFAULT_CODE_LABELS.wx_cond_basic },
  };
  const added: ResolvedCodeLabels['addedFromDictionary'] = [];
  for (const row of dictionary) {
    if (row.table.trim().toLowerCase() !== 'events') continue;
    const column = LABELLED_COLUMNS.find((c) => c === row.column.trim().toLowerCase());
    const code = row.code_iaids.trim().toUpperCase();
    const meaning = row.meaning.trim();
    if (!column || code === '' || meaning === '' || Object.hasOwn(merged[column], code)) continue;
    merged[column][code] = meaning;
    added.push({ column, code, meaning });
  }
  return { labels: merged, source: 'fixed+dictionary', addedFromDictionary: added };
}
