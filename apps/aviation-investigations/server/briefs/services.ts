/**
 * What the brief routes need beyond the AI runtime: the evidence ports, the stage
 * timeouts and the registry of running steps (their cancel controllers), built once in
 * server/main.ts (`AppDeps.briefs`, with the hybrid retriever of
 * server/briefs/retriever.ts). Without services (no query embedder) AI briefs report
 * unavailable.
 */
import { DatasetUnavailableError, type PinnedDataset } from '../dataset.js';
import type { Db } from '../db/client.js';
import { createCaseCatalog } from './catalog.js';
import type { CaseCatalog, EvidenceDataset, EvidenceRetriever } from './evidence.js';
import type { StageTimeouts, StepOutcome } from './pipeline.js';

export interface BriefServicesOptions {
  retriever: EvidenceRetriever;
  /** Default: the PostgreSQL catalog (server/briefs/catalog.ts). */
  catalog?: CaseCatalog;
  timeouts?: Partial<StageTimeouts>;
}

export interface RunningStep {
  controller: AbortController;
  done: Promise<StepOutcome>;
}

export interface BriefServices {
  retriever: EvidenceRetriever;
  catalog: CaseCatalog;
  timeouts: Partial<StageTimeouts>;
  /** Steps running in this process, by step id. */
  runs: Map<string, RunningStep>;
  /** Resolves when every step running now has finished (tests and shutdown). */
  settled(): Promise<void>;
}

export function createBriefServices(db: Db, opts: BriefServicesOptions): BriefServices {
  const runs = new Map<string, RunningStep>();
  return {
    retriever: opts.retriever,
    catalog: opts.catalog ?? createCaseCatalog(db),
    timeouts: opts.timeouts ?? {},
    runs,
    async settled() {
      while (runs.size > 0) await Promise.allSettled([...runs.values()].map((r) => r.done));
    },
  };
}

/**
 * The evidence dataset AI would use now, or null (AI unavailable): the active
 * manifest's passages index, only when the dataset resolver reports it servable
 * (server/dataset.ts: the passages contract for the configured embedding, with
 * transient failures checked again) and the retriever accepts it too. A dataset that
 * cannot be served at all (`DatasetUnavailableError`) is null as well; why is never
 * passed on, so no index name or contract value reaches a client.
 */
export async function servableEvidence(
  services: BriefServices | null,
  current: () => Promise<Pick<PinnedDataset, 'manifest' | 'passages'>>,
): Promise<EvidenceDataset | null> {
  if (!services) return null;
  let pinned: Pick<PinnedDataset, 'manifest' | 'passages'>;
  try {
    pinned = await current();
  } catch (err) {
    if (err instanceof DatasetUnavailableError) return null;
    throw err;
  }
  const passages = pinned.passages;
  if (!passages?.servable) return null;
  const dataset = { generationId: pinned.manifest.generationId, passagesIndex: passages.index };
  return (await services.retriever.available(dataset)) ? dataset : null;
}
