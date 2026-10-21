import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import {
  decodeFlag,
  orderPhaseGroups,
  phaseGroupOf,
  resolveCodeLabels,
  type DictionaryCodeRow,
  type FlagColumn,
  type PhaseGroup,
  type ResolvedCodeLabels,
} from '../../shared/codes.js';
import {
  COMPLETION_MAPPING_V1,
  completionClassOf,
  isAnswerEligible,
  isCohortProvisional,
  type CompletionClass,
  type CompletionMapping,
} from '../../shared/completion.js';
import { CITATION_TEXT_VERSION, toCitationText, type CitationText } from './citation-text.js';
import { blankToNull, parseDecimal, parseInteger, parseIsoDate, parseIsoDateTime } from './scalars.js';
import { TABLE_NAMES, TABLE_SPECS, type TableName } from './tables.js';

export { CITATION_TEXT_VERSION, TEXT_NORMALIZATION_VERSION } from './citation-text.js';

/**
 * Field normalization rules (code trimming and upper-casing, flag and scalar decoding,
 * section scoping). Citation text has its own `CITATION_TEXT_VERSION`.
 */
export const FIELD_NORMALIZATION_VERSION = 'v1';

export const REQUIRED_TABLES = [
  'events',
  'aircraft',
  'narratives',
  'findings',
  'events_sequence',
  'ntsb_admin',
] as const satisfies readonly TableName[];
export type RequiredTable = (typeof REQUIRED_TABLES)[number];
export type OptionalTable = Exclude<TableName, RequiredTable>;

/** One projected CSV record: every allowlisted column, empty string for NULL. */
export type RowOf<T extends TableName> = Readonly<Record<(typeof TABLE_SPECS)[T]['columns'][number], string>>;
export type RawTables = { readonly [T in RequiredTable]: readonly RowOf<T>[] } & {
  readonly [T in OptionalTable]?: readonly RowOf<T>[];
};

export type SectionKind = 'factual' | 'analysis' | 'probable_cause';
export type SectionScope = 'event' | 'aircraft';

/** Narrative column to section kind, in display order. */
export const NARRATIVE_KINDS: readonly (readonly ['narr_accp' | 'narr_accf' | 'narr_cause', SectionKind])[] = [
  ['narr_accp', 'factual'],
  ['narr_accf', 'analysis'],
  ['narr_cause', 'probable_cause'],
];

export interface CanonicalSection {
  /** Unique within a case: `<kind>/event` or `<kind>/aircraft-<key>`. */
  key: string;
  kind: SectionKind;
  /**
   * `event` when the identical source text was recorded for every aircraft of a
   * multi-aircraft event (stored once); otherwise `aircraft`, attributed to its row.
   */
  scope: SectionScope;
  /** Null for event scope. */
  aircraftKey: number | null;
  /** Aircraft whose narrative row carried this text. */
  aircraftKeys: number[];
  /** Canonical citation text (`CITATION_TEXT_VERSION`). */
  text: string;
  /** sha256 hex of `text` (UTF-8). */
  sha256: string;
  /** The narrative field exactly as exported. */
  sourceText: string;
  sourceSha256: string;
  transformedFromHtml: boolean;
  citationTextVersion: string;
  /** Latest `narratives.lchg_date` of the rows behind the section. */
  lastChangedAt: string | null;
}

export interface CanonicalEngine {
  engNo: number | null;
  /** `eng_type` code (REC, TP, TF, ...). */
  engType: string | null;
  /** `carb_fuel_injection` code (CARB, FINJ). */
  carbFuelInjection: string | null;
}

export interface CanonicalSequenceEvent {
  aircraftKey: number;
  occurrenceNo: number;
  /** `phase_no`. */
  phaseNo: number | null;
  phaseGroup: PhaseGroup;
  /** `eventsoe_no`, the event code within the phase. */
  eventCode: string | null;
  occurrenceCode: string | null;
  description: string | null;
  /** `defining_ev`: 1 -> true, 0 -> false. */
  isDefining: boolean | null;
  lastChangedAt: string | null;
}

export interface CanonicalFinding {
  aircraftKey: number;
  findingNo: number;
  code: string | null;
  description: string | null;
  /** `cm_inpc`: T -> true, F -> false, blank -> null. Cause and contributing findings are not distinguished. */
  inProbableCause: boolean | null;
  /** Deprecated `cause_factor` code (C, F), kept raw. */
  causeFactor: string | null;
  categoryNo: string | null;
  subcategoryNo: string | null;
  sectionNo: string | null;
  subsectionNo: string | null;
  modifierNo: string | null;
  lastChangedAt: string | null;
}

