/**
 * `pnpm eval:retrieval`: the retrieval evaluation (amendment A13; review gate G5).
 *
 *   pnpm eval:retrieval [--track silver|coded] [--env-files <a,b>] [--dataset <file>]
 *     [--sizes 50,100] [--split all|dev|holdout] [--passages-index <name>]
 *     [--out-dir <dir>] [--confirm-cost | --fake-embedder] [--exploratory]
 *
 * `--track coded` runs the coded-reference track instead (`coded/run.ts`, task 10c
 * Track C) with the same options and the same fail-closed checks; the default
 * `silver` track is described here.
 *
 * **Fails closed.** Before anything is embedded it validates the dataset
 * (`datasetProblems`), resolves the target (the active manifest's passages index, or
 * `--passages-index`, whose generation comes from its `_meta`), checks the passages
 * contract for the configured embedding model and dimensions, and verifies the labels
 * on the target: the target generation's id and identity (archive sha256, mapping and
 * normalization versions) must be the ones the silver set was built from, and every
 * question's criteria, re-run read-only on the target (`rederiveSilver`, about 25 s),
 * must give the dataset's expected cases (`generation.ts`). Any problem stops the run
 * (exit 1) with nothing paid. `--exploratory` continues past dataset, generation and
 * label problems, and the report is then marked `gating: false` with the reasons; an
 * index that breaks the contract always stops the run (retrieval would refuse it). A
 * `--fake-embedder` run is never gating either.
 *
 * - Embeds each RAG question once with the configured model (`OPENAI_EMBEDDING_MODEL`,
 *   `OPENAI_EMBEDDING_DIMENSIONS`), in requests of at most 96 inputs, metered on the
 *   ledger under `evaluation`. Without `--confirm-cost` it prints the token count and
 *   the estimated cost after the checks and stops: no paid request. `--fake-embedder`
 *   uses free deterministic vectors (a pipeline check: its vector and hybrid numbers
 *   mean nothing).
 * - Questions of the `structured` section are not run (they belong to a structured or
 *   combined evaluation).
 * - Questions tagged `multi_aircraft_filtered` (an aircraft filter over multi-aircraft
 *   events, `needsEventAircraftQualification`) need an index whose contract has the
 *   event-level aircraft qualification (`passages-v2`). On a `passages-v1` index they
 *   are a problem that stops the run; `--exploratory` runs without them, non-gating,
 *   and the report lists them.
 * - Writes `data/work/eval-retrieval-<UTC timestamp>.json` with every metric, ranking,
 *   bundle and Elasticsearch body (query vectors elided), and prints candidate recall
 *   and the bundle metrics for keyword, vector and hybrid at each size.
 *
 * Connects with `DATABASE_URL` (the active manifest), `ELASTICSEARCH_READ_API_KEY`
 * and, for paid embeddings, `DATABASE_INGEST_URL` (the ledger). Values are never
 * printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { closeDb, createDb } from '../../server/db/client.js';
import { createEsClient } from '../../server/search/es.js';
import { CANDIDATE_STAGE_PER_CHANNEL, RETRIEVAL_DEFAULTS, numCandidates } from '../../server/search/hybrid.js';
import { APP_DIR } from '../../worker/config.js';
import { describeWorkerError } from '../../worker/errors.js';
import { DEFAULT_DATASET, rederiveSilver, silverLabels } from './build-silver.js';
import { runCodedEvaluation } from './coded/run.js';
import { evalConfig } from './config.js';
import { MODES, evaluateRetrieval, type EvaluationResult } from './evaluate.js';
import { targetProblems } from './generation.js';
import { checkTarget, describePlan, embedPlan, indexReport, pct, planQueryEmbeddings, resolveRunTarget, stamp } from './harness.js';
import { DatasetSchema, datasetProblems, needsEventAircraftQualification, type Dataset } from './silver.js';

export { precomputedEmbedder } from './harness.js';

const USAGE =
  'usage: pnpm eval:retrieval [--track silver|coded] [--env-files <a,b>] [--dataset <file>] [--sizes 50,100] [--split all|dev|holdout] ' +
  '[--passages-index <name>] [--out-dir <dir>] [--confirm-cost | --fake-embedder] [--exploratory]';

export const RUN_OPTIONS = {
  track: { type: 'string' },
  'env-files': { type: 'string' },
  dataset: { type: 'string' },
  sizes: { type: 'string' },
  split: { type: 'string' },
  'passages-index': { type: 'string' },
  'out-dir': { type: 'string' },
  'confirm-cost': { type: 'boolean' },
  'fake-embedder': { type: 'boolean' },
  exploratory: { type: 'boolean' },
} as const;

/** Options both tracks share, validated. Null on a usage error. */
export interface RunOptions {
  envFiles: string | undefined;
  dataset: string | undefined;
  sizes: number[];
  split: 'all' | 'dev' | 'holdout';
  passagesIndex: string | undefined;
  outDir: string | undefined;
  confirmCost: boolean;
  fake: boolean;
  exploratory: boolean;
}

