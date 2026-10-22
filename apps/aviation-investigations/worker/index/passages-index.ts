/**
 * The passages index: section chunks of one verified generation's answer-eligible US
 * cases, with their embeddings, for filtered kNN and BM25 retrieval (DESIGN §5;
 * amendments A2, A3, A6, A7, A10, A12, A16).
 *
 * - Index `<prefix>-passages-v2-g<generation>-<UTC timestamp>-<build id>`, alias
 *   `<prefix>-passages` ("built last", for operators; the API reads index names from
 *   the active `dataset_manifests` row). Builds use the cases index's machinery
 *   (`publications.ts`, `aliases.ts`): a recorded build with its own liveness lock,
 *   a generation pin `index-build:<build id>` without expiry that must still exist
 *   when the alias switches, recorded switch attempts, and automatic deletion only of
 *   an index that was never part of an alias request.
 * - One document per passage, `_id` = `passage_id`. Text uses the cases analyzers
 *   (`aviation_english`, A12). `embedding` is a 1,536-dimension `dense_vector`
 *   (cosine, `int8_hnsw`); vectors are kept out of `_source`. Event filter fields are
 *   copied onto every passage. Only an aircraft-scoped passage fills the nested
 *   `aircraft` field (its one aircraft), so a nested `aircraft` filter never matches
 *   an event-scoped passage.
 * - **Event aircraft (`passages-v2`).** An event-scoped passage (`aircraft_specific:
 *   false`) lists every aircraft of its event under the nested field
 *   `event_aircraft`, with the same properties, records `event_aircraft_count` (the
 *   event's `case_aircraft` rows in PostgreSQL) and `event_aircraft_complete: true`.
 *   The plan and the build compare each event-scoped passage's set with the event's
 *   aircraft keys read separately from PostgreSQL (`loadEventAircraftSets`) and refuse
 *   (`IncompleteEventAircraftError`) on any difference, before an index exists. This
 *   is what lets retrieval qualify an event as a whole under aircraft filters (gate
 *   G5 extension, `server/search/filters.ts`); the passage stays event-scoped.
 *   `passages-v1` stored the set as a flattened object, which cannot prove that every
 *   aircraft satisfies a conjunction; its mapping (`PASSAGES_V1_MAPPING`) is kept to
 *   re-derive its recorded fingerprint.
 * - Embedding inputs are those of `passages-v1` (template `input-v1`, chunker
 *   `chunk-v2`): a `passages-v2` build of a generation `passages-v1` was built for
 *   finds every vector in `embedding_cache`.
 * - `planPassages` is the dry run: it reads the generation (one repeatable-read
 *   snapshot, nothing written, nothing pinned), builds every passage and reports
 *   counts, exact token totals (headers and overlap included), percentiles, A16
 *   splits, the checked event aircraft sets, expected cache hits and the estimated
 *   cost ("to embed").
 * - `rebuildPassagesIndex` refuses unless `confirmCost` is set and the plan's
 *   reservations fit the remaining indexing budget. It then writes the passages to
 *   PostgreSQL (insert-only, idempotent), resolves vectors from `embedding_cache`,
 *   embeds only the misses (each distinct input once, in requests of at most 96
 *   inputs), stores them in the cache as they arrive, bulk-loads the index, checks
 *   it against what was built and switches the alias.
 * - **Cache only** (`cacheOnly`): the build pays for nothing. It replaces the given
 *   embedder with one that throws on any call (`cacheOnlyEmbedder`), needs neither
 *   `confirmCost` nor the spend gate, and stops with `CacheIncompleteError` before
 *   creating an index unless the plan finds every input in the cache.
 */
import { createHash } from 'node:crypto';
import type { Client, estypes } from '@elastic/elasticsearch';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import type { Db, DbOrTx } from '../../server/db/client.js';
import { VERIFIER_VERSION } from '../../server/db/generations.js';
import { streamCaseRecords, type CaseRecord, type SectionKind } from '../../server/db/queries/case-records.js';
import { datasetGenerations, passages as passagesTable } from '../../server/db/schema/index.js';
import { AliasSwitchError, blockedMessage, blockingAttempts, switchAlias, type SwitchAliasOptions } from './aliases.js';
import { AVIATION_ANALYSIS, NAME_NORMALIZER, aviationTextField } from './analysis.js';
import {
  GenerationNotIndexableError,
  INDEXABLE_STATUSES,
  UnresolvedAliasError,
  assertPinned,
  newBuildId,
  pinIndexableGeneration,
  unpin,
} from './cases-index.js';
import { buildPinReason, checkBuildId, deleteUnsubmittedIndex, recordBuild, withBuildLock } from './publications.js';
import { CHUNKER_VERSION, DEFAULT_CHUNK_OPTIONS } from './chunk.js';
import { EMBEDDING_LIMITS, batchByLimits, cacheOnlyEmbedder, embeddingUsd, reservationUsd, type Embedder } from './embed.js';
import { countCachedKeys, embeddingCacheKey, lookupEmbeddings, storeEmbeddings } from './embedding-cache.js';
import {
  EMBEDDING_INPUT_TEMPLATE_VERSION,
  buildCasePassages,
  type CasePassage,
  type PassageAircraft,
  type PassageScope,
} from './passages.js';
import { SpendRefusedError, type SpendGate } from './spend-gate.js';
import { TOKENIZER } from './tokens.js';

/** Bump on any change to the mapping, analysis, chunking, input template or embedding model. */
export const PASSAGES_INDEX_VERSION = 'passages-v2';
/** Versions whose definition this module keeps (`passagesIndexFingerprint`). */
export const PASSAGES_INDEX_VERSIONS = ['passages-v1', 'passages-v2'] as const;
export type PassagesIndexVersion = (typeof PASSAGES_INDEX_VERSIONS)[number];
/** The embedding the mapping is built for (DESIGN §5: `text-embedding-3-small`, 1,536 dimensions). */
export const PASSAGES_EMBEDDING_DIMS = 1536;
/** Two-key advisory lock namespace: one passages build per generation at a time (no double spending). */
export const PASSAGES_BUILD_LOCK_NAMESPACE = 731_190_520;
/**
 * Pool connections a build needs at once: the build's liveness lock, the snapshot
 * stream, and the writes (passages, cache) made while the stream is open.
 */
