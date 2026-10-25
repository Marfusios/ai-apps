/** One Task 24 lock and allocation across fields, A/B and judges; production ledger only. */
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, type Db } from '../../server/db/client.js';
import { spendSnapshot, toMicros } from '../../server/quota/pacing.js';
import { createLedgerSpendGate, type SpendGate, type SpendReservation, type SpendOutcome } from '../../worker/index/spend-gate.js';
import { loadConfig, type AppConfig } from '../../shared/config.js';
import type { EvaluationSettings } from './config.js';

export const TASK_ALLOCATION = 'eval-task24';
export const TASK_LOCK_KEY = 732400024;
export const TASK_CAP_MICROS = 30_000_000;
export const PHASE_CAP_MICROS = { selection: 9_000_000, confirmation: 12_000_000, fields: 3_000_000, narrative: 5_000_000 } as const;
export type Phase = keyof typeof PHASE_CAP_MICROS;
export interface Totals { chargedMicros: number; openMicros: number; open: number; reservations: number; ledgerMicros: number }
export class EvaluationError extends Error { override name = 'EvaluationError'; }
export function checkAllocation(total: Totals, phase: Totals, phaseName: Phase, reserveMicros: number) {
  for (const t of [total, phase]) {
    if (Object.values(t).some(v => !Number.isSafeInteger(v) || v < 0)) throw new EvaluationError('Invalid allocation totals');
    if (t.open || t.openMicros) throw new EvaluationError('Unresolved reservation; stop and reconcile before dispatch');
    if (t.chargedMicros !== t.ledgerMicros) throw new EvaluationError('Ledger and reservation totals disagree');
  }
  if (!Number.isSafeInteger(reserveMicros) || reserveMicros <= 0) throw new EvaluationError('Invalid proposed reservation');
  if (total.chargedMicros + total.openMicros + reserveMicros > TASK_CAP_MICROS) throw new EvaluationError('Task 24 $30 cap would be exceeded');
  if (phase.chargedMicros + phase.openMicros + reserveMicros > PHASE_CAP_MICROS[phaseName]) throw new EvaluationError('Task 24 phase cap would be exceeded');
}
export function appendDurable(path: string, value: unknown) {
  appendFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 });
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export async function allocationTotals(db: Db, phase?: Phase): Promise<Totals> {
  const pattern = phase ? `${TASK_ALLOCATION}:${phase}:%` : `${TASK_ALLOCATION}:%`;
  const r = await db.execute(sql`select count(*)::int as reservations,
    count(*) filter(where status='open')::int as open,
    coalesce(sum(usd) filter(where status='open'),0)::text as open_usd,
    coalesce(sum(charged_usd) filter(where status<>'open'),0)::text as charged_usd,
    (select coalesce(sum(usd),0)::text from cost_ledger where category='evaluation' and request_id like ${pattern}) as ledger_usd
    from reservations where category='evaluation' and request_id like ${pattern}`);
  const row = r.rows[0]!;
  return { reservations: Number(row.reservations), open: Number(row.open), openMicros: toMicros(Number(row.open_usd)),
    chargedMicros: toMicros(Number(row.charged_usd)), ledgerMicros: toMicros(Number(row.ledger_usd)) };
}

export class TaskAllocation {
  private poisoned = false;
  private reserving = false;
  private current: { reservation: SpendReservation; gate: SpendGate; phase: Phase } | null = null;
  private constructor(readonly db: Db, readonly config: AppConfig, readonly directory: string, private lock: pg.PoolClient) {}

  static async open(settings: EvaluationSettings, directory: string): Promise<TaskAllocation> {
    const url = settings.config.databaseIngestUrl;
    if (settings.config.appEnv !== 'dev' || !url || new URL(url).pathname !== '/aviation_dev') throw new EvaluationError('Development ingestion-role ledger required');
    const db = createDb(url, { max: 3, applicationName: 'aircase-task24-evaluation' });
    let client: pg.PoolClient | undefined;
    try {
      client = await db.$client.connect();
      const r = await client.query('select current_database() as database, pg_try_advisory_lock($1) as locked', [TASK_LOCK_KEY]);
      if (r.rows[0]?.database !== 'aviation_dev' || !r.rows[0]?.locked) throw new EvaluationError('Wrong database or Task 24 lock held by another evaluator');
      const monthly = await spendSnapshot(db, new Date());
      // Explicit owner-approved run-local environment override; other budgets are preserved.
      const ingestionMonthly = Math.min(50, (monthly.ingestionMonth + TASK_CAP_MICROS) / 1e6);
      const config = loadConfig({ env: { ...settings.env, AI_INGESTION_MONTHLY_BUDGET_USD: String(ingestionMonthly) } });
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const allocation = new TaskAllocation(db, config, directory, client);
      const total = await allocationTotals(db);
      if (total.open || total.openMicros || total.chargedMicros !== total.ledgerMicros) throw new EvaluationError('Unreconciled prior Task 24 spend');
      appendDurable(join(directory, 'allocation.jsonl'), { event: 'open', at: new Date().toISOString(), lockKey: TASK_LOCK_KEY,
        task: TASK_ALLOCATION, total, categorySpendMicros: monthly.ingestionMonth, ingestionMonthlyUsd: ingestionMonthly });
      return allocation;
    } catch (e) {
      if (client) { await client.query('select pg_advisory_unlock($1)', [TASK_LOCK_KEY]).catch(() => undefined); client.release(); }
      await closeDb(db); throw e;
    }
  }