export function runOptions(values: { [K in keyof typeof RUN_OPTIONS]?: (typeof RUN_OPTIONS)[K]['type'] extends 'boolean' ? boolean : string }): RunOptions | null {
  if (values['confirm-cost'] && values['fake-embedder']) return null;
  const sizes = (values.sizes ?? `${RETRIEVAL_DEFAULTS.perChannel},${CANDIDATE_STAGE_PER_CHANNEL}`).split(',').map((s) => Number(s.trim()));
  if (sizes.length === 0 || sizes.some((s) => !Number.isSafeInteger(s) || s < 1 || s > 200)) return null;
  const split = values.split ?? 'all';
  if (split !== 'all' && split !== 'dev' && split !== 'holdout') return null;
  return {
    envFiles: values['env-files'],
    dataset: values.dataset,
    sizes,
    split,
    passagesIndex: values['passages-index'],
    outDir: values['out-dir'],
    confirmCost: values['confirm-cost'] === true,
    fake: values['fake-embedder'] === true,
    exploratory: values.exploratory === true,
  };
}

function printSummary(r: EvaluationResult): void {
  for (const group of ['all', 'dev', 'holdout', 'tag:paraphrase']) {
    const n = r.summary[String(r.sizes[0])]?.hybrid[group]?.questions ?? 0;
    if (n === 0) continue;
    console.log(`\n${group === 'tag:paraphrase' ? 'paraphrases only' : group} (${n} questions)`);
    console.log('  per channel  mode      candidates:  R@20     R@10     R@6  | bundle: cases evidence  precision  nDCG@6   any   causes(structural)');
    for (const size of r.sizes) {
      for (const mode of MODES) {
        const a = r.summary[String(size)]?.[mode][group];
        if (!a) continue;
        console.log(
          `  ${String(size).padStart(11)}  ${mode.padEnd(8)}          ${pct(a.recallAt20)} ${pct(a.recallAt10)} ${pct(a.recallAt6)} |  ${pct(a.coverageCases)} ${pct(a.coverageEvidence)} ${pct(a.bundlePrecision)} ${pct(a.ndcg6)} ${pct(a.anyInBundle)} ${pct(a.coverageCausesStructural)}`,
        );
      }
    }
  }
  for (const size of r.sizes.map(String)) {
    const tags = Object.keys(r.summary[size]?.hybrid ?? {}).filter((g) => g.startsWith('tag:'));
    if (tags.length === 0) continue;
    console.log(`\nby tag, ${size} per channel: R@20 keyword / vector / hybrid; hybrid bundle cases / evidence`);
    for (const tag of tags) {
      const s = r.summary[size];
      console.log(
        `  ${tag.slice(4).padEnd(20)} ${String(s?.hybrid[tag]?.questions).padStart(3)}  ${pct(s?.keyword[tag]?.recallAt20)} ${pct(s?.vector[tag]?.recallAt20)} ${pct(s?.hybrid[tag]?.recallAt20)}  ${pct(s?.hybrid[tag]?.coverageCases)} ${pct(s?.hybrid[tag]?.coverageEvidence)}`,
      );
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: RUN_OPTIONS, strict: true });
  const opts = runOptions(values);
  const track = values.track ?? 'silver';
  if (!opts || (track !== 'silver' && track !== 'coded')) {
    console.error(USAGE);
    return 2;
  }
  return track === 'coded' ? runCodedEvaluation(opts) : runSilverEvaluation(opts);
}

