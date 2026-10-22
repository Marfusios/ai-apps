/**
 * The passages index compatibility contract (DATA_PIPELINE "Passages validation";
 * review gate G5 #5). One check used by `worker publish`, the API's dataset loader
 * (`server/dataset.ts`) and retrieval (`server/search/hybrid.ts`): a passages index
 * is served only when its `_meta` names
 * - the generation being served;
 * - an approved index version (`PASSAGES_CONTRACTS`: `passages-v2`, `passages-v1`);
 * - that version's chunker (`chunk-v2`) and embedding-input template (`input-v1`);
 * - the configured embedding model and dimensions;
 * - that version's approved mapping fingerprint for that model and dimension count.
 * A missing, unknown or different value is refused; nothing is inferred.
 *
 * The version also decides how retrieval filters the index:
 * `eventAircraftQualification` lets an event-scoped passage satisfy aircraft filters
 * when every aircraft of its event does (gate G5 extension, `filters.ts`). Only
 * `passages-v2` stores each event's complete aircraft set as nested `event_aircraft`
 * and can prove that; `passages-v1` keeps the exclusion.
 *
 * The approved fingerprints are recorded here, not computed, so the API does not
 * load the worker's mapping and analysis code. A unit test recomputes each one with
 * `passagesIndexFingerprint` (worker/index/passages-index.ts): changing the mapping,
 * analysis, chunking, template, tokenizer or model fails that test until a new
 * version is approved here.
 *
 * `worker publish` also compares the index's document count with the generation's
 * `passages` rows for the version's chunker.
 */
import { errors, type Client } from '@elastic/elasticsearch';
import { IndexMetaError, readIndexMeta, type IndexMeta, type IndexMetaOptions } from './index-meta.js';

export interface PassagesContract {
  indexVersion: string;
  chunkerVersion: string;
  inputTemplateVersion: string;
  /** Approved mapping fingerprint per embedding, keyed `<model>/<dims>`. */
  fingerprints: Readonly<Record<string, string>>;
  /**
   * Whether an event-scoped passage may satisfy aircraft filters when every aircraft
   * of its event does (`filters.ts`). True only for a version whose documents carry
   * the event's complete aircraft set as nested `event_aircraft`.
   */
  eventAircraftQualification: boolean;
}

/** The current version: event aircraft nested and complete, so the event-level qualification is on. */
export const PASSAGES_V2_CONTRACT: PassagesContract = Object.freeze({
  indexVersion: 'passages-v2',
  chunkerVersion: 'chunk-v2',
  inputTemplateVersion: 'input-v1',
  fingerprints: Object.freeze({
    'text-embedding-3-small/1536': 'ed335f462734e6b8e4888ed51f6ba2f9926747b100e97d9735eeb0c1f6043dd2',
  }),
  eventAircraftQualification: true,
});

/** The first version (event aircraft a flattened object): servable, with event-scoped passages excluded under aircraft filters. */
export const PASSAGES_V1_CONTRACT: PassagesContract = Object.freeze({
  indexVersion: 'passages-v1',
  chunkerVersion: 'chunk-v2',
  inputTemplateVersion: 'input-v1',
  fingerprints: Object.freeze({
    // The shared dev index (generation 1, built at d2b9db8) records this fingerprint.
    'text-embedding-3-small/1536': '57d731b28445deb4369951a92c767414376b6d78cc312c1cdea4a8b822375b5b',
  }),
  eventAircraftQualification: false,
});

/** Every servable passages version, newest first; the worker builds the first. */
export const PASSAGES_CONTRACTS: readonly PassagesContract[] = Object.freeze([PASSAGES_V2_CONTRACT, PASSAGES_V1_CONTRACT]);

/** The contract the worker builds to (`PASSAGES_INDEX_VERSION`). */
export const PASSAGES_CONTRACT: PassagesContract = PASSAGES_V2_CONTRACT;

export const embeddingKey = (model: string, dims: number): string => `${model}/${dims}`;

/** What the served dataset expects of its passages index. */
export interface PassagesExpectation {
  generationId: number;
  /** The configured embedding model and dimensions (the query embedder's). */
  model: string;
  dims: number;
}

/** The contract fields an index can fail on (fixed names, safe for logs). */
export type ContractField = 'generation' | 'index_version' | 'chunker' | 'input_template' | 'embedding_model' | 'embedding_dims' | 'fingerprint';

/** The contracts a check accepts: one version, or several (newest first). */
export type PassagesContracts = PassagesContract | readonly PassagesContract[];

const contractList = (c: PassagesContracts): readonly PassagesContract[] => ('indexVersion' in c ? [c] : c);

export interface PassagesContractMatch {
  /** The contract of the index's version; the first (newest) accepted one when the version is not accepted. */
  contract: PassagesContract;
  /** Every way the index breaks that contract, by field; empty when it can be served. */
  mismatches: { field: ContractField; problem: string }[];
}

/**
 * The contract of `meta`'s index version, and every way `meta` breaks it. An index
 * version none of `contracts` names is a mismatch; the rest is then checked against
 * the newest contract, so the report lists every difference.
 */