export const PASSAGES_BUILD_MIN_POOL = 3;

// ---------------------------------------------------------------------------
// Document

export interface PassageDoc {
  passage_id: string;
  ntsb_no: string;
  section_id: string;
  revision_id: string;
  section_kind: SectionKind;
  scope: PassageScope;
  aircraft_specific: boolean;
  aircraft_key: number | null;
  start: number;
  end: number;
  part: number;
  parts: number;
  continuation: boolean;
  text: string;
  embedding: number[];
  country: string;
  ev_year: number | null;
  ev_date: string | null;
  state: string | null;
  answer_eligible: boolean;
  defining_phase_groups: string[];
  highest_injury: string | null;
  wx_cond: string | null;
  light: string | null;
  /** Nested: the one aircraft of an aircraft-scoped passage; empty when event-scoped. */
  aircraft: PassageAircraft[];
  /** Nested: every aircraft of an event-scoped passage's event, as in PostgreSQL; empty when aircraft-scoped. */
  event_aircraft: PassageAircraft[];
  /** Event-scoped: the event's aircraft rows in PostgreSQL (`case_aircraft`); null when aircraft-scoped. */
  event_aircraft_count: number | null;
  /** True only on an event-scoped passage whose `event_aircraft` was checked to be the event's full set. */
  event_aircraft_complete: boolean;
}

/** float32 values with 9 significant digits: exact for float32, about half the JSON of a float64 rendering. */
function vectorJson(v: Float32Array): number[] {
  return Array.from(v, (x) => Number(x.toPrecision(9)));
}

// ---------------------------------------------------------------------------
// Event aircraft sets

/** Every multi-aircraft answer-eligible US event's aircraft keys in PostgreSQL, ascending, by case number. */
export type EventAircraftSets = ReadonlyMap<string, readonly number[]>;

/**
 * Each multi-aircraft answer-eligible US event's aircraft keys, read from
 * `case_aircraft` by its own aggregate query (not through the case records the
 * passages are built from). A generation is sealed, so it cannot change between this
 * read and the record stream.
 */
export async function loadEventAircraftSets(db: DbOrTx, generationId: number): Promise<Map<string, number[]>> {
  const r = await db.execute(sql`
    select a.ntsb_no, array_agg(a.aircraft_key order by a.aircraft_key) as keys
      from case_aircraft a
      join cases c on c.generation_id = a.generation_id and c.ntsb_no = a.ntsb_no
     where a.generation_id = ${generationId} and c.is_us and c.answer_eligible
     group by a.ntsb_no
    having count(*) > 1`);
  const out = new Map<string, number[]>();
  for (const row of r.rows as { ntsb_no: string; keys: unknown }[]) {
    const keys = row.keys;
    if (!Array.isArray(keys) || !keys.every((k) => Number.isSafeInteger(k))) throw new Error(`aircraft keys of ${row.ntsb_no} are not integers`);
    out.set(row.ntsb_no, keys as number[]);
  }
  return out;
}

/** Event-scoped passages whose aircraft set is not the event's full set in PostgreSQL: nothing is built. */
export class IncompleteEventAircraftError extends Error {
  constructor(readonly cases: readonly string[]) {
    super(
      `${cases.length} event(s) have event-scoped passages whose aircraft set differs from case_aircraft ` +
        `(${cases.slice(0, 10).join(', ')}${cases.length > 10 ? ', ...' : ''}); a passages index needs every event's complete aircraft set`,
    );
    this.name = 'IncompleteEventAircraftError';
  }
}

/** True when the passage carries exactly the event's aircraft keys (at least two). Aircraft-scoped passages: true. */
export function hasCompleteEventAircraft(p: CasePassage, sets: EventAircraftSets): boolean {
  if (p.aircraftSpecific) return true;
  const canonical = sets.get(p.ntsbNo);
  const stored = p.aircraft.map((a) => a.aircraft_key).sort((a, b) => a - b);
  return canonical !== undefined && canonical.length >= 2 && stored.length === canonical.length && stored.every((k, i) => k === canonical[i]);
}

/** `event_aircraft_count` of a passage: the event's aircraft count, or null when aircraft-scoped; throws on an incomplete set. */
export function eventAircraftCount(p: CasePassage, sets: EventAircraftSets): number | null {
  if (p.aircraftSpecific) return null;
  if (!hasCompleteEventAircraft(p, sets)) throw new IncompleteEventAircraftError([p.ntsbNo]);
  return p.aircraft.length;
}

export function buildPassageDocument(p: CasePassage, vector: Float32Array, sets: EventAircraftSets): PassageDoc {
  if (vector.length !== PASSAGES_EMBEDDING_DIMS) throw new Error(`${p.passageId}: vector has ${vector.length} dimensions`);
  const count = eventAircraftCount(p, sets);
  return {
    passage_id: p.passageId,
    ntsb_no: p.ntsbNo,
    section_id: p.sectionId,
    revision_id: p.revisionId,
    section_kind: p.kind,
    scope: p.scope,
    aircraft_specific: p.aircraftSpecific,
    aircraft_key: p.aircraftKey,
    start: p.start,
    end: p.end,
    part: p.part,
    parts: p.parts,
    continuation: p.continuation,
    text: p.text,
    embedding: vectorJson(vector),
    ...p.filters,
    aircraft: p.aircraftSpecific ? p.aircraft : [],
    event_aircraft: p.aircraftSpecific ? [] : p.aircraft,
    event_aircraft_count: count,
    event_aircraft_complete: count !== null,
  };
}

// ---------------------------------------------------------------------------
// Mapping and settings

const keyword = (): estypes.MappingKeywordProperty => ({ type: 'keyword' });
const nameKeyword = (): estypes.MappingKeywordProperty => ({ type: 'keyword', normalizer: NAME_NORMALIZER });
const aircraftProperties = (): Record<string, estypes.MappingProperty> => ({
  aircraft_key: { type: 'integer' },
  category: keyword(),
  make: nameKeyword(),
  model: nameKeyword(),
  far_part: keyword(),
  purpose: keyword(),
  eng_types: keyword(),
  defining_phase_group: keyword(),
});

