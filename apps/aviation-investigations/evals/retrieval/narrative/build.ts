/**
 * Build the narrative-relevance dataset (`evals/retrieval/narrative/dataset.json`) from
 * a dataset generation: each question's cohort (every case of a bounded cohort, the
 * size of a broad one) and the coded positives of its related codes, read in one
 * read-only, repeatable-read snapshot with `DATABASE_URL` (the app role).
 * Deterministic: the same generation always gives the same file.
 *
 *   pnpm eval:retrieval:narrative build [--env-files <a,b>] [--generation <id>] [--out <file>] [--dry-run | --check]
 *
 * The snapshot reads the generation's identity, the answer-eligible US cases (year,
 * state, highest injury, basic weather, light), their aircraft (category, defining
 * phase group, FAR part, purpose) and engine types, and, when a question has related
 * codes, the Track C corpus (findings and sequence rows; never `cause_factor`). No
 * narrative text is read. Prints case counts, never configuration values.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { APP_DIR } from '../../../worker/config.js';
import { CORPUS_QUERIES } from '../coded/build-coded.js';
import { CodedFiltersSchema, deriveQuestion, indexCorpus, type CodedCorpus } from '../coded/coded.js';
import { readGenerationSource, type GenerationSource } from '../generation.js';
import { assembleNarrative, deriveCohort, type CohortAircraft, type CohortCase, type NarrativeBuild, type NarrativeDataset } from './dataset.js';
import { NARRATIVE_PARAPHRASES, NARRATIVE_QUESTIONS } from './questions.js';
import type { NarrativeParaphraseSpec, NarrativeQuestionSpec } from './spec.js';

export const DEFAULT_NARRATIVE_DATASET = resolve(APP_DIR, 'evals/retrieval/narrative/dataset.json');
export const BUILDER = 'evals/retrieval/narrative/build.ts';

/** The cohort's rows, ordered; every value a bind parameter. No narrative text. */
export const COHORT_QUERIES = {
  cases: `select c.ntsb_no, c.ev_year, c.state, c.highest_injury, c.wx_cond_basic, c.light_cond from cases c
           where c.generation_id = $1 and c.answer_eligible and c.is_us order by c.ntsb_no`,
  aircraft: `select a.ntsb_no, a.aircraft_key, a.category, a.defining_phase_group, a.far_part, a.purpose from case_aircraft a
               join cases c on c.generation_id = a.generation_id and c.ntsb_no = a.ntsb_no
              where a.generation_id = $1 and c.answer_eligible and c.is_us order by a.ntsb_no, a.aircraft_key`,
  engines: `select e.ntsb_no, e.aircraft_key, e.eng_type from case_engines e
              join cases c on c.generation_id = e.generation_id and c.ntsb_no = e.ntsb_no
             where e.generation_id = $1 and c.answer_eligible and c.is_us and e.eng_type is not null
             order by e.ntsb_no, e.aircraft_key, e.eng_no`,
} as const;

export interface NarrativeCorpus {
  source: GenerationSource;
  cohort: CohortCase[];
  /** The Track C corpus, when some question has related codes. */
  coded: CodedCorpus | null;
}

