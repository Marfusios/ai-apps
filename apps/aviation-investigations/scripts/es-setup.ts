import { Client } from '@elastic/elasticsearch';
import { ensureSecrets, readLocal, writeLocal } from './local-env.js';

const ROLES = {
  aviation_reader: {
    indices: [{ names: ['aviation-*'], privileges: ['read', 'view_index_metadata'] }],
  },
  aviation_writer: {
    cluster: ['monitor'],
    indices: [{ names: ['aviation-*'], privileges: ['create_index', 'write', 'manage', 'read'] }],
  },
};

async function keyWorks(node: string, key: string | undefined): Promise<boolean> {
  if (!key) return false;
  try {
    await new Client({ node, auth: { apiKey: key } }).security.authenticate();
    return true;
  } catch {
    return false;
  }
}

/** Creates roles and mints scoped API keys into .env.local (idempotent). */
export async function setupElasticsearch(): Promise<void> {
  const { ELASTIC_PASSWORD } = ensureSecrets(['ELASTIC_PASSWORD']);
  const port = Number(process.env.ELASTICSEARCH_PORT || 59200);
  const node = `http://localhost:${port}`;
  const admin = new Client({ node, auth: { username: 'elastic', password: ELASTIC_PASSWORD! } });
  for (const [name, body] of Object.entries(ROLES)) await admin.security.putRole({ name, ...body });

  const existing = readLocal(['ELASTICSEARCH_READ_API_KEY', 'ELASTICSEARCH_WRITE_API_KEY']);
  const out: Record<string, string> = { ELASTICSEARCH_URL: node, ELASTICSEARCH_PORT: String(port) };
  const specs = [
    ['ELASTICSEARCH_READ_API_KEY', 'aviation-read', 'aviation_reader'],
    ['ELASTICSEARCH_WRITE_API_KEY', 'aviation-write', 'aviation_writer'],
  ] as const;
  for (const [envName, keyName, role] of specs) {
    // Re-minting on every run would invalidate keys held by other processes.
    if (await keyWorks(node, existing[envName])) continue;
    await admin.security.invalidateApiKey({ name: keyName }).catch(() => undefined);
    const k = await admin.security.createApiKey({
      name: keyName,
      role_descriptors: { [role]: ROLES[role] },
    });
    out[envName] = k.encoded;
  }
  writeLocal(out);
}