export interface CanonicalAircraft {
  aircraftKey: number;
  /** `aircraft.ntsb_no`; suffixed (A, B) in multi-aircraft events. Never used for joins. */
  aircraftNtsbNo: string | null;
  regisNo: string | null;
  make: string | null;
  model: string | null;
  series: string | null;
  /** `acft_category` code (AIR, HELI, GLI, ...). */
  category: string | null;
  /** `far_part` code (091, 135, NUSN, ...). */
  farPart: string | null;
  /** `type_fly` code (PERS, INST, BUS, ...). */
  purpose: string | null;
  /** `damage` code (SUBS, DEST, MINR, NONE, UNK). */
  damage: string | null;
  /** `homebuilt`: Y -> true, N -> false, U or blank -> null. */
  homebuilt: boolean | null;
  numEngines: number | null;
  dateLastInsp: string | null;
  afmHrs: number | null;
  afmHrsLastInsp: number | null;
  /** `afm_hrs_since` Y/N as recorded; its meaning is unverified (the dictionary lists ACCI/INSP). */
  afmHrsSince: boolean | null;
  acftYear: number | null;
  engines: CanonicalEngine[];
  definingEvent: CanonicalSequenceEvent | null;
  /** Phase group of this aircraft's defining event. */
  definingPhaseGroup: PhaseGroup | null;
  phaseGroups: PhaseGroup[];
  hasProbableCause: boolean;
  /** Key of this aircraft's probable-cause section (aircraft- or event-scoped). */
  probableCauseSectionKey: string | null;
}

export interface CanonicalEventFields {
  evType: string | null;
  evDate: string | null;
  evDow: string | null;
  /** `ev_time`, HHMM as recorded, in the `ev_tmzn` zone. */
  evTime: number | null;
  evTmzn: string | null;
  city: string | null;
  state: string | null;
  evYear: number | null;
  evMonth: number | null;
  lightCond: string | null;
  skyCondNonceil: string | null;
  skyNonceilHt: number | null;
  skyCeilHt: number | null;
  skyCondCeil: string | null;
  visSm: number | null;
  /** Recorded as-is; zeros are not interpreted (DATA_REVIEW quality constraints). */
  wxTemp: number | null;
  wxDewPt: number | null;
  windDirDeg: number | null;
  windDirInd: string | null;
  windVelKts: number | null;
  windVelInd: string | null;
  gustInd: string | null;
  gustKts: number | null;
  altimeter: number | null;
  wxDensAlt: number | null;
  wxIntPrecip: string | null;
  wxCondBasic: string | null;
  metar: string | null;
  highestInjury: string | null;
  injFGrnd: number | null;
  injMGrnd: number | null;
  injSGrnd: number | null;
  injTotF: number | null;
  injTotM: number | null;
  injTotN: number | null;
  injTotS: number | null;
  injTotT: number | null;
  lastChangedAt: string | null;
}

export interface CanonicalCase {
  /** Public case key (event-level `ntsb_no`). */
  ntsbNo: string;
  /** Internal event id. */
  evId: string;
  /** `ev_country` as published (e.g. USA). */
  country: string | null;
  isUs: boolean;
  fields: CanonicalEventFields;
  /** From `dec_latitude`/`dec_longitude` only; null when missing or invalid. */
  location: { lat: number; lon: number } | null;
  aircraft: CanonicalAircraft[];
  sections: CanonicalSection[];
  findings: CanonicalFinding[];
  sequence: CanonicalSequenceEvent[];
  /** Defining-event phase of the lowest aircraft key that has a defining event. */
  definingPhaseGroup: PhaseGroup | null;
  /** Every phase group in the sequence, in flight order. */
  phaseGroups: PhaseGroup[];
  /** `NTSB_Admin.rec_stat`, trimmed; null when blank or the admin row is missing. */
  rawStatus: string | null;
  approvalDate: string | null;
  adminLastChangedAt: string | null;
  completionClass: CompletionClass;
  completionMappingVersion: string;
  /** At least one nonblank probable-cause section (canonical text). */
  hasProbableCause: boolean;
  /** Completed and has probable cause. US membership is enforced separately. */
  answerEligible: boolean;
  /** sha256 hex over this case's projected source rows; changes exactly when they change. */
  sourceRevision: string;
}

export type QuarantineReason =
  | 'invalid_key'
  | 'orphan_row'
  | 'missing_admin_row'
  | 'invalid_number'
  | 'invalid_date'
  | 'date_has_time'
  | 'coordinate_out_of_range'
  | 'coordinate_incomplete'
  | 'unknown_flag'
  | 'multiple_defining_events';

export interface QuarantineRow {
  table: TableName;
  /** Source key, e.g. `ev_id=...,aircraft_key=1,finding_no=2`. */
  key: string;
  column: string | null;
  reason: QuarantineReason;
  /** What happened: the row was left out, the value set to null, or kept with a note. */
  action: 'row_excluded' | 'value_nulled' | 'value_kept';
  /** The offending scalar value (truncated), never narrative text. */
  value: string | null;
  detail: string;
}

export interface NormalizeStats {
  events: number;
  usEvents: number;
  aircraft: number;
  sections: number;
  eventScopedSections: number;
  htmlTransformedSections: number;
  answerEligible: number;
  answerEligibleUs: number;
  completedWithoutCause: number;
}

