/**
 * The attribution check's ticket on the evaluation ledger (`ledgerRankingSpendGate`, the design
 * review's money tests, task review M5): its own reservation and line, the restore hold, and cap
 * exhaustion under concurrency. Fake provider and retriever; the ledger is the real PostgreSQL one.
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, type Db } from '../../server/db/client.js';
import type { PinnedDataset } from '../../server/dataset.js';
import { approveCandidates, createFakeProvider, type FakeScript } from '../../server/ai/fake.js';
import { autoFilterPolicy } from '../../server/evidence/auto-filters.js';
import { rankEvidence } from '../../server/evidence/pipeline.js';
import { attributionWorstCaseUsd } from '../../server/evidence/pricing.js';
import { evidenceRankingConfig } from '../../server/evidence/ranking-config.js';
import type { EvidenceRetriever } from '../../server/evidence/retrieve.js';
import { ledgerRankingSpendGate, type RankingSpendGate, type RankingStage } from '../../server/evidence/spend.js';
import { quotaPolicy } from '../../server/quota/index.js';
import { loadConfig } from '../../shared/config.js';
import { syntheticEvidenceCases } from '../support/evidence-cases.js';
import { resetControls, testDb } from './helpers.js';

const BUDGETS = quotaPolicy({
  ai: loadConfig({ env: {}, files: [] }).ai,
  auth: { identityHmacSecret: 'test-identity-hmac-secret-0123456789', ipHmacSecret: 'test-network-hmac-secret-0123456789' },
}).budgets;
const QUESTION = 'Find helicopter accidents in Alaska during 2019.';
const SCOPE = { intent: 'case_search' as const, filters: { state: ['AK'], category: ['HELI'], yearFrom: 2019, yearTo: 2019 }, terms: 'engine' };
const attributed = autoFilterPolicy('attributed.v1');
const config = evidenceRankingConfig('er-q-v1');

let app: Db, ingest: Db, migrator: Db;
beforeAll(() => { app = testDb('app'); ingest = testDb('ingest'); migrator = testDb('migrator'); });
afterAll(async () => { await resetHold(); await Promise.all([closeDb(app), closeDb(ingest), closeDb(migrator)]); });
beforeEach(async () => { await resetControls(); await resetHold(); });
afterEach(async () => { await resetHold(); });

/** A migrated, never-restored database: this database's row, no hold (as tests/integration/restore-hold.test.ts). */
async function resetHold(): Promise<void> {
  await migrator.execute(sql`
    INSERT INTO paid_operations_hold (id, database_oid) SELECT 1, oid::bigint FROM pg_database WHERE datname = current_database()
    ON CONFLICT (id) DO UPDATE SET database_oid = EXCLUDED.database_oid, held_at = NULL, reconciled_at = NULL, note = NULL`);
}
/** What a restore into another database brings along: the row of the database the backup came from. */
const simulateRestore = () => migrator.execute(sql`UPDATE paid_operations_hold SET database_oid = database_oid + 1000 WHERE id = 1`);

function providers(script: FakeScript) {
  const llm = createFakeProvider({ evidenceScope: { output: SCOPE }, ...script });
  const cases = syntheticEvidenceCases(2);
  const search = vi.fn<EvidenceRetriever['search']>(async (_dataset, _plan, _signal, callback) => {
    callback?.({ model: 'text-embedding-3-small', dims: 1536, inputTemplate: 'query-v1', billing: 'reported', tokens: 12, usd: 0.00000024 });
    return { cases, ranking: cases.map(c => ({ ntsbNo: c.case.ntsbNo, seeds: [], channels: ['keyword' as const] })) };
  });
  return { llm, search, providers: { llm, retriever: { available: async () => true, search }, embeddingModel: 'text-embedding-3-small' } };
}
const input = () => ({ question: QUESTION, filters: {}, dataset: {} as PinnedDataset, signal: new AbortController().signal, autoFilters: attributed });
const reservations = async () => (await app.execute(sql`SELECT stage, status, usd::float AS reserved, charged_usd::float AS charged,
  uncertain, request_id FROM reservations WHERE category = 'evaluation' ORDER BY id`)).rows as
  { stage: string; status: string; reserved: number; charged: number | null; uncertain: boolean | null; request_id: string }[];

