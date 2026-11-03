import { createHash } from 'node:crypto';
import { TABLE_NAMES, TABLE_SPECS, type TableName } from '../ingest/tables.js';
import { normalizeCorpus, type RawTables, type NormalizeResult } from '../ingest/normalize.js';
import { toCitationText } from '../ingest/citation-text.js';
import { DIGEST_VERSION, ImportFailure } from './contracts.js';
import { consumedCodeValues } from './codes.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
export const byteOrder = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));
type Row = Record<string, string>;
export interface SnapshotFacts {
  digest: string;
  perCase: Map<string, string>;
  identities: Map<string, string>;
  narrativeSources: Map<string, string>;
  dictionary: Map<string, string>;
  consumedCodes: Set<string>;
  quarantine: Map<string, { foreignCoordinate: boolean }>;
  sourceDates: string[];
  changeDates: string[];
  normalized: NormalizeResult;
}
/** Typed, ordered JSON tuples; array multiplicity is retained. No delimiter concatenation. */
export function sourceFacts(tables: RawTables): SnapshotFacts {
  const raw = tables as unknown as Record<TableName, readonly Row[]>;
  const normalized = normalizeCorpus(tables);
  const groups = new Map<string, string[]>();
  const identities = new Map<string, string>();
  const tableDigests: [string, string][] = [];
  const dictionary = new Map<string, string>();
  const narrativeSources = new Map<string, string>();
  const consumedCodes = new Set<string>();
  const sourceDates: string[] = [];
  const changeDates: string[] = [];
  for (const row of raw.events) {
    if (!row.ev_id || !row.ntsb_no || identities.has(row.ntsb_no))
      throw new ImportFailure('integrity');
    identities.set(row.ntsb_no, row.ev_id);
  }
  for (const table of TABLE_NAMES) {
    const rows = raw[table];
    if (!rows) throw new ImportFailure('schema');
    const encoded: string[] = [];
    for (const row of rows) {
      const values = TABLE_SPECS[table].columns.map((column) => {
        if (typeof row[column] !== 'string') throw new ImportFailure('schema');
        return ['string', row[column]];
      });
      const tuple = JSON.stringify([table, values]);
      encoded.push(tuple);
      if (row.ev_id !== undefined) {
        const group = groups.get(row.ev_id) ?? [];
        group.push(tuple);
        groups.set(row.ev_id, group);
      } else {
        // Rows with the same dictionary key must not silently replace each other.
        const key =
          table === 'ct_seqevt'
            ? JSON.stringify([table, row.code])
            : JSON.stringify([table, row.table, row.column, row.code_iaids, row.ct_name]);
        const prior = dictionary.get(key);
        dictionary.set(
          key,
          JSON.stringify(
            [...(prior ? (JSON.parse(prior) as string[]) : []), tuple].sort(byteOrder),
          ),
        );
      }
      for (const name of ['lchg_date', 'ev_date', 'approval_date']) {
        const value = row[name]?.trim();
        if (value) sourceDates.push(value);
        if (value && name === 'lchg_date') changeDates.push(value);
      }
      for (const value of consumedCodeValues(table, row)) consumedCodes.add(value);
      if (table === 'narratives')
        for (const name of ['narr_accp', 'narr_accf', 'narr_cause']) {
          const key = JSON.stringify([row.ev_id, Number(row.aircraft_key), name]);
          if (narrativeSources.has(key)) throw new ImportFailure('integrity');
          narrativeSources.set(key, toCitationText(row[name] ?? '').text.trim());
        }
    }
    tableDigests.push([table, digest(encoded.sort(byteOrder))]);
  }
  const perCase = new Map<string, string>();
  for (const [key, evId] of identities)
    perCase.set(key, digest((groups.get(evId) ?? []).sort(byteOrder)));
  // The diagnostic key embeds the entire ID, which may itself contain commas.
  // Only exact full-key joins are meaningful. Never split diagnostics on commas.
  const byEvent = new Map<string, (typeof normalized.cases)[number] | null>();
  for (const c of normalized.cases) {
    const key = `ev_id=${c.evId}`;
    byEvent.set(key, byEvent.has(key) ? null : c);
  }
  const quarantine = new Map<string, { foreignCoordinate: boolean }>();
  for (const q of normalized.quarantine) {
    const c = byEvent.get(q.key);
    const foreignCoordinate =
      c != null &&
      !c.isUs &&
      q.table === 'events' &&
      ['coordinate_out_of_range', 'coordinate_incomplete'].includes(q.reason) &&
      q.action === 'value_nulled';
    const key = JSON.stringify([q.table, q.key, q.column, q.reason, q.action, c?.isUs ?? null]);
    quarantine.set(key, { foreignCoordinate });
  }
  return {
    digest: digest([
      DIGEST_VERSION,
      normalized.completionMapping,
      normalized.fieldNormalizationVersion,
      normalized.citationTextVersion,
      tableDigests,
    ]),
    perCase,
    identities,
    narrativeSources,
    dictionary,
    consumedCodes,
    quarantine,
    sourceDates,
    changeDates,
    normalized,
  };
}
