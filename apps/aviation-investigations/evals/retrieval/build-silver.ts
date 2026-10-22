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
 * Every question keeps its rule's full positive set. Paraphrases (`PARAPHRASES`) copy
 * their original's rule, filters and expected set. Questions sharing a case, and
 * paraphrases with their originals, form connected groups that are split whole
 * (`assignSplits`); the build prints every group. Fails when a rule derives fewer
 * than `MIN_EXPECTED` or more than `MAX_EXPECTED` cases (never capped), or when the
 * set breaks a coverage rule (`datasetProblems`).
 *
 * `source` records the generation's identity (archive sha256, mapping and
 * normalization versions) next to its id; `rederiveSilver` re-runs every question's
 * recorded criteria on a run's target so the run can refuse labels that do not hold
 * there (`generation.ts`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { APP_DIR } from '../../worker/config.js';
import { evalConfig } from './config.js';
import { readGenerationSource, type GenerationSource, type QuestionLabels } from './generation.js';
import { PARAPHRASES, QUESTIONS } from './questions.js';
import {
  DatasetSchema,
  MAX_EXPECTED,
  MIN_EXPECTED,
  SILVER_VERSION,
  assignSplits,
  compileCriteria,
  datasetProblems,
  describeCriteria,
  rulesSha256,
  type Criteria,
  type Dataset,
  type DatasetItem,
  type GroupedSplits,
  type ParaphraseSpec,
  type QuestionSpec,
} from './silver.js';

export const DEFAULT_DATASET = resolve(APP_DIR, 'evals/retrieval/dataset.json');

const DESCRIPTION =
  'Silver retrieval set (amendment A13, gate G5): public NTSB case numbers derived from structured fields and explicit ' +
  'keyword rules (derivation.criteria, compiled by evals/retrieval/silver.ts), full positive sets. Every label awaits ' +
  'expert adjudication. Questions sharing a case, and paraphrases with their originals, are split together by group. ' +
  'Section "structured" questions are excluded from RAG metrics. Rebuild with pnpm eval:retrieval:silver.';

export interface SilverBuild {
  dataset: Dataset;
  /** Rules whose expected set is out of bounds, with their counts. */
  rejected: { id: string; count: number }[];
  groups: GroupedSplits['groups'];
  problems: string[];
}

/**
 * In one read-only, repeatable-read snapshot of `generationId`: the generation's
 * identity, its answer-eligible case count and the cases each rule derives (identical
 * rules are run once).
 */
async function deriveInSnapshot(
  client: pg.ClientBase,
  generationId: number,
  rules: readonly { id: string; criteria: Criteria }[],
): Promise<{ source: GenerationSource; answerEligibleCases: number; derived: Map<string, string[]> }> {
  await client.query('begin transaction isolation level repeatable read read only');
  try {
    const source = await readGenerationSource(client, generationId);
    const [row] = (await client.query<{ n: number }>('select count(*)::int as n from cases where generation_id = $1 and answer_eligible', [generationId])).rows;
    const answerEligibleCases = row?.n ?? 0;
    if (answerEligibleCases === 0) throw new Error(`generation ${generationId} has no answer-eligible cases`);
    const byRule = new Map<string, string[]>();
    const derived = new Map<string, string[]>();
    for (const rule of rules) {
      const key = JSON.stringify(rule.criteria);
      let cases = byRule.get(key);
      if (!cases) {
        const q = compileCriteria(rule.criteria);
        cases = (await client.query<{ ntsb_no: string }>(q.text, [generationId, ...q.values])).rows.map((r) => r.ntsb_no);
        byRule.set(key, cases);
      }
      derived.set(rule.id, cases);
    }
    await client.query('commit');
    return { source, answerEligibleCases, derived };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

/** Derive every question's expected cases in one read-only snapshot of `generationId`. */
export async function buildSilver(
  client: pg.ClientBase,
  generationId: number,
  specs: readonly QuestionSpec[] = QUESTIONS,
  paraphrases: readonly ParaphraseSpec[] = PARAPHRASES,
): Promise<SilverBuild> {
  const { source, answerEligibleCases, derived } = await deriveInSnapshot(client, generationId, specs);
  return assembleSilver({ ...source, answerEligibleCases }, specs, paraphrases, derived);
}

/**
 * Every question's expected cases re-derived on `generationId` from the criteria the
 * dataset records (read-only snapshot): what a run compares with the dataset before
 * anything is embedded.
 */
export async function rederiveSilver(client: pg.ClientBase, generationId: number, dataset: Dataset): Promise<{ labels: Map<string, QuestionLabels> }> {
  const { derived } = await deriveInSnapshot(
    client,
    generationId,
    dataset.questions.map((q) => ({ id: q.id, criteria: q.derivation.criteria })),
  );
  return { labels: new Map([...derived].map(([id, relevant]) => [id, { relevant }])) };
}

/** The labels a silver dataset records, in the shape `targetProblems` compares. */
export const silverLabels = (d: Dataset): Map<string, QuestionLabels> => new Map(d.questions.map((q) => [q.id, { relevant: q.expected }]));

type Draft = Omit<DatasetItem, 'group' | 'split'>;

/** Pure: the dataset from each rule's derived cases. */
export function assembleSilver(
  source: GenerationSource & { answerEligibleCases: number },
  specs: readonly QuestionSpec[],
  paraphrases: readonly ParaphraseSpec[],
  derived: ReadonlyMap<string, readonly string[]>,
): SilverBuild {
  const problems: string[] = [];
  const rejected = specs
    .map((spec) => ({ id: spec.id, count: derived.get(spec.id)?.length ?? 0 }))
    .filter((r) => r.count < MIN_EXPECTED || r.count > MAX_EXPECTED);
  const rejectedIds = new Set(rejected.map((r) => r.id));
  const drafts: Draft[] = [];
  const byId = new Map<string, Draft>();
  for (const spec of specs) {
    if (rejectedIds.has(spec.id)) continue;
    const d: Draft = {
      id: spec.id,
      question: spec.question,
      tags: spec.tags,
      section: spec.section ?? 'rag',
      filters: spec.filters,
      expected: [...(derived.get(spec.id) ?? [])],
      derivation: { rule: describeCriteria(spec.criteria), criteria: spec.criteria, note: spec.note },
      adjudication: 'pending-expert',
    };
    drafts.push(d);
    byId.set(d.id, d);
  }
  const links: [string, string][] = [];
  for (const p of paraphrases) {
    const of = byId.get(p.of);
    if (!of) {
      problems.push(`${p.id}: paraphrase of ${p.of}, which is unknown or rejected`);
      continue;
    }
    const tags = of.tags.filter((t) => t !== 'seed');
    drafts.push({
      ...of,
      id: p.id,
      question: p.question,
      tags: [...tags, 'paraphrase'],
      paraphrase_of: of.id,
      derivation: { ...of.derivation, note: `Paraphrase of ${of.id}, avoiding: ${p.avoids.join(', ')}. ${of.derivation.note}` },
    });
    links.push([p.id, of.id]);
  }
  const grouped = assignSplits(drafts, links);
  const dataset: Dataset = {
    version: SILVER_VERSION,
    description: DESCRIPTION,
    adjudication: 'pending-expert',
    source: {
      generationId: source.generationId,
      archiveSha256: source.archiveSha256,
      mappingVersion: source.mappingVersion,
      fieldNormalizationVersion: source.fieldNormalizationVersion,
      citationTextVersion: source.citationTextVersion,
      answerEligibleCases: source.answerEligibleCases,
      builder: 'evals/retrieval/build-silver.ts',
      rulesSha256: rulesSha256(specs, paraphrases),
    },
    limits: { minExpected: MIN_EXPECTED, maxExpected: MAX_EXPECTED },
    questions: drafts.map((d) => ({
      ...d,
      group: grouped.group.get(d.id) as string,
      split: grouped.split.get(d.id) as 'dev' | 'holdout',
    })),
  };
  const parsed = DatasetSchema.safeParse(dataset);
  problems.push(
    ...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)),
    ...datasetProblems(dataset),
    ...rejected.map((r) => `${r.id}: the rule derives ${r.count} cases (allowed ${MIN_EXPECTED}..${MAX_EXPECTED}; sets are never capped)`),
  );
  return { dataset, rejected, groups: grouped.groups, problems };
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
    const byId = new Map(d.questions.map((q) => [q.id, q]));
    for (const g of built.groups) {
      console.log(`${g.id} ${g.split} (${g.questions.length} question${g.questions.length === 1 ? '' : 's'})`);
      for (const id of g.questions) {
        const q = byId.get(id);
        if (q) console.log(`    ${String(q.expected.length).padStart(2)}  ${q.id}  [${q.section}; ${q.tags.join(', ')}]`);
      }
    }
    for (const r of built.rejected) console.log(`  REJECTED ${String(r.count).padStart(4)}  ${r.id}`);
    const count = (split: string, section: string) => d.questions.filter((q) => q.split === split && q.section === section).length;
    const sizes = built.groups.map((g) => g.questions.length);
    console.log(
      `questions: ${d.questions.length} (RAG dev ${count('dev', 'rag')}, RAG holdout ${count('holdout', 'rag')}, ` +
        `structured ${d.questions.filter((q) => q.section === 'structured').length}; paraphrases ${d.questions.filter((q) => q.paraphrase_of).length}); ` +
        `groups: ${built.groups.length} (largest ${Math.max(...sizes)}); distinct expected cases: ${new Set(d.questions.flatMap((q) => q.expected)).size}`,
    );
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
