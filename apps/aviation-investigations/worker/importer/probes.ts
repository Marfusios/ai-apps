import type { Client } from '@elastic/elasticsearch';
import { sql } from 'drizzle-orm';
import type { Db } from '../../server/db/client.js';
import { readCaseDetail } from '../../server/db/queries/case-views.js';
import { readCaseRecords } from '../../server/db/queries/case-records.js';
import { readIndexMeta } from '../../server/search/index-meta.js';
import { matchPassagesContract } from '../../server/search/passages-contract.js';
import { isServableCasesIndex } from '../index/cases-index.js';
import { buildCasePassages, EMBEDDING_INPUT_TEMPLATE_VERSION } from '../index/passages.js';
import { embeddingCacheKey, lookupEmbeddings } from '../index/embedding-cache.js';
import { CaseDetailSchema } from '../../shared/contracts/cases.js';
import { pageHead } from '../../server/seo/head.js';
import { ImportFailure, sameManifest, type ManifestIdentity } from './contracts.js';
import { certificationClient } from './strict-es.js';
import { digest, type SnapshotFacts } from './provenance.js';
import type { Comparison } from './compare.js';
import { manifest } from './store.js';

export const SENTINELS = ['DFW08TA066','MIA08LA156','DEN08LA103','NYC08LA106','SEA08LA057','CEN24FA064'];
export interface CandidatePair { generationId: number; casesIndex: string; passagesIndex: string }
export interface ProbeReport { ok: true; generationId: number; cases: number; passages: number; sampled: number; hash: string }
export function candidateSample(facts: SnapshotFacts, changes: Comparison): string[] {
  const byNo = new Map(facts.normalized.cases.map(c => [c.ntsbNo,c]));
  const changed = [...new Set([...changes.added,...changes.changed])].sort();
  const special = changed.filter(no => { const c=byNo.get(no);return c && (c.aircraft.length>1 || c.sections.filter(s=>s.kind==='probable_cause').length>1); });
  return [...new Set([...special.slice(0,10),...changed.slice(0,20)])].slice(0,20);
}
/** No provider dependency exists in this module. Every vector is from this artifact's exact cached input. */
export async function probeCandidate(db:Db, given:Client, pair:CandidatePair, facts:SnapshotFacts, changes:Comparison,
  embedding:{model:string;dims:number}):Promise<ProbeReport> {
  const es=certificationClient(given), {generationId,casesIndex,passagesIndex}=pair;
  const casesMeta=await readIndexMeta(es,casesIndex), passagesMeta=await readIndexMeta(es,passagesIndex);
  if (casesMeta.generationId!==generationId || !isServableCasesIndex(casesMeta.indexVersion,casesMeta.fingerprint)
    || matchPassagesContract(passagesMeta,{generationId,...embedding}).mismatches.length) throw new ImportFailure('probe');
  const totals=await db.execute(sql`select
    (select count(*)::int from cases where generation_id=${generationId} and is_us) as cases,
    (select count(*)::int from passages where generation_id=${generationId}) as passages`);
  const counts=totals.rows[0] as {cases:number;passages:number};
  if (!counts.cases || !counts.passages || (await es.count({index:casesIndex})).count!==counts.cases
    || (await es.count({index:passagesIndex})).count!==counts.passages) throw new ImportFailure('probe');
  const boundary = [facts.normalized.cases.find(c=>!c.isUs),facts.normalized.cases.find(c=>c.isUs&&!c.answerEligible)].filter(c=>c!==undefined);
  if (boundary.length!==2) throw new ImportFailure('probe');
  const chosen=[...new Set([...SENTINELS,...candidateSample(facts,changes),...boundary.map(c=>c.ntsbNo)])];
  const snapshotDate=[...facts.changeDates].sort().at(-1)!.slice(0,10);
  for (const no of chosen) {
    const detail=await readCaseDetail(db,generationId,no,{dataset:{revision:`g${generationId}-candidate`,snapshotDate},
      citationTextVersion:facts.normalized.citationTextVersion,fieldNormalizationVersion:facts.normalized.fieldNormalizationVersion,mappingVerified:false});
    const parsed=CaseDetailSchema.safeParse(detail);
    if (!parsed.success) throw new ImportFailure('probe');
    // Production metadata renderer escapes source fields; it receives only the schema-checked DTO.
    if (!pageHead({kind:'case',detail:parsed.data},'https://example.invalid').includes('<title>')) throw new ImportFailure('probe');
    const expected=facts.normalized.cases.find(c=>c.ntsbNo===no)!;
    const hits=await es.search({index:casesIndex,size:2,query:{term:{ntsb_no:no}}});
    if (hits.hits.hits.length!==(expected.isUs?1:0) || (expected.isUs && hits.hits.hits[0]?._id!==no)) throw new ImportFailure('probe');
    if (!expected.answerEligible && (await es.count({index:passagesIndex,query:{term:{ntsb_no:no}}})).count!==0) throw new ImportFailure('probe');
  }
  for (const query of ['fuel pump','carburetor icing','engine failure']) {
    const hits=await es.search({index:casesIndex,size:1,query:{bool:{filter:[{term:{answer_eligible:true}}],
      must:[{multi_match:{query,fields:['probable_cause','analysis','factual']}}]}}});
    if (hits.hits.hits.length!==1) throw new ImportFailure('probe');
  }
  const records=await readCaseRecords(db,generationId,[SENTINELS[0]!]);
  const passage=records[0] && buildCasePassages(records[0]).passages[0];
  if (!passage) throw new ImportFailure('probe');
  const key=embeddingCacheKey({input:passage.input,model:embedding.model,dims:embedding.dims,templateVersion:EMBEDDING_INPUT_TEMPLATE_VERSION});
  const vector=(await lookupEmbeddings(db,[key],embedding.model,embedding.dims)).get(key);
  if (!vector || [...vector].some(n=>!Number.isFinite(n))) throw new ImportFailure('probe');
  const nearest=await es.search({index:passagesIndex,size:5,knn:{field:'embedding',query_vector:[...vector],k:5,num_candidates:50,
    filter:{bool:{filter:[{term:{answer_eligible:true}},{term:{country:'USA'}}]}}}});
  if (!nearest.hits.hits.length) throw new ImportFailure('probe');
  const lexical=await es.search({index:passagesIndex,size:1,query:{term:{passage_id:passage.passageId}}});
  const document=lexical.hits.hits[0]?._source as Record<string,unknown>|undefined;
  if (!document || document.text!==passage.text || document.revision_id!==passage.revisionId
    || document.start!==passage.start || document.end!==passage.end) throw new ImportFailure('probe');
  const report={ok:true as const,generationId,cases:counts.cases,passages:counts.passages,sampled:chosen.length};
  return {...report,hash:digest(report)};
}

export interface ApplicationProbe {
  /** Approved deployed image/commit identity, obtained independently of source responses. */
  deployedCode: string;
  read(expected:ManifestIdentity):Promise<{revision:string;cases:number;hash:string}>;
}
/** A replaced dev publication invalidates the canary, including same-generation republishes. */
export async function runCanary(db:Db, expected:ManifestIdentity, app:ApplicationProbe,
  options:{sleep?:(ms:number)=>Promise<void>;durationMs?:number}={}):Promise<string> {
  const sleep=options.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
  if (!sameManifest(await manifest(db),expected)) throw new ImportFailure('baseline_changed');
  const first=await app.read(expected);
  await sleep(options.durationMs??600_000);
  if (!sameManifest(await manifest(db),expected)) throw new ImportFailure('baseline_changed');
  const second=await app.read(expected);
  if (!first.revision || first.revision!==second.revision || first.cases!==second.cases) throw new ImportFailure('probe');
  return digest([app.deployedCode,expected,first,second]);
}
