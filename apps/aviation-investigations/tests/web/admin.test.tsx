/**
 * The admin page (UI_DESIGN §4.12, Task 25): the header links it only for an account `/api/account`
 * says is an admin (`isAdmin`); `/admin` is the ordinary "not found" page for everyone else, signed
 * out or not, and when the API answers 404; for an admin, everything from `GET /api/admin/overview`
 * (contract `AdminOverviewSchema`): users, usage with its chart and table, costs with the budgets,
 * and the system in plain words, times in the viewer's own zone, named. Private and not indexed.
 * Shapes the mock never makes (no dataset, a capped list, an import set up) come from synthetic
 * overviews, each validated with the contract first.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminOverviewSchema, type AdminOverview } from '../../shared/contracts/admin';
import { mockAdminOverview } from '../../web/mock/admin';
import { MOCK_EVIDENCE_RELEASE } from '../../web/mock/evidence';
import {
  automaticFiltersInWords,
  durationInWords,
  formatDateTime,
  formatDay,
  formatShare,
  formatUsd,
  formatUtcDay,
  rankingInWords,
  viewerTimeZone,
} from '../../web/src/features/admin/format';
import { USAGE_CHART_TITLE, dayInWords } from '../../web/src/features/admin/UsageChart';
import { MOCK_USER, createHandlers, type HandlerOptions } from '../../web/src/mocks/handlers';
import { ADMIN_COPY } from '../../web/src/pages/Admin';
import { renderApp, setupMockApi } from './render-app';

const server = setupMockApi();
const SLOW = { timeout: 5000 };
const NOT_FOUND_TITLE = 'There is no page here.';

afterEach(() => {
  server.events.removeAllListeners();
});

/** Signed in as the mock's account, an admin unless `admin: false`. */
function signedIn(options: HandlerOptions = {}): void {
  window.sessionStorage.setItem('casebook-mock-account', JSON.stringify({ signedIn: true, registered: true }));
  server.use(...createHandlers({ googleEnabled: true, admin: true, evidence: MOCK_EVIDENCE_RELEASE, ...options }));
}

/** Every read of the admin overview. */
function recordOverviewReads(): string[] {
  const reads: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === '/api/admin/overview') reads.push(request.method);
  });
  return reads;
}

/** An overview served instead of the mock's, validated with the contract first. */
function serve(change: (o: AdminOverview) => AdminOverview): AdminOverview {
  const base = mockAdminOverview({ now: new Date(), evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: MOCK_USER });
  const overview = AdminOverviewSchema.parse(change(base));
  server.use(http.get('*/api/admin/overview', () => HttpResponse.json(overview, { headers: { 'cache-control': 'private, no-store' } })));
  return overview;
}

async function openAdmin(): Promise<void> {
  renderApp('/admin');
  await screen.findByRole('heading', { level: 1, name: ADMIN_COPY.title }, SLOW);
  await screen.findByRole('region', { name: ADMIN_COPY.users }, SLOW);
}

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

