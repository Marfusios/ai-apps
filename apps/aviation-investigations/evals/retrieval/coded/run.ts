/**
 * `pnpm eval:retrieval --track coded`: the coded-reference retrieval evaluation (Track C
 * of the task 10c protocol v4) over `evals/retrieval/coded/dataset.json`, for keyword,
 * vector and hybrid at each channel size (default 50 and 100). Options as for the silver
 * track (`run.ts`).
 *
 * **Fails closed** before anything is embedded (`codedPreflight`): a dataset that does
 * not parse or breaks a dataset rule (`codedDatasetProblems`), a dataset built from other
 * question specs than the committed ones, a target generation whose id or identity
 * (archive sha256, mapping and normalization versions) differs from the one the set
 * was built from, any question whose labels re-derived on the target (read-only,
 * `rederiveCoded`) differ from the dataset's, and questions that need the event-level
 * aircraft qualification on an index without it (`passages-v1`) stop the run with
 * nothing paid; an index that breaks the passages contract always stops it.
 * `--exploratory` continues past the others (without the unreachable questions) and
 * marks the report non-gating with the reasons, as does `--fake-embedder`. New codes
 * of a frozen code family in the target generation are printed as warnings.
 *
 * The questions are embedded once each, metered on the ledger under `evaluation`; the
 * report `data/work/eval-retrieval-coded-<UTC>.json` is labelled `coded-reference` and
 * holds the metric definitions, the summary, a per-question table and every ranking,
 * bundle and Elasticsearch body (query vectors elided).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDb, createDb } from '../../../server/db/client.js';
import { createEsClient } from '../../../server/search/es.js';
import { CANDIDATE_STAGE_PER_CHANNEL, RETRIEVAL_DEFAULTS, numCandidates } from '../../../server/search/hybrid.js';
import { APP_DIR } from '../../../worker/config.js';
import { evalConfig } from '../config.js';
import { MODES } from '../evaluate.js';
import { targetProblems, type TargetCheck } from '../generation.js';
import { checkTarget, describePlan, embedPlan, indexReport, pct, planQueryEmbeddings, resolveRunTarget, retrievalReport, stamp } from '../harness.js';
import { NDCG_ENUMERATION_LIMIT, RECALL_TARGET } from '../metrics.js';
import type { RunOptions } from '../run.js';
import { DEFAULT_CODED_DATASET, rederiveCoded } from './build-coded.js';
import { CAVEAT, CodedDatasetSchema, REFERENCE, codedDatasetProblems, codedLabels, specSha256, type CodedDataset, type CodedItem } from './coded.js';
import { evaluateCoded, type CodedEvaluation } from './evaluate.js';
import { CODED_PARAPHRASES, CODED_QUESTIONS } from './questions.js';

export const CODED_REPORT_KIND = 'eval-retrieval-coded';

/** The metric definitions the report carries. */
export const CODED_METRICS = {
  reference: CAVEAT,
  recallAt20:
    'candidate ranking: coded cases among the first 20 unique cases / all coded cases (never capped). Gate metric only for narrow ' +
    `questions (1 to 20 coded cases, exhaustive, no unknowns; target ${RECALL_TARGET}); a diagnostic with its ceiling min(1, 20 / coded) otherwise`,
  strictP6: 'bundle: coded cases among the first 6 positions / 6, unfilled positions counting as zero (coded P@6)',
  codedPrecision: 'bundle: coded cases among the returned cases / returned cases; null for an empty bundle. Uncoded cases are "not coded", not judged irrelevant',
  ndcg6: 'bundle: nDCG@6 with gains 0/1/2 -> 0/1/3 (coded cases grade 2), ideal ranking from the coded cases; an empty bundle scores 0 and is kept',
  bounds:
    `Track C has no unknown grades: lower and upper bounds are equal. (With unknowns, P@6 bounds are exact and nDCG@6 bounds enumerate up to ${NDCG_ENUMERATION_LIMIT} affecting unknowns, then relax.)`,
} as const;

export interface CodedPreflight {
  /** Problems that stop a gating run before anything is embedded. */
  problems: string[];
  /** Questions to run. */
  items: CodedItem[];
  /** Questions not run: they need the event-level aircraft qualification the index lacks. */
  notRun: string[];
}

/**
 * Pure: what a run of `dataset` against the target would evaluate, and what makes it
 * invalid. `target` is the target generation's identity and every question's labels
 * re-derived there (`checkTarget` with `rederiveCoded`).
 */
