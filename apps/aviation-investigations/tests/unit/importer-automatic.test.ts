import {it,expect} from 'vitest';
import {checkShrink,suppressionKey} from '../../worker/importer/automatic.js';
import {ImportFailure,IMPORT_CAP_MICROS} from '../../worker/importer/contracts.js';

it.each(['total','eligible'] as const)('90% guard is exact and independent for %s',key=>{
 const before={total:100,eligible:100};
 expect(()=>checkShrink({...before,[key]:90},before)).not.toThrow();
 expect(()=>checkShrink({...before,[key]:91},before)).not.toThrow();
 expect(()=>checkShrink({...before,[key]:89},before)).toThrow('shrunk');
 expect(()=>checkShrink({...before,[key]:NaN},before)).toThrow('integrity');
 expect(()=>checkShrink({total:9,eligible:9},{total:10,eligible:10})).not.toThrow();
});
it('suppression binds environment, bytes, code and image, never a day or attempts',()=>{
 const args=['dev','a'.repeat(64),null,'b'.repeat(40),'sha256:'+'c'.repeat(64)] as const;
 const first=suppressionKey(...args);
 for(const n of [0,1,3,4]){const changed=[...args] as [string,string|null,null,string,string];changed[n]='different';expect(suppressionKey(...changed)).not.toBe(first);}
 expect(suppressionKey(...args)).toBe(first);expect(IMPORT_CAP_MICROS).toBe(2_000_000);
});
it.each(['source_unavailable','source_changed_during_download','cache_miss','monthly_budget','busy','backup_window','lock_lost','timeout','interrupted'] as const)('%s stays temporary without an attempt limit',reason=>expect(new ImportFailure(reason).fix).toBe(false));
it.each(['schema','integrity','verification','mapping','probe','site_check','import_cap','storage','configuration','cleanup','restore_hold','accounting','source_listing_changed','source_retired','shrunk','unclassified','alias_unknown','rollback_failed'] as const)('%s requires a fix',reason=>expect(new ImportFailure(reason).fix).toBe(true));
