import { expect, it } from 'vitest';
import {
  projectImports,
  localClock,
  type ImportHealth,
  type StatusRow,
} from '../../worker/importer/status.js';
import { AdminImportRunSchema } from '../../shared/contracts/admin.js';
const now = new Date('2026-11-03T12:00:00Z');
const schedule = { enabled: true, localTime: '05:30', timeZone: 'Europe/Prague' };
const row: StatusRow = {
  public: AdminImportRunSchema.parse({
    checkedAt: '2026-11-03T04:30:00Z',
    finishedAt: '2026-11-03T04:31:00Z',
    mode: 'automatic',
    source: null,
    archiveSha256: null,
    generationId: null,
    step: 'check',
    result: 'deferred',
    reason: 'source_unavailable',
    costUsd: 0,
  }),
  canaryPassed: false,
  sourceCheckSucceeded: false,
};
function health(n = 0): ImportHealth {
  return {
    automaticSince: '2026-11-01T12:00:00Z',
    restoreHeld: false,
    switchHeld: false,
    switchHoldReason: 'alias_unknown',
    hold: null,
    fixSince: null,
    temporaryDays: n,
    delayedSince: '2026-11-01T04:30:00Z',
    serving: null,
    lastGood: null,
    waiting: null,
    issue: {
      reason: 'source_unavailable',
      fixed: false,
      since: '2026-11-01T04:30:00Z',
      origin: 'dev',
      siteState: 'unchanged',
      postSuccess: false,
      suppressesFile: false,
      preflight: false,
      details: row.public,
      originRunId: null,
    },
  };
}
it.each([
  [0, 'working'],
  [1, 'working'],
  [2, 'working'],
  [3, 'delayed'],
  [6, 'delayed'],
  [7, 'fix'],
] as const)('%i distinct failed dates => %s', (n, status) => {
  const r = projectImports([row], schedule, now, health(n));
  expect(r.status).toBe(status);
  expect(r.lastStartedAt).toBe(row.public.checkedAt);
});
it('fresh starts prevent overdue even when the last run failed; 36h is measured from start', () => {
  const old = {
    ...row,
    public: {
      ...row.public,
      checkedAt: '2026-11-02T00:00:00Z',
      finishedAt: '2026-11-03T11:59:00Z',
    },
  };
  expect(projectImports([old], schedule, now, health()).alert).toBeNull();
  expect(projectImports([old], schedule, new Date(+now + 1), health()).alert?.cause).toBe(
    'overdue',
  );
  expect(projectImports([], schedule, now, health()).alert?.cause).toBe('overdue');
});
it('disabled means Off, without any alert, including unreadable/restore/overdue states', () => {
  for (const h of [true, { ...health(7), restoreHeld: true, switchHeld: true }])
    expect(projectImports([], { ...schedule, enabled: false }, now, h)).toMatchObject({
      status: 'off',
      alert: null,
      schedule: { nextCheckAt: null },
    });
});
it.each([3, 7])(
  'monthly budget follows the same %i-day rule and resumes on the first',
  (n) => {
    const h = health(n);
    h.issue!.reason = 'monthly_budget';
    const r = projectImports([row], schedule, now, h);
    expect(r.status).toBe(n === 3 ? 'delayed' : 'fix');
    expect(r.alert?.retryAt).toBe('2026-12-01T00:00:00.000Z');
    expect(r.alert?.nextAction).toBe('daily');
  },
);
it('a fixed incident outlives suppressed rows and recertification without changing its original cause', () => {
  const h = health();
  h.issue = { ...h.issue!, fixed: true, suppressesFile: true, reason: 'schema' };
  const rows = Array.from({ length: 25 }, (_, i) => ({
    ...row,
    recertification: i === 0,
    public: {
      ...row.public,
      suppressed: true,
      result: 'waiting' as const,
      checkedAt: new Date(+now - i * 60_000).toISOString(),
    },
  }));
  expect(projectImports(rows, schedule, now, h)).toMatchObject({
    status: 'fix',
    alert: { cause: 'schema', since: h.issue.since, nextAction: 'new_file_or_release' },
    recentRuns: expect.any(Array),
  });
  expect(projectImports(rows, schedule, now, h).recentRuns).toHaveLength(20);
});
it('inherited dev causes and verified restoration are retained; live shrink identifies dev having advanced', () => {
  const h = health();
  h.issue = { ...h.issue!, fixed: true, reason: 'site_check', siteState: 'restored' };
  expect(projectImports([row], schedule, now, h).alert).toMatchObject({
    origin: 'dev',
    siteState: 'restored',
    cause: 'site_check',
  });
  h.issue = { ...h.issue!, reason: 'shrunk', origin: 'live' };
  expect(projectImports([row], schedule, now, h).alert?.devAdvanced).toBe(true);
});
it('post-success cleanup is temporary, storage is a fix, and unknown switch stays uncertain', () => {
  const h = health(3);
  h.issue = { ...h.issue!, reason: 'cleanup', postSuccess: true };
  expect(projectImports([row], schedule, now, h).status).toBe('delayed');
  h.issue = { ...h.issue!, reason: 'storage', fixed: true };
  expect(projectImports([row], schedule, now, h).alert).toMatchObject({
    level: 'fix',
    postSuccess: true,
    nextAction: 'daily',
  });
  h.switchHeld = true;
  expect(projectImports([row], schedule, now, h).alert?.siteState).toBe('uncertain');
});
it('unknown status is a fixed category, not a successful check', () =>
  expect(projectImports([], schedule, now, true)).toMatchObject({
    status: 'fix',
    alert: { cause: 'status_unavailable' },
    lastGoodCheck: null,
  }));