  async assertBlock(phase: Phase, reserveMicros: number) {
    await this.assertLock();
    checkAllocation(await allocationTotals(this.db), await allocationTotals(this.db, phase), phase, reserveMicros);
    const probe = createLedgerSpendGate(this.db, { budgets: this.config.ai.budgets, provider: 'allocation', model: 'preflight', stage: 'task24_preflight' });
    if (toMicros(await probe.remainingUsd('evaluation')) < reserveMicros) throw new EvaluationError('Category or global allowance cannot cover the complete block');
  }

  private async assertLock() {
    if (this.poisoned) throw new EvaluationError('Accounting or lock failed; no further dispatch');
    try {
      const r = await this.lock.query(`select exists(select 1 from pg_locks where locktype='advisory' and pid=pg_backend_pid()
        and classid=0 and objid=$1 and granted) as locked`, [TASK_LOCK_KEY]);
      if (!r.rows[0]?.locked) throw new Error('lock missing');
    } catch { this.poisoned = true; throw new EvaluationError('Task 24 database lock lost'); }
  }

  /** The only injected gate for all Task 24 provider paths. Sequential, no automatic retry. */
  gate(phase: Phase, runHash: string, provider: string, model: string, stage: string): SpendGate {
    if (!/^[a-f0-9]{64}$/.test(runHash)) throw new EvaluationError('Frozen run hash required');
    const underlying = createLedgerSpendGate(this.db, { budgets: this.config.ai.budgets, provider, model, stage, ttlMs: 300_000 });
    return {
      reserve: async req => {
        if (this.reserving || this.current) throw new EvaluationError('Concurrent Task 24 reservation forbidden');
        this.reserving = true;
        try {
        await this.assertLock();
        if (req.category !== 'evaluation' || this.current) throw new EvaluationError('Only one Task 24 evaluation attempt may be active');
        if (!/^[A-Za-z0-9_.:-]{1,110}$/.test(req.purpose)) throw new EvaluationError('Invalid content-free attempt identity');
        const purpose = `${TASK_ALLOCATION}:${phase}:${runHash.slice(0, 12)}:${req.purpose}`;
        const duplicate = await this.db.execute(sql`select id from reservations where category='evaluation' and request_id=${purpose} limit 1`);
        if (duplicate.rows.length) throw new EvaluationError('Attempt already reserved; never dispatch it again');
        checkAllocation(await allocationTotals(this.db), await allocationTotals(this.db, phase), phase, toMicros(req.usd));
        const reservation = await underlying.reserve({ ...req, purpose });
        this.current = { reservation, gate: underlying, phase };
        try {
          appendDurable(join(this.directory, 'allocation.jsonl'), { event: 'reserved', phase, purpose,
            reservationId: reservation.reservationId, reserveMicros: toMicros(req.usd), provider, model, stage, at: new Date().toISOString() });
        } catch {
          await underlying.settle(reservation, { usd: 0 }).catch(() => undefined);
          this.poisoned = true; throw new EvaluationError('Reservation journal failed before provider dispatch');
        }
        return reservation;
        } finally { this.reserving = false; }
      },
      settle: async (reservation: SpendReservation, outcome: SpendOutcome) => {
        if (this.current?.reservation.reservationId !== reservation.reservationId) throw new EvaluationError('Unexpected settlement');
        try {
          await underlying.settle(reservation, outcome);
          appendDurable(join(this.directory, 'allocation.jsonl'), { event: 'settled', reservationId: reservation.reservationId,
            phase, outcome, at: new Date().toISOString() });
          this.current = null;
        } catch { this.poisoned = true; throw new EvaluationError('Settlement failed; retained result must be reconciled'); }
      },
      remainingUsd: async category => {
        const total = await allocationTotals(this.db);
        const part = await allocationTotals(this.db, phase);
        return Math.max(0, Math.min(await underlying.remainingUsd(category),
          (TASK_CAP_MICROS - total.chargedMicros - total.openMicros) / 1e6,
          (PHASE_CAP_MICROS[phase] - part.chargedMicros - part.openMicros) / 1e6));
      },
    };
  }

  async close() {
    try {
      const total = await allocationTotals(this.db);
      appendDurable(join(this.directory, 'allocation.jsonl'), { event: 'close', total, balanced: !this.poisoned && !this.current && total.open === 0 && total.chargedMicros === total.ledgerMicros });
      if (this.current || this.reserving || total.open || total.chargedMicros !== total.ledgerMicros || this.poisoned) throw new EvaluationError('Task 24 accounting requires reconciliation');
      return total;
    } finally {
      await this.lock.query('select pg_advisory_unlock($1)', [TASK_LOCK_KEY]).catch(() => undefined);
      this.lock.release(); await closeDb(this.db);
    }
  }
}
