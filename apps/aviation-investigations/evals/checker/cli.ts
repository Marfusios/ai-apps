/**
 * `pnpm eval:checker <command>`: the evidence checker's calibration (Tasks 16c and 16d; gate G6).
 *
 *   retrieve  [--confirm-cost] [--questions v1|16d] [--out <file>]   real retrieval bundles (and case headers)
 *   headers   [--out <file>]                         free: case headers of every calibration case (read-only)
 *   build     [--check]                              evidence + items → dataset.v2.json (dataset.json stays frozen)
 *   simulate  [--dir16c <dir>] [--dir16d <dir>] [--write]  free: the 16c and 16d recordings through the display projection
 *   excerpts  [--write]                              free: the excerpt-context policy on its labelled corpora
 *   inventory --candidate <name> --split dev|holdout free: token counts, expected and worst-case cost
 *   run       --candidate <name> --split dev|holdout [--confirm-cost] [--resume <manifest>]
 *   select    <dev summary.json>...                   the frozen selection rule → selection.v2.json
 *
 * Common options: `--env-files a,b` (as the evaluations': the dev connection files),
 * `--keys-file <file>` (only `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are read from it,
 * never over a nonempty process value; values are never printed).
 *
 * Paid calls only with `--confirm-cost`, each attempt reserved and settled on the
 * evaluation ledger (`DATABASE_INGEST_URL`); every paid 16d step is appended to
 * `data/work/checker/spend-16d.jsonl`, and a step whose reservation would take the logged
 * total above `BUDGET_V2_USD` refuses before anything is sent. The held-out split runs
 * once, for the candidate frozen in `selection.v2.json`.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { readDotenvAllowlisted } from '../../shared/env-files.js';
import { APP_DIR, workerConfig } from '../../worker/config.js';
import { describeWorkerError } from '../../worker/errors.js';

const USAGE = [
  'usage: pnpm eval:checker retrieve [--confirm-cost] [--questions v1|16d] [--out <file>]',
  '       pnpm eval:checker headers [--out <file>]',
  '       pnpm eval:checker build [--check]',
  '       pnpm eval:checker simulate [--dir16c <dir>] [--dir16d <dir>] [--write]',
  '       pnpm eval:checker excerpts [--write]',
  '       pnpm eval:checker inventory --candidate <name> --split dev|holdout',
  '       pnpm eval:checker run --candidate <name> --split dev|holdout [--confirm-cost] [--resume <manifest>]',
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
      candidate: { type: 'string' },
      split: { type: 'string' },
      resume: { type: 'string' },
      dir16c: { type: 'string' },
      dir16d: { type: 'string' },
      write: { type: 'boolean' },
      questions: { type: 'string' },
    },
    strict: true,
  });
  const log = (m: string) => console.log(m);
  if (command === 'retrieve') {
    const { DEFAULT_EVIDENCE, retrieveEvidence } = await import('./retrieve.js');
    const config = checkerConfig(values['env-files'], values['keys-file']);
    const set = values.questions ?? 'v1';
    if (set !== 'v1' && set !== '16d') {
      console.error(USAGE);
      return 2;
    }
    return retrieveEvidence(config, { confirmCost: values['confirm-cost'] === true, set, out: values.out ? resolve(values.out) : DEFAULT_EVIDENCE[set], log });
  }
  if (command === 'headers') {
    const { headersCommand } = await import('./retrieve.js');
    const config = checkerConfig(values['env-files'], values['keys-file']);
    return headersCommand(config, { ...(values.out ? { out: resolve(values.out) } : {}), log });
  }
  if (command === 'build') {
    const { buildDataset } = await import('./build.js');
    return buildDataset({ check: values.check === true, log });
  }
  if (command === 'simulate') {
    const { DEFAULT_RECORDINGS, simulateCommand } = await import('./simulate.js');
    const dirs = {
      '16c': values.dir16c ? resolve(values.dir16c) : DEFAULT_RECORDINGS['16c'],
      '16d': values.dir16d ? resolve(values.dir16d) : DEFAULT_RECORDINGS['16d'],
    };
    return simulateCommand({ dirs, write: values.write === true, log });
  }
  if (command === 'excerpts') {
    const { excerptsCommand } = await import('./excerpts.js');
    return excerptsCommand({ write: values.write === true, log });
  }
  if (command === 'inventory' || command === 'run') {
    const { inventoryCommand, runCommand } = await import('./run.js');
    const config = checkerConfig(values['env-files'], values['keys-file']);
    const candidate = values.candidate ?? '';
    const split = values.split ?? 'dev';
    if (!candidate || (split !== 'dev' && split !== 'holdout')) {
      console.error(USAGE);
      return 2;
    }
    if (command === 'inventory') return inventoryCommand(config, { candidate, split, log });
    return runCommand(config, { candidate, split, confirmCost: values['confirm-cost'] === true, ...(values.resume ? { resume: values.resume } : {}), log });
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
