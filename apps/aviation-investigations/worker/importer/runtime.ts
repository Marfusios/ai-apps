/** Explicit production effects and an isolated-test seam; none are configurable by source or CLI data. */
import type { Client } from '@elastic/elasticsearch';
import type { Db } from '../../server/db/client.js';
import type { AppConfig } from '../../shared/config.js';
import { loadFromExtract } from '../ingest/load.js';
import { verifyCorpus } from '../ingest/verify.js';
import { rebuildCasesIndex } from '../index/cases-index.js';
import { rebuildPassagesIndex, planPassages } from '../index/passages-index.js';
import { createOpenAIEmbedder } from '../index/embed.js';
import type { SpendGate } from '../index/spend-gate.js';
import {
  applicationAvailable,
  applicationProbe,
  deployedImage,
  propagate,
  workerIdentity,
} from './application.js';
import { verifyBaseline } from './baseline.js';
import { providerKey, type ImporterConfig } from './config.js';
import { extractSnapshot, readSnapshot, type ExtractedSnapshot } from './extraction.js';
import { ManagedSpace } from './files.js';
import { runCanary, probeCandidate } from './probes.js';
import { retainDatabase, retainFiles } from './retention.js';
import { type SnapshotSource } from './source.js';
import type { HostFacts } from './facts.js';
import type {
  AcceptedSnapshot,
  Artifact,
  Certificate,
  ImportSession,
  PendingFetch,
} from './store.js';
import type { Comparison } from './compare.js';
import type { ImportStep, ManifestIdentity, SourceObservation } from './contracts.js';

export interface RunOptions {
  environment: 'dev' | 'live';
  noChange?: boolean;
  forcedDev?: boolean;
  recertify?: boolean;
  cacheOnly: boolean;
  seed?: { path: string; sha256: string; observation: SourceObservation };
}
export interface RunReport {
  result: 'unchanged' | 'published';
  reason: 'same_archive' | 'same_content' | 'metadata_unchanged' | null;
  archive: string;
  content: string;
  generationId: number;
  elapsedMs: number;
  peakBytes: number;
  remoteRefreshOwed: boolean;
  cacheMisses: number;
  reservationUsd: number;
  chargedUsd: number;
}
export type FaultPoint =
  | 'fetched'
  | 'extracted'
  | 'registered'
  | 'loaded'
  | 'cases_built'
  | 'passages_built'
  | 'published'
  | 'accepted'
  | 'before_report';
export const productionEffects = {
  verifyBaseline,
  extractSnapshot,
  readSnapshot,
  loadFromExtract,
  verifyCorpus,
  planPassages,
  rebuildCasesIndex,
  rebuildPassagesIndex,
  probeCandidate,
  applicationAvailable,
  applicationProbe,
  deployedImage,
  propagate,
  runCanary,
  workerIdentity,
  retainDatabase,
  retainFiles,
  now: () => new Date(),
  fault: async (_point: FaultPoint): Promise<void> => {},
  paidEmbedder(
    config: ImporterConfig,
    environment: 'dev' | 'live',
    embedding: { model: string; dims: number },
    gate: SpendGate,
    id: string,
  ) {
    return createOpenAIEmbedder({
      apiKey: providerKey(config, environment),
      ...embedding,
      gate,
      purpose: `import:${id}`,
      log: () => {},
    });
  },
};
export type ImportEffects = typeof productionEffects;
export interface ImportResources {
  db: Db;
  es: Client;
  appConfig: AppConfig;
  space: ManagedSpace;
  source: SnapshotSource;
  hostFacts: HostFacts;
}
export interface ImportContext extends ImportResources {
  config: ImporterConfig;
  options: RunOptions;
  effects: ImportEffects;
  started: number;
  reports: string;
  session: ImportSession;
  runId: string;
  step: ImportStep;
  blocked: boolean;
  sourceChecked: boolean;
  artifact: Artifact | null;
  pending: PendingFetch | null;
  accepted: AcceptedSnapshot;
  baseline: ExtractedSnapshot;
  candidate: ExtractedSnapshot;
  observation: SourceObservation;
  current: ManifestIdentity;
  comparison: Comparison;
  approvedReasons: string[];
  generation: number;
  genericReport: string;
  plan: Awaited<ReturnType<typeof planPassages>>;
  embedding: { model: string; dims: number; usdPerMillionTokens: number };
  gate: SpendGate;
  cases: { index: string; buildId: string };
  passages: { index: string; buildId: string };
  certificate: Certificate;
  publication: ManifestIdentity;
}
