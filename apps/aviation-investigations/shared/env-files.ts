import { readFileSync } from 'node:fs';

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseValue(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end > 0) return v.slice(1, end);
    return v;
  }
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

/**
 * Parse a dotenv file without expansion or command substitution and return
 * only nonempty values for the allowlisted names. Never logs values.
 */
export function readDotenvAllowlisted(
  path: string,
  names: readonly string[],
): Record<string, string> {
  const allowed = new Set(names);
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1]!;
    if (!KEY.test(key) || !allowed.has(key)) continue;
    const value = parseValue(m[2]!);
    if (value !== '') out[key] = value;
  }
  return out;
}
