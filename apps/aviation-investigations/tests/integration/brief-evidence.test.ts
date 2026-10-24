/**
 * A brief keeps the evidence it was made with until it expires (Task 22 fix round 2: gate
 * finding 3, re-review N2). Publishing its generation again with another passages index (the
 * planned passages-v2 rollout) must neither let `index delete-unused` delete the index the
 * brief is pinned to, nor stop its next step from retrieving: the pairing it was made with
 * stays resolvable (manifest_pairings, migration 0021) and cleanup refuses every index an
 * unexpired brief uses (indices_cited_by_live_briefs()). Fixture corpus in aviation_test,
 * indices under aviation-test-*.
 */
import { randomBytes } from 'node:crypto';
import type { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHybridRetriever } from '../../server/briefs/retriever.js';
import { insertBrief } from '../../server/briefs/store.js';
import { closeDb, type Db } from '../../server/db/client.js';
import { BRIEF_REFERENCES_LOCK_KEY, claimBriefEvidence, getActiveManifest, manifestCasesIndex } from '../../server/db/generations.js';
import { RETRIEVAL_V2 } from '../../server/search/retrieval-config.js';
import { passagesAlias } from '../../worker/index/passages-index.js';
import { deleteUnusedIndices } from '../../worker/index/publications.js';
import * as schema from '../../server/db/schema/index.js';
import { publishGeneration } from '../../worker/index/publish.js';
import { FIXTURE_EMBEDDING, buildFixturePassagesIndex, deleteIndices, fixtureEmbedder, publishFixtureDataset } from '../support/api-dataset.js';
import { count } from './corpus-helpers.js';
import { TEST_INDEX_PREFIX, resetControls, resetCorpus, testDb, testEs, testEsReader } from './helpers.js';

const PREFIX = `${TEST_INDEX_PREFIX}evid${randomBytes(4).toString('hex')}`;
const DAY = 24 * 3_600_000;

let appDb: Db;
let ingest: Db;
let migrator: Db;
let reader: Client;
let writer: Client;
let generationId: number;
let casesIndex: string;
let firstPassages: string;

beforeAll(async () => {
  appDb = testDb('app');
  ingest = testDb('ingest');
  migrator = testDb('migrator');
  reader = testEsReader();
  writer = testEs();
  await resetControls();
  const published = await publishFixtureDataset(ingest, writer, PREFIX, { passages: true });
  generationId = published.generationId;
  casesIndex = published.casesIndex;
  firstPassages = published.passagesIndex!;
}, 180_000);

afterAll(async () => {
  await deleteIndices(writer, PREFIX);
  await resetControls();
  await resetCorpus();
  await Promise.all([closeDb(appDb), closeDb(ingest), closeDb(migrator), reader.close(), writer.close()]);
});

beforeEach(async () => {
  await resetControls();
});

const retriever = () =>
  createHybridRetriever({
    es: reader,
    embedder: fixtureEmbedder(),
    retrieval: RETRIEVAL_V2,
    casesIndexOf: (d, signal) => manifestCasesIndex(appDb, d.generationId, d.passagesIndex, { timeoutMs: 2_000, signal }),
  });

