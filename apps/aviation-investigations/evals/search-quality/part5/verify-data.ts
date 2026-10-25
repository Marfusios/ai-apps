/** Independent metadata equality, exact gold, grammar coverage, and cross-field no-apply audit. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { BriefFiltersSchema, QuestionSchema } from '../../../shared/contracts/briefs.js';
import { fileSha } from '../frozen.js';
import { guardedFields, type C2Dataset } from './field-score.js';
import type { Filters } from '../types.js';

const root = 'evals/search-quality/part5/frozen';
export function verifyC2Data() {
  const dataset = JSON.parse(readFileSync(`${root}/fields.json`,'utf8')) as C2Dataset;
  const raw = JSON.parse(readFileSync('data/work/task24/corpus.json','utf8'));
  const ex = JSON.parse(readFileSync(`${root}/exclusions.json`,'utf8'));
  const extras = JSON.parse(readFileSync('data/work/task24/part5/aircraft.json','utf8'));
  const cases = new Map<string,any>(raw.cases.map((c:any)=>[c.ntsb_no,c]));
  const bad = new Set<string>(ex.cases), used = new Set<string>(), texts = new Set<string>();
  assert.deepEqual(dataset.source,raw.source);
  assert.equal(dataset.questions.length,1600);
  assert.equal(new Set(dataset.questions.map(q=>q.id)).size,1600);
  const issues: {id:string;kind:string;got?:unknown;want?:unknown}[]=[];
  for(const q of dataset.questions) {
    QuestionSchema.parse(q.question); BriefFiltersSchema.parse(q.gold);
    const n=q.seed.ntsb_no, c=cases.get(n);
    assert(c && !bad.has(n) && !used.has(n),q.id);used.add(n);
    const text=q.question.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
    assert(!texts.has(text),q.id);texts.add(text);
    assert.deepEqual(q.seed,Object.fromEntries(Object.keys(q.seed).map(k=>[k,c[k]])));
    const aa=raw.aircraft.filter((a:any)=>a.ntsb_no===n);
    assert.equal(aa.length,1);
    assert.deepEqual(q.aircraft,aa.map((a:any)=>({aircraft_key:a.aircraft_key,category:a.category,defining_phase_group:a.defining_phase_group})));
    const context=(q as any).context;
    assert(raw.findings.some((f:any)=>f.ntsb_no===n && f.code===context.code && f.description===context.description));
    assert(q.question.includes(context.topic));
    const d=extras.rows.find((a:any)=>a.ntsb_no===n && a.aircraft_key===aa[0].aircraft_key);
    assert.deepEqual((q as any).makerModel,{make:d.make,model:d.model});
    if(q.role==='positive') {
      if(q.field==='category') assert.deepEqual(q.gold,{category:[aa[0].category]});
      else {
        const y=c.ev_year;
        const want=q.stratum==='single'?{yearFrom:y,yearTo:y}:q.stratum==='closed'?{yearFrom:y-1,yearTo:y+1}:q.stratum==='lower'?{yearFrom:y}:{yearTo:y};
        assert.deepEqual(q.gold,want,q.id);
      }
      const got=guardedFields(q.question,q.gold);
      if(JSON.stringify(got)!==JSON.stringify(q.gold)) issues.push({id:q.id,kind:'gold-not-eligible',got,want:q.gold});
    } else {
      assert.deepEqual(q.gold,{}); assert(q.critical);
      // Try all singleton canonical codes and boundary variants, not just one dummy output.
      for(const category of ['AIR','HELI','GLI','BALL','ULTR','PLFT','GYRO','WSFT','PPAR','BLIM','UNK']) {
        if(q.field==='category' && Object.keys(guardedFields(q.question,{category:[category]})).length) issues.push({id:q.id,kind:'control-eligible',got:category});
      }
      const years=[...q.question.matchAll(/\b\d{4}\b/g)].map(m=>Number(m[0]));
      if(q.field==='yearRange') for(const y of years) {
        const probes:Filters[]=[{yearFrom:y,yearTo:y},{yearFrom:y},{yearTo:y},{yearFrom:y+1},{yearTo:y-1}];
        for(const gold of probes)if(Object.keys(guardedFields(q.question,gold)).length) issues.push({id:q.id,kind:'control-eligible',got:gold});
      }
    }
  }
  for(const field of ['yearRange','category']) for(const role of ['positive','control']) {
    const qs=dataset.questions.filter(q=>q.field===field && q.role===role);assert.equal(qs.length,400);
    const counts=new Map<string,number>();qs.forEach(q=>counts.set(q.wordingFamily,(counts.get(q.wordingFamily)??0)+1));
    assert.equal(counts.size,16);assert([...counts.values()].every(n=>n===25));
  }
  const result={version:'task24-fields-c2-verification-v1',passed:issues.length===0,questions:1600,independentSeedCases:used.size,
    issues,hashes:{corpus:fileSha('data/work/task24/corpus.json'),fields:fileSha(`${root}/fields.json`),exclusions:fileSha(`${root}/exclusions.json`)}};
  writeFileSync(`${root}/gold-verification.json`,JSON.stringify(result,null,2)+'\n');
  return result;
}
if(process.argv[1]?.endsWith('/verify-data.ts')) {
  const r=verifyC2Data();console.log(JSON.stringify(r));if(!r.passed)process.exitCode=1;
}