describe('the attribution ticket on the evaluation ledger', () => {
  it('reserves the check\'s worst case as its own stage and settles it at the actual usage', async () => {
    const h = providers({});
    const out = await rankEvidence(config, input(), h.providers, ledgerRankingSpendGate(ingest, BUDGETS, 'm5-ledger'));
    expect(out).toMatchObject({ attributionOutcome: 'applied', automaticFilters: SCOPE.filters });
    const line = out.usage.find(l => l.stage === 'attribution')!;
    const rows = await reservations();
    expect(rows.map(r => [r.stage, r.status, r.request_id])).toEqual([
      ['scope', 'settled', 'm5-ledger:1:scope'], ['attribution', 'settled', 'm5-ledger:2:attribution'], ['embed', 'settled', 'm5-ledger:3:embed']]);
    expect(rows[1]!.reserved).toBeCloseTo(attributionWorstCaseUsd(attributed.attribution!), 6);
    expect(rows[1]!.charged).toBeCloseTo(line.usd, 6);
    const lines = await app.execute(sql`SELECT stage, provider, model, uncertain FROM cost_ledger WHERE category = 'evaluation' ORDER BY id`);
    expect(lines.rows).toEqual([
      { stage: 'scope', provider: 'fake', model: 'claude-haiku-5-5', uncertain: false },
      { stage: 'attribution', provider: 'fake', model: 'claude-haiku-5-5', uncertain: false },
      { stage: 'embed', provider: 'openai', model: 'text-embedding-3-small', uncertain: false }]);
  });
  it('an unknown outcome keeps the check\'s whole reservation charged, as an uncertain line', async () => {
    const h = providers({ evidenceAttribution: { fail: 'timeout', billing: { kind: 'uncertain' } } });
    const out = await rankEvidence(config, input(), h.providers, ledgerRankingSpendGate(ingest, BUDGETS, 'm5-uncertain'));
    expect(out).toMatchObject({ attributionOutcome: 'timeout', automaticFilters: null });
    const row = (await reservations()).find(r => r.stage === 'attribution')!;
    expect(row).toMatchObject({ status: 'settled', uncertain: true });
    expect(row.charged).toBeCloseTo(attributionWorstCaseUsd(attributed.attribution!), 6);
    // The evaluation gate settles an unknown outcome as uncertain as a whole: one remainder line for the reservation.
    const lines = await app.execute(sql`SELECT l.stage, l.model, l.uncertain FROM cost_ledger l JOIN reservations r ON r.id = l.reservation_id
      WHERE r.stage = 'attribution'`);
    expect(lines.rows).toEqual([{ stage: 'uncertain', model: 'claude-haiku-5-5', uncertain: true }]);
  });
  it('a restore hold established during scope refuses the attribution ticket: nothing more is dispatched or reserved', async () => {
    const h = providers({ evidenceScope: async () => { await simulateRestore(); return { output: SCOPE }; } });
    await expect(rankEvidence(config, input(), h.providers, ledgerRankingSpendGate(ingest, BUDGETS, 'm5-hold')))
      .rejects.toMatchObject({ stage: 'spend' });
    expect(h.llm.calls.map(c => c.stage)).toEqual(['scope']);
    expect(h.search).not.toHaveBeenCalled();
    // The scope call that was already running settles; no other reservation exists.
    expect((await reservations()).map(r => [r.stage, r.status])).toEqual([['scope', 'settled']]);
  });
  it('concurrent searches never overspend the cap: once it is exhausted, the attribution ticket is refused before dispatch', async () => {
    // Three searches each settle scope at $0.0021; then $0.0015 is left, room for exactly one check ticket ($0.001025).
    const searches = 3, scopeUsd = 0.0021, budgets = { ...BUDGETS, ingestionMonthlyUsd: searches * scopeUsd + 0.0015 };
    // Every search reaches its check ticket only once all scope calls have settled, and the one check that is admitted
    // answers only once every ticket was decided, so the outcome does not depend on timing.
    let scopesSettled = 0, attempts = 0;
    let settledAll!: () => void, decidedAll!: () => void;
    const scopesDone = new Promise<void>(r => { settledAll = r; }), attemptsDone = new Promise<void>(r => { decidedAll = r; });
    const h = providers({ evidenceScope: { output: SCOPE, usage: { inputTokens: 9000, outputTokens: 2400, cacheWriteTokens: 0, cacheReadTokens: 0 } },
      evidenceAttribution: async request => { await attemptsDone; return approveCandidates(request); } });
    const coordinated = (gate: RankingSpendGate): RankingSpendGate => {
      const stages = new Map<unknown, RankingStage>();
      return {
        async reserve(call) {
          if (call.stage !== 'attribution') { const t = await gate.reserve(call); stages.set(t, call.stage); return t; }
          await scopesDone;
          try { const t = await gate.reserve(call); stages.set(t, call.stage); return t; }
          finally { if (++attempts === searches) decidedAll(); }
        },
        async settle(ticket, lines) {
          await gate.settle(ticket, lines);
          if (stages.get(ticket) === 'scope' && ++scopesSettled === searches) settledAll();
        },
      };
    };
    const runs = await Promise.allSettled(Array.from({ length: searches }, (_, i) =>
      rankEvidence(config, input(), h.providers, coordinated(ledgerRankingSpendGate(ingest, budgets, `m5-cap-${i}`)))));
    expect(runs.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of runs.filter(r => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ stage: 'spend' });
    // One check dispatched, with its ticket; the refused ones sent nothing.
    expect(h.llm.calls.map(c => c.stage).sort()).toEqual(['attribution', 'scope', 'scope', 'scope']);
    const rows = await reservations();
    expect(rows.filter(r => r.stage === 'attribution').map(r => r.status)).toEqual(['settled']);
    expect(rows.filter(r => r.stage === 'scope').map(r => r.status)).toEqual(['settled', 'settled', 'settled']);
    expect(rows.every(r => r.status !== 'open')).toBe(true);
    const charged = rows.reduce((n, r) => n + (r.charged ?? 0), 0);
    expect(charged).toBeLessThanOrEqual(budgets.ingestionMonthlyUsd + 1e-9);
  });
});
