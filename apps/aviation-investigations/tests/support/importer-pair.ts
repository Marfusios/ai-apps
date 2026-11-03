import { sql } from 'drizzle-orm';
import { digest } from '../../worker/importer/provenance.js';
/** The production fact readers, across two disposable databases and distinct ES prefixes. */
import { readServingFacts, retainedArchives } from '../../worker/importer/facts.js';
import {
  latestCanary,
  manifest,
  withImportSession,
  fenced,
} from '../../worker/importer/store.js';
import { importerFixture, type ImportFixture } from './importer.js';

export function connectImporters(dev: ImportFixture, live: ImportFixture): void {
  dev.config.live = { ...live.config.live! };
  live.config.dev = { ...dev.config.dev };
  live.config.code = dev.config.code;
  const host = {
    serving: (env: 'dev' | 'live') =>
      readServingFacts((env === 'dev' ? dev : live).resources.db),
    retention: (env: 'dev' | 'live') =>
      retainedArchives((env === 'dev' ? dev : live).resources.db),
    canary: async (content: string) => ({
      canary: await latestCanary(dev.resources.db, content),
      current: await manifest(dev.resources.db),
      observedImage: dev.config.dev.image,
    }),
  };
  dev.resources.hostFacts = host;
  live.resources.hostFacts = host;
}

export async function importerPair(
  body: (dev: ImportFixture, live: ImportFixture) => Promise<void>,
  legacy = false,
): Promise<void> {
  await importerFixture(
    async (dev) =>
      importerFixture(
        async (live) => {
          connectImporters(dev, live);
          const canary = {
            publication: dev.baseline.manifest,
            archive: dev.baseline.archive,
            content: dev.baseline.content,
            code: dev.config.code,
            deployedCode: dev.config.dev.image,
            probes: 'a'.repeat(64),
            checkedAt: new Date().toISOString(),
          };
          await withImportSession(dev.resources.db, (s) =>
            fenced(dev.resources.db, s, (tx) =>
              tx.execute(sql`select import_record_attestation(${s.fence}::uuid,null::uuid,null::uuid,'legacy',
              ${JSON.stringify(dev.baseline.manifest)}::jsonb,${JSON.stringify(dev.baseline)}::jsonb,${JSON.stringify(canary)}::jsonb,${digest(canary)})`),
            ),
          );
          await body(dev, live);
        },
        { environment: 'live' },
      ),
    { environment: 'dev', upTo: legacy ? '0028_importer_recovery' : undefined },
  );
}