const V1_PROPERTIES: Record<string, estypes.MappingProperty> = {
  passage_id: keyword(),
  ntsb_no: keyword(),
  section_id: keyword(),
  revision_id: keyword(),
  section_kind: keyword(),
  scope: keyword(),
  aircraft_specific: { type: 'boolean' },
  aircraft_key: { type: 'integer' },
  start: { type: 'integer' },
  end: { type: 'integer' },
  part: { type: 'integer' },
  parts: { type: 'integer' },
  continuation: { type: 'boolean' },
  text: aviationTextField(),
  embedding: {
    type: 'dense_vector',
    dims: PASSAGES_EMBEDDING_DIMS,
    similarity: 'cosine',
    index: true,
    index_options: { type: 'int8_hnsw' },
  },
  country: keyword(),
  ev_year: { type: 'integer' },
  ev_date: { type: 'date', format: 'strict_date' },
  state: keyword(),
  answer_eligible: { type: 'boolean' },
  defining_phase_groups: keyword(),
  highest_injury: keyword(),
  wx_cond: keyword(),
  light: keyword(),
  aircraft: { type: 'nested', dynamic: 'strict', properties: aircraftProperties() },
  event_aircraft: { type: 'object', dynamic: 'strict', properties: aircraftProperties() },
};

/**
 * The `passages-v1` mapping: `event_aircraft` a plain object, whose flattened fields
 * cannot tell which aircraft satisfied which predicate. Kept to re-derive the
 * recorded `passages-v1` fingerprint (and, in tests, to stand up a v1 index); the
 * build never uses it.
 */
export const PASSAGES_V1_MAPPING: estypes.MappingTypeMapping = { dynamic: 'strict', properties: V1_PROPERTIES };

/** The `passages-v2` mapping: v1 with `event_aircraft` nested, its count and the completeness flag. */
export const PASSAGES_MAPPING: estypes.MappingTypeMapping = {
  dynamic: 'strict',
  properties: {
    ...V1_PROPERTIES,
    event_aircraft: { type: 'nested', dynamic: 'strict', properties: aircraftProperties() },
    event_aircraft_count: { type: 'integer' },
    event_aircraft_complete: { type: 'boolean' },
  },
};

/** One shard (exact BM25 statistics), no replicas, vectors kept out of `_source`. */
export const PASSAGES_SETTINGS: estypes.IndicesIndexSettings = {
  number_of_shards: 1,
  number_of_replicas: 0,
  'mapping.exclude_source_vectors': true,
  analysis: AVIATION_ANALYSIS,
};

const MAPPINGS: Readonly<Record<PassagesIndexVersion, estypes.MappingTypeMapping>> = {
  'passages-v1': PASSAGES_V1_MAPPING,
  'passages-v2': PASSAGES_MAPPING,
};

/**
 * sha256 over everything that shapes a passage document of `version` (default: the
 * one built); recorded in the index `_meta`. Both versions share settings, chunking,
 * template, tokenizer and dimensions; only the mapping differs.
 */
export function passagesIndexFingerprint(model: string, version: PassagesIndexVersion = PASSAGES_INDEX_VERSION): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version,
        settings: PASSAGES_SETTINGS,
        mapping: MAPPINGS[version],
        chunker: CHUNKER_VERSION,
        chunkOptions: DEFAULT_CHUNK_OPTIONS,
        template: EMBEDDING_INPUT_TEMPLATE_VERSION,
        tokenizer: TOKENIZER,
        model,
        dims: PASSAGES_EMBEDDING_DIMS,
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Names

const PREFIX = /^[a-z0-9][a-z0-9._-]*$/;

function checkPrefix(prefix: string): void {
  if (!PREFIX.test(prefix) || prefix.length > 100) throw new Error(`invalid index prefix: ${JSON.stringify(prefix)}`);
}

export function passagesAlias(prefix: string): string {
  checkPrefix(prefix);
  return `${prefix}-passages`;
}

/** `<prefix>-passages-v2-g<generation>-<yyyymmddhhmmssmmm UTC>-<build id>`, like the cases index. */
export function passagesIndexName(prefix: string, generationId: number, at: Date, buildId: string): string {
  checkPrefix(prefix);
  checkBuildId(buildId);
  if (!Number.isSafeInteger(generationId) || generationId < 1) throw new Error('invalid generation id');
  const stamp = at.toISOString().replace(/\D/g, '');
  return `${prefix}-${PASSAGES_INDEX_VERSION}-g${generationId}-${stamp}-${buildId}`;
}

// ---------------------------------------------------------------------------
// Plan (dry run)

export interface EmbeddingSpec {
  model: string;
  dims: number;
  usdPerMillionTokens: number;
}

export interface TokenPercentiles {
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface KindScopeCount {
  kind: SectionKind;
  scope: PassageScope;
  sections: number;
  wholeSections: number;
  passages: number;
  inputTokens: number;
}

export interface PassagePlan {
  generationId: number;
  chunkerVersion: string;
  chunkOptions: typeof DEFAULT_CHUNK_OPTIONS;
  templateVersion: string;
  tokenizer: string;
  embedding: EmbeddingSpec;
  /** US cases read from the generation; only the answer-eligible ones get passages. */
  usCases: number;
  answerEligibleCases: number;
  casesWithPassages: number;
  sections: number;
  passages: number;
  byKindScope: KindScopeCount[];
  aircraftSpecific: number;
  eventScoped: number;
  /** Event-scoped passages checked against each event's aircraft rows in PostgreSQL (all complete, or the plan throws). */
  eventAircraft: { events: number; passages: number; aircraft: number };
  tokens: {
    /** Exact tokens of every embedding input: header, separator, overlap and text. */
    input: number;
    /** Passage text alone (overlap included). */
    text: number;
    /** `input - text`: headers and the newline after them. */
    header: number;
    /** Text repeated from the previous passage of the same section. */
    overlap: number;
  };
  inputTokenPercentiles: TokenPercentiles;
  maxPassageTextTokens: number;
  /** Largest probable cause (A11 keeps causes whole up to the chunker's maxTokens). */
  maxProbableCauseTokens: number;
  continuations: number;
  /** A16: what was split, and the cases it affects. */
  oversized: {
    probableCauses: number;
    longSentences: number;
    forcedCharSplits: number;
    cases: string[];
  };
  uniqueInputs: number;
  duplicateInputs: number;
  cache: { available: boolean; hits: number; hitTokens: number };
  toEmbed: { inputs: number; tokens: number; requests: number };
  estimatedUsd: number;
  /** Sum of the single-attempt reservations of every request (A7). */
  reservationUsd: number;
  durationMs: number;
}

function percentiles(values: number[]): TokenPercentiles {
  if (values.length === 0) return { min: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const s = Float64Array.from(values).sort();
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] as number;
  const sum = values.reduce((a, b) => a + b, 0);
  return { min: s[0] as number, p50: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99), max: s[s.length - 1] as number, mean: sum / values.length };
}

