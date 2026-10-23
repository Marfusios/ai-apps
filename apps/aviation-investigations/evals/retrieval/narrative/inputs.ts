/**
 * Track N pool inputs (task 10c-2 round 4): the cached inputs every retrieval version's
 * pool runs read, taken once so the versions see identical inputs.
 *
 * - **Scope outputs**: per member and scope sample, the scope stage's output (intent,
 *   keyword text, filters) and the keyword text the brief pipeline resolves from it
 *   (`resolveIntent`; the question when the stage failed). Taken by the paid `pools` run
 *   (`source: scope-stage`), or a diagnostic's frozen scope output (`source: frozen`,
 *   `NarrativeDiagnosticSchema.scope`), which is never sampled again.
 * - **Query vectors**: one per member, the embedding of the member's question as the
 *   pipeline embeds it (`queryEmbeddingInput`, the configured model and dimensions),
 *   embedded by the paid run or reused from a saved vector file (`savedVectors`).
 *
 * The file is versioned by its content (`inputsVersion`; provenance such as charges is
 * outside the version) and checked before use (`poolInputsProblems`): the dataset and
 * generation, every member's samples (their question hash, and each keyword text
 * resolving from its scope output as the pipeline resolves it), every member's vector
 * (input hash, dimensions) and the embedding. `pools --inputs <file>` rebuilds the pools
 * from it without paying anything.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QUERY_INPUT_TEMPLATE_VERSION, queryEmbeddingInput, type Embedder } from '../../../server/ai/embeddings.js';
import { pipelineIntent } from '../adoption/validate.js';
import { questionSha, type ScopeRun } from '../experiments/scope.js';
import { precomputedEmbedder } from '../harness.js';
import type { NarrativeDataset, NarrativeItem } from './dataset.js';
import { canonicalJson, sha256 } from './spec.js';

export interface PoolInputSample {
  member: string;
  sample: number;
  questionSha256: string;
  /** `scope-stage`: sampled for the pools; `frozen`: a diagnostic's frozen scope output. */
  source: 'scope-stage' | 'frozen';
  status: 'ok' | 'failed';
  intent: string | null;
  plannerKeywordText: string | null;
  plannerFilters: unknown;
  /** The keyword text the pipeline searches with; the question when the scope stage failed. */
  keywordText: string;
}

export interface PoolInputVector {
  /** The embedding input (`queryEmbeddingInput` of a member's question). */
  input: string;
  sha256: string;
  /** Little-endian float32, base64. */
  vector: string;
}

export interface PoolInputs {
  kind: 'track-n-pool-inputs';
  datasetSpecSha256: string;
  generationId: number;
  scope: { model: string; promptVersion: string | null; samples: PoolInputSample[] };
  embedding: { model: string; dims: number; inputTemplate: string; vectors: PoolInputVector[] };
  version: string;
  /** Where the inputs came from (the run, its charges, a reused vector file): outside the version. */
  provenance?: Record<string, unknown>;
}

/** The inputs' version: sha256 over everything but the version and the provenance. */
export const inputsVersion = (p: Omit<PoolInputs, 'version' | 'provenance'> & { version?: string; provenance?: unknown }): string => {
  const { version: _version, provenance: _provenance, ...body } = p;
  return sha256(canonicalJson(body));
};

export const encodeVector = (v: Float32Array): string => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');

export function decodeVector(b64: string, dims: number): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength !== dims * 4) throw new Error(`a cached vector has ${buf.byteLength / 4} dimensions, expected ${dims}`);
  return Float32Array.from(new Float32Array(buf.buffer, buf.byteOffset, dims));
}

/** A diagnostic family's frozen scope output, when it has one. */
export const frozenScopeOf = (d: NarrativeDataset, member: Pick<NarrativeItem, 'family'>) => d.questions.find((q) => q.id === member.family)?.diagnostic?.scope ?? null;

/** The members whose scope outputs the pools must sample (every member without a frozen one). */
export const membersToSample = (d: NarrativeDataset): NarrativeItem[] => d.questions.filter((q) => frozenScopeOf(d, q) === null);