describe('a live brief across a republish of its generation', () => {
  it('cleanup keeps the brief’s passages index, and the brief’s next step still retrieves from it', async () => {
    // A brief made on the published pair, as POST /api/briefs stores it.
    await insertBrief(appDb, {
      readOwner: 'a'.repeat(64),
      readOwnerKind: 'trial',
      generationId,
      passagesIndex: firstPassages,
      now: new Date(),
      ttlMs: DAY,
    });
    // The same generation published again with a new passages index; the alias moves on.
    const secondPassages = await buildFixturePassagesIndex(writer, generationId, PREFIX);
    await publishGeneration(writer, ingest, { generationId, casesIndex, passagesIndex: secondPassages, embedding: FIXTURE_EMBEDDING });

    const kept = await deleteUnusedIndices(writer, ingest, { olderThanHours: 0, yes: true, aliases: [passagesAlias(PREFIX)] });
    expect(kept.refused).toContainEqual({ indexName: firstPassages, reason: 'used by an unexpired AI brief' });
    expect(kept.deleted).not.toContain(firstPassages);
    expect(await writer.indices.exists({ index: firstPassages })).toBe(true);

    // What a refinement does first (routes/briefs.ts readyFor) and then its retrieval, under retrieval.v2:
    // the cases index the brief's pair was published with is still found.
    expect(await manifestCasesIndex(appDb, generationId, firstPassages, { timeoutMs: 2_000 })).toBe(casesIndex);
    const pinned = { generationId, passagesIndex: firstPassages };
    expect(await retriever().available(pinned)).toBe(true);
    const step = await retriever().retrieve(
      { dataset: pinned, text: 'engine power loss shortly after maintenance', keywordText: 'engine power loss maintenance', filters: {} },
      new AbortController().signal,
      () => undefined,
    );
    expect(step.bundle.cases.length).toBeGreaterThan(0);

    // Once no unexpired brief uses it, the superseded index goes.
    await resetControls();
    const retired = await deleteUnusedIndices(writer, ingest, { olderThanHours: 0, yes: true, aliases: [passagesAlias(PREFIX)] });
    expect(retired.deleted).toContain(firstPassages);
    expect(retired.refused.map((r) => r.indexName)).toContain(secondPassages);
  }, 180_000);

  it('index cleanup waits for a brief being created, then keeps the index the new brief cites (gate finding 4)', async () => {
    const current = (await getActiveManifest(appDb))!;
    const pinned = { generationId, passagesIndex: current.passagesIndex! };
    // The creating transaction: evidence claimed and the brief inserted, not yet committed.
    const creator = await appDb.$client.connect();
    let committed = false;
    try {
      await creator.query('BEGIN');
      expect(await claimBriefEvidence(drizzle({ client: creator, schema }), pinned)).toBe('ok');
      await drizzle({ client: creator }).execute(sql`
        insert into briefs (read_owner, read_owner_kind, generation_id, passages_index, created_at, expires_at)
        values (${'d'.repeat(64)}, 'trial', ${generationId}, ${pinned.passagesIndex}, now(), now() + interval '1 hour')`);
      // Meanwhile the generation is published with another passages index: the pinned one is in no manifest.
      const next = await buildFixturePassagesIndex(writer, generationId, PREFIX);
      await publishGeneration(writer, ingest, { generationId, casesIndex, passagesIndex: next, embedding: FIXTURE_EMBEDDING });
      let finished = false;
      const cleanup = deleteUnusedIndices(writer, ingest, { olderThanHours: 0, yes: true, aliases: [passagesAlias(PREFIX)] }).finally(() => (finished = true));
      const high = Math.floor(BRIEF_REFERENCES_LOCK_KEY / 2 ** 32);
      const low = BRIEF_REFERENCES_LOCK_KEY % 2 ** 32;
      for (let i = 0; ; i++) {
        const waiting = await count(migrator, sql`select count(*) from pg_locks where locktype = 'advisory' and classid = ${high} and objid = ${low} and not granted`);
        if (waiting > 0) break;
        if (i > 400) throw new Error('index cleanup never waited for the brief being created');
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(finished).toBe(false);
      await creator.query('COMMIT');
      committed = true;
      const report = await cleanup;
      expect(report.refused).toContainEqual({ indexName: pinned.passagesIndex, reason: 'used by an unexpired AI brief' });
      expect(await writer.indices.exists({ index: pinned.passagesIndex })).toBe(true);
    } finally {
      if (!committed) await creator.query('ROLLBACK').catch(() => undefined);
      creator.release();
    }
  }, 180_000);

  it('a brief created between cleanup’s last check and the deletion never cites the deleted index (gate finding 4)', async () => {
    // A superseded passages index: published, then replaced by another one.
    const superseded = await buildFixturePassagesIndex(writer, generationId, PREFIX);
    await publishGeneration(writer, ingest, { generationId, casesIndex, passagesIndex: superseded, embedding: FIXTURE_EMBEDDING });
    const current = await buildFixturePassagesIndex(writer, generationId, PREFIX);
    await publishGeneration(writer, ingest, { generationId, casesIndex, passagesIndex: current, embedding: FIXTURE_EMBEDDING });
    let creation: Promise<string> | undefined;
    const report = await deleteUnusedIndices(writer, ingest, {
      olderThanHours: 0,
      yes: true,
      aliases: [passagesAlias(PREFIX)],
      beforeDelete: async (index) => {
        if (index !== superseded) return;
        // A request whose evidence (resolved while that index was published) arrives now.
        creation = appDb.transaction(async (tx) => {
          const claim = await claimBriefEvidence(tx, { generationId, passagesIndex: superseded });
          if (claim !== 'ok') return claim;
          await tx.execute(sql`
            insert into briefs (read_owner, read_owner_kind, generation_id, passages_index, created_at, expires_at)
            values (${'e'.repeat(64)}, 'trial', ${generationId}, ${superseded}, now(), now() + interval '1 hour')`);
          return 'created';
        });
        await Promise.race([creation.catch(() => undefined), new Promise((r) => setTimeout(r, 300))]);
      },
    });
    expect(report.deleted).toContain(superseded);
    expect(await creation).not.toBe('created');
    expect(await count(migrator, sql`select count(*) from briefs where passages_index = ${superseded}`)).toBe(0);
  }, 180_000);
});