describe('the Admin link', { timeout: 20_000 }, () => {
  it('an admin account gets “Admin” in the header’s navigation and in the phone menu', async () => {
    signedIn();
    renderApp('/');
    const banner = screen.getByRole('banner');
    // The desktop navigation lists it after Dashboard.
    await waitFor(() => expect(within(banner).getAllByRole('link', { name: 'Admin' })).toHaveLength(1), SLOW);
    const [main] = within(banner).getAllByRole('navigation', { name: 'Main' });
    expect(within(main as HTMLElement).getAllByRole('link').map((a) => a.textContent)).toEqual(['Explore', 'Dashboard', 'Admin']);
    // The phone menu, once opened, lists it too.
    fireEvent.click(within(banner).getByRole('button', { name: 'Menu' }));
    const links = within(banner).getAllByRole('link', { name: 'Admin' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute('href')).toBe('/admin');
  });

  it.each([
    ['an account that is not an admin', () => signedIn({ admin: false })],
    ['a signed-out visitor', () => server.use(...createHandlers({ googleEnabled: true, admin: true }))],
    ['a site without sign-in', () => server.use(...createHandlers({ admin: true }))],
  ])('%s gets no Admin link', async (_name, setUp) => {
    setUp();
    renderApp('/');
    const banner = screen.getByRole('banner');
    await waitFor(() => expect(within(banner).getAllByRole('link', { name: 'Explore' }).length).toBeGreaterThan(0));
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(within(banner).queryByRole('link', { name: 'Admin' })).toBeNull();
  });
});

describe('/admin for anyone but an admin is the ordinary “not found” page', () => {
  it.each([
    ['signed out', () => server.use(...createHandlers({ googleEnabled: true, admin: true }))],
    ['signed in, not an admin', () => signedIn({ admin: false })],
    ['a site without sign-in', () => server.use(...createHandlers({ admin: true }))],
  ])('%s: “There is no page here.”, and the overview is never asked for', async (_name, setUp) => {
    setUp();
    const reads = recordOverviewReads();
    renderApp('/admin');
    expect(await screen.findByRole('heading', { level: 1, name: NOT_FOUND_TITLE }, SLOW)).toBeTruthy();
    await waitFor(() => expect(document.title).toBe('Page not found · AirCase'));
    expect(reads).toEqual([]);
  });

  it('an admin whom the API answers 404 (the list changed) gets the same page', async () => {
    signedIn();
    server.use(http.get('*/api/admin/overview', () => HttpResponse.json({ error: 'not_found', message: 'Not found.' }, { status: 404 })));
    renderApp('/admin');
    expect(await screen.findByRole('heading', { level: 1, name: NOT_FOUND_TITLE }, SLOW)).toBeTruthy();
  });

  it('an account response without `isAdmin` is not an admin', async () => {
    signedIn();
    server.use(http.get('*/api/account', () => HttpResponse.json({ signedIn: true, user: { ...MOCK_USER } })));
    renderApp('/admin');
    expect(await screen.findByRole('heading', { level: 1, name: NOT_FOUND_TITLE }, SLOW)).toBeTruthy();
  });
});

describe('the admin page', { timeout: 20_000 }, () => {
  it('is private and not indexed, its figures dated, the viewer’s time zone named, with a way to each section', async () => {
    signedIn();
    await openAdmin();
    await waitFor(() => expect(document.title).toBe('Admin · AirCase'));
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow');
    const asOf = document.querySelector('[data-as-of]')?.textContent ?? '';
    expect(asOf).toMatch(/^Figures as of \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}\. Times are in your time zone, /);
    expect(asOf).toContain(viewerTimeZone());
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Users', 'Usage', 'Costs', 'System']);
    fireEvent.click(within(nav).getByRole('link', { name: 'Costs' }));
    expect(document.activeElement?.textContent).toBe('Costs');
  });

  it('users: the totals, then every account most recently active first, with its admin tag, dates and searches over four windows', async () => {
    signedIn();
    await openAdmin();
    const users = region(ADMIN_COPY.users);
    const overview = mockAdminOverview({ now: new Date(), evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: MOCK_USER });
    expect(users.querySelector('[data-stat="Accounts"] dd')?.textContent).toBe('37');
    expect(users.querySelector('[data-stat="New in the last 7 days"] dd')?.textContent).toBe('6');
    const table = within(users).getByRole('table', { name: 'Accounts, most recently active first' });
    const heads = within(table).getAllByRole('columnheader').map((th) => th.textContent);
    expect(heads).toEqual(['Name', 'E-mail', 'Joined', 'Last sign-in', 'Last AI search', 'AI searches', 'Today', '7 days', '30 days', '90 days']);
    const rows = within(table).getAllByRole('row').slice(2);
    expect(rows).toHaveLength(overview.users.list.length);
    const first = overview.users.list[0] as AdminOverview['users']['list'][number];
    expect(within(rows[0] as HTMLElement).getByRole('rowheader').textContent).toBe(first.name + (first.isAdmin ? 'Admin' : ''));
    const cells = within(rows[0] as HTMLElement).getAllByRole('cell').map((c) => c.textContent);
    expect(cells.slice(0, 2)).toEqual([first.email, formatDay(first.createdAt, viewerTimeZone())]);
    expect(cells.slice(4)).toEqual([first.aiSearches.today, first.aiSearches.last7Days, first.aiSearches.last30Days, first.aiSearches.last90Days].map(String));
    // The admins carry a tag; a time that is not there is a dash, said as such.
    expect(within(table).getAllByText('Admin')).toHaveLength(2);
    const noSession = overview.users.list.findIndex((u) => u.lastSignInAt === null);
    expect(within(rows[noSession] as HTMLElement).getAllByRole('cell')[2]?.textContent).toBe('—None');
    // On a phone the same accounts are a list of blocks.
    const list = within(users).getByRole('list', { name: 'Accounts, most recently active first' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(overview.users.list.length);
    expect(within(list).getAllByRole('listitem')[0]?.textContent).toContain(`${first.aiSearches.last90Days} in 90 days`);
  });

  it('usage: the 30-day figures, a chart of small multiples with its table, a day read by keyboard, and the ratings', async () => {
    signedIn();
    await openAdmin();
    const usage = region(ADMIN_COPY.usage);
    const overview = mockAdminOverview({ now: new Date(), evidence: MOCK_EVIDENCE_RELEASE, ratings: { useful: 0, notUseful: 0 }, admin: MOCK_USER });
    const sum = (key: 'trialSearches' | 'accountSearches' | 'freeUndos' | 'failedSearches') => overview.usage.days.reduce((n, d) => n + d[key], 0);
    expect(usage.querySelector('[data-stat="AI searches"] dd')?.textContent).toBe((sum('trialSearches') + sum('accountSearches')).toLocaleString('en-US'));
    expect(usage.querySelector('[data-stat="Active trials"] dd')?.textContent).toBe('186');
    expect(usage.querySelector('[data-stat="Active accounts"] dd')?.textContent).toBe('24');
    expect(usage.querySelector('[data-stat="Free undos"] dd')?.textContent).toBe(String(sum('freeUndos')));
    expect(usage.querySelector('[data-stat="Failed searches"] dd')?.textContent).toBe(String(sum('failedSearches')));
    // Four rows, each named, with its total; the chart is an image to screen readers, summed up in its caption.
    expect([...usage.querySelectorAll('[data-usage-row]')].map((g) => g.getAttribute('data-usage-row'))).toEqual(['trialSearches', 'accountSearches', 'freeUndos', 'failedSearches']);
    expect(usage.querySelector('figcaption')?.textContent).toContain(`${sum('trialSearches').toLocaleString('en-US')} trial searches`);
    // The table: hidden until asked for, newest day first.
    const toggle = within(usage).getByRole('button', { name: 'Show the figures' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const table = within(usage).getByRole('table', { name: USAGE_CHART_TITLE });
    const today = overview.usage.days.at(-1) as AdminOverview['usage']['days'][number];
    expect(within(table).getAllByRole('row')[1]?.textContent).toContain(formatUtcDay(today.day));
    expect(within(table).getAllByRole('row')).toHaveLength(31);
    // The arrow keys read the days, one at a time, aloud too.
    const plot = within(usage).getByRole('group', { name: new RegExp(`^${USAGE_CHART_TITLE}`) });
    act(() => plot.focus());
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(usage.querySelector('[data-usage-tooltip]')?.textContent).toContain(formatUtcDay(today.day));
    expect(usage.querySelector('[aria-live="polite"]')?.textContent).toBe(dayInWords(today));
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(usage.querySelector('[data-usage-tooltip]')?.textContent).toContain(formatUtcDay((overview.usage.days[0] as typeof today).day));
    // The ratings, all time and over 30 days.
    const ratings = within(usage).getByRole('table', { name: 'Search ratings' });
    expect(within(ratings).getAllByRole('row').map((r) => r.textContent)).toEqual(['All timeLast 30 days', 'Useful4117', 'Not useful136', 'Rated useful76%74%']);
  });

  it('costs: today, the month and the last, per search, uncertain charges, each budget with how much is used, by category and by stage', async () => {
    signedIn();
    // Today also had an indexing run: the daily interactive cap reads the interactive part only.
    const overview = serve((o) => ({ ...o, costs: { ...o.costs, today: o.costs.interactiveToday + 0.92 } }));
    expect(overview.costs.interactiveToday).toBeLessThan(overview.costs.today);
    await openAdmin();
    const costs = region(ADMIN_COPY.costs);
    expect(costs.querySelector('[data-stat="Today"] dd')?.textContent).toBe(formatUsd(overview.costs.today));
    expect(costs.querySelector('[data-stat="This month"] dd')?.textContent).toBe(formatUsd(overview.costs.monthToDate));
    expect(costs.querySelector('[data-stat="Last month"] dd')?.textContent).toBe('$9.62');
    expect(costs.querySelector('[data-stat="Per AI search"] dd')?.textContent).toBe(formatUsd(overview.costs.perSearch.meanUsd ?? 0));
    expect(costs.querySelector('[data-stat="Uncertain charges"] dd')?.textContent).toBe('$0.0125');
    const meters = within(costs).getAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual(['All AI spend, this month', 'Interactive, this month', 'Interactive, today', 'Indexing and evaluation, this month']);
    expect(meters[0]?.getAttribute('aria-valuetext')).toBe(`${formatUsd(overview.costs.monthToDate)} of $100.00 · ${formatShare(overview.costs.monthToDate, 100)}`);
    expect(meters[2]?.getAttribute('aria-valuemax')).toBe('3');
    // The daily cap is set against today's interactive spend, not all of today's.
    expect(meters[2]?.getAttribute('aria-valuetext')).toBe(`${formatUsd(overview.costs.interactiveToday)} of $3.00 · ${formatShare(overview.costs.interactiveToday, 3)}`);
    expect(costs.textContent).not.toContain('all of today’s spend');
    const categories = within(costs).getByRole('list', { name: 'By category, this month' });
    expect(within(categories).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      `Interactive (AI searches)${formatUsd(overview.costs.byCategory.interactive)}`,
      `Indexing${formatUsd(overview.costs.byCategory.indexing)}`,
      `Evaluation${formatUsd(overview.costs.byCategory.evaluation)}`,
    ]);
    const stages = within(costs).getByRole('table', { name: /by stage, provider and model/ });
    const first = overview.costs.byStage[0] as AdminOverview['costs']['byStage'][number];
    expect(within(stages).getAllByRole('row')[1]?.textContent).toBe(`Ordering rerank${first.provider} · ${first.model}${first.calls.toLocaleString('en-US')}${formatUsd(first.usd)}`);
  });

  it('system: the app, the AI search in plain words with each identifier, tracing, the dataset, and an import not set up yet', async () => {
    signedIn();
    const overview = serve((o) => o);
    await openAdmin();
    const system = region(ADMIN_COPY.system);
    const fact = (label: string): string => system.querySelector(`[data-fact="${label}"] dd`)?.textContent ?? '';
    expect(fact('Version')).toBe('2026.10.31-mock');
    expect(fact('Environment')).toBe('Dev');
    expect(fact('Started')).toBe(`${formatDateTime(overview.system.startedAt, viewerTimeZone())} (up 3 days, 4 hours)`);
    expect(fact('AI')).toBe('On');
    expect(fact('Without an account')).toBe('On');
    expect(fact('Account checks')).toBe('Only when an account looks suspicious');
    expect(fact('Ranking')).toBe('The question as asked; AI reranks the top 50er-q-h50-v1');
    expect(fact('Automatic filters')).toBe('None: every filter AI suggests stays a suggestionnone');
    expect(fact('Tracing')).toBe('On');
    expect(fact('Failed exports')).toBe('0');
    expect(fact('NTSB snapshot')).toBe('16 Oct 2026');
    expect(fact('Cases')).toBe('26 (21 completed US investigations with a probable cause)');
    expect(fact('Next snapshot check')).toBe(ADMIN_COPY.notSetUp);
  });

  it('shapes the mock never makes: a capped list, no accounts, no dataset, an unknown ranking, an import set up, tracing off', async () => {
    signedIn();
    serve((o) => ({
      ...o,
      users: { ...o.users, total: 1_204, list: o.users.list.slice(0, 3) },
      system: {
        ...o.system,
        appVersion: null,
        appEnv: 'live',
        ranking: 'er-x-v9',
        automaticFilters: 'state-explicit.v2',
        ai: { enabled: false, anonymousEnabled: false, accountCheck: 'always' },
        tracing: { enabled: false, lastExportOkAt: null, failedExports: 3 },
        dataset: null,
        imports: { ...o.system.imports, enabled: true, schedule: { localTime: '05:30', timeZone: 'Europe/Prague', nextCheckAt: '2026-11-16T04:30:00.000Z' } },
      },
    }));
    await openAdmin();
    expect(region(ADMIN_COPY.users).textContent).toContain('The 3 most recently active accounts are listed.');
    const system = region(ADMIN_COPY.system);
    const fact = (label: string): string => system.querySelector(`[data-fact="${label}"] dd`)?.textContent ?? '';
    expect(fact('Version')).toBe('Not set');
    expect(fact('Environment')).toBe('Live');
    expect(fact('AI')).toBe('Off');
    expect(fact('Account checks')).toBe('Every account search takes a check');
    expect(fact('Ranking')).toBe('er-x-v9');
    expect(fact('Automatic filters')).toBe('A US state the question names explicitlystate-explicit.v2');
    expect(fact('Tracing')).toBe('Off');
    expect(fact('Last export')).toBe('None yet');
    expect(fact('Failed exports')).toBe('3');
    expect(fact('Dataset')).toBe('None loaded');
    expect(fact('Next snapshot check')).toBe(formatDateTime('2026-11-16T04:30:00.000Z', viewerTimeZone()));
  });

  it('no accounts yet', async () => {
    signedIn();
    serve((o) => ({ ...o, users: { total: 0, newLast7Days: 0, list: [] } }));
    await openAdmin();
    expect(region(ADMIN_COPY.users).textContent).toContain(ADMIN_COPY.noUsers);
  });

  it('a mean cost of no searches and a share of no ratings show “—”, which screen readers hear as “None”, like the users’ dashes', async () => {
    signedIn();
    serve((o) => ({
      ...o,
      costs: { ...o.costs, perSearch: { searches: 0, meanUsd: null } },
      usage: { ...o.usage, feedback: { useful: 0, notUseful: 0, usefulLast30Days: 0, notUsefulLast30Days: 0 } },
    }));
    await openAdmin();
    const mean = region(ADMIN_COPY.costs).querySelector('[data-stat="Per AI search"] dd');
    expect(mean?.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
    expect(mean?.querySelector('.sr-only')?.textContent).toBe(ADMIN_COPY.none);
    const ratings = within(region(ADMIN_COPY.usage)).getByRole('table', { name: 'Search ratings' });
    const share = within(ratings).getAllByRole('row').at(-1) as HTMLElement;
    expect(share.textContent).toBe(`Rated useful—${ADMIN_COPY.none}—${ADMIN_COPY.none}`);
    for (const cell of within(share).getAllByRole('cell')) {
      expect(cell.querySelector('[aria-hidden="true"]')?.textContent).toBe('—');
      expect(cell.querySelector('.sr-only')?.textContent).toBe(ADMIN_COPY.none);
    }
  });

  it('an account read that fails, and fails again, says the page didn’t load, with Try again, not “not found”; Try again opens it for an admin', async () => {
    signedIn();
    let reads = 0;
    server.use(
      http.get('*/api/account', () => {
        reads += 1;
        // The first read and its one retry fail.
        return reads <= 2 ? HttpResponse.json({ error: 'internal', message: 'Something went wrong.' }, { status: 500 }) : undefined;
      }),
    );
    const overviewReads = recordOverviewReads();
    renderApp('/admin');
    const failed = (await screen.findByText(ADMIN_COPY.accountFailed, {}, SLOW)).closest('[role="alert"]') as HTMLElement;
    expect(failed.textContent).toContain(ADMIN_COPY.loadFailedText);
    expect(reads).toBe(2);
    expect(screen.queryByRole('heading', { level: 1, name: NOT_FOUND_TITLE })).toBeNull();
    expect(overviewReads).toEqual([]);
    fireEvent.click(within(failed).getByRole('button', { name: ADMIN_COPY.tryAgain }));
    await screen.findByRole('region', { name: ADMIN_COPY.users }, SLOW);
    expect(screen.queryByText(ADMIN_COPY.accountFailed)).toBeNull();
  });

  it('figures that do not load say so, with Try again; Refresh reads them again', async () => {
    signedIn();
    let reads = 0;
    server.use(
      http.get('*/api/admin/overview', () => {
        reads += 1;
        // The first read and its one retry fail.
        return reads <= 2 ? HttpResponse.json({ error: 'internal', message: 'Something went wrong.' }, { status: 500 }) : undefined;
      }),
    );
    renderApp('/admin');
    expect(await screen.findByText(ADMIN_COPY.loadFailed, {}, SLOW)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(ADMIN_COPY.loadFailedText);
    fireEvent.click(screen.getByRole('button', { name: ADMIN_COPY.tryAgain }));
    await screen.findByRole('region', { name: ADMIN_COPY.users }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: ADMIN_COPY.refresh }));
    await waitFor(() => expect(reads).toBe(4), SLOW);
  });
});

describe('how the admin page says its figures', () => {
  it('times in a named zone, with the site’s month names; UTC days for the chart', () => {
    expect(formatDateTime('2026-10-31T13:02:00.000Z', 'Europe/Prague')).toBe('31 Oct 2026, 14:02');
    expect(formatDateTime('2026-07-01T13:02:00.000Z', 'Europe/Prague')).toBe('1 Jul 2026, 15:02');
    expect(formatDateTime('2026-09-30T23:30:00.000Z', 'UTC')).toBe('30 Sep 2026, 23:30');
    expect(formatDay('2026-09-30T23:30:00.000Z', 'Europe/Prague')).toBe('1 Oct 2026');
    expect(formatDateTime('2026-10-31T00:05:00.000Z', 'UTC')).toBe('31 Oct 2026, 00:05');
    expect(formatUtcDay('2026-10-30')).toBe('Fri 30 Oct');
    expect(formatUtcDay('2026-10-03', { weekday: false })).toBe('3 Oct');
  });

  it('dollars with the precision small sums need; shares; durations', () => {
    expect([0, 0.00004, 0.0086, 0.0125, 0.0999, 0.62, 14.87, 1234.5].map(formatUsd)).toEqual(['$0.00', 'under $0.0001', '$0.0086', '$0.0125', '$0.0999', '$0.62', '$14.87', '$1,234.50']);
    expect([formatShare(12.37, 100), formatShare(0.18, 3), formatShare(1, 0), formatShare(3, 2)]).toEqual(['12%', '6.0%', '0%', '150%']);
    expect([durationInWords(8 * 60_000), durationInWords(5 * 3_600_000 + 12 * 60_000), durationInWords(3_600_000), durationInWords((3 * 24 + 4) * 3_600_000 + 17 * 60_000), durationInWords(86_400_000)]).toEqual([
      '8 minutes',
      '5 hours, 12 minutes',
      '1 hour',
      '3 days, 4 hours',
      '1 day',
    ]);
  });

  it('every ranking and automatic-filter policy in plain words; anything else as its identifier alone', () => {
    expect(rankingInWords('er-q-v1')).toBe('The question as asked; in match order');
    expect(rankingInWords('er-q-h50-v1')).toBe('The question as asked; AI reranks the top 50');
    expect(rankingInWords('er-q-h100-v1')).toBe('The question as asked; AI reranks the top 100');
    expect(rankingInWords('er-t-s50-v1')).toBe('AI’s terms in keyword search, the question in similarity search; AI reranks the top 50 with a larger model');
    expect(rankingInWords('er-qt-v1')).toBe('The question and AI’s terms; in match order');
    expect(rankingInWords('er-x-v9')).toBeNull();
    expect(automaticFiltersInWords('none')).toBe('None: every filter AI suggests stays a suggestion');
    expect(automaticFiltersInWords('state-explicit.v1.3')).toBe('A US state the question names explicitly');
    expect(automaticFiltersInWords('cities')).toBeNull();
  });
});
