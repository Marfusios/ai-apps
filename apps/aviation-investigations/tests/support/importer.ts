/** Real isolated PostgreSQL/Elasticsearch fixture; only source extraction, app HTTP and provider transport are offline. */
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { vi } from 'vitest';
import { withScratchEnvironment, localAdminUrl } from '../../scripts/scratch-env.js';
import { runMigrations } from '../../server/db/migrate.js';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { testConfig, testEs } from '../integration/helpers.js';
import {
  makeCombinedExtractDir,
  writeCsv,
  writeManifest,
  editTable,
} from './extract-dir.js';
import { TABLE_NAMES } from '../../worker/ingest/tables.js';
import { loadFromExtract } from '../../worker/ingest/load.js';
import { verifyCorpus } from '../../worker/ingest/verify.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import { rebuildPassagesIndex } from '../../worker/index/passages-index.js';
import { publishGeneration } from '../../worker/index/publish.js';
import { createFakeEmbedder } from '../../worker/index/embed.js';
import { createMemorySpendGate } from '../../worker/index/spend-gate.js';
import {
  ManagedSpace,
  FILE_LIMITS,
  hashExtraction,
  privateDirectory,
} from '../../worker/importer/files.js';
import {
  readSnapshot,
  type ExtractedSnapshot,
} from '../../worker/importer/extraction.js';
import { certificationClient, validateRecord } from '../../worker/importer/strict-es.js';
import { runWithResources } from '../../worker/importer/run.js';
import { runCanary } from '../../worker/importer/probes.js';
import {
  manifest,
  withImportSession,
  type AcceptedSnapshot,
} from '../../worker/importer/store.js';
import { digest } from '../../worker/importer/provenance.js';
import { recordLegacy } from '../../worker/importer/durable.js';
import type {
  ImportEffects,
  ImportResources,
  RunOptions,
} from '../../worker/importer/runtime.js';
import type { ImporterConfig } from '../../worker/importer/config.js';
import type { SourceObservation } from '../../worker/importer/contracts.js';

export const EMBEDDING = {
  model: 'text-embedding-3-small',
  dims: 1536,
  usdPerMillionTokens: 0,
};
export const OLD_OBSERVATION = { advertisedAtLocal: '2026-10-01T07:36:33', bytes: 10 };
export const NEW_OBSERVATION = { advertisedAtLocal: '2026-10-31T07:36:33', bytes: 11 };
export interface ImportFixture {
  resources: ImportResources;
  migrate(): Promise<void>;
  owner: Db;
  app: Db;
  config: ImporterConfig;
  baseline: AcceptedSnapshot;
  original: ExtractedSnapshot;
  candidate: ExtractedSnapshot;
  effects: Partial<ImportEffects>;
  acquire: ReturnType<typeof vi.fn>;
  inspect: ReturnType<typeof vi.fn>;
  canaryWait: ReturnType<typeof vi.fn>;
  snapshot(name: string, edit?: (dir: string) => void): Promise<ExtractedSnapshot>;
  setRemote(snapshot: ExtractedSnapshot, observation?: SourceObservation): void;
  run(
    overrides?: Partial<ImportEffects>,
    options?: Partial<RunOptions>,
  ): ReturnType<typeof runWithResources>;
}

