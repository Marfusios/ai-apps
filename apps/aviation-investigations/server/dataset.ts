/**
 * The dataset a request is served from (amendment A6). Every API request resolves
 * the active `dataset_manifests` row once and uses that generation and those index
 * names for everything it reads: the API never reads the index alias.
 *
 * Facts derived from a manifest are computed once per manifest and cached:
 * - `revision`: `g<generation>-<index version>-<8 hex of the index names>`, part of
 *   every ETag and cache key, so it changes with the generation, the mapping version
 *   and any re-publication with other indices;
 * - `snapshotDate`: the newest source record change (`lchg_date`) in the generation,
 *   i.e. the date the snapshot's data is current to (the archive's own date is not
 *   recorded);
 * - the cases index `_meta`, checked against the manifest: same generation, and an
 *   index version and mapping fingerprint this code serves (the current version, or
 *   an earlier one with the same fields: `isServableCasesIndex`). A mismatch makes the
 *   API unavailable (503) instead of serving another generation's data;
 * - the coverage numbers of `GET /api/config` and the corpus year range;
 *
 * Whether the manifest's passages index can serve AI evidence is cached apart from
 * those facts: the passages contract (`server/search/passages-contract.ts`) for the
 * configured embedding model and dimensions.
 * - The check is bounded (`passagesCheckTimeoutMs`) and never fails the dataset: any
 *   failure only marks the passages unservable, with a log line. Keyword search, case
 *   pages and the dashboard keep working; AI routes must stay off (retrieval checks
 *   the same contract again before every use).
 * - A definitive answer (servable, keyword-only, no embedding configured, an index that
 *   breaks the contract or does not exist) is kept until the manifest changes.
 * - A transient failure (timeout, transport error, 5xx) is kept for
 *   `passagesRetryMs` (default 30 s) and then checked again, so one Elasticsearch blip
 *   does not turn AI evidence off until the next publication.
 * - Concurrent callers share one check. The first check of a manifest is awaited
 *   (bounded); a later re-check runs in the background while callers get the last
 *   status (stale-while-revalidate), so no request waits for it.
 * - `reason` is a fixed category (`passagesCheckFailure`: `timeout`, `transport`,
 *   `http_<status>`, `incompatible:<fields>`, …), never upstream text, so it is safe
 *   in logs; responses should still only carry `code`.
 */
import { createHash } from 'node:crypto';
import type { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import type { Coverage } from '../shared/contracts/config.js';
import type { Dataset } from '../shared/contracts/common.js';
import { SERVABLE_CASES_VERSIONS, isServableCasesIndex } from '../worker/index/cases-index.js';
import type { Db } from './db/client.js';
import { getActiveManifest, type ActiveManifest } from './db/generations.js';
import { IndexMetaError, readIndexMeta } from './search/index-meta.js';
import {
  PassagesCheckTimeoutError,
  checkPassagesIndex,
  isDefinitivePassagesFailure,
  passagesCheckFailure,
} from './search/passages-contract.js';

export class DatasetUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetUnavailableError';
  }
}

export interface PinnedDataset {
  manifest: ActiveManifest;
  dataset: Dataset;
  indexVersion: string;
  fieldNormalizationVersion: string;
  coverage: Coverage;
  /** First and last event year of the US events (the Explore and dashboard year axis). */
  years: { from: number; to: number };
  /** The manifest's passages index and whether it meets the passages contract; null when keyword-only. */
  passages: PassagesStatus | null;
}

/**
 * Why a passages index is not servable, as a fixed code: `not_configured` (no
 * embedding model), `incompatible` (it breaks the contract or does not exist; until
 * the manifest changes) or `unavailable` (a transient failure; checked again later).
 */
export type PassagesUnservableCode = 'not_configured' | 'incompatible' | 'unavailable';

export type PassagesStatus =
  | { index: string; servable: true }
  /** `reason`: a fixed failure category (`passagesCheckFailure`), never an upstream message. */
  | { index: string; servable: false; code: PassagesUnservableCode; reason: string };

type KeywordFacts = Omit<PinnedDataset, 'passages'>;

/** The passages status of one manifest: its last answer and any check in flight. */
interface PassagesEntry {
  key: string;
  settled: { status: PassagesStatus | null; until: number } | null;
  inflight: Promise<PassagesStatus | null> | null;
}

export interface DatasetResolverOptions {
  /** How long the active manifest row is reused before it is read again (default 5 s). */
  manifestTtlMs?: number;
  now?: () => number;
  /** The configured embedding model and dimensions; without them no passages index is servable. */
  embedding?: { model: string; dims: number };
  /** Bound of the passages contract read (default 2 s). */
  passagesCheckTimeoutMs?: number;
  /** How long a transient passages failure is kept before the index is checked again (default 30 s). */
  passagesRetryMs?: number;
  /** Told why a published passages index is not servable (a code and a fixed category). */
  onPassagesUnservable?: (index: string, code: PassagesUnservableCode, reason: string) => void;
}

