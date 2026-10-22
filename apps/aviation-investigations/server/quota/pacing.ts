/**
 * Budget pacing (DESIGN §9). Money is handled as whole micro-dollars (µ$) so sums and
 * comparisons are exact; the database stores USD `numeric(12,6)`.
 *
 * Spent money is the ledger plus the full amount of every open reservation; an expired
 * lease is already in the ledger at its full reservation. Nothing becomes available
 * again because a request or lease expired.
 *
 * The daily interactive allowance is fixed at the start of each UTC day:
 * `min(daily cap, (interactive budget − charged on earlier days − still-open
 * reservations from earlier days) / days left in the month including today)`.
 * Today's charges and open reservations are then spent against it, so pacing does
 * not count today's spend twice. Unspent allowance rolls into later days.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import type { SpendCategory } from '../db/schema/index.js';
import { monthStart, nextMonthStart, nextUtcMidnight, utcDay } from './buckets.js';
import { QuotaInputError, type QuotaBudgets } from './policy.js';

const MICROS = 1_000_000;

/** USD to µ$, rounded up: charges and reservations are never understated. */
export function toMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new QuotaInputError('Amounts must be finite and non-negative');
  return Math.ceil(Math.round(usd * 1e9) / 1e3);
}

/** USD to µ$, rounded down: allowances are never overstated. */
export function budgetMicros(usd: number): number {
  return Math.max(0, Math.floor(Math.round(usd * 1e9) / 1e3));
}

export const microsToUsd = (m: number): number => m / MICROS;

/** Exact `numeric(12,6)` literal for a non-negative µ$ integer. */
export function microsToNumeric(m: number): string {
  if (!Number.isSafeInteger(m) || m < 0) throw new QuotaInputError('Invalid amount');
  const s = String(m).padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/** Calendar days left in the UTC month, today included. */
export function remainingDaysInMonth(now: Date): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return daysInMonth - now.getUTCDate() + 1;
}

/** Interactive spend of the current month before today (UTC). */
export interface LedgerState {
  /** Charged on earlier days (ledger lines, uncertain ones at their full reservation). */
  settledUsd: number;
  /** Reservations from earlier days that are still open, at their full amount. */
  unsettledUsd: number;
}

function allowanceMicros(now: Date, settled: number, unsettled: number, budgets: QuotaBudgets): number {
  const remaining = Math.max(0, budgetMicros(budgets.interactiveMonthlyUsd) - settled - unsettled);
  const paced = Math.floor(remaining / remainingDaysInMonth(now));
  return Math.min(budgetMicros(budgets.interactiveDailyUsd), paced);
}

/**
 * Today's interactive allowance: the lower of the daily cap and the remaining
 * interactive money (after unsettled reservations) divided by the days left.
 */
export function dailyAllowanceUsd(now: Date, ledger: LedgerState, budgets: QuotaBudgets): number {
  return microsToUsd(allowanceMicros(now, toMicros(ledger.settledUsd), toMicros(ledger.unsettledUsd), budgets));
}

/** Month-to-date spend in µ$, ledger plus open reservations, by accounting day. */
export interface SpendSnapshot {
  interactive: {
    /** Ledger lines from earlier days of the month. */
    settledBeforeToday: number;
    /** Open reservations from earlier days of the month. */
    openBeforeToday: number;
    /** Ledger plus open reservations today. */
    today: number;
    /** Of `today`, what anonymous trials spent or hold. */
    anonymousToday: number;
    /** Ledger plus open reservations this month. */
    month: number;
  };
  /** Indexing plus evaluation this month (ledger plus open). */
  ingestionMonth: number;
  /** Every category this month (ledger plus open). */
  totalMonth: number;
}

