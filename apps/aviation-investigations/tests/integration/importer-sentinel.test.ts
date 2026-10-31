import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import yazl from 'yazl';
import { importerFixture } from '../support/importer.js';
import { editTable, writeManifest } from '../support/extract-dir.js';
import { readImportStatus } from '../../server/db/import-status.js';
import { hashExtraction } from '../../worker/importer/files.js';
import { extractSnapshot } from '../../worker/importer/extraction.js';
import { AvallSource } from '../../worker/importer/source.js';
import { certificationClient } from '../../worker/importer/strict-es.js';
import { probeCandidate } from '../../worker/importer/probes.js';
import { loadFromExtract } from '../../worker/ingest/load.js';
import { rebuildCasesIndex } from '../../worker/index/cases-index.js';
import type { ImportEffects } from '../../worker/importer/runtime.js';

const SENTINEL = 'PRIVATE_SENTINEL_MUST_NOT_LEAVE_WORKER';

/** Override a transport response, keeping the actual parser, builder and strict validator. */
function transport(client: Client, method: 'bulk' | 'count'): Client {
  return certificationClient(
    new Proxy(client, {
      get(target, property) {
        if (property === method)
          return async (request: {
            operations?: { create?: { _index: string; _id: string } }[];
          }) => {
            if (method === 'count')
              return {
                count: 0,
                _shards: { total: 1, successful: 0, failed: 1, failures: [{ reason: SENTINEL }] },
              };
            return {
              errors: true,
              items: request
                .operations!.filter((_, index) => index % 2 === 0)
                .map((operation) => ({
                  create: {
                    ...operation.create,
                    status: 400,
                    error: { type: 'mapper_parsing_exception', reason: SENTINEL },
                  },
                })),
            };
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  );
}

it.each(['HTML', 'MDB', 'CSV', 'normalizer', 'bulk', 'SQL', 'cleanup', 'probe'] as const)(
  'redacts the real %s failure path from journals, status and ingestion errors',
  async (boundary) =>
    importerFixture(async (fixture) => {
      const effects: Partial<ImportEffects> = {};
      if (boundary === 'HTML') {
        const source = new AvallSource({
          fetch: async () => new Response(`<table><tr><td>${SENTINEL}</td></tr></table>`),
          sleep: async () => {},
          now: () => new Date('2026-10-31T12:00:00Z'),
        });
        fixture.resources.source.inspect = () => source.inspect();
      }
      if (boundary === 'MDB') {
        const zip = new yazl.ZipFile();
        zip.addBuffer(Buffer.from(SENTINEL), 'avall.mdb');
        zip.end();
        const chunks: Buffer[] = [];
        for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
        const bytes = Buffer.concat(chunks);
        const sha = createHash('sha256').update(bytes).digest('hex');
        const directory = join(fixture.resources.space.root, 'archives', sha);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await fixture.resources.space.register(`archives/${sha}`);
        await writeFile(join(directory, 'avall.zip'), bytes, { mode: 0o600 });
        fixture.resources.source.acquire = async () => ({
          path: join(directory, 'avall.zip'),
          sha256: sha,
          fetchedAt: new Date().toISOString(),
        });
        effects.extractSnapshot = extractSnapshot;
      }
      if (boundary === 'CSV') {
        const csv = `ev_id,ntsb_no\n"${SENTINEL}`;
        await writeFile(join(fixture.candidate.dir, 'events.csv'), csv, { mode: 0o600 });
        const manifestPath = join(fixture.candidate.dir, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.tables.events.bytes = Buffer.byteLength(csv);
        await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
        await fixture.resources.space.json(
          join(fixture.candidate.dir, 'integrity.json'),
          await hashExtraction(fixture.candidate.dir),
        );
      }
      if (boundary === 'normalizer') {
        editTable(fixture.candidate.dir, 'events', (rows) => {
          const duplicate = { ...rows[0]!, ev_id: SENTINEL };
          rows[0]!.ev_id = SENTINEL;
          return [...rows, duplicate];
        });
        await writeManifest(fixture.candidate.dir, fixture.candidate.archive);
        await fixture.resources.space.json(
          join(fixture.candidate.dir, 'integrity.json'),
          await hashExtraction(fixture.candidate.dir),
        );
      }
      if (boundary === 'bulk')
        effects.rebuildCasesIndex = (client, database, options) =>
          rebuildCasesIndex(transport(client, 'bulk'), database, options);
      if (boundary === 'SQL')
        effects.loadFromExtract = (database, directory, options) =>
          loadFromExtract(database, directory, {
            ...options,
            onGeneration: async (tx, generation) => {
              await options?.onGeneration?.(tx, generation);
              await tx.execute(sql.raw(`do $$ begin raise exception '${SENTINEL}'; end $$`));
            },
          });
      if (boundary === 'cleanup')
        await fixture.resources.space.json(join(fixture.resources.space.root, 'extraction.json'), {
          archive: fixture.candidate.archive,
          containers: [SENTINEL],
        });
      if (boundary === 'probe')
        effects.probeCandidate = (database, client, ...args) =>
          probeCandidate(database, transport(client, 'count'), ...args);

      const output: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((bytes: unknown) => {
        output.push(String(bytes));
        return true;
      }) as typeof process.stdout.write);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((bytes: unknown) => {
        output.push(String(bytes));
        return true;
      }) as typeof process.stderr.write);
      try {
        await expect(fixture.run(effects)).rejects.toMatchObject({ name: 'ImportFailure' });
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
      expect(output.join('')).not.toContain(SENTINEL);
      expect(output.some((line) => /"result":"(?:needs_review|failed|deferred)"/.test(line))).toBe(
        true,
      );
      expect(JSON.stringify(await readImportStatus(fixture.app, null))).not.toContain(SENTINEL);
      expect(
        JSON.stringify(
          (await fixture.resources.db.execute(sql`select error from ingestion_runs`)).rows,
        ),
      ).not.toContain(SENTINEL);
    }),
);
