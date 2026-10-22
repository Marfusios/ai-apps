/**
 * The cases index: one document per US event of one verified dataset generation,
 * for keyword search, filters and facets (amendments A2, A6, A12, A14).
 *
 * - Index `<prefix>-cases-v2-g<generation>-<timestamp>`, alias `<prefix>-cases`. The
 *   alias means "the cases index built last": it moves atomically once a new index is
 *   loaded and verified, and the previous index is kept. The API never reads the
 *   alias; it reads index names only from the active `dataset_manifests` row, which is
 *   published separately once the passages index of the same generation exists.
 * - Each build has a random build id, part of its index name and of its generation
 *   pin. It pins the generation (no expiry, `pin_generation` under the lifecycle lock)
 *   after checking it is verified by the current verifier, refuses to publish if the
 *   pin has disappeared, and removes only its own pin at the end. A build that dies
 *   leaves its pin and index to `worker index cleanup-builds` (see publications.ts).
 * - Facet counts are distinct events. Event-level facets are plain `terms`
 *   aggregations. Aircraft fields are `nested`, so one query clause sees one aircraft
 *   (no cross-aircraft matches), and aircraft facets count events through
 *   `reverse_nested`. An event with two different aircraft counts once in each of their
 *   buckets, so aircraft buckets can sum to more than the total; the same holds for
 *   `defining_phase_groups`, which lists every aircraft's defining phase group.
 * - Blank source values are indexed as null (absent from the inverted index): facets
 *   show them with a `missing` aggregation.
 * - Text fields are arrays, one value per section or finding, with a position gap
 *   between values, so phrases never match across two sections.
 * - The internal `ev_id` is never indexed.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Client, estypes } from '@elastic/elasticsearch';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../server/db/client.js';
import { VERIFIER_VERSION, lifecycleError, withLifecycleLock } from '../../server/db/generations.js';
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
import type pg from 'pg';
import { AliasSwitchError, switchAlias, unresolvedMessage, unresolvedPublications, type SwitchAliasOptions } from './aliases.js';
import { AVIATION_ANALYSIS, NAME_NORMALIZER, aviationTextField } from './analysis.js';
import { abandonIndex, buildPinReason, checkBuildId, recordBuild, withBuildLock } from './publications.js';

/** Bump on any change to the mapping, analysis, synonyms or stem overrides. */
export const CASES_INDEX_VERSION = 'cases-v2';

/**
 * Generation statuses that may be indexed: verified, or already published (a rebuild);
 * in both cases the latest verification must be `ok` and made by `VERIFIER_VERSION`.
 */
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
  /** One value per section of the kind (trimmed, record order); empty when none. */
  probable_cause: string[];
  analysis: string[];
  factual: string[];
  /** One value per distinct finding description, in aircraft and finding order. */
  findings_text: string[];
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

/** Sections of one kind, one value each, in record order, trimmed. */
function sectionTexts(r: CaseRecord, kind: CaseRecord['sections'][number]['kind']): string[] {
  return r.sections
    .filter((s) => s.kind === kind)
    .map((s) => s.text.trim())
    .filter((t) => t !== '');
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
    probable_cause: sectionTexts(r, 'probable_cause'),
    analysis: sectionTexts(r, 'analysis'),
    factual: sectionTexts(r, 'factual'),
    findings_text: distinct(r.findings.map((f) => (f.description ?? '').trim()).filter((d) => d !== '')),
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

/** `<prefix>-cases-v2-g<generation>-<yyyymmddhhmmssmmm UTC>-<build id>`. */
export function casesIndexName(prefix: string, generationId: number, at: Date, buildId: string): string {
  checkPrefix(prefix);
  checkBuildId(buildId);
  if (!Number.isSafeInteger(generationId) || generationId < 1) throw new Error('invalid generation id');
  const stamp = at.toISOString().replace(/\D/g, '');
  return `${prefix}-${CASES_INDEX_VERSION}-g${generationId}-${stamp}-${buildId}`;
}

export function newBuildId(): string {
  return randomBytes(4).toString('hex');
}

// ---------------------------------------------------------------------------
// Build

export class GenerationNotIndexableError extends Error {
  constructor(
    readonly generationId: number,
    reason: string,
  ) {
    super(`generation ${generationId} cannot be indexed: ${reason}`);
    this.name = 'GenerationNotIndexableError';
  }
}

/** The alias has a switch whose outcome is unresolved; nothing is built until it is reconciled. */
export class UnresolvedAliasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvedAliasError';
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
  /** Build id (tests); default random. Unique per build: it names the index and the pin. */
  buildId?: string;
  log?: (message: string) => void;
  /** Alias switch settings (lock wait, read-back retries). */
  alias?: Pick<SwitchAliasOptions, 'lockTimeoutMs' | 'readAttempts' | 'readRetryDelayMs'>;
  /** Test seam: runs once the generation is pinned, before anything is counted or created. */
  afterPin?: () => Promise<void> | void;
}

