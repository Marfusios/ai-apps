/**
 * The mock admin overview's automatic importer (web/mock/imports.ts, Task 26): each synthetic state
 * is a valid overview under the contract and shaped as the server sends it (worker/importer/status.ts):
 * the last *completed* check is only ever an unchanged or published run, overdue follows from it,
 * blocked daily runs carry their review's reason and file, and every time is at the scheduled 05:30
 * in Prague (summer and winter time alike), the runs newest first.
 */
import { describe, expect, it } from 'vitest';
import { AdminOverviewSchema, type AdminOverview } from '../../shared/contracts/admin.js';
import { mockAdminOverview } from '../../web/mock/admin.js';
import { MOCK_EVIDENCE_RELEASE } from '../../web/mock/evidence.js';
import { MOCK_IMPORT_STATES, parseMockImportState, type MockImportState } from '../../web/mock/imports.js';

const ADMIN = { name: 'Alex Example', email: 'alex@example.com' };
const HOUR = 3_600_000;
/** 08:15 in Prague, after the day's check. */
const NOW = new Date('2026-11-01T07:15:00.000Z');

function overview(imports: MockImportState, now = NOW): AdminOverview {
  return AdminOverviewSchema.parse(mockAdminOverview({ now, evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: ADMIN, imports }));
}

/** The time of day in Prague of an instant: "05:30". */
const prague = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