export function matchPassagesContract(
  meta: IndexMeta,
  expect: PassagesExpectation,
  contracts: PassagesContracts = PASSAGES_CONTRACTS,
): PassagesContractMatch {
  const list = contractList(contracts);
  const newest = list[0];
  if (!newest) throw new Error('no passages contract to check against');
  const own = list.find((c) => c.indexVersion === meta.indexVersion);
  const contract = own ?? newest;
  const out: { field: ContractField; problem: string }[] = [];
  const show = (v: string | number | null) => (v === null ? 'none' : String(v));
  const add = (field: ContractField, problem: string) => out.push({ field, problem });
  if (meta.generationId !== expect.generationId) add('generation', `generation ${show(meta.generationId)} (expected ${expect.generationId})`);
  if (!own) add('index_version', `index version ${show(meta.indexVersion)} (expected ${list.map((c) => c.indexVersion).join(' or ')})`);
  if (meta.chunkerVersion !== contract.chunkerVersion) add('chunker', `chunker ${show(meta.chunkerVersion)} (expected ${contract.chunkerVersion})`);
  if (meta.inputTemplateVersion !== contract.inputTemplateVersion) {
    add('input_template', `input template ${show(meta.inputTemplateVersion)} (expected ${contract.inputTemplateVersion})`);
  }
  if (meta.embeddingModel !== expect.model) add('embedding_model', `embedding model ${show(meta.embeddingModel)} (expected ${expect.model})`);
  if (meta.embeddingDims !== expect.dims) add('embedding_dims', `${show(meta.embeddingDims)} dimensions (expected ${expect.dims})`);
  const key = embeddingKey(expect.model, expect.dims);
  const approved = Object.hasOwn(contract.fingerprints, key) ? contract.fingerprints[key] : undefined;
  if (approved === undefined) add('fingerprint', `no approved fingerprint for ${key}`);
  else if (meta.fingerprint !== approved) add('fingerprint', `fingerprint ${meta.fingerprint ? meta.fingerprint.slice(0, 12) : 'none'} (expected ${approved.slice(0, 12)})`);
  return { contract, mismatches: out };
}

/** Every way `meta` breaks the contract of its version, by field; empty when the index can be served. */
export function passagesIndexMismatches(
  meta: IndexMeta,
  expect: PassagesExpectation,
  contracts: PassagesContracts = PASSAGES_CONTRACTS,
): { field: ContractField; problem: string }[] {
  return matchPassagesContract(meta, expect, contracts).mismatches;
}

/** Every way `meta` breaks the contract, as sentences (operator messages); empty when the index can be served. */
export function passagesIndexProblems(meta: IndexMeta, expect: PassagesExpectation, contracts: PassagesContracts = PASSAGES_CONTRACTS): string[] {
  return passagesIndexMismatches(meta, expect, contracts).map((m) => m.problem);
}

export class PassagesIndexIncompatibleError extends Error {
  /** The fields that differ (fixed names, safe for logs). */
  readonly fields: readonly ContractField[];
  /** Operator sentences; they quote the index `_meta`. */
  readonly problems: readonly string[];
  constructor(
    readonly index: string,
    mismatches: readonly { field: ContractField; problem: string }[],
  ) {
    super(`${index} breaks the passages contract: ${mismatches.map((m) => m.problem).join('; ')}`);
    this.name = 'PassagesIndexIncompatibleError';
    this.fields = [...new Set(mismatches.map((m) => m.field))];
    this.problems = mismatches.map((m) => m.problem);
  }
}

/** The check outran its own deadline (the caller's timer, not the client's). */
export class PassagesCheckTimeoutError extends Error {
  constructor(ms: number) {
    super(`the passages index check timed out after ${ms} ms`);
    this.name = 'PassagesCheckTimeoutError';
  }
}

/**
 * A fixed category for a failed passages check, safe to store and log: no upstream
 * message, body or cause is ever part of it (an Elasticsearch error message quotes
 * the server's `root_cause.reason`).
 * - `incompatible:<fields>` (the contract fields that differ), `index_missing`,
 *   `index_not_concrete`: definitive;
 * - `timeout`, `aborted`, `transport`, `http_<status>` (a validated 3-digit status) or
 *   `http_unknown`, `unexpected`: transient.
 */
export function passagesCheckFailure(err: unknown): string {
  if (err instanceof PassagesIndexIncompatibleError) return `incompatible:${err.fields.join(',')}`;
  if (err instanceof IndexMetaError) return `index_${err.kind}`;
  if (err instanceof PassagesCheckTimeoutError || err instanceof errors.TimeoutError) return 'timeout';
  if (err instanceof errors.RequestAbortedError || (err instanceof Error && err.name === 'AbortError')) return 'aborted';
  if (err instanceof errors.ResponseError) {
    const status = err.statusCode;
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? `http_${status}` : 'http_unknown';
  }
  if (err instanceof errors.ConnectionError || err instanceof errors.NoLivingConnectionsError) return 'transport';
  return 'unexpected';
}

/** True for the definitive failures: the index breaks the contract or cannot be the index. */
export function isDefinitivePassagesFailure(err: unknown): boolean {
  return err instanceof PassagesIndexIncompatibleError || err instanceof IndexMetaError;
}

/** A passages index that meets the contract of its version. */
export interface ServablePassagesIndex {
  meta: IndexMeta;
  contract: PassagesContract;
}

/**
 * Read `index`'s `_meta` (bounded by `opts`) and check it against the contract of its
 * version. Throws `IndexMetaError` (missing index, alias) or
 * `PassagesIndexIncompatibleError`.
 */
export async function checkPassagesIndex(
  es: Client,
  index: string,
  expect: PassagesExpectation,
  opts: IndexMetaOptions & { contracts?: PassagesContracts } = {},
): Promise<ServablePassagesIndex> {
  const meta = await readIndexMeta(es, index, opts);
  const { contract, mismatches } = matchPassagesContract(meta, expect, opts.contracts);
  if (mismatches.length > 0) throw new PassagesIndexIncompatibleError(index, mismatches);
  return { meta, contract };
}
