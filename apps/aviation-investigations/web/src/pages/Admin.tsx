import { useQuery } from '@tanstack/react-query';
import { Fragment, type ReactNode } from 'react';
import type { AdminOverview, AdminUser } from '../../../shared/contracts/admin';
import { isNotFound } from '../api';
import { documentTitle } from '../brand';
import { Button } from '../components/Button';
import { SectionHead } from '../components/SectionHead';
import { adminOverviewQuery } from '../features/admin/api';
import {
  automaticFiltersInWords,
  durationInWords,
  formatDateTime,
  formatDay,
  formatShare,
  formatUsd,
  rankingInWords,
  viewerTimeZone,
} from '../features/admin/format';
import { UsageChart, USAGE_CHART_TITLE } from '../features/admin/UsageChart';
import { accountQuery } from '../features/auth/api';
import { useSignIn } from '../features/auth/SignInDialog';
import { cx } from '../lib/cx';
import { formatCount, formatDate } from '../lib/format';
import { NotFound } from './Placeholder';

// ---------------------------------------------------------------------------
// Builder copy (Task 25), for the owner's review.

export const ADMIN_COPY = {
  title: 'Admin',
  asOf: (at: string, zone: string) => `Figures as of ${at}. Times are in your time zone, ${zone}.`,
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  loadFailed: 'The admin figures didn’t load.',
  loadFailedText: 'Check your connection and try again.',
  tryAgain: 'Try again',
  users: 'Users',
  usage: 'Usage',
  costs: 'Costs',
  system: 'System',
  noUsers: 'No accounts yet.',
  listed: (n: number) => `The ${formatCount(n)} most recently active accounts are listed.`,
  admin: 'Admin',
  never: 'Never',
  none: 'None',
  notSetUp: 'Not set up yet',
  notSet: 'Not set',
  on: 'On',
  off: 'Off',
} as const;

const tz = viewerTimeZone();
const when = (iso: string | null, fallback: string = ADMIN_COPY.never): string => (iso === null ? fallback : formatDateTime(iso, tz));

/** A card of the page: its heading (serif, like the dashboard's questions) and what it holds. */
function Panel({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cx('min-w-0 scroll-mt-4 rounded-card border border-hairline bg-raised/80 px-4 py-3.5 sm:px-5 sm:py-4', className)}>
      <h2 id={`${id}-title`} tabIndex={-1} className="mb-2.5 font-serif text-[19px] leading-[1.2] font-semibold outline-none">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A headline figure: its label, the value, and what it is measured over. */
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0" data-stat={label}>
      <dt className="text-micro font-bold tracking-caps text-muted uppercase">{label}</dt>
      <dd className="mt-0.5 text-[20px] leading-tight font-bold text-ink">{value}</dd>
      {sub && <dd className="text-label text-muted">{sub}</dd>}
    </div>
  );
}

function Stats({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">{children}</dl>;
}

/** The small caps tag of an admin account. */
function AdminTag() {
  return <span className="ml-1.5 rounded-tag border border-hairline px-1 text-micro font-bold tracking-caps whitespace-nowrap text-muted uppercase">{ADMIN_COPY.admin}</span>;
}

/** "—" for a time that is not there, said as such. */
function Missing({ words }: { words: string }) {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{words}</span>
    </>
  );
}

/**
 * An account's AI searches over the four windows: the table's column heads, and how the phone's
 * list says them ("10 in 7 days"). The longest window is 90 days: usage records are kept that long.
 */
const counts = (u: AdminUser): [string, string, number][] => [
  ['Today', 'today', u.aiSearches.today],
  ['7 days', 'in 7 days', u.aiSearches.last7Days],
  ['30 days', 'in 30 days', u.aiSearches.last30Days],
  ['90 days', 'in 90 days', u.aiSearches.last90Days],
];
const COUNT_HEADS = ['Today', '7 days', '30 days', '90 days'] as const;

