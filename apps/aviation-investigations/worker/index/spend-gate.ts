/**
 * Spend gate for metered provider calls (amendment A7).
 *
 * Every paid attempt reserves its maximum cost before it is dispatched and settles
 * afterwards: with the actual cost, with zero when the provider certainly rejected
 * the request, or as `uncertain`, which keeps the whole reservation charged. Retries
 * are separate attempts with their own reservations. Indexing and evaluation share
 * one allowance (`AI_INGESTION_MONTHLY_BUDGET_USD`).
 *
 * `createLedgerSpendGate` meters through the PostgreSQL ledger (`reservations`,
 * `cost_ledger`; `server/quota/spend.ts`): `reserveSpend`, `settleSpend` and
 * `remainingCategoryUsd`. A ledger lock wait that times out (`busy`) is retried a
 * bounded number of times; after that the gate refuses (reserve) or fails (settle),
 * and an unsettled reservation stays charged in full until its lease expires.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../../server/db/client.js';
import { remainingCategoryUsd } from '../../server/quota/pacing.js';
import type { QuotaBudgets } from '../../server/quota/policy.js';
import { reserveSpend, settleSpend } from '../../server/quota/spend.js';

export type SpendCategory = 'indexing' | 'evaluation';

export interface SpendReservation {
  reservationId: string;
  fencingToken: string;
}

/** The actual cost (with the billed tokens when known), or `uncertain`: charged at the full reservation. */
export type SpendOutcome = { usd: number; tokens?: number } | 'uncertain';

export interface SpendGate {
  /** Reserve `usd` before dispatch; throws `SpendRefusedError` when it does not fit. */
  reserve(req: { category: SpendCategory; usd: number; purpose: string }): Promise<SpendReservation>;
  /** Settle a reservation once: the actual cost, or `uncertain` (charged at the full reservation). */
  settle(res: SpendReservation, outcome: SpendOutcome): Promise<void>;
  /** Money left in the category's allowance after settled charges and open reservations. */
  remainingUsd(category: SpendCategory): Promise<number>;
}

export class SpendRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpendRefusedError';
  }
}

/** Round a USD amount up to the ledger's precision (micro-dollars), so a reservation never undershoots. */
export function ceilUsd(usd: number): number {
  // The small epsilon keeps float noise (0.0000020000000001) from adding a micro-dollar.
  return Math.max(0, Math.ceil(usd * 1e6 - 1e-6) / 1e6);
}

function checkUsd(usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`invalid USD amount: ${usd}`);
}

export interface SpendRecord {
  reservationId: string;
  category: SpendCategory;
  purpose: string;
  reservedUsd: number;
  status: 'open' | 'settled' | 'uncertain';
  /** Charged amount: the actual cost once settled, the full reservation while open or uncertain. */
  chargedUsd: number;
}

export interface MemorySpendGate extends SpendGate {
  /** Every reservation in order (tests and run reports). */
  readonly records: readonly SpendRecord[];
  /** Charged total of a category: settled costs plus open and uncertain reservations. */
  chargedUsd(category: SpendCategory): number;
}

/**
 * In-memory gate (tests, and the shape the ledger must honour): indexing and
 * evaluation share `allowanceUsd`; open and uncertain reservations count in full.
 */
export function createMemorySpendGate(allowanceUsd: number): MemorySpendGate {
  checkUsd(allowanceUsd);
  const records: SpendRecord[] = [];
  const tokens = new Map<string, string>();
  const charged = () => records.reduce((sum, r) => sum + r.chargedUsd, 0);
  return {
    records,
    chargedUsd: (category) => records.filter((r) => r.category === category).reduce((sum, r) => sum + r.chargedUsd, 0),
    async reserve({ category, usd, purpose }) {
      checkUsd(usd);
      const reserved = ceilUsd(usd);
      if (charged() + reserved > allowanceUsd + 1e-9) {
        throw new SpendRefusedError(
          `${category} spend of $${reserved.toFixed(6)} refused: $${Math.max(0, allowanceUsd - charged()).toFixed(6)} left of $${allowanceUsd}`,
        );
      }
      const reservationId = randomUUID();
      const fencingToken = randomUUID();
      tokens.set(reservationId, fencingToken);
      records.push({ reservationId, category, purpose, reservedUsd: reserved, status: 'open', chargedUsd: reserved });
      return { reservationId, fencingToken };
    },
    async settle(res, outcome) {
      const r = records.find((x) => x.reservationId === res.reservationId);
      if (!r || tokens.get(res.reservationId) !== res.fencingToken) throw new Error(`unknown reservation ${res.reservationId}`);
      if (r.status !== 'open') throw new Error(`reservation ${res.reservationId} is already ${r.status}`);
      if (outcome === 'uncertain') {
        r.status = 'uncertain';
        r.chargedUsd = r.reservedUsd;
        return;
      }
      checkUsd(outcome.usd);
      r.status = 'settled';
      r.chargedUsd = ceilUsd(outcome.usd);
    },
    async remainingUsd() {
      return Math.max(0, allowanceUsd - charged());
    },
  };
}

