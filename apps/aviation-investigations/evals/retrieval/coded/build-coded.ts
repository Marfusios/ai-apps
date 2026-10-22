/**
 * Build the coded-reference retrieval set (`evals/retrieval/coded/dataset.json`) from a
 * dataset generation: every question's relevant cases are exact membership in its
 * frozen code set (`questions.ts`, derived by `coded.ts`) over every answer-eligible US
 * case, read in one read-only, repeatable-read snapshot. Deterministic: the same
 * generation always gives the same file.
 *
 *   pnpm eval:retrieval:coded [--env-files <a,b>] [--generation <id>] [--out <file>]
 *     [--dry-run | --check] [--freeze-splits] [--reassign-splits]
 *
 * - `--generation`: default the active manifest's generation.
 * - `--dry-run`: print the table only. `--check`: exit 1 when the file differs.
 * - Splits: when the committed file is frozen (`splitsFrozen`, protocol section 6),
 *   every question it holds keeps its split and only new questions are placed; a spec
 *   edit that joins questions frozen in both splits fails. `--freeze-splits` marks the
 *   result frozen; `--reassign-splits` places every group afresh (a deliberate,
 *   reviewable change that `--check` reports as a difference).
 * - Connects with `DATABASE_URL` (the read-only app role). Prints case counts, codes
 *   and group membership (public NTSB data), never configuration values.
 *
 * The snapshot reads the generation's identity (`dataset_generations`), and the
 * cohort's cases (year, state), aircraft (category, defining phase group), findings
 * (code, description, `in_probable_cause`) and sequence rows (event code,
 * description). `cause_factor` is never read. Labels come from codes only;
 * descriptions are recorded as the text seen. Fails when a question's count does not
 * fit its class (never capped), when a spec breaks a wording rule, or when the set
 * breaks a coverage or split rule (`codedDatasetProblems`). Warns when the generation
 * holds a code of a frozen family outside its frozen list (`CODE_FAMILIES`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { APP_DIR } from '../../../worker/config.js';
import { evalConfig } from '../config.js';
import { readGenerationSource, type GenerationSource, type QuestionLabels } from '../generation.js';
import type { Split } from '../silver.js';
import {
  assembleCoded,
  codeStats,
  deriveQuestion,
  familyWarnings,
  indexCorpus,
  type AssembleOptions,
  type CodedBuild,
  type CodedCorpus,
  type CodedDataset,
  type CodedParaphraseSpec,
  type CodedQuestionSpec,
  type Derivation,
} from './coded.js';
import { CODED_PARAPHRASES, CODED_QUESTIONS, CODE_FAMILIES } from './questions.js';

export const DEFAULT_CODED_DATASET = resolve(APP_DIR, 'evals/retrieval/coded/dataset.json');
export const BUILDER = 'evals/retrieval/coded/build-coded.ts';

/** The cohort's rows, ordered; every value a bind parameter. `cause_factor` is not selected. */
export const CORPUS_QUERIES = {
  cases: `select c.ntsb_no, c.ev_year, c.state from cases c
           where c.generation_id = $1 and c.answer_eligible and c.is_us order by c.ntsb_no`,
  aircraft: `select a.ntsb_no, a.aircraft_key, a.category, a.defining_phase_group from case_aircraft a
               join cases c on c.generation_id = a.generation_id and c.ntsb_no = a.ntsb_no
              where a.generation_id = $1 and c.answer_eligible and c.is_us order by a.ntsb_no, a.aircraft_key`,
  findings: `select f.ntsb_no, f.aircraft_key, f.code, f.description, f.in_probable_cause from case_findings f
               join cases c on c.generation_id = f.generation_id and c.ntsb_no = f.ntsb_no
              where f.generation_id = $1 and c.answer_eligible and c.is_us order by f.ntsb_no, f.aircraft_key, f.finding_no`,
  sequence: `select q.ntsb_no, q.aircraft_key, q.event_code, q.description from case_sequence q
               join cases c on c.generation_id = q.generation_id and c.ntsb_no = q.ntsb_no
              where q.generation_id = $1 and c.answer_eligible and c.is_us order by q.ntsb_no, q.aircraft_key, q.occurrence_no`,
} as const;