function UsersTable({ list }: { list: readonly AdminUser[] }) {
  const th = 'px-2 py-1.5 text-left text-micro font-bold tracking-caps text-muted uppercase first:pl-0';
  return (
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[760px] text-meta" data-users-table="">
        <caption className="sr-only">Accounts, most recently active first</caption>
        <thead>
          <tr>
            <th scope="col" rowSpan={2} className={cx(th, 'align-bottom')}>
              Name
            </th>
            <th scope="col" rowSpan={2} className={cx(th, 'align-bottom')}>
              E-mail
            </th>
            <th scope="col" rowSpan={2} className={cx(th, 'align-bottom')}>
              Joined
            </th>
            <th scope="col" rowSpan={2} className={cx(th, 'align-bottom')}>
              Last sign-in
            </th>
            <th scope="col" rowSpan={2} className={cx(th, 'align-bottom')}>
              Last AI search
            </th>
            <th scope="colgroup" colSpan={4} className={cx(th, 'border-b border-hairline pb-0.5 text-center')}>
              AI searches
            </th>
          </tr>
          <tr className="border-b border-hairline">
            {COUNT_HEADS.map((h) => (
              <th key={h} scope="col" className={cx(th, 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.email} className="border-b border-hairline last:border-b-0">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal whitespace-nowrap text-ink">
                {u.name}
                {u.isAdmin && <AdminTag />}
              </th>
              <td className="px-2 py-1.5 break-all text-ink">{u.email}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{formatDay(u.createdAt, tz)}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{u.lastSignInAt === null ? <Missing words={ADMIN_COPY.none} /> : when(u.lastSignInAt)}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{u.lastAiSearchAt === null ? <Missing words={ADMIN_COPY.never} /> : when(u.lastAiSearchAt)}</td>
              {counts(u).map(([head, , n]) => (
                <td key={head} className="px-2 py-1.5 text-right font-mono tabular-nums last:pr-0">
                  {formatCount(n)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** On a phone each account is a block of its own, in the table's order. */
function UsersList({ list }: { list: readonly AdminUser[] }) {
  return (
    <ul className="sm:hidden" aria-label="Accounts, most recently active first" data-users-list="">
      {list.map((u) => (
        <li key={u.email} className="border-t border-hairline py-2.5 first:border-t-0 first:pt-0">
          <p className="text-ui font-bold text-ink">
            {u.name}
            {u.isAdmin && <AdminTag />}
          </p>
          <p className="text-meta break-all text-muted">{u.email}</p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-meta">
            <dt className="text-muted">Joined</dt>
            <dd>{formatDay(u.createdAt, tz)}</dd>
            <dt className="text-muted">Last sign-in</dt>
            <dd>{u.lastSignInAt === null ? <Missing words={ADMIN_COPY.none} /> : when(u.lastSignInAt)}</dd>
            <dt className="text-muted">Last AI search</dt>
            <dd>{u.lastAiSearchAt === null ? <Missing words={ADMIN_COPY.never} /> : when(u.lastAiSearchAt)}</dd>
            <dt className="text-muted">AI searches</dt>
            <dd className="font-mono tabular-nums">
              {counts(u).map(([head, words, n], i) => (
                <Fragment key={head}>
                  {i > 0 && <span aria-hidden="true"> · </span>}
                  <span className="whitespace-nowrap">
                    {formatCount(n)} <span className="font-sans text-muted">{words}</span>
                  </span>
                  {i < 3 && <span className="sr-only">, </span>}
                </Fragment>
              ))}
            </dd>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function Users({ users }: { users: AdminOverview['users'] }) {
  return (
    <Panel id="admin-users" title={ADMIN_COPY.users}>
      <Stats>
        <Stat label="Accounts" value={formatCount(users.total)} />
        <Stat label="New in the last 7 days" value={formatCount(users.newLast7Days)} />
      </Stats>
      <div className="mt-4">
        {users.list.length === 0 ? (
          <p className="text-ui text-muted">{ADMIN_COPY.noUsers}</p>
        ) : (
          <>
            <UsersTable list={users.list} />
            <UsersList list={users.list} />
            {users.list.length < users.total && <p className="mt-2 text-label text-muted">{ADMIN_COPY.listed(users.list.length)}</p>}
          </>
        )}
      </div>
    </Panel>
  );
}

function Ratings({ feedback }: { feedback: AdminOverview['usage']['feedback'] }) {
  const all = feedback.useful + feedback.notUseful;
  const recent = feedback.usefulLast30Days + feedback.notUsefulLast30Days;
  const cell = 'py-1 pl-4 text-right font-mono tabular-nums text-ink';
  return (
    <table className="w-full max-w-[420px] text-meta" data-ratings="">
      <caption className="sr-only">Search ratings</caption>
      <thead>
        <tr className="border-b border-hairline text-micro font-bold tracking-caps text-muted uppercase">
          <td />
          <th scope="col" className="py-1 pl-4 text-right font-bold">
            All time
          </th>
          <th scope="col" className="py-1 pl-4 text-right font-bold">
            Last 30 days
          </th>
        </tr>
      </thead>
      <tbody>
        <tr className="border-b border-hairline">
          <th scope="row" className="py-1 text-left font-normal">
            Useful
          </th>
          <td className={cell}>{formatCount(feedback.useful)}</td>
          <td className={cell}>{formatCount(feedback.usefulLast30Days)}</td>
        </tr>
        <tr className="border-b border-hairline">
          <th scope="row" className="py-1 text-left font-normal">
            Not useful
          </th>
          <td className={cell}>{formatCount(feedback.notUseful)}</td>
          <td className={cell}>{formatCount(feedback.notUsefulLast30Days)}</td>
        </tr>
        <tr>
          <th scope="row" className="py-1 text-left font-normal text-muted">
            Rated useful
          </th>
          <td className={cell}>{all > 0 ? formatShare(feedback.useful, all) : '—'}</td>
          <td className={cell}>{recent > 0 ? formatShare(feedback.usefulLast30Days, recent) : '—'}</td>
        </tr>
      </tbody>
    </table>
  );
}

function Usage({ usage }: { usage: AdminOverview['usage'] }) {
  const sum = (key: 'trialSearches' | 'accountSearches' | 'freeUndos' | 'failedSearches'): number => usage.days.reduce((n, d) => n + d[key], 0);
  return (
    <Panel id="admin-usage" title={ADMIN_COPY.usage}>
      <Stats>
        <Stat label="AI searches" value={formatCount(sum('trialSearches') + sum('accountSearches'))} sub="last 30 days" />
        <Stat label="Active trials" value={formatCount(usage.activeTrialsLast30Days)} sub="last 30 days" />
        <Stat label="Active accounts" value={formatCount(usage.activeAccountsLast30Days)} sub="last 30 days" />
        <Stat label="Free undos" value={formatCount(sum('freeUndos'))} sub="last 30 days" />
        <Stat label="Failed searches" value={formatCount(sum('failedSearches'))} sub="last 30 days" />
      </Stats>
      <div className="mt-5">
        <SectionHead>{USAGE_CHART_TITLE}</SectionHead>
        <UsageChart days={usage.days} />
      </div>
      <div className="mt-5">
        <SectionHead>Search ratings</SectionHead>
        <Ratings feedback={usage.feedback} />
      </div>
    </Panel>
  );
}

/** A budget and how much of it is used: a meter in chart blue on a track of its lighter wash. */
function Budget({ label, used, budget }: { label: string; used: number; budget: number }) {
  const share = budget > 0 ? Math.min(1, used / budget) : 0;
  const words = `${formatUsd(used)} of ${formatUsd(budget)} · ${formatShare(used, budget)}`;
  return (
    <li className="min-w-0" data-budget={label}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-meta text-ink">{label}</span>
        <span className="font-mono text-label text-ink tabular-nums">{words}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={Math.min(used, budget)}
        aria-valuetext={words}
        className="mt-1 h-2 overflow-hidden rounded-full bg-blue-wash"
      >
        <div className="h-full rounded-full bg-blue" style={{ width: `${Math.max(used > 0 ? 1.5 : 0, share * 100)}%` }} />
      </div>
    </li>
  );
}

const CATEGORY_WORDS = { interactive: 'Interactive (AI searches)', indexing: 'Indexing', evaluation: 'Evaluation' } as const;
/** The pipeline stages the spend ledger names, in words; any other shows its name alone. */
const STAGE_WORDS: Readonly<Partial<Record<string, string>>> = { scope: 'Question', embed: 'Embedding', rerank: 'Ordering', retrieve: 'Retrieval', uncertain: 'Uncertain charge', lease_expired: 'Expired reservation' };

function Costs({ costs }: { costs: AdminOverview['costs'] }) {
  const categories = Object.entries(costs.byCategory) as [keyof typeof CATEGORY_WORDS, number][];
  const max = Math.max(0.000001, ...categories.map(([, usd]) => usd));
  const th = 'px-2 py-1.5 text-left text-micro font-bold tracking-caps text-muted uppercase first:pl-0 last:pr-0';
  return (
    <Panel id="admin-costs" title={ADMIN_COPY.costs}>
      <Stats>
        <Stat label="Today" value={formatUsd(costs.today)} sub="UTC day" />
        <Stat label="This month" value={formatUsd(costs.monthToDate)} sub="to date, UTC" />
        <Stat label="Last month" value={formatUsd(costs.previousMonth)} />
        <Stat
          label="Per AI search"
          value={costs.perSearch.meanUsd === null ? '—' : formatUsd(costs.perSearch.meanUsd)}
          sub={`this month, ${formatCount(costs.perSearch.searches)} ${costs.perSearch.searches === 1 ? 'search' : 'searches'}`}
        />
        <Stat label="Uncertain charges" value={formatUsd(costs.uncertainUsd)} sub="this month, at the reserved cost" />
      </Stats>
      <div className="mt-5">
        <SectionHead>Budgets</SectionHead>
        <ul className="space-y-3">
          <Budget label="All AI spend, this month" used={costs.monthToDate} budget={costs.budgets.monthly} />
          <Budget label="Interactive, this month" used={costs.byCategory.interactive} budget={costs.budgets.interactiveMonthly} />
          <Budget label="Interactive, today" used={costs.interactiveToday} budget={costs.budgets.interactiveDaily} />
          <Budget label="Indexing and evaluation, this month" used={costs.byCategory.indexing + costs.byCategory.evaluation} budget={costs.budgets.ingestionMonthly} />
        </ul>
      </div>
      <div className="mt-5">
        <SectionHead>By category, this month</SectionHead>
        <ul aria-label="By category, this month" className="space-y-1">
          {categories.map(([key, usd]) => (
            <li key={key} className="grid grid-cols-[1fr_auto] items-center gap-x-3">
              <span className="relative min-w-0">
                <span aria-hidden="true" className="absolute inset-y-px left-0 rounded-[2px] bg-blue-wash" style={{ width: `${Math.max(usd > 0 ? 2 : 0, (usd / max) * 100)}%` }} />
                <span className="relative block truncate px-1.5 py-px text-meta text-ink">{CATEGORY_WORDS[key]}</span>
              </span>
              <span className="text-right font-mono text-label text-ink tabular-nums">{formatUsd(usd)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-5">
        <SectionHead>By stage, this month</SectionHead>
        {costs.byStage.length === 0 ? (
          <p className="text-meta text-muted">No spend this month.</p>
        ) : (
          <table className="w-full text-meta" data-stage-costs="">
            <caption className="sr-only">This month by stage, provider and model, most expensive first</caption>
            <thead>
              <tr className="border-b border-hairline">
                <th scope="col" className={th}>
                  Stage, provider and model
                </th>
                <th scope="col" className={cx(th, 'text-right')}>
                  Calls
                </th>
                <th scope="col" className={cx(th, 'text-right')}>
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {costs.byStage.map((s) => (
                <tr key={`${s.stage}|${s.provider ?? ''}|${s.model ?? ''}`} className="border-b border-hairline align-baseline last:border-b-0">
                  <th scope="row" className="py-1.5 pr-2 text-left font-normal text-ink">
                    {STAGE_WORDS[s.stage] !== undefined ? (
                      <>
                        {STAGE_WORDS[s.stage]} <span className="font-mono text-label text-muted">{s.stage}</span>
                      </>
                    ) : (
                      <span className="font-mono text-label">{s.stage}</span>
                    )}
                    <span className="block font-mono text-label break-words text-muted">
                      {s.provider ?? 'no provider'} · {s.model ?? 'no model'}
                    </span>
                  </th>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{formatCount(s.calls)}</td>
                  <td className="py-1.5 pl-2 text-right font-mono tabular-nums">{formatUsd(s.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

/** One line of the system's facts: its name, and the value (with an identifier in mono where there is one). */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9.5rem)_1fr] gap-x-3 py-1 sm:grid-cols-[11rem_1fr]" data-fact={label}>
      <dt className="text-meta text-muted">{label}</dt>
      <dd className="min-w-0 text-meta break-words text-ink">{children}</dd>
    </div>
  );
}

/** A configuration's identifier, under its words (or alone, for one the page has no words for). */
function Id({ children }: { children: string }) {
  return <span className="block font-mono text-label break-words text-muted">{children}</span>;
}

function System({ system, now }: { system: AdminOverview['system']; now: number }) {
  const ranking = rankingInWords(system.ranking);
  const automatic = automaticFiltersInWords(system.automaticFilters);
  const d = system.dataset;
  return (
    <Panel id="admin-system" title={ADMIN_COPY.system}>
      <SectionHead>App</SectionHead>
      <dl className="mb-4">
        <Fact label="Version">{system.appVersion ?? ADMIN_COPY.notSet}</Fact>
        <Fact label="Environment">{system.appEnv === 'live' ? 'Live' : 'Dev'}</Fact>
        <Fact label="Started">
          {when(system.startedAt)} <span className="text-muted">(up {durationInWords(now - Date.parse(system.startedAt))})</span>
        </Fact>
      </dl>
      <SectionHead>AI search</SectionHead>
      <dl className="mb-4">
        <Fact label="AI">{system.ai.enabled ? ADMIN_COPY.on : ADMIN_COPY.off}</Fact>
        <Fact label="Without an account">{system.ai.anonymousEnabled ? ADMIN_COPY.on : ADMIN_COPY.off}</Fact>
        <Fact label="Account checks">{system.ai.accountCheck === 'always' ? 'Every account search takes a check' : 'Only when an account looks suspicious'}</Fact>
        <Fact label="Ranking">
          {ranking}
          <Id>{system.ranking}</Id>
        </Fact>
        <Fact label="Automatic filters">
          {automatic}
          <Id>{system.automaticFilters}</Id>
        </Fact>
      </dl>
      <SectionHead>Tracing</SectionHead>
      <dl className="mb-4">
        <Fact label="Tracing">{system.tracing.enabled ? ADMIN_COPY.on : ADMIN_COPY.off}</Fact>
        <Fact label="Last export">{when(system.tracing.lastExportOkAt, 'None yet')}</Fact>
        <Fact label="Failed exports">{formatCount(system.tracing.failedExports)}</Fact>
      </dl>
      <SectionHead>Dataset</SectionHead>
      <dl className="mb-4">
        {d === null ? (
          <Fact label="Dataset">None loaded</Fact>
        ) : (
          <>
            <Fact label="NTSB snapshot">{formatDate(d.snapshotDate)}</Fact>
            <Fact label="Loaded">{when(d.loadedAt, ADMIN_COPY.notSet)}</Fact>
            <Fact label="Published">{when(d.publishedAt, ADMIN_COPY.notSet)}</Fact>
            <Fact label="Cases">
              {formatCount(d.cases)} <span className="text-muted">({formatCount(d.eligibleCases)} completed US investigations with a probable cause)</span>
            </Fact>
            <Fact label="Generation">
              <Id>{String(d.generationId)}</Id>
            </Fact>
          </>
        )}
      </dl>
      <SectionHead>Automatic import</SectionHead>
      <dl>
        <Fact label="Next import">{system.nextAutomaticImport === null ? ADMIN_COPY.notSetUp : when(system.nextAutomaticImport)}</Fact>
      </dl>
    </Panel>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true" className="space-y-3.5">
      <div className="h-7 w-40 rounded-[3px] bg-tint" />
      <div className="h-40 rounded-card bg-tint opacity-60" />
      <div className="h-56 rounded-card bg-tint opacity-40" />
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-page px-4 pt-5 pb-12 sm:px-[26px] sm:pt-[22px]">
      <title>{documentTitle(ADMIN_COPY.title)}</title>
      <meta name="robots" content="noindex, nofollow" />
      {children}
    </div>
  );
}

/**
 * The admin page (`/admin`, UI_DESIGN §4.12, Task 25): for an account the server lists as an admin
 * (`/api/account` `isAdmin`), everything from `GET /api/admin/overview`: users, usage, costs and the
 * system, in plain words and formatted numbers, times in the viewer's own zone, named once. Everyone
 * else, signed out or not an admin, gets the ordinary "not found" page, as the API answers them 404.
 * Private and not indexed.
 */
export function Admin() {
  const signIn = useSignIn();
  const account = useQuery({ ...accountQuery(), enabled: signIn.enabled });
  const isAdmin = account.data?.signedIn === true && account.data.isAdmin === true;
  const overview = useQuery({ ...adminOverviewQuery(), enabled: isAdmin });

  // Whether sign-in is offered, and who is signed in, are still being read.
  if (signIn.pending || (signIn.enabled && account.isPending)) {
    return (
      <Frame>
        <Skeleton />
      </Frame>
    );
  }
  if (!isAdmin || isNotFound(overview.error)) return <NotFound />;
  const data = overview.data;
  return (
    <Frame>
      <h1 className="font-serif text-[26px] leading-[1.1] font-semibold tracking-headline sm:text-[28px]">{ADMIN_COPY.title}</h1>
      {!data ? (
        overview.isError ? (
          <div role="alert" className="mt-4 rounded-card border border-hairline bg-raised px-4 py-4">
            <p className="font-serif text-[16px] font-semibold">{ADMIN_COPY.loadFailed}</p>
            <p className="mt-1 mb-3 text-meta text-muted">{ADMIN_COPY.loadFailedText}</p>
            <Button variant="search" size="sm" onClick={() => void overview.refetch()}>
              {ADMIN_COPY.tryAgain}
            </Button>
          </div>
        ) : (
          <div className="mt-4">
            <Skeleton />
          </div>
        )
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-meta text-muted" data-as-of="">
              {ADMIN_COPY.asOf(when(data.generatedAt), tz)}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void overview.refetch()} disabled={overview.isFetching} aria-busy={overview.isFetching}>
              {overview.isFetching ? ADMIN_COPY.refreshing : ADMIN_COPY.refresh}
            </Button>
          </div>
          {overview.isError && (
            <p role="alert" className="mt-1 text-meta text-ink">
              {ADMIN_COPY.loadFailed} These are the figures read before.
            </p>
          )}
          <nav aria-label="On this page" className="mt-2 mb-4 flex flex-wrap gap-x-4 gap-y-1 text-ui" data-print="hide">
            {(['users', 'usage', 'costs', 'system'] as const).map((key) => (
              <a
                key={key}
                href={`#admin-${key}`}
                onClick={(event) => {
                  // In the page, without a router navigation: the section's heading takes focus and scrolls into view.
                  event.preventDefault();
                  document.getElementById(`admin-${key}-title`)?.focus();
                }}
                className="text-blue hover:underline pointer-coarse:min-h-11 pointer-coarse:py-2.5"
              >
                {ADMIN_COPY[key]}
              </a>
            ))}
          </nav>
          <div className="space-y-3.5">
            <Users users={data.users} />
            <Usage usage={data.usage} />
            <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2">
              <Costs costs={data.costs} />
              <System system={data.system} now={Date.parse(data.generatedAt)} />
            </div>
          </div>
        </>
      )}
    </Frame>
  );
}
