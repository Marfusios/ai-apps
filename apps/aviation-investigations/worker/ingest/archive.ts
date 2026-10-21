import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export interface ArchiveLimits {
  maxCompressed: number;
  maxExpanded: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = {
  maxCompressed: 200 * 1024 * 1024,
  maxExpanded: 1024 * 1024 * 1024,
};

/** Hash the archive and require it to match the pinned digest. */
export async function verifyArchive(
  zipPath: string,
  expectedSha256: string,
): Promise<{ sha256: string; bytes: number }> {
  const expected = expectedSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('expected sha256 must be 64 hex characters');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(zipPath)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  const sha256 = hash.digest('hex');
  if (sha256 !== expected) throw new Error(`archive sha256 mismatch: expected ${expected}, got ${sha256}`);
  return { sha256, bytes };
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zf) =>
      err || !zf ? reject(err ?? new Error('cannot open archive')) : resolve(zf),
    );
  });
}

function checkEntry(entry: yauzl.Entry, member: string, limits: ArchiveLimits): void {
  const name = entry.fileName;
  if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`unsafe archive entry name rejected`);
  }
  if (name !== member) throw new Error(`unexpected archive entry (only "${member}" is allowed)`);
  if (entry.isEncrypted()) throw new Error('encrypted archive entries are not allowed');
  // High 16 bits of external attributes hold the Unix mode when made on Unix (host 3).
  const hostOs = entry.versionMadeBy >>> 8;
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if (hostOs === 3 && (mode & S_IFMT) !== 0 && (mode & S_IFMT) !== S_IFREG) {
    throw new Error('symlink or non-regular archive entry rejected');
  }
  if (entry.uncompressedSize > limits.maxExpanded) {
    throw new Error(`expanded size ${entry.uncompressedSize} exceeds limit ${limits.maxExpanded}`);
  }
}

/**
 * Extract the single allowed member to `<outDir>/<member>`. Sizes are enforced
 * on the bytes actually produced, not just on the headers.
 */
export async function extractMember(
  zipPath: string,
  member: 'avall.mdb',
  outDir: string,
  limits: ArchiveLimits,
): Promise<string> {
  const { size } = await stat(zipPath);
  if (size > limits.maxCompressed) {
    throw new Error(`compressed archive size ${size} exceeds limit ${limits.maxCompressed}`);
  }
  const zf = await openZip(zipPath);
  const target = join(outDir, member);
  try {
    if (zf.entryCount !== 1) throw new Error(`archive must contain exactly one entry, found ${zf.entryCount}`);
    const entry = await new Promise<yauzl.Entry>((resolve, reject) => {
      zf.once('entry', resolve);
      zf.once('error', reject);
      zf.once('end', () => reject(new Error('archive has no entries')));
      zf.readEntry();
    });
    checkEntry(entry, member, limits);
    const input = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
      zf.openReadStream(entry, (err, s) => (err || !s ? reject(err ?? new Error('cannot read entry')) : resolve(s))),
    );
    let total = 0;
    let first = true;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (first) {
          first = false;
          if (chunk.length >= 4 && chunk.readUInt32LE(0) === 0x04034b50) {
            return cb(new Error('nested archive rejected'));
          }
        }
        total += chunk.length;
        if (total > limits.maxExpanded) return cb(new Error(`expanded size exceeds limit ${limits.maxExpanded}`));
        cb(null, chunk);
      },
    });
    await pipeline(input, guard, createWriteStream(target, { flags: 'wx', mode: 0o644 }));
    return target;
  } catch (err) {
    await rm(target, { force: true });
    throw err;
  } finally {
    zf.close();
  }
}
