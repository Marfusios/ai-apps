import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractMember, verifyArchive } from '../../worker/ingest/archive.js';

const LIMITS = { maxCompressed: 1024 * 1024, maxExpanded: 1024 * 1024 };
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'archive-test-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Entry {
  name: string;
  data: Buffer;
  mode?: number;
}
let n = 0;
async function makeZip(entries: Entry[]): Promise<string> {
  const zip = new yazl.ZipFile();
  for (const e of entries) {
    zip.addBuffer(e.data, e.name, e.mode === undefined ? {} : { mode: e.mode });
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  const path = join(dir, `t${n++}.zip`);
  writeFileSync(path, Buffer.concat(chunks));
  return path;
}
function outDir(): string {
  const d = join(dir, `out${n++}`);
  mkdirSync(d);
  return d;
}
const mdb = Buffer.from('synthetic mdb bytes '.repeat(50));

describe('extractMember', () => {
  it('accepts single avall.mdb', async () => {
    const zip = await makeZip([{ name: 'avall.mdb', data: mdb }]);
    const out = outDir();
    const path = await extractMember(zip, 'avall.mdb', out, LIMITS);
    expect(path).toBe(join(out, 'avall.mdb'));
    expect(readFileSync(path)).toEqual(mdb);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('rejects traversal member ../evil.mdb', async () => {
    const zip = await makeZip([{ name: '../evil.mdb', data: mdb }]).catch(() => null);
    // yazl itself refuses some names; hand-patch a benign name in that case.
    const path = zip ?? (await patchedName('xxxxxxxxx.mdb', '../evil.mdb'));
    const out = outDir();
    await expect(extractMember(path, 'avall.mdb', out, LIMITS)).rejects.toThrow();
    expect(existsSync(join(out, 'evil.mdb'))).toBe(false);
    expect(existsSync(join(dir, 'evil.mdb'))).toBe(false);
  });

  it('rejects symlink entry', async () => {
    const zip = await makeZip([{ name: 'avall.mdb', data: Buffer.from('/etc/passwd'), mode: 0o120777 }]);
    await expect(extractMember(zip, 'avall.mdb', outDir(), LIMITS)).rejects.toThrow(/symlink|regular/i);
  });

  it('rejects nested zip', async () => {
    const inner = await makeZip([{ name: 'avall.mdb', data: mdb }]);
    const zip = await makeZip([{ name: 'inner.zip', data: readFileSync(inner) }]);
    await expect(extractMember(zip, 'avall.mdb', outDir(), LIMITS)).rejects.toThrow(/unexpected/i);
  });

  it('rejects an avall.mdb that is itself a zip', async () => {
    const inner = await makeZip([{ name: 'a', data: mdb }]);
    const zip = await makeZip([{ name: 'avall.mdb', data: readFileSync(inner) }]);
    await expect(extractMember(zip, 'avall.mdb', outDir(), LIMITS)).rejects.toThrow(/nested/i);
  });

  it('rejects more than one entry', async () => {
    const zip = await makeZip([
      { name: 'avall.mdb', data: mdb },
      { name: 'readme.txt', data: Buffer.from('x') },
    ]);
    await expect(extractMember(zip, 'avall.mdb', outDir(), LIMITS)).rejects.toThrow(/entr/i);
  });

  it('rejects an empty archive', async () => {
    const zip = await makeZip([]);
    await expect(extractMember(zip, 'avall.mdb', outDir(), LIMITS)).rejects.toThrow();
  });

  it('rejects expanded size over limit (fake header)', async () => {
    const zip = await makeZip([{ name: 'avall.mdb', data: mdb }]);
    const buf = readFileSync(zip);
    const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    buf.writeUInt32LE(0x7fffffff, cd + 24);
    const fake = join(dir, `fake${n++}.zip`);
    writeFileSync(fake, buf);
    const out = outDir();
    await expect(extractMember(fake, 'avall.mdb', out, LIMITS)).rejects.toThrow();
    expect(existsSync(join(out, 'avall.mdb'))).toBe(false);
  });

  it('stops streaming once real expanded bytes pass the limit', async () => {
    const zip = await makeZip([{ name: 'avall.mdb', data: Buffer.alloc(100_000, 1) }]);
    const out = outDir();
    await expect(
      extractMember(zip, 'avall.mdb', out, { maxCompressed: LIMITS.maxCompressed, maxExpanded: 10_000 }),
    ).rejects.toThrow(/expanded/i);
    expect(existsSync(join(out, 'avall.mdb'))).toBe(false);
  });

  it('rejects an archive over the compressed limit', async () => {
    const zip = await makeZip([{ name: 'avall.mdb', data: mdb }]);
    await expect(
      extractMember(zip, 'avall.mdb', outDir(), { maxCompressed: 10, maxExpanded: LIMITS.maxExpanded }),
    ).rejects.toThrow(/compressed/i);
  });
});

describe('verifyArchive', () => {
  it('returns hash and size when the digest matches', async () => {
    const zip = await makeZip([{ name: 'avall.mdb', data: mdb }]);
    const buf = readFileSync(zip);
    const sha256 = createHash('sha256').update(buf).digest('hex');
    await expect(verifyArchive(zip, sha256)).resolves.toEqual({ sha256, bytes: buf.length });
    await expect(verifyArchive(zip, sha256.toUpperCase())).resolves.toEqual({ sha256, bytes: buf.length });
  });

  it('rejects a mismatching digest', async () => {
    const zip = await makeZip([{ name: 'avall.mdb', data: mdb }]);
    await expect(verifyArchive(zip, '0'.repeat(64))).rejects.toThrow(/sha256/i);
  });
});

/** Build a zip whose single entry name is replaced in both headers (same length required). */
async function patchedName(placeholder: string, name: string): Promise<string> {
  const padded = placeholder.padEnd(name.length, 'x').slice(0, name.length);
  const zip = await makeZip([{ name: padded, data: mdb }]);
  const buf = readFileSync(zip);
  let from = 0;
  const needle = Buffer.from(padded);
  for (;;) {
    const i = buf.indexOf(needle, from);
    if (i < 0) break;
    Buffer.from(name).copy(buf, i);
    from = i + 1;
  }
  const out = join(dir, `patched${n++}.zip`);
  writeFileSync(out, buf);
  return out;
}