/**
 * Gate for dry runs: nothing can be reserved or settled, so a dry run can never
 * dispatch a paid request. `remainingUsd` reads through to `readFrom` when given.
 */
export function createDryRunSpendGate(readFrom?: SpendGate): SpendGate {
  return {
    async reserve() {
      throw new SpendRefusedError('dry run: paid requests are not allowed');
    },
    async settle() {
      throw new SpendRefusedError('dry run: nothing to settle');
    },
    async remainingUsd(category) {
      if (!readFrom) throw new Error('dry run: no ledger to read the remaining budget from');
      return readFrom.remainingUsd(category);
    },
  };
}

export interface LedgerSpendGateOptions {
  budgets: QuotaBudgets;
  /** Labels copied to the reservation and its ledger lines (no content). */
  provider: string;
  model: string;
  /** Lower-case stage label, e.g. `embed`. */
  stage: string;
  /** Lease of one reservation (default 5 minutes; an attempt settles within its request timeout). */
  ttlMs?: number;
  /** Retries of a `busy` ledger (default 5), with a doubling delay from `busyDelayMs` (default 500 ms). */
  busyRetries?: number;
  busyDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const REQUEST_ID = /[^A-Za-z0-9_.:-]+/g;

/** The spend gate on the PostgreSQL ledger (amendment A7). */
export function createLedgerSpendGate(db: Db, opts: LedgerSpendGateOptions): SpendGate {
  const retries = opts.busyRetries ?? 5;
  const delay = opts.busyDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const whileBusy = async <T extends { ok: boolean }>(call: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i += 1) {
      const r = await call();
      if (r.ok || (r as { reason?: string }).reason !== 'busy' || i >= retries) return r;
      await sleep(delay * 2 ** i);
    }
  };
  return {
    async reserve({ category, usd, purpose }) {
      checkUsd(usd);
      const amount = Math.max(ceilUsd(usd), 0.000001);
      const r = await whileBusy(() =>
        reserveSpend(db, {
          category,
          usd: amount,
          request: {
            provider: opts.provider,
            model: opts.model,
            stage: opts.stage,
            requestId: purpose.replace(REQUEST_ID, '-').slice(0, 200) || undefined,
          },
          budgets: opts.budgets,
          now: now(),
          ttlMs: opts.ttlMs ?? 5 * 60_000,
        }),
      );
      if (r.ok) return { reservationId: String(r.reservationId), fencingToken: r.fencingToken };
      if (r.reason === 'busy') throw new SpendRefusedError(`${category} spend of $${amount.toFixed(6)} refused: the ledger stayed busy`);
      if (r.reason === 'restore_hold') {
        throw new SpendRefusedError(
          `${category} spend of $${amount.toFixed(6)} refused: paid operations are held after a restore (pnpm worker restore-reconcile, RUNBOOK "Backups")`,
        );
      }
      throw new SpendRefusedError(
        `${category} spend of $${amount.toFixed(6)} refused (${r.reason}): $${r.remainingUsd.toFixed(6)} left until ${r.retryAt.toISOString()}`,
      );
    },
    async settle(res, outcome) {
      const id = Number(res.reservationId);
      if (!Number.isSafeInteger(id)) throw new Error(`unknown reservation ${res.reservationId}`);
      const usage =
        outcome === 'uncertain'
          ? ('uncertain' as const)
          : {
              lines: [
                {
                  usd: (checkUsd(outcome.usd), outcome.usd),
                  provider: opts.provider,
                  model: opts.model,
                  stage: opts.stage,
                  ...(outcome.tokens !== undefined ? { tokens: { input: outcome.tokens } } : {}),
                },
              ],
            };
      const r = await whileBusy(() => settleSpend(db, { reservationId: id }, usage, res.fencingToken, now()));
      if (!r.ok) {
        // The reservation stays charged in full (open until its lease expires, or already expired).
        throw new Error(`reservation ${id} could not be settled: ${r.reason}`);
      }
    },
    async remainingUsd(category) {
      return remainingCategoryUsd(db, category, now(), opts.budgets);
    },
  };
}
