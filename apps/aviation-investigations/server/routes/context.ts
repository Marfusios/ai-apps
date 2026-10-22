/** What the API routes share: connections, the dataset resolver and the caches. */
import type { Client } from '@elastic/elasticsearch';
import type { FastifyBaseLogger } from 'fastify';
import type { FacetKey } from '../../shared/contracts/search.js';
import type { AiRuntime } from '../ai/runtime.js';
import type { BriefServices } from '../briefs/services.js';
import type { EvidenceDataset } from '../briefs/evidence.js';
import type { DatasetResolver } from '../dataset.js';
import type { Db } from '../db/client.js';

export interface ApiContext {
  db: Db;
  es: Client;
  datasets: DatasetResolver;
  log: FastifyBaseLogger;
  /** AI startup check, quota policy, trial identities, the anonymous gate and the provider; null: AI is off. */
  ai: AiRuntime | null;
  /** Evidence retrieval and the brief runs; null without a query embedder: AI briefs are off. */
  briefs: BriefServices | null;
  /**
   * The passages index AI evidence would come from right now (the active manifest's,
   * when the dataset reports it servable and the retriever accepts it), or null: AI is
   * unavailable (`paused`/`dependency`, and 503 `unavailable` for brief requests).
   */
  aiEvidence: () => Promise<EvidenceDataset | null>;
  onUnknownFacetValue: (facet: FacetKey, value: string) => void;
}

/** `Cache-Control` of public, dataset-bound responses (config, case pages, dashboard). */
export const PUBLIC_CACHE = 'public, max-age=300';

/**
 * Search responses: a short public cache keyed by the full URL (the canonical query
 * string). A new manifest is visible to cached searches within a minute.
 */
export const SEARCH_CACHE = 'public, max-age=60';
