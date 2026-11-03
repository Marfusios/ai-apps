/** Capped task supervision around the production PostgreSQL spend gate (Task 25, reused by Task 29); no budget settings are persisted. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { spendSnapshot, toMicros } from '../../server/quota/pacing.js';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import { createLedgerSpendGate, type SpendGate, type SpendReservation } from '../../worker/index/spend-gate.js';
import { appendDurable, EvaluationError } from '../search-quality/money.js';
import type { EvaluationSettings } from '../search-quality/config.js';
import { TASK_CAP_MICROS } from './data.js';

/** One task's own ledger prefix, advisory lock and hard cap. A new task never reuses another's. */
export interface TaskSpec { allocation: string; lockKey: number; capMicros: number; label: string; probeStage: string; applicationName: string }
export const TASK25: TaskSpec = { allocation: 'eval-task25', lockKey: 732500025, capMicros: TASK_CAP_MICROS, label: 'Task 25',
  probeStage: 'task25_preflight', applicationName: 'aircase-task25-evaluation' };
export const ALLOCATION = TASK25.allocation;
export const LOCK_KEY = TASK25.lockKey;
export interface Totals { chargedMicros: number; ledgerMicros: number; openMicros: number; open: number; reservations: number }
export function decimalMicros(v: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(v)) throw new EvaluationError('Invalid ledger amount');
  const [whole, fraction = ''] = v.split('.');
  const n = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(n)) throw new EvaluationError('Ledger amount exceeds integer range');
  return n;
}
export function checkTaskCap(t: Totals, proposed: number, task: TaskSpec = TASK25) {
  if ([...Object.values(t), proposed].some(x => !Number.isSafeInteger(x) || x < 0) || proposed === 0) throw new EvaluationError('Invalid allocation arithmetic');
  if (t.open || t.openMicros) throw new EvaluationError(`${task.label} has unresolved reservations; reconcile without retrying providers`);
  if (t.chargedMicros !== t.ledgerMicros) throw new EvaluationError(`${task.label} ledger and reservations disagree`);
  if (t.chargedMicros + proposed > task.capMicros) throw new EvaluationError(`${task.label} hard $${(task.capMicros / 1e6).toFixed(2)} cap would be exceeded`);
}
export async function taskTotals(db: Db, task: TaskSpec = TASK25): Promise<Totals> {
  const pattern = `${task.allocation}:%`;
  const result = await db.execute(sql`select count(*)::int as reservations,
    count(*) filter(where status='open')::int as open,
    coalesce(sum(usd) filter(where status='open'),0)::text as open_usd,
    coalesce(sum(charged_usd) filter(where status<>'open'),0)::text as charged_usd,
    (select coalesce(sum(usd),0)::text from cost_ledger where category='evaluation' and request_id like ${pattern}) as ledger_usd
    from reservations where category='evaluation' and request_id like ${pattern}`);
  const r = result.rows[0]!;
  return { reservations: Number(r.reservations), open: Number(r.open), openMicros: decimalMicros(String(r.open_usd)),
    chargedMicros: decimalMicros(String(r.charged_usd)), ledgerMicros: decimalMicros(String(r.ledger_usd)) };
}
export class CappedAllocation {
  private poisoned = false;
  private reserving = false;
  private current: SpendReservation | null = null;
  private constructor(readonly db: Db, readonly config: AppConfig, private lock: pg.PoolClient, private directory: string, readonly task: TaskSpec) {}
  static async open(settings: EvaluationSettings, directory: string, task: TaskSpec = TASK25) {
    const url = settings.config.databaseIngestUrl;
    if (settings.config.appEnv !== 'dev' || !url || new URL(url).pathname !== '/aviation_dev') throw new EvaluationError(`${task.label} requires the development ledger`);
    const db = createDb(url, { max: 3, applicationName: task.applicationName });
    let client: pg.PoolClient | undefined;
    try {
      client = await db.$client.connect();
      const identity = await client.query('select current_database() as database');
      if (identity.rows[0]?.database !== 'aviation_dev') throw new EvaluationError('Wrong database; no task lock or reservation attempted');
      const r = await client.query('select pg_try_advisory_lock($1) as locked', [task.lockKey]);
      if (!r.rows[0]?.locked) throw new EvaluationError(`${task.label} evaluator already running`);
      const monthly = await spendSnapshot(db, new Date());
      const prior = await taskTotals(db, task);
      // Other caps stay unchanged. The category allowance covers only remaining task liability.
      const remaining = Math.max(0, task.capMicros - prior.chargedMicros - prior.openMicros);
      const categoryUsd = Math.min(50, (monthly.ingestionMonth + remaining) / 1e6);
      const config = loadConfig({ env: { ...settings.env, AI_INGESTION_MONTHLY_BUDGET_USD: String(categoryUsd) } });
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (prior.open || prior.openMicros || prior.chargedMicros !== prior.ledgerMicros) throw new EvaluationError(`Unreconciled prior ${task.label} spend`);
      appendDurable(join(directory, 'allocation.jsonl'), { event: 'open', at: new Date().toISOString(), task: task.allocation,
        lockKey: task.lockKey, capMicros: task.capMicros, prior, categoryBudgetMicros: toMicros(categoryUsd) });
      return new CappedAllocation(db, config, client, directory, task);
    } catch (e) {
      if (client) { await client.query('select pg_advisory_unlock($1)', [task.lockKey]).catch(() => undefined); client.release(); }
      await closeDb(db); throw e;
    }
  }
  private async assertLock() {
    if (this.poisoned) throw new EvaluationError('Accounting or task lock failed; no further dispatch');
    try {
      const r = await this.lock.query(`select exists(select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid()
        and classid=0 and objid=$1 and granted) as locked`, [this.task.lockKey]);
      if (!r.rows[0]?.locked) throw new Error('missing');
    } catch { this.poisoned = true; throw new EvaluationError(`${this.task.label} advisory lock lost`); }
  }
  async assertBlock(reserveMicros: number) {
    await this.assertLock();
    checkTaskCap(await taskTotals(this.db, this.task), reserveMicros, this.task);
    const probe = createLedgerSpendGate(this.db, { budgets: this.config.ai.budgets, provider: 'allocation', model: 'preflight', stage: this.task.probeStage });
    if (toMicros(await probe.remainingUsd('evaluation')) < reserveMicros) throw new EvaluationError('Category or global allowance cannot cover the complete block');
  }
  gate(phase: string, hash: string, provider: string, model: string, stage: string): SpendGate {
    if (!['selection', 'confirmation'].includes(phase) || !/^[a-f0-9]{64}$/.test(hash)) throw new EvaluationError(`Invalid ${this.task.label} run identity`);
    const gate = createLedgerSpendGate(this.db, { budgets: this.config.ai.budgets, provider, model, stage, ttlMs: 300_000 });
    return {
      reserve: async req => {
        if (this.reserving || this.current) throw new EvaluationError(`Concurrent ${this.task.label} reservation forbidden`);
        this.reserving = true;
        try {
          await this.assertLock();
          if (req.category !== 'evaluation' || !/^[A-Za-z0-9_.:-]{1,110}$/.test(req.purpose)) throw new EvaluationError('Invalid evaluation reservation');
          const purpose = `${this.task.allocation}:${phase}:${hash.slice(0, 12)}:${req.purpose}`;
          const dup = await this.db.execute(sql`select id from reservations where category='evaluation' and request_id=${purpose} limit 1`);
          if (dup.rows.length) throw new EvaluationError('Attempt already reserved; no second provider dispatch');
          checkTaskCap(await taskTotals(this.db, this.task), toMicros(req.usd), this.task);
          const reservation = await gate.reserve({ ...req, purpose });
          this.current = reservation;
          try { appendDurable(join(this.directory, 'allocation.jsonl'), { event: 'reserved', purpose, reservationId: reservation.reservationId,
            reserveMicros: toMicros(req.usd), provider, model, stage, at: new Date().toISOString() }); }
          catch { await gate.settle(reservation, { usd: 0 }).catch(() => undefined); this.poisoned = true; throw new EvaluationError('Journal failed before provider dispatch'); }
          return reservation;
        } finally { this.reserving = false; }
      },
      settle: async (reservation, outcome) => {
        if (this.current?.reservationId !== reservation.reservationId) throw new EvaluationError(`Unexpected ${this.task.label} settlement`);
        try {
          await gate.settle(reservation, outcome);
          appendDurable(join(this.directory, 'allocation.jsonl'), { event: 'settled', reservationId: reservation.reservationId, outcome, at: new Date().toISOString() });
          this.current = null;
        } catch { this.poisoned = true; throw new EvaluationError(`${this.task.label} settlement requires reconciliation`); }
      },
      remainingUsd: async category => {
        const t = await taskTotals(this.db, this.task);
        return Math.max(0, Math.min(await gate.remainingUsd(category), (this.task.capMicros - t.chargedMicros - t.openMicros) / 1e6));
      },
    };
  }
  async close() {
    try {
      const t = await taskTotals(this.db, this.task);
      const balanced = !this.poisoned && !this.current && !this.reserving && !t.open && !t.openMicros && t.chargedMicros === t.ledgerMicros;
      appendDurable(join(this.directory, 'allocation.jsonl'), { event: 'close', at: new Date().toISOString(), total: t, balanced });
      if (!balanced || t.chargedMicros > this.task.capMicros) throw new EvaluationError(`${this.task.label} ledger requires reconciliation`);
      return t;
    } finally {
      await this.lock.query('select pg_advisory_unlock($1)', [this.task.lockKey]).catch(() => undefined);
      this.lock.release(); await closeDb(this.db);
    }
  }
}
/** Task 25's name for its allocation, kept for its runner and tests. */
export { CappedAllocation as Task25Allocation };
