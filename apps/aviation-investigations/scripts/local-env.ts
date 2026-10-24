import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDotenvAllowlisted } from '../shared/env-files.js';

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_LOCAL = resolve(APP_DIR, '.env.local');

/** Read nonempty values for the given names from the ignored .env.local. */
export function readLocal(names: readonly string[]): Record<string, string> {
  return existsSync(ENV_LOCAL) ? readDotenvAllowlisted(ENV_LOCAL, names) : {};
}

/**
 * Set or replace variables in a dotenv file without printing values. The new content goes
 * to a temporary file (mode 0600) next to it, which then replaces the file in one rename:
 * an interrupted write leaves the previous file whole. `afterWrite` is a test seam.
 */
export function writeEnvFile(file: string, values: Record<string, string>, opts: { afterWrite?: (temp: string) => void } = {}): void {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  if (lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  const temp = `${file}.tmp-${process.pid}`;
  rmSync(temp, { force: true }); // a leftover of an earlier process with this pid
  try {
    writeFileSync(temp, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    opts.afterWrite?.(temp);
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/** Set or replace variables in .env.local (mode 0600) without printing values. */
export function writeLocal(values: Record<string, string>): void {
  writeEnvFile(ENV_LOCAL, values);
}

/** Return existing values; generate and persist random ones for missing names. */
export function ensureSecrets(names: readonly string[]): Record<string, string> {
  // Nonempty process values win over the file, matching the project rule.
  const have = readLocal(names);
  for (const n of names) if (process.env[n]) have[n] = process.env[n]!;
  const added: Record<string, string> = {};
  for (const n of names) if (!have[n]) added[n] = randomBytes(24).toString('hex');
  if (Object.keys(added).length) writeLocal(added);
  return { ...have, ...added };
}

/** A local service port: process value, then .env.local, then the default. */
export function localPort(name: 'POSTGRES_PORT' | 'ELASTICSEARCH_PORT', fallback: number): number {
  return Number(process.env[name] || readLocal([name])[name] || fallback);
}
