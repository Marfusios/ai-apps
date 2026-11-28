import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchingDev } from '../../worker/importer/facts.js';
import { classify } from '../../worker/importer/failure.js';
import { SpendRefusedError } from '../../worker/index/spend-gate.js';
import type { ImporterConfig } from '../../worker/importer/config.js';
import { applicationAvailable } from '../../worker/importer/application.js';
import { AvallSource } from '../../worker/importer/source.js';

type ContainerState = 'running' | 'missing' | 'stopped';
/** What `docker inspect` answers for the dev container, as the real image inspection reads it. */
const docker = vi.hoisted(() => ({
  state: 'running' as ContainerState,
  inspected: [] as string[][],
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const original = promisify(actual.execFile);
  async function run(file: string, args: string[], options: object) {
    if (file !== 'docker' || args[0] !== 'inspect') return original(file, args, options);
    docker.inspected.push(args);
    if (docker.state === 'missing')
      throw Object.assign(new Error('Command failed: docker inspect'), {
        code: 1,
        stdout: '',
        stderr: `Error: No such container: ${args.at(-1)}\n`,
      });
    return { stdout: `sha256:${'a'.repeat(64)} ${docker.state === 'running'}\n`, stderr: '' };
  }
  const execFile = Object.assign(
    () => {
      throw new Error('this test fakes only the promisified execFile');
    },
    { [promisify.custom]: run },
  );
  return { ...actual, execFile };
});

const image = 'sha256:' + 'a'.repeat(64);
const code = 'b'.repeat(40);
const publication = {
  generationId: 7,
  casesIndex: 'synthetic-cases',
  passagesIndex: 'synthetic-passages',
  publishedAt: '2026-10-31T01:00:00.000001Z',
};
const config = { dev: { image, container: 'aircase-dev' }, live: { image }, code } as ImporterConfig;
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
  // Every test starts from a running container with nothing inspected, whatever ran before it.
  afterEach(() => {
    docker.state = 'running';
    docker.inspected = [];
  });
  it('requires both observed dev image checks to equal the certificate and intended live image', async () => {
    const facts = {
      canary: vi.fn(async () => ({ canary, current: publication, observedImage: image })),
      retention: async () => [],
    };
    expect(await matchingDev(config, candidate, facts, async () => image, now)).toEqual(canary);
    await expect(
      matchingDev(config, candidate, facts, async () => 'sha256:' + 'f'.repeat(64), now),
    ).rejects.toMatchObject({ reason: 'dev_failed', fix: false });
  });
  it.each(['missing', 'stopped'] as const)(
    'refuses a %s dev container as a temporary unavailability through the image inspection',
    async (state) => {
      const facts = {
        canary: vi.fn(async () => ({ canary, current: publication, observedImage: image })),
        retention: async () => [],
      };
      // A running container passes first, so the refusal below comes from the state alone.
      expect(await matchingDev(config, candidate, facts, undefined, now)).toEqual(canary);
      docker.state = state;
      await expect(matchingDev(config, candidate, facts, undefined, now)).rejects.toMatchObject({
        reason: 'source_unavailable',
        fix: false,
        result: 'deferred',
      });
      expect(docker.inspected).toHaveLength(2);
      expect(docker.inspected[1]?.at(-1)).toBe('aircase-dev');
    },
  );
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
    ).rejects.toMatchObject({ reason: 'dev_failed', fix: false });
  });
});

it.each([
  ['P2601', 'lock_lost', 'cancelled'],
  ['P2602', 'restore_hold', 'failed'],
  ['P2603', 'import_cap', 'failed'],
  ['P2604', 'accounting', 'failed'],
  ['P2605', 'alias_unknown', 'failed'],
  ['55000', 'integrity', 'failed'],
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
    reason: 'unclassified',
    result: 'failed',
    fix: true,
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
  ).rejects.toMatchObject({ fix: false, reason: 'source_unavailable' });
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
    fix: false,
    reason: 'source_unavailable',
  });
  expect(sleeps).toEqual([1500, 2500]);
  const forbidden = new AvallSource({
    fetch: async () => new Response('PRIVATE_SENTINEL', { status: 403 }),
    now: () => now,
    sleep: async () => {},
  });
  await expect(forbidden.inspect()).rejects.toMatchObject({
    fix: false,
    reason: 'source_unavailable',
  });
});
