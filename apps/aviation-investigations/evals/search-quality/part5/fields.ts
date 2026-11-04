/** One scope.e3 attempt per C2 question. The production Task 24 gate is mandatory. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAnthropicProvider } from '../../../server/ai/anthropic.js';
import { mulberry32 } from '../../retrieval/experiments/stats.js';
import { evaluationSettings } from '../config.js';
import { TaskAllocation, allocationTotals, appendDurable, EvaluationError } from '../money.js';
import { fieldAttempt } from '../fields.js';
import { fileSha, SCOPE_MODEL } from '../frozen.js';
import type { FieldObservation } from '../types.js';
import { C2_DIR, verifyC2Manifest } from './frozen.js';
import { scoreC2, type C2Dataset } from './field-score.js';

async function main() {
  const {values}=parseArgs({options:{'env-files':{type:'string'},'keys-file':{type:'string'},'out-dir':{type:'string'},'protocol-file':{type:'string'},'confirm-cost':{type:'boolean'}}});
  const frozen=verifyC2Manifest();
  if(!values['protocol-file'] || fileSha(values['protocol-file'])!==frozen.manifest.protocolSha256)throw new EvaluationError('Registered C2 protocol changed');
  const dataset=JSON.parse(readFileSync(`${C2_DIR}/fields.json`,'utf8')) as C2Dataset;
  const questions=[...dataset.questions],random=mulberry32(frozen.manifest.settings.shuffleSeed);
  for(let i=questions.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[questions[i],questions[j]]=[questions[j]!,questions[i]!];}
  if(!values['confirm-cost']){console.log(JSON.stringify({paid:false,manifest:frozen.hash,questions:questions.length,worstBlockMicros:questions.length*Math.round(frozen.manifest.settings.reservationUsd*1e6)}));return;}
  if(!values['env-files'])throw new EvaluationError('Explicit development files required');
  const settings=evaluationSettings(values['env-files'],values['keys-file']);
  if(!settings.config.ai.anthropic.apiKey || settings.config.ai.anthropic.scopeModel!==SCOPE_MODEL)throw new EvaluationError('Scope identity changed');
  const directory=resolve(values['out-dir']??'data/work/task24/fields_c2');mkdirSync(directory,{recursive:true,mode:0o700});
  const startPath=join(directory,'start.json'),attemptsPath=join(directory,'attempts.jsonl');
  const saved:any[]=existsSync(attemptsPath)?readFileSync(attemptsPath,'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
  if(existsSync(startPath)){
    if(JSON.parse(readFileSync(startPath,'utf8')).manifestSha256!==frozen.hash)throw new EvaluationError('C2 resume manifest changed');
  }else if(saved.length)throw new EvaluationError('Prior C2 dispatch has no start record');
  const dispatched=new Set(saved.filter(r=>r.event==='dispatch').map(r=>r.id));
  const prior=new Map<string,FieldObservation>(saved.filter(r=>r.event==='result').map(r=>[r.id,r as FieldObservation]));
  if([...dispatched].some(id=>!prior.has(id)) || prior.size!==saved.filter(r=>r.event==='result').length || [...prior.keys()].some(id=>!questions.some(q=>q.id===id))) throw new EvaluationError('Incomplete or duplicate billed C2 observation; reconcile without retry');
  const allocation=await TaskAllocation.open(settings,directory);
  const observations:FieldObservation[]=[];let completed=false;
  try {
    const pending=questions.filter(q=>!prior.has(q.id));
    if(pending.length)await allocation.assertBlock('fields_c2',pending.length*Math.round(frozen.manifest.settings.reservationUsd*1e6));
    if(!existsSync(startPath))writeFileSync(startPath,JSON.stringify({manifestSha256:frozen.hash,at:new Date().toISOString(),order:questions.map(q=>q.id)})+'\n',{flag:'wx',mode:0o600});
    const provider=createAnthropicProvider({apiKey:settings.config.ai.anthropic.apiKey,models:{scope:SCOPE_MODEL,answer:SCOPE_MODEL,check:SCOPE_MODEL}});
    const gate=allocation.gate('fields_c2',frozen.hash,'anthropic',SCOPE_MODEL,'scope_eval');
    let failuresInRow=0;
    for(const q of questions){
      const result=prior.get(q.id)??await fieldAttempt(q,provider,gate,frozen.manifest.settings.reservationUsd,r=>appendDurable(attemptsPath,r));
      observations.push(result);
      if(result.error && ['auth','bad_request','cap_exceeded','invalid_input'].includes(result.error))throw new EvaluationError('Scope dependency/cap failure; stopped without retry');
      failuresInRow=result.error && ['timeout','count_failed','rate_limited','overloaded','network','provider_error','provider_failure','unexpected'].includes(result.error)?failuresInRow+1:0;
      if(failuresInRow>=3)throw new EvaluationError('Three consecutive infrastructure failures; no retry');
      if(observations.length%20===0)console.log(JSON.stringify({completed:observations.length,total:questions.length,failures:observations.filter(o=>o.error).length}));
    }
    completed=true;
  }finally{
    const phaseLedger=await allocationTotals(allocation.db,'fields_c2');
    const confirmation2=await allocationTotals(allocation.db,'confirmation2');
    const narrative=await allocationTotals(allocation.db,'narrative');
    const totalLedger=await allocation.close();
    writeFileSync(join(directory,'observations.json'),JSON.stringify({manifestSha256:frozen.hash,completed,phaseLedger,confirmation2,narrative,totalLedger,observations},null,2)+'\n',{mode:0o600});
    const metrics=scoreC2(dataset,observations);
    writeFileSync(join(directory,'metrics.json'),JSON.stringify(metrics,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify({completed,observations:observations.length,failures:metrics.failures,clears:metrics.clears,phaseLedger,totalLedger}));
  }
}
main().catch(e=>{console.error(e instanceof EvaluationError?e.message:'C2 stopped; raw exception suppressed.');process.exitCode=1;});
