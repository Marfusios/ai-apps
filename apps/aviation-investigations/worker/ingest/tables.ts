import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';

/**
 * Explicit column allowlists for every exported table. Source columns are matched
 * case-insensitively (the dictionary table has mixed-case headers) and written
 * under the names below. Owner/operator names and addresses, contact and
 * notification fields, and internal editor ids (`lchg_userid`) are never listed.
 */
export const TABLE_SPECS = {
  events: {
    columns: [
      'ev_id', 'ntsb_no', 'ev_type', 'ev_date', 'ev_dow', 'ev_time', 'ev_tmzn',
      'ev_city', 'ev_state', 'ev_country', 'ev_year', 'ev_month',
      'dec_latitude', 'dec_longitude',
      'light_cond', 'sky_cond_nonceil', 'sky_nonceil_ht', 'sky_ceil_ht', 'sky_cond_ceil',
      'vis_sm', 'wx_temp', 'wx_dew_pt', 'wind_dir_deg', 'wind_dir_ind', 'wind_vel_kts',
      'wind_vel_ind', 'gust_ind', 'gust_kts', 'altimeter', 'wx_dens_alt',
      'wx_int_precip', 'wx_cond_basic', 'metar',
      'ev_highest_injury', 'inj_f_grnd', 'inj_m_grnd', 'inj_s_grnd',
      'inj_tot_f', 'inj_tot_m', 'inj_tot_n', 'inj_tot_s', 'inj_tot_t',
      'lchg_date',
    ],
  },
  aircraft: {
    columns: [
      'ev_id', 'aircraft_key', 'ntsb_no', 'regis_no',
      'acft_make', 'acft_model', 'acft_series', 'acft_category',
      'far_part', 'type_fly', 'damage', 'homebuilt', 'num_eng',
      'date_last_insp', 'afm_hrs', 'afm_hrs_last_insp', 'afm_hrs_since', 'acft_year',
    ],
  },
  engines: { columns: ['ev_id', 'aircraft_key', 'eng_no', 'eng_type', 'carb_fuel_injection'] },
  narratives: {
    columns: ['ev_id', 'aircraft_key', 'narr_accp', 'narr_accf', 'narr_cause', 'lchg_date'],
  },
  findings: {
    columns: [
      'ev_id', 'aircraft_key', 'finding_no', 'finding_code', 'finding_description',
      'category_no', 'subcategory_no', 'section_no', 'subsection_no', 'modifier_no',
      'cause_factor', 'lchg_date', 'cm_inpc',
    ],
  },
  events_sequence: {
    columns: [
      'ev_id', 'aircraft_key', 'occurrence_no', 'occurrence_code', 'occurrence_description',
      'phase_no', 'eventsoe_no', 'defining_ev', 'lchg_date',
    ],
  },
  ntsb_admin: { columns: ['ev_id', 'rec_stat', 'approval_date', 'lchg_date'] },
  ct_seqevt: { columns: ['code', 'meaning'] },
  eadmspub_datadictionary: {
    columns: [
      'category of data', 'table', 'column', 'ct_name', 'code_iaids', 'meaning',
      'data type eadms', 'length eadms', 'short_desc', 'question_def', 'code meaning',
      'typeofchange', 'change_notes',
    ],
  },
} as const satisfies Record<string, { columns: readonly string[] }>;

export type TableName = keyof typeof TABLE_SPECS;
export const TABLE_NAMES = Object.keys(TABLE_SPECS) as TableName[];

export interface ProjectionCounter {
  rows: number;
}

/**
 * Value contract for the exported CSV: mdb-export writes NULL as an empty, unquoted
 * field, and the round trip through the parser makes NULL and the empty string
 * identical. Loaders must treat an empty field as NULL for non-text columns and may
 * do so for text columns too.
 *
 * Streaming CSV (RFC 4180) projection: [parser, selector, serializer]. The header
 * row is mapped to the allowlist; a missing allowlisted column is an error.
 */
export function projectCsv(table: TableName, counter?: ProjectionCounter): [Transform, Transform, Transform] {
  const wanted: readonly string[] = TABLE_SPECS[table].columns;
  let indices: number[] | null = null;
  const parser = parse({ bom: true, relax_column_count: false, skip_empty_lines: false });
  const selector = new Transform({
    objectMode: true,
    transform(row: string[], _enc, cb) {
      if (indices === null) {
        const lower = row.map((h) => h.trim().toLowerCase());
        const found: number[] = [];
        for (const col of wanted) {
          const first = lower.indexOf(col);
          if (first < 0 || lower.indexOf(col, first + 1) >= 0) {
            return cb(new Error(`${table}: allowlisted column "${col}" missing or duplicated in source header`));
          }
          found.push(first);
        }
        indices = found;
        return cb(null, [...wanted]);
      }
      if (counter) counter.rows += 1;
      cb(null, indices.map((i) => row[i] ?? ''));
    },
  });
  const serializer = stringify({ record_delimiter: 'unix' });
  return [parser, selector, serializer];
}

/** Project one raw CSV file to its allowlisted columns; returns the data row count. */
export async function projectFile(table: TableName, rawPath: string, outPath: string): Promise<number> {
  const counter: ProjectionCounter = { rows: 0 };
  const [parser, selector, serializer] = projectCsv(table, counter);
  await pipeline(
    createReadStream(rawPath),
    parser,
    selector,
    serializer,
    createWriteStream(outPath, { flags: 'wx', mode: 0o600 }),
  );
  return counter.rows;
}
