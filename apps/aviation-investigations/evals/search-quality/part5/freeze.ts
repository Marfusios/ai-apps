/** Explicit free counts and locked full-block admission; no generated output. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createAnthropicProvider } from '../../../server/ai/anthropic.js';
import { evidenceScopeCtx } from '../../../server/ai/provider.js';
import { evaluationSettings } from '../config.js';
import { TaskAllocation, allocationTotals, EvaluationError } from '../money.js';
import { fileSha, SCOPE_MODEL } from '../frozen.js';
import { C2_DIR, C2_SOURCE_FILES, c2Settings, verifyC2Manifest, type C2Manifest } from './frozen.js';
import type { C2Dataset } from './field-score.js';

async function main() {
  const {values}=parseArgs({options:{'env-files':{type:'string'},'keys-file':{type:'string'},'protocol-file':{type:'string'}}});
  if(!values['env-files'] || !values['protocol-file']) throw new EvaluationError('Explicit development files and registered protocol required');
  if(existsSync(`${C2_DIR}/field-manifest.json`)) throw new EvaluationError('C2 already frozen; never overwrite');
  if(execFileSync('git',['status','--porcelain','--','server','shared','worker','evals/search-quality','tests/unit/year-category-eligibility.test.ts','tests/unit/task24-c2.test.ts','tests/unit/task24-allocation.test.ts'],{encoding:'utf8'}).trim()) throw new EvaluationError('Commit C2 code and gold before freeze');
  const dataset=JSON.parse(readFileSync(`${C2_DIR}/fields.json`,'utf8')) as C2Dataset;
  const gold=JSON.parse(readFileSync(`${C2_DIR}/gold-verification.json`,'utf8'));
  if(!gold.passed || gold.questions!==1600 || gold.hashes.fields!==fileSha(`${C2_DIR}/fields.json`)) throw new EvaluationError('C2 exact-gold verification missing');
  const settings=evaluationSettings(values['env-files'],values['keys-file']);
  if(!settings.config.ai.anthropic.apiKey || settings.config.ai.anthropic.scopeModel!==SCOPE_MODEL) throw new EvaluationError('Scope model/key differs');
  const scope=c2Settings();
  const provider=createAnthropicProvider({apiKey:settings.config.ai.anthropic.apiKey,models:{scope:SCOPE_MODEL,answer:SCOPE_MODEL,check:SCOPE_MODEL}});
  const measured=[];
  for(const q of [...dataset.questions].sort((a,b)=>Buffer.byteLength(b.question)-Buffer.byteLength(a.question)||a.id.localeCompare(b.id)).slice(0,5)) {
    const tokens=await provider.countEvidenceScopeTokens!({question:q.question},evidenceScopeCtx(AbortSignal.timeout(10_000),10_000));
    if(tokens>scope.caps.input)throw new EvaluationError('C2 free count exceeds frozen cap');
    measured.push({id:q.id,tokens});
  }
  const allocation=await TaskAllocation.open(settings,'data/work/task24/part5/preflight');
  let ledger;
  try {
    await allocation.assertBlock('fields_c2',1600*Math.round(scope.reservationUsd*1e6));
    ledger={total:await allocationTotals(allocation.db),fields_c2:await allocationTotals(allocation.db,'fields_c2'),confirmation2:await allocationTotals(allocation.db,'confirmation2'),
      narrative:await allocationTotals(allocation.db,'narrative'),monthlyIngestionUsd:allocation.config.ai.budgets.ingestionMonthlyUsd};
  }finally{await allocation.close();}
  const files=[...C2_SOURCE_FILES,...['fields.json','exclusions.json','power.json','feasibility.json','feasibility-relaxed-exposure.json','construction.json','gold-verification.json'].map(f=>`${C2_DIR}/${f}`)];
  const manifest:C2Manifest={version:'task24-fields-c2-freeze-v1',frozenAt:new Date().toISOString(),
    codeCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),protocolSha256:fileSha(values['protocol-file']),settings:scope,
    files:Object.fromEntries(files.map(f=>[f,fileSha(f)])),preflight:{goldVerified:true,measured,ledger,pricesChecked:'2026-10-25',
      priceSource:'https://platform.claude.com/docs/en/models/haiku-5-5/overview (unchanged Part 4 checked price snapshot)'}};
  writeFileSync(`${C2_DIR}/field-manifest.json`,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  const frozen=verifyC2Manifest();console.log(JSON.stringify({paidCalls:0,frozen:frozen.hash,questions:1600,measured,worstBlockMicros:1600*Math.round(scope.reservationUsd*1e6),ledger}));
}
main().catch(e=>{console.error(e instanceof EvaluationError?e.message:'C2 free freeze failed; raw exception suppressed.');process.exitCode=1;});
