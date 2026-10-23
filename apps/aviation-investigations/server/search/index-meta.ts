/**
 * The `_meta` an index build records in its mapping (index version, fingerprint,
 * generation, build id). Publication checks it before a manifest names an index, and
 * the API checks it again before serving from the manifest's index, so a manifest can
 * never pair a generation with another generation's index or an incompatible mapping.
 */
import type { Client } from '@elastic/elasticsearch';

export interface IndexMeta {
  /** The concrete index name (never an alias). */
  index: string;
  indexVersion: string | null;
  fingerprint: string | null;
  generationId: number | null;
  buildId: string | null;
  /** Passages indices: the embedding model and dimensions the vectors were built with. */
  embeddingModel: string | null;
  embeddingDims: number | null;
  /** Passages indices: the chunker and embedding-input template versions. */
  chunkerVersion: string | null;
  inputTemplateVersion: string | null;
}

export interface IndexMetaOptions {
  /** Request timeout in milliseconds (default: the client's). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class IndexMetaError extends Error {
  constructor(
    message: string,
    /** `missing`: no such index; `not_concrete`: the name is an alias or pattern. */
    readonly kind: 'missing' | 'not_concrete' = 'missing',
  ) {
    super(message);
    this.name = 'IndexMetaError';
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The transport's retry backoff (@elastic/transport's own: exponential with jitter, in
 * seconds), skipped once the request's signal has aborted. An abort can surface as a
 * connection error, which the transport retries after its backoff before it notices the
 * abort; without this an aborted request could be held for 1 to 2 s (task 10e load test).
 */
export function abortAwareBackoff(signal: AbortSignal): (min: number, max: number, attempt: number) => number {
  return (min, max, attempt) => {
    if (signal.aborted) return 0;
    const ceiling = Math.min(max, 2 ** attempt) / 2;
    return ceiling + (Math.random() * (ceiling - min) + min);
  };
}

/**
 * Read an index's `_meta`. Throws `IndexMetaError` when the index does not exist or
 * the name is an alias (an alias resolves to differently named indices).
 */
export async function readIndexMeta(es: Client, index: string, opts: IndexMetaOptions = {}): Promise<IndexMeta> {
  let found: Record<string, { mappings?: { _meta?: Record<string, unknown> } }>;
  const transport = {
    ...(opts.timeoutMs !== undefined ? { requestTimeout: opts.timeoutMs } : {}),
    ...(opts.signal ? { signal: opts.signal, retryBackoff: abortAwareBackoff(opts.signal) } : {}),
  };
  try {
    found = (await es.indices.getMapping({ index }, transport)) as typeof found;
  } catch (err) {
    if ((err as { meta?: { statusCode?: number } }).meta?.statusCode === 404) {
      throw new IndexMetaError(`index ${index} does not exist`, 'missing');
    }
    throw err;
  }
  const names = Object.keys(found);
  if (names.length !== 1 || names[0] !== index) {
    throw new IndexMetaError(`${index} is not a concrete index (it resolves to ${names.join(', ') || 'nothing'})`, 'not_concrete');
  }
  const meta = found[index]?.mappings?._meta ?? {};
  const generation = meta.generation_id;
  const dims = meta.embedding_dims;
  return {
    index,
    indexVersion: str(meta.index_version),
    fingerprint: str(meta.fingerprint),
    generationId: typeof generation === 'number' && Number.isSafeInteger(generation) ? generation : null,
    buildId: str(meta.build_id),
    embeddingModel: str(meta.embedding_model),
    embeddingDims: typeof dims === 'number' && Number.isSafeInteger(dims) && dims > 0 ? dims : null,
    chunkerVersion: str(meta.chunker_version),
    inputTemplateVersion: str(meta.input_template_version),
  };
}