export function codedPreflight(
  dataset: CodedDataset,
  opts: { split: 'all' | 'dev' | 'holdout'; eventAircraftQualification: boolean; specSha256: string; target: TargetCheck },
): CodedPreflight {
  const problems = codedDatasetProblems(dataset).map((p) => `dataset: ${p}`);
  if (dataset.source.specSha256 !== opts.specSha256) {
    problems.push('dataset: built from other question specs than the committed ones; rebuild it with pnpm eval:retrieval:coded');
  }
  const selected = dataset.questions.filter((q) => opts.split === 'all' || q.split === opts.split);
  const notRun = opts.eventAircraftQualification ? [] : selected.filter((q) => q.needsEventAircraftQualification).map((q) => q.id);
  if (notRun.length > 0) {
    problems.push(`index: no event-level aircraft qualification; ${notRun.length} question(s) need it (${notRun.join(', ')}) and are not run`);
  }
  problems.push(...targetProblems('coded', { source: dataset.source, labels: codedLabels(dataset) }, opts.target));
  return { problems, items: selected.filter((q) => !notRun.includes(q.id)), notRun };
}

/** Parse a dataset file's text; the issues when it does not parse. */
export function parseCodedDataset(raw: string): { dataset: CodedDataset } | { issues: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { issues: [`not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = CodedDatasetSchema.safeParse(json);
  return parsed.success ? { dataset: parsed.data } : { issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`) };
}

const num = (x: number | null | undefined) => (x === null || x === undefined ? '   -  ' : x.toFixed(3).padStart(6));

/** The summary group of `group`'s questions of one class (`all` has the bare class names). */
export const classGroup = (group: string, cls: 'narrow' | 'broad'): string => (group === 'all' ? cls : `${group}/${cls}`);

function printCoded(r: CodedEvaluation): void {
  console.log(`\n${REFERENCE} scores: retrieval of coded facts; absence of a code is not a negative judgement`);
  for (const group of ['all', 'dev', 'holdout', 'tag:paraphrase']) {
    const n = r.summary[String(r.sizes[0])]?.hybrid[group]?.questions ?? 0;
    if (n === 0) continue;
    console.log(`\n${group === 'tag:paraphrase' ? 'paraphrases only' : group} (${n} questions)`);
    console.log('  per channel  mode     | narrow: R@20  >=90%  (n) | broad: coded P@6  coded nDCG@6  R@20 diag (ceiling) (n) | all: coded precision');
    for (const size of r.sizes) {
      for (const mode of MODES) {
        const s = r.summary[String(size)]?.[mode];
        const narrow = s?.[classGroup(group, 'narrow')];
        const broad = s?.[classGroup(group, 'broad')];
        const all = s?.[group];
        console.log(
          `  ${String(size).padStart(11)}  ${mode.padEnd(8)} |  ${pct(narrow?.recallGate.mean)} ${pct(narrow?.recallGate.atTarget)} (${narrow?.recallGate.questions ?? 0}) |` +
            `     ${pct(broad?.strictP6?.lower)}       ${pct(broad?.ndcg6?.lower)} ${pct(broad?.recallDiagnostic.mean)} (${pct(broad?.recallDiagnostic.ceiling)}) (${broad?.questions ?? 0}) |` +
            ` ${pct(all?.precisionReturned?.lower)}`,
        );
      }
    }
  }
  for (const size of r.sizes) {
    console.log(`\nper question, ${size} per channel: R@20 keyword / vector / hybrid; hybrid bundle: coded P@6, coded nDCG@6, coded precision`);
    for (const q of r.questions) {
      const m = q.sizes[String(size)]?.modes;
      if (!m) continue;
      const h = m.hybrid.score;
      console.log(
        `  ${q.id.padEnd(52)} ${q.split.padEnd(7)} ${q.class.padEnd(6)} ${String(q.relevant).padStart(4)}  ` +
          `${num(m.keyword.score.recall.value)} ${num(m.vector.score.recall.value)} ${num(h.recall.value)}${h.recall.gate === 'eligible' ? '*' : ' '}  ` +
          `${num(h.precision.strict.lower)} ${num(h.ndcg.bounds?.lower)} ${num(h.precision.amongReturned?.lower)}`,
      );
    }
    console.log('  (* Recall@20 gate-eligible)');
  }
}

