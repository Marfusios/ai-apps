/**
 * Track N pool inputs (round 4): the cached scope outputs and query vectors every
 * retrieval version's pool runs read. Versioned by content (provenance outside), checked
 * against the dataset, generation and configured embedding (every member's samples, each
 * keyword text resolving as the pipeline resolves it, a diagnostic's frozen scope output
 * unchanged, every member's vector), and answered from without paying.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QUERY_INPUT_TEMPLATE_VERSION, queryEmbeddingInput } from '../../server/ai/embeddings.js';
import { pipelineIntent } from '../../evals/retrieval/adoption/validate.js';
import { questionSha } from '../../evals/retrieval/experiments/scope.js';
import { NarrativeDatasetSchema } from '../../evals/retrieval/narrative/dataset.js';
import {
  assembleInputs,
  decodeVector,
  encodeVector,
  inputSamples,
  inputsEmbedder,
  inputsVersion,
  keywordTextsOf,
  membersToSample,
  poolInputsProblems,
  savedVectors,
  type PoolInputs,
} from '../../evals/retrieval/narrative/inputs.js';
import { sha256 } from '../../evals/retrieval/narrative/spec.js';

const APP_DIR = resolve(import.meta.dirname, '../..');
const d = NarrativeDatasetSchema.parse(JSON.parse(readFileSync(resolve(APP_DIR, 'evals/retrieval/narrative/dataset.json'), 'utf8')));
const DIMS = 4;
const target = { generationId: d.source.generationId, model: 'text-embedding-3-small', dims: DIMS };
const vectorOf = (i: number) => Float32Array.from([i, i + 0.5, -i, 1 / (i + 1)]);

/** A scope run over the sampled members: every sample answered, its keyword text resolved as the pipeline resolves it. */
function scopeRun(samples = 3) {
  return {
    samples: membersToSample(d).flatMap((q) =>
      Array.from({ length: samples }, (_, i) => {
        const planner = { intent: 'case_search', plannerKeywordText: `${q.id.replace(/-/g, ' ')} sample ${i + 1}`, plannerFilters: {} };
        return { id: q.id, questionSha256: questionSha(q.question), sample: i + 1, status: 'ok' as const, ...planner, keywordText: pipelineIntent(q.question, planner).keywordText, attempts: [] };
      }),
    ),
  };
}

function inputs(over: { samples?: number; provenance?: Record<string, unknown> } = {}): PoolInputs {
  const vectors = new Map(d.questions.map((q, i) => [queryEmbeddingInput(q.question), vectorOf(i)]));
  return assembleInputs({
    dataset: d,
    generationId: d.source.generationId,
    scope: { model: 'claude-haiku-5-5', promptVersion: 'scope.v2', samples: inputSamples(d, scopeRun(over.samples)) },
    embedding: { model: target.model, dims: DIMS },
    vectors,
    ...(over.provenance ? { provenance: over.provenance } : {}),
  });
}

const reversion = (p: PoolInputs): PoolInputs => ({ ...p, version: inputsVersion(p) });