/** The generation must be indexable: verified (or published) with a current `ok` verification. Read-only. */
export async function assertIndexable(db: Db, generationId: number): Promise<void> {
  const [g] = await db
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
    throw new GenerationNotIndexableError(generationId, `its latest verification is not an ok one by ${VERIFIER_VERSION}`);
  }
}

const cacheKeyOf = (p: CasePassage, e: EmbeddingSpec) =>
  embeddingCacheKey({ input: p.input, model: e.model, dims: e.dims, templateVersion: EMBEDDING_INPUT_TEMPLATE_VERSION });

export interface PlanPassagesOptions {
  generationId: number;
  embedding: EmbeddingSpec;
  /** Cases per read batch (default 500). */
  batchSize?: number;
  log?: (message: string) => void;
  /** Test seam: alters each case record before its passages are built (simulates a projection fault). */
  mapRecord?: (r: CaseRecord) => CaseRecord;
}

/**
 * The passages of one streamed record (answer-eligible only), after the test seam.
 * Shared by the plan and the build so both see the same passages.
 */
function recordPassages(r: CaseRecord, mapRecord: ((r: CaseRecord) => CaseRecord) | undefined) {
  return buildCasePassages(mapRecord ? mapRecord(r) : r);
}

/**
 * The dry run: every passage of the generation, counted and priced; nothing is
 * written. Throws `IncompleteEventAircraftError` when an event-scoped passage's
 * aircraft set is not its event's full set in PostgreSQL.
 */