export interface NormalizeResult {
  cases: CanonicalCase[];
  quarantine: QuarantineRow[];
  completionMapping: CompletionMapping;
  /** True while the completion mapping is unverified (amendment A5). */
  cohortProvisional: boolean;
  citationTextVersion: string;
  fieldNormalizationVersion: string;
  codeLabels: ResolvedCodeLabels;
  stats: NormalizeStats;
}

export interface NormalizeOptions {
  mapping?: CompletionMapping;
}

/** Structural problems (missing tables or columns, duplicate keys, blank case numbers) that stop a run. */
export class NormalizationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    const shown = problems.slice(0, 20);
    const more = problems.length > shown.length ? `\n... and ${problems.length - shown.length} more` : '';
    super(problems.length === 1 ? (problems[0] as string) : `${problems.length} problems:\n${shown.join('\n')}${more}`);
    this.name = 'NormalizationError';
    this.problems = problems;
  }
}

type AnyRow = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// Keys

type KeyKind = 'id' | 'int' | 'optional-int';
type KeyedTable = Exclude<TableName, 'ct_seqevt' | 'eadmspub_datadictionary'>;

/** Composite keys from amendment A1 (plus `ntsb_admin.ev_id`). */
const KEY_COLUMNS: Readonly<Record<KeyedTable, readonly (readonly [string, KeyKind])[]>> = {
  events: [['ev_id', 'id']],
  ntsb_admin: [['ev_id', 'id']],
  aircraft: [['ev_id', 'id'], ['aircraft_key', 'int']],
  engines: [['ev_id', 'id'], ['aircraft_key', 'int'], ['eng_no', 'optional-int']],
  narratives: [['ev_id', 'id'], ['aircraft_key', 'int']],
  findings: [['ev_id', 'id'], ['aircraft_key', 'int'], ['finding_no', 'int']],
  events_sequence: [['ev_id', 'id'], ['aircraft_key', 'int'], ['occurrence_no', 'int']],
};

interface KeyedRow {
  row: AnyRow;
  evId: string;
  aircraftKey: number;
  /** Third key part (eng_no, finding_no, occurrence_no) when present. */
  sub: number | null;
  key: string;
}

const NON_NEGATIVE_INT = /^\d+$/;

function keyOf(table: KeyedTable, row: AnyRow): { ok: true; keyed: KeyedRow } | { ok: false; key: string; column: string; value: string } {
  const parts: string[] = [];
  const values: (string | number | null)[] = [];
  let bad: { column: string; value: string } | null = null;
  for (const [column, kind] of KEY_COLUMNS[table]) {
    const raw = row[column] ?? '';
    const value = raw.trim();
    parts.push(`${column}=${value}`);
    if (kind === 'id') {
      if (value === '' && !bad) bad = { column, value: raw };
      values.push(value);
    } else if (value === '' && kind === 'optional-int') {
      values.push(null);
    } else if (NON_NEGATIVE_INT.test(value) && Number.isSafeInteger(Number(value))) {
      values.push(Number(value));
    } else {
      if (!bad) bad = { column, value: raw };
      values.push(null);
    }
  }
  const key = parts.join(',');
  if (bad) return { ok: false, key, ...bad };
  return {
    ok: true,
    keyed: {
      row,
      evId: values[0] as string,
      aircraftKey: typeof values[1] === 'number' ? values[1] : 0,
      sub: typeof values[2] === 'number' ? values[2] : null,
      key,
    },
  };
}

function truncate(value: string): string {
  return value.length > 100 ? `${value.slice(0, 100)}...` : value;
}

class Notes {
  readonly rows: QuarantineRow[] = [];
  add(
    table: TableName,
    key: string,
    column: string | null,
    reason: QuarantineReason,
    action: QuarantineRow['action'],
    value: string | null,
    detail: string,
  ): void {
    this.rows.push({ table, key, column, reason, action, value: value === null ? null : truncate(value), detail });
  }
}

