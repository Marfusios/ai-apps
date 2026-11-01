/**
 * The mock admin overview's automatic importer (web/mock/imports.ts, Task 26): each of its five
 * synthetic states is a valid overview under the contract, consistent with itself (the dataset it
 * serves, the last check, the 36-hour rule), with times at the scheduled 05:30 in Prague (summer
 * and winter time alike) and runs newest first.
 */
import { describe, expect, it } from 'vitest';
import { AdminOverviewSchema, type AdminOverview } from '../../shared/contracts/admin.js';
import { mockAdminOverview } from '../../web/mock/admin.js';
import { MOCK_EVIDENCE_RELEASE } from '../../web/mock/evidence.js';
import { MOCK_IMPORT_STATES, parseMockImportState, type MockImportState } from '../../web/mock/imports.js';

const ADMIN = { name: 'Alex Example', email: 'alex@example.com' };
const HOUR = 3_600_000;

function overview(imports: MockImportState, now = new Date('2026-11-01T17:05:00.000Z')): AdminOverview {
  return AdminOverviewSchema.parse(mockAdminOverview({ now, evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: ADMIN, imports }));
}

/** The time of day in Prague of an instant: "05:30". */
const prague = (iso: string): string =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

describe('the mock importer states', () => {
  it.each(MOCK_IMPORT_STATES)('%s is a valid overview, the same on every read, its runs newest first', (state) => {
    const o = overview(state);
    expect(overview(state)).toEqual(o);
    const runs = o.system.imports.recentRuns;
    expect(runs.length).toBeLessThanOrEqual(20);
    expect(runs.map((r) => r.checkedAt)).toEqual([...runs.map((r) => r.checkedAt)].sort().reverse());
    for (const r of runs) {
      expect(prague(r.checkedAt)).toBe('05:30');
      if (r.finishedAt) expect(Date.parse(r.finishedAt)).toBeGreaterThanOrEqual(Date.parse(r.checkedAt));
    }
  });

  it('healthy: checked today with no new file, not overdue, nothing to review; the serving generation imported days ago', () => {
    const { imports, dataset } = overview('healthy').system;
    const now = Date.parse('2026-11-01T17:05:00.000Z');
    expect(imports).toMatchObject({ enabled: true, attentionRequired: false, overdue: false, schedule: { localTime: '05:30', timeZone: 'Europe/Prague' } });
    expect(imports.lastCheck).toMatchObject({ result: 'unchanged', reason: 'metadata_unchanged' });
    expect(now - Date.parse(imports.lastCheck?.checkedAt ?? '')).toBeLessThan(36 * HOUR);
    expect(imports.lastSuccessfulImport).toMatchObject({ result: 'published', generationId: dataset?.generationId });
    expect(now - Date.parse(imports.lastSuccessfulImport?.checkedAt ?? '')).toBeGreaterThan(3 * 24 * HOUR);
    // A re-download that found the same file, and a night postponed by a backup, among the runs.
    expect(imports.recentRuns.some((r) => r.reason === 'same_archive')).toBe(true);
    expect(imports.recentRuns.some((r) => r.result === 'deferred' && r.reason === 'busy')).toBe(true);
    // The next check: tomorrow at 05:30 in Prague.
    expect(imports.schedule?.nextCheckAt).toBe('2026-11-02T04:30:00.000Z');
  });

  it('published: today’s check imported generation 8, which the dataset now serves', () => {
    const { imports, dataset } = overview('published').system;
    expect(imports.lastCheck).toMatchObject({ result: 'published', generationId: 8 });
    expect(imports.lastSuccessfulImport).toEqual(imports.lastCheck);
    expect(dataset?.generationId).toBe(8);
    expect(dataset?.snapshotDate).toBe(imports.lastCheck?.source?.advertisedAtLocal.slice(0, 10));
    expect(imports.lastCheck?.costUsd).toBeGreaterThan(0);
    expect(imports.lastCheck?.costUsd).toBeLessThanOrEqual(0.5);
  });

  it('needs review: today’s run stopped at verification for review, so attention is required; generation 7 still serves', () => {
    const { imports, dataset } = overview('needs_review').system;
    expect(imports.attentionRequired).toBe(true);
    expect(imports.recentRuns[0]).toMatchObject({ result: 'needs_review', reason: 'cohort_bounds', step: 'verify', generationId: null });
    expect(dataset?.generationId).toBe(7);
  });

  it('overdue: no successful check for over 36 hours, the failed and postponed ones after it listed', () => {
    const { imports } = overview('overdue').system;
    const now = Date.parse('2026-11-01T17:05:00.000Z');
    expect(imports.overdue).toBe(true);
    expect(now - Date.parse(imports.lastCheck?.checkedAt ?? '')).toBeGreaterThan(36 * HOUR);
    expect(imports.recentRuns.slice(0, 2).map((r) => [r.result, r.reason])).toEqual([
      ['failed', 'interrupted'],
      ['deferred', 'source_unavailable'],
    ]);
  });

  it('disabled: the schedule is off, with no next check and no runs', () => {
    const { imports } = overview('disabled').system;
    expect(imports).toEqual({
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

  it('a state name that is not one of the five is the healthy one', () => {
    expect(parseMockImportState('needs_review')).toBe('needs_review');
    expect([parseMockImportState(null), parseMockImportState(''), parseMockImportState('broken')]).toEqual(['healthy', 'healthy', 'healthy']);
  });
});