export async function planPassages(db: Db, opts: PlanPassagesOptions): Promise<PassagePlan> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const { generationId, embedding } = opts;
  if (embedding.dims !== PASSAGES_EMBEDDING_DIMS) throw new Error(`the passages mapping needs ${PASSAGES_EMBEDDING_DIMS} dimensions, not ${embedding.dims}`);
  await assertIndexable(db, generationId);
  const sets = await loadEventAircraftSets(db, generationId);
  const incomplete = new Set<string>();
  const eventAircraft = { events: new Set<string>(), passages: 0, aircraft: 0 };

  let usCases = 0;
  let answerEligibleCases = 0;
  let casesWithPassages = 0;
  let sections = 0;
  let passages = 0;
  let aircraftSpecific = 0;
  let eventScoped = 0;
  let continuations = 0;
  let maxPassageTextTokens = 0;
  let maxProbableCauseTokens = 0;
  const tokens = { input: 0, text: 0, header: 0, overlap: 0 };
  const inputTokens: number[] = [];
  const byKindScope = new Map<string, KindScopeCount>();
  const oversized = { probableCauses: 0, longSentences: 0, forcedCharSplits: 0, cases: new Set<string>() };
  /** Distinct inputs in first-seen order, with their token counts. */
  const unique = new Map<string, number>();

  for await (const r of streamCaseRecords(db, generationId, { batchSize: opts.batchSize ?? 500 })) {
    usCases += 1;
    if (!r.answerEligible) continue;
    answerEligibleCases += 1;
    const built = recordPassages(r, opts.mapRecord);
    if (built.passages.length > 0) casesWithPassages += 1;
    for (const s of built.sections) {
      sections += 1;
      const k = `${s.kind}/${s.scope}`;
      const row = byKindScope.get(k) ?? { kind: s.kind, scope: s.scope, sections: 0, wholeSections: 0, passages: 0, inputTokens: 0 };
      row.sections += 1;
      if (s.stats.whole) row.wholeSections += 1;
      byKindScope.set(k, row);
      if (s.stats.oversizedProbableCause || s.stats.longSentences > 0 || s.stats.forcedCharSplits > 0) oversized.cases.add(r.ntsbNo);
      if (s.stats.oversizedProbableCause) oversized.probableCauses += 1;
      oversized.longSentences += s.stats.longSentences;
      oversized.forcedCharSplits += s.stats.forcedCharSplits;
    }
    for (const p of built.passages) {
      passages += 1;
      if (p.aircraftSpecific) aircraftSpecific += 1;
      else {
        eventScoped += 1;
        if (hasCompleteEventAircraft(p, sets)) {
          eventAircraft.events.add(p.ntsbNo);
          eventAircraft.passages += 1;
          eventAircraft.aircraft += p.aircraft.length;
        } else incomplete.add(p.ntsbNo);
      }
      if (p.continuation) continuations += 1;
      maxPassageTextTokens = Math.max(maxPassageTextTokens, p.tokens);
      if (p.kind === 'probable_cause' && p.parts === 1) maxProbableCauseTokens = Math.max(maxProbableCauseTokens, p.tokens);
      tokens.input += p.inputTokens;
      tokens.text += p.tokens;
      tokens.overlap += p.overlapTokens;
      inputTokens.push(p.inputTokens);
      const row = byKindScope.get(`${p.kind}/${p.scope}`) as KindScopeCount;
      row.passages += 1;
      row.inputTokens += p.inputTokens;
      const key = cacheKeyOf(p, embedding);
      if (!unique.has(key)) unique.set(key, p.inputTokens);
    }
    if (usCases % 5000 === 0) log(`planned ${usCases} US cases, ${passages} passages`);
  }
  tokens.header = tokens.input - tokens.text;
  if (incomplete.size > 0) throw new IncompleteEventAircraftError([...incomplete].sort());

  const { available, cached } = await countCachedKeys(db, [...unique.keys()]);
  let hitTokens = 0;
  const misses: [string, number][] = [];
  for (const [key, n] of unique) {
    if (cached.has(key)) hitTokens += n;
    else misses.push([key, n]);
  }
  const requests = batchByLimits(misses, ([, n]) => n);
  const toEmbedTokens = misses.reduce((sum, [, n]) => sum + n, 0);
  return {
    generationId,
    chunkerVersion: CHUNKER_VERSION,
    chunkOptions: DEFAULT_CHUNK_OPTIONS,
    templateVersion: EMBEDDING_INPUT_TEMPLATE_VERSION,
    tokenizer: TOKENIZER,
    embedding,
    usCases,
    answerEligibleCases,
    casesWithPassages,
    sections,
    passages,
    byKindScope: [...byKindScope.values()].sort((a, b) => `${a.kind}/${a.scope}`.localeCompare(`${b.kind}/${b.scope}`)),
    aircraftSpecific,
    eventScoped,
    eventAircraft: { events: eventAircraft.events.size, passages: eventAircraft.passages, aircraft: eventAircraft.aircraft },
    tokens,
    inputTokenPercentiles: percentiles(inputTokens),
    maxPassageTextTokens,
    maxProbableCauseTokens,
    continuations,
    oversized: { ...oversized, cases: [...oversized.cases].sort() },
    uniqueInputs: unique.size,
    duplicateInputs: passages - unique.size,
    cache: { available, hits: cached.size, hitTokens },
    toEmbed: { inputs: misses.length, tokens: toEmbedTokens, requests: requests.length },
    estimatedUsd: embeddingUsd(toEmbedTokens, embedding.usdPerMillionTokens),
    reservationUsd: requests.reduce(
      (sum, b) => sum + reservationUsd(b.reduce((t, [, n]) => t + n, 0), embedding.usdPerMillionTokens),
      0,
    ),
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Build

/** A cache-only build found inputs that are not cached: it stops before creating an index, having paid for nothing. */
export class CacheIncompleteError extends Error {
  constructor(readonly plan: PassagePlan) {
    super(
      plan.cache.available
        ? `${plan.toEmbed.inputs} of ${plan.uniqueInputs} embedding inputs are not in embedding_cache (${plan.toEmbed.tokens} tokens, ` +
            `about $${plan.estimatedUsd.toFixed(4)}); a cache-only build embeds nothing and stops`
        : 'embedding_cache does not exist in this database; a cache-only build stops',
    );
    this.name = 'CacheIncompleteError';
  }
}

export class CostNotConfirmedError extends Error {
  constructor(readonly plan: PassagePlan) {
    super(
      `embedding ${plan.toEmbed.inputs} inputs (${plan.toEmbed.tokens} tokens, about $${plan.estimatedUsd.toFixed(4)}) needs --confirm-cost`,
    );
    this.name = 'CostNotConfirmedError';
  }
}

export interface RebuildPassagesOptions {
  generationId: number;
  prefix: string;
  gate: SpendGate;
  /** Required for a paid build: without it the build stops after the plan (`CostNotConfirmedError`). */
  confirmCost: boolean;
  /**
   * Build from `embedding_cache` alone: the embedder is replaced by one that throws on
   * any call, `confirmCost` and the spend gate are not consulted, and the build stops
   * with `CacheIncompleteError` before creating an index unless every input is cached.
   */
  cacheOnly?: boolean;
  /** Cases per read batch (default 200). */
  batchSize?: number;
  /** Passages per embedding/indexing window (default 480). */
  windowSize?: number;
  /** Bulk request body limit in bytes (default 8 MiB). */
  maxBulkBytes?: number;
  /** Clock for the index name (tests). */
  now?: () => Date;
  /** Build id (tests); default random. It names the index and the pin. */
  buildId?: string;
  log?: (message: string) => void;
  alias?: Pick<SwitchAliasOptions, 'lockTimeoutMs' | 'readAttempts' | 'readRetryDelayMs'>;
  /** Test seam: runs once the generation is pinned, before planning. */
  afterPin?: () => Promise<void> | void;
  /** Test seam: alters each case record before its passages are built, in the plan and the build. */
  mapRecord?: (r: CaseRecord) => CaseRecord;
}

export interface PassagesIndexReport {
  index: string;
  alias: string;
  buildId: string;
  /** The committed `index_switch_attempts` row. */
  attemptId: number | null;
  previousIndices: string[];
  /** A read-back after the committed switch showed exactly the new index. */
  aliasVerified: boolean;
  generationId: number;
  version: string;
  fingerprint: string;
  model: string;
  dims: number;
  passages: number;
  /** Passage rows that already existed in PostgreSQL (an earlier build of this generation and chunker). */
  passagesAlreadyStored: number;
  /** Distinct inputs found in `embedding_cache` when first met (cached before this build). */
  cacheHits: number;
  /** Passages whose exact input another passage of this build already had: embedded once. */
  deduplicated: number;
  /** Built with `cacheOnly`: no embedder call was possible. */
  cacheOnly: boolean;
  embedded: { inputs: number; tokens: number; requests: number; usd: number };
  plan: PassagePlan;
  durationMs: number;
}

/**
 * Hold the per-generation passages lock: a second build of the same generation fails
 * fast instead of paying for the same embeddings. It lives on its own session, outside
 * the pool the build needs.
 */
async function withGenerationLock<T>(db: Db, generationId: number, fn: () => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...db.$client.options, application_name: 'aviation-passages-generation-lock' });
  await client.connect();
  try {
    const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1, $2) as ok', [PASSAGES_BUILD_LOCK_NAMESPACE, generationId]);
    if (r.rows[0]?.ok !== true) throw new Error(`another passages build of generation ${generationId} is running`);
    return await fn();
  } finally {
    // Closing the session releases the lock.
    await client.end().catch(() => undefined);
  }
}

type PassageRow = typeof passagesTable.$inferInsert;

function passageRow(generationId: number, p: CasePassage): PassageRow {
  return {
    generationId,
    passageId: p.passageId,
    chunkerVersion: p.chunkerVersion,
    ntsbNo: p.ntsbNo,
    sectionId: p.sectionId,
    revisionId: p.revisionId,
    sectionSha: p.sectionSha,
    sectionKind: p.kind,
    scope: p.scope,
    aircraftKey: p.aircraftKey,
    aircraftSpecific: p.aircraftSpecific,
    start: p.start,
    end: p.end,
    part: p.part,
    parts: p.parts,
    continuation: p.continuation,
    tokenCount: p.tokens,
  };
}

