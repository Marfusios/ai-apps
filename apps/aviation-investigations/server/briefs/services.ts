/**
 * What the brief routes need beyond the AI runtime: the evidence ports, the stage
 * timeouts and the registry of running steps (their cancel controllers), built once in
 * server/app.ts from `AppDeps.briefs`. Without a retriever (phase 1 of Task 16, until
 * retrieval is bound) there are no services and AI briefs report unavailable.
 */
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

/** The evidence dataset of the active manifest when the retriever accepts it. */
export async function manifestEvidence(
  services: BriefServices | null,
  activeManifest: () => Promise<{ generationId: number; passagesIndex: string | null } | null>,
): Promise<EvidenceDataset | null> {
  if (!services) return null;
  const m = await activeManifest();
  if (!m?.passagesIndex) return null;
  const dataset = { generationId: m.generationId, passagesIndex: m.passagesIndex };
  return (await services.retriever.available(dataset)) ? dataset : null;
}
