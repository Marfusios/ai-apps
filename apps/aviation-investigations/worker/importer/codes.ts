import { decodeFlag, type FlagColumn } from '../../shared/codes.js';
import { parseInteger } from '../ingest/scalars.js';
import type { TableName, TABLE_SPECS } from '../ingest/tables.js';

type Spelling = 'upper' | 'trim' | 'raw' | 'integer' | 'flag';
/**
 * Semantic inventory, reviewed against normalizeCorpus/eventFields and the stored
 * filter/label/sequence/finding fields. Numeric measurements, dates, identities and
 * open text (city, make/model/series, registration, descriptions, narratives) are
 * not code vocabularies. Both dictionaries are compared in full separately.
 * Keep this explicit when a projected code/flag gains a consumer; raw spellings
 * remain in the corpus/per-case provenance digest, independently of this set.
 */
export const CONSUMED_CODES = {
  events: {
    ev_type: 'upper',
    ev_dow: 'trim',
    ev_tmzn: 'trim',
    ev_state: 'trim',
    ev_country: 'trim',
    light_cond: 'upper',
    sky_cond_nonceil: 'upper',
    sky_cond_ceil: 'upper',
    wind_dir_ind: 'upper',
    wind_vel_ind: 'upper',
    gust_ind: 'upper',
    wx_int_precip: 'upper',
    wx_cond_basic: 'upper',
    ev_highest_injury: 'upper',
  },
  aircraft: {
    acft_category: 'upper',
    far_part: 'upper',
    type_fly: 'upper',
    damage: 'upper',
    homebuilt: 'flag',
    afm_hrs_since: 'flag',
  },
  engines: { eng_type: 'upper', carb_fuel_injection: 'upper' },
  findings: {
    finding_code: 'trim',
    category_no: 'trim',
    subcategory_no: 'trim',
    section_no: 'trim',
    subsection_no: 'trim',
    modifier_no: 'trim',
    cause_factor: 'raw',
    cm_inpc: 'flag',
  },
  events_sequence: {
    phase_no: 'integer',
    eventsoe_no: 'trim',
    occurrence_code: 'trim',
    defining_ev: 'flag',
  },
  ntsb_admin: { rec_stat: 'trim' },
  narratives: {},
  ct_seqevt: {},
  eadmspub_datadictionary: {},
} as const satisfies {
  [T in TableName]: Partial<Record<(typeof TABLE_SPECS)[T]['columns'][number], Spelling>>;
};

export function consumedCodeValues(table: TableName, row: Record<string, string>): string[] {
  return Object.entries(CONSUMED_CODES[table]).map(([column, spelling]) => {
    const raw = row[column]!,
      trimmed = raw.trim();
    let value: unknown =
      spelling === 'raw' ? raw : spelling === 'upper' ? trimmed.toUpperCase() : trimmed;
    if (spelling === 'integer') {
      const parsed = parseInteger(raw);
      value =
        parsed.ok &&
        (parsed.value === null || (parsed.value >= -2147483648 && parsed.value <= 2147483647))
          ? ['integer', parsed.value]
          : ['invalid', trimmed];
    }
    if (spelling === 'flag') {
      const parsed = decodeFlag(column as FlagColumn, raw);
      value = parsed.ok ? ['flag', parsed.value] : ['invalid', trimmed];
    }
    return JSON.stringify([table, column, value]);
  });
}