export interface IndexReport {
  index: string;
  alias: string;
  buildId: string;
  /** Indices the alias pointed at before; kept. */
  previousIndices: string[];
  /** A read-back after the committed switch showed exactly the new index. */
  aliasVerified: boolean;
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

/**
 * Under the lifecycle lock (shared with verification, publication and pruning): check
 * that the generation is indexable and pin it, without expiry, for this build. Pruning
 * either ran first (the generation is gone and this refuses) or runs later and skips
 * the pinned generation.
 */
async function pinIndexableGeneration(db: Db, generationId: number, reason: string): Promise<void> {
  await withLifecycleLock(db, async (q) => {
    const [g] = await q
      .select({
        status: datasetGenerations.status,
        verificationStatus: datasetGenerations.verificationStatus,
        verifierVersion: datasetGenerations.verifierVersion,
      })
      .from(datasetGenerations)
      .where(eq(datasetGenerations.id, generationId));
    if (!g) throw new GenerationNotIndexableError(generationId, 'it does not exist');
    if (!INDEXABLE_STATUSES.includes(g.status)) {
      throw new GenerationNotIndexableError(generationId, `it is ${g.status}; only a verified generation can be indexed`);
    }
    if (g.verificationStatus !== 'ok' || g.verifierVersion !== VERIFIER_VERSION) {
      throw new GenerationNotIndexableError(
        generationId,
        `its latest verification is ${g.verificationStatus ?? 'none'} by ${g.verifierVersion ?? 'no verifier'}; ${VERIFIER_VERSION} must have passed it`,
      );
    }
    try {
      await q.execute(sql`select pin_generation(${generationId}, ${reason}, null::timestamptz)`);
    } catch (err) {
      throw lifecycleError(err);
    }
  });
}

/** Fail closed: the build's own pin must still exist when it publishes. */
async function assertPinned(client: pg.PoolClient, generationId: number, reason: string): Promise<void> {
  const r = await client.query('select 1 from generation_pins where generation_id = $1 and reason = $2', [generationId, reason]);
  if (r.rowCount !== 1) throw new Error(`build pin ${reason} of generation ${generationId} is gone; refusing to publish`);
}

async function unpin(db: Db, generationId: number, reason: string, log: (m: string) => void): Promise<void> {
  try {
    await db.execute(sql`select unpin_generation(${generationId}, ${reason})`);
  } catch (err) {
    log(`could not release pin ${reason} of generation ${generationId} (pnpm worker index cleanup-builds removes it): ${String(lifecycleError(err))}`);
  }
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
  if (total <= 0) wrong.push(['documents (non-empty)', expected.cases, total]);
  if (wrong.length > 0) {
    throw new Error(`index ${index} failed verification: ${wrong.map(([k, want, got]) => `${k} expected ${want}, got ${got}`).join('; ')}`);
  }
}

/**
 * Build a new cases index for one verified generation and move the alias to it.
 *
 * 1. Take this build's liveness lock and refuse while the alias has an unresolved
 *    switch.
 * 2. Under the lifecycle lock, check the generation (verified or published, latest
 *    verification ok by the current verifier) and pin it for this build, without
 *    expiry.
 * 3. Count its US cases (an empty generation is refused), record the build, create the
 *    index (refresh off), bulk-load every US case, refresh, and verify the counts.
 * 4. Switch the alias (serialized per alias; refused if the build's pin is gone).
 * 5. Remove this build's pin.
 *
 * Until the switch request is sent, any failure deletes the new index. Once sent, the
 * index is deleted only on a definite rejection; a transport failure leaves it in
 * place and the alias blocked until reconciled. The previous index is always kept.
 */
export async function rebuildCasesIndex(es: Client, db: Db, opts: RebuildCasesOptions): Promise<IndexReport> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const batchSize = opts.batchSize ?? 500;
  const maxBulkBytes = opts.maxBulkBytes ?? 8 * 1024 * 1024;
  const { generationId, prefix } = opts;
  const buildId = opts.buildId ?? newBuildId();
  const alias = casesAlias(prefix);
  const index = casesIndexName(prefix, generationId, (opts.now ?? (() => new Date()))(), buildId);
  const pinReason = buildPinReason(buildId);

  return withBuildLock(db, buildId, async () => {
    const unresolved = await unresolvedPublications(db.$client, alias);
    if (unresolved.length > 0) throw new UnresolvedAliasError(unresolvedMessage(alias, unresolved));

    await pinIndexableGeneration(db, generationId, pinReason);
    try {
      await opts.afterPin?.();
      const expected = await countCaseRecords(db, generationId);
      if (expected.cases === 0) {
        throw new GenerationNotIndexableError(generationId, 'it has no US cases; an empty index is never built');
      }
      const fingerprint = casesIndexFingerprint();
      await recordBuild(db, { indexName: index, alias, buildId, generationId });

      // Pre-publication: the alias is untouched, so any failure deletes the new index.
      let streamed = 0;
      let unparsedEventLabels = 0;
      try {
        await es.indices.create({
          index,
          settings: { ...CASES_SETTINGS, refresh_interval: '-1' },
          mappings: {
            ...CASES_MAPPING,
            _meta: { index_version: CASES_INDEX_VERSION, fingerprint, generation_id: generationId, build_id: buildId },
          },
        });
        log(`created ${index}`);
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
      } catch (err) {
        await abandonIndex(es, db.$client, index).catch((e: unknown) => log(`cleanup of ${index} failed: ${String(e)}`));
        throw err;
      }

      // Publication.
      let switched;
      try {
        switched = await switchAlias(es, db, alias, index, {
          ...opts.alias,
          buildId,
          generationId,
          beforeSwitch: (client) => assertPinned(client, generationId, pinReason),
        });
      } catch (err) {
        if (err instanceof AliasSwitchError && err.outcome === 'not_switched') {
          await abandonIndex(es, db.$client, index).catch((e: unknown) => log(`cleanup of ${index} failed: ${String(e)}`));
        }
        throw err;
      }
      log(`alias ${alias} -> ${index}${switched.previous.length ? ` (was ${switched.previous.join(', ')})` : ''}`);
      if (!switched.verified) log(`alias ${alias}: switch committed but could not be read back`);
      return {
        index,
        alias,
        buildId,
        previousIndices: switched.previous,
        aliasVerified: switched.verified,
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
    } finally {
      await unpin(db, generationId, pinReason, log);
    }
  });
}
