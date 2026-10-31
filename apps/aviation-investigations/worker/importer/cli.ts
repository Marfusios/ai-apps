/** Internal child entry: invoke through `pnpm importer`, whose host locks and redacting journal wrap this process. */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { fstatSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readImporterConfig } from './config.js';
import { ImportFailure, safeLog, SourceSchema } from './contracts.js';
import { runImport } from './run.js';
import { operatorCommand } from './commands.js';
import { ManagedSpace } from './files.js';
import { recordSkippedLive } from './recovery.js';
import { recoveryCommand } from './operations.js';
import { classify } from './failure.js';

async function main(): Promise<void> {
  process.umask(0o077);
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      env: { type: 'string' },
      'cache-only': { type: 'boolean' },
      'no-change': { type: 'boolean' },
      'forced-dev': { type: 'boolean' },
      'seed-archive': { type: 'string' },
      sha256: { type: 'string' },
      'seed-advertised-at': { type: 'string' },
      approval: { type: 'string' },
      artifact: { type: 'string' },
      'publication-sha256': { type: 'string' },
      run: { type: 'string' },
      'evidence-sha256': { type: 'string' },
      apply: { type: 'boolean' },
    },
  });
  if (
    !values.config ||
    !['dev', 'live'].includes(values.env ?? '') ||
    positionals.length !== 1
  )
    throw new ImportFailure('configuration');
  const config = await readImporterConfig(values.config),
    environment = values.env as 'dev' | 'live';
  // The inherited descriptors keep both kernel locks alive if the host disappears. Direct bypass refuses.
  for (const [index, path] of [config.hostLock, config.maintenanceLock].entries()) {
    const fd = 3 + index,
      opened = fstatSync(fd),
      named = lstatSync(path);
    if (
      !opened.isFile() ||
      named.isSymbolicLink() ||
      opened.ino !== named.ino ||
      opened.dev !== named.dev ||
      spawnSync('flock', ['--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd],
        timeout: 5000,
      }).status !== 0
    )
      throw new ImportFailure('configuration');
  }
  const deadline = Number(process.env.AIRCASE_IMPORT_DEADLINE);
  if (
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now() ||
    deadline > Date.now() + 3 * 3_600_000
  )
    throw new ImportFailure('configuration');
  setTimeout(
    () => process.kill(process.pid, 'SIGTERM'),
    Math.max(1, deadline - Date.now() - 120_000),
  ).unref();
  setTimeout(() => process.exit(124), Math.max(1, deadline - Date.now() - 90_000)).unref();
  const seed = () => {
    if (
      Boolean(values['seed-archive']) !== Boolean(values.sha256) ||
      Boolean(values['seed-archive']) !== Boolean(values['seed-advertised-at'])
    )
      throw new ImportFailure('configuration');
    return values['seed-archive']
      ? {
          path: values['seed-archive'],
          sha256: values.sha256!,
          observation: SourceSchema.parse({
            advertisedAtLocal: values['seed-advertised-at'],
            bytes: lstatSync(values['seed-archive']).size,
          }),
        }
      : undefined;
  };
  if (positionals[0] === 'record-skip' && environment === 'live') {
    await recordSkippedLive(config);
    return;
  }
  if (positionals[0] === 'run' || positionals[0] === 'recertify') {
    const report = await runImport(config, {
      environment,
      cacheOnly: positionals[0] === 'recertify' || values['cache-only'] === true,
      recertify: positionals[0] === 'recertify',
      noChange: values['no-change'],
      forcedDev: values['forced-dev'],
      seed: seed(),
    });
    await new ManagedSpace(config.root).json(
      join(config.root, `last-${environment}.json`),
      report,
    );
    process.stdout.write(`${safeLog('complete', report.result, report.reason)}\n`);
    return;
  }
  if (positionals[0] === 'rebaseline' && values['publication-sha256']) {
    await recoveryCommand(config, environment, {
      command: 'rebaseline',
      publication: values['publication-sha256'],
      apply: values.apply === true,
      seed: seed(),
    });
    process.stdout.write(`${safeLog('complete', 'deferred', null)}\n`);
    return;
  }
  if (
    positionals[0] === 'acknowledge-preartifact' &&
    values.run &&
    values['evidence-sha256']
  ) {
    await recoveryCommand(config, environment, {
      command: 'acknowledge-preartifact',
      run: values.run,
      evidence: values['evidence-sha256'],
      apply: values.apply === true,
    });
    process.stdout.write(`${safeLog('complete', 'deferred', null)}\n`);
    return;
  }
  if ((positionals[0] === 'approve' || positionals[0] === 'rollback') && values.artifact) {
    await operatorCommand(config, environment, positionals[0], values.artifact, {
      approval: values.approval,
      publicationHash: values['publication-sha256'],
    });
    process.stdout.write(
      `${safeLog('complete', positionals[0] === 'rollback' ? 'rolled_back' : 'deferred', null)}\n`,
    );
    return;
  }
  throw new ImportFailure('configuration');
}
main()
  .catch((error) => {
    const e = classify(error);
    if (!e.logged) process.stdout.write(`${safeLog('check', e.result, e.reason)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (process.connected) process.disconnect();
  });
