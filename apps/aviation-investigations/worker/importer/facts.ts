/** Host-mediated metadata bridge. Environment workers never open the other environment's files or database. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { environmentConfig, type ImporterConfig } from './config.js';
import { ImportFailure, Sha256, sameManifest } from './contracts.js';
import { checkDevCanary } from './approval.js';
import { deployedImage } from './application.js';
import { manifest, latestCanary, type Artifact, type Canary } from './store.js';

export { ManifestSchema, CanarySchema } from './contracts.js';
import { ManifestSchema, CanarySchema } from './contracts.js';
const DevFactsSchema = z.strictObject({
  canary: CanarySchema.nullable(),
  current: ManifestSchema.nullable(),
  observedImage: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type DevFacts = z.infer<typeof DevFactsSchema>;
export const FactRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('canary'),
    environment: z.literal('dev'),
    content: Sha256,
  }),
  z.strictObject({ kind: z.literal('retention'), environment: z.enum(['dev', 'live']) }),
]);
export type FactRequest = z.infer<typeof FactRequestSchema>;
export const FactMessageSchema = z.strictObject({
  type: z.literal('import-facts'),
  id: z.uuid(),
  request: FactRequestSchema,
});
const FactReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({
    type: z.literal('import-facts-reply'),
    id: z.uuid(),
    ok: z.literal(false),
  }),
  z.strictObject({
    type: z.literal('import-facts-reply'),
    id: z.uuid(),
    ok: z.literal(true),
    value: z.union([DevFactsSchema, z.array(Sha256).max(2048)]),
  }),
]);
export interface HostFacts {
  canary(content: string): Promise<DevFacts>;
  retention(environment: 'dev' | 'live'): Promise<string[]>;
}

export async function retainedArchives(db: Db): Promise<string[]> {
  const result =
    await db.execute(sql`select accepted->>'archive' as archive from import_control where accepted is not null
    union select pending->>'archive' from import_control where pending is not null
    union select archive_sha256 from import_artifacts a where
      (resolved_at is null and (needs_review or canary is null))
      or exists(select 1 from import_index_refs r where r.artifact_id=a.id and released_at is null)`);
  const parsed = z
    .array(Sha256)
    .max(2048)
    .safeParse(result.rows.map((row) => row.archive));
  if (!parsed.success) throw new ImportFailure('integrity');
  return parsed.data;
}

/** Called by the lock-owning host only; the response contains no connection material. */
export async function readHostFacts(
  config: ImporterConfig,
  request: FactRequest,
): Promise<DevFacts | string[]> {
  const cfg = environmentConfig(config, request.environment, true);
  const db = createDb(cfg.databaseIngestUrl!, {
    max: 2,
    applicationName: 'aviation-import-host-facts',
    onConnectionError: () => {},
  });
  try {
    if (request.kind === 'retention') return retainedArchives(db);
    const before = await manifest(db);
    const canary = await latestCanary(db, request.content);
    const observedImage = await deployedImage(config.dev);
    if (!sameManifest(before, await manifest(db)))
      throw new ImportFailure('dev_failed', false);
    return DevFactsSchema.parse({
      canary,
      current: before,
      observedImage,
    });
  } finally {
    await closeDb(db);
  }
}

/** Fresh checks at admission and again inside the live publication guard. */
export async function matchingDev(
  config: ImporterConfig,
  candidate: Pick<Artifact, 'archive_sha256' | 'content_sha256'>,
  facts: HostFacts,
  inspect: typeof deployedImage = deployedImage,
  now = new Date(),
): Promise<Canary> {
  if (!config.live || config.dev.image !== config.live.image)
    throw new ImportFailure('configuration');
  const first = await facts.canary(candidate.content_sha256);
  const observed = await inspect(config.dev);
  const fresh = await facts.canary(candidate.content_sha256);
  if (
    first.observedImage !== observed ||
    fresh.observedImage !== observed ||
    observed !== config.live.image ||
    !sameManifest(first.current, fresh.current)
  )
    throw new ImportFailure('dev_failed', false);
  checkDevCanary(
    fresh.canary,
    fresh.current,
    {
      archive: candidate.archive_sha256,
      content: candidate.content_sha256,
      code: config.code,
      deployedCode: observed,
    },
    now,
  );
  return fresh.canary;
}

/** A bounded IPC exchange; a missing host is an availability refusal, never a direct credential fallback. */
export function workerHostFacts(): HostFacts {
  async function request(value: FactRequest): Promise<DevFacts | string[]> {
    if (!process.send || !process.connected) throw new ImportFailure('dev_failed', false);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: ImportFailure, result?: DevFacts | string[]) => {
        clearTimeout(timer);
        process.off('message', receive);
        process.off('disconnect', disconnected);
        if (error) reject(error);
        else resolve(result!);
      };
      const receive = (raw: unknown) => {
        const parsed = FactReplySchema.safeParse(raw);
        if (!parsed.success || parsed.data.id !== id) return;
        if (!parsed.data.ok) finish(new ImportFailure('dev_failed', false));
        else finish(undefined, parsed.data.value);
      };
      const disconnected = () => finish(new ImportFailure('lock_lost', false, 'cancelled'));
      const timer = setTimeout(() => finish(new ImportFailure('dev_failed', false)), 30_000);
      process.on('message', receive);
      process.once('disconnect', disconnected);
      process.send!({ type: 'import-facts', id, request: value }, (error) => {
        if (error) finish(new ImportFailure('dev_failed', false));
      });
    });
  }
  return {
    async canary(content) {
      return DevFactsSchema.parse(
        await request({ kind: 'canary', environment: 'dev', content }),
      );
    },
    async retention(environment) {
      return z
        .array(Sha256)
        .max(2048)
        .parse(await request({ kind: 'retention', environment }));
    },
  };
}
