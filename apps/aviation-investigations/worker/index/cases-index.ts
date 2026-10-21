/**
 * The cases index: one document per US event of one verified dataset generation,
 * for keyword search, filters and facets (amendments A2, A6, A12, A14).
 *
 * - Index `<prefix>-cases-v1-g<generation>-<timestamp>`, alias `<prefix>-cases`. The
 *   alias moves atomically once the new index is loaded and verified; the previous
 *   index is kept. The dataset manifest (which index the API reads) is published
 *   separately, after the passages index of the same generation exists.
 * - Facet counts are distinct events. Event-level facets are plain `terms`
 *   aggregations. Aircraft fields are `nested`, so one query clause sees one aircraft
 *   (no cross-aircraft matches), and aircraft facets count events through
 *   `reverse_nested`. An event with two different aircraft counts once in each of their
 *   buckets, so aircraft buckets can sum to more than the total; the same holds for
 *   `defining_phase_groups`, which lists every aircraft's defining phase group.
 * - Blank source values are indexed as null (absent from the inverted index): facets
 *   show them with a `missing` aggregation.
 * - The internal `ev_id` is never indexed.
 */
import { createHash } from 'node:crypto';
import type { Client, estypes } from '@elastic/elasticsearch';
import { eq } from 'drizzle-orm';
import type { Db } from '../../server/db/client.js';
import {
  countCaseRecords,
  streamCaseRecords,
  type CaseRecord,
  type CaseRecordCounts,
} from '../../server/db/queries/case-records.js';
import { datasetGenerations, type GenerationStatus } from '../../server/db/schema/index.js';
import { PHASE_GROUPS, orderPhaseGroups, type PhaseGroup } from '../../shared/codes.js';
import type { CompletionClass } from '../../shared/completion.js';
import { occurrenceEventLabel } from '../../shared/occurrences.js';
import { switchAlias } from './aliases.js';
import { AVIATION_ANALYSIS, NAME_NORMALIZER, aviationTextField } from './analysis.js';

/** Bump on any change to the mapping, analysis or synonym list. */
export const CASES_INDEX_VERSION = 'cases-v1';

/** Generation statuses that may be indexed: verified, or already published (a rebuild). */
export const INDEXABLE_STATUSES: readonly GenerationStatus[] = ['verified', 'published'];

// ---------------------------------------------------------------------------
// Document

export interface CaseAircraftDoc {
  aircraft_key: number;
  aircraft_ntsb_no: string | null;
  make: string | null;
  model: string | null;
  category: string | null;
  far_part: string | null;
  purpose: string | null;
  damage: string | null;
  /** Distinct engine type codes of this aircraft, in engine order. */
  eng_types: string[];
  homebuilt: boolean | null;
  defining_phase_group: PhaseGroup | null;
}

export interface CaseDoc {
  ntsb_no: string;
  ev_date: string | null;
  ev_year: number | null;
  /** `ev_country` as published; always `USA` in this index. */
  country: string;
  state: string | null;
  city: string | null;
  /** Absent when the event has no coordinates. */
  location?: { lat: number; lon: number };
  completion_class: CompletionClass;
  raw_status: string | null;
  answer_eligible: boolean;
  completed_with_cause: boolean;
  highest_injury: string | null;
  light: string | null;
  wx_cond: string | null;
  /** Every aircraft's defining phase group, in flight order (several in some multi-aircraft events). */
  defining_phase_groups: PhaseGroup[];
  /** Phase groups of every sequence row, in flight order. */
  sequence_phase_groups: PhaseGroup[];
  /** Event labels of the aircraft's defining sequence rows, in aircraft order, distinct. */
  defining_events: string[];
  aircraft_count: number;
  aircraft: CaseAircraftDoc[];
  probable_cause: string | null;
  analysis: string | null;
  factual: string | null;
  /** Finding descriptions, distinct, in aircraft and finding order. */
  findings_text: string | null;
}

const PHASE_SET: ReadonlySet<string> = new Set(PHASE_GROUPS);

function phaseGroups(ntsbNo: string, values: readonly string[]): PhaseGroup[] {
  for (const v of values) {
    if (!PHASE_SET.has(v)) throw new Error(`${ntsbNo}: unknown phase group ${JSON.stringify(v)}`);
  }
  return orderPhaseGroups(values as readonly PhaseGroup[]);
}

function phaseGroupOrNull(ntsbNo: string, value: string | null): PhaseGroup | null {
  if (value === null) return null;
  if (!PHASE_SET.has(value)) throw new Error(`${ntsbNo}: unknown phase group ${JSON.stringify(value)}`);
  return value as PhaseGroup;
}

