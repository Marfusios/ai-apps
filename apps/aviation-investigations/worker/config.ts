import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredNames, loadConfig, type AppConfig, type LoadConfigOptions } from '../shared/config.js';

export const APP_DIR = resolve(fileURLToPath(import.meta.url), '../..');

function workerSources(env: NodeJS.ProcessEnv): LoadConfigOptions {
  if ((env.AVIATION_ENV_FILES ?? '').trim() !== '') return { env };
  const local = resolve(APP_DIR, '.env.local');
  return { env, files: existsSync(local) ? [local] : [] };
}

/**
 * Configuration for local worker commands: AVIATION_ENV_FILES when set, otherwise
 * the app's ignored `.env.local` when present. Nonempty process values always win.
 */
export function workerConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return loadConfig(workerSources(env));
}

/** Which of `names` those sources set, rather than leaving them to the defaults. */
export function workerConfiguredNames(names: readonly string[], env: NodeJS.ProcessEnv = process.env): Set<string> {
  return configuredNames(names, workerSources(env));
}