export async function importerFixture(
  body: (fixture: ImportFixture) => Promise<void>,
  options: { environment?: 'dev' | 'live'; upTo?: string } = {},
): Promise<void> {
  const appConfig = testConfig();
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(
      new URL(appConfig.elasticsearch.url).hostname,
    )
  )
    throw new Error('local fixture ES required');
  await withScratchEnvironment(
    localAdminUrl(),
    `importerflow${options.environment ?? ''}`,
    async (urls) => {
      const db = createDb(urls.ingest, { max: 12 }),
        owner = createDb(urls.migrator, { max: 4 }),
        app = createDb(urls.app, { max: 2 });
      const raw = testEs(),
        es = certificationClient(raw);
      const root = await mkdtemp(join(tmpdir(), 'importer-flow-'));
      const space = new ManagedSpace(root, { ...FILE_LIMITS, reserve: 0 });
      const prefix = `aviation-test-importflow-${randomBytes(6).toString('hex')}`;
      const sourceDir = await makeCombinedExtractDir();
      for (const table of TABLE_NAMES)
        if (!existsSync(join(sourceDir, `${table}.csv`)))
          writeCsv(join(sourceDir, `${table}.csv`), table, []);
      const snapshot = async (name: string, edit?: (dir: string) => void) => {
        const archive = createHash('sha256').update(name).digest('hex');
        const dir = join(root, 'extracts', archive);
        const archiveDir = join(root, 'archives', archive);
        await privateDirectory(archiveDir);
        await writeFile(join(archiveDir, 'avall.zip'), name, { mode: 0o600 });
        await space.register(`archives/${archive}`);
        await mkdir(join(root, 'extracts'), { recursive: true, mode: 0o700 });
        await cp(sourceDir, dir, { recursive: true });
        edit?.(dir);
        await writeManifest(dir, archive);
        await space.register(`extracts/${archive}`);
        await space.json(join(dir, 'integrity.json'), await hashExtraction(dir));
        return readSnapshot(space, archive);
      };
      try {
        const original = await snapshot('original-public-fixture');
        const candidate = await snapshot('candidate-public-fixture', (dir) =>
          editTable(dir, 'events', (rows) => {
            rows[0]!.lchg_date = '2026-10-30T00:00:00';
            return rows;
          }),
        );
        const loaded = await loadFromExtract(db, original.dir);
        const reports = join(root, 'reports', 'dev');
        await privateDirectory(reports);
        const verified = await verifyCorpus(db, loaded.generationId, {
          outDir: reports,
          profile: null,
        });
        if (!verified.ok) throw new Error('fixture verification failed');
        const cases = await rebuildCasesIndex(es, db, {
          generationId: loaded.generationId,
          prefix,
          log: () => {},
        });
        const passages = await rebuildPassagesIndex(
          es,
          db,
          createFakeEmbedder(1536, EMBEDDING.model),
          {
            generationId: loaded.generationId,
            prefix,
            confirmCost: true,
            gate: createMemorySpendGate(0),
            log: () => {},
            mapRecord: validateRecord,
          },
        );
        await publishGeneration(es, db, {
          generationId: loaded.generationId,
          casesIndex: cases.index,
          passagesIndex: passages.index,
          embedding: EMBEDDING,
        });
        const baseline: AcceptedSnapshot = {
          archive: original.archive,
          content: original.facts.digest,
          csvHash: original.csvHash,
          manifest: (await manifest(db))!,
          observation: OLD_OBSERVATION,
          code: 'a'.repeat(40),
        };
        await withImportSession(db, async (session) => {
          await recordLegacy(db, session, baseline);
        });
        const config: ImporterConfig = {
          version: 'snapshot-importer.v1',
          root,
          hostLock: join(root, 'host.lock'),
          maintenanceLock: join(root, 'backup.lock'),
          code: baseline.code,
          installation: null,
          schedule: {
            enabled: false,
            localTime: '05:30',
            timeZone: 'Europe/Prague',
          },
          dev: {
            envFiles: [],
            applicationUrl: 'http://example.invalid/',
            container: 'offline-app',
            image: 'sha256:' + 'b'.repeat(64),
          },
        };
        if (options.environment === 'live') config.live = { ...config.dev };
        let remote = candidate;
        let observation = NEW_OBSERVATION;
        const inspect = vi.fn(async () => observation);
        const acquire = vi.fn(async () => ({
          sha256: remote.archive,
          path: join(remote.dir, 'avall.zip'),
          fetchedAt: new Date().toISOString(),
        }));
        const canaryWait = vi.fn(async (_ms: number) => {});
        const resources: ImportResources = {
          db,
          es,
          space,
          source: { id: 'offline-fixture', inspect, acquire },
          appConfig: {
            ...appConfig,
            databaseIngestUrl: urls.ingest,
            ai: {
              ...appConfig.ai,
              budgets: {
                monthlyUsd: 100,
                interactiveMonthlyUsd: 80,
                ingestionMonthlyUsd: 20,
                interactiveDailyUsd: 3,
                anonymousShare: 0.25,
              },
            },
            elasticsearch: {
              ...appConfig.elasticsearch,
              indexPrefix: prefix,
            },
          },
          hostFacts: {
            canary: async () => {
              throw new Error('no dev fact requested by this fixture');
            },
            retention: async () => [],
          },
        };
        const effects: Partial<ImportEffects> = {
          extractSnapshot: async (_space, sha) => readSnapshot(space, sha),
          deployedImage: async (env) => env.image,
          applicationAvailable: async () => {},
          workerIdentity: async () => {},
          applicationProbe: (env, _version, counts) => ({
            deployedCode: env.image,
            read: async (publication) => ({
              revision: digest(publication),
              cases: counts.cases,
              hash: digest(counts),
            }),
          }),
          runCanary: (database, publication, probe) =>
            runCanary(database, publication, probe, { sleep: canaryWait }),
        };
        const environment = options.environment ?? 'dev';
        await body({
          resources,
          migrate: async () => {
            await runMigrations(urls.migrator);
          },
          owner,
          app,
          config,
          baseline,
          original,
          candidate,
          effects,
          acquire,
          inspect,
          canaryWait,
          snapshot,
          setRemote(next, nextObservation = NEW_OBSERVATION) {
            remote = next;
            observation = nextObservation;
          },
          run(overrides = {}, options = {}) {
            return runWithResources(
              config,
              { environment: environment, cacheOnly: true, ...options },
              resources,
              { ...effects, ...overrides },
            );
          },
        });
      } finally {
        try {
          const indices = await raw.indices.get({
            index: `${prefix}-*`,
            allow_no_indices: true,
            ignore_unavailable: true,
          });
          const names = Object.keys(indices);
          if (names.length) await raw.indices.delete({ index: names });
        } finally {
          await raw.close();
          await Promise.all([closeDb(db), closeDb(owner), closeDb(app)]);
          await rm(root, { recursive: true, force: true });
          await rm(sourceDir, { recursive: true, force: true });
        }
      }
    },
    { upTo: options.upTo },
  );
}
