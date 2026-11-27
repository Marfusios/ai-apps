import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { AvallSource, LISTING_URL, ARCHIVE_URL } from '../../worker/importer/source.js';
import { ManagedSpace, FILE_LIMITS } from '../../worker/importer/files.js';
import { hostLock, journalLine } from '../../worker/importer/host.js';
import { ImportFailure, safeLog } from '../../worker/importer/contracts.js';
import { checkDevCanary } from '../../worker/importer/facts.js';
import { certificationClient } from '../../worker/importer/strict-es.js';
import { runCanary } from '../../worker/importer/probes.js';
import { unchangedDecision, classify } from '../../worker/importer/run.js';
import { projectImports } from '../../worker/importer/status.js';
import type { Db } from '../../server/db/client.js';

const now = new Date('2026-10-31T12:00:00Z');
const observation = { advertisedAtLocal: '2026-10-01T07:36:33', bytes: 3 };
const html = (size = 3) =>
  `<table><tr><td>avall.zip</td><td>10/1/2026 7:36:33 AM</td><td>${size}</td><td><a href="/avdata/FileDirectory/DownloadFile?fileID=avall.zip">Download</a></td></tr></table>`;
const manifest = {
  generationId: 1,
  casesIndex: 'x-cases',
  passagesIndex: 'x-passages',
  publishedAt: '2026-10-01T00:00:00.000001Z',
};
const freshManifest = { ...manifest, publishedAt: '2026-10-01T00:00:00.000002Z' };
const archive = 'a'.repeat(64),
  content = 'b'.repeat(64),
  code = 'c'.repeat(40);

