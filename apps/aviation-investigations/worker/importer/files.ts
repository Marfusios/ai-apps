import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, statfs } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ImportFailure } from './contracts.js';
import { TABLE_NAMES, TABLE_SPECS } from '../ingest/tables.js';
import { readExtractManifest } from '../ingest/load.js';

const GIB = 1024 ** 3;
export const FILE_LIMITS = { root: 10 * GIB, workspace: 5 * GIB, reserve: 2 * GIB,
  expanded: GIB, raw: 2 * GIB, projected: GIB, report: 4 * 1024 ** 2 };
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0) throw new ImportFailure('storage');
}
export async function regular(path: string): Promise<number> {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink()) throw new ImportFailure('integrity');
  return s.size;
}
/** Does not follow symlinks, including in parents inside the managed root. */
export async function ownedPath(root: string, path: string): Promise<void> {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || resolve(path) === sep) throw new ImportFailure('storage');
  let cursor = resolve(root);
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    const s = await lstat(cursor).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
    if (s?.isSymbolicLink()) throw new ImportFailure('storage');
  }
}
export async function treeBytes(path: string): Promise<number> {
  const s = await lstat(path);
  if (s.isSymbolicLink()) throw new ImportFailure('storage');
  if (s.isFile()) return s.size;
  if (!s.isDirectory()) throw new ImportFailure('storage');
  let size = 0;
  for (const name of await readdir(path)) size += await treeBytes(join(path, name));
  return size;
}
export class ManagedSpace {
  peakBytes = 0;
  private snapshot: { bytes:number; free:number; at:number } | null = null;
  private allocated = 0;
  constructor(readonly root: string, readonly limits = FILE_LIMITS) {}
  async check(extra = 0): Promise<void> {
    // Count every write, but do not recursively stat the root for every CSV row. Between scans the
    // allocation estimate is conservative (deletions are credited only by an explicit stage-boundary scan).
    if (!this.snapshot || extra===0 || this.allocated>=1024**2 || Date.now()-this.snapshot.at>=1000) {
      const bytes=await treeBytes(this.root),fs=await statfs(this.root);
      const conservative=extra===0?bytes:Math.max(bytes,(this.snapshot?.bytes??0)+this.allocated);
      this.snapshot={bytes:conservative,free:fs.bavail*fs.bsize,at:Date.now()};this.allocated=0;
    }
    this.allocated+=extra;
    const bytes=this.snapshot.bytes+this.allocated;
    this.peakBytes=Math.max(this.peakBytes,bytes);
    if(bytes>this.limits.root||this.snapshot.free-this.allocated<this.limits.reserve)throw new ImportFailure('storage');
  }
  async remove(path: string): Promise<void> { await ownedPath(this.root, path); await rm(path, { force: true, recursive: true }); }
  async registered():Promise<string[]> {
    const path=join(this.root,'owned-paths.json');
    try {
      if(await regular(path)>this.limits.report)throw new ImportFailure('storage');
      const v=JSON.parse(await readFile(path,'utf8')) as {version?:unknown;paths?:unknown};
      if(v.version!==1||!Array.isArray(v.paths)||v.paths.length>512
        ||v.paths.some(p=>typeof p!=='string'||!OWNED_NAME.test(p)))throw new ImportFailure('storage');
      return v.paths as string[];
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
  }
  async register(name:string):Promise<void> {
    if(!OWNED_NAME.test(name))throw new ImportFailure('storage');
    await ownedPath(this.root,join(this.root,name));
    const paths=await this.registered();
    if(paths.includes(name))return;
    if(paths.length>=512)throw new ImportFailure('storage');
    await this.json(join(this.root,'owned-paths.json'),{version:1,paths:[...paths,name]});
  }
  async json(path: string, value: unknown): Promise<void> {
    await ownedPath(this.root, path);
    const body = Buffer.from(`${JSON.stringify(value)}\n`);
    if (body.length > this.limits.report) throw new ImportFailure('storage');
    await this.check(body.length);
    const temp = `${path}.${randomUUID()}.part`;
    const h = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await h.writeFile(body); await h.sync(); } finally { await h.close(); }
    if (!(await readFile(temp)).equals(body)) throw new ImportFailure('integrity');
    await rename(temp, path);
    const d = await open(dirname(path), 'r'); try { await d.sync(); } finally { await d.close(); }
  }
}
const OWNED_NAME=/^(?:(?:archives|extracts)\/[0-9a-f]{64}|archives\/[0-9a-f-]{36}\.part)$/;
export async function fileDigest(path: string): Promise<string> {
  await regular(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export interface ExtractHashes { version: 'csv-integrity.v1'; archive: string; manifest: string;
  tables: Record<string, { bytes: number; sha256: string }> }
/** New sidecar: historical extraction manifests remain byte-for-byte unchanged. */
export async function hashExtraction(dir: string): Promise<ExtractHashes> {
  await regular(join(dir,'manifest.json'));
  const manifest = readExtractManifest(dir);
  const tables: ExtractHashes['tables'] = {};
  for (const table of TABLE_NAMES) {
    if (!manifest.tables[table] || manifest.tables[table]!.columns !== TABLE_SPECS[table].columns.length) throw new ImportFailure('schema');
    const file = join(dir, `${table}.csv`);
    tables[table] = { bytes: await regular(file), sha256: await fileDigest(file) };
  }
  return { version: 'csv-integrity.v1', archive: manifest.archive.sha256,
    manifest: await fileDigest(join(dir, 'manifest.json')), tables };
}
export async function checkExtraction(dir: string, expected: ExtractHashes): Promise<void> {
  if (JSON.stringify(await hashExtraction(dir)) !== JSON.stringify(expected)) throw new ImportFailure('integrity');
}