/** Every member's samples: the scope run's for the sampled members, the frozen ones for a diagnostic's. */
export function inputSamples(d: NarrativeDataset, run: Pick<ScopeRun, 'samples'> | null): PoolInputSample[] {
  const out: PoolInputSample[] = [];
  for (const q of d.questions) {
    const frozen = frozenScopeOf(d, q);
    if (frozen) {
      for (const s of frozen.samples) {
        out.push({ member: q.id, sample: s.sample, questionSha256: questionSha(q.question), source: 'frozen', status: 'ok', intent: s.intent, plannerKeywordText: s.plannerKeywordText, plannerFilters: s.plannerFilters, keywordText: s.keywordText });
      }
      continue;
    }
    for (const s of (run?.samples ?? []).filter((x) => x.id === q.id).sort((a, b) => a.sample - b.sample)) {
      out.push({ member: q.id, sample: s.sample, questionSha256: s.questionSha256, source: 'scope-stage', status: s.status, intent: s.intent, plannerKeywordText: s.plannerKeywordText, plannerFilters: s.plannerFilters, keywordText: s.keywordText });
    }
  }
  return out;
}

/** The inputs file from its parts, versioned. */
export function assembleInputs(input: {
  dataset: NarrativeDataset;
  generationId: number;
  scope: { model: string; promptVersion: string | null; samples: PoolInputSample[] };
  embedding: { model: string; dims: number };
  vectors: ReadonlyMap<string, Float32Array>;
  provenance?: Record<string, unknown>;
}): PoolInputs {
  const inputs = [...new Set(input.dataset.questions.map((q) => queryEmbeddingInput(q.question)))].sort();
  const vectors: PoolInputVector[] = inputs.map((i) => {
    const v = input.vectors.get(i);
    if (!v) throw new Error('a member question has no query vector');
    return { input: i, sha256: sha256(i), vector: encodeVector(v) };
  });
  const body: Omit<PoolInputs, 'version' | 'provenance'> = {
    kind: 'track-n-pool-inputs',
    datasetSpecSha256: input.dataset.source.specSha256,
    generationId: input.generationId,
    scope: { ...input.scope, samples: [...input.scope.samples].sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : a.sample - b.sample)) },
    embedding: { model: input.embedding.model, dims: input.embedding.dims, inputTemplate: QUERY_INPUT_TEMPLATE_VERSION, vectors },
  };
  return { ...body, version: inputsVersion(body), ...(input.provenance ? { provenance: input.provenance } : {}) };
}

