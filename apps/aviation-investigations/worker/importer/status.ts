import {
  AdminImportsSchema,
  type AdminImports,
  type AdminImportRun,
  ImportFailure,
} from './contracts.js';
import { IMPORT_LOCAL_TIME, IMPORT_TIME_ZONE } from '../../shared/import-schedule.js';

export interface ImportSchedule {
  enabled: boolean;
  localTime: string;
  timeZone: string;
}
export const DEFAULT_SCHEDULE: ImportSchedule = {
  enabled: false,
  localTime: IMPORT_LOCAL_TIME,
  timeZone: IMPORT_TIME_ZONE,
};
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 8) formatters.clear();
    formatters.set(zone, value);
  }
  return value;
}
export function localClock(
  at: Date,
  zone: string,
): { day: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}
/** Enumerate real instants: handles nonexistent and repeated civil times without assuming 24 h. */
export function nextCheck(now: Date, schedule: ImportSchedule): string | null {
  if (!schedule.enabled) return null;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime))
    throw new ImportFailure('configuration');
  const [hour, minute] = schedule.localTime.split(':').map(Number);
  try {
    for (
      let t = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
      t <= now.getTime() + 3 * 86_400_000;
      t += 60_000
    ) {
      const c = localClock(new Date(t), schedule.timeZone);
      if (c.hour === hour && c.minute === minute) return new Date(t).toISOString();
    }
  } catch {
    throw new ImportFailure('configuration');
  }
  throw new ImportFailure('configuration');
}
export function inBackupWindow(now: Date, zone = 'Europe/Prague'): boolean {
  const c = localClock(now, zone),
    minute = c.hour * 60 + c.minute;
  return minute >= 240 && minute < 315;
}
export interface StatusRow {
  public: AdminImportRun;
  sourceCheckSucceeded: boolean;
  canaryPassed: boolean;
  goodCheck?: boolean;
  unresolved?: boolean; // historical rows only; never authorizes or blocks work
  recertification?: boolean;
}
export interface ImportHealth {
  automaticSince: string;
  restoreHeld: boolean;
  switchHeld: boolean;
  temporaryDays: number;
  serving: AdminImports['serving'];
  lastGood: AdminImportRun|null;
  waiting: {source:AdminImportRun['source'];since:string}|null;
  issue: {reason:AdminImportRun['reason'];fixed:boolean;since:string;origin:'dev'|'live'|'host';
    siteState:'unchanged'|'restored'|'restore_unverified'|'uncertain';postSuccess:boolean;details:AdminImportRun|null;originRunId:string|null}|null;
}
/** Severity and retry policy are server owned. Incidents outlive the recent-run window. */
export function projectImports(rows: readonly StatusRow[], schedule: ImportSchedule|null, now:Date,
 health?:ImportHealth|boolean):AdminImports {
  const sorted=[...rows].sort((a,b)=>b.public.checkedAt.localeCompare(a.public.checkedAt));
  const known=typeof health==='object' ? health : null;
  const unknown=health===true;
  const enabled=schedule?.enabled===true;
  const lastStartedAt=sorted[0]?.public.checkedAt??null;
  const lastCheck=sorted.find(r=>r.public.finishedAt!==null&&!r.recertification)?.public??null;
  const lastGoodCheck=known?.lastGood??sorted.find(r=>r.goodCheck)?.public??null;
  const since=lastStartedAt??known?.automaticSince??now.toISOString();
  const overdue=now.getTime()-Date.parse(since)>36*3_600_000;
  const issue=known?.issue;
  const days=known?.temporaryDays??0;
  let alert:AdminImports['alert']=null;
  const retry=issue?.siteState==='uncertain'?'release':issue?.fixed&&!issue.postSuccess?'new_file_or_release':'daily';
  if(enabled) {
    const cause=known?.restoreHeld?'restore_hold':known?.switchHeld?(issue?.reason??'alias_unknown'):
      unknown?'status_unavailable':issue?.fixed?(issue.reason??'unclassified'):overdue?'overdue':days>=3?(issue?.reason??'interrupted'):null;
    if(cause) {
      const level=issue?.fixed||known?.restoreHeld||known?.switchHeld||unknown||overdue||days>=7?'fix':'delayed';
      const issueSelected=cause!=='overdue'&&cause!=='status_unavailable';
      alert={level,cause,since:cause==='overdue'?since:issue?.since??now.toISOString(),failedDays:days,
        origin:issueSelected?issue?.origin??'host':'host',siteState:known?.switchHeld?'uncertain':issueSelected?issue?.siteState??'unchanged':'unchanged',
        nextAction:cause==='overdue'||cause==='status_unavailable'?'release':known?.restoreHeld?'release':retry,
        retryAt:cause==='monthly_budget'?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString():null,
        postSuccess:issueSelected&&issue?.postSuccess===true,
        devAdvanced:cause==='shrunk'&&issue?.origin==='live',details:issueSelected?issue?.details??null:null,
        originRunId:issueSelected?issue?.originRunId??null:null};
    }
  }
  const waiting=known?.waiting??(issue&&!issue.postSuccess&&issue.details?.source?{source:issue.details.source,since:issue.since}:null);
  return AdminImportsSchema.parse({enabled,status:!enabled?'off':alert?.level??'working',
    schedule:schedule?{localTime:schedule.localTime,timeZone:schedule.timeZone,nextCheckAt:nextCheck(now,schedule)}:null,
    serving:known?.serving??null,lastStartedAt,lastCheck,lastGoodCheck,
    waiting:waiting?{...waiting,reason:issue?.reason??null,retry}:null,alert,
    recentRuns:sorted.filter(r=>!(r.recertification&&r.public.result==='unchanged')).slice(0,20).map(r=>r.public)});
}
