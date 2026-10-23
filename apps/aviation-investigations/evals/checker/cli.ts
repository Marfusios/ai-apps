/**
 * `pnpm eval:checker <command>`: the evidence checker's calibration (Task 16c; gate G6).
 *
 *   retrieve  [--confirm-cost] [--out <file>]       real retrieval bundles → evidence.json
 *   build     [--check]                             evidence.json + items → dataset.json
 *   inventory --config <name>[,<name>] [--split dev|holdout]   free: token counts, prices
 *   run       --config <name> --split dev|holdout [--samples <n>] [--confirm-cost] [--resume <trials.jsonl>]
 *   select    <dev summary.json>...                  the selection rule → selection.json
 *
 * Common options: `--env-files a,b` (as the evaluations': the dev connection files),
 * `--keys-file <file>` (only `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are read from it,
 * never over a nonempty process value; values are never printed).
 *
 * Paid calls only with `--confirm-cost`, each attempt reserved and settled on the
 * evaluation ledger (`DATABASE_INGEST_URL`); every paid step is appended to
 * `data/work/checker/spend.jsonl`, and a step whose reservations would take the logged
 * total above `CALIBRATION_LIMIT_USD` refuses before anything is sent. The held-out split
 * runs once, for the configuration frozen in `selection.json`.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { readDotenvAllowlisted } from '../../shared/env-files.js';
import { APP_DIR, workerConfig } from '../../worker/config.js';
import { describeWorkerError } from '../../worker/errors.js';
import { SUPPORTED_SAMPLES } from './protocol.js';
import { DEFAULT_EVIDENCE, retrieveEvidence } from './retrieve.js';

const USAGE = [
  'usage: pnpm eval:checker retrieve [--confirm-cost] [--out <file>]',
  '       pnpm eval:checker build [--check]',
  '       pnpm eval:checker inventory --config <name>[,<name>] [--split dev|holdout]',
  '       pnpm eval:checker run --config <name> --split dev|holdout [--samples <n>] [--confirm-cost] [--resume <trials.jsonl>]',
  '       pnpm eval:checker select <dev summary.json>...',
  'common: [--env-files <a,b>] [--keys-file <file>]',
].join('\n');

/** Configuration: the env files given (or the worker's), with provider keys from `--keys-file` under nonempty process values. */
export function checkerConfig(envFiles: string | undefined, keysFile: string | undefined): AppConfig {
  const env = { ...process.env };
  if (keysFile) {
    const keys = readDotenvAllowlisted(resolve(keysFile), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
    for (const [k, v] of Object.entries(keys)) if (!env[k]) env[k] = v;
  }
  if (envFiles === undefined) return workerConfig(env);
  const files = envFiles
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => resolve(APP_DIR, f));
  return loadConfig({ env, files });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'select') {
    const { selectCommand } = await import('./run.js');
    return selectCommand(rest, (m) => console.log(m));
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      'env-files': { type: 'string' },
      'keys-file': { type: 'string' },
      'confirm-cost': { type: 'boolean' },
      out: { type: 'string' },
      check: { type: 'boolean' },
      config: { type: 'string' },
      split: { type: 'string' },
      samples: { type: 'string' },
      resume: { type: 'string' },
    },
    strict: true,
  });
  const log = (m: string) => console.log(m);
  if (command === 'retrieve') {
    const config = checkerConfig(values['env-files'], values['keys-file']);
    return retrieveEvidence(config, { confirmCost: values['confirm-cost'] === true, out: values.out ? resolve(values.out) : DEFAULT_EVIDENCE, log });
  }
  if (command === 'build') {
    const { buildDataset } = await import('./build.js');
    return buildDataset({ check: values.check === true, log });
  }
  if (command === 'inventory' || command === 'run') {
    const { inventoryCommand, runCommand } = await import('./run.js');
    const config = checkerConfig(values['env-files'], values['keys-file']);
    const names = (values.config ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const split = values.split ?? 'dev';
    if (names.length === 0 || (split !== 'dev' && split !== 'holdout')) {
      console.error(USAGE);
      return 2;
    }
    if (command === 'inventory') return inventoryCommand(config, { configs: names, split, log });
    const samples = values.samples === undefined ? SUPPORTED_SAMPLES : Number(values.samples);
    if (names.length !== 1 || !Number.isInteger(samples) || samples < 1 || samples > SUPPORTED_SAMPLES) {
      console.error(USAGE);
      return 2;
    }
    return runCommand(config, {
      config: names[0]!,
      split,
      samples,
      confirmCost: values['confirm-cost'] === true,
      ...(values.resume ? { resume: values.resume } : {}),
      log,
    });
  }
  console.error(USAGE);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(APP_DIR, 'evals/checker/cli.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(describeWorkerError(err));
      process.exit(1);
    },
  );
}
