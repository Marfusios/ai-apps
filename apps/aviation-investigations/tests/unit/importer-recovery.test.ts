import { describe, expect, it, vi } from 'vitest';
import { matchingDev } from '../../worker/importer/facts.js';
import { ImportFailure } from '../../worker/importer/contracts.js';
import { classify } from '../../worker/importer/failure.js';
import { SpendRefusedError } from '../../worker/index/spend-gate.js';
import type { ImporterConfig } from '../../worker/importer/config.js';
import { applicationAvailable } from '../../worker/importer/application.js';
import { AvallSource } from '../../worker/importer/source.js';

const image = 'sha256:' + 'a'.repeat(64);
const code = 'b'.repeat(40);
const publication = {
  generationId: 7,
  casesIndex: 'synthetic-cases',
  passagesIndex: 'synthetic-passages',
  publishedAt: '2026-10-31T01:00:00.000001Z',
};
const config = { dev: { image }, live: { image }, code } as ImporterConfig;
const candidate = { archive_sha256: 'c'.repeat(64), content_sha256: 'd'.repeat(64) };
const canary = {
  publication,
  archive: candidate.archive_sha256,
  content: candidate.content_sha256,
  code,
  deployedCode: image,
  checkedAt: '2026-10-31T12:00:00.000Z',
  probes: 'e'.repeat(64),
};
const now = new Date(canary.checkedAt);

describe('real cross-environment matching orchestration', () => {
  it('requires both observed dev image checks to equal the certificate and intended live image', async () => {
    const facts = {
      canary: vi.fn(async () => ({ canary, current: publication, observedImage: image })),
      retention: async () => [],
    };
    expect(await matchingDev(config, candidate, facts, async () => image, now)).toEqual(canary);
    await expect(
      matchingDev(config, candidate, facts, async () => 'sha256:' + 'f'.repeat(64), now),
    ).rejects.toMatchObject({ reason: 'dev_failed', review: false });
    for (const unavailable of ['missing', 'stopped']) {
      await expect(
        matchingDev(
          config,
          candidate,
          facts,
          async () => {
            throw new ImportFailure('source_unavailable', false);
          },
          now,
        ),
      ).rejects.toMatchObject({ review: false });
    }
  });
  it('refuses same-generation republication during the image inspection', async () => {
    let current = publication;
    const facts = {
      canary: async () => ({ canary, current, observedImage: image }),
      retention: async () => [],
    };
    await expect(
      matchingDev(
        config,
        candidate,
        facts,
        async () => {
          current = { ...publication, publishedAt: '2026-10-31T01:00:00.000002Z' };
          return image;
        },
        now,
      ),
    ).rejects.toMatchObject({ reason: 'dev_failed', review: false });
  });
});

it.each([
  ['P2601', 'lock_lost', 'cancelled'],
  ['P2602', 'restore_hold', 'needs_review'],
  ['P2603', 'import_cap', 'needs_review'],
  ['P2604', 'accounting', 'needs_review'],
  ['ECONNRESET', 'interrupted', 'deferred'],
])('classifies %s without reading diagnostics', (code, reason, result) => {
  const failure = classify(
    new Error('PRIVATE_SENTINEL', {
      cause: Object.assign(new Error('PRIVATE_SENTINEL'), { code }),
    }),
  );
  expect(failure).toMatchObject({ reason, result });
  expect(failure.message).not.toContain('PRIVATE_SENTINEL');
});
it('keeps unknown failures distinct from temporary admission refusals', () => {
  expect(classify(new Error('PRIVATE_SENTINEL'))).toMatchObject({
    reason: 'interrupted',
    result: 'failed',
    review: false,
  });
  expect(classify(new SpendRefusedError('PRIVATE_SENTINEL', 'busy'))).toMatchObject({
    reason: 'busy',
    result: 'deferred',
  });
  expect(classify(new SpendRefusedError('PRIVATE_SENTINEL', 'restore_hold'))).toMatchObject({
    reason: 'restore_hold',
  });
});
it('treats unavailable apps and non-200 listings as availability, with bounded jitter', async () => {
  await expect(
    applicationAvailable(
      { applicationUrl: 'http://example.invalid' } as ImporterConfig['dev'],
      async () => {
        throw new Error('PRIVATE_SENTINEL');
      },
    ),
  ).rejects.toMatchObject({ review: false, reason: 'source_unavailable' });
  const sleeps: number[] = [];
  const source = new AvallSource({
    fetch: async () => new Response('PRIVATE_SENTINEL', { status: 503 }),
    now: () => now,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await expect(source.inspect()).rejects.toMatchObject({
    review: false,
    reason: 'source_unavailable',
  });
  expect(sleeps).toEqual([1500, 2500]);
  const forbidden = new AvallSource({
    fetch: async () => new Response('PRIVATE_SENTINEL', { status: 403 }),
    now: () => now,
    sleep: async () => {},
  });
  await expect(forbidden.inspect()).rejects.toMatchObject({
    review: false,
    reason: 'source_unavailable',
  });
});
