/**
 * The embedding cache (`embedding_cache`, amendment A10). The key is the sha256 of the
 * exact embedding input (header and passage text), the model, the dimensions and
 * `EMBEDDING_INPUT_TEMPLATE_VERSION`, so a changed header, model or dimension count
 * never reuses a vector. Vectors are stored as float32 little-endian bytes.
 */
import { createHash } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../server/db/client.js';
import { embeddingCache } from '../../server/db/schema/index.js';

export interface CacheKeyParts {
  input: string;
  model: string;
  dims: number;
  templateVersion: string;
}

export function embeddingCacheKey(p: CacheKeyParts): string {
  return createHash('sha256').update(JSON.stringify([p.templateVersion, p.model, p.dims, p.input])).digest('hex');
}

export function vectorToBytes(v: Float32Array): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i += 1) buf.writeFloatLE(v[i] as number, i * 4);
  return buf;
}

export function bytesToVector(b: Buffer, dims: number): Float32Array {
  if (b.byteLength !== dims * 4) throw new Error(`cached vector has ${b.byteLength} bytes, expected ${dims * 4}`);
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) out[i] = b.readFloatLE(i * 4);
  return out;
}

const LOOKUP_CHUNK = 1000;

/** Cached vectors for the given keys (model and dims checked). */
export async function lookupEmbeddings(
  db: DbOrTx,
  keys: readonly string[],
  model: string,
  dims: number,
): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
    const chunk = keys.slice(i, i + LOOKUP_CHUNK);
    const rows = await db
      .select({ key: embeddingCache.cacheKey, model: embeddingCache.model, dims: embeddingCache.dims, vector: embeddingCache.vector })
      .from(embeddingCache)
      .where(inArray(embeddingCache.cacheKey, chunk));
    for (const r of rows) {
      // The key covers model and dims; a mismatch means a corrupt row, not a cache hit.
      if (r.model !== model || r.dims !== dims) throw new Error(`embedding_cache row ${r.key} is ${r.model}/${r.dims}, expected ${model}/${dims}`);
      out.set(r.key, bytesToVector(r.vector, dims));
    }
  }
  return out;
}

/** Keys already cached (no vectors read). Reports a missing table instead of failing (dry runs on an unmigrated database). */
export async function countCachedKeys(db: DbOrTx, keys: readonly string[]): Promise<{ available: boolean; cached: Set<string> }> {
  const cached = new Set<string>();
  try {
    for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
      const rows = await db
        .select({ key: embeddingCache.cacheKey })
        .from(embeddingCache)
        .where(inArray(embeddingCache.cacheKey, keys.slice(i, i + LOOKUP_CHUNK)));
      for (const r of rows) cached.add(r.key);
    }
  } catch (err) {
    const code = (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
    if (code === '42P01') return { available: false, cached };
    throw err;
  }
  return { available: true, cached };
}

/** Insert vectors; an existing key is kept (same key, same input). */
export async function storeEmbeddings(
  db: DbOrTx,
  rows: readonly { key: string; vector: Float32Array }[],
  model: string,
  dims: number,
  templateVersion: string,
): Promise<void> {
  if (rows.length === 0) return;
  for (const r of rows) if (r.vector.length !== dims) throw new Error(`vector for ${r.key} has ${r.vector.length} dimensions, expected ${dims}`);
  await db
    .insert(embeddingCache)
    .values(rows.map((r) => ({ cacheKey: r.key, model, dims, templateVersion, vector: vectorToBytes(r.vector) })))
    .onConflictDoNothing({ target: embeddingCache.cacheKey });
}
