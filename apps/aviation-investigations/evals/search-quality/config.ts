import { resolve } from 'node:path';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { readDotenvAllowlisted } from '../../shared/env-files.js';

const NAMES = ['APP_ENV', 'DATABASE_URL', 'DATABASE_INGEST_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_SCOPE_MODEL',
  'AI_MONTHLY_BUDGET_USD', 'AI_INTERACTIVE_MONTHLY_BUDGET_USD', 'AI_INTERACTIVE_DAILY_BUDGET_USD',
  'AI_INGESTION_MONTHLY_BUDGET_USD', 'ELASTICSEARCH_URL', 'ELASTICSEARCH_READ_API_KEY', 'ELASTICSEARCH_CA_FILE',
  'ELASTICSEARCH_INDEX_PREFIX', 'OPENAI_API_KEY', 'OPENAI_EMBEDDING_MODEL', 'OPENAI_EMBEDDING_DIMENSIONS'] as const;
export interface EvaluationSettings { env: NodeJS.ProcessEnv; config: AppConfig }
export function evaluationSettings(files: string, keysFile?: string, embeddings = false): EvaluationSettings {
  const allowed = NAMES.filter(n => embeddings || !n.startsWith('OPENAI_') && !n.startsWith('ELASTICSEARCH_'));
  const env: NodeJS.ProcessEnv = Object.fromEntries(allowed.filter(n => process.env[n]?.trim()).map(n => [n, process.env[n]]));
  for (const file of files.split(',').filter(Boolean)) {
    for (const [name, value] of Object.entries(readDotenvAllowlisted(resolve(file), allowed))) if (!env[name]) env[name] = value;
  }
  const providerNames = embeddings ? ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] : ['ANTHROPIC_API_KEY'];
  const needed = providerNames.filter(n => !env[n]);
  if (keysFile && needed.length) {
    for (const [name, value] of Object.entries(readDotenvAllowlisted(resolve(keysFile), needed))) if (!env[name]) env[name] = value;
  }
  const config = loadConfig({ env });
  if (config.appEnv !== 'dev') throw new Error('Task 24 requires APP_ENV=dev');
  for (const url of [config.databaseUrl, config.databaseIngestUrl].filter(Boolean)) {
    if (new URL(url!).pathname !== '/aviation_dev') throw new Error('Task 24 requires development database connections');
  }
  return { env, config };
}