/** The generation's identity and its answer-eligible US cohort, in one read-only, repeatable-read snapshot. */
export async function loadNarrativeCorpus(client: pg.ClientBase, generationId: number, withCoded: boolean): Promise<NarrativeCorpus> {
  await client.query('begin transaction isolation level repeatable read read only');
  try {
    const source = await readGenerationSource(client, generationId);
    const cases = await client.query<{ ntsb_no: string; ev_year: number | null; state: string | null; highest_injury: string | null; wx_cond_basic: string | null; light_cond: string | null }>(
      COHORT_QUERIES.cases,
      [generationId],
    );
    if (cases.rows.length === 0) throw new Error(`generation ${generationId} has no answer-eligible US cases`);
    const aircraft = await client.query<{ ntsb_no: string; aircraft_key: number; category: string | null; defining_phase_group: string | null; far_part: string | null; purpose: string | null }>(
      COHORT_QUERIES.aircraft,
      [generationId],
    );
    const engines = await client.query<{ ntsb_no: string; aircraft_key: number; eng_type: string }>(COHORT_QUERIES.engines, [generationId]);
    let coded: CodedCorpus | null = null;
    if (withCoded) {
      const q = <R extends pg.QueryResultRow>(sql: string) => client.query<R>(sql, [generationId]);
      const cc = await q<{ ntsb_no: string; ev_year: number | null; state: string | null }>(CORPUS_QUERIES.cases);
      const ca = await q<{ ntsb_no: string; aircraft_key: number; category: string | null; defining_phase_group: string | null }>(CORPUS_QUERIES.aircraft);
      const cf = await q<{ ntsb_no: string; aircraft_key: number; code: string | null; description: string | null; in_probable_cause: boolean | null }>(CORPUS_QUERIES.findings);
      const cs = await q<{ ntsb_no: string; aircraft_key: number; event_code: string | null; description: string | null }>(CORPUS_QUERIES.sequence);
      coded = {
        cases: cc.rows.map((r) => ({ ntsbNo: r.ntsb_no, evYear: r.ev_year, state: r.state })),
        aircraft: ca.rows.map((r) => ({ ntsbNo: r.ntsb_no, aircraftKey: r.aircraft_key, category: r.category, definingPhaseGroup: r.defining_phase_group })),
        findings: cf.rows.map((r) => ({ ntsbNo: r.ntsb_no, aircraftKey: r.aircraft_key, code: r.code, description: r.description, inProbableCause: r.in_probable_cause })),
        sequence: cs.rows.map((r) => ({ ntsbNo: r.ntsb_no, aircraftKey: r.aircraft_key, eventCode: r.event_code, description: r.description })),
      };
    }
    await client.query('commit');
    const engineTypes = new Map<string, Set<string>>();
    for (const e of engines.rows) {
      const key = `${e.ntsb_no}/${e.aircraft_key}`;
      engineTypes.set(key, (engineTypes.get(key) ?? new Set()).add(e.eng_type));
    }
    const byCase = new Map<string, CohortAircraft[]>();
    for (const a of aircraft.rows) {
      byCase.set(a.ntsb_no, [
        ...(byCase.get(a.ntsb_no) ?? []),
        {
          aircraftKey: a.aircraft_key,
          category: a.category,
          phase: a.defining_phase_group,
          farPart: a.far_part,
          purpose: a.purpose,
          engines: [...(engineTypes.get(`${a.ntsb_no}/${a.aircraft_key}`) ?? [])].sort(),
        },
      ]);
    }
    const cohort: CohortCase[] = cases.rows.map((r) => ({
      ntsbNo: r.ntsb_no,
      evYear: r.ev_year,
      state: r.state,
      injury: r.highest_injury,
      conditions: r.wx_cond_basic,
      light: r.light_cond,
      aircraft: byCase.get(r.ntsb_no) ?? [],
    }));
    return { source, cohort, coded };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  }
}

/** Pure: every family's cohort and related positives, then the dataset. */
export function buildNarrativeFromCorpus(
  corpus: NarrativeCorpus,
  specs: readonly NarrativeQuestionSpec[] = NARRATIVE_QUESTIONS,
  paraphrases: readonly NarrativeParaphraseSpec[] = NARRATIVE_PARAPHRASES,
): NarrativeBuild {
  const cohorts = new Map<string, string[]>();
  const related = new Map<string, string[]>();
  const index = corpus.coded ? indexCorpus(corpus.coded) : null;
  const relatedProblems: string[] = [];
  for (const s of specs) {
    cohorts.set(s.id, deriveCohort(corpus.cohort, s.filters));
    if (!s.relatedCodes) continue;
    const filters = CodedFiltersSchema.safeParse(s.filters);
    if (!index || !filters.success) {
      relatedProblems.push(`${s.id}: related codes cannot be derived (${index ? 'filters outside Track C' : 'no coded corpus'})`);
      continue;
    }
    related.set(s.id, deriveQuestion(index, { filters: filters.data, codeSet: s.relatedCodes }).relevant);
  }
  const built = assembleNarrative({ ...corpus.source, answerEligibleCases: corpus.cohort.length, builder: BUILDER }, specs, paraphrases, cohorts, related);
  return { dataset: built.dataset, problems: [...new Set([...relatedProblems, ...built.problems])] };
}

