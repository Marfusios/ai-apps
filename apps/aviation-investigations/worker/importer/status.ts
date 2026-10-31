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
export function localClock(at: Date, zone: string): { day: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
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
  unresolved: boolean;
}
/** Pure projection. Busy/failure rows cannot refresh lastCheck; latched review survives later checks. */
export function projectImports(
  rows: readonly StatusRow[],
  schedule: ImportSchedule | null,
  now: Date,
  unresolved = false,
): AdminImports {
  const sorted = [...rows].sort((a, b) => b.public.checkedAt.localeCompare(a.public.checkedAt));
  const lastCheck =
    sorted.find((r) => r.sourceCheckSucceeded && r.public.finishedAt !== null)?.public ?? null;
  const lastSuccess =
    sorted.find((r) => r.canaryPassed && r.public.result === 'published')?.public ?? null;
  const enabled = schedule?.enabled === true;
  return AdminImportsSchema.parse({
    enabled,
    schedule: schedule
      ? {
          localTime: schedule.localTime,
          timeZone: schedule.timeZone,
          nextCheckAt: nextCheck(now, schedule),
        }
      : null,
    lastCheck,
    lastSuccessfulImport: lastSuccess,
    attentionRequired: unresolved || sorted.some((r) => r.unresolved),
    overdue:
      enabled && (!lastCheck || now.getTime() - Date.parse(lastCheck.checkedAt) > 36 * 3_600_000),
    recentRuns: sorted.slice(0, 20).map((r) => r.public),
  });
}
