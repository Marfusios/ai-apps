/**
 * Index aliases. A search alias always points at exactly one built and verified
 * index; moving it is one `_aliases` request, so a reader sees either the old or the
 * new index and never neither. Previous indices are kept (a rollback is another
 * switch); removing them is a separate, explicit step.
 */
import type { Client } from '@elastic/elasticsearch';

const status = (e: unknown) => (e as { meta?: { statusCode?: number } }).meta?.statusCode;

/** Concrete indices the alias points at (empty when it does not exist). */
export async function aliasTargets(es: Client, alias: string): Promise<string[]> {
  try {
    const found = await es.indices.getAlias({ name: alias });
    return Object.keys(found).sort();
  } catch (e) {
    if (status(e) === 404) return [];
    throw e;
  }
}

export interface AliasSwitch {
  alias: string;
  index: string;
  /** Indices the alias pointed at before (kept, not deleted). */
  previous: string[];
}

/**
 * Point `alias` at `index` only, in one atomic request. Each current target is
 * removed with `must_exist`, so a concurrent change makes the whole request fail
 * and leaves the alias as it was. Fails when a concrete index has the alias name.
 */
export async function switchAlias(es: Client, alias: string, index: string): Promise<AliasSwitch> {
  if (alias === index) throw new Error('alias and index names must differ');
  const exists = await es.indices.exists({ index: alias });
  const previous = await aliasTargets(es, alias);
  if (exists && previous.length === 0) throw new Error(`${alias} is a concrete index, not an alias`);
  const removals = previous.filter((p) => p !== index);
  await es.indices.updateAliases({
    actions: [
      ...removals.map((p) => ({ remove: { index: p, alias, must_exist: true } })),
      { add: { index, alias } },
    ],
  });
  const now = await aliasTargets(es, alias);
  if (now.length !== 1 || now[0] !== index) {
    throw new Error(`alias ${alias} points at ${now.join(', ') || 'nothing'} after switching to ${index}`);
  }
  return { alias, index, previous };
}
