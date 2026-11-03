import { afterEach, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import {
  environmentConfig,
  providerKey,
  readImporterConfig,
  WORKER_VARS,
  type ImporterConfig,
} from '../../worker/importer/config.js';
import { ManagedSpace, FILE_LIMITS } from '../../worker/importer/files.js';
import { spoolFailure, OutageSchema } from '../../worker/importer/recovery.js';
import {
  ImportFailure,
  sourceReminder,
  SOURCE_REMINDER,
  SOURCE_CUTOFF,
} from '../../worker/importer/contracts.js';
afterEach(() => vi.unstubAllEnvs());
async function withConfig(fn: (c: ImporterConfig) => Promise<void>) {
  for (const name of [...WORKER_VARS, 'OPENAI_API_KEY']) vi.stubEnv(name, undefined);
  const root = await mkdtemp(join(tmpdir(), 'importer-config-')),
    env = join(root, 'worker.env');
  await writeFile(
    env,
    [
      'APP_ENV=dev',
      'DATABASE_INGEST_URL=postgres://synthetic:offline@localhost/aviation_dev?options=-c%20role%3Daviation_ingest',
      'ELASTICSEARCH_URL=http://localhost:9200',
      'ELASTICSEARCH_WRITE_API_KEY=synthetic-offline-only',
      'ELASTICSEARCH_INDEX_PREFIX=ai-aviation-dev',
      'AI_MONTHLY_BUDGET_USD=100',
      'AI_INTERACTIVE_MONTHLY_BUDGET_USD=80',
      'AI_INGESTION_MONTHLY_BUDGET_USD=20',
      'AVIATION_TRACING_ENABLED=true',
      'LANGFUSE_SECRET_KEY=PRIVATE_SENTINEL',
      'BETTER_AUTH_SECRET=PRIVATE_SENTINEL',
      'OPENAI_API_KEY="unterminated',
    ].join('\n'),
    { mode: 0o600 },
  );
  const c: ImporterConfig = {
    version: 'snapshot-importer.v1',
    root,
    hostLock: join(root, 'host'),
    maintenanceLock: join(root, 'backup'),
    code: 'a'.repeat(40),
    installation: null,
    schedule: { enabled: false, localTime: '05:30', timeZone: 'Europe/Prague' },
    dev: {
      envFiles: [env],
      applicationUrl: 'http://localhost:3000',
      container: 'synthetic',
      image: 'sha256:' + 'b'.repeat(64),
    },
  };
  try {
    await fn(c);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
it('never reads a provider key before misses need it, drops unrelated secrets and forcibly disables tracing', async () =>
  withConfig(async (c) => {
    const app = environmentConfig(c, 'dev');
    expect(JSON.stringify(app)).not.toContain('PRIVATE_SENTINEL');
    expect(app.tracing.enabled).toBe(false);
    expect(() => providerKey(c, 'dev')).toThrow();
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-process-value');
    expect(() => providerKey(c, 'dev')).toThrow();
  }));
it('preserves process values and refuses a mixed project or disagreeing schedule', async () =>
  withConfig(async (c) => {
    vi.stubEnv('AI_INGESTION_MONTHLY_BUDGET_USD', '10');
    expect(environmentConfig(c, 'dev').ai.budgets.ingestionMonthlyUsd).toBe(10);
    vi.stubEnv('APP_ENV', 'live');
    expect(() => environmentConfig(c, 'dev')).toThrow();
    expect(environmentConfig(c, 'dev', true).appEnv).toBe('dev');
    vi.stubEnv('APP_ENV', 'dev');
    expect(() =>
      environmentConfig({ ...c, schedule: { ...c.schedule, enabled: true } }, 'dev'),
    ).toThrow();
  }));
it.each([
  ['/aviation_dev', '/aviation_live'],
  ['role%3Daviation_ingest', 'role%3Daviation_migrator'],
  ['role%3Daviation_ingest', 'role%3Daviation_ingest%20-c%20role%3Daviation_migrator'],
  ['role%3Daviation_ingest', 'role%3Daviation_ingest&options=-c%20role%3Daviation_migrator'],
  ['ELASTICSEARCH_INDEX_PREFIX=ai-aviation-dev', 'ELASTICSEARCH_INDEX_PREFIX=ai-aviation-live'],
])('refuses an inconsistent %s before connecting', async (from, to) =>
  withConfig(async (c) => {
    const path = c.dev.envFiles[0]!;
    await writeFile(path, (await readFile(path, 'utf8')).replace(from, to), { mode: 0o600 });
    expect(() => environmentConfig(c, 'dev')).toThrow(ImportFailure);
  }),
);
it('keeps one strict bounded outage record without replacing unresolved artifact evidence', async () =>
  withConfig(async (c) => {
    const space = new ManagedSpace(c.root, { ...FILE_LIMITS, reserve: 0 });
    await spoolFailure(
      space,
      'dev',
      new ImportFailure('integrity'),
      'extract',
      null,
      '00000000-0000-4000-8000-000000000001',
    );
    await spoolFailure(space, 'dev', new ImportFailure('busy'), 'check');
    const raw = JSON.parse(await readFile(join(c.root, 'status-dev.json'), 'utf8'));
    expect(OutageSchema.parse(raw).reason).toBe('integrity');
    expect(OutageSchema.safeParse({ ...raw, error: 'PRIVATE_SENTINEL' }).success).toBe(false);
  }));
it('emits a fixed March reminder and stops that reminder at the acquisition cutoff', () => {
  expect(sourceReminder(new Date(SOURCE_REMINDER - 1))).toBeNull();
  expect(sourceReminder(new Date(SOURCE_REMINDER))).toBe(
    '{"event":"source_transition_reminder","cutoff":"2027-04-05T00:00:00Z"}',
  );
  expect(sourceReminder(new Date(SOURCE_CUTOFF))).toBeNull();
});

it('refuses different image pins, symlinked configs and a configuration owned by an unsafe mode', async () =>
  withConfig(async (c) => {
    const path = join(c.root, 'config.json');
    const config = {
      ...c,
      root: join(c.root, 'workspace'),
      live: { ...c.dev, image: 'sha256:' + 'c'.repeat(64) },
    };
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    await expect(readImporterConfig(path)).rejects.toThrow('configuration');
    config.live.image = c.dev.image;
    await writeFile(path, JSON.stringify(config));
    await expect(readImporterConfig(path)).resolves.toMatchObject({ code: c.code });
    await symlink(path, join(c.root, 'link.json'));
    await expect(readImporterConfig(join(c.root, 'link.json'))).rejects.toThrow('configuration');
    await chmod(path, 0o644);
    await expect(readImporterConfig(path)).rejects.toThrow('configuration');
  }));

it.each(['hostLock', 'maintenanceLock'] as const)(
  'validates the %s parent before accepting the importer configuration',
  async (name) =>
    withConfig(async (c) => {
      const parent = join(c.root, 'locks');
      await mkdir(parent, { mode: 0o700 });
      const configPath = join(c.root, 'config.json');
      const config = { ...c, root: join(c.root, 'workspace'), [name]: join(parent, 'import.lock') };
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

      for (const mode of [0o700, 0o750, 0o755]) {
        await chmod(parent, mode);
        await expect(readImporterConfig(configPath)).resolves.toMatchObject({
          [name]: config[name],
        });
      }
      for (const mode of [0o720, 0o702, 0o777, 0o1777]) {
        await chmod(parent, mode);
        await expect(readImporterConfig(configPath)).rejects.toThrow(/^configuration$/);
      }
      await chmod(parent, 0o700);

      const link = join(c.root, 'lock-link');
      await symlink(parent, link);
      for (const invalidParent of [link, join(c.root, 'absent'), c.dev.envFiles[0]!]) {
        await writeFile(
          configPath,
          JSON.stringify({ ...config, [name]: join(invalidParent, 'import.lock') }),
        );
        await expect(readImporterConfig(configPath)).rejects.toThrow(/^configuration$/);
      }
    }),
);

// Non-root runs can use the root-owned filesystem directory to prove the owner check
// without chown, elevated privileges, mocked filesystem data or creating a lock there.
it.skipIf(!process.getuid || process.getuid() === 0).each(['hostLock', 'maintenanceLock'] as const)(
  'refuses a foreign-owned %s parent even without group or other write permission',
  async (name) =>
    withConfig(async (c) => {
      const foreignParent = parse(c.root).root;
      const parent = await lstat(foreignParent);
      expect(parent.uid).not.toBe(process.getuid!());
      expect(parent.isDirectory()).toBe(true);
      expect(parent.mode & 0o022).toBe(0);
      const configPath = join(c.root, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          ...c,
          root: join(c.root, 'workspace'),
          [name]: join(foreignParent, 'aircase-config-test.lock'),
        }),
        { mode: 0o600 },
      );
      await expect(readImporterConfig(configPath)).rejects.toThrow(/^configuration$/);
    }),
);

it('uses only the selected environment provider account, even with a process key', async () =>
  withConfig(async (c) => {
    await writeFile(c.dev.envFiles[0]!, 'OPENAI_API_KEY=synthetic-dev\n', { mode: 0o600 });
    const live = join(c.root, 'live.env');
    await writeFile(live, 'OPENAI_API_KEY=synthetic-live\n', { mode: 0o600 });
    c.live = { ...c.dev, envFiles: [live] };
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-process');
    expect(providerKey(c, 'dev')).toBe('synthetic-dev');
    expect(providerKey(c, 'live')).toBe('synthetic-live');
  }));

it('does not open another environment file while loading the selected worker', async () =>
  withConfig(async (config) => {
    config.live = { ...config.dev, envFiles: [join(config.root, 'must-not-be-opened.env')] };
    expect(environmentConfig(config, 'dev').appEnv).toBe('dev');
    await writeFile(config.dev.envFiles[0]!, 'OPENAI_API_KEY=synthetic-dev\n', { mode: 0o600 });
    expect(providerKey(config, 'dev')).toBe('synthetic-dev');
  }));

it('unregisters removed managed paths before the bounded registry can fill', async () =>
  withConfig(async (c) => {
    const space = new ManagedSpace(c.root, { ...FILE_LIMITS, reserve: 0 });
    for (let n = 0; n < 520; n++) {
      const name = `archives/${n.toString(16).padStart(64, '0')}`;
      await space.register(name);
      await space.remove(join(c.root, name));
    }
    expect(await space.registered()).toEqual([]);
  }));