const ROW_FIELDS = [
  'chunkerVersion', 'ntsbNo', 'sectionId', 'revisionId', 'sectionSha', 'sectionKind', 'scope', 'aircraftKey',
  'aircraftSpecific', 'start', 'end', 'part', 'parts', 'continuation', 'tokenCount',
] as const;

/** Insert passage rows; rows that exist already must be identical. Returns how many existed. */
async function storePassages(db: Db, generationId: number, batch: readonly CasePassage[]): Promise<number> {
  if (batch.length === 0) return 0;
  const rows = batch.map((p) => passageRow(generationId, p));
  const inserted = await db.insert(passagesTable).values(rows).onConflictDoNothing().returning({ id: passagesTable.passageId });
  const fresh = new Set(inserted.map((r) => r.id));
  const existing = rows.filter((r) => !fresh.has(r.passageId));
  if (existing.length === 0) return 0;
  const stored = await db
    .select()
    .from(passagesTable)
    .where(and(eq(passagesTable.generationId, generationId), inArray(passagesTable.passageId, existing.map((r) => r.passageId))));
  const byId = new Map(stored.map((r) => [r.passageId, r]));
  for (const r of existing) {
    const s = byId.get(r.passageId);
    const differs = !s || ROW_FIELDS.some((f) => s[f] !== r[f]);
    if (differs) throw new Error(`passage ${r.passageId} of generation ${generationId} is stored differently; bump CHUNKER_VERSION`);
  }
  return existing.length;
}

const BULK_RETRIES = 3;

/** Bulk-create documents; retries 429s. Errors name passages and error types, never document content. */
async function bulkCreate(es: Client, index: string, docs: readonly PassageDoc[], log: (m: string) => void): Promise<void> {
  let pending = docs;
  for (let attempt = 0; pending.length > 0; attempt += 1) {
    const operations = pending.flatMap((d) => [{ create: { _index: index, _id: d.passage_id } }, d]);
    const res = await es.bulk({ operations, refresh: false });
    if (!res.errors) return;
    const retry: PassageDoc[] = [];
    const failed: string[] = [];
    res.items.forEach((item, i) => {
      const result = item.create;
      if (!result?.error) return;
      const doc = pending[i] as PassageDoc;
      if (result.status === 429) retry.push(doc);
      else failed.push(`${doc.passage_id}: ${String(result.error.type).slice(0, 80)}`);
    });
    if (failed.length > 0) throw new Error(`bulk indexing failed for ${failed.length} passage(s): ${failed.slice(0, 5).join('; ')}`);
    if (attempt + 1 >= BULK_RETRIES) throw new Error(`bulk indexing still rejected (429) after ${BULK_RETRIES} attempts`);
    log(`bulk: ${retry.length} passage(s) rejected with 429, retrying`);
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    pending = retry;
  }
}

interface Expected {
  passages: number;
  byKindScope: Map<string, number>;
  eventScoped: number;
  /** Nested aircraft: one per aircraft-scoped passage. */
  nestedAircraft: number;
  /** Nested event aircraft: the event's aircraft count per event-scoped passage. */
  eventAircraft: number;
}

async function verifyIndex(es: Client, index: string, want: Expected): Promise<void> {
  const res = await es.search({
    index,
    size: 0,
    track_total_hits: true,
    aggs: {
      kinds: { multi_terms: { terms: [{ field: 'section_kind' }, { field: 'scope' }], size: 20 } },
      aircraft: { nested: { path: 'aircraft' } },
      event_aircraft: { nested: { path: 'event_aircraft' } },
      event_aircraft_count: { sum: { field: 'event_aircraft_count' } },
    },
  });
  const total = typeof res.hits.total === 'number' ? res.hits.total : (res.hits.total?.value ?? -1);
  const buckets = (res.aggregations?.kinds as estypes.AggregationsMultiTermsAggregate | undefined)?.buckets;
  const got = new Map((Array.isArray(buckets) ? buckets : []).map((b) => [`${b.key[0]}/${b.key[1]}`, b.doc_count]));
  const nested = (res.aggregations?.aircraft as estypes.AggregationsNestedAggregate | undefined)?.doc_count ?? -1;
  const nestedEvent = (res.aggregations?.event_aircraft as estypes.AggregationsNestedAggregate | undefined)?.doc_count ?? -1;
  const countSum = (res.aggregations?.event_aircraft_count as estypes.AggregationsSumAggregate | undefined)?.value ?? -1;
  const count = async (query: estypes.QueryDslQueryContainer) => (await es.count({ index, query })).count;
  const nestedAny: estypes.QueryDslQueryContainer = { nested: { path: 'aircraft', query: { match_all: {} } } };
  const eventAny: estypes.QueryDslQueryContainer = { nested: { path: 'event_aircraft', query: { match_all: {} } } };
  const eventScoped: estypes.QueryDslQueryContainer = { term: { aircraft_specific: false } };
  const aircraftScoped: estypes.QueryDslQueryContainer = { term: { aircraft_specific: true } };
  const checks: [string, number, number][] = [
    ['passages', want.passages, total],
    ['nested aircraft', want.nestedAircraft, nested],
    ['nested event aircraft', want.eventAircraft, nestedEvent],
    ['sum of event_aircraft_count', want.eventAircraft, countSum],
    ['event-scoped (aircraft_specific false)', want.eventScoped, await count(eventScoped)],
    ['event-scoped with nested aircraft', 0, await count({ bool: { filter: [eventScoped, nestedAny] } })],
    ['aircraft-scoped with event aircraft', 0, await count({ bool: { filter: [aircraftScoped, eventAny] } })],
    ['event-scoped without event aircraft', 0, await count({ bool: { filter: [eventScoped], must_not: [eventAny] } })],
    ['event-scoped not marked complete', 0, await count({ bool: { filter: [eventScoped], must_not: [{ term: { event_aircraft_complete: true } }] } })],
    ['event-scoped with fewer than 2 event aircraft', 0, await count({ bool: { filter: [eventScoped], must_not: [{ range: { event_aircraft_count: { gte: 2 } } }] } })],
    [
      'aircraft-scoped with an event aircraft count or flag',
      0,
      await count({
        bool: {
          filter: [aircraftScoped],
          should: [{ term: { event_aircraft_complete: true } }, { exists: { field: 'event_aircraft_count' } }],
          minimum_should_match: 1,
        },
      }),
    ],
    ['with an embedding', want.passages, await count({ exists: { field: 'embedding' } })],
    ['not answer-eligible', 0, await count({ bool: { must_not: { term: { answer_eligible: true } } } })],
    ['non-US', 0, await count({ bool: { must_not: { term: { country: 'USA' } } } })],
  ];
  for (const [k, n] of want.byKindScope) checks.push([k, n, got.get(k) ?? 0]);
  for (const [k, n] of got) if (!want.byKindScope.has(k)) checks.push([k, 0, n]);
  const wrong = checks.filter(([, a, b]) => a !== b);
  if (total <= 0) wrong.push(['passages (non-empty)', want.passages, total]);
  if (wrong.length > 0) {
    throw new Error(`index ${index} failed verification: ${wrong.map(([k, a, b]) => `${k} expected ${a}, got ${b}`).join('; ')}`);
  }
}