/** One consistent read (single statement) of this month's spend. */
export async function spendSnapshot(db: DbOrTx, now: Date): Promise<SpendSnapshot> {
  const from = utcDay(monthStart(now));
  const to = utcDay(nextMonthStart(now));
  const today = utcDay(now);
  const micros = (filter: SQL) =>
    sql`(coalesce(sum(usd) FILTER (WHERE ${filter}), 0) * 1000000)::bigint`;
  const res = await db.execute(sql`
    WITH spend AS (
      SELECT category, principal_kind, accounting_day, usd, false AS open FROM cost_ledger
        WHERE accounting_day >= ${from}::date AND accounting_day < ${to}::date
      UNION ALL
      SELECT category, principal_kind, accounting_day, usd, true AS open FROM reservations
        WHERE status = 'open' AND accounting_day >= ${from}::date AND accounting_day < ${to}::date
    )
    SELECT
      ${micros(sql`category = 'interactive' AND accounting_day < ${today}::date AND NOT open`)} AS settled_before,
      ${micros(sql`category = 'interactive' AND accounting_day < ${today}::date AND open`)} AS open_before,
      ${micros(sql`category = 'interactive' AND accounting_day = ${today}::date`)} AS today,
      ${micros(sql`category = 'interactive' AND accounting_day = ${today}::date AND principal_kind = 'trial'`)} AS anon_today,
      ${micros(sql`category = 'interactive'`)} AS interactive_month,
      ${micros(sql`category IN ('indexing', 'evaluation')`)} AS ingestion_month,
      ${micros(sql`true`)} AS total_month
    FROM spend`);
  const row = res.rows[0] as Record<string, string>;
  const n = (k: string) => Number(row[k]);
  return {
    interactive: {
      settledBeforeToday: n('settled_before'),
      openBeforeToday: n('open_before'),
      today: n('today'),
      anonymousToday: n('anon_today'),
      month: n('interactive_month'),
    },
    ingestionMonth: n('ingestion_month'),
    totalMonth: n('total_month'),
  };
}

export type BudgetPause = 'monthly_budget' | 'daily_budget';

export type InteractiveBudget =
  | { ok: true; allowanceMicros: number; anonymousOk: boolean }
  | { ok: false; pause: BudgetPause; retryAt: Date };

/** Whether one more interactive reservation of `reservation` µ$ fits today. */
export function checkInteractiveBudget(
  snap: SpendSnapshot,
  reservation: number,
  budgets: QuotaBudgets,
  now: Date,
): InteractiveBudget {
  const i = snap.interactive;
  if (
    snap.totalMonth + reservation > budgetMicros(budgets.monthlyUsd) ||
    i.month + reservation > budgetMicros(budgets.interactiveMonthlyUsd)
  ) {
    return { ok: false, pause: 'monthly_budget', retryAt: nextMonthStart(now) };
  }
  const allowance = allowanceMicros(now, i.settledBeforeToday, i.openBeforeToday, budgets);
  if (i.today + reservation > allowance) return { ok: false, pause: 'daily_budget', retryAt: nextUtcMidnight(now) };
  const anonymousCap = Math.floor(allowance * budgets.anonymousShare);
  return { ok: true, allowanceMicros: allowance, anonymousOk: i.anonymousToday + reservation <= anonymousCap };
}

/** µ$ still available this month to `category`, within the total monthly budget. */
export function remainingCategoryMicros(snap: SpendSnapshot, category: SpendCategory, budgets: QuotaBudgets): number {
  const total = budgetMicros(budgets.monthlyUsd) - snap.totalMonth;
  const own =
    category === 'interactive'
      ? budgetMicros(budgets.interactiveMonthlyUsd) - snap.interactive.month
      : budgetMicros(budgets.ingestionMonthlyUsd) - snap.ingestionMonth;
  return Math.max(0, Math.min(total, own));
}

/** USD still available this month to `category` (indexing and evaluation share one allowance). */
export async function remainingCategoryUsd(
  db: DbOrTx,
  category: SpendCategory,
  now: Date,
  budgets: QuotaBudgets,
): Promise<number> {
  return microsToUsd(remainingCategoryMicros(await spendSnapshot(db, now), category, budgets));
}
