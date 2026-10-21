/**
 * Elasticsearch client factory. The HTTP process uses the read key and workers the
 * write key; `ELASTICSEARCH_API_KEY` is the fallback for either when the scoped key
 * is not set. A CA file, when configured, is the only trusted TLS root.
 */
import { readFileSync } from 'node:fs';
import { Client } from '@elastic/elasticsearch';
import type { AppConfig } from '../../shared/config.js';

export type EsAccess = 'read' | 'write';

export interface EsClientOptions {
  /** Per-request timeout in milliseconds (default 30 s). */
  requestTimeoutMs?: number;
  /** Retries on connection errors and 502/503/504 (default 2). */
  maxRetries?: number;
}

const KEY_NAME: Readonly<Record<EsAccess, string>> = {
  read: 'ELASTICSEARCH_READ_API_KEY',
  write: 'ELASTICSEARCH_WRITE_API_KEY',
};

export function createEsClient(
  config: AppConfig['elasticsearch'],
  access: EsAccess,
  opts: EsClientOptions = {},
): Client {
  const apiKey = (access === 'read' ? config.readApiKey : config.writeApiKey) ?? config.apiKey;
  if (!apiKey) throw new Error(`${KEY_NAME[access]} is not set; run pnpm services:setup`);
  return new Client({
    node: config.url,
    auth: { apiKey },
    requestTimeout: opts.requestTimeoutMs ?? 30_000,
    maxRetries: opts.maxRetries ?? 2,
    ...(config.caFile ? { tls: { ca: readFileSync(config.caFile) } } : {}),
  });
}
