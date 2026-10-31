import { constants } from 'node:fs';
import { open, readdir, readFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { extractArchive, reconcileByName, setExtractEnvironment, type ExtractGuard } from '../ingest/extract.js';
import { readProjectedTables } from '../ingest/normalize.js';
import { readExtractManifest, checkRowCounts } from '../ingest/load.js';
import { TABLE_NAMES } from '../ingest/tables.js';
import { ImportFailure, Sha256 } from './contracts.js';
import { ManagedSpace, FILE_LIMITS, privateDirectory, regular, fileDigest, hashExtraction, checkExtraction,
  type ExtractHashes, treeBytes, ownedPath } from './files.js';
import { sourceFacts, digest, type SnapshotFacts } from './provenance.js';
import { MAX_ARCHIVE_BYTES } from './source.js';

const CleanupSchema=z.strictObject({ archive:Sha256, containers:z.array(z.string().regex(/^ai-aviation-(dev|live)-extract-[0-9a-f]{12}$/)).max(16) });
/** Read only owner-created bounded JSON; never deserialize source-supplied paths. */
export async function privateJson(path:string):Promise<unknown> {
  if (await regular(path)>FILE_LIMITS.report || ((await lstat(path)).mode&0o077)!==0) throw new ImportFailure('storage');
  return JSON.parse(await readFile(path,'utf8')) as unknown;
}
export async function recoverExtraction(space:ManagedSpace):Promise<void> {
  // Registered partial downloads belong only to a terminated previous child (the host owns both locks).
  for(const path of await space.registered())if(/^archives\/[0-9a-f-]{36}\.part$/.test(path))await space.remove(join(space.root,path));
  const state=join(space.root,'extraction.json');
  let raw:unknown;
  try {raw=await privateJson(state);} catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  const parsed=CleanupSchema.safeParse(raw);
  if (!parsed.success) throw new ImportFailure('cleanup');
  for (const name of parsed.data.containers) {
    try {await reconcileByName(name);} catch {throw new ImportFailure('cleanup');}
  }
  // The host lock outlives the worker. No raw workspace is reused before every recorded container is gone.
  const parent=join(space.root,'extracts');
  for (const name of await readdir(parent).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;})) {
    if (new RegExp(`^${parsed.data.archive}\\.staging-[0-9a-f]{12}$`).test(name)) await space.remove(join(parent,name));
  }
  await space.remove(state);
}
/** Copy the initial pinned ZIP under the same bounds as a download; this is NOT a remote retrieval. */
export async function seedArchive(space:ManagedSpace,path:string,sha256:string):Promise<string> {
  Sha256.parse(sha256);
  const bytes=await regular(path);
  if (bytes>MAX_ARCHIVE_BYTES || await fileDigest(path)!==sha256) throw new ImportFailure('integrity');
  const dir=join(space.root,'archives',sha256), target=join(dir,'avall.zip');
  await space.register(`archives/${sha256}`);
  await privateDirectory(dir);
  try {if(await fileDigest(target)!==sha256)throw new ImportFailure('integrity');return target;}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const temp=join(dir,'seed.part');
  await space.remove(temp);
  const input=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  const output=await open(temp,'wx',0o600);
  try {
    for await(const chunk of input.createReadStream({autoClose:false})) {await space.check(chunk.length);await output.writeFile(chunk);}
    await output.sync();
  } finally {await input.close();await output.close();}
  if(await fileDigest(temp)!==sha256)throw new ImportFailure('integrity');
  await rename(temp,target);
  const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
  return target;
}
export interface ExtractedSnapshot { archive:string; dir:string; hashes:ExtractHashes; csvHash:string; facts:SnapshotFacts }
export async function readSnapshot(space:ManagedSpace,archive:string):Promise<ExtractedSnapshot> {
  Sha256.parse(archive);
  const dir=join(space.root,'extracts',archive);
  await ownedPath(space.root,dir);
  const hashes=await privateJson(join(dir,'integrity.json')) as ExtractHashes;
  await checkExtraction(dir,hashes);
  if (hashes.archive!==archive) throw new ImportFailure('integrity');
  const tables=await readProjectedTables(dir);
  checkRowCounts(tables,readExtractManifest(dir));
  return {archive,dir,hashes,csvHash:digest(hashes),facts:sourceFacts(tables)};
}
export async function extractSnapshot(space:ManagedSpace,archive:string,environment:'dev'|'live', assert:()=>void):Promise<ExtractedSnapshot> {
  await recoverExtraction(space);
  const parent=join(space.root,'extracts'),dir=join(parent,archive);
  await space.register(`extracts/${archive}`);
  await privateDirectory(parent);
  const exists=async(path:string)=>{try{await lstat(path);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}};
  if(await exists(join(dir,'integrity.json')))return readSnapshot(space,archive);
  // A killed extraction may have renamed its complete directory before writing the sidecar.
  if(await exists(join(dir,'manifest.json'))) {
    const hashes=await hashExtraction(dir);
    if(hashes.archive!==archive)throw new ImportFailure('integrity');
    await space.json(join(dir,'integrity.json'),hashes);
    return readSnapshot(space,archive);
  }
  await space.remove(dir);
  const state={archive,containers:[] as string[]};
  await space.json(join(space.root,'extraction.json'),state);
  const cumulative={expanded:0,raw:0,projected:0};
  const guard:ExtractGuard={async beforeWrite(kind,bytes) {
    assert();cumulative[kind]+=bytes;
    if(cumulative[kind]>FILE_LIMITS[kind]
      || Object.values(cumulative).reduce((a,b)=>a+b,0)>FILE_LIMITS.workspace)throw new ImportFailure('storage');
    await space.check(bytes);
  },async container(name,present) {
    state.containers=present?[...state.containers,name]:state.containers.filter(n=>n!==name);
    CleanupSchema.parse(state);await space.json(join(space.root,'extraction.json'),state);
  }};
  setExtractEnvironment(environment);
  await extractArchive({archive:join(space.root,'archives',archive,'avall.zip'),sha256:archive,out:dir,guard});
  for(const name of [...TABLE_NAMES.map(t=>`${t}.csv`),'manifest.json']) {
    const h=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);try{await h.sync();}finally{await h.close();}
  }
  if(await treeBytes(dir)>FILE_LIMITS.projected)throw new ImportFailure('storage');
  await space.json(join(dir,'integrity.json'),await hashExtraction(dir));
  await recoverExtraction(space);
  return readSnapshot(space,archive);
}
