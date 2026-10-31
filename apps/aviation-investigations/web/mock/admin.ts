/**
 * The admin overview of the mock API (`GET /api/admin/overview`, contract `AdminOverviewSchema` in
 * shared/contracts/admin.ts), for the dev mock mode and the tests of the admin page. Every number
 * is synthetic and made the same way every time (from the day of the month, never at random), so
 * a page reads alike on every load: 37 accounts with made-up names at the reserved example
 * domains, 30 days of AI searches with a weekly rhythm, costs in the range a small beta spends
 * (cents a day, a few dollars a month), and the system as the mock stands in for it. The ratings
 * add the ones given to the mock's own searches. Nothing here is a real person or a real figure.
 */
import type { AdminOverview, AdminStageCost, AdminUsageDay, AdminUser } from '../../shared/contracts/admin.js';
import type { MockEvidenceConfig } from './evidence.js';
import config from './config.json' with { type: 'json' };

const DAY_MS = 86_400_000;

/** A whole number from `seed` in [min, max]: the same every time for the same seed. */
function pick(seed: number, min: number, max: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453;
  return min + Math.floor((x - Math.floor(x)) * (max - min + 1));
}

const round = (usd: number, places = 6): number => Number(usd.toFixed(places));

/** Synthetic first and last names; the e-mail addresses are at the reserved example domains. */
const FIRST = ['Sam', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Jamie', 'Avery', 'Quinn', 'Rowan', 'Skyler', 'Dakota', 'Reese', 'Emerson', 'Finley', 'Hayden', 'Kendall', 'Logan'];
const LAST = ['Rivera', 'Okafor', 'Lindqvist', 'Novak', 'Haddad', 'Moreau', 'Tanaka', 'Kowalski', 'Byrne', 'Silva', 'Petrov', 'Nguyen', 'Fischer', 'Duarte', 'Mensah', 'Larsen', 'Oyelaran', 'Varga'];
const DOMAINS = ['example.com', 'example.org', 'example.net'];

/** How many accounts the mock reports, and how many of them are new this week. */
export const MOCK_ADMIN_USERS = 37;
export const MOCK_ADMIN_NEW_USERS = 6;

export interface MockAdminOptions {
  now: Date;
  /** The ranking configuration and automatic-filter policy the mock stands in for. */
  evidence: MockEvidenceConfig;
  /** Ratings the mock's own searches were given (added to the synthetic totals). */
  ratings: { useful: number; notUseful: number };
  /** The signed-in mock account, which is an admin. */
  admin: { name: string; email: string };
}

function users(now: number, admin: MockAdminOptions['admin']): AdminUser[] {
  const out: (AdminUser & { activeAt: number })[] = [];
  for (let i = 0; i < MOCK_ADMIN_USERS; i++) {
    const isSelf = i === 0;
    const isSecondAdmin = i === 1;
    // Every pair of names once: the second time round the first names, the last names move on by seven.
    const first = FIRST[i % FIRST.length] as string;
    const last = LAST[(i + 7 * Math.floor(i / FIRST.length)) % LAST.length] as string;
    const name = isSelf ? admin.name : isSecondAdmin ? 'Robin Example' : `${first} ${last}`;
    const email = isSelf ? admin.email : isSecondAdmin ? 'robin@example.com' : `${first}.${last}@${DOMAINS[i % DOMAINS.length]}`.toLowerCase();
    // The first six joined this week; the rest over the two months before.
    const joinedDaysAgo = i < MOCK_ADMIN_NEW_USERS ? 1 + (i % 6) : 8 + pick(i, 0, 55);
    const createdAt = now - joinedDaysAgo * DAY_MS - pick(i + 100, 0, 23) * 3_600_000;
    // Some accounts have no session left (signed out, or it expired), and some never asked the AI.
    const signedInHoursAgo = pick(i + 200, 0, 9) === 0 ? null : pick(i + 300, 0, 24 * Math.min(joinedDaysAgo, 20));
    const lastSignInAt = signedInHoursAgo === null ? null : Math.max(createdAt, now - signedInHoursAgo * 3_600_000 - pick(i + 400, 0, 59) * 60_000);
    const searcher = isSelf || isSecondAdmin || pick(i + 500, 0, 5) !== 0;
    const days90 = searcher ? pick(i + 600, 1, 120) : 0;
    const days30 = Math.min(days90, searcher ? pick(i + 700, 0, 60) : 0);
    const days7 = Math.min(days30, searcher ? pick(i + 800, 0, 25) : 0);
    const today = Math.min(days7, searcher ? pick(i + 900, 0, 6) : 0);
    const searchedHoursAgo = today > 0 ? pick(i + 1000, 0, 10) : days7 > 0 ? 24 + pick(i + 1100, 0, 140) : days30 > 0 ? 24 * 8 + pick(i + 1200, 0, 500) : days90 > 0 ? 24 * 31 + pick(i + 1300, 0, 1400) : null;
    const lastAiSearchAt = searchedHoursAgo === null ? null : Math.max(createdAt, now - searchedHoursAgo * 3_600_000 - pick(i + 1400, 0, 59) * 60_000);
    out.push({
      name,
      email,
      createdAt: new Date(createdAt).toISOString(),
      lastSignInAt: lastSignInAt === null ? null : new Date(lastSignInAt).toISOString(),
      lastAiSearchAt: lastAiSearchAt === null ? null : new Date(lastAiSearchAt).toISOString(),
      aiSearches: { today, last7Days: days7, last30Days: days30, last90Days: days90 },
      isAdmin: isSelf || isSecondAdmin,
      activeAt: Math.max(createdAt, lastSignInAt ?? 0, lastAiSearchAt ?? 0),
    });
  }
  // Most recently active first.
  out.sort((a, b) => b.activeAt - a.activeAt);
  return out.map(({ activeAt: _activeAt, ...user }) => user);
}

/** What an indexing run spent on a UTC day (`YYYY-MM-DD`): on the 1st and the 17th of each month. */
function indexingOn(day: string): number {
  return day.endsWith('-01') || day.endsWith('-17') ? 0.92 : 0;
}

/** The last 30 UTC days, oldest first, today included. */
function days(now: Date): AdminUsageDay[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: AdminUsageDay[] = [];
  for (let back = 29; back >= 0; back--) {
    const at = new Date(today - back * DAY_MS);
    const seed = at.getUTCFullYear() * 400 + at.getUTCMonth() * 32 + at.getUTCDate();
    // Busier on weekdays, and growing a little over the month.
    const weekday = at.getUTCDay() !== 0 && at.getUTCDay() !== 6;
    const growth = 1 + (29 - back) / 40;
    const trialSearches = Math.round(pick(seed, weekday ? 14 : 6, weekday ? 34 : 18) * growth);
    const accountSearches = Math.round(pick(seed + 1, weekday ? 8 : 3, weekday ? 22 : 11) * growth);
    const freeUndos = pick(seed + 2, 0, 3);
    const failedSearches = pick(seed + 3, 0, 7) === 0 ? pick(seed + 4, 1, 2) : 0;
    // About $0.0086 a search, plus an indexing run on two days of the month.
    const day = at.toISOString().slice(0, 10);
    out.push({ day, trialSearches, accountSearches, freeUndos, failedSearches, usd: round((trialSearches + accountSearches) * 0.0086 + indexingOn(day)) });
  }
  return out;
}

/** This month's spend by pipeline stage, provider and model, most expensive first. */
function stages(interactive: number, indexing: number, evaluation: number, searches: number): AdminStageCost[] {
  const rows: AdminStageCost[] = [
    { stage: 'rerank', provider: 'anthropic', model: 'claude-haiku-5-5', calls: searches, usd: round(interactive * 0.62) },
    { stage: 'scope', provider: 'anthropic', model: 'claude-haiku-5-5', calls: Math.round(searches * 0.86), usd: round(interactive * 0.33) },
    { stage: 'embed', provider: 'openai', model: 'text-embedding-3-small', calls: searches, usd: round(interactive * 0.04) },
    { stage: 'uncertain', provider: 'anthropic', model: 'claude-haiku-5-5', calls: 5, usd: round(interactive * 0.01) },
    { stage: 'index', provider: 'openai', model: 'text-embedding-3-small', calls: 2, usd: round(indexing) },
    { stage: 'judge', provider: 'anthropic', model: 'claude-sonnet-5-5', calls: 40, usd: round(evaluation) },
  ];
  return rows.filter((r) => r.usd > 0).sort((a, b) => b.usd - a.usd);
}

/** `GET /api/admin/overview` for the signed-in admin of the mock API. */
export function mockAdminOverview({ now, evidence, ratings, admin }: MockAdminOptions): AdminOverview {
  const list = users(now.getTime(), admin);
  const usage = days(now);
  const month = now.toISOString().slice(0, 7);
  const thisMonth = usage.filter((d) => d.day.startsWith(month));
  const searches = thisMonth.reduce((n, d) => n + d.trialSearches + d.accountSearches, 0);
  const monthToDate = round(thisMonth.reduce((n, d) => n + d.usd, 0));
  const indexing = round(thisMonth.reduce((n, d) => n + indexingOn(d.day), 0));
  const evaluation = 0.37;
  const interactive = round(Math.max(0, monthToDate - indexing));
  const total = round(monthToDate + evaluation);
  const today = usage[usage.length - 1] as AdminUsageDay;
  const startedAt = new Date(now.getTime() - (3 * 24 + 4) * 3_600_000 - 17 * 60_000);
  return {
    generatedAt: now.toISOString(),
    users: { total: MOCK_ADMIN_USERS, newLast7Days: MOCK_ADMIN_NEW_USERS, list },
    usage: {
      days: usage,
      activeTrialsLast30Days: 186,
      activeAccountsLast30Days: 24,
      feedback: {
        useful: 41 + ratings.useful,
        notUseful: 13 + ratings.notUseful,
        usefulLast30Days: 17 + ratings.useful,
        notUsefulLast30Days: 6 + ratings.notUseful,
      },
    },
    costs: {
      today: today.usd,
      // The day's spend without its indexing run: what the daily interactive budget caps.
      interactiveToday: round(Math.max(0, today.usd - indexingOn(today.day))),
      monthToDate: total,
      previousMonth: 9.62,
      byCategory: { interactive, indexing, evaluation },
      byStage: stages(interactive, indexing, evaluation, searches),
      perSearch: { searches, meanUsd: searches > 0 ? round(interactive / searches) : null },
      uncertainUsd: 0.0125,
      budgets: { monthly: 100, interactiveMonthly: 80, interactiveDaily: 3, ingestionMonthly: 20 },
    },
    system: {
      appVersion: '2026.10.31-mock',
      appEnv: 'dev',
      startedAt: startedAt.toISOString(),
      ranking: evidence.ranking,
      automaticFilters: evidence.autoFilters,
      ai: { enabled: true, anonymousEnabled: true, accountCheck: 'suspicious' },
      tracing: { enabled: true, lastExportOkAt: new Date(now.getTime() - 42_000).toISOString(), failedExports: 0 },
      dataset: {
        generationId: 7,
        snapshotDate: config.snapshotDate,
        loadedAt: '2026-10-17T03:12:44.000Z',
        publishedAt: '2026-10-17T03:41:09.000Z',
        cases: config.coverage.defaultCohort + config.coverage.otherRecords,
        eligibleCases: config.coverage.defaultCohort,
      },
      nextAutomaticImport: null,
    },
  };
}