function distinct<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/** Sections of one kind, in record order, trimmed and separated by a blank line; null when none. */
function sectionText(r: CaseRecord, kind: CaseRecord['sections'][number]['kind']): string | null {
  const parts = r.sections
    .filter((s) => s.kind === kind)
    .map((s) => s.text.trim())
    .filter((t) => t !== '');
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Defining sequence rows of the record's aircraft, in aircraft order. */
export function definingSequenceRows(r: CaseRecord): CaseRecord['sequence'] {
  const out: CaseRecord['sequence'] = [];
  for (const a of r.aircraft) {
    if (a.definingOccurrenceNo === null) continue;
    const row = r.sequence.find((s) => s.aircraftKey === a.aircraftKey && s.occurrenceNo === a.definingOccurrenceNo);
    if (!row) throw new Error(`${r.ntsbNo}: defining occurrence ${a.definingOccurrenceNo} of aircraft ${a.aircraftKey} is missing`);
    out.push(row);
  }
  return out;
}

/**
 * The cases-index document of one US case record (pure). Throws for a non-US event:
 * the index is US-only (A2), whatever the caller passes.
 */
export function buildCaseDocument(r: CaseRecord): CaseDoc {
  if (!r.isUs || r.country !== 'USA') {
    throw new Error(`${r.ntsbNo} is not a US event (country ${JSON.stringify(r.country)}); the cases index is US-only`);
  }
  const doc: CaseDoc = {
    ntsb_no: r.ntsbNo,
    ev_date: r.evDate,
    ev_year: r.evYear,
    country: r.country,
    state: r.state,
    city: r.city,
    completion_class: r.completionClass,
    raw_status: r.rawStatus,
    answer_eligible: r.answerEligible,
    completed_with_cause: r.completedWithCause,
    highest_injury: r.highestInjury,
    light: r.lightCond,
    wx_cond: r.wxCondBasic,
    defining_phase_groups: phaseGroups(r.ntsbNo, r.definingPhaseGroups),
    sequence_phase_groups: phaseGroups(r.ntsbNo, r.sequencePhaseGroups),
    defining_events: distinct(
      definingSequenceRows(r)
        .map((s) => occurrenceEventLabel(s.phaseNo, s.description)?.label)
        .filter((l): l is string => l !== undefined),
    ),
    aircraft_count: r.aircraft.length,
    aircraft: r.aircraft.map((a) => ({
      aircraft_key: a.aircraftKey,
      aircraft_ntsb_no: a.aircraftNtsbNo,
      make: a.make,
      model: a.model,
      category: a.category,
      far_part: a.farPart,
      purpose: a.purpose,
      damage: a.damage,
      eng_types: distinct(a.engines.map((e) => e.engType).filter((t): t is string => t !== null)),
      homebuilt: a.homebuilt,
      defining_phase_group: phaseGroupOrNull(r.ntsbNo, a.definingPhaseGroup),
    })),
    probable_cause: sectionText(r, 'probable_cause'),
    analysis: sectionText(r, 'analysis'),
    factual: sectionText(r, 'factual'),
    findings_text: (() => {
      const lines = distinct(
        r.findings.map((f) => (f.description ?? '').trim()).filter((d) => d !== ''),
      );
      return lines.length > 0 ? lines.join('\n') : null;
    })(),
  };
  if (r.latitude !== null && r.longitude !== null) doc.location = { lat: r.latitude, lon: r.longitude };
  return doc;
}

// ---------------------------------------------------------------------------
// Mapping and settings

const keyword = (): estypes.MappingKeywordProperty => ({ type: 'keyword' });
const nameKeyword = (): estypes.MappingKeywordProperty => ({ type: 'keyword', normalizer: NAME_NORMALIZER });

export const CASES_MAPPING: estypes.MappingTypeMapping = {
  dynamic: 'strict',
  properties: {
    ntsb_no: keyword(),
    ev_date: { type: 'date', format: 'strict_date' },
    ev_year: { type: 'integer' },
    country: keyword(),
    state: keyword(),
    city: nameKeyword(),
    location: { type: 'geo_point' },
    completion_class: keyword(),
    raw_status: keyword(),
    answer_eligible: { type: 'boolean' },
    completed_with_cause: { type: 'boolean' },
    highest_injury: keyword(),
    light: keyword(),
    wx_cond: keyword(),
    defining_phase_groups: keyword(),
    sequence_phase_groups: keyword(),
    defining_events: keyword(),
    aircraft_count: { type: 'integer' },
    aircraft: {
      type: 'nested',
      dynamic: 'strict',
      properties: {
        aircraft_key: { type: 'integer' },
        aircraft_ntsb_no: keyword(),
        make: nameKeyword(),
        model: nameKeyword(),
        category: keyword(),
        far_part: keyword(),
        purpose: keyword(),
        damage: keyword(),
        eng_types: keyword(),
        homebuilt: { type: 'boolean' },
        defining_phase_group: keyword(),
      },
    },
    probable_cause: aviationTextField(),
    analysis: aviationTextField(),
    factual: aviationTextField(),
    findings_text: aviationTextField(),
  },
};

/** Static index settings: one shard (exact BM25 statistics), no replicas. */
export const CASES_SETTINGS: estypes.IndicesIndexSettings = {
  number_of_shards: 1,
  number_of_replicas: 0,
  analysis: AVIATION_ANALYSIS,
};

/** sha256 over the version, settings and mapping; recorded in the index `_meta`. */
export function casesIndexFingerprint(): string {
  return createHash('sha256')
    .update(JSON.stringify({ version: CASES_INDEX_VERSION, settings: CASES_SETTINGS, mapping: CASES_MAPPING }))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Names

const PREFIX = /^[a-z0-9][a-z0-9._-]*$/;

function checkPrefix(prefix: string): void {
  if (!PREFIX.test(prefix) || prefix.length > 100) throw new Error(`invalid index prefix: ${JSON.stringify(prefix)}`);
}

export function casesAlias(prefix: string): string {
  checkPrefix(prefix);
  return `${prefix}-cases`;
}

/** `<prefix>-cases-v1-g<generation>-<yyyymmddhhmmssmmm UTC>`. */
export function casesIndexName(prefix: string, generationId: number, at: Date): string {
  checkPrefix(prefix);
  if (!Number.isSafeInteger(generationId) || generationId < 1) throw new Error('invalid generation id');
  const stamp = at.toISOString().replace(/\D/g, '');
  return `${prefix}-${CASES_INDEX_VERSION}-g${generationId}-${stamp}`;
}

// ---------------------------------------------------------------------------
// Build

export class GenerationNotIndexableError extends Error {
  constructor(
    readonly generationId: number,
    readonly status: GenerationStatus | null,
  ) {
    super(
      status === null
        ? `generation ${generationId} does not exist`
        : `generation ${generationId} is ${status}; only a verified generation can be indexed`,
    );
    this.name = 'GenerationNotIndexableError';
  }
}

export interface RebuildCasesOptions {
  generationId: number;
  /** Index name prefix (`ELASTICSEARCH_INDEX_PREFIX`). */
  prefix: string;
  /** Documents per bulk request (default 500). */
  batchSize?: number;
  /** Bulk request body limit in bytes (default 8 MiB); a request is sent once either limit is reached. */
  maxBulkBytes?: number;
  /** Clock for the index name (tests). */
  now?: () => Date;
  log?: (message: string) => void;
}

export interface IndexReport {
  index: string;
  alias: string;
  /** Indices the alias pointed at before; kept. */
  previousIndices: string[];
  generationId: number;
  version: string;
  fingerprint: string;
  documents: number;
  aircraft: number;
  answerEligible: number;
  multiAircraftEvents: number;
  eventsWithSeveralDefiningPhases: number;
  eventsWithoutDefiningPhase: number;
  /** Defining sequence descriptions without the expected phase text (labelled with the whole description). */
  unparsedEventLabels: number;
  durationMs: number;
}

async function generationStatus(db: Db, generationId: number): Promise<GenerationStatus | null> {
  const [row] = await db
    .select({ status: datasetGenerations.status })
    .from(datasetGenerations)
    .where(eq(datasetGenerations.id, generationId));
  return row?.status ?? null;
}

const BULK_RETRIES = 3;

/** Bulk-create documents; retries items rejected with 429, fails on any other item error. */
async function bulkCreate(es: Client, index: string, docs: readonly CaseDoc[], log: (m: string) => void): Promise<void> {
  let pending = docs;
  for (let attempt = 0; pending.length > 0; attempt += 1) {
    const operations = pending.flatMap((d) => [{ create: { _index: index, _id: d.ntsb_no } }, d]);
    const res = await es.bulk({ operations, refresh: false });
    if (!res.errors) return;
    const retry: CaseDoc[] = [];
    const failed: string[] = [];
    res.items.forEach((item, i) => {
      const result = item.create;
      if (!result?.error) return;
      const doc = pending[i] as CaseDoc;
      if (result.status === 429) retry.push(doc);
      else failed.push(`${doc.ntsb_no}: ${result.error.type} ${(result.error.reason ?? '').slice(0, 200)}`.trim());
    });
    if (failed.length > 0) {
      throw new Error(`bulk indexing failed for ${failed.length} document(s): ${failed.slice(0, 5).join('; ')}`);
    }
    if (attempt + 1 >= BULK_RETRIES) throw new Error(`bulk indexing still rejected (429) after ${BULK_RETRIES} attempts`);
    log(`bulk: ${retry.length} document(s) rejected with 429, retrying`);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    pending = retry;
  }
}

async function countWhere(es: Client, index: string, query: estypes.QueryDslQueryContainer): Promise<number> {
  return (await es.count({ index, query })).count;
}

/** Compare the loaded index with the generation's counts; throws on any difference. */
async function verifyIndex(es: Client, index: string, expected: CaseRecordCounts, streamed: number): Promise<void> {
  const res = await es.search({
    index,
    size: 0,
    track_total_hits: true,
    aggs: { aircraft: { nested: { path: 'aircraft' } } },
  });
  const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? -1);
  const aircraft = (res.aggregations?.aircraft as estypes.AggregationsNestedAggregate | undefined)?.doc_count ?? -1;
  const measured: [string, number, number][] = [
    ['documents (generation US cases)', expected.cases, total],
    ['documents (streamed)', streamed, total],
    ['nested aircraft', expected.aircraft, aircraft],
    ['answer-eligible', expected.answerEligible, await countWhere(es, index, { term: { answer_eligible: true } })],
    ['multi-aircraft events', expected.multiAircraftEvents, await countWhere(es, index, { range: { aircraft_count: { gte: 2 } } })],
    ['non-US documents', 0, await countWhere(es, index, { bool: { must_not: { term: { country: 'USA' } } } })],
  ];
  const wrong = measured.filter(([, want, got]) => want !== got);
  if (wrong.length > 0) {
    throw new Error(`index ${index} failed verification: ${wrong.map(([k, want, got]) => `${k} expected ${want}, got ${got}`).join('; ')}`);
  }
}

/**
 * Build a new cases index for one verified generation and move the alias to it:
 * create the index (refresh off), bulk-load every US case, refresh, verify the counts
 * against the generation, then switch the alias atomically. The previous index is
 * kept. On any failure the new index is deleted and the alias is left unchanged.
 */
export async function rebuildCasesIndex(es: Client, db: Db, opts: RebuildCasesOptions): Promise<IndexReport> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const batchSize = opts.batchSize ?? 500;
  const maxBulkBytes = opts.maxBulkBytes ?? 8 * 1024 * 1024;
  const { generationId, prefix } = opts;
  const alias = casesAlias(prefix);
  const index = casesIndexName(prefix, generationId, (opts.now ?? (() => new Date()))());

  const status = await generationStatus(db, generationId);
  if (status === null || !INDEXABLE_STATUSES.includes(status)) throw new GenerationNotIndexableError(generationId, status);
  const expected = await countCaseRecords(db, generationId);
  const fingerprint = casesIndexFingerprint();

  await es.indices.create({
    index,
    settings: { ...CASES_SETTINGS, refresh_interval: '-1' },
    mappings: {
      ...CASES_MAPPING,
      _meta: { index_version: CASES_INDEX_VERSION, fingerprint, generation_id: generationId },
    },
  });
  log(`created ${index}`);
  try {
    let streamed = 0;
    let unparsedEventLabels = 0;
    let buffer: CaseDoc[] = [];
    let bytes = 0;
    const flush = async () => {
      if (buffer.length === 0) return;
      await bulkCreate(es, index, buffer, log);
      streamed += buffer.length;
      buffer = [];
      bytes = 0;
      log(`indexed ${streamed}/${expected.cases}`);
    };
    for await (const record of streamCaseRecords(db, generationId, { batchSize })) {
      const doc = buildCaseDocument(record);
      for (const s of definingSequenceRows(record)) {
        if (occurrenceEventLabel(s.phaseNo, s.description)?.parsed === false) unparsedEventLabels += 1;
      }
      buffer.push(doc);
      bytes += Buffer.byteLength(JSON.stringify(doc));
      if (buffer.length >= batchSize || bytes >= maxBulkBytes) await flush();
    }
    await flush();

    // Back to the default once loaded; the index takes no further writes.
    await es.indices.putSettings({ index, settings: { refresh_interval: '1s' } });
    await es.indices.refresh({ index });
    await verifyIndex(es, index, expected, streamed);
    const switched = await switchAlias(es, alias, index);
    log(`alias ${alias} -> ${index}${switched.previous.length ? ` (was ${switched.previous.join(', ')})` : ''}`);
    return {
      index,
      alias,
      previousIndices: switched.previous,
      generationId,
      version: CASES_INDEX_VERSION,
      fingerprint,
      documents: streamed,
      aircraft: expected.aircraft,
      answerEligible: expected.answerEligible,
      multiAircraftEvents: expected.multiAircraftEvents,
      eventsWithSeveralDefiningPhases: expected.eventsWithSeveralDefiningPhases,
      eventsWithoutDefiningPhase: expected.eventsWithoutDefiningPhase,
      unparsedEventLabels,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    await es.indices.delete({ index }).catch(() => undefined);
    throw err;
  }
}
