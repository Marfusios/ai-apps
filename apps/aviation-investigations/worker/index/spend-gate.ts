/**
 * Spend gate for metered provider calls (amendment A7).
 *
 * Every paid attempt reserves its maximum cost before it is dispatched and settles
 * afterwards: with the actual cost, with zero when the provider certainly rejected
 * the request, or as `uncertain`, which keeps the whole reservation charged. Retries
 * are separate attempts with their own reservations. Indexing and evaluation share
 * one allowance (`AI_INGESTION_MONTHLY_BUDGET_USD`).
 *
 * The PostgreSQL ledger (`cost_ledger`, `reservations`) is built in Task 15;
 * `createLedgerSpendGate` is wired to its `reserveSpend`, `settleSpend` and
 * `remainingCategoryUsd` when the branches merge. Until then it throws, so a paid run
 * fails closed before any request.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../../server/db/client.js';

export type SpendCategory = 'indexing' | 'evaluation';

export interface SpendReservation {
  reservationId: string;
  fencingToken: string;
}

export type SpendOutcome = { usd: number } | 'uncertain';

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

/** The PostgreSQL ledger gate (Task 15). Throws until it is wired at merge, so paid runs fail closed. */
export function createLedgerSpendGate(db: Db): SpendGate {
  void db;
  throw new Error(
    'the spend ledger is wired at merge (Task 15: reserveSpend, settleSpend, remainingCategoryUsd); paid indexing is disabled until then',
  );
}
