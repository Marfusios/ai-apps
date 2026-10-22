/**
 * The passages index compatibility contract (DATA_PIPELINE "Passages validation";
 * review gate G5 #5). One check used by `worker publish`, the API's dataset loader
 * (`server/dataset.ts`) and retrieval (`server/search/hybrid.ts`): a passages index
 * is served only when its `_meta` names
 * - the generation being served;
 * - the approved index version (`passages-v1`);
 * - the approved chunker (`chunk-v2`) and embedding-input template (`input-v1`);
 * - the configured embedding model and dimensions;
 * - the approved mapping fingerprint for that model and dimension count.
 * A missing, unknown or different value is refused; nothing is inferred.
 *
 * The approved fingerprints are recorded here, not computed, so the API does not
 * load the worker's mapping and analysis code. A unit test recomputes each one with
 * `passagesIndexFingerprint` (worker/index/passages-index.ts): changing the mapping,
 * analysis, chunking, template, tokenizer or model fails that test until a new
 * version is approved here.
 *
 * `worker publish` also compares the index's document count with the generation's
 * `passages` rows for the approved chunker version.
 */
import type { Client } from '@elastic/elasticsearch';
import { readIndexMeta, type IndexMeta, type IndexMetaOptions } from './index-meta.js';

export interface PassagesContract {
  indexVersion: string;
  chunkerVersion: string;
  inputTemplateVersion: string;
  /** Approved mapping fingerprint per embedding, keyed `<model>/<dims>`. */
  fingerprints: Readonly<Record<string, string>>;
}

export const PASSAGES_CONTRACT: PassagesContract = Object.freeze({
  indexVersion: 'passages-v1',
  chunkerVersion: 'chunk-v2',
  inputTemplateVersion: 'input-v1',
  fingerprints: Object.freeze({
    // The shared dev index (generation 1, built at d2b9db8) records this fingerprint.
    'text-embedding-3-small/1536': '57d731b28445deb4369951a92c767414376b6d78cc312c1cdea4a8b822375b5b',
  }),
});

export const embeddingKey = (model: string, dims: number): string => `${model}/${dims}`;

/** What the served dataset expects of its passages index. */
export interface PassagesExpectation {
  generationId: number;
  /** The configured embedding model and dimensions (the query embedder's). */
  model: string;
  dims: number;
}

/** Every way `meta` breaks the contract; empty when the index can be served. */
export function passagesIndexProblems(meta: IndexMeta, expect: PassagesExpectation, contract: PassagesContract = PASSAGES_CONTRACT): string[] {
  const out: string[] = [];
  const show = (v: string | number | null) => (v === null ? 'none' : String(v));
  if (meta.generationId !== expect.generationId) out.push(`generation ${show(meta.generationId)} (expected ${expect.generationId})`);
  if (meta.indexVersion !== contract.indexVersion) out.push(`index version ${show(meta.indexVersion)} (expected ${contract.indexVersion})`);
  if (meta.chunkerVersion !== contract.chunkerVersion) out.push(`chunker ${show(meta.chunkerVersion)} (expected ${contract.chunkerVersion})`);
  if (meta.inputTemplateVersion !== contract.inputTemplateVersion) {
    out.push(`input template ${show(meta.inputTemplateVersion)} (expected ${contract.inputTemplateVersion})`);
  }
  if (meta.embeddingModel !== expect.model) out.push(`embedding model ${show(meta.embeddingModel)} (expected ${expect.model})`);
  if (meta.embeddingDims !== expect.dims) out.push(`${show(meta.embeddingDims)} dimensions (expected ${expect.dims})`);
  const key = embeddingKey(expect.model, expect.dims);
  const approved = Object.hasOwn(contract.fingerprints, key) ? contract.fingerprints[key] : undefined;
  if (approved === undefined) out.push(`no approved fingerprint for ${key}`);
  else if (meta.fingerprint !== approved) out.push(`fingerprint ${meta.fingerprint ? meta.fingerprint.slice(0, 12) : 'none'} (expected ${approved.slice(0, 12)})`);
  return out;
}

export class PassagesIndexIncompatibleError extends Error {
  constructor(
    readonly index: string,
    readonly problems: readonly string[],
  ) {
    super(`${index} breaks the passages contract: ${problems.join('; ')}`);
    this.name = 'PassagesIndexIncompatibleError';
  }
}

/**
 * Read `index`'s `_meta` (bounded by `opts`) and check it against the contract.
 * Throws `IndexMetaError` (missing index, alias) or `PassagesIndexIncompatibleError`.
 */
export async function checkPassagesIndex(
  es: Client,
  index: string,
  expect: PassagesExpectation,
  opts: IndexMetaOptions & { contract?: PassagesContract } = {},
): Promise<IndexMeta> {
  const meta = await readIndexMeta(es, index, opts);
  const problems = passagesIndexProblems(meta, expect, opts.contract);
  if (problems.length > 0) throw new PassagesIndexIncompatibleError(index, problems);
  return meta;
}
