/**
 * Dataset generations and manifests (amendment A6). The active manifest names the
 * generation and the two search indices built for it; the API pins every request to
 * it. `publishManifest` flips it atomically; `pruneGenerations` removes old ones.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from './client.js';
import {
  caseAircraft,
  caseEngines,
  caseFindings,
  caseSectionSources,
  caseSections,
  caseSequence,
  cases,
  codeDictionary,
  datasetGenerations,
  datasetManifests,
  quarantine,
  type GenerationStatus,
} from './schema/index.js';

export interface ActiveManifest {
  generationId: number;
  casesIndex: string;
  passagesIndex: string;
  publishedAt: Date;
  archiveSha256: string;
  mappingVersion: string;
  mappingVerified: boolean;
  citationTextVersion: string;
}

/** The active manifest with its generation's versions, or null before the first publish. */
export async function getActiveManifest(db: DbOrTx): Promise<ActiveManifest | null> {
  const [row] = await db
    .select({
      generationId: datasetManifests.generationId,
      casesIndex: datasetManifests.casesIndex,
      passagesIndex: datasetManifests.passagesIndex,
      publishedAt: datasetManifests.publishedAt,
      archiveSha256: datasetGenerations.archiveSha256,
      mappingVersion: datasetGenerations.mappingVersion,
      mappingVerified: datasetGenerations.mappingVerified,
      citationTextVersion: datasetGenerations.citationTextVersion,
    })
    .from(datasetManifests)
    .innerJoin(datasetGenerations, eq(datasetGenerations.id, datasetManifests.generationId))
    .where(eq(datasetManifests.active, true));
  if (!row) return null;
  return { ...row, publishedAt: row.publishedAt as Date };
}

/** Elasticsearch index names: lower-case, no path or wildcard characters. */
const INDEX_NAME = /^[a-z0-9][a-z0-9._-]{0,254}$/;
const PUBLISHABLE: readonly GenerationStatus[] = ['verified', 'published', 'retired'];

/** Serializes publish and prune; readers are not blocked. */
async function lockManifests(tx: DbOrTx): Promise<void> {
  await tx.execute(sql`lock table dataset_manifests in share row exclusive mode`);
}

/**
 * Make `generationId` the active dataset with the given indices, in one transaction:
 * the previous active manifest is deactivated and its generation becomes `retired`;
 * this generation's manifest is created or updated, activated, and the generation
 * becomes `published`. Only a verified (or previously published) generation can be
 * published. Re-publishing an older generation is a rollback.
 */
export async function publishManifest(
  db: Db,
  generationId: number,
  casesIndex: string,
  passagesIndex: string,
): Promise<ActiveManifest> {
  for (const name of [casesIndex, passagesIndex]) {
    if (!INDEX_NAME.test(name)) throw new Error(`invalid index name: ${JSON.stringify(name)}`);
  }
  return db.transaction(async (tx) => {
    await lockManifests(tx);
    const [gen] = await tx
      .select({ id: datasetGenerations.id, status: datasetGenerations.status })
      .from(datasetGenerations)
      .where(eq(datasetGenerations.id, generationId))
      .for('update');
    if (!gen) throw new Error(`generation ${generationId} does not exist`);
    if (!PUBLISHABLE.includes(gen.status)) {
      throw new Error(`generation ${generationId} is ${gen.status}; only a verified generation can be published`);
    }
    const previous = await tx
      .update(datasetManifests)
      .set({ active: false })
      .where(sql`${datasetManifests.active} and ${datasetManifests.generationId} <> ${generationId}`)
      .returning({ generationId: datasetManifests.generationId });
    if (previous.length > 0) {
      await tx
        .update(datasetGenerations)
        .set({ status: 'retired' })
        .where(inArray(datasetGenerations.id, previous.map((p) => p.generationId)));
    }
    const now = new Date();
    await tx
      .insert(datasetManifests)
      .values({ generationId, casesIndex, passagesIndex, publishedAt: now, active: true })
      .onConflictDoUpdate({
        target: datasetManifests.generationId,
        set: { casesIndex, passagesIndex, publishedAt: now, active: true },
      });
    await tx.update(datasetGenerations).set({ status: 'published' }).where(eq(datasetGenerations.id, generationId));
    const active = await getActiveManifest(tx);
    if (!active || active.generationId !== generationId) throw new Error('manifest activation failed');
    return active;
  });
}

