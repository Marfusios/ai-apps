/**
 * `pnpm eval:retrieval:narrative <command>`: the narrative-relevance track (Track N of
 * the task 10c protocol v4). Scores are model-judged, never expert-adjudicated.
 *
 *   build         [--generation <id>] [--out <file>] [--dry-run | --check]   the question set (PostgreSQL, read-only)
 *   calibration   --generation <id> [--out <file>] [--check]                 the calibration sets, labels frozen
 *   plan          [--samples 1|3]                                            the free dry run: preflight, inventory, cost
 *   pools         [--samples 1|3] [--confirm-cost --allocation <name>]       paid: scope samples and query embeddings; builds the pools
 *   judge         --set calibration --split dev|holdout [--confirm-cost --allocation <name>]
 *   judge         --set relevance --pools <file> [--stage 1|2] [--confirm-cost --allocation <name>]
 *   answerability --pools <file> [--confirm-cost --allocation <name>]
 *   report        [--pools <file>] --judgments <a,b,...>                     free: metrics and diagnostics
 *
 * Common options: `--env-files a,b` (as the other evaluation commands), `--keys-file
 * <file>` (only `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are read from it, never over a
 * nonempty process value), `--out-dir` (default `data/work/narrative`). Paid options:
 * `--allocation <name>` (required with `--confirm-cost`: the phase or month budget, its
 * cap given once with `--allocation-usd`), `--max-usd` (this run's own limit),
 * `--concurrency`, `--max-escalation-share` (at most 0.25 for pools). Without
 * `--confirm-cost` a paid command prints its plan and sends nothing.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { APP_DIR } from '../../../worker/config.js';
import { describeWorkerError } from '../../../worker/errors.js';
import { evalConfig } from '../config.js';
import { experimentAppConfig } from '../experiments/cli.js';
import { buildCommand, calibrationCommand } from './build.js';
import { judgeCommand, planCommand, poolsCommand, reportCommand } from './commands.js';

export const USAGE = [
  'usage: pnpm eval:retrieval:narrative build [--env-files <a,b>] [--generation <id>] [--out <file>] [--dry-run | --check]',
  '       pnpm eval:retrieval:narrative calibration [--env-files <a,b>] --generation <id> [--out <file>] [--check]',
  '       pnpm eval:retrieval:narrative plan [--env-files <a,b>] [--keys-file <file>] [--samples 1|3] [--out-dir <dir>]',
  '       pnpm eval:retrieval:narrative pools [--samples 1|3] [--max-usd <usd>] [--confirm-cost --allocation <name> [--allocation-usd <usd>]] ...',
  '       pnpm eval:retrieval:narrative judge --set calibration --split dev|holdout [--max-usd <usd>] [--concurrency <n>] [--confirm-cost --allocation <name> [--allocation-usd <usd>]] ...',
  '       pnpm eval:retrieval:narrative judge --set relevance --pools <file> [--stage 1|2] [--max-usd <usd>] [--concurrency <n>] [--max-escalation-share <share>] [--confirm-cost --allocation <name>] ...',
  '       pnpm eval:retrieval:narrative answerability --pools <file> [--confirm-cost --allocation <name>] ...',
  '       pnpm eval:retrieval:narrative report [--pools <file>] --judgments <a,b,...> [--out-dir <dir>]',
].join('\n');

const COMMANDS = ['build', 'calibration', 'plan', 'pools', 'judge', 'answerability', 'report'] as const;
type Command = (typeof COMMANDS)[number];

const positiveNumber = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
};

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'env-files': { type: 'string' },
      'keys-file': { type: 'string' },
      generation: { type: 'string' },
      out: { type: 'string' },
      'out-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      check: { type: 'boolean' },
      samples: { type: 'string' },
      set: { type: 'string' },
      split: { type: 'string' },
      pools: { type: 'string' },
      judgments: { type: 'string' },
      'max-usd': { type: 'string' },
      concurrency: { type: 'string' },
      'max-escalation-share': { type: 'string' },
      'confirm-cost': { type: 'boolean' },
      stage: { type: 'string' },
      allocation: { type: 'string' },
      'allocation-usd': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0] as Command | undefined;
  if (!command || !(COMMANDS as readonly string[]).includes(command) || positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }
  const samples = values.samples === undefined ? 3 : Number(values.samples);
  if (samples !== 1 && samples !== 3) {
    console.error('--samples is 1 or 3');
    return 2;
  }
  const split = values.split as 'dev' | 'holdout' | 'all' | undefined;
  if (split !== undefined && !['dev', 'holdout', 'all'].includes(split)) {
    console.error('--split is dev, holdout or all');
    return 2;
  }
  const stage = values.stage === undefined ? undefined : Number(values.stage);
  if (stage !== undefined && stage !== 1 && stage !== 2) {
    console.error('--stage is 1 or 2');
    return 2;
  }
  let generation: number | undefined;
  if (values.generation !== undefined) {
    generation = Number(values.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('--generation must be a positive integer');
  }
  const outDir = resolve(values['out-dir'] ?? resolve(APP_DIR, 'data/work/narrative'));
  const log = (m: string) => console.log(m);
  if (command === 'report') {
    if (!values.judgments) {
      console.error('report needs --judgments');
      return 2;
    }
    return reportCommand({ outDir, ...(values.pools ? { pools: values.pools } : {}), judgments: values.judgments.split(',').map((f) => f.trim()).filter(Boolean), log });
  }
  if (command === 'build' || command === 'calibration') {
    const config = evalConfig(values['env-files']);
    if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
    if (command === 'calibration') {
      if (generation === undefined) throw new Error("--generation is required (the Track C dataset's generation)");
      return calibrationCommand({ databaseUrl: config.databaseUrl, generation, ...(values.out ? { out: values.out } : {}), check: values.check === true });
    }
    return buildCommand({
      databaseUrl: config.databaseUrl,
      ...(generation !== undefined ? { generation } : {}),
      ...(values.out ? { out: values.out } : {}),
      check: values.check === true,
      dryRun: values['dry-run'] === true,
    });
  }
  const config = experimentAppConfig(values['env-files'], values['keys-file']);
  const base = { config, outDir, confirm: values['confirm-cost'] === true, log };
  const maxUsd = positiveNumber(values['max-usd'], '--max-usd');
  if (command === 'plan') return planCommand({ ...base, confirm: false, samples, broadSample: { bm25: 30, lure: 5, random: 5 } });
  const allocationUsd = positiveNumber(values['allocation-usd'], '--allocation-usd');
  const allocation = { ...(values.allocation ? { allocation: values.allocation } : {}), ...(allocationUsd !== undefined ? { allocationUsd } : {}) };
  if (command === 'pools') return poolsCommand({ ...base, samples, ...(maxUsd !== undefined ? { maxUsd } : {}), ...allocation });
  const set = command === 'answerability' ? 'answerability' : values.set;
  if (set !== 'calibration' && set !== 'relevance' && set !== 'answerability') {
    console.error('judge needs --set calibration or relevance');
    return 2;
  }
  const concurrency = positiveNumber(values.concurrency, '--concurrency');
  const share = positiveNumber(values['max-escalation-share'], '--max-escalation-share');
  return judgeCommand({
    ...base,
    set,
    ...(split ? { split } : {}),
    ...(stage !== undefined ? { stage: stage as 1 | 2 } : {}),
    ...allocation,
    ...(values.pools ? { pools: values.pools } : {}),
    ...(maxUsd !== undefined ? { maxUsd } : {}),
    ...(concurrency !== undefined ? { concurrency: Math.floor(concurrency) } : {}),
    ...(share !== undefined ? { maxEscalationShare: share } : {}),
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
