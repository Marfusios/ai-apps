import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ConfigResponseSchema } from '../../shared/contracts/config.js';
import { SearchResponseSchema } from '../../shared/contracts/search.js';
import { DashboardResponseSchema } from '../../shared/contracts/dashboard.js';
import { CaseDetailSchema } from '../../shared/contracts/cases.js';
import { ImportFailure, type ManifestIdentity } from './contracts.js';
import { digest } from './provenance.js';
import type { ApplicationProbe } from './probes.js';
import type { ImporterConfig } from './config.js';

const exec = promisify(execFile);
/** Cheap availability check before any candidate work; the full contract is checked by the canary. */
export async function applicationAvailable(
  config: ImporterConfig['dev'],
  http: typeof fetch = globalThis.fetch,
): Promise<void> {
  try {
    const response = await http(new URL('/api/config', config.applicationUrl), {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'AirCase-snapshot-canary/1.0',
      },
    });
    await response.body?.cancel();
    if (response.status !== 200) throw new ImportFailure('source_unavailable', false);
  } catch {
    throw new ImportFailure('source_unavailable', false);
  }
}
export async function deployedImage(config: ImporterConfig['dev']): Promise<string> {
  try {
    const r = await exec(
      'docker',
      [
        'inspect',
        '--type',
        'container',
        '--format',
        '{{.Image}} {{.State.Running}}',
        config.container,
      ],
      { timeout: 10_000, maxBuffer: 1024 },
    );
    if (r.stdout.trim() !== `${config.image} true`)
      throw new ImportFailure('source_unavailable', false);
    return config.image;
  } catch {
    throw new ImportFailure('source_unavailable', false);
  }
}
export async function workerIdentity(expected: string, cwd: string): Promise<void> {
  try {
    const head = await exec('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024,
    });
    const status = await exec('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (head.stdout.trim() !== expected || status.stdout.trim())
      throw new ImportFailure('configuration', false);
  } catch {
    throw new ImportFailure('configuration', false);
  }
}
/** The actual public GET read paths. No cookies, identity, AI endpoints or provider clients. */
export function applicationProbe(
  config: ImporterConfig['dev'],
  indexVersion: string,
  expectedCounts: { cases: number; eligible: number },
  http: typeof fetch = globalThis.fetch,
): ApplicationProbe {
  async function read(path: string): Promise<string> {
    try {
      const r = await http(new URL(path, config.applicationUrl), {
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Cache-Control': 'no-cache',
          'User-Agent': 'AirCase-snapshot-canary/1.0',
        },
      });
      if (r.status !== 200) {
        await r.body?.cancel();
        throw new ImportFailure('source_unavailable', false);
      }
      if (!r.body) throw new ImportFailure('probe');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const b of r.body) {
        bytes += b.length;
        if (bytes > 8 * 1024 ** 2) throw new ImportFailure('probe');
        chunks.push(b);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch (e) {
      if (e instanceof ImportFailure) throw e;
      throw new ImportFailure('source_unavailable', false);
    }
  }
  return {
    deployedCode: config.image,
    async read(expected: ManifestIdentity) {
      await deployedImage(config);
      const suffix = createHash('sha256')
        .update(`${expected.casesIndex}\n${expected.passagesIndex}`)
        .digest('hex')
        .slice(0, 8);
      const revision = `g${expected.generationId}-${indexVersion}-${suffix}`;
      try {
        const c = ConfigResponseSchema.parse(JSON.parse(await read('/api/config')));
        // Cache propagation is retried by the orchestrator; no rollback based on a stale response.
        if (c.datasetRevision !== revision)
          throw new ImportFailure('source_unavailable', false);
        if (
          c.coverage.defaultCohort !== expectedCounts.eligible ||
          c.coverage.defaultCohort + c.coverage.otherRecords !== expectedCounts.cases
        )
          throw new ImportFailure('probe');
        const search = SearchResponseSchema.parse(JSON.parse(await read('/api/search')));
        const dashboard = DashboardResponseSchema.parse(
          JSON.parse(await read('/api/dashboard')),
        );
        const detail = CaseDetailSchema.parse(JSON.parse(await read('/api/cases/DFW08TA066')));
        if (
          [
            search.dataset.revision,
            dashboard.dataset.revision,
            detail.provenance.datasetRevision,
          ].some((r) => r !== revision)
        ) {
          throw new ImportFailure('source_unavailable', false);
        }
        if (
          search.total !== expectedCounts.eligible ||
          dashboard.total !== expectedCounts.eligible
        )
          throw new ImportFailure('probe');
        const page = await read('/cases/DFW08TA066'),
          sitemap = await read('/sitemap.xml');
        if (
          !page.includes('DFW08TA066') ||
          !page.includes('<title>') ||
          !sitemap.includes('<sitemapindex')
        )
          throw new ImportFailure('probe');
        await deployedImage(config);
        return {
          revision,
          cases: expectedCounts.cases,
          hash: digest([revision, c.coverage, search.total, dashboard.total]),
        };
      } catch (e) {
        if (e instanceof ImportFailure) throw e;
        throw new ImportFailure('probe');
      }
    },
  };
}
export async function propagate(
  app: ApplicationProbe,
  expected: ManifestIdentity,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const now = options.now ?? Date.now,
    sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    deadline = now() + 300_000;
  for (;;) {
    try {
      await app.read(expected);
      return;
    } catch (e) {
      if (!(e instanceof ImportFailure) || e.review || now() >= deadline) throw e;
      await sleep(10_000);
    }
  }
}