it('failure dates use the schedule zone across midnight and both DST transitions', () => {
  expect(localClock(new Date('2026-11-02T23:30:00Z'), schedule.timeZone).day).toBe(
    '2026-11-03',
  );
  expect(localClock(new Date('2026-10-25T00:30:00Z'), schedule.timeZone).day).toBe(
    localClock(new Date('2026-10-25T01:30:00Z'), schedule.timeZone).day,
  );
  expect(localClock(new Date('2026-03-29T22:30:00Z'), schedule.timeZone).day).toBe(
    '2026-03-30',
  );
});

it.each(['issue', 'restore', 'switch'] as const)(
  'overdue takes priority over %s and preserves the earlier failure',
  (kind) => {
    const h = health();
    h.issue = {
      ...h.issue!,
      fixed: true,
      reason: 'schema',
      details: { ...row.public, reason: 'schema' },
    };
    h.waiting = {
      source: { advertisedAtLocal: '2026-11-01T00:00:00', bytes: 100 },
      since: h.issue.since,
      reason: 'schema',
      retry: 'new_file_or_release',
    };
    h.restoreHeld = kind === 'restore';
    h.switchHeld = kind === 'switch';
    const old = {
      ...row,
      public: { ...row.public, checkedAt: new Date(+now - 37 * 3600000).toISOString() },
    };
    expect(projectImports([old], schedule, now, h)).toMatchObject({
      alert: {
        cause: 'overdue',
        since: old.public.checkedAt,
        details: { reason: 'schema' },
      },
      waiting: { reason: 'schema' },
    });
  },
);
it('unreadable and holds without an incident do not invent a changing since date', () => {
  for (const time of [now, new Date(+now + 60000)]) {
    expect(projectImports([], schedule, time, true).alert?.since).toBeNull();
    expect(
      projectImports([row], schedule, time, {
        ...health(),
        issue: null,
        restoreHeld: true,
      }).alert?.since,
    ).toBeNull();
  }
});
it('a delay starts with the earliest unresolved temporary failure, not its latest details', () => {
  const h = health(3);
  h.issue!.since = row.public.checkedAt;
  expect(projectImports([row], schedule, now, h).alert?.since).toBe(h.delayedSince);
});

it('fixed Since uses the earliest same-cause date, and a hold reason beats an unrelated newest issue', () => {
  const h = health();
  h.fixSince = '2026-10-20T04:30:00Z';
  h.issue = { ...h.issue!, fixed: true, reason: 'storage' };
  expect(projectImports([row], schedule, now, h).alert?.since).toBe(h.fixSince);
  h.switchHeld = true;
  h.switchHoldReason = 'rollback_failed';
  expect(projectImports([row], schedule, now, h).alert).toMatchObject({
    cause: 'rollback_failed',
    holds: ['rollback_failed'],
    details: null,
    since: null,
  });
});

it('a check-step integrity failure is not classified as a serving-data check without provenance', () => {
  const h = health();
  h.issue = {
    ...h.issue!,
    fixed: true,
    reason: 'integrity',
    details: { ...row.public, reason: 'integrity', step: 'check' },
  };
  expect(projectImports([row], schedule, now, h).alert).toMatchObject({
    cause: 'integrity',
    servingChecks: false,
  });
});

it.each(['check', 'cleanup', 'complete'] as const)(
  'an inherited %s incident cannot supply a file-failure reason',
  (step) => {
    const h = health();
    h.issue = {
      ...h.issue!,
      fixed: true,
      reason: 'configuration',
      originRunId: '10000000-0000-4000-8000-000000000001',
      details: {
        ...row.public,
        step,
        source: { advertisedAtLocal: '2026-11-01T07:30:00', bytes: 100 },
        archiveSha256: 'a'.repeat(64),
      },
    };
    expect(projectImports([row], schedule, now, h).waiting).toMatchObject({
      reason: null,
    });
  },
);