/** Problems of an inputs file against the dataset, the target generation and the configured embedding (empty: usable). */
export function poolInputsProblems(p: PoolInputs, d: NarrativeDataset, target: { generationId: number; model: string; dims: number }): string[] {
  const problems: string[] = [];
  if (p.kind !== 'track-n-pool-inputs') return ['not a Track N pool inputs file'];
  if (inputsVersion(p) !== p.version) problems.push('the inputs version does not match their content');
  if (p.datasetSpecSha256 !== d.source.specSha256) problems.push('the inputs were taken for another dataset (spec hash differs)');
  if (p.generationId !== target.generationId) problems.push(`the inputs were taken on generation ${p.generationId}, the target is ${target.generationId}`);
  const e = p.embedding;
  if (e.model !== target.model || e.dims !== target.dims || e.inputTemplate !== QUERY_INPUT_TEMPLATE_VERSION) problems.push(`the vectors are ${e.model}/${e.dims}/${e.inputTemplate}, the configured embedding is ${target.model}/${target.dims}/${QUERY_INPUT_TEMPLATE_VERSION}`);
  const members = new Map(d.questions.map((q) => [q.id, q]));
  for (const s of p.scope.samples) if (!members.has(s.member)) problems.push(`samples of ${s.member}, which is not a question of the dataset`);
  const counts = new Set<number>();
  for (const q of d.questions) {
    const mine = p.scope.samples.filter((s) => s.member === q.id);
    if (mine.length === 0) {
      problems.push(`${q.id}: no scope sample`);
      continue;
    }
    if (mine.some((s, i) => s.sample !== i + 1)) problems.push(`${q.id}: the samples are not numbered 1, 2, ...`);
    const frozen = frozenScopeOf(d, q);
    if (frozen) {
      const want = frozen.samples.map((s) => ({ sample: s.sample, intent: s.intent, plannerKeywordText: s.plannerKeywordText, plannerFilters: s.plannerFilters, keywordText: s.keywordText }));
      const got = mine.map((s) => ({ sample: s.sample, intent: s.intent, plannerKeywordText: s.plannerKeywordText, plannerFilters: s.plannerFilters, keywordText: s.keywordText }));
      if (canonicalJson(want) !== canonicalJson(got) || mine.some((s) => s.source !== 'frozen' || s.status !== 'ok')) problems.push(`${q.id}: the samples are not the diagnostic's frozen scope output`);
    } else {
      counts.add(mine.length);
      if (mine.some((s) => s.source !== 'scope-stage')) problems.push(`${q.id}: a sampled member's samples come from the scope stage`);
    }
    for (const s of mine) {
      if (s.questionSha256 !== questionSha(q.question)) problems.push(`${q.id}: sample ${s.sample} was taken for another question text`);
      if (s.status === 'failed') {
        if (s.keywordText !== q.question) problems.push(`${q.id}: failed sample ${s.sample} does not fall back to the question`);
        continue;
      }
      let resolved: string;
      try {
        resolved = pipelineIntent(q.question, { intent: s.intent, plannerKeywordText: s.plannerKeywordText, plannerFilters: s.plannerFilters }).keywordText;
      } catch {
        resolved = '';
      }
      if (resolved !== s.keywordText) problems.push(`${q.id}: sample ${s.sample}'s keyword text does not resolve from its scope output as the pipeline resolves it`);
    }
  }
  if (counts.size > 1) problems.push(`sampled members have different numbers of scope samples (${[...counts].sort().join(', ')})`);
  const vectors = new Map(e.vectors.map((v) => [v.input, v]));
  for (const v of e.vectors) {
    if (sha256(v.input) !== v.sha256) problems.push('a cached vector\'s input does not match its hash');
    try {
      decodeVector(v.vector, e.dims);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  for (const q of d.questions) if (!vectors.has(queryEmbeddingInput(q.question))) problems.push(`${q.id}: no cached query vector`);
  return [...new Set(problems)];
}

/** Each member's keyword texts by sample. */
export function keywordTextsOf(p: PoolInputs): Map<string, { sample: number; keywordText: string }[]> {
  const out = new Map<string, { sample: number; keywordText: string }[]>();
  for (const s of p.scope.samples) out.set(s.member, [...(out.get(s.member) ?? []), { sample: s.sample, keywordText: s.keywordText }]);
  for (const list of out.values()) list.sort((a, b) => a.sample - b.sample);
  return out;
}

/** The embedder that answers every member's query from the cached vectors (nothing paid). */
export function inputsEmbedder(p: PoolInputs): Embedder {
  return precomputedEmbedder({ model: p.embedding.model, dims: p.embedding.dims, usdPerMillionTokens: 0 }, new Map(p.embedding.vectors.map((v) => [v.input, decodeVector(v.vector, p.embedding.dims)])));
}

export function readPoolInputs(file: string): PoolInputs {
  const p = JSON.parse(readFileSync(resolve(file), 'utf8')) as PoolInputs;
  if (p.kind !== 'track-n-pool-inputs') throw new Error(`${file} is not a Track N pool inputs file`);
  return p;
}

/**
 * Saved query vectors for the configured embedding: a task 10e adoption vectors file
 * (`eval-retrieval-adoption-vectors`) or a Track N inputs file. Each entry's input must
 * match its hash; a file for another model, dimensions or input template is refused.
 */
export function savedVectors(file: string, model: string, dims: number): Map<string, Float32Array> {
  const f = JSON.parse(readFileSync(resolve(file), 'utf8')) as { kind?: string; model?: string; dims?: number; inputTemplate?: string; vectors?: { sha256: string; input: string; vector: string }[]; embedding?: PoolInputs['embedding'] };
  const e = f.kind === 'track-n-pool-inputs' ? f.embedding : f.kind === 'eval-retrieval-adoption-vectors' ? { model: f.model, dims: f.dims, inputTemplate: f.inputTemplate, vectors: f.vectors } : null;
  if (!e || !e.vectors) throw new Error(`${file} is neither an adoption vectors file nor a Track N inputs file`);
  if (e.model !== model || e.dims !== dims || e.inputTemplate !== QUERY_INPUT_TEMPLATE_VERSION) throw new Error(`${file} holds ${e.model}/${e.dims}/${e.inputTemplate} vectors, the configured embedding is ${model}/${dims}/${QUERY_INPUT_TEMPLATE_VERSION}`);
  const out = new Map<string, Float32Array>();
  for (const v of e.vectors) {
    if (sha256(v.input) !== v.sha256) throw new Error(`${file}: a vector's input does not match its hash`);
    out.set(v.input, decodeVector(v.vector, dims));
  }
  return out;
}
