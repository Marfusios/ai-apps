/**
 * Build the silver retrieval set (`evals/retrieval/dataset.json`) from a dataset
 * generation: every question's expected cases come from its committed rule
 * (`questions.ts`, compiled by `silver.ts`), run in one read-only, repeatable-read
 * snapshot. Deterministic: the same generation always gives the same file.
 *
 *   pnpm eval:retrieval:silver [--env-files <a,b>] [--generation <id>] [--out <file>] [--dry-run | --check]
 *
 * - `--generation`: default the active manifest's generation.
 * - `--dry-run`: print the table only. `--check`: exit 1 when the file differs.
 * - Connects with `DATABASE_URL` (the read-only app role). Prints case numbers
 *   (public NTSB data) and counts, never configuration values.
 *
 * A case several rules derive is kept by the first question only (held out by case;
 * `disjointExpected`). Fails when a question keeps fewer than `MIN_EXPECTED` or more
 * than `MAX_EXPECTED` cases, or when the set breaks a coverage rule (`datasetProblems`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { APP_DIR } from '../../worker/config.js';
import { evalConfig } from './config.js';
import { QUESTIONS } from './questions.js';
import {
  DatasetSchema,
  MAX_EXPECTED,
  MIN_EXPECTED,
  SILVER_VERSION,
  assignSplits,
  compileCriteria,
  datasetProblems,
  disjointExpected,
  describeCriteria,
  rulesSha256,
  type Dataset,
  type QuestionSpec,
} from './silver.js';

export const DEFAULT_DATASET = resolve(APP_DIR, 'evals/retrieval/dataset.json');

const DESCRIPTION =
  'Silver retrieval set (amendment A13): public NTSB case numbers derived from structured fields and explicit ' +
  'keyword rules (derivation.criteria, compiled by evals/retrieval/silver.ts). Every label awaits expert ' +
  'adjudication. Splits are held out by case. Rebuild with pnpm eval:retrieval:silver.';

export interface SilverBuild {
  dataset: Dataset;
  /** Rules whose expected set is out of bounds, with their counts. */
  rejected: { id: string; count: number }[];
  problems: string[];
}

/** Derive every question's expected cases in one read-only snapshot of `generationId`. */
export async function buildSilver(client: pg.ClientBase, generationId: number, specs: readonly QuestionSpec[] = QUESTIONS): Promise<SilverBuild> {
  await client.query('begin transaction isolation level repeatable read read only');
  try {
    const [{ n }] = (await client.query<{ n: number }>('select count(*)::int as n from cases where generation_id = $1 and answer_eligible', [generationId])).rows as [{ n: number }];
    if (n === 0) throw new Error(`generation ${generationId} has no answer-eligible cases`);
    const derived: { spec: QuestionSpec; expected: string[] }[] = [];
    for (const spec of specs) {
      const q = compileCriteria(spec.criteria);
      const rows = await client.query<{ ntsb_no: string }>(q.text, [generationId, ...q.values]);
      derived.push({ spec, expected: rows.rows.map((r) => r.ntsb_no) });
    }
    await client.query('commit');
    const disjoint = disjointExpected(derived.map((d) => ({ id: d.spec.id, tags: d.spec.tags, derived: d.expected })));
    const rejected = disjoint
      .filter((d) => d.expected.length < MIN_EXPECTED || d.expected.length > MAX_EXPECTED)
      .map((d) => ({ id: d.id, count: d.expected.length }));
    const rejectedIds = new Set(rejected.map((r) => r.id));
    const specOf = new Map(specs.map((s) => [s.id, s]));
    const kept = disjoint.filter((d) => !rejectedIds.has(d.id));
    const splits = assignSplits(kept);
    const dataset: Dataset = {
      version: SILVER_VERSION,
      description: DESCRIPTION,
      adjudication: 'pending-expert',
      source: {
        generationId,
        answerEligibleCases: n,
        builder: 'evals/retrieval/build-silver.ts',
        rulesSha256: rulesSha256(specs),
      },
      limits: { minExpected: MIN_EXPECTED, maxExpected: MAX_EXPECTED },
      questions: kept.map((d) => {
        const spec = specOf.get(d.id) as QuestionSpec;
        return {
          id: spec.id,
          question: spec.question,
          tags: spec.tags,
          filters: spec.filters,
          expected: d.expected,
          derivation: { rule: describeCriteria(spec.criteria), criteria: spec.criteria, note: spec.note, sharedWith: d.sharedWith },
          split: splits.get(spec.id) as 'dev' | 'holdout',
          adjudication: 'pending-expert' as const,
        };
      }),
    };
    const parsed = DatasetSchema.safeParse(dataset);
    const problems = [
      ...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
      ...datasetProblems(dataset),
      ...rejected.map((r) => `${r.id}: the rule derives ${r.count} cases (allowed ${MIN_EXPECTED}..${MAX_EXPECTED})`),
    ];
    return { dataset, rejected, problems };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

export const serializeDataset = (d: Dataset): string => `${JSON.stringify(d, null, 2)}\n`;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'env-files': { type: 'string' },
      generation: { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean' },
      check: { type: 'boolean' },
    },
    strict: true,
  });
  const config = evalConfig(values['env-files']);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  const out = values.out ? resolve(values.out) : DEFAULT_DATASET;
  const client = new pg.Client({ connectionString: config.databaseUrl, application_name: 'aviation-eval-silver' });
  await client.connect();
  try {
    let generationId: number;
    if (values.generation !== undefined) {
      generationId = Number(values.generation);
      if (!Number.isSafeInteger(generationId) || generationId < 1) throw new Error('--generation must be a positive integer');
    } else {
      const r = await client.query<{ generation_id: string }>('select generation_id from dataset_manifests where active');
      if (!r.rows[0]) throw new Error('no dataset manifest is active; pass --generation');
      generationId = Number(r.rows[0].generation_id);
    }
    const built = await buildSilver(client, generationId);
    const d = built.dataset;
    console.log(`silver set ${d.version} from generation ${generationId} (${d.source.answerEligibleCases} answer-eligible cases)`);
    for (const q of d.questions) {
      console.log(`  ${q.split.padEnd(7)} ${String(q.expected.length).padStart(2)}  ${q.id}  [${q.tags.join(', ')}]`);
    }
    for (const r of built.rejected) console.log(`  REJECTED ${String(r.count).padStart(4)}  ${r.id}`);
    const bySplit = (s: string) => d.questions.filter((q) => q.split === s).length;
    console.log(`questions: ${d.questions.length} (dev ${bySplit('dev')}, holdout ${bySplit('holdout')}); expected cases: ${d.questions.reduce((n, q) => n + q.expected.length, 0)}`);
    if (built.problems.length > 0) {
      for (const p of built.problems) console.error(`problem: ${p}`);
      return 1;
    }
    const text = serializeDataset(d);
    if (values.check) {
      const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
      if (current === text) {
        console.log(`${out} is up to date`);
        return 0;
      }
      const old = current ? (JSON.parse(current) as Dataset) : null;
      const before = new Map((old?.questions ?? []).map((q) => [q.id, JSON.stringify(q)]));
      for (const q of d.questions) if (before.get(q.id) !== JSON.stringify(q)) console.error(`differs: ${q.id}`);
      if (old && JSON.stringify(old.source) !== JSON.stringify(d.source)) console.error('differs: source');
      return 1;
    }
    if (values['dry-run']) return 0;
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
    return 0;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(APP_DIR, 'evals/retrieval/build-silver.ts')) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
