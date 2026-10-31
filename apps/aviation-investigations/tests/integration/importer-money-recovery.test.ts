import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { importerFixture } from '../support/importer.js';
import { editTable } from '../support/extract-dir.js';
import { createOpenAIEmbedder, checkBatch, fakeVector } from '../../worker/index/embed.js';
import { vectorToBytes } from '../../worker/index/embedding-cache.js';
import type { ImportEffects } from '../../worker/importer/runtime.js';
import {
  artifact,
  budgetRemaining,
  control,
  withImportSession,
} from '../../worker/importer/store.js';
import { readImportStatus } from '../../server/db/import-status.js';

async function missFixture(fixture: Parameters<Parameters<typeof importerFixture>[0]>[0]) {
  const candidate = await fixture.snapshot('changed-narrative', (dir) =>
    editTable(dir, 'narratives', (rows) => {
      rows[0]!.narr_cause += ' Additional synthetic public fixture sentence.';
      return rows;
    }),
  );
  fixture.setRemote(candidate);
}
function providerTransport(counter: { calls: number }, status = 200): typeof fetch {
  return async (_url, options) => {
    counter.calls++;
    if (status !== 200)
      return new Response(
        JSON.stringify({ error: { type: 'server_error', message: 'PRIVATE_SENTINEL_PROVIDER' } }),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
    const input = (JSON.parse(String(options?.body)) as { input: string[] }).input;
    return new Response(
      JSON.stringify({
        object: 'list',
        model: 'text-embedding-3-small',
        data: input.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: vectorToBytes(fakeVector(text, 1536)).toString('base64'),
        })),
        usage: { prompt_tokens: checkBatch(input), total_tokens: checkBatch(input) },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
}
function fakePaid(
  counter: { calls: number },
  status = 200,
): NonNullable<Partial<ImportEffects>['paidEmbedder']> {
  return (_config, _env, embedding, gate, id) =>
    createOpenAIEmbedder({
      apiKey: 'synthetic-offline-only',
      ...embedding,
      gate,
      purpose: `import:${id}`,
      fetch: providerTransport(counter, status),
      sleep: async () => {},
      log: () => {},
    });
}

it.each(['settlement', 'cache'] as const)(
  'keeps the original tagged count after a lost %s acknowledgement and resumes',
  async (boundary) =>
    importerFixture(async (fixture) => {
      await missFixture(fixture);
      const provider = { calls: 0 };
      let lost = false;
      const originalQuery = fixture.resources.db.$client.query.bind(fixture.resources.db.$client);
      if (boundary === 'cache') {
        fixture.resources.db.$client.query = (async (...args: unknown[]) => {
          const text =
            typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
          const result = await Reflect.apply(originalQuery, fixture.resources.db.$client, args);
          if (!lost && /insert into "embedding_cache"/i.test(text)) {
            lost = true;
            throw new Error('PRIVATE_SENTINEL_CACHE_COMMIT');
          }
          return result;
        }) as pg.Pool['query'];
      }
      const embed: ImportEffects['paidEmbedder'] = (_config, _env, embedding, gate, id) =>
        createOpenAIEmbedder({
          apiKey: 'synthetic-offline-only',
          ...embedding,
          purpose: `import:${id}`,
          fetch: providerTransport(provider),
          sleep: async () => {},
          gate: {
            ...gate,
            async settle(reservation, outcome) {
              await gate.settle(reservation, outcome);
              if (boundary === 'settlement' && !lost) {
                lost = true;
                throw new Error('PRIVATE_SENTINEL_SETTLEMENT_COMMIT');
              }
            },
          },
        });
      try {
        await expect(
          fixture.run({ paidEmbedder: embed }, { cacheOnly: false }),
        ).rejects.toMatchObject({ review: false, result: 'failed' });
      } finally {
        fixture.resources.db.$client.query = originalQuery;
      }
      expect(lost).toBe(true);
      const pending = (await control(fixture.resources.db)).pending!;
      const saved = await artifact(fixture.resources.db, pending.artifactId!);
      const rows = (
        await fixture.resources.db.execute(
          sql`select id,import_artifact_id,charged_usd::float8 as charged,status from reservations order by id`,
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ import_artifact_id: saved.id, status: 'settled' });
      expect(Number(rows[0]?.charged)).toBeGreaterThan(0);
      const before = await withImportSession(fixture.resources.db, (session) =>
        budgetRemaining(fixture.resources.db, session, saved.id),
      );
      expect(
        await fixture.run({ paidEmbedder: fakePaid(provider) }, { cacheOnly: false }),
      ).toMatchObject({ result: 'published', generationId: 2 });
      const after = await withImportSession(fixture.resources.db, (session) =>
        budgetRemaining(fixture.resources.db, session, saved.id),
      );
      expect(after).toBeLessThanOrEqual(before);
      const retained = (
        await fixture.resources.db.execute(
          sql`select id,import_artifact_id,charged_usd::float8 as charged,status from reservations order by id`,
        )
      ).rows;
      expect(retained[0]).toEqual(rows[0]);
      expect(retained.every((row) => row.import_artifact_id === saved.id)).toBe(true);
      expect(provider.calls).toBe(boundary === 'cache' ? 1 : 2);
      expect(
        (await fixture.resources.db.execute(sql`select count(*)::int as n from import_artifacts`))
          .rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await fixture.resources.db.execute(
            sql`select count(*)::int as n from dataset_generations`,
          )
        ).rows[0]?.n,
      ).toBe(2);
    }),
);

it('defers the monthly allowance without a review and resumes under the same artifact cap', async () =>
  importerFixture(async (fixture) => {
    await missFixture(fixture);
    fixture.resources.appConfig.ai.budgets.ingestionMonthlyUsd = 0;
    const provider = { calls: 0 };
    await expect(
      fixture.run({ paidEmbedder: fakePaid(provider) }, { cacheOnly: false }),
    ).rejects.toMatchObject({ reason: 'monthly_budget', review: false });
    const pending = (await control(fixture.resources.db)).pending!;
    expect(provider.calls).toBe(0);
    expect((await artifact(fixture.resources.db, pending.artifactId!)).needs_review).toBe(false);
    expect((await readImportStatus(fixture.app, null)).attentionRequired).toBe(false);
    fixture.resources.appConfig.ai.budgets.ingestionMonthlyUsd = 20;
    expect(
      await fixture.run({ paidEmbedder: fakePaid(provider) }, { cacheOnly: false }),
    ).toMatchObject({ result: 'published' });
    expect((await artifact(fixture.resources.db, pending.artifactId!)).id).toBe(pending.artifactId);
  }));

it('redacts an actual provider failure and keeps all three uncertain attempts tagged on resume', async () =>
  importerFixture(async (fixture) => {
    await missFixture(fixture);
    const provider = { calls: 0 },
      output: string[] = [];
    const capture = vi.spyOn(process.stdout, 'write').mockImplementation(((bytes: unknown) => {
      output.push(String(bytes));
      return true;
    }) as typeof process.stdout.write);
    try {
      await expect(
        fixture.run({ paidEmbedder: fakePaid(provider, 500) }, { cacheOnly: false }),
      ).rejects.toMatchObject({ review: false });
    } finally {
      capture.mockRestore();
    }
    expect(output.join('')).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.stringify(await readImportStatus(fixture.app, null))).not.toContain(
      'PRIVATE_SENTINEL',
    );
    const pending = (await control(fixture.resources.db)).pending!;
    const uncertain = (
      await fixture.resources.db.execute(
        sql`select count(*)::int as n,bool_and(uncertain and import_artifact_id=${pending.artifactId}::uuid) as tagged from reservations`,
      )
    ).rows[0];
    expect(uncertain).toEqual({ n: 3, tagged: true });
    expect(
      await fixture.run({ paidEmbedder: fakePaid(provider) }, { cacheOnly: false }),
    ).toMatchObject({ result: 'published' });
    expect(
      (
        await fixture.resources.db.execute(
          sql`select count(*)::int as n from reservations where uncertain and import_artifact_id=${pending.artifactId}::uuid`,
        )
      ).rows[0]?.n,
    ).toBe(3);
  }));
