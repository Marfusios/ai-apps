/**
 * Configuration of the retrieval evaluation commands, like the worker CLI's:
 * `--env-files a,b` (highest priority first, absolute or app-relative) when given,
 * otherwise `AVIATION_ENV_FILES`, otherwise the app's ignored `.env.local`. Nonempty
 * process values always win; values are never printed.
 */
import { resolve } from 'node:path';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { APP_DIR, workerConfig } from '../../worker/config.js';

export function evalConfig(envFiles: string | undefined): AppConfig {
  if (envFiles === undefined) return workerConfig();
  const files = envFiles
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => resolve(APP_DIR, f));
  if (files.length === 0) throw new Error('--env-files names no file');
  return loadConfig({ files });
}
