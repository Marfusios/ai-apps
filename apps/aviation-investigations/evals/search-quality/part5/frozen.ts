import { readFileSync } from 'node:fs';
import { fieldSettings, fileSha, sha, FIELD_SOURCE_FILES } from '../frozen.js';
import { YEAR_GUARD_VERSION } from '../../../shared/year-eligibility.js';
import { CATEGORY_GUARD_VERSION, AUTOMATIC_CATEGORY_CODES } from '../../../shared/category-eligibility.js';
import { EvaluationError } from '../money.js';

export const C2_DIR = 'evals/search-quality/part5/frozen';
export const C2_SOURCE_FILES = [...FIELD_SOURCE_FILES,
  'shared/explicit-filter-text.ts','shared/year-eligibility.ts','shared/category-eligibility.ts',
  ...['feasibility.py','construct-fields.py','aircraft-snapshot.ts','verify-data.ts','frozen.ts','freeze.ts','fields.ts','field-score.ts'].map(f=>`evals/search-quality/part5/${f}`),
  'tests/unit/year-category-eligibility.test.ts','tests/unit/task24-c2.test.ts','tests/unit/task24-allocation.test.ts'];
export function c2Settings() {
  const { guard: _oldStateGuard, ...scope } = fieldSettings();
  return { ...scope,guards:{year:YEAR_GUARD_VERSION,category:CATEGORY_GUARD_VERSION,categories:AUTOMATIC_CATEGORY_CODES},
    phase:'fields_c2',phaseCapMicros:5_000_000,attempts:1600,shuffleSeed:2026102507 };
}
export interface C2Manifest {
  version:'task24-fields-c2-freeze-v1';frozenAt:string;codeCommit:string;protocolSha256:string;
  settings:ReturnType<typeof c2Settings>;files:Record<string,string>;
  preflight:{goldVerified:boolean;measured:{id:string;tokens:number}[];ledger:unknown;pricesChecked:string;priceSource:string};
}
export function verifyC2Manifest() {
  const bytes=readFileSync(`${C2_DIR}/field-manifest.json`);
  const manifest=JSON.parse(bytes.toString()) as C2Manifest;
  if(manifest.version!=='task24-fields-c2-freeze-v1' || JSON.stringify(manifest.settings)!==JSON.stringify(c2Settings())) throw new EvaluationError('C2 settings changed');
  if(manifest.settings.version!=='scope.e3' || manifest.settings.systemSha256!=='901abbf596ebd86ea32afb5c241c51cace149d89958ab1a8a75398930c041b04'
    || manifest.settings.wireSha256!=='cb20cf6bc65ecd99328518c75e1513e716b92b59a272f5d86a9f022d8ddc85c9') throw new EvaluationError('Cleared scope.e3 identity changed');
  for(const [path,hash] of Object.entries(manifest.files)) if(fileSha(path)!==hash) throw new EvaluationError(`Frozen C2 file changed: ${path}`);
  if(!manifest.preflight.goldVerified || manifest.preflight.measured.length!==5 || manifest.preflight.measured.some(m=>m.tokens>manifest.settings.caps.input)) throw new EvaluationError('C2 free preflight incomplete');
  return {manifest,hash:sha(bytes)};
}
