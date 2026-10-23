/**
 * `pnpm eval:retrieval:narrative <command>`: the narrative-relevance track (Track N of
 * the task 10c protocol v4). Scores are model-judged, never expert-adjudicated.
 *
 *   build         [--generation <id>] [--out <file>] [--dry-run | --check]   the question set (PostgreSQL, read-only)
 *   calibration   --generation <id> [--out <file>] [--check]                 the calibration sets, labels frozen
 *   plan          [--samples 1|3] [--allocation-usd <usd>] [--allocation <name>] [--pools <file>] [--measured <judgments,...>] [--output-tokens <a,b>] [--disagreement <share>]
 *                 the free dry run: preflight, inventory, cost, the month's sequence (what remains of it set against an existing
 *                 allocation's spend, read only); measured usage replaces the assumptions; a built pool file replaces the pool
 *                 estimates with its exact counts and is measured on its own cases and delivered bundles
 *   pools         [--samples 1|3] [--vectors <file>] [--confirm-cost --allocation <name>]
 *                 paid: the cached inputs (scope samples, query embeddings), then the pools through the production
 *                 retrievers and their frozen identity (frozen-pools.json, committed before judging)
 *   pools         --inputs <file>                                            free: the pools again from saved inputs
 *   judge         --set calibration --split dev|holdout [--max-pairs <n>] [--confirm-cost --allocation <name>]
 *   judge         --set relevance --pools <file> [--stage 1|2] [--confirm-cost --allocation <name>]
 *   answerability --pools <file> [--confirm-cost --allocation <name>]
 *   report        [--pools <file>] --judgments <a,b,...>                     free: metrics and diagnostics
 *   recover       --allocation <name> --run <id> [--confirm]                remove the lock an interrupted run left, after
 *                 reconciling its ledger reservations and allocation charges (without --confirm: a report only)
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
import { judgeCommand, planCommand, poolsCommand, recoverCommand, reportCommand } from './commands.js';

export const USAGE = [
  'usage: pnpm eval:retrieval:narrative build [--env-files <a,b>] [--generation <id>] [--out <file>] [--dry-run | --check]',
  '       pnpm eval:retrieval:narrative calibration [--env-files <a,b>] --generation <id> [--out <file>] [--check]',
  '       pnpm eval:retrieval:narrative plan [--env-files <a,b>] [--keys-file <file>] [--samples 1|3] [--allocation-usd <usd>] [--allocation <name>] [--pools <file>] [--measured <judgments,...>] [--output-tokens <a,b>] [--disagreement <share>] [--out-dir <dir>]',
  '       pnpm eval:retrieval:narrative pools [--samples 1|3] [--vectors <file>] [--max-usd <usd>] [--confirm-cost --allocation <name> [--allocation-usd <usd>]] ...',
  '       pnpm eval:retrieval:narrative pools --inputs <file> ...',
  '       pnpm eval:retrieval:narrative judge --set calibration --split dev|holdout [--max-pairs <n>] [--max-usd <usd>] [--concurrency <n>] [--confirm-cost --allocation <name> [--allocation-usd <usd>]] ...',
  '       pnpm eval:retrieval:narrative judge --set relevance --pools <file> [--stage 1|2] [--max-usd <usd>] [--concurrency <n>] [--max-escalation-share <share>] [--confirm-cost --allocation <name>] ...',
  '       pnpm eval:retrieval:narrative answerability --pools <file> [--confirm-cost --allocation <name>] ...',
  '       pnpm eval:retrieval:narrative report [--pools <file>] --judgments <a,b,...> [--out-dir <dir>]',
  '       pnpm eval:retrieval:narrative recover --allocation <name> --run <id> [--confirm] [--env-files <a,b>] [--out-dir <dir>]',
].join('\n');

const COMMANDS = ['build', 'calibration', 'plan', 'pools', 'judge', 'answerability', 'report', 'recover'] as const;
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
      'max-pairs': { type: 'string' },
      measured: { type: 'string' },
      'output-tokens': { type: 'string' },
      disagreement: { type: 'string' },
      run: { type: 'string' },
      confirm: { type: 'boolean' },
      inputs: { type: 'string' },
      vectors: { type: 'string' },
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
  const split = values.split as 'dev' | 'holdout' | undefined;
  if (split !== undefined && !['dev', 'holdout'].includes(split)) {
    console.error('--split is dev or holdout: the dev split first, the holdout once, never both in one run');
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
  if (command === 'recover' && (!values.allocation || !values.run)) {
    console.error('recover needs --allocation <name> and --run <id> (the run that holds the lock)');
    return 2;
  }
  const config = experimentAppConfig(values['env-files'], values['keys-file']);
  if (command === 'recover') return recoverCommand({ config, outDir, confirm: values.confirm === true, log, allocation: values.allocation as string, run: values.run as string });
  const base = { config, outDir, confirm: values['confirm-cost'] === true, log };
  const maxUsd = positiveNumber(values['max-usd'], '--max-usd');
  const allocationUsd = positiveNumber(values['allocation-usd'], '--allocation-usd');
  if (command === 'plan') {
    let outputTokens: { a: number; b: number } | undefined;
    if (values['output-tokens'] !== undefined) {
      const [a, b, ...rest] = values['output-tokens'].split(',').map((x) => Number(x.trim()));
      if (rest.length > 0 || !(a !== undefined && a > 0) || !(b !== undefined && b > 0)) {
        console.error('--output-tokens takes two positive numbers: judge A,judge B (mean output tokens per call, thinking or reasoning included)');
        return 2;
      }
      outputTokens = { a, b };
    }
    const disagreement = values.disagreement === undefined ? undefined : Number(values.disagreement);
    if (disagreement !== undefined && !(disagreement >= 0 && disagreement <= 1)) {
      console.error('--disagreement is a share between 0 and 1');
      return 2;
    }
    return planCommand({
      ...base,
      confirm: false,
      samples,
      broadSample: { bm25: 30, lure: 5, random: 5 },
      ...(allocationUsd !== undefined ? { allocationUsd } : {}),
      ...(values.allocation ? { allocation: values.allocation } : {}),
      ...(values.pools ? { pools: values.pools } : {}),
      ...(values.measured ? { measured: values.measured.split(',').map((f) => f.trim()).filter(Boolean) } : {}),
      ...(outputTokens ? { outputTokens } : {}),
      ...(disagreement !== undefined ? { disagreement } : {}),
    });
  }
  const allocation = { ...(values.allocation ? { allocation: values.allocation } : {}), ...(allocationUsd !== undefined ? { allocationUsd } : {}) };
  if (command === 'pools') {
    if (values.inputs && (values['confirm-cost'] || values.vectors)) {
      console.error('pools --inputs <file> builds from saved inputs and pays nothing: it takes neither --confirm-cost nor --vectors');
      return 2;
    }
    return poolsCommand({ ...base, samples, ...(maxUsd !== undefined ? { maxUsd } : {}), ...allocation, ...(values.inputs ? { inputs: values.inputs } : {}), ...(values.vectors ? { vectors: values.vectors } : {}) });
  }
  const set = command === 'answerability' ? 'answerability' : values.set;
  if (set !== 'calibration' && set !== 'relevance' && set !== 'answerability') {
    console.error('judge needs --set calibration or relevance');
    return 2;
  }
  const concurrency = positiveNumber(values.concurrency, '--concurrency');
  const maxPairs = positiveNumber(values['max-pairs'], '--max-pairs');
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
    ...(maxPairs !== undefined ? { maxPairs: Math.floor(maxPairs) } : {}),
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
