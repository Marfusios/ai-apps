import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../shared/config.js';
import { AdminOverviewSchema, type AdminOverview } from '../../shared/contracts/admin.js';
import { isAdmin } from '../auth/admin.js';
import { GOOGLE_ISSUER } from '../auth/better-auth.js';
import { accountIdentityHash } from '../quota/policy.js';
import { readAiSwitch } from '../quota/switch.js';
import { tracingHealth } from '../observability/tracing.js';
import { JSON_TYPE, sendError } from '../http/reply.js';
import type { ApiContext } from './context.js';

export interface AdminSettings {
  emails: readonly string[];
  identitySecret?: string;
  budgets?: AppConfig['ai']['budgets'];
  appVersion?: string;
  appEnv: 'dev' | 'live';
  startedAt: string;
  ranking: string;
  automaticFilters: string;
}
const dayMs = 86400_000;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const iso = (value: unknown): string | null => value == null ? null : new Date(value as string).toISOString();
const num = (value: unknown): number => Number(value ?? 0);

/** No content, subjects, principal hashes or trace ids leave this projection. */
export async function adminOverview(ctx: ApiContext, settings: AdminSettings, now = new Date()): Promise<AdminOverview> {
  const today = isoDay(now), month = `${today.slice(0, 7)}-01`;
  const prior = new Date(`${month}T00:00:00Z`); prior.setUTCMonth(prior.getUTCMonth() - 1);
  const priorMonth = isoDay(prior), from30 = isoDay(new Date(Date.parse(today) - 29 * dayMs));
  const from7 = isoDay(new Date(Date.parse(today) - 6 * dayMs)), from90 = isoDay(new Date(Date.parse(today) - 89 * dayMs));
  const pinned = await ctx.datasets.current().catch(() => null);
  return ctx.db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
    // Account metadata is bounded independently of the returned list. Refuse rather than
    // silently omit a potentially most-active user if this beta grows beyond the bound.
    const users = (await tx.execute(sql`SELECT u.id, u.name, u.email, u.email_verified, u.created_at, a.account_id,
      (SELECT max(s.updated_at) FROM auth_sessions s WHERE s.user_id = u.id) AS signed_at
      FROM auth_users u LEFT JOIN auth_accounts a ON a.user_id = u.id AND a.provider_id = 'google'
      ORDER BY u.id LIMIT 10001`)).rows;
    if (users.length > 10000) throw new Error('admin overview user bound exceeded');
    const hashes = users.map(u => settings.identitySecret && u.account_id ? accountIdentityHash(settings.identitySecret, GOOGLE_ISSUER, String(u.account_id)) : null);
    const userUsage = (await tx.execute(sql`SELECT principal_hash,
      count(*) FILTER (WHERE accounting_day = ${today}::date)::int AS today,
      count(*) FILTER (WHERE accounting_day >= ${from7}::date)::int AS week,
      count(*) FILTER (WHERE accounting_day >= ${from30}::date)::int AS month,
      count(*)::int AS total, max(created_at) AS latest
      FROM reservations WHERE principal_hash = ANY(${sql.param(hashes.filter(h => h !== null))}::text[])
      AND principal_kind = 'account' AND category = 'interactive' AND status <> 'open' AND quota_counted
      AND accounting_day BETWEEN ${from90}::date AND ${today}::date GROUP BY principal_hash`)).rows;
    const byPrincipal = new Map(userUsage.map(r => [r.principal_hash, r]));
    const list = users.map((u, index) => {
      const usage = byPrincipal.get(hashes[index]);
      return { name: String(u.name), email: String(u.email), createdAt: iso(u.created_at)!, lastSignInAt: iso(u.signed_at),
        lastAiSearchAt: iso(usage?.latest), aiSearches: { today: num(usage?.today), last7Days: num(usage?.week), last30Days: num(usage?.month), last90Days: num(usage?.total) },
        isAdmin: u.account_id !== null && u.email_verified === true && settings.emails.includes(String(u.email).trim().toLowerCase()) };
    }).sort((a,b) => Math.max(Date.parse(b.lastAiSearchAt ?? b.createdAt), Date.parse(b.lastSignInAt ?? b.createdAt)) -
      Math.max(Date.parse(a.lastAiSearchAt ?? a.createdAt), Date.parse(a.lastSignInAt ?? a.createdAt)) || a.email.localeCompare(b.email)).slice(0,1000);
    const daily = (await tx.execute(sql`SELECT r.accounting_day AS day,
      count(*) FILTER (WHERE r.quota_counted AND r.principal_kind = 'trial')::int AS trial,
      count(*) FILTER (WHERE r.quota_counted AND r.principal_kind = 'account')::int AS account,
      count(*) FILTER (WHERE coalesce(u.free_undo,false))::int AS undos,
      count(*) FILTER (WHERE NOT r.quota_counted AND (NOT coalesce(u.free_undo,false) OR coalesce(u.outcome,'failed') = 'failed'))::int AS failed
      FROM reservations r LEFT JOIN evidence_usage u ON u.reservation_id = r.id
      WHERE r.category = 'interactive' AND r.principal_kind IN ('trial','account') AND r.status <> 'open'
      AND r.accounting_day BETWEEN ${from30}::date AND ${today}::date GROUP BY r.accounting_day`)).rows;
    const money = (await tx.execute(sql`SELECT accounting_day AS day, sum(usd)::float AS usd FROM cost_ledger
      WHERE accounting_day BETWEEN ${from30}::date AND ${today}::date GROUP BY accounting_day`)).rows;
    const distinct = (await tx.execute(sql`SELECT count(DISTINCT principal_hash) FILTER (WHERE principal_kind = 'trial')::int AS trials,
      count(DISTINCT principal_hash) FILTER (WHERE principal_kind = 'account')::int AS accounts FROM reservations
      WHERE category = 'interactive' AND quota_counted AND status <> 'open' AND accounting_day BETWEEN ${from30}::date AND ${today}::date`)).rows[0]!;
    const feedback = (await tx.execute(sql`SELECT
      coalesce(sum(count) FILTER (WHERE rating = 'useful'),0)::float AS useful,
      coalesce(sum(count) FILTER (WHERE rating = 'not_useful'),0)::float AS not_useful,
      coalesce(sum(count) FILTER (WHERE rating = 'useful' AND day >= ${from30}::date),0)::float AS useful_month,
      coalesce(sum(count) FILTER (WHERE rating = 'not_useful' AND day >= ${from30}::date),0)::float AS not_useful_month FROM evidence_feedback_daily WHERE day <= ${today}::date`)).rows[0]!;
    const costs = (await tx.execute(sql`SELECT
      coalesce(sum(usd) FILTER (WHERE accounting_day = ${today}::date),0)::float AS today,
      coalesce(sum(usd) FILTER (WHERE accounting_day >= ${month}::date),0)::float AS month,
      coalesce(sum(usd) FILTER (WHERE accounting_day < ${month}::date),0)::float AS previous,
      coalesce(sum(usd) FILTER (WHERE accounting_day >= ${month}::date AND category = 'interactive'),0)::float AS interactive,
      coalesce(sum(usd) FILTER (WHERE accounting_day >= ${month}::date AND category = 'indexing'),0)::float AS indexing,
      coalesce(sum(usd) FILTER (WHERE accounting_day >= ${month}::date AND category = 'evaluation'),0)::float AS evaluation,
      coalesce(sum(usd) FILTER (WHERE accounting_day >= ${month}::date AND uncertain),0)::float AS uncertain
      FROM cost_ledger WHERE accounting_day BETWEEN ${priorMonth}::date AND ${today}::date`)).rows[0]!;
    const stages = (await tx.execute(sql`SELECT stage, provider, model, count(*)::int AS calls, sum(usd)::float AS usd FROM cost_ledger
      WHERE accounting_day BETWEEN ${month}::date AND ${today}::date GROUP BY stage,provider,model ORDER BY sum(usd) DESC, stage, provider, model LIMIT 50`)).rows;
    const searches = num((await tx.execute(sql`SELECT count(*)::int AS n FROM reservations WHERE category = 'interactive' AND quota_counted AND status <> 'open'
      AND accounting_day BETWEEN ${month}::date AND ${today}::date`)).rows[0]?.n);
    const state = await readAiSwitch(tx);
    const generation = pinned ? (await tx.execute(sql`SELECT sealed_at FROM dataset_generations WHERE id = ${pinned.manifest.generationId}`)).rows[0] : null;
    const counts = new Map(daily.map(d => [isoDay(new Date(d.day as string)), d]));
    const dollars = new Map(money.map(d => [isoDay(new Date(d.day as string)), num(d.usd)]));
    const budget = settings.budgets;
    return AdminOverviewSchema.parse({ generatedAt: now.toISOString(),
      users: { total: users.length, newLast7Days: users.filter(u => Date.parse(iso(u.created_at)!) >= Date.parse(from7)).length, list },
      usage: { days: Array.from({length:30}, (_, i) => {
        const day = isoDay(new Date(Date.parse(from30) + i * dayMs)), d = counts.get(day);
        return { day, trialSearches: num(d?.trial), accountSearches: num(d?.account), freeUndos: num(d?.undos), failedSearches: num(d?.failed), usd: dollars.get(day) ?? 0 };
      }), activeTrialsLast30Days: num(distinct.trials), activeAccountsLast30Days: num(distinct.accounts),
      feedback: { useful: num(feedback.useful), notUseful: num(feedback.not_useful), usefulLast30Days: num(feedback.useful_month), notUsefulLast30Days: num(feedback.not_useful_month) } },
      costs: { today: num(costs.today), monthToDate: num(costs.month), previousMonth: num(costs.previous),
        byCategory: {interactive: num(costs.interactive), indexing: num(costs.indexing), evaluation: num(costs.evaluation)},
        byStage: stages.map(s => ({stage:s.stage, provider:s.provider == null ? null : String(s.provider).slice(0,40), model:s.model == null ? null : String(s.model).slice(0,80), calls:num(s.calls), usd:num(s.usd)})),
        perSearch: { searches, meanUsd: searches ? num(costs.interactive) / searches : null }, uncertainUsd: num(costs.uncertain),
        budgets: {monthly:budget?.monthlyUsd ?? 0, interactiveMonthly:budget?.interactiveMonthlyUsd ?? 0, interactiveDaily:budget?.interactiveDailyUsd ?? 0, ingestionMonthly:budget?.ingestionMonthlyUsd ?? 0} },
      system: { appVersion:settings.appVersion ?? null, appEnv:settings.appEnv, startedAt:settings.startedAt,
        ranking:settings.ranking, automaticFilters:settings.automaticFilters,
        ai:{enabled:state.enabled,anonymousEnabled:state.anonymousEnabled,accountCheck:state.accountCheck}, tracing:tracingHealth(),
        dataset:pinned ? {generationId:pinned.manifest.generationId, snapshotDate:pinned.dataset.snapshotDate, loadedAt:iso(generation?.sealed_at),
          publishedAt:pinned.manifest.publishedAt.toISOString(), cases:pinned.coverage.defaultCohort + pinned.coverage.otherRecords, eligibleCases:pinned.coverage.defaultCohort} : null,
        nextAutomaticImport:null },
    });
  }, { isolationLevel:'repeatable read', accessMode:'read only' });
}

export function adminRoutes(app: FastifyInstance, ctx: ApiContext, settings: AdminSettings): void {
  app.get('/api/admin/overview', async (request, reply) => {
    const signed = ctx.auth ? await ctx.auth.signedIn(request.headers.cookie) : null;
    if (!(await isAdmin(ctx.db, signed, settings.emails))) return sendError(reply,404,'not_found');
    return reply.type(JSON_TYPE).send(JSON.stringify(await adminOverview(ctx,settings)));
  });
}
