import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { runContainer, resolveImageId, SANDBOX_FLAGS } from '../../worker/ingest/extract.js';
import { execFileSync } from 'node:child_process';
import { ImportFailure } from '../../worker/importer/contracts.js';

it('attached stdout works with log-driver=none in the actual networkless extraction sandbox',async()=>{
  expect(SANDBOX_FLAGS).toContain('--log-driver=none');
  const chunks:Buffer[]=[];
  const seen:string[]=[];
  await runContainer({image:await resolveImageId(),mounts:[],command:['/bin/sh','-c','printf synthetic-csv'],
    sink:new Writable({write(c,_e,cb){chunks.push(c);cb();}}),timeoutMs:10_000,maxBytes:1024,
    container:async(name,present)=>{seen.push(present?'created':'removed');}});
  expect(Buffer.concat(chunks).toString()).toBe('synthetic-csv'); expect(seen).toEqual(['created','removed']);
});

it.each(['output','storage','timeout'])('confirms daemon cleanup after %s exhaustion in the real sandbox',async failure=>{
  let name='';const events:boolean[]=[];
  await expect(runContainer({image:await resolveImageId(),mounts:[],
    command:['/bin/sh','-c',failure==='timeout'?'sleep 30':'printf synthetic-csv'],
    sink:new Writable({write(_c,_e,cb){cb();}}),timeoutMs:failure==='timeout'?250:10_000,
    maxBytes:failure==='output'?1:1024,
    beforeWrite:async()=>{if(failure==='storage')throw new ImportFailure('storage');},
    container:async(n,present)=>{name=n;events.push(present);}})).rejects.toThrow();
  expect(events).toEqual([true,false]);
  expect(execFileSync('docker',['ps','-a','--filter',`name=^/?${name}$`,'--format','{{.Names}}'],{encoding:'utf8',timeout:15_000}).trim()).toBe('');
});
