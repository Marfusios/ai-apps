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
}

export class IndexMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IndexMetaError';
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * Read an index's `_meta`. Throws `IndexMetaError` when the index does not exist or
 * the name is an alias (an alias resolves to differently named indices).
 */
export async function readIndexMeta(es: Client, index: string): Promise<IndexMeta> {
  let found: Record<string, { mappings?: { _meta?: Record<string, unknown> } }>;
  try {
    found = (await es.indices.getMapping({ index })) as typeof found;
  } catch (err) {
    if ((err as { meta?: { statusCode?: number } }).meta?.statusCode === 404) {
      throw new IndexMetaError(`index ${index} does not exist`);
    }
    throw err;
  }
  const names = Object.keys(found);
  if (names.length !== 1 || names[0] !== index) {
    throw new IndexMetaError(`${index} is not a concrete index (it resolves to ${names.join(', ') || 'nothing'})`);
  }
  const meta = found[index]?.mappings?._meta ?? {};
  const generation = meta.generation_id;
  return {
    index,
    indexVersion: str(meta.index_version),
    fingerprint: str(meta.fingerprint),
    generationId: typeof generation === 'number' && Number.isSafeInteger(generation) ? generation : null,
    buildId: str(meta.build_id),
  };
}
