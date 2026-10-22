/**
 * Elasticsearch client factory. The HTTP process reads with
 * `ELASTICSEARCH_READ_API_KEY` only: it never falls back to another key, so a missing
 * read key fails instead of handing the API write privileges. Workers write with
 * `ELASTICSEARCH_WRITE_API_KEY`, or `ELASTICSEARCH_API_KEY` when that is the only key
 * an operator configured. A CA file, when configured, is the only trusted TLS root.
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

function apiKeyFor(config: AppConfig['elasticsearch'], access: EsAccess): string {
  if (access === 'read') {
    if (!config.readApiKey) throw new Error('ELASTICSEARCH_READ_API_KEY is not set; run pnpm services:setup');
    return config.readApiKey;
  }
  const key = config.writeApiKey ?? config.apiKey;
  if (!key) throw new Error('ELASTICSEARCH_WRITE_API_KEY is not set; run pnpm services:setup');
  return key;
}

export function createEsClient(
  config: AppConfig['elasticsearch'],
  access: EsAccess,
  opts: EsClientOptions = {},
): Client {
  return new Client({
    node: config.url,
    auth: { apiKey: apiKeyFor(config, access) },
    requestTimeout: opts.requestTimeoutMs ?? 30_000,
    maxRetries: opts.maxRetries ?? 2,
    ...(config.caFile ? { tls: { ca: readFileSync(config.caFile) } } : {}),
  });
}
