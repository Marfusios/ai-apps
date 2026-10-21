import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from '../shared/config.js';

export const APP_DIR = resolve(fileURLToPath(import.meta.url), '../..');

/**
 * Configuration for local worker commands: AVIATION_ENV_FILES when set, otherwise
 * the app's ignored `.env.local` when present. Nonempty process values always win.
 */
export function workerConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if ((env.AVIATION_ENV_FILES ?? '').trim() !== '') return loadConfig({ env });
  const local = resolve(APP_DIR, '.env.local');
  return loadConfig({ env, files: existsSync(local) ? [local] : [] });
}
