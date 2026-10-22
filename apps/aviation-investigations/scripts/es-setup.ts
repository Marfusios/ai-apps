import { ensureSecrets, localPort, readLocal, writeLocal } from './local-env.js';
import { defaultIndexPrefix, provisionElasticsearch } from './provision.js';

/**
 * Local environments on the stand-alone Elasticsearch: `dev` (indices
 * ai-aviation-dev-*, ELASTICSEARCH_*_API_KEY) and `test` (aviation-test-* for the
 * integration tests, TEST_ELASTICSEARCH_*_API_KEY). Keys that still work are kept.
 */
const LOCAL_ES_ENVS = [
  { env: 'dev', prefix: defaultIndexPrefix('dev'), vars: '' },
  { env: 'test', prefix: 'aviation-test', vars: 'TEST_' },
] as const;

/** Creates roles and mints scoped API keys into .env.local (idempotent). */
export async function setupElasticsearch(): Promise<void> {
  const { ELASTIC_PASSWORD } = ensureSecrets(['ELASTIC_PASSWORD']);
  const port = localPort('ELASTICSEARCH_PORT', 59200);
  const node = `http://localhost:${port}`;
  const out: Record<string, string> = {
    ELASTICSEARCH_URL: node,
    ELASTICSEARCH_PORT: String(port),
    ELASTICSEARCH_INDEX_PREFIX: defaultIndexPrefix('dev'),
  };
  for (const { env, prefix, vars } of LOCAL_ES_ENVS) {
    const readVar = `${vars}ELASTICSEARCH_READ_API_KEY`;
    const writeVar = `${vars}ELASTICSEARCH_WRITE_API_KEY`;
    const existing = readLocal([readVar, writeVar]);
    // Re-minting on every run would invalidate keys held by other processes.
    const keys = await provisionElasticsearch({
      env,
      indexPrefix: prefix,
      admin: { url: node, password: ELASTIC_PASSWORD! },
      keys: { read: existing[readVar], write: existing[writeVar] },
      log: () => undefined,
    });
    out[readVar] = keys.read;
    out[writeVar] = keys.write;
  }
  writeLocal(out);
}