/** The coded track of `pnpm eval:retrieval` (module comment). */
export async function runCodedEvaluation(opts: RunOptions): Promise<number> {
  const { sizes, split, exploratory, fake } = opts;
  const config = evalConfig(opts.envFiles);
  const datasetPath = opts.dataset ? resolve(opts.dataset) : DEFAULT_CODED_DATASET;
  const raw = readFileSync(datasetPath, 'utf8');
  const parsed = parseCodedDataset(raw);
  if ('issues' in parsed) {
    for (const i of parsed.issues) console.error(`dataset: ${i}`);
    console.error('the coded dataset does not parse; nothing embedded');
    return 1;
  }
  const dataset = parsed.dataset;
  const { embeddingModel: model, embeddingDimensions: dims } = config.ai.openai;

  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (the active manifest)');
  const app = createDb(config.databaseUrl, { max: 2, applicationName: 'aviation-eval-retrieval-coded' });
  const es = createEsClient(config.elasticsearch, 'read', { requestTimeoutMs: 30_000 });
  try {
    const run = await resolveRunTarget(es, app, opts.passagesIndex, { model, dims });
    if ('refused' in run) {
      console.error(`${run.refused}; nothing embedded`);
      return 1;
    }
    // The dataset's labels re-derived on the target generation (read-only): generation ids are per-database sequences.
    const target = await checkTarget(config.databaseUrl, run.target.generationId, (client) => rederiveCoded(client, run.target.generationId, dataset));
    for (const w of target.warnings) console.warn(`warning: ${w}`);
    const pre = codedPreflight(dataset, {
      split,
      eventAircraftQualification: run.contract.eventAircraftQualification,
      specSha256: specSha256(CODED_QUESTIONS, CODED_PARAPHRASES),
      target,
    });
    if (pre.problems.length > 0) {
      for (const p of pre.problems) console.error(p);
      if (!exploratory) {
        console.error('the run would not be a valid gate run; nothing embedded (--exploratory runs anyway, marked non-gating)');
        return 1;
      }
    }
    const items = pre.items;
    const gating = !exploratory && !fake && pre.problems.length === 0;
    const reasons = [...pre.problems, ...(exploratory ? ['--exploratory'] : []), ...(fake ? ['--fake-embedder'] : [])];
    if (!gating) console.warn(`NON-GATING run (${reasons.join('; ')}): its numbers cannot lock retrieval defaults`);

    const plan = planQueryEmbeddings(
      items.map((q) => q.question),
      model,
      dims,
    );
    const count = (cls: string) => items.filter((q) => q.class === cls).length;
    console.log(
      `${REFERENCE}: ${items.length} questions (${split}; ${count('narrow')} narrow, ${count('broad')} broad, ` +
        `${items.filter((q) => q.paraphrase_of !== undefined).length} paraphrases), ${describePlan(plan)}; ` +
        `index ${run.index} (generation ${run.target.generationId}) meets the passages contract`,
    );
    if (!opts.confirmCost && !fake) {
      console.log('nothing embedded: run with --confirm-cost to evaluate (or --fake-embedder for a free, non-gating pipeline check)');
      return 0;
    }

    const started = new Date();
    const { embedder, billed } = await embedPlan(plan, { fake, config, purpose: `eval-retrieval-coded-${stamp(started)}`, log: (m) => console.error(m) });
    if (fake) console.warn('warning: fake embeddings; vector and hybrid numbers are meaningless');
    const result = await evaluateCoded(es, embedder, run.target, items, { sizes, log: (m) => console.error(m) });
    const finished = new Date();
    const groups = new Map<string, number>();
    for (const q of dataset.questions) groups.set(q.group, (groups.get(q.group) ?? 0) + 1);
    const report = {
      kind: CODED_REPORT_KIND,
      version: 1,
      reference: REFERENCE,
      gating,
      nonGatingReasons: gating ? [] : reasons,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      dataset: {
        file: datasetPath.startsWith(APP_DIR) ? datasetPath.slice(APP_DIR.length + 1) : 'external',
        sha256: createHash('sha256').update(raw).digest('hex'),
        version: dataset.version,
        builtFromGeneration: dataset.source.generationId,
        specSha256: dataset.source.specSha256,
        split,
        questions: items.length,
        narrow: count('narrow'),
        broad: count('broad'),
        paraphrases: items.filter((q) => q.paraphrase_of !== undefined).length,
        notRunWithoutEventAircraftQualification: pre.notRun,
        splitsFrozen: dataset.splitsFrozen,
        groups: Object.fromEntries([...groups.entries()].sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))),
        /** The target generation's identity; every question's labels were re-derived there before anything was embedded. */
        target: { source: target.source, questionsRederived: target.labels.size, warnings: target.warnings, ms: target.ms },
      },
      index: indexReport(run),
      retrieval: retrievalReport(config),
      embedder: { kind: fake ? 'fake' : 'openai', model, dims, inputs: plan.inputs.length, countedTokens: plan.inputTokens, billed },
      params: {
        live: { ...RETRIEVAL_DEFAULTS, numCandidates: numCandidates(RETRIEVAL_DEFAULTS) },
        sizes: sizes.map((s) => ({ perChannel: s, numCandidates: numCandidates({ perChannel: s, numCandidatesFactor: RETRIEVAL_DEFAULTS.numCandidatesFactor }) })),
        candidateStage: CANDIDATE_STAGE_PER_CHANNEL,
      },
      metrics: CODED_METRICS,
      summary: result.summary,
      table: result.table,
      questions: result.questions,
    };
    const outDir = opts.outDir ? resolve(opts.outDir) : resolve(APP_DIR, 'data/work');
    mkdirSync(outDir, { recursive: true });
    const file = resolve(outDir, `${CODED_REPORT_KIND}-${stamp(started)}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    printCoded(result);
    console.log(`\nquery embeddings: ${billed.requests} request(s), ${billed.tokens} billed tokens, $${billed.usd.toFixed(6)}${billed.uncertain ? ` (${billed.uncertain} without a usage report: charged in full)` : ''}`);
    if (!gating) console.warn(`NON-GATING report (${reasons.join('; ')})`);
    console.log(`report: ${file}`);
    return 0;
  } finally {
    await es.close();
    await closeDb(app);
  }
}