export async function buildNarrative(client: pg.ClientBase, generationId: number): Promise<NarrativeBuild> {
  const corpus = await loadNarrativeCorpus(client, generationId, NARRATIVE_QUESTIONS.some((s) => s.relatedCodes !== undefined));
  return buildNarrativeFromCorpus(corpus);
}

export const serializeNarrativeDataset = (d: NarrativeDataset): string => `${JSON.stringify(d, null, 2)}\n`;

export function printNarrativeBuild(built: NarrativeBuild, log: (m: string) => void = console.log): void {
  const d = built.dataset;
  log(
    `narrative set ${d.version} from generation ${d.source.generationId} (${d.source.answerEligibleCases} answer-eligible cases; archive ${d.source.archiveSha256.slice(0, 12)}, ` +
      `mapping ${d.source.mappingVersion}, normalization ${d.source.fieldNormalizationVersion}, citation text ${d.source.citationTextVersion})`,
  );
  for (const q of d.questions) {
    const extra = [q.paraphrase_of ? `paraphrase of ${q.paraphrase_of}` : '', q.relatedPositives.length > 0 ? `${q.relatedPositives.length} related positives` : '']
      .filter(Boolean)
      .join('; ');
    log(`  ${String(q.cohort.size).padStart(6)}  ${q.type.padEnd(14)} ${q.id}  [${q.tags.join(', ')}]${extra ? ` (${extra})` : ''}`);
  }
  const originals = d.questions.filter((q) => !q.paraphrase_of);
  log(
    `questions: ${d.questions.length} (${originals.length} families, ${d.questions.length - originals.length} paraphrases); ` +
      `bounded cohorts: ${originals.filter((q) => q.type === 'bounded-cohort').length} families, ${originals.filter((q) => q.type === 'bounded-cohort').reduce((n, q) => n + q.cohort.size, 0)} cases`,
  );
}

/** `build` (cli.ts): write the dataset, or compare (`check`), or print only (`dryRun`). Returns the exit code. */
export async function buildCommand(opts: { databaseUrl: string; generation?: number; out?: string; check: boolean; dryRun: boolean; log?: (m: string) => void }): Promise<number> {
  const log = opts.log ?? console.log;
  const out = opts.out ? resolve(opts.out) : DEFAULT_NARRATIVE_DATASET;
  const client = new pg.Client({ connectionString: opts.databaseUrl, application_name: 'aviation-eval-narrative' });
  await client.connect();
  try {
    let generationId = opts.generation;
    if (generationId === undefined) {
      const r = await client.query<{ generation_id: string }>('select generation_id from dataset_manifests where active');
      if (!r.rows[0]) throw new Error('no dataset manifest is active; pass --generation');
      generationId = Number(r.rows[0].generation_id);
    }
    const built = await buildNarrative(client, generationId);
    printNarrativeBuild(built, log);
    if (built.problems.length > 0) {
      for (const p of built.problems) console.error(`problem: ${p}`);
      return 1;
    }
    const text = serializeNarrativeDataset(built.dataset);
    if (opts.check) {
      const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
      if (current === text) {
        log(`${out} is up to date`);
        return 0;
      }
      const old = current ? (JSON.parse(current) as NarrativeDataset) : null;
      const before = new Map((old?.questions ?? []).map((q) => [q.id, JSON.stringify(q)]));
      for (const q of built.dataset.questions) if (before.get(q.id) !== JSON.stringify(q)) console.error(`differs: ${q.id}`);
      if (old && JSON.stringify(old.source) !== JSON.stringify(built.dataset.source)) console.error('differs: source');
      return 1;
    }
    if (opts.dryRun) return 0;
    writeFileSync(out, text);
    log(`wrote ${out}`);
    return 0;
  } finally {
    await client.end();
  }
}
