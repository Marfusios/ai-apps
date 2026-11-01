import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { ImporterConfigSchema } from '../worker/importer/config.js';

export class ReleaseError extends Error {
  constructor(readonly exitCode: 1 | 2 | 75, message: string) { super(message); }
}
export const PRIVATE_FILE_LIMIT = 64 * 1024;
const absolutePath = z.string().min(1).max(4096)
  .refine((v) => isAbsolute(v) && !/[\x00-\x1f\x7f,]/.test(v) && v.trim() === v);
const files = z.array(absolutePath).min(1).max(8);
export const ReleaseConfigSchema = z.strictObject({
  version: z.literal('aircase-release.v1'),
  checkout: absolutePath,
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,127}$/),
  importerConfig: absolutePath,
  publicUrl: z.url().refine((v) => {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/';
  }),
  logDir: absolutePath,
  live: z.strictObject({ versionFile: absolutePath, composeEnvFiles: files, preflightEnvFiles: files, migratorEnvFile: absolutePath }),
  dev: z.strictObject({ versionFile: absolutePath, migrateEnvFiles: files, canaryEnvFiles: files, migratorEnvFile: absolutePath }),
}).refine((c) => c.live.versionFile !== c.dev.versionFile &&
  c.live.composeEnvFiles.includes(c.live.versionFile) && c.dev.canaryEnvFiles.includes(c.dev.versionFile));
export type ReleaseConfig = z.infer<typeof ReleaseConfigSchema>;

export function parseReleaseConfig(bytes: Buffer): ReleaseConfig {
  try { return ReleaseConfigSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new ReleaseError(2, 'invalid release config'); }
}

/** Open first, then inspect that same descriptor; never follow a final symlink or read without a bound. */
export async function readPrivateFile(path: string, exactMode = true): Promise<Buffer> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 ||
        (exactMode ? (stat.mode & 0o7777) !== 0o600 : (stat.mode & 0o077) !== 0) || stat.size > PRIVATE_FILE_LIMIT) throw new Error();
      const bytes = Buffer.alloc(PRIVATE_FILE_LIMIT + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > PRIVATE_FILE_LIMIT) throw new Error();
      return bytes.subarray(0, length);
    } finally { await file.close(); }
  } catch { throw new ReleaseError(2, 'private file must be regular, owned by this user, not a symlink, and mode 0600 (config: owner-only)'); }
}

export function outsideCheckout(path: string, checkout: string): boolean {
  const r = relative(checkout, path);
  return r === '..' || r.startsWith('../') || isAbsolute(r);
}

/** Preserve every byte outside the single assignment, including CRLF and a missing final newline. */
export function versionEdit(bytes: Buffer, tag: string): { current: string; bytes: Buffer } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const matches = [...text.matchAll(/^APP_VERSION=([^\r\n]*)(?=\r?$)/gm)];
    // Reject alternative duplicate spellings that dotenv/Compose would also consume.
    if (matches.length !== 1 || [...text.matchAll(/^\s*(?:export\s+)?APP_VERSION\s*=/gm)].length !== 1) throw new Error();
    const current = parseEnv(matches[0]![0]).APP_VERSION;
    if (!current || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(current)) throw new Error();
    if (current === tag) return { current, bytes };
    const m = matches[0]!;
    return { current, bytes: Buffer.from(text.slice(0, m.index) + `APP_VERSION=${tag}` + text.slice(m.index! + m[0].length)) };
  } catch { throw new ReleaseError(2, 'version file must have exactly one valid APP_VERSION= line'); }
}

export function repin(bytes: Buffer, code: string, image: string): Buffer {
  try {
    const original = ImporterConfigSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (!original.live) throw new Error();
    const updated = ImporterConfigSchema.parse({ ...original, code,
      dev: { ...original.dev, image }, live: { ...original.live, image } });
    if (original.code === code && original.dev.image === image && original.live.image === image) return bytes;
    return Buffer.from(JSON.stringify(updated, null, 2) + '\n');
  } catch { throw new ReleaseError(1, 're-pinned importer config is invalid'); }
}

/** Compare against the validated original before replacing, without silently overwriting an operator edit. */
export async function atomicPrivateReplace(path: string, expected: Buffer, value: Buffer, config = false): Promise<void> {
  if (!(await readPrivateFile(path, !config)).equals(expected)) throw new ReleaseError(1, 'private file changed during release');
  if (expected.equals(value)) return;
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0)
    throw new ReleaseError(1, 'private file parent is not safely owned');
  const temp = resolve(dirname(path), `.release-${randomUUID()}.tmp`);
  try {
    const f = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await f.writeFile(value); await f.sync(); } finally { await f.close(); }
    if (!(await readPrivateFile(temp)).equals(value)) throw new ReleaseError(1, 'private file write verification failed');
    if (!(await readPrivateFile(path, !config)).equals(expected)) throw new ReleaseError(1, 'private file changed during release');
    await rename(temp, path);
    const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temp).catch(() => undefined); }
}

/** Logs stay outside the checkout; do not traverse a symlink or fix unsafe existing directory permissions. */
export async function privateLogDirectory(path: string, checkout: string): Promise<void> {
  if (!outsideCheckout(path, checkout)) throw new ReleaseError(2, 'release logs must be outside the checkout');
  const target = resolve(path);
  const missing: string[] = [];
  let cursor = target;
  for (;;) {
    try {
      const s = await lstat(cursor);
      if (!s.isDirectory() || await realpath(cursor) !== cursor || (s.mode & 0o022) !== 0)
        throw new ReleaseError(2, 'unsafe release log directory');
      if (cursor === target && (s.uid !== process.getuid?.() || (s.mode & 0o7777) !== 0o700))
        throw new ReleaseError(2, 'release log directory must be owned by this user and mode 0700');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      missing.push(cursor);
      cursor = dirname(cursor);
    }
  }
  for (const dir of missing.reverse()) await mkdir(dir, { mode: 0o700 });
}