describe('the mock importer states', () => {
  it.each(MOCK_IMPORT_STATES)('%s is a valid overview, the same on every read, shaped as the server sends it', (state) => {
    const o = overview(state);
    expect(overview(state)).toEqual(o);
    const imports = o.system.imports;
    const runs = imports.recentRuns;
    expect(runs.length).toBeLessThanOrEqual(20);
    expect(runs.map((r) => r.checkedAt)).toEqual([...runs.map((r) => r.checkedAt)].sort().reverse());
    for (const r of runs) {
      expect(prague(r.checkedAt)).toBe('05:30');
      if (r.finishedAt) expect(Date.parse(r.finishedAt)).toBeGreaterThanOrEqual(Date.parse(r.checkedAt));
    }
    // The last completed check: an unchanged or published run only, the newest such run.
    if (imports.lastCheck) {
      expect(['unchanged', 'published']).toContain(imports.lastCheck.result);
      expect(imports.lastCheck).toEqual(runs.find((r) => r.result === 'unchanged' || r.result === 'published'));
    }
    // Overdue: no completed check within 36 hours while enabled.
    const age = imports.lastCheck ? NOW.getTime() - Date.parse(imports.lastCheck.checkedAt) : Infinity;
    expect(imports.overdue).toBe(imports.enabled && age > 36 * HOUR);
    // The last successful import is the newest publication, and its generation serves unless a later one does.
    if (imports.lastSuccessfulImport) expect(imports.lastSuccessfulImport.result).toBe('published');
  });

  it('healthy: checked today with no new file, nothing to review; the serving generation imported days ago; a busy night', () => {
    const { imports, dataset } = overview('healthy').system;
    expect(imports).toMatchObject({ enabled: true, attentionRequired: false, overdue: false, schedule: { localTime: '05:30', timeZone: 'Europe/Prague' } });
    expect(imports.lastCheck).toEqual(imports.recentRuns[0]);
    expect(imports.lastCheck).toMatchObject({ result: 'unchanged', reason: 'metadata_unchanged' });
    expect(imports.lastSuccessfulImport).toMatchObject({ result: 'published', generationId: dataset?.generationId });
    expect(imports.recentRuns.some((r) => r.reason === 'same_archive')).toBe(true);
    expect(imports.recentRuns.find((r) => r.reason === 'busy')).toMatchObject({ result: 'deferred', step: 'check', source: null, archiveSha256: null, costUsd: 0 });
    // The next check: tomorrow at 05:30 in Prague.
    expect(imports.schedule?.nextCheckAt).toBe('2026-11-02T04:30:00.000Z');
  });

  it('published: today’s check imported generation 8, which the dataset now serves', () => {
    const { imports, dataset } = overview('published').system;
    expect(imports.lastCheck).toMatchObject({ result: 'published', generationId: 8 });
    expect(imports.lastSuccessfulImport).toEqual(imports.lastCheck);
    expect(dataset?.generationId).toBe(8);
    expect(dataset?.snapshotDate).toBe(imports.lastCheck?.source?.advertisedAtLocal.slice(0, 10));
  });

  it('needs review: today’s run stopped at extraction (the comparison sets no step of its own); the last completed check is yesterday’s', () => {
    const { imports, dataset } = overview('needs_review').system;
    expect(imports.attentionRequired).toBe(true);
    expect(imports.recentRuns[0]).toMatchObject({ result: 'needs_review', reason: 'cohort_bounds', step: 'extract', generationId: null });
    expect(imports.recentRuns[0]?.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(imports.lastCheck).toEqual(imports.recentRuns[1]);
    expect(dataset?.generationId).toBe(7);
  });

  it('blocked: the stop three checks ago, each daily run since postponed with its reason and file, and overdue', () => {
    const { imports } = overview('blocked').system;
    const stopped = imports.recentRuns[3];
    expect(stopped).toMatchObject({ result: 'needs_review', reason: 'cohort_bounds' });
    for (const blocked of imports.recentRuns.slice(0, 3)) {
      expect(blocked).toMatchObject({ result: 'deferred', reason: 'cohort_bounds', step: 'check', source: null, archiveSha256: stopped?.archiveSha256, costUsd: stopped?.costUsd });
    }
    expect(imports).toMatchObject({ attentionRequired: true, overdue: true });
    expect(imports.lastCheck).toEqual(imports.recentRuns[4]);
  });

  it('after the switch: generation 8 serves, and the run stopped at the site checks with a probe review', () => {
    const { imports, dataset } = overview('after_switch').system;
    expect(imports.recentRuns[0]).toMatchObject({ result: 'needs_review', reason: 'probe', step: 'canary', generationId: 8 });
    expect(dataset?.generationId).toBe(8);
    expect(imports.lastSuccessfulImport?.generationId).toBe(7);
  });

  it('a restore hold and the retired source: a stop before any file, then blocked runs', () => {
    for (const [state, reason] of [
      ['restore_hold', 'restore_hold'],
      ['retired', 'source_retired'],
    ] as const) {
      const { imports } = overview(state).system;
      const stopped = imports.recentRuns.find((r) => r.result === 'needs_review');
      expect(stopped, state).toMatchObject({ reason, step: 'check', archiveSha256: null, source: null });
      expect(imports.recentRuns[0], state).toMatchObject({ result: 'deferred', reason });
      expect(imports.attentionRequired, state).toBe(true);
    }
  });

  it('unreadable: attention, overdue, and no runs or checks, as the server answers when it cannot read the status', () => {
    const { imports } = overview('unreadable').system;
    expect(imports).toMatchObject({ enabled: true, attentionRequired: true, overdue: true, lastCheck: null, lastSuccessfulImport: null, recentRuns: [] });
  });

  it('overdue: no completed check for over 36 hours, the failed and postponed runs after it listed', () => {
    const { imports } = overview('overdue').system;
    expect(imports.overdue).toBe(true);
    expect(imports.recentRuns.slice(0, 2).map((r) => [r.result, r.reason])).toEqual([
      ['failed', 'interrupted'],
      ['deferred', 'source_unavailable'],
    ]);
  });

  it('disabled: the schedule is off, with no next check and no runs', () => {
    expect(overview('disabled').system.imports).toEqual({
      enabled: false,
      schedule: { localTime: '05:30', timeZone: 'Europe/Prague', nextCheckAt: null },
      lastCheck: null,
      lastSuccessfulImport: null,
      attentionRequired: false,
      overdue: false,
      recentRuns: [],
    });
  });

  it('the checks keep 05:30 in Prague across the change to winter and to summer time', () => {
    // 25 Oct 2026: summer time ends; 28 Mar 2027 (a Sunday): it starts.
    const autumn = overview('healthy', new Date('2026-10-26T12:00:00.000Z')).system.imports;
    expect(autumn.recentRuns.slice(0, 3).map((r) => r.checkedAt.slice(0, 16))).toEqual(['2026-10-26T04:30', '2026-10-25T04:30', '2026-10-24T03:30']);
    const spring = overview('healthy', new Date('2027-03-28T02:00:00.000Z')).system.imports;
    expect(spring.schedule?.nextCheckAt).toBe('2027-03-28T03:30:00.000Z');
    expect(spring.recentRuns[0]?.checkedAt.slice(0, 16)).toBe('2027-03-27T04:30');
  });

  it('a state name that is not one of them is the healthy one', () => {
    expect(parseMockImportState('needs_review')).toBe('needs_review');
    expect([parseMockImportState(null), parseMockImportState(''), parseMockImportState('broken')]).toEqual(['healthy', 'healthy', 'healthy']);
  });
});