/** The generation's identity and its answer-eligible US cohort, in one read-only, repeatable-read snapshot. */
export async function loadCodedCorpus(client: pg.ClientBase, generationId: number): Promise<{ source: GenerationSource; corpus: CodedCorpus }> {
  await client.query('begin transaction isolation level repeatable read read only');
  try {
    const source = await readGenerationSource(client, generationId);
    const cases = await client.query<{ ntsb_no: string; ev_year: number | null; state: string | null }>(CORPUS_QUERIES.cases, [generationId]);
    if (cases.rows.length === 0) throw new Error(`generation ${generationId} has no answer-eligible US cases`);
    const aircraft = await client.query<{ ntsb_no: string; aircraft_key: number; category: string | null; defining_phase_group: string | null }>(
      CORPUS_QUERIES.aircraft,
      [generationId],
    );
    const findings = await client.query<{ ntsb_no: string; aircraft_key: number; code: string | null; description: string | null; in_probable_cause: boolean | null }>(
      CORPUS_QUERIES.findings,
      [generationId],
    );
    const sequence = await client.query<{ ntsb_no: string; aircraft_key: number; event_code: string | null; description: string | null }>(
      CORPUS_QUERIES.sequence,
      [generationId],
    );
    await client.query('commit');
    return {
      source,
      corpus: {
        cases: cases.rows.map((r) => ({ ntsbNo: r.ntsb_no, evYear: r.ev_year, state: r.state })),
        aircraft: aircraft.rows.map((r) => ({ ntsbNo: r.ntsb_no, aircraftKey: r.aircraft_key, category: r.category, definingPhaseGroup: r.defining_phase_group })),
        findings: findings.rows.map((r) => ({ ntsbNo: r.ntsb_no, aircraftKey: r.aircraft_key, code: r.code, description: r.description, inProbableCause: r.in_probable_cause })),
        sequence: sequence.rows.map((r) => ({ ntsbNo: r.ntsb_no, aircraftKey: r.aircraft_key, eventCode: r.event_code, description: r.description })),
      },
    };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

/** Pure: every question derived over the corpus, then the dataset. */
export function buildCodedFromCorpus(
  source: GenerationSource,
  corpus: CodedCorpus,
  specs: readonly CodedQuestionSpec[] = CODED_QUESTIONS,
  paraphrases: readonly CodedParaphraseSpec[] = CODED_PARAPHRASES,
  opts: AssembleOptions = {},
): CodedBuild {
  const index = indexCorpus(corpus);
  const derived = new Map<string, Derivation>(specs.map((s) => [s.id, deriveQuestion(index, s)]));
  const stats = codeStats(
    corpus,
    specs.flatMap((s) => s.codeSet.clauses.flatMap((c) => c.codes.map((code) => ({ kind: c.kind, code })))),
  );
  return assembleCoded({ ...source, answerEligibleCases: corpus.cases.length, builder: BUILDER }, specs, paraphrases, derived, stats, opts);
}

export async function buildCoded(client: pg.ClientBase, generationId: number, opts: AssembleOptions = {}): Promise<CodedBuild & { warnings: string[] }> {
  const { source, corpus } = await loadCodedCorpus(client, generationId);
  return { ...buildCodedFromCorpus(source, corpus, CODED_QUESTIONS, CODED_PARAPHRASES, opts), warnings: familyWarnings(corpus, CODE_FAMILIES) };
}

/**
 * Every question's labels re-derived on `generationId` from the code set and filters
 * the dataset records (read-only snapshot), and the frozen-family warnings of that
 * generation: what a run compares with the dataset before anything is embedded.
 */
export async function rederiveCoded(client: pg.ClientBase, generationId: number, dataset: CodedDataset): Promise<{ labels: Map<string, QuestionLabels>; warnings: string[] }> {
  const { corpus } = await loadCodedCorpus(client, generationId);
  const index = indexCorpus(corpus);
  const labels = new Map<string, QuestionLabels>();
  for (const q of dataset.questions) {
    const d = deriveQuestion(index, q);
    labels.set(q.id, { relevant: d.relevant, unreachable: d.unreachable });
  }
  return { labels, warnings: familyWarnings(corpus, CODE_FAMILIES) };
}

/** Only what freezing needs from a committed file, so a later schema change cannot drop the pins. */
const FrozenSplitsSchema = z.object({
  splitsFrozen: z.boolean().optional(),
  questions: z.array(z.object({ id: z.string(), split: z.enum(['dev', 'holdout']) })),
});

/**
 * The frozen splits of a committed dataset file: `frozen` and every question's split
 * when the file is frozen; nothing for a missing or unfrozen file.
 */
export function frozenSplits(text: string | null): { frozen: boolean; pinned: Map<string, Split> } {
  if (text === null) return { frozen: false, pinned: new Map() };
  const parsed = FrozenSplitsSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('the committed coded dataset has no readable splits; its frozen assignment cannot be kept');
  const frozen = parsed.data.splitsFrozen === true;
  return { frozen, pinned: frozen ? new Map(parsed.data.questions.map((q) => [q.id, q.split])) : new Map() };
}

export const serializeCodedDataset = (d: CodedDataset): string => `${JSON.stringify(d, null, 2)}\n`;

function printBuild(built: CodedBuild): void {
  const d = built.dataset;
  console.log(
    `coded set ${d.version} from generation ${d.source.generationId} (${d.source.answerEligibleCases} answer-eligible cases; archive ${d.source.archiveSha256.slice(0, 12)}, ` +
      `mapping ${d.source.mappingVersion}, normalization ${d.source.fieldNormalizationVersion}, citation text ${d.source.citationTextVersion}); splits ${d.splitsFrozen ? 'frozen' : 'not frozen'}`,
  );
  const byId = new Map(d.questions.map((q) => [q.id, q]));
  for (const g of built.groups) {
    console.log(`${g.id} ${g.split} (${g.questions.length} question${g.questions.length === 1 ? '' : 's'})`);
    for (const id of g.questions) {
      const q = byId.get(id);
      if (!q) continue;
      const extra = [
        q.unreachable.length > 0 ? `${q.unreachable.length} unreachable` : '',
        q.needsEventAircraftQualification ? 'needs passages-v2' : '',
      ].filter(Boolean);
      console.log(`    ${String(q.relevant.length).padStart(4)}  ${q.class.padEnd(6)} ${q.id}  [${q.tags.join(', ')}]${extra.length ? ` (${extra.join('; ')})` : ''}`);
    }
  }
  for (const r of built.rejected) console.log(`  REJECTED ${String(r.count).padStart(4)}  ${r.class.padEnd(6)} ${r.id}`);
  const count = (split: string, cls: string) => d.questions.filter((q) => q.split === split && q.class === cls).length;
  const sizes = built.groups.map((g) => g.questions.length);
  console.log(
    `questions: ${d.questions.length} (dev ${count('dev', 'narrow')} narrow + ${count('dev', 'broad')} broad, ` +
      `holdout ${count('holdout', 'narrow')} narrow + ${count('holdout', 'broad')} broad; paraphrases ${d.questions.filter((q) => q.paraphrase_of).length}); ` +
      `groups: ${built.groups.length} (largest ${Math.max(0, ...sizes)}); distinct relevant cases: ${new Set(d.questions.flatMap((q) => q.relevant)).size}`,
  );
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'env-files': { type: 'string' },
      generation: { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean' },
      check: { type: 'boolean' },
      'freeze-splits': { type: 'boolean' },
      'reassign-splits': { type: 'boolean' },
    },
    strict: true,
  });
  const config = evalConfig(values['env-files']);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
  const out = values.out ? resolve(values.out) : DEFAULT_CODED_DATASET;
  const committed = existsSync(out) ? readFileSync(out, 'utf8') : null;
  const { frozen, pinned: committedPins } = frozenSplits(committed);
  const pinned = values['reassign-splits'] ? new Map<string, Split>() : committedPins;
  const client = new pg.Client({ connectionString: config.databaseUrl, application_name: 'aviation-eval-coded' });
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
    const built = await buildCoded(client, generationId, { pinned, splitsFrozen: values['freeze-splits'] === true || frozen });
    printBuild(built);
    const ids = new Set(built.dataset.questions.map((q) => q.id));
    for (const id of pinned.keys()) if (!ids.has(id)) console.warn(`warning: frozen question ${id} is no longer in the set`);
    for (const w of built.warnings) console.warn(`warning: ${w}`);
    if (built.problems.length > 0) {
      for (const p of built.problems) console.error(`problem: ${p}`);
      return 1;
    }
    const text = serializeCodedDataset(built.dataset);
    if (values.check) {
      const current = committed ?? '';
      if (current === text) {
        console.log(`${out} is up to date`);
        return 0;
      }
      const old = current ? (JSON.parse(current) as CodedDataset) : null;
      const before = new Map((old?.questions ?? []).map((q) => [q.id, JSON.stringify(q)]));
      for (const q of built.dataset.questions) if (before.get(q.id) !== JSON.stringify(q)) console.error(`differs: ${q.id}`);
      if (old && JSON.stringify(old.source) !== JSON.stringify(built.dataset.source)) console.error('differs: source');
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

if (process.argv[1] && resolve(process.argv[1]) === resolve(APP_DIR, BUILDER)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
