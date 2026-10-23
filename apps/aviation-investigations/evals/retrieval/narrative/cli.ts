/**
 * `pnpm eval:retrieval:narrative <command>`: the narrative-relevance track (Track N of
 * the task 10c protocol v4).
 *
 *   build [--generation <id>] [--out <file>] [--dry-run | --check]
 *
 * Common options: `--env-files a,b` (as the other evaluation commands).
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { APP_DIR } from '../../../worker/config.js';
import { describeWorkerError } from '../../../worker/errors.js';
import { evalConfig } from '../config.js';
import { buildCommand } from './build.js';

const USAGE = 'usage: pnpm eval:retrieval:narrative build [--env-files <a,b>] [--generation <id>] [--out <file>] [--dry-run | --check]';

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'env-files': { type: 'string' },
      generation: { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean' },
      check: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0];
  if (command !== 'build' || positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }
  const config = evalConfig(values['env-files']);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  let generation: number | undefined;
  if (values.generation !== undefined) {
    generation = Number(values.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('--generation must be a positive integer');
  }
  return buildCommand({
    databaseUrl: config.databaseUrl,
    ...(generation !== undefined ? { generation } : {}),
    ...(values.out ? { out: values.out } : {}),
    check: values.check === true,
    dryRun: values['dry-run'] === true,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(APP_DIR, 'evals/retrieval/narrative/cli.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(describeWorkerError(err));
      process.exit(1);
    },
  );
}