/** Index rows by key; malformed keys are quarantined, duplicates become problems. */
function indexRows(
  table: KeyedTable,
  rows: readonly AnyRow[],
  structural: Notes,
  problems: string[],
): KeyedRow[] {
  const out: KeyedRow[] = [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = keyOf(table, row);
    if (!k.ok) {
      if (table === 'events') problems.push(`events: blank or invalid ${k.column} (${k.key})`);
      else structural.add(table, k.key, k.column, 'invalid_key', 'row_excluded', k.value, `key column ${k.column} is blank or not an integer`);
      continue;
    }
    counts.set(k.keyed.key, (counts.get(k.keyed.key) ?? 0) + 1);
    out.push(k.keyed);
  }
  for (const [key, n] of counts) {
    if (n > 1) problems.push(`${table}: duplicate key ${key} (${n} rows)`);
  }
  return out;
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const byAircraftThenSub = (a: KeyedRow, b: KeyedRow): number =>
  a.aircraftKey - b.aircraftKey || (a.sub ?? -1) - (b.sub ?? -1);

/** Code-unit comparison: deterministic regardless of locale. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Field readers

/** Codes: trimmed and upper-cased (`Unk` -> `UNK`, `BUS ` -> `BUS`), blank -> null. */
function code(raw: string | undefined): string | null {
  const value = blankToNull(raw);
  return value === null ? null : value.toUpperCase();
}

class FieldReader {
  constructor(
    private readonly notes: Notes,
    private readonly table: TableName,
    private readonly key: string,
    private readonly row: AnyRow,
  ) {}

  raw(column: string): string {
    return this.row[column] ?? '';
  }

  decimal(column: string): number | null {
    const p = parseDecimal(this.raw(column));
    if (p.ok) return p.value;
    this.notes.add(this.table, this.key, column, 'invalid_number', 'value_nulled', p.raw, 'not a decimal number');
    return null;
  }

  integer(column: string): number | null {
    const p = parseInteger(this.raw(column));
    if (p.ok) return p.value;
    this.notes.add(this.table, this.key, column, 'invalid_number', 'value_nulled', p.raw, 'not an integer');
    return null;
  }

  date(column: string): string | null {
    const p = parseIsoDate(this.raw(column));
    if (!p.ok) {
      this.notes.add(this.table, this.key, column, 'invalid_date', 'value_nulled', p.raw, 'not a valid ISO date');
      return null;
    }
    if (p.droppedTime !== undefined) {
      this.notes.add(this.table, this.key, column, 'date_has_time', 'value_kept', this.raw(column), `date column has time ${p.droppedTime}; date part kept`);
    }
    return p.value;
  }

  dateTime(column: string): string | null {
    const p = parseIsoDateTime(this.raw(column));
    if (p.ok) return p.value;
    this.notes.add(this.table, this.key, column, 'invalid_date', 'value_nulled', p.raw, 'not a valid ISO timestamp');
    return null;
  }

  flag(column: FlagColumn): boolean | null {
    const d = decodeFlag(column, this.raw(column));
    if (d.ok) return d.value;
    this.notes.add(this.table, this.key, column, 'unknown_flag', 'value_nulled', d.raw, `value outside the ${column} vocabulary`);
    return null;
  }
}

function coordinate(r: FieldReader, notes: Notes, key: string, column: 'dec_latitude' | 'dec_longitude', limit: number): {
  value: number | null;
  present: boolean;
  valid: boolean;
} {
  const raw = r.raw(column);
  const p = parseDecimal(raw);
  if (!p.ok) {
    notes.add('events', key, column, 'invalid_number', 'value_nulled', raw, 'coordinate is not a decimal number');
    return { value: null, present: true, valid: false };
  }
  if (p.value === null) return { value: null, present: false, valid: false };
  if (p.value < -limit || p.value > limit) {
    notes.add('events', key, column, 'coordinate_out_of_range', 'value_nulled', raw, `outside [-${limit}, ${limit}]`);
    return { value: null, present: true, valid: false };
  }
  return { value: p.value, present: true, valid: true };
}

function location(r: FieldReader, notes: Notes, key: string): { lat: number; lon: number } | null {
  const lat = coordinate(r, notes, key, 'dec_latitude', 90);
  const lon = coordinate(r, notes, key, 'dec_longitude', 180);
  if (lat.valid && lon.valid && lat.value !== null && lon.value !== null) return { lat: lat.value, lon: lon.value };
  if (lat.valid !== lon.valid && !(lat.present && !lat.valid) && !(lon.present && !lon.valid)) {
    const missing = lat.valid ? 'dec_longitude' : 'dec_latitude';
    notes.add('events', key, missing, 'coordinate_incomplete', 'value_nulled', null, 'only one coordinate of the pair is present');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalization

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sourceValues(table: TableName, row: AnyRow): string[] {
  return TABLE_SPECS[table].columns.map((c) => row[c] ?? '');
}

function maxString(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) if (v !== null && (best === null || v > best)) best = v;
  return best;
}

function checkColumns(tables: Readonly<Partial<Record<TableName, readonly AnyRow[]>>>): string[] {
  const problems: string[] = [];
  for (const table of TABLE_NAMES) {
    const rows = tables[table];
    if (rows === undefined) {
      if ((REQUIRED_TABLES as readonly string[]).includes(table)) problems.push(`${table}: required table missing`);
      continue;
    }
    const missing = new Set<string>();
    for (const row of rows) {
      for (const column of TABLE_SPECS[table].columns) if (!Object.hasOwn(row, column)) missing.add(column);
    }
    for (const column of missing) problems.push(`${table}: required column "${column}" missing`);
  }
  return problems;
}

interface Indexed {
  events: KeyedRow[];
  admin: Map<string, KeyedRow>;
  aircraft: Map<string, KeyedRow[]>;
  engines: Map<string, KeyedRow[]>;
  narratives: Map<string, KeyedRow[]>;
  findings: Map<string, KeyedRow[]>;
  sequence: Map<string, KeyedRow[]>;
}

/**
 * Index every table by its composite key, fail on duplicates and blank case numbers,
 * and quarantine rows with malformed keys or without a parent (event for admin and
 * aircraft rows; event + aircraft for child rows).
 */
function indexCorpus(tables: Readonly<Partial<Record<TableName, readonly AnyRow[]>>>, structural: Notes): Indexed {
  const problems: string[] = [];
  const events = indexRows('events', tables.events ?? [], structural, problems);
  const admin = indexRows('ntsb_admin', tables.ntsb_admin ?? [], structural, problems);
  const aircraft = indexRows('aircraft', tables.aircraft ?? [], structural, problems);
  const engines = indexRows('engines', tables.engines ?? [], structural, problems);
  const narratives = indexRows('narratives', tables.narratives ?? [], structural, problems);
  const findings = indexRows('findings', tables.findings ?? [], structural, problems);
  const sequence = indexRows('events_sequence', tables.events_sequence ?? [], structural, problems);

  const ntsbCounts = new Map<string, number>();
  for (const e of events) {
    const no = (e.row.ntsb_no ?? '').trim();
    if (no === '') problems.push(`events: blank ntsb_no for ${e.key}`);
    else ntsbCounts.set(no, (ntsbCounts.get(no) ?? 0) + 1);
  }
  for (const [no, n] of ntsbCounts) if (n > 1) problems.push(`events: duplicate ntsb_no ${no} (${n} rows)`);
  if (problems.length > 0) throw new NormalizationError(problems);

  const evIds = new Set(events.map((e) => e.evId));
  const withParent = (table: TableName, rows: KeyedRow[], parents: Set<string>, parentKey: (r: KeyedRow) => string): KeyedRow[] =>
    rows.filter((r) => {
      if (parents.has(parentKey(r))) return true;
      structural.add(table, r.key, null, 'orphan_row', 'row_excluded', null, 'no parent row with this key');
      return false;
    });
  const evKey = (r: KeyedRow): string => r.evId;
  const acKey = (r: KeyedRow): string => `${r.evId}\u0000${r.aircraftKey}`;

  const adminRows = withParent('ntsb_admin', admin, evIds, evKey);
  const aircraftRows = withParent('aircraft', aircraft, evIds, evKey);
  const aircraftKeys = new Set(aircraftRows.map(acKey));
  const sorted = (rows: KeyedRow[]): Map<string, KeyedRow[]> => {
    const map = groupBy(rows, evKey);
    for (const list of map.values()) list.sort(byAircraftThenSub);
    return map;
  };
  return {
    events,
    admin: new Map(adminRows.map((r) => [r.evId, r])),
    aircraft: sorted(aircraftRows),
    engines: sorted(withParent('engines', engines, aircraftKeys, acKey)),
    narratives: sorted(withParent('narratives', narratives, aircraftKeys, acKey)),
    findings: sorted(withParent('findings', findings, aircraftKeys, acKey)),
    sequence: sorted(withParent('events_sequence', sequence, aircraftKeys, acKey)),
  };
}

function eventFields(r: FieldReader): CanonicalEventFields {
  return {
    evType: code(r.raw('ev_type')),
    evDate: r.date('ev_date'),
    evDow: blankToNull(r.raw('ev_dow')),
    evTime: r.integer('ev_time'),
    evTmzn: blankToNull(r.raw('ev_tmzn')),
    city: blankToNull(r.raw('ev_city')),
    state: blankToNull(r.raw('ev_state')),
    evYear: r.integer('ev_year'),
    evMonth: r.integer('ev_month'),
    lightCond: code(r.raw('light_cond')),
    skyCondNonceil: code(r.raw('sky_cond_nonceil')),
    skyNonceilHt: r.decimal('sky_nonceil_ht'),
    skyCeilHt: r.decimal('sky_ceil_ht'),
    skyCondCeil: code(r.raw('sky_cond_ceil')),
    visSm: r.decimal('vis_sm'),
    wxTemp: r.decimal('wx_temp'),
    wxDewPt: r.decimal('wx_dew_pt'),
    windDirDeg: r.decimal('wind_dir_deg'),
    windDirInd: code(r.raw('wind_dir_ind')),
    windVelKts: r.decimal('wind_vel_kts'),
    windVelInd: code(r.raw('wind_vel_ind')),
    gustInd: code(r.raw('gust_ind')),
    gustKts: r.decimal('gust_kts'),
    altimeter: r.decimal('altimeter'),
    wxDensAlt: r.decimal('wx_dens_alt'),
    wxIntPrecip: code(r.raw('wx_int_precip')),
    wxCondBasic: code(r.raw('wx_cond_basic')),
    metar: blankToNull(r.raw('metar')),
    highestInjury: code(r.raw('ev_highest_injury')),
    injFGrnd: r.integer('inj_f_grnd'),
    injMGrnd: r.integer('inj_m_grnd'),
    injSGrnd: r.integer('inj_s_grnd'),
    injTotF: r.integer('inj_tot_f'),
    injTotM: r.integer('inj_tot_m'),
    injTotN: r.integer('inj_tot_n'),
    injTotS: r.integer('inj_tot_s'),
    injTotT: r.integer('inj_tot_t'),
    lastChangedAt: r.dateTime('lchg_date'),
  };
}

interface SectionSource {
  aircraftKey: number;
  source: string;
  citation: CitationText;
  lastChangedAt: string | null;
}

/**
 * One section per narrative row and kind. A source text recorded identically for
 * every aircraft of a multi-aircraft event is stored once with event scope
 * (amendment A3); everything else is attributed to its row's aircraft. Blank text
 * (also after HTML conversion, e.g. `<br /><br />`) produces no section.
 */
function buildSections(narratives: readonly KeyedRow[], aircraftKeys: readonly number[], lastChanged: Map<KeyedRow, string | null>): CanonicalSection[] {
  const sections: CanonicalSection[] = [];
  const cache = new Map<string, CitationText>();
  const citationOf = (source: string): CitationText => {
    let c = cache.get(source);
    if (!c) {
      c = toCitationText(source);
      cache.set(source, c);
    }
    return c;
  };
  for (const [column, kind] of NARRATIVE_KINDS) {
    const entries: SectionSource[] = [];
    for (const n of narratives) {
      const source = n.row[column] ?? '';
      if (source.trim() === '') continue;
      const citation = citationOf(source);
      if (citation.text.trim() === '') continue;
      entries.push({ aircraftKey: n.aircraftKey, source, citation, lastChangedAt: lastChanged.get(n) ?? null });
    }
    const first = entries[0];
    if (!first) continue;
    const eventScoped =
      aircraftKeys.length >= 2 && entries.length === aircraftKeys.length && entries.every((e) => e.source === first.source);
    // Event scope requires byte-identical sources, so the first entry stands for all of them.
    const make = (head: SectionSource, scope: SectionScope, covered: readonly SectionSource[]): CanonicalSection => ({
      key: scope === 'event' ? `${kind}/event` : `${kind}/aircraft-${head.aircraftKey}`,
      kind,
      scope,
      aircraftKey: scope === 'event' ? null : head.aircraftKey,
      aircraftKeys: covered.map((e) => e.aircraftKey),
      text: head.citation.text,
      sha256: sha256(head.citation.text),
      sourceText: head.source,
      sourceSha256: sha256(head.source),
      transformedFromHtml: head.citation.transformedFromHtml,
      citationTextVersion: CITATION_TEXT_VERSION,
      lastChangedAt: maxString(covered.map((e) => e.lastChangedAt)),
    });
    if (eventScoped) sections.push(make(first, 'event', entries));
    else for (const e of entries) sections.push(make(e, 'aircraft', [e]));
  }
  return sections;
}

/**
 * Normalize projected NTSB tables into canonical cases. Throws `NormalizationError`
 * for structural problems (missing tables or columns, duplicate composite keys,
 * blank or duplicate `ntsb_no`); value-level problems are nulled or excluded and
 * listed in `quarantine`, never silently coerced. Cases are sorted by `ntsbNo`.
 */
export function normalizeCorpus(tables: RawTables, options: NormalizeOptions = {}): NormalizeResult {
  const mapping = options.mapping ?? COMPLETION_MAPPING_V1;
  const loose = tables as unknown as Readonly<Partial<Record<TableName, readonly AnyRow[]>>>;
  const columnProblems = checkColumns(loose);
  if (columnProblems.length > 0) throw new NormalizationError(columnProblems);

  const structural = new Notes();
  const idx = indexCorpus(loose, structural);
  const notes = new Notes();
  const cases: CanonicalCase[] = [];
  const events = [...idx.events].sort((a, b) => compareStrings((a.row.ntsb_no ?? '').trim(), (b.row.ntsb_no ?? '').trim()));

  for (const ev of events) {
    const evId = ev.evId;
    const ntsbNo = (ev.row.ntsb_no ?? '').trim();
    const er = new FieldReader(notes, 'events', ev.key, ev.row);
    const fields = eventFields(er);
    const loc = location(er, notes, ev.key);
    const country = blankToNull(er.raw('ev_country'));

    const admin = idx.admin.get(evId);
    let rawStatus: string | null = null;
    let approvalDate: string | null = null;
    let adminLastChangedAt: string | null = null;
    if (admin) {
      const ar = new FieldReader(notes, 'ntsb_admin', admin.key, admin.row);
      rawStatus = blankToNull(ar.raw('rec_stat'));
      approvalDate = ar.date('approval_date');
      adminLastChangedAt = ar.dateTime('lchg_date');
    } else {
      notes.add('ntsb_admin', `ev_id=${evId}`, null, 'missing_admin_row', 'value_nulled', null, 'event has no NTSB_Admin row; status is null');
    }

    const aircraftRows = idx.aircraft.get(evId) ?? [];
    const engineRows = idx.engines.get(evId) ?? [];
    const narrativeRows = idx.narratives.get(evId) ?? [];
    const findingRows = idx.findings.get(evId) ?? [];
    const sequenceRows = idx.sequence.get(evId) ?? [];

    const aircraftBase = aircraftRows.map((a) => {
      const r = new FieldReader(notes, 'aircraft', a.key, a.row);
      return {
        aircraftKey: a.aircraftKey,
        aircraftNtsbNo: blankToNull(r.raw('ntsb_no')),
        regisNo: blankToNull(r.raw('regis_no')),
        make: blankToNull(r.raw('acft_make')),
        model: blankToNull(r.raw('acft_model')),
        series: blankToNull(r.raw('acft_series')),
        category: code(r.raw('acft_category')),
        farPart: code(r.raw('far_part')),
        purpose: code(r.raw('type_fly')),
        damage: code(r.raw('damage')),
        homebuilt: r.flag('homebuilt'),
        numEngines: r.integer('num_eng'),
        dateLastInsp: r.date('date_last_insp'),
        afmHrs: r.decimal('afm_hrs'),
        afmHrsLastInsp: r.decimal('afm_hrs_last_insp'),
        afmHrsSince: r.flag('afm_hrs_since'),
        acftYear: r.integer('acft_year'),
      };
    });

    const engines = engineRows.map((e) => {
      const r = new FieldReader(notes, 'engines', e.key, e.row);
      const engine: CanonicalEngine = {
        engNo: e.sub,
        engType: code(r.raw('eng_type')),
        carbFuelInjection: code(r.raw('carb_fuel_injection')),
      };
      return { aircraftKey: e.aircraftKey, engine };
    });

    const narrativeChanged = new Map<KeyedRow, string | null>();
    for (const n of narrativeRows) narrativeChanged.set(n, new FieldReader(notes, 'narratives', n.key, n.row).dateTime('lchg_date'));

    const findings: CanonicalFinding[] = findingRows.map((f) => {
      const r = new FieldReader(notes, 'findings', f.key, f.row);
      return {
        aircraftKey: f.aircraftKey,
        findingNo: f.sub as number,
        code: blankToNull(r.raw('finding_code')),
        description: blankToNull(r.raw('finding_description')),
        inProbableCause: r.flag('cm_inpc'),
        causeFactor: code(r.raw('cause_factor')),
        categoryNo: blankToNull(r.raw('category_no')),
        subcategoryNo: blankToNull(r.raw('subcategory_no')),
        sectionNo: blankToNull(r.raw('section_no')),
        subsectionNo: blankToNull(r.raw('subsection_no')),
        modifierNo: blankToNull(r.raw('modifier_no')),
        lastChangedAt: r.dateTime('lchg_date'),
      };
    });

    const sequence: CanonicalSequenceEvent[] = sequenceRows.map((s) => {
      const r = new FieldReader(notes, 'events_sequence', s.key, s.row);
      const phaseNo = r.integer('phase_no');
      return {
        aircraftKey: s.aircraftKey,
        occurrenceNo: s.sub as number,
        phaseNo,
        phaseGroup: phaseNo === null ? 'unknown' : phaseGroupOf(phaseNo),
        eventCode: blankToNull(r.raw('eventsoe_no')),
        occurrenceCode: blankToNull(r.raw('occurrence_code')),
        description: blankToNull(r.raw('occurrence_description')),
        isDefining: r.flag('defining_ev'),
        lastChangedAt: r.dateTime('lchg_date'),
      };
    });

    const aircraftKeys = aircraftBase.map((a) => a.aircraftKey);
    const sections = buildSections(narrativeRows, aircraftKeys, narrativeChanged);

    const aircraft: CanonicalAircraft[] = aircraftBase.map((a) => {
      const own = sequence.filter((s) => s.aircraftKey === a.aircraftKey);
      const defining = own.filter((s) => s.isDefining === true);
      if (defining.length > 1) {
        notes.add(
          'events_sequence',
          `ev_id=${evId},aircraft_key=${a.aircraftKey}`,
          'defining_ev',
          'multiple_defining_events',
          'value_kept',
          null,
          `${defining.length} defining events; the lowest occurrence_no is used`,
        );
      }
      const definingEvent = defining[0] ?? null;
      const cause = sections.find(
        (s) => s.kind === 'probable_cause' && (s.scope === 'event' || s.aircraftKey === a.aircraftKey),
      );
      return {
        ...a,
        engines: engines.filter((e) => e.aircraftKey === a.aircraftKey).map((e) => e.engine),
        definingEvent,
        definingPhaseGroup: definingEvent?.phaseGroup ?? null,
        phaseGroups: orderPhaseGroups(own.map((s) => s.phaseGroup)),
        hasProbableCause: cause !== undefined,
        probableCauseSectionKey: cause?.key ?? null,
      };
    });

    const hasProbableCause = sections.some((s) => s.kind === 'probable_cause');
    const completionClass = completionClassOf(rawStatus, mapping);

    const revision = createHash('sha256');
    const revisionRows: [string, string[]][] = [['events', sourceValues('events', ev.row)]];
    if (admin) revisionRows.push(['ntsb_admin', sourceValues('ntsb_admin', admin.row)]);
    for (const [table, rows] of [
      ['aircraft', aircraftRows],
      ['engines', engineRows],
      ['narratives', narrativeRows],
      ['findings', findingRows],
      ['events_sequence', sequenceRows],
    ] as const) {
      for (const r of rows) revisionRows.push([table, sourceValues(table, r.row)]);
    }
    revision.update(JSON.stringify(revisionRows), 'utf8');

    cases.push({
      ntsbNo,
      evId,
      country,
      isUs: country === 'USA',
      fields,
      location: loc,
      aircraft,
      sections,
      findings,
      sequence,
      definingPhaseGroup: aircraft.find((a) => a.definingPhaseGroup !== null)?.definingPhaseGroup ?? null,
      phaseGroups: orderPhaseGroups(sequence.map((s) => s.phaseGroup)),
      rawStatus,
      approvalDate,
      adminLastChangedAt,
      completionClass,
      completionMappingVersion: mapping.version,
      hasProbableCause,
      answerEligible: isAnswerEligible({ completionClass, hasProbableCause }),
      sourceRevision: revision.digest('hex'),
    });
  }

  const sections = cases.flatMap((c) => c.sections);
  return {
    cases,
    quarantine: [...notes.rows, ...structural.rows],
    completionMapping: mapping,
    cohortProvisional: isCohortProvisional(mapping),
    citationTextVersion: CITATION_TEXT_VERSION,
    fieldNormalizationVersion: FIELD_NORMALIZATION_VERSION,
    codeLabels: resolveCodeLabels(tables.eadmspub_datadictionary as readonly DictionaryCodeRow[] | undefined),
    stats: {
      events: cases.length,
      usEvents: cases.filter((c) => c.isUs).length,
      aircraft: cases.reduce((n, c) => n + c.aircraft.length, 0),
      sections: sections.length,
      eventScopedSections: sections.filter((s) => s.scope === 'event').length,
      htmlTransformedSections: sections.filter((s) => s.transformedFromHtml).length,
      answerEligible: cases.filter((c) => c.answerEligible).length,
      answerEligibleUs: cases.filter((c) => c.answerEligible && c.isUs).length,
      completedWithoutCause: cases.filter((c) => c.completionClass === 'completed' && !c.hasProbableCause).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading projected CSVs

/** Upper bound for one CSV record while reading (largest observed narrative row is ~80k characters per field). */
export const READ_MAX_RECORD_SIZE = 8 * 1024 * 1024;

function checkHeader(table: TableName, header: readonly string[]): string[] {
  const allowed = new Set<string>(TABLE_SPECS[table].columns);
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const name of header) {
    if (!allowed.has(name)) problems.push(`${table}: unexpected column "${name}" (not allowlisted)`);
    else if (seen.has(name)) problems.push(`${table}: duplicate column "${name}"`);
    seen.add(name);
  }
  for (const column of TABLE_SPECS[table].columns) {
    if (!seen.has(column)) problems.push(`${table}: required column "${column}" missing`);
  }
  if (problems.length > 0) throw new NormalizationError(problems);
  return [...header];
}

async function readTableFile(table: TableName, file: string): Promise<AnyRow[]> {
  const rows: AnyRow[] = [];
  try {
    await pipeline(
      createReadStream(file),
      parse({
        bom: true,
        columns: (header: string[]) => checkHeader(table, header),
        relax_column_count: false,
        skip_empty_lines: false,
        max_record_size: READ_MAX_RECORD_SIZE,
      }),
      async function collect(source: AsyncIterable<AnyRow>) {
        for await (const row of source) rows.push(row);
      },
    );
  } catch (err) {
    if (err instanceof NormalizationError) throw err;
    throw new Error(`${table}: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return rows;
}

/**
 * Stream the projected CSVs (`<table>.csv`) from an extraction output directory or a
 * fixture directory. The header must hold exactly the allowlisted columns. Required
 * tables must exist; optional ones (engines, ct_seqevt, eadmspub_datadictionary)
 * are left undefined when their file is absent.
 */
export async function readProjectedTables(dir: string): Promise<RawTables> {
  const missing = REQUIRED_TABLES.filter((t) => !existsSync(join(dir, `${t}.csv`)));
  if (missing.length > 0) throw new NormalizationError(missing.map((t) => `${t}: ${t}.csv missing in ${dir}`));
  const out: Partial<Record<TableName, AnyRow[]>> = {};
  for (const table of TABLE_NAMES) {
    const file = join(dir, `${table}.csv`);
    if (!existsSync(file)) continue;
    out[table] = await readTableFile(table, file);
  }
  return out as unknown as RawTables;
}