function checkPool(db: Db): void {
  const max = db.$client.options.max ?? 10;
  if (max < PASSAGES_BUILD_MIN_POOL) {
    throw new Error(`a passages build needs a pool of at least ${PASSAGES_BUILD_MIN_POOL} connections (this one has ${max})`);
  }
}

/**
 * Build a passages index for one verified generation and move the alias to it.
 *
 * 1. Take the per-generation passages lock and this build's liveness lock; refuse
 *    while the alias is blocked by an unresolved switch attempt; record the build.
 * 2. Check and pin the generation for this build (`index-build:<build id>`, no
 *    expiry), as the cases index does.
 * 3. Plan (the dry run; it refuses incomplete event aircraft sets). With `cacheOnly`,
 *    stop with `CacheIncompleteError` unless every input is cached; otherwise stop
 *    with `CostNotConfirmedError` unless `confirmCost`, and with `SpendRefusedError`
 *    if the plan's reservations exceed the remaining indexing budget. An empty plan is
 *    refused.
 * 4. Create the index and stream the generation again: store passages, resolve
 *    vectors (cache first, then the embedder for misses, each distinct input once,
 *    in the plan's request boundaries), cache new vectors, bulk-load documents.
 * 5. Verify the index and the stored passages against what was built; switch the
 *    alias (refused if the build's pin is gone); remove the pin.
 *
 * The only automatic deletion: if the build fails before its index was part of any
 * alias request, the index is deleted. Embeddings already paid for stay in the cache,
 * so a rerun does not pay for them again.
 */
