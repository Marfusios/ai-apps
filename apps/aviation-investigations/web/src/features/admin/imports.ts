/** Fixed words only. Alert severity and retry decisions come from the server. */
import type {AdminImportRun,AdminImports} from '../../../../shared/contracts/admin';
import {formatDateTime} from './format';
export const IMPORT_LIMITS={capUsd:2,overdueHours:36,deadlineHours:3,delayedDays:3,fixDays:7} as const;
export type ImportEnvironment='dev'|'live';
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** The source's day has no timezone; do not shift it into the viewer's zone. */
export function sourceDay(date:string|null|undefined):string {
 if(!date)return 'date not recorded';
 const [y,m,d]=date.slice(0,10).split('-').map(Number);
 return `${d} ${MONTHS[m!-1]} ${y}`;
}
export function reasonWords(reason:AdminImportRun['reason']):string {
 switch(reason){
 case 'schema':return 'The file’s tables or columns changed. AirCase cannot read it.';
 case 'shrunk':return 'The new file looks damaged: more than a tenth of its cases are missing. It was not put on this site.';
 case 'source_unavailable':return 'The NTSB download or the site did not answer.';
 case 'source_changed_during_download':return 'NTSB changed the file while it was downloading.';
 case 'monthly_budget':return 'This month’s OpenAI spending limit is used up.';
 case 'cache_miss':return 'The saved search vectors are not available yet.';
 case 'busy':case 'backup_window':return 'Another import or a backup was running.';
 case 'interrupted':case 'lock_lost':case 'timeout':return 'The import stopped before it finished.';
 case 'site_check':case 'probe':return 'The new data failed the site checks.';
 case 'rollback_failed':case 'alias_unknown':return 'The data switch could not be confirmed. The site may show mixed data.';
 case 'import_cap':return 'This file would cost more than the $2.00 import limit.';
 case 'source_retired':return 'NTSB stopped publishing this file. Automatic imports have ended.';
 case 'source_listing_changed':return 'The NTSB download page changed. AirCase cannot find the file.';
 case 'storage':return 'The server cannot safely save the import files. Check its disk space and permissions.';
 case 'cleanup':return 'The importer could not clean up its temporary files.';
 case 'restore_hold':case 'accounting':return 'Imports are stopped until the restored spending records are checked.';
 case 'integrity':case 'verification':case 'mapping':return 'The file or search data failed an integrity check.';
 case 'configuration':return 'The importer’s settings need a fix.';
 case 'dev_failed':return 'The test copy of the site has not finished its checks.';
 case 'manual_rollback':return 'The site was returned to the previous data.';
 case 'post_success':return 'The import finished, but a later task did not finish.';
 case 'metadata_unchanged':case 'same_archive':case 'same_content':return 'No new file.';
 case 'baseline_changed':return 'The data on the site changed during the import.';
 default:return 'The import stopped with an unexpected error.';
 }
}
export function importOutcome(run:AdminImportRun):string {
 const day=sourceDay(run.source?.advertisedAtLocal);
 if(run.result==='published'){
  const changes=run.changes?`: ${run.changes.new.toLocaleString('en-US')} new cases, ${run.changes.updated.toLocaleString('en-US')} updated, ${run.changes.removed.toLocaleString('en-US')} removed`:'';
  return `Imported ${run.source?`the ${day} file`:'a new file'}${changes}`;
 }
 if(run.suppressed||run.result==='waiting')return `No new file. ${run.source?`The ${day} file`:'The waiting file'} waits for a fix.`;
 if(run.result==='unchanged')return run.workKind==='recertification'?'The data on the site passed the release checks.':'No new file.';
 if(run.result==='running')return 'Import in progress.';
 if(run.result==='skipped_dev_failed')return `Held back by the test copy of the site: ${reasonWords(run.reason)}`;
 if(run.result==='rolled_back')return 'The site went back to the previous data.';
 if(run.result==='needs_review')return 'Earlier import stopped.';
 return `${run.result==='deferred'?'Waiting':'Failed'}: ${reasonWords(run.reason)}`;
}
export function alertDetails(imports:AdminImports,zone:string):string {
 const a=imports.alert;if(!a)return '';
 const r=a.details;
 return [r?.result??'failed',a.cause,r?.step??'check',`${formatDateTime(r?.checkedAt??a.since,zone)} (${zone})`,
  r?.runId?`run ${r.runId}`:null,r?.source?`file ${sourceDay(r.source.advertisedAtLocal)}`:null,
  r?.code?`code ${r.code}`:null,r?.image?`image ${r.image}`:null,a.originRunId?`dev run ${a.originRunId}`:null].filter(Boolean).join(' · ');
}
export function alertSentences(imports:AdminImports,environment:ImportEnvironment,zone:string):string[] {
 const a=imports.alert;if(!a)return [];
 const lines:string[]=[];
 if(a.cause==='overdue')lines.push(`No import check has run since ${formatDateTime(a.since,zone)} (${zone}).`);
 else if(a.cause==='status_unavailable')lines.push('AirCase cannot read the import status.');
 else {
  if(a.postSuccess)lines.push('The import finished. A later task needs attention.');
  if(a.origin==='dev'&&environment==='live')lines.push('The new file failed in the test copy of the site (dev). Live was not touched.');
  if(!a.postSuccess && a.details?.source)lines.push(`The NTSB file of ${sourceDay(a.details.source.advertisedAtLocal)} is waiting.`);
  lines.push(reasonWords(a.cause));
  if(a.failedDays>=3)lines.push(`Imports have failed on ${a.failedDays>=7?'at least ':''}${a.failedDays} different days.`);
 }
 if(a.devAdvanced)lines.push('Dev has the new file. Live still has the previous file.');
 const source=imports.serving?.sourceDate;
 if(a.siteState==='uncertain'&&!['alias_unknown','rollback_failed'].includes(a.cause))lines.push('The site may show mixed data.');
 else if(a.siteState==='restored')lines.push(source?`The site went back to the data from ${sourceDay(source)}. The site checks passed.`:'The site went back to the previous data. The site checks passed.');
 else if(a.siteState!=='uncertain')lines.push(source?`The site still shows the data from the NTSB file of ${sourceDay(source)}.`:'The file date of the data on the site is not recorded.');
 if(a.cause==='monthly_budget')lines.push('The import continues on the 1st of next month.');
 else if(a.nextAction==='daily')lines.push(a.level==='fix'?'The system still tries every day. The server or service needs a fix.':'The system tries again every day. Nothing for you to do.');
 else if(a.cause==='overdue')lines.push('The schedule or server needs a fix. The alert goes away when checks run again.');
 else if(a.siteState==='uncertain')lines.push('A release is needed before the system can try recovery. It will not switch data while the result is uncertain.');
 else lines.push('This needs a code or settings fix, or a newer file. The system still checks every day. The alert goes away after a good import.');
 return lines;
}