export interface PruneReport {
  /** Generations kept because they are among the last `keep` published (active first). */
  kept: number[];
  deleted: number[];
}

/** Child-first delete order for one generation's rows. */
const DELETE_ORDER = [
  caseSectionSources,
  caseSections,
  caseEngines,
  caseFindings,
  caseSequence,
  caseAircraft,
  cases,
  codeDictionary,
  quarantine,
] as const;

/** Delete every row of one generation, then the generation itself. */
async function deleteGeneration(tx: DbOrTx, generationId: number): Promise<void> {
  for (const table of DELETE_ORDER) await tx.delete(table).where(eq(table.generationId, generationId));
  await tx.delete(datasetManifests).where(eq(datasetManifests.generationId, generationId));
  await tx.delete(datasetGenerations).where(eq(datasetGenerations.id, generationId));
}

/**
 * Keep the last `keep` published generations (by publish time; the active one is
 * always kept) and delete `failed` generations and every other generation older than
 * all kept ones. Generations newer than the oldest kept one that were never published
 * (loaded or verified, awaiting indices) are left alone. Before anything is published
 * only `failed` generations are deleted.
 */
export async function pruneGenerations(db: Db, keep = 2): Promise<PruneReport> {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer');
  return db.transaction(async (tx) => {
    // Deletes and their per-row foreign-key checks use the generation and key indexes.
    await tx.execute(sql`set local enable_seqscan = off`);
    await lockManifests(tx);
    const published = await tx
      .select({ generationId: datasetManifests.generationId })
      .from(datasetManifests)
      .where(sql`${datasetManifests.publishedAt} is not null`)
      .orderBy(desc(datasetManifests.active), desc(datasetManifests.publishedAt), desc(datasetManifests.generationId))
      .limit(keep);
    const kept = published.map((p) => p.generationId);
    const oldestKept = kept.length > 0 ? Math.min(...kept) : null;
    const all = await tx
      .select({ id: datasetGenerations.id, status: datasetGenerations.status })
      .from(datasetGenerations)
      .orderBy(datasetGenerations.id)
      .for('update');
    const deleted = all
      .filter((g) => !kept.includes(g.id) && g.status !== 'published')
      .filter((g) => g.status === 'failed' || (oldestKept !== null && g.id < oldestKept))
      .map((g) => g.id);
    for (const id of deleted) await deleteGeneration(tx, id);
    return { kept, deleted };
  });
}

export interface GenerationSummary {
  id: number;
  status: GenerationStatus;
  createdAt: Date;
  verifiedAt: Date | null;
  archiveSha256: string;
  mappingVersion: string;
  mappingVerified: boolean;
  citationTextVersion: string;
  events: number | null;
  active: boolean;
  publishedAt: Date | null;
}

export async function listGenerations(db: DbOrTx): Promise<GenerationSummary[]> {
  const rows = await db
    .select({
      id: datasetGenerations.id,
      status: datasetGenerations.status,
      createdAt: datasetGenerations.createdAt,
      verifiedAt: datasetGenerations.verifiedAt,
      archiveSha256: datasetGenerations.archiveSha256,
      mappingVersion: datasetGenerations.mappingVersion,
      mappingVerified: datasetGenerations.mappingVerified,
      citationTextVersion: datasetGenerations.citationTextVersion,
      events: sql<number | null>`(${datasetGenerations.stats} -> 'rows' ->> 'cases')::int`,
      active: sql<boolean>`coalesce(${datasetManifests.active}, false)`,
      publishedAt: datasetManifests.publishedAt,
    })
    .from(datasetGenerations)
    .leftJoin(datasetManifests, eq(datasetManifests.generationId, datasetGenerations.id))
    .orderBy(datasetGenerations.id);
  return rows;
}