describe('pool inputs', () => {
  it('sample every member but a diagnostic with a frozen scope output, which keeps it', () => {
    const sampled = membersToSample(d).map((q) => q.id);
    expect(sampled).toHaveLength(d.questions.length - 1);
    expect(sampled).not.toContain('per-pilot-decision-cause-weight-shift');
    const frozen = inputSamples(d, null);
    expect(frozen.map((s) => [s.member, s.sample, s.source, s.keywordText])).toEqual(
      [1, 2, 3].map((n) => ['per-pilot-decision-cause-weight-shift', n, 'frozen', 'weight-shift pilot decision making probable cause judgment']),
    );
  });

  it('are versioned by content, with provenance outside the version', () => {
    const a = inputs();
    expect(a.version).toBe(inputsVersion(a));
    expect(inputs({ provenance: { run: 'x', chargedUsd: 0.04 } }).version).toBe(a.version);
    expect(a.embedding.inputTemplate).toBe(QUERY_INPUT_TEMPLATE_VERSION);
    const edited = { ...a, scope: { ...a.scope, samples: a.scope.samples.map((s, i) => (i === 0 ? { ...s, keywordText: `${s.keywordText} more` } : s)) } };
    expect(inputsVersion(edited)).not.toBe(a.version);
    expect(inputs({ samples: 1 }).version).not.toBe(a.version);
  });

  it('pass the checks when complete, and name what is wrong otherwise', () => {
    const a = inputs();
    expect(poolInputsProblems(a, d, target)).toEqual([]);
    expect(poolInputsProblems(inputs({ samples: 1 }), d, target)).toEqual([]);
    expect(poolInputsProblems({ ...a, version: 'f'.repeat(64) }, d, target)).toEqual(['the inputs version does not match their content']);
    expect(poolInputsProblems(reversion({ ...a, datasetSpecSha256: 'x' }), d, target)).toEqual(['the inputs were taken for another dataset (spec hash differs)']);
    expect(poolInputsProblems(a, d, { ...target, generationId: 2 })[0]).toMatch(/generation/);
    expect(poolInputsProblems(a, d, { ...target, dims: 8 })[0]).toMatch(/configured embedding/);
    const first = a.scope.samples.find((s) => s.source === 'scope-stage') as PoolInputs['scope']['samples'][number];
    // A keyword text that does not resolve from its scope output.
    const unresolved = reversion({ ...a, scope: { ...a.scope, samples: a.scope.samples.map((s) => (s === first ? { ...s, keywordText: 'something else' } : s)) } });
    expect(poolInputsProblems(unresolved, d, target)).toEqual([`${first.member}: sample 1's keyword text does not resolve from its scope output as the pipeline resolves it`]);
    // A member without samples, and members with different numbers of samples.
    const missing = reversion({ ...a, scope: { ...a.scope, samples: a.scope.samples.filter((s) => s.member !== first.member) } });
    expect(poolInputsProblems(missing, d, target)).toEqual([`${first.member}: no scope sample`]);
    const uneven = reversion({ ...a, scope: { ...a.scope, samples: a.scope.samples.filter((s) => !(s.member === first.member && s.sample > 1)) } });
    expect(poolInputsProblems(uneven, d, target)).toEqual(['sampled members have different numbers of scope samples (1, 3)']);
    // The diagnostic's frozen scope output cannot be replaced by a new sample.
    const resampled = reversion({ ...a, scope: { ...a.scope, samples: a.scope.samples.map((s) => (s.source === 'frozen' ? { ...s, source: 'scope-stage' as const } : s)) } });
    expect(poolInputsProblems(resampled, d, target)).toEqual(["per-pilot-decision-cause-weight-shift: the samples are not the diagnostic's frozen scope output"]);
    // A failed sample falls back to the question.
    const failed = reversion({ ...a, scope: { ...a.scope, samples: a.scope.samples.map((s) => (s === first ? { ...s, status: 'failed' as const, intent: null, plannerKeywordText: null, plannerFilters: null, keywordText: 'not the question' } : s)) } });
    expect(poolInputsProblems(failed, d, target)).toEqual([`${first.member}: failed sample 1 does not fall back to the question`]);
    // Every member's question has a vector of the right dimensions.
    const noVector = reversion({ ...a, embedding: { ...a.embedding, vectors: a.embedding.vectors.slice(1) } });
    expect(poolInputsProblems(noVector, d, target).some((p) => p.endsWith('no cached query vector'))).toBe(true);
    const short = reversion({ ...a, embedding: { ...a.embedding, vectors: a.embedding.vectors.map((v, i) => (i === 0 ? { ...v, vector: encodeVector(Float32Array.from([1, 2])) } : v)) } });
    expect(poolInputsProblems(short, d, target)).toContain('a cached vector has 2 dimensions, expected 4');
  });

  it('answer every member\'s query from the cached vectors, and give each member its keyword texts by sample', async () => {
    const a = inputs();
    const e = inputsEmbedder(a);
    const q = d.questions[2] as (typeof d.questions)[number];
    const r = await e.embed([queryEmbeddingInput(q.question)]);
    expect(Array.from(r.vectors[0] as Float32Array)).toEqual(Array.from(vectorOf(2)));
    await expect(e.embed(['a question nobody embedded'])).rejects.toThrow(/not embedded up front/);
    expect(e.usdPerMillionTokens).toBe(0);
    const texts = keywordTextsOf(a);
    expect(texts.get(q.id)?.map((x) => x.sample)).toEqual([1, 2, 3]);
    expect(texts.get('per-pilot-decision-cause-weight-shift')?.map((x) => x.keywordText)).toEqual(Array(3).fill('weight-shift pilot decision making probable cause judgment'));
    expect(Array.from(decodeVector(encodeVector(vectorOf(3)), DIMS))).toEqual(Array.from(vectorOf(3)));
  });

  it('reuse saved vectors from an adoption vectors file or an inputs file, for the configured embedding only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'track-n-inputs-'));
    const input = queryEmbeddingInput('Which accidents?');
    const adoption = join(dir, 'adoption.json');
    writeFileSync(adoption, JSON.stringify({ kind: 'eval-retrieval-adoption-vectors', model: target.model, dims: DIMS, inputTemplate: QUERY_INPUT_TEMPLATE_VERSION, vectors: [{ sha256: sha256(input), input, vector: encodeVector(vectorOf(7)) }] }));
    expect(Array.from(savedVectors(adoption, target.model, DIMS).get(input) as Float32Array)).toEqual(Array.from(vectorOf(7)));
    expect(() => savedVectors(adoption, 'another-model', DIMS)).toThrow(/configured embedding/);
    const tampered = join(dir, 'tampered.json');
    writeFileSync(tampered, JSON.stringify({ kind: 'eval-retrieval-adoption-vectors', model: target.model, dims: DIMS, inputTemplate: QUERY_INPUT_TEMPLATE_VERSION, vectors: [{ sha256: sha256('other'), input, vector: encodeVector(vectorOf(7)) }] }));
    expect(() => savedVectors(tampered, target.model, DIMS)).toThrow(/does not match its hash/);
    const own = join(dir, 'inputs.json');
    writeFileSync(own, JSON.stringify(inputs()));
    expect(savedVectors(own, target.model, DIMS).size).toBe(new Set(d.questions.map((q) => q.question)).size);
    const other = join(dir, 'other.json');
    writeFileSync(other, JSON.stringify({ kind: 'something' }));
    expect(() => savedVectors(other, target.model, DIMS)).toThrow(/neither/);
  });
});
