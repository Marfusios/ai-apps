import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Set or replace variables in .env.local (mode 0600) without printing values. */
export function writeLocal(values: Record<string, string>): void {
  const lines = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, 'utf8').split('\n') : [];
  if (lines.at(-1) === '') lines.pop();
  for (const [key, value] of Object.entries(values)) {
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  writeFileSync(ENV_LOCAL, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(ENV_LOCAL, 0o600);
}

/** Return existing values; generate and persist random ones for missing names. */
export function ensureSecrets(names: readonly string[]): Record<string, string> {
  const have = readLocal(names);
  const added: Record<string, string> = {};
  for (const n of names) if (!have[n]) added[n] = randomBytes(24).toString('hex');
  if (Object.keys(added).length) writeLocal(added);
  return { ...have, ...added };
}
