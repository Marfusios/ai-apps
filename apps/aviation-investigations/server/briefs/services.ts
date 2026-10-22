/**
 * What the brief routes need beyond the AI runtime: the evidence ports, the stage
 * timeouts, the registry of running steps (their cancel controllers) and the shutdown
 * state, built once in server/main.ts (`AppDeps.briefs`, with the hybrid retriever of
 * server/briefs/retriever.ts). Without services (no query embedder) AI briefs report
 * unavailable.
 *
 * Shutdown (server/app.ts `preClose`) aborts `shutdown` once: every running step stops,
 * a step started later stops before its first provider call (it releases its quota and
 * settles at zero), and the paid routes refuse new work (503 `unavailable`) at each
 * point before admission and before a step exists. Paid requests run as `track`ed work,
 * so closing waits for the ones still in the gate, admission or step creation as well as
 * for the running steps (`settled`, bounded by the caller).
 */
import { DatasetUnavailableError, type PinnedDataset } from '../dataset.js';
import type { Db } from '../db/client.js';
import { createCaseCatalog } from './catalog.js';
import type { CaseCatalog, EvidenceDataset, EvidenceRetriever } from './evidence.js';
import { SHUTDOWN_REASON, type StageTimeouts, type StepOutcome } from './pipeline.js';

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
  /** Aborted with `SHUTDOWN_REASON` once the server begins closing; every step runs under it. */
  readonly shutdown: AbortSignal;
  /** Begin shutdown: stop running steps and refuse new paid work (idempotent). */
  beginShutdown(): void;
  /** Run a paid request's handler as tracked work: `settled` waits for it too. */
  track<T>(work: () => Promise<T>): Promise<T>;
  /** Resolves when every step and tracked request running now has finished (tests and shutdown). */
  settled(): Promise<void>;
}

export function createBriefServices(db: Db, opts: BriefServicesOptions): BriefServices {
  const runs = new Map<string, RunningStep>();
  const pending = new Set<Promise<unknown>>();
  const shutdown = new AbortController();
  return {
    retriever: opts.retriever,
    catalog: opts.catalog ?? createCaseCatalog(db),
    timeouts: opts.timeouts ?? {},
    runs,
    shutdown: shutdown.signal,
    beginShutdown() {
      if (!shutdown.signal.aborted) shutdown.abort(SHUTDOWN_REASON);
    },
    track<T>(work: () => Promise<T>): Promise<T> {
      const p = work();
      pending.add(p);
      const done = () => void pending.delete(p);
      p.then(done, done);
      return p;
    },
    async settled() {
      while (runs.size > 0 || pending.size > 0) {
        await Promise.allSettled([...[...runs.values()].map((r) => r.done), ...pending]);
      }
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