function revisionOf(m: ActiveManifest, indexVersion: string): string {
  const names = createHash('sha256').update(`${m.casesIndex}\n${m.passagesIndex ?? ''}`).digest('hex').slice(0, 8);
  return `g${m.generationId}-${indexVersion}-${names}`;
}

const manifestKey = (m: ActiveManifest): string =>
  `${m.generationId}|${m.casesIndex}|${m.passagesIndex ?? ''}|${m.publishedAt.toISOString()}`;

export class DatasetResolver {
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly embedding: { model: string; dims: number } | undefined;
  private readonly passagesCheckTimeoutMs: number;
  private readonly passagesRetryMs: number;
  private readonly onPassagesUnservable: (index: string, code: PassagesUnservableCode, reason: string) => void;
  private manifest: { value: ActiveManifest; at: number } | null = null;
  private manifestLoad: Promise<ActiveManifest | null> | null = null;
  private readonly facts = new Map<string, Promise<KeywordFacts>>();
  private passagesEntry: PassagesEntry | null = null;

  constructor(
    private readonly db: Db,
    private readonly es: Client,
    opts: DatasetResolverOptions = {},
  ) {
    this.ttl = opts.manifestTtlMs ?? 5_000;
    this.now = opts.now ?? Date.now;
    this.embedding = opts.embedding;
    this.passagesCheckTimeoutMs = opts.passagesCheckTimeoutMs ?? 2_000;
    this.passagesRetryMs = opts.passagesRetryMs ?? 30_000;
    this.onPassagesUnservable = opts.onPassagesUnservable ?? (() => undefined);
  }

  /** The dataset of the active manifest. Throws `DatasetUnavailableError` when none can be served. */
  async current(): Promise<PinnedDataset> {
    const manifest = await this.activeManifest();
    if (!manifest) throw new DatasetUnavailableError('no dataset manifest is active');
    const key = manifestKey(manifest);
    let facts = this.facts.get(key);
    if (!facts) {
      facts = this.load(manifest);
      // Only the current manifest's facts are kept; a failed load is retried next time.
      this.facts.clear();
      this.facts.set(key, facts);
      facts.catch(() => {
        if (this.facts.get(key) === facts) this.facts.delete(key);
      });
    }
    const [keyword, passages] = await Promise.all([facts, this.passagesFor(manifest)]);
    return { ...keyword, passages };
  }

  /**
   * The manifest's passages status (module comment): the cached answer while it is
   * valid; after a transient failure expires, the last answer while one shared
   * background re-check runs; for a new manifest, one shared first check.
   */
  private passagesFor(manifest: ActiveManifest): Promise<PassagesStatus | null> {
    const key = manifestKey(manifest);
    if (this.passagesEntry?.key !== key) this.passagesEntry = { key, settled: null, inflight: null };
    const entry = this.passagesEntry;
    if (entry.settled) {
      if (this.now() >= entry.settled.until) {
        entry.inflight ??= this.checkPassages(entry, manifest);
        // Nobody awaits a background re-check; a rejection must not go unhandled.
        entry.inflight.catch(() => {});
      }
      return Promise.resolve(entry.settled.status);
    }
    entry.inflight ??= this.checkPassages(entry, manifest);
    return entry.inflight;
  }

  private checkPassages(entry: PassagesEntry, manifest: ActiveManifest): Promise<PassagesStatus | null> {
    const check = this.passagesStatus(manifest).then(({ status, transient }) => {
      entry.settled = { status, until: transient ? this.now() + this.passagesRetryMs : Number.POSITIVE_INFINITY };
      return status;
    });
    const done = check.finally(() => {
      if (entry.inflight === done) entry.inflight = null;
    });
    return done;
  }

  /** The active manifest row (PostgreSQL only, reused for `manifestTtlMs`), or null before the first publish. */
  async activeManifest(): Promise<ActiveManifest | null> {
    const cached = this.manifest;
    if (cached && this.now() - cached.at < this.ttl) return cached.value;
    this.manifestLoad ??= getActiveManifest(this.db).finally(() => {
      this.manifestLoad = null;
    });
    const value = await this.manifestLoad;
    // A missing manifest is not cached: the first publication is seen at once.
    this.manifest = value ? { value, at: this.now() } : null;
    return value;
  }