export async function rebuildPassagesIndex(
  es: Client,
  db: Db,
  given: Embedder,
  opts: RebuildPassagesOptions,
): Promise<PassagesIndexReport> {
  const started = Date.now();
  const log = opts.log ?? (() => undefined);
  const { generationId, prefix } = opts;
  const cacheOnly = opts.cacheOnly === true;
  // A cache-only build never holds a callable embedder: only the model, dimensions and price are kept.
  const embedder: Embedder = cacheOnly ? cacheOnlyEmbedder(given) : given;
  if (embedder.dims !== PASSAGES_EMBEDDING_DIMS) throw new Error(`the passages mapping needs ${PASSAGES_EMBEDDING_DIMS} dimensions, not ${embedder.dims}`);
  checkPool(db);
  const buildId = opts.buildId ?? newBuildId();
  const alias = passagesAlias(prefix);
  const index = passagesIndexName(prefix, generationId, (opts.now ?? (() => new Date()))(), buildId);
  const pinReason = buildPinReason(buildId);
  const spec: EmbeddingSpec = { model: embedder.model, dims: embedder.dims, usdPerMillionTokens: embedder.usdPerMillionTokens };

  return withGenerationLock(db, generationId, () =>
    withBuildLock(db, buildId, async () => {
      const blocking = await blockingAttempts(db.$client, alias);
      if (blocking.length > 0) throw new UnresolvedAliasError(blockedMessage(alias, blocking));
      await recordBuild(db, { indexName: index, alias, buildId, generationId });

      let pinned = false;
      let submitted = false;
      try {
        await pinIndexableGeneration(db, generationId, pinReason);
        pinned = true;
        await opts.afterPin?.();
        const plan = await planPassages(db, {
          generationId,
          embedding: spec,
          batchSize: opts.batchSize,
          log,
          ...(opts.mapRecord ? { mapRecord: opts.mapRecord } : {}),
        });
        if (plan.passages === 0) throw new GenerationNotIndexableError(generationId, 'it has no answer-eligible US passages');
        if (cacheOnly) {
          if (!plan.cache.available || plan.toEmbed.inputs > 0) throw new CacheIncompleteError(plan);
        } else {
          if (!opts.confirmCost) throw new CostNotConfirmedError(plan);
          const remaining = await opts.gate.remainingUsd('indexing');
          if (plan.reservationUsd > remaining) {
            throw new SpendRefusedError(
              `the build reserves up to $${plan.reservationUsd.toFixed(6)} but $${remaining.toFixed(6)} of the indexing budget is left`,
            );
          }
        }
        const sets = await loadEventAircraftSets(db, generationId);
        const fingerprint = passagesIndexFingerprint(embedder.model);

        await es.indices.create({
          index,
          settings: { ...PASSAGES_SETTINGS, refresh_interval: '-1' },
          mappings: {
            ...PASSAGES_MAPPING,
            _meta: {
              index_version: PASSAGES_INDEX_VERSION,
              fingerprint,
              generation_id: generationId,
              build_id: buildId,
              chunker_version: CHUNKER_VERSION,
              input_template_version: EMBEDDING_INPUT_TEMPLATE_VERSION,
              embedding_model: embedder.model,
              embedding_dims: embedder.dims,
            },
          },
        });
        log(`created ${index}`);

        const want: Expected = { passages: 0, byKindScope: new Map(), eventScoped: 0, nestedAircraft: 0, eventAircraft: 0 };
        const embedded = { inputs: 0, tokens: 0, requests: 0, usd: 0 };
        let cacheHits = 0;
        let deduplicated = 0;
        let alreadyStored = 0;
        const windowSize = opts.windowSize ?? 480;
        const maxBulkBytes = opts.maxBulkBytes ?? 8 * 1024 * 1024;
        /** Every input key met in this build. */
        const seen = new Set<string>();
        /** Passages waiting for the vector of their input, by cache key. */
        const pending = new Map<string, { input: string; tokens: number; passages: CasePassage[] }>();
        /** Cache misses in first-seen order, not yet embedded. */
        const misses: string[] = [];
        let ready: PassageDoc[] = [];
        let readyBytes = 0;
        let window: CasePassage[] = [];

        const flushDocs = async (force: boolean) => {
          if (ready.length === 0 || (!force && readyBytes < maxBulkBytes)) return;
          await bulkCreate(es, index, ready, log);
          ready = [];
          readyBytes = 0;
        };
        const resolve = async (key: string, vector: Float32Array) => {
          const entry = pending.get(key);
          if (!entry) return;
          pending.delete(key);
          for (const p of entry.passages) {
            const doc = buildPassageDocument(p, vector, sets);
            ready.push(doc);
            readyBytes += Buffer.byteLength(JSON.stringify(doc));
            await flushDocs(false);
          }
        };
        const embedMisses = async (all: boolean) => {
          // Requests have the plan's boundaries: until the end only closed batches go (every
          // batch but the last, which goes once it is full).
          const batches = batchByLimits(misses, (k) => (pending.get(k) as { tokens: number }).tokens);
          for (const [i, batch] of batches.entries()) {
            if (!all && i === batches.length - 1 && batch.length < EMBEDDING_LIMITS.maxInputs) break;
            const inputs = batch.map((k) => (pending.get(k) as { input: string }).input);
            const res = await embedder.embed(inputs);
            embedded.inputs += batch.length;
            embedded.tokens += res.tokens;
            embedded.requests += 1;
            embedded.usd += embeddingUsd(res.tokens, embedder.usdPerMillionTokens);
            await storeEmbeddings(
              db,
              batch.map((key, j) => ({ key, vector: res.vectors[j] as Float32Array })),
              embedder.model,
              embedder.dims,
              EMBEDDING_INPUT_TEMPLATE_VERSION,
            );
            misses.splice(0, batch.length);
            for (const [j, key] of batch.entries()) await resolve(key, res.vectors[j] as Float32Array);
            log(`embedded ${embedded.inputs}/${plan.toEmbed.inputs} inputs (${embedded.tokens} tokens)`);
          }
        };
        const processWindow = async () => {
          if (window.length === 0) return;
          alreadyStored += await storePassages(db, generationId, window);
          /** Keys met for the first time in this build: cache hits or misses. */
          const fresh: string[] = [];
          /** Keys met before whose vector was already released: read back from the cache. */
          const again: string[] = [];
          for (const p of window) {
            const key = cacheKeyOf(p, spec);
            want.passages += 1;
            want.byKindScope.set(`${p.kind}/${p.scope}`, (want.byKindScope.get(`${p.kind}/${p.scope}`) ?? 0) + 1);
            if (p.aircraftSpecific) want.nestedAircraft += p.aircraft.length;
            else {
              want.eventScoped += 1;
              want.eventAircraft += eventAircraftCount(p, sets) ?? 0;
            }
            const entry = pending.get(key);
            if (seen.has(key)) deduplicated += 1;
            if (entry) {
              entry.passages.push(p);
              continue;
            }
            pending.set(key, { input: p.input, tokens: p.inputTokens, passages: [p] });
            if (seen.has(key)) again.push(key);
            else {
              seen.add(key);
              fresh.push(key);
            }
          }
          window = [];
          const hits = await lookupEmbeddings(db, [...fresh, ...again], embedder.model, embedder.dims);
          for (const key of again) {
            const v = hits.get(key);
            if (!v) throw new Error(`embedding ${key} was cached by this build but is missing`);
            await resolve(key, v);
          }
          for (const key of fresh) {
            const v = hits.get(key);
            if (v) {
              cacheHits += 1;
              await resolve(key, v);
            } else misses.push(key);
          }
          await embedMisses(false);
        };

        for await (const r of streamCaseRecords(db, generationId, { batchSize: opts.batchSize ?? 200 })) {
          if (!r.answerEligible) continue;
          window.push(...recordPassages(r, opts.mapRecord).passages);
          if (window.length >= windowSize) await processWindow();
        }
        await processWindow();
        await embedMisses(true);
        if (pending.size > 0) throw new Error(`${pending.size} passage input(s) left without a vector`);
        await flushDocs(true);

        const [stored] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(passagesTable)
          .where(and(eq(passagesTable.generationId, generationId), eq(passagesTable.chunkerVersion, CHUNKER_VERSION)));
        if ((stored?.n ?? -1) !== want.passages || want.passages !== plan.passages) {
          throw new Error(
            `passages of generation ${generationId}: planned ${plan.passages}, built ${want.passages}, stored ${stored?.n ?? 'none'}`,
          );
        }
        await es.indices.putSettings({ index, settings: { refresh_interval: '1s' } });
        await es.indices.refresh({ index });
        await verifyIndex(es, index, want);

        let switched;
        try {
          switched = await switchAlias(es, db, alias, index, {
            ...opts.alias,
            buildId,
            beforeSwitch: (client) => assertPinned(client, generationId, pinReason),
          });
        } catch (err) {
          if (!(err instanceof AliasSwitchError && err.outcome === 'not_submitted')) submitted = true;
          throw err;
        }
        submitted = true;
        log(`alias ${alias} -> ${index}${switched.previous.length ? ` (was ${switched.previous.join(', ')})` : ''}`);
        if (!switched.verified) log(`alias ${alias}: switch committed but could not be read back`);
        return {
          index,
          alias,
          buildId,
          attemptId: switched.attemptId,
          previousIndices: switched.previous,
          aliasVerified: switched.verified,
          generationId,
          version: PASSAGES_INDEX_VERSION,
          fingerprint,
          model: embedder.model,
          dims: embedder.dims,
          passages: want.passages,
          passagesAlreadyStored: alreadyStored,
          cacheHits,
          deduplicated,
          cacheOnly,
          embedded,
          plan,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        if (!submitted) {
          // Never part of an alias request: the only index a build deletes on its own.
          await deleteUnsubmittedIndex(es, db.$client, index).catch((e: unknown) => log(`cleanup of ${index} failed: ${String(e)}`));
        }
        throw err;
      } finally {
        if (pinned) await unpin(db, generationId, pinReason, log);
      }
    }),
  );
}