async function workspace(fn: (space: ManagedSpace) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'importer-unit-'));
  try {
    await fn(new ManagedSpace(root, { ...FILE_LIMITS, reserve: 0 }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('bounded acquisition and host recovery boundary', () => {
  it('detects different bytes under the same advertised tuple, with no conditional/redirect fetch', async () =>
    workspace(async (space) => {
      let bytes = 'abc';
      const calls: string[] = [];
      const fake = vi.fn(async (url: Parameters<typeof fetch>[0], opts?: RequestInit) => {
        calls.push(String(url));
        expect(opts?.redirect).toBe('manual');
        expect(opts?.headers).toMatchObject({ 'Accept-Encoding': 'identity' });
        return String(url) === LISTING_URL
          ? new Response(html())
          : new Response(bytes, { headers: { 'Content-Length': '3' } });
      });
      const source = new AvallSource({
        fetch: fake as typeof fetch,
        now: () => now,
        sleep: async () => {},
      });
      const first = await source.acquire(observation, space);
      bytes = 'abd';
      const second = await source.acquire(observation, space);
      expect(first.sha256).not.toBe(second.sha256);
      expect(calls.filter((c) => c === ARCHIVE_URL)).toHaveLength(2);
    }));
  it.each(['oversize', 'header', 'race', 'html'])(
    'fails closed on %s and removes its partial file',
    async (problem) =>
      workspace(async (space) => {
        const fake = async (url: Parameters<typeof fetch>[0]) =>
          String(url) === LISTING_URL
            ? new Response(html(problem === 'race' ? 4 : 3))
            : new Response(problem === 'oversize' ? 'abcd' : 'abc', {
                headers: {
                  'Content-Length': problem === 'header' ? '4' : '3',
                  'Content-Type': problem === 'html' ? 'text/html' : 'application/zip',
                },
              });
        const source = new AvallSource({
          fetch: fake as typeof fetch,
          now: () => now,
          sleep: async () => {},
        });
        await expect(source.acquire(observation, space)).rejects.toBeInstanceOf(ImportFailure);
        expect(
          (await readdir(join(space.root, 'archives'))).filter((n) => n.endsWith('.part')),
        ).toEqual([]);
      }),
  );
  it('limits source retries and honors only bounded Retry-After', async () => {
    const fetcher = vi.fn(
        async () => new Response('untrusted', { status: 429, headers: { 'Retry-After': '2' } }),
      ),
      wait = vi.fn(async () => {});
    const source = new AvallSource({ fetch: fetcher as typeof fetch, sleep: wait, now: () => now });
    await expect(source.inspect()).rejects.toMatchObject({ reason: 'source_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toHaveLength(2);
  });
  it('keeps the nonqueuing kernel lock across the helper exit, and releases only when the parent closes', async () =>
    workspace(async (space) => {
      const path = join(space.root, 'test.lock'),
        first = await hostLock(path);
      try {
        await expect(hostLock(path)).rejects.toMatchObject({ reason: 'busy' });
      } finally {
        await first.close();
      }
      const next = await hostLock(path);
      await next.close();
    }));
});

describe('policy/certificate identity and redacted output', () => {
  it('a matching archive is insufficient without the exact recent dev publication and code/image identities', () => {
    const candidate = { archive, content, code, deployedCode: 'sha256:' + 'f'.repeat(64) };
    const c = {
      ...candidate,
      publication: manifest,
      probes: '0'.repeat(64),
      checkedAt: now.toISOString(),
    };
    expect(() => checkDevCanary(c, manifest, candidate, now)).not.toThrow();
    expect(() => checkDevCanary(c, freshManifest, candidate, now)).toThrow();
    expect(() =>
      checkDevCanary(c, manifest, { ...candidate, code: '1'.repeat(40) }, now),
    ).toThrow();
    expect(() =>
      checkDevCanary(c, manifest, candidate, new Date(now.getTime() + 86_400_001)),
    ).toThrow();
  });
  it('manual same-generation publication during the canary invalidates it before the second probe', async () => {
    let current = manifest;
    const db = {
      execute: async () => ({
        rows: [
          {
            generation_id: current.generationId,
            cases_index: current.casesIndex,
            passages_index: current.passagesIndex,
            published_at: current.publishedAt,
          },
        ],
      }),
    } as unknown as Db;
    const app = {
      deployedCode: code,
      read: vi.fn(async () => ({ revision: 'r1', cases: 1, hash: content })),
    };
    await expect(
      runCanary(db, manifest, app, {
        sleep: async () => {
          current = freshManifest;
        },
        durationMs: 1,
      }),
    ).rejects.toMatchObject({ reason: 'baseline_changed' });
    expect(app.read).toHaveBeenCalledTimes(1);
  });
  it('does not let a local verification or recent listing discharge the unconditional refresh debt', () => {
    const accepted = { archive, content, csvHash: content, manifest, observation, code };
    expect(unchangedDecision(accepted, observation, null, now)).toBe(false);
    expect(
      unchangedDecision(
        accepted,
        observation,
        new Date(now.getTime() - 7 * 86_400_000).toISOString(),
        now,
      ),
    ).toBe(false);
    expect(unchangedDecision(accepted, observation, now.toISOString(), now)).toBe(true);
  });
  it.each([
    'HTML listing',
    'CSV diagnostic',
    'normalizer',
    'ES bulk reason',
    'SQL',
    'provider key',
    'cleanup',
    'probe body',
  ])('drops %s sentinels and nested error causes', (label) => {
    const secret = `PRIVATE_SENTINEL_${label}`,
      error = new Error(secret, { cause: new Error(secret) });
    const classified = classify(error);
    expect(safeLog('check', 'needs_review', classified.reason)).not.toContain('PRIVATE_SENTINEL');
    expect(
      journalLine(
        JSON.stringify({ step: 'check', result: 'failed', reason: 'integrity', error: secret }),
      ),
    ).toBeNull();
    expect(
      journalLine(JSON.stringify({ step: 'check', result: 'failed', reason: secret })),
    ).toBeNull();
    expect(journalLine(secret)).toBeNull();
    expect(classified.cause).toBeUndefined();
  });
  it('shows an unresolved restore even when there has never been an import run', () => {
    expect(
      projectImports(
        [],
        { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' },
        now,
        true,
      ),
    ).toMatchObject({
      status:'fix',alert:{cause:'status_unavailable'},lastCheck:null,lastGoodCheck:null,
    });
  });
  it('defers an unknown alias for bounded reconciliation without treating it as confirmed bad data', () => {
    const error = new Error('PRIVATE_SENTINEL');
    error.name = 'AliasSwitchError';
    expect(classify(error)).toMatchObject({ reason: 'alias_unknown', fix: true });
  });
  it('rejects incomplete pages and capped aggregation buckets despite HTTP success', async () => {
    const response = {
      _shards: { total: 1, successful: 1, failed: 0 },
      timed_out: false,
      hits: { total: { value: 2, relation: 'eq' }, hits: [] },
      aggregations: {},
    };
    const es = certificationClient({ search: async () => response } as unknown as Client);
    await expect(es.search({ size: 1 })).rejects.toBeInstanceOf(ImportFailure);
    response.hits.total.value = 0;
    response.aggregations = { kinds: { sum_other_doc_count: 1, buckets: [] } };
    await expect(es.search({ size: 0 })).rejects.toBeInstanceOf(ImportFailure);
  });
});