  private async load(manifest: ActiveManifest): Promise<KeywordFacts> {
    const meta = await readIndexMeta(this.es, manifest.casesIndex).catch((err: unknown) => {
      throw err instanceof IndexMetaError ? new DatasetUnavailableError(`the active cases index cannot be read: ${err.message}`) : err;
    });
    if (meta.generationId !== manifest.generationId) {
      throw new DatasetUnavailableError(`the active cases index was built for generation ${meta.generationId ?? 'unknown'}`);
    }
    if (meta.indexVersion === null || !isServableCasesIndex(meta.indexVersion, meta.fingerprint)) {
      throw new DatasetUnavailableError(
        `the active cases index is ${meta.indexVersion ?? 'unversioned'} with fingerprint ${meta.fingerprint ?? 'none'}; this server reads ${SERVABLE_CASES_VERSIONS.join(' or ')}`,
      );
    }
    const g = manifest.generationId;
    const rows = (
      await this.db.execute(sql`
        select greatest(
                 (select max(greatest(last_changed_at, admin_last_changed_at)) from cases where generation_id = ${g}),
                 (select max(last_changed_at) from case_sections where generation_id = ${g})
               )::date::text as changed,
               (select field_normalization_version from dataset_generations where id = ${g}) as field_version,
               (select (extract_manifest ->> 'startedAt') from dataset_generations where id = ${g}) as extracted`)
    ).rows[0] as { changed: string | null; field_version: string | null; extracted: string | null } | undefined;
    if (!rows?.field_version) throw new DatasetUnavailableError(`generation ${g} is missing`);
    const extracted = rows.extracted && /^\d{4}-\d{2}-\d{2}/.test(rows.extracted) ? rows.extracted.slice(0, 10) : null;
    // Never later than the extraction (a source date in the future would be an error).
    const changed = rows.changed && extracted && rows.changed > extracted ? extracted : rows.changed;
    const snapshotDate = changed ?? extracted;
    if (!snapshotDate) throw new DatasetUnavailableError(`generation ${g} has no snapshot date`);

    const stats = await this.es.search({
      index: manifest.casesIndex,
      size: 0,
      track_total_hits: true,
      query: { term: { country: 'USA' } },
      aggs: {
        cohort: { filter: { term: { completed_with_cause: true } } },
        first: { min: { field: 'ev_year' } },
        last: { max: { field: 'ev_year' } },
      },
    });
    const total = typeof stats.hits.total === 'number' ? stats.hits.total : (stats.hits.total?.value ?? 0);
    const aggs = stats.aggregations as
      | { cohort: { doc_count: number }; first: { value: number | null }; last: { value: number | null } }
      | undefined;
    const from = aggs?.first.value;
    const to = aggs?.last.value;
    if (!aggs || total === 0 || typeof from !== 'number' || typeof to !== 'number') {
      throw new DatasetUnavailableError('the active cases index is empty');
    }
    const indexVersion = meta.indexVersion;
    return {
      manifest,
      dataset: { revision: revisionOf(manifest, indexVersion), snapshotDate },
      indexVersion,
      fieldNormalizationVersion: rows.field_version,
      coverage: {
        defaultCohort: aggs.cohort.doc_count,
        otherRecords: total - aggs.cohort.doc_count,
        yearFrom: from,
        yearTo: to,
        provisional: !manifest.mappingVerified,
      },
      years: { from, to },
    };
  }

  /**
   * Whether the manifest's passages index meets the contract, and whether a negative
   * answer is transient. Never throws: an incompatible or missing index, an
   * Elasticsearch error or a timeout all give `servable: false`, reported to
   * `onPassagesUnservable`.
   */
  private async passagesStatus(manifest: ActiveManifest): Promise<{ status: PassagesStatus | null; transient: boolean }> {
    const index = manifest.passagesIndex;
    if (index === null) return { status: null, transient: false };
    const unservable = (code: PassagesUnservableCode, reason: string) => {
      try {
        this.onPassagesUnservable(index, code, reason);
      } catch {
        // A failing log hook must not fail the dataset.
      }
      return { status: { index, servable: false as const, code, reason }, transient: code === 'unavailable' };
    };
    if (!this.embedding) return unservable('not_configured', 'embedding_not_configured');
    const ms = this.passagesCheckTimeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The timer bounds the check even if the client ignores the abort signal.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PassagesCheckTimeoutError(ms));
      }, ms);
    });
    try {
      await Promise.race([
        checkPassagesIndex(this.es, index, { generationId: manifest.generationId, ...this.embedding }, { timeoutMs: ms, signal: controller.signal }),
        deadline,
      ]);
      return { status: { index, servable: true }, transient: false };
    } catch (err) {
      // A fixed category only: no upstream message, body or cause is stored or logged.
      return unservable(isDefinitivePassagesFailure(err) ? 'incompatible' : 'unavailable', passagesCheckFailure(err));
    } finally {
      clearTimeout(timer);
    }
  }
}