/** The silver track (module comment). */
async function runSilverEvaluation(opts: RunOptions): Promise<number> {
  const { sizes, split, exploratory, fake } = opts;
  const config = evalConfig(opts.envFiles);
  const datasetPath = opts.dataset ? resolve(opts.dataset) : DEFAULT_DATASET;
  const raw = readFileSync(datasetPath, 'utf8');
  const parsed = DatasetSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 20)) console.error(`dataset: ${i.path.join('.')}: ${i.message}`);
    console.error('the dataset does not parse; nothing embedded');
    return 1;
  }
  const dataset: Dataset = parsed.data;
  const problems = datasetProblems(dataset).map((p) => `dataset: ${p}`);
  const selected = dataset.questions.filter((q) => q.section === 'rag' && (split === 'all' || q.split === split));
  const structured = dataset.questions.filter((q) => q.section === 'structured').length;
  const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;

  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (the active manifest)');
  const app = createDb(config.databaseUrl, { max: 2, applicationName: 'aviation-eval-retrieval' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 30_000 });
  try {
    // Target and passages contract, before anything is embedded.
    const run = await resolveRunTarget(es, app, opts.passagesIndex, { model, dims });
    if ('refused' in run) {
      console.error(`${run.refused}; nothing embedded`);
      return 1;
    }
    const { target, index, contract } = run;
    // An index without the event-level qualification can never reach these questions' multi-aircraft cases.
    const unreachable = contract.eventAircraftQualification
      ? []
      : selected.filter((q) => needsEventAircraftQualification({ filters: q.filters, criteria: q.derivation.criteria })).map((q) => q.id);
    if (unreachable.length > 0) {
      problems.push(
        `index: ${contract.indexVersion} has no event-level aircraft qualification; ${unreachable.length} question(s) need it ` +
          `(${unreachable.join(', ')}) and are not run`,
      );
    }
    const items = selected.filter((q) => !unreachable.includes(q.id));
    // The dataset's labels re-derived on the target generation (read-only): generation ids are per-database sequences.
    const verified = await checkTarget(config.databaseUrl, target.generationId, (client) => rederiveSilver(client, target.generationId, dataset));
    problems.push(...targetProblems('silver', { source: dataset.source, labels: silverLabels(dataset) }, verified));
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      if (!exploratory) {
        console.error('the run would not be a valid gate run; nothing embedded (--exploratory runs anyway, marked non-gating)');
        return 1;
      }
    }
    const gating = !exploratory && !fake && problems.length === 0;
    const reasons = [...problems, ...(exploratory ? ['--exploratory'] : []), ...(fake ? ['--fake-embedder'] : [])];
    if (!gating) console.warn(`NON-GATING run (${reasons.join('; ')}): its numbers cannot lock retrieval defaults`);

    const plan = planQueryEmbeddings(
      items.map((q) => q.question),
      model,
      dims,
    );
    console.log(
      `${items.length} RAG questions (${split}; ${structured} structured questions not run), ${describePlan(plan)}; ` +
        `index ${index} (generation ${target.generationId}) meets the passages contract`,
    );
    if (!opts.confirmCost && !fake) {
      console.log('nothing embedded: run with --confirm-cost to evaluate (or --fake-embedder for a free, non-gating pipeline check)');
      return 0;
    }

    const started = new Date();
    const { embedder, billed } = await embedPlan(plan, { fake, config, purpose: `eval-retrieval-${stamp(started)}`, log: (m) => console.error(m) });
    if (fake) console.warn('warning: fake embeddings; vector and hybrid numbers are meaningless');

    const result = await evaluateRetrieval(es, embedder, target, items, { sizes, log: (m) => console.error(m) });
    const finished = new Date();
    const groups = new Map<string, number>();
    for (const q of dataset.questions) groups.set(q.group, (groups.get(q.group) ?? 0) + 1);
    const report = {
      kind: 'eval-retrieval',
      version: 3,
      gating,
      nonGatingReasons: gating ? [] : reasons,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      dataset: {
        file: datasetPath.startsWith(APP_DIR) ? datasetPath.slice(APP_DIR.length + 1) : 'external',
        sha256: createHash('sha256').update(raw).digest('hex'),
        version: dataset.version,
        builtFromGeneration: dataset.source.generationId,
        rulesSha256: dataset.source.rulesSha256,
        split,
        ragQuestions: items.length,
        notRunWithoutEventAircraftQualification: unreachable,
        structuredQuestionsNotRun: structured,
        paraphrases: items.filter((q) => q.paraphrase_of !== undefined).length,
        groups: Object.fromEntries([...groups.entries()].sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))),
        adjudication: dataset.adjudication,
        /** The target generation's identity; every question's expected cases were re-derived there before anything was embedded. */
        target: { source: verified.source, questionsRederived: verified.labels.size, ms: verified.ms },
      },
      index: indexReport(run),
      embedder: { kind: fake ? 'fake' : 'openai', model, dims, inputs: plan.inputs.length, countedTokens: plan.inputTokens, billed },
      params: {
        live: { ...RETRIEVAL_DEFAULTS, numCandidates: numCandidates(RETRIEVAL_DEFAULTS) },
        sizes: sizes.map((s) => ({ perChannel: s, numCandidates: numCandidates({ perChannel: s, numCandidatesFactor: RETRIEVAL_DEFAULTS.numCandidatesFactor }) })),
        candidateStage: CANDIDATE_STAGE_PER_CHANNEL,
      },
      metrics: {
        recall: 'candidate case recall@k: expected cases in the first k unique cases / min(|expected|, k)',
        coverageCases: 'bundle: expected cases with a passage in the bundle / min(|expected|, maxCases)',
        coverageEvidence:
          'bundle: expected cases whose bundle passages satisfy the question\'s own text criterion (every text rule matched by a passage of its section kinds) / min(|expected|, maxCases); questions without a text criterion are left out',
        coverageCausesStructural: 'bundle: expected cases with their probable cause in the bundle; equals case coverage while packing attaches every cause',
        bundlePrecision: 'bundle cases that are expected / bundle cases',
        ndcg6: 'binary-relevance nDCG over the bundle cases in rank order, ideal = min(|expected|, 6) expected cases',
      },
      summary: result.summary,
      questions: result.questions,
    };
    const outDir = opts.outDir ? resolve(opts.outDir) : resolve(APP_DIR, 'data/work');
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, `eval-retrieval-${stamp(started)}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    printSummary(result);
    console.log(`\nquery embeddings: ${billed.requests} request(s), ${billed.tokens} billed tokens, $${billed.usd.toFixed(6)}${billed.uncertain ? ` (${billed.uncertain} without a usage report: charged in full)` : ''}`);
    if (!gating) console.warn(`NON-GATING report (${reasons.join('; ')})`);
    console.log(`report: ${file}`);
    return 0;
  } finally {
    await es.close();
    await closeDb(app);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(APP_DIR, 'evals/retrieval/run.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(describeWorkerError(err));
      process.exit(1);
    },
  );
}
