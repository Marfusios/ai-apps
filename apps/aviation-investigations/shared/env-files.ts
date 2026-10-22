import { readFileSync } from 'node:fs';

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `null` for an unterminated quote; the caller names the variable (the value is never echoed). */
function parseValue(raw: string): string | null {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(1, end) : null;
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
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`Environment file not found: ${path} (named in AVIATION_ENV_FILES or the command's file list)`);
    throw new Error(`Environment file ${path} cannot be read (${code ?? 'unknown error'})`);
  }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(?:export\s+)?([^=\s]+)\s*=(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1]!;
    if (!KEY.test(key) || !allowed.has(key)) continue;
    const value = parseValue(m[2]!);
    if (value === null) throw new Error(`Environment file ${path}: the value of ${key} has an unterminated quote`);
    if (value !== '') out[key] = value;
  }
  return out;
}
