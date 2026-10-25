import type { LlmProviderName } from '../ai/provider.js';
/** Per-stage admission shared by HTTP's existing reservation and ledger-backed evaluation. */
import type { Db } from '../db/client.js';
import type { Admission } from '../quota/admit.js';
import type { QuotaBudgets } from '../quota/policy.js';
import type { SpendLine } from '../quota/settle.js';
import { createLedgerSpendGate, type SpendGate, type SpendReservation } from '../../worker/index/spend-gate.js';

export type RankingStage = 'scope' | 'embed' | 'rerank';
export interface RankingCall { stage: RankingStage; provider: LlmProviderName; model: string; worstCaseUsd: number }
export interface RankingSpendGate {
  reserve(call: RankingCall): Promise<unknown>;
  settle(ticket: unknown, lines: readonly SpendLine[]): Promise<void>;
}
export class RankingSpendError extends Error {
  constructor() { super('evidence spend gate unavailable'); }
}
/** No second DB reservation: the route already admitted the complete stage sum. Final
 * settlement and search storage still commit atomically. Pending calls stay conservative. */
export function admittedRankingSpendGate(admission: Admission) {
  const calls = new Map<RankingStage, { call: RankingCall; lines?: readonly SpendLine[] }>();
  const gate: RankingSpendGate = {
    async reserve(call) {
      if (calls.has(call.stage) || !Number.isFinite(call.worstCaseUsd) || call.worstCaseUsd < 0 ||
          [...calls.values()].reduce((sum, c) => sum + c.call.worstCaseUsd, call.worstCaseUsd) > admission.reservationUsd + 1e-9) throw new RankingSpendError();
      const ticket = { call }; calls.set(call.stage, ticket); return ticket;
    },
    async settle(ticket, lines) {
      const entry = [...calls.values()].find(e => e === ticket);
      if (!entry || entry.lines) throw new RankingSpendError();
      entry.lines = [...lines];
    },
  };
  return { gate, lines: (): SpendLine[] => [...calls.values()].flatMap(e => e.lines ?? [{ stage: e.call.stage,
    provider: e.call.provider, model: e.call.model, usd: e.call.worstCaseUsd, uncertain: true }]) };
}
/** Allows an evaluation allocation wrapper to supply the production gate per model/stage. */
export function evaluationRankingSpendGate(gateFor: (call: RankingCall) => SpendGate, runId: string): RankingSpendGate {
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(runId)) throw new Error('invalid ranking run id');
  const tickets = new Map<unknown, { gate: SpendGate; reservation: SpendReservation }>();
  let counter = 0;
  return {
    async reserve(call) {
      const gate = gateFor(call);
      const reservation = await gate.reserve({ category: 'evaluation', usd: call.worstCaseUsd, purpose: `${runId}:${++counter}:${call.stage}` });
      const ticket = {}; tickets.set(ticket, { gate, reservation }); return ticket;
    },
    async settle(ticket, lines) {
      const entry = tickets.get(ticket);
      if (!entry) throw new RankingSpendError();
      // An uncertain attempt keeps its own full stage reservation, never the request's sum.
      await entry.gate.settle(entry.reservation, lines.some(l => l.uncertain) ? 'uncertain' : {
        usd: lines.reduce((sum, l) => sum + l.usd, 0),
        tokens: lines.reduce((sum, l) => sum + Object.entries(l.tokens ?? {}).reduce((n, [key, v]) => n + (key === 'thinkingTokens' ? 0 : v), 0), 0),
      });
      tickets.delete(ticket);
    },
  };
}
/** Uses reserveSpend/settleSpend, the shared evaluation allowance and restore hold. */
export const ledgerRankingSpendGate = (db: Db, budgets: QuotaBudgets, runId: string): RankingSpendGate =>
  evaluationRankingSpendGate(call => createLedgerSpendGate(db, { budgets, provider: call.provider, model: call.model, stage: call.stage }), runId);
