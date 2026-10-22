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
 * - whether the manifest's passages index can serve AI evidence: the passages
 *   contract (`server/search/passages-contract.ts`) for the configured embedding model
 *   and dimensions. The check is bounded (`passagesCheckTimeoutMs`) and any failure,
 *   an Elasticsearch error or a timeout included, only marks the passages unservable
 *   with a log line: keyword search, case pages and the dashboard keep working, and
 *   AI routes must stay off (retrieval checks the same contract again before every use).
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
import { PassagesIndexIncompatibleError, checkPassagesIndex } from './search/passages-contract.js';

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

export type PassagesStatus = { index: string; servable: true } | { index: string; servable: false; reason: string };

export interface DatasetResolverOptions {
  /** How long the active manifest row is reused before it is read again (default 5 s). */
  manifestTtlMs?: number;
  now?: () => number;
  /** The configured embedding model and dimensions; without them no passages index is servable. */
  embedding?: { model: string; dims: number };
  /** Bound of the passages contract read (default 5 s). */
  passagesCheckTimeoutMs?: number;
  /** Told why a published passages index is not servable (no values beyond index name and reason). */
  onPassagesUnservable?: (index: string, reason: string) => void;
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
  private readonly onPassagesUnservable: (index: string, reason: string) => void;
  private manifest: { value: ActiveManifest; at: number } | null = null;
  private manifestLoad: Promise<ActiveManifest | null> | null = null;
  private readonly facts = new Map<string, Promise<PinnedDataset>>();

  constructor(
    private readonly db: Db,
    private readonly es: Client,
    opts: DatasetResolverOptions = {},
  ) {
    this.ttl = opts.manifestTtlMs ?? 5_000;
    this.now = opts.now ?? Date.now;
    this.embedding = opts.embedding;
    this.passagesCheckTimeoutMs = opts.passagesCheckTimeoutMs ?? 5_000;
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
    return facts;
  }

  private async activeManifest(): Promise<ActiveManifest | null> {
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

  private async load(manifest: ActiveManifest): Promise<PinnedDataset> {
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
    const passages = await this.passagesStatus(manifest);
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
      passages,
    };
  }

  /**
   * Whether the manifest's passages index meets the contract. Never throws: an
   * incompatible index, a missing one, an Elasticsearch error or a timeout all give
   * `servable: false` with a reason, reported to `onPassagesUnservable`.
   */
  private async passagesStatus(manifest: ActiveManifest): Promise<PassagesStatus | null> {
    const index = manifest.passagesIndex;
    if (index === null) return null;
    const unservable = (reason: string): PassagesStatus => {
      this.onPassagesUnservable(index, reason);
      return { index, servable: false, reason };
    };
    if (!this.embedding) return unservable('no embedding model is configured');
    const ms = this.passagesCheckTimeoutMs;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The timer bounds the check even if the client ignores the abort signal.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`the passages index check timed out after ${ms} ms`));
      }, ms);
    });
    try {
      await Promise.race([
        checkPassagesIndex(this.es, index, { generationId: manifest.generationId, ...this.embedding }, { timeoutMs: ms, signal: controller.signal }),
        deadline,
      ]);
      return { index, servable: true };
    } catch (err) {
      if (err instanceof PassagesIndexIncompatibleError) return unservable(err.problems.join('; '));
      if (err instanceof IndexMetaError) return unservable(err.message);
      const name = err instanceof Error ? err.name : 'Error';
      const message = err instanceof Error ? err.message : String(err);
      return unservable(`the passages index could not be checked (${name}: ${message.slice(0, 200)})`);
    } finally {
      clearTimeout(timer);
    }
  }
}
