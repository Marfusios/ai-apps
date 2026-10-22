/**
 * `pnpm worker publish`: make a generation's indices the active manifest (amendment
 * A6). It only checks and then calls `publishManifest`; it builds, moves and deletes
 * nothing.
 *
 * Checks, before anything is written:
 * - the cases index exists as a concrete index (not an alias) and its `_meta` names
 *   this generation and a version and mapping fingerprint the API serves: the current
 *   `CASES_INDEX_VERSION`, or an earlier version with the same fields
 *   (`isServableCasesIndex`), so a generation indexed before a version bump can be
 *   published again;
 * - its document count equals the generation's US events in PostgreSQL;
 * - a passages index, when given, meets the passages contract
 *   (`server/search/passages-contract.ts`: generation, version, approved fingerprint
 *   for the configured embedding model and dimensions, chunker and input-template
 *   versions) and holds exactly the generation's `passages` rows of the approved
 *   chunker version. Without one the manifest is keyword-only: AI routes stay off
 *   until a later publication names a passages index.
 *
 * `publish_manifest` itself checks that the generation's latest verification passed
 * under the current verifier.
 */
import type { Client } from '@elastic/elasticsearch';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../server/db/client.js';
import { publishManifest, type ActiveManifest } from '../../server/db/generations.js';
import { countCaseRecords } from '../../server/db/queries/case-records.js';
import { passages as passagesTable } from '../../server/db/schema/index.js';
import { readIndexMeta } from '../../server/search/index-meta.js';
import { PASSAGES_CONTRACT, passagesIndexProblems, type PassagesContract } from '../../server/search/passages-contract.js';
import { SERVABLE_CASES_VERSIONS, isServableCasesIndex } from './cases-index.js';

export interface PublishOptions {
  generationId: number;
  casesIndex: string;
  /** Null: keyword-only manifest. */
  passagesIndex: string | null;
  /** The configured embedding model and dimensions; required with a passages index. */
  embedding?: { model: string; dims: number };
  /** Test seam; default the approved contract. */
  contract?: PassagesContract;
}

export interface PublishReport {
  manifest: ActiveManifest;
  casesDocuments: number;
  passagesDocuments: number | null;
}

export class PublishRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishRefusedError';
  }
}

async function documents(es: Client, index: string): Promise<number> {
  const r = await es.count({ index });
  return r.count;
}

export async function publishGeneration(es: Client, db: Db, opts: PublishOptions): Promise<PublishReport> {
  const { generationId, casesIndex, passagesIndex } = opts;
  const refuse = (why: string): never => {
    throw new PublishRefusedError(`not published: ${why}`);
  };

  const cases = await readIndexMeta(es, casesIndex).catch((err: unknown) => refuse(String((err as Error).message)));
  if (cases.generationId !== generationId) {
    refuse(`${casesIndex} was built for generation ${cases.generationId ?? 'unknown'}, not ${generationId}`);
  }
  if (cases.indexVersion === null || !SERVABLE_CASES_VERSIONS.includes(cases.indexVersion)) {
    refuse(`${casesIndex} is ${cases.indexVersion ?? 'unversioned'}; this code serves ${SERVABLE_CASES_VERSIONS.join(' or ')}`);
  }
  if (!isServableCasesIndex(cases.indexVersion, cases.fingerprint)) {
    refuse(`${casesIndex} has a different mapping fingerprint than ${cases.indexVersion} defines`);
  }
  const expected = (await countCaseRecords(db, generationId)).cases;
  const casesDocuments = await documents(es, casesIndex);
  if (expected === 0) refuse(`generation ${generationId} has no US events`);
  if (casesDocuments !== expected) {
    refuse(`${casesIndex} holds ${casesDocuments} documents; generation ${generationId} has ${expected} US events`);
  }

  let passagesDocuments: number | null = null;
  if (passagesIndex !== null) {
    if (passagesIndex === casesIndex) refuse('the passages index must differ from the cases index');
    if (!opts.embedding) refuse('a passages index needs the configured embedding model and dimensions');
    const embedding = opts.embedding as { model: string; dims: number };
    const contract = opts.contract ?? PASSAGES_CONTRACT;
    const passages = await readIndexMeta(es, passagesIndex).catch((err: unknown) => refuse(String((err as Error).message)));
    const problems = passagesIndexProblems(passages, { generationId, ...embedding }, contract);
    if (problems.length > 0) refuse(`${passagesIndex} breaks the passages contract: ${problems.join('; ')}`);
    const [rows] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(passagesTable)
      .where(and(eq(passagesTable.generationId, generationId), eq(passagesTable.chunkerVersion, contract.chunkerVersion)));
    const stored = rows?.n ?? 0;
    passagesDocuments = await documents(es, passagesIndex);
    if (passagesDocuments === 0) refuse(`${passagesIndex} is empty`);
    if (passagesDocuments !== stored) {
      refuse(`${passagesIndex} holds ${passagesDocuments} documents; generation ${generationId} has ${stored} ${contract.chunkerVersion} passages`);
    }
  }

  const manifest = await publishManifest(db, generationId, casesIndex, passagesIndex);
  return { manifest, casesDocuments, passagesDocuments };
}
