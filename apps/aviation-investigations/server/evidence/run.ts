/** One admitted evidence search. No path here can call compose or check. */
import { and, eq, inArray } from 'drizzle-orm';
import { rankEvidence, RankingFailure, vectorText, type LexicalSource, type RankingPhase } from './pipeline.js';
import { disclosedQuery, questionQuery, remainingSuggestion } from './disclosure.js';
import { autoFilterPolicy } from './auto-filters.js';
import { evidenceRankingConfig } from './ranking-config.js';
import { admittedRankingSpendGate } from './spend.js';
import { cases, evidenceSearches } from '../db/schema/index.js';
import type { PinnedDataset } from '../dataset.js';
import { evidenceRoute } from './routing.js';
import { releaseQuota, type Admission } from '../quota/admit.js';
import { settle } from '../quota/settle.js';
import { startRequestSpan } from '../observability/tracing.js';
import type { ApiContext } from '../routes/context.js';
import { withSuggestion, finishSearch, pageOf, type EvidenceRow, type SearchData } from './store.js';

/** Failures expose only a fixed category; no upstream error, scope output, text or keys. */
export class EvidenceFailure extends Error {
  constructor(readonly category: 'scope' | 'retrieval' | 'storage' | 'stopped') { super(`evidence search failed: ${category}`); }
}

export async function runEvidence(ctx: ApiContext, row: EvidenceRow, pinned: PinnedDataset, admission: Admission,
  signal: AbortSignal): Promise<void> {
  const ai = ctx.ai!, services = ctx.evidence!;
  const llm = ai.llm!, policy = ai.policy!;
  const config = ai.evidenceRanking ?? evidenceRankingConfig();
  const meter = admittedRankingSpendGate(admission);
  let active: RankingPhase | 'storage' = 'scope';
  let finalData: SearchData = { ...row.data, note: null, rerankOutcome: config.rerank ? 'not_run' : 'disabled' };
  let execution: Partial<SearchData> = {};
  let outcome: 'results' | 'failed' = 'failed';
  let failed = false;
  const failureData = (): SearchData => {
    // Only a completed result may replace the admitted public query/filter facts.
    // Keep private execution diagnostics on failure without preventing settlement
    // under the immutable-row guard (including a rejected/oversized projection).
    const { query: _query, appliedFilters: _filters, automaticFilters: _automatic, ...facts } = execution;
    return { ...row.data, rerankOutcome: config.rerank ? 'not_run' : 'disabled', ...facts,
      ...(execution.automaticFilters !== undefined ? { diagnostics: { automaticFilters: execution.automaticFilters, appliedFilters: execution.appliedFilters ?? row.data.appliedFilters } } : {}) };
  };
  await startRequestSpan('evidence.request', { datasetGeneration: String(row.generationId) }, async (span) => {
    try {
      signal.throwIfAborted();
      const route = row.data.edited ? { kind: 'search' as const } : evidenceRoute(row.data.question);
      if (route.kind === 'corpus_statistics') finalData.hint = { kind: 'corpus_statistics' };
      if (route.kind === 'case_comparison') {
        const existing = await ctx.db.select({ ntsbNo: cases.ntsbNo }).from(cases).where(and(eq(cases.generationId, row.generationId), inArray(cases.ntsbNo, route.numbers)));
        const found = new Set(existing.map(c => c.ntsbNo));
        finalData.hint = { kind: 'case_comparison', found: route.numbers.filter(n => found.has(n)), notFound: route.numbers.filter(n => !found.has(n)) };
      }
      const legacyText = row.data.query.source === 'question' ? row.data.question : row.data.query.terms;
      const result = await rankEvidence(config, {
        question: row.data.question, filters: row.data.appliedFilters, dataset: pinned, signal, uncertainAllowanceReached: admission.skipScope,
        autoFilters: ai.evidenceAutoFilters ?? autoFilterPolicy(),
        ...(row.data.edited ? { edited: {
          addedTerms: row.data.addedTerms,
          executed: row.data.executed ?? { lexical: legacyText.replace(/\s+/gu, ' ').trim(), vector: vectorText(legacyText) },
          lexicalSource: row.data.lexicalSource ?? (row.data.query.source === 'question' ? 'question' : 'terms') as LexicalSource,
        } } : {}),
      }, { llm, retriever: services.retriever, embeddingModel: ai.startup.models!.embed }, meter.gate, async () => {
        signal.throwIfAborted();
        // The same guard immediately precedes scope, embedding and rerank admission.
        const still = await ctx.db.select({ id: evidenceSearches.id }).from(evidenceSearches)
          .where(and(eq(evidenceSearches.id, row.id), eq(evidenceSearches.status, 'running')));
        if (!still.length) throw new EvidenceFailure('stopped');
        signal.throwIfAborted();
      }, {
        onExecution: facts => { execution = { ...facts }; },
        onStage: stage => { active = stage; },
        onFallback: ({ stage, outcome }) => {
          if (stage === 'scope') ctx.log.warn({ stage, outcome: 'no_suggestion', failure: outcome }, 'evidence suggestion unavailable');
          else ctx.log.warn({ stage, outcome }, 'evidence rerank unavailable');
        },
      });
      const query = row.data.edited ? disclosedQuery(row.data) : questionQuery(result.lexicalSource, result.addedTerms);
      execution = { addedTerms: result.addedTerms, appliedFilters: result.appliedFilters, automaticFilters: result.automaticFilters,
        autoFilterPolicy: result.autoFilterPolicy, autoFilterReason: result.autoFilterReason,
        query,
        executed: result.executed, lexicalSource: result.lexicalSource, rankingConfig: result.configuration,
        scopeOutcome: result.scopeOutcome, rerankOutcome: result.rerankOutcome };
      active = 'storage';
      finalData = withSuggestion({ ...finalData, ...execution, ranking: result.ranking, cases: result.cases, note: result.note }, remainingSuggestion(query, result.suggestion), config.query.highlights);
      // Validate the exact public page before keeping its quota unit or storing success.
      pageOf({ ...row, status: 'results', data: finalData }, 1, ai.now());
      outcome = 'results'; // A rerank abort preserves the already retrieved order.
    } catch (error) {
      if (error instanceof RankingFailure && error.stage !== 'spend') active = error.stage === 'retrieve' ? 'retrieval' : error.stage;
      failed = true;
      outcome = 'failed';
      finalData = failureData();
      ctx.log.warn({ stage: active, outcome: signal.aborted ? 'stopped' : 'failed' }, 'evidence search did not finish');
    }
    // Finishing the row, refunding unsuccessful searches, and settlement commit together.
    // If deletion removed it, refund; never recreate deleted private data.
    active = 'storage';
    const lines = meter.lines();
    const finish = () => ctx.db.transaction(async (tx) => {
      const [stored] = await tx.select({ status: evidenceSearches.status }).from(evidenceSearches)
        .where(eq(evidenceSearches.id, row.id)).for('no key update');
      // A lost commit response may be retried without charging or releasing twice.
      if (stored && stored.status !== 'running') { failed = stored.status === 'failed'; return; }
      if (!stored || outcome !== 'results') {
        const released = await releaseQuota(tx, admission, admission.fencingToken, { policy, now: ai.now() });
        if (!released.released && released.reason === 'busy') throw new EvidenceFailure('storage');
      }
      const settled = await settle(tx, admission, { lines }, admission.fencingToken, ai.now());
      if (!settled.ok && settled.reason === 'busy') throw new EvidenceFailure('storage');
      if (!settled.ok) { outcome = 'failed'; failed = true; finalData = failureData(); }
      if (stored) await finishSearch(tx, row.id, outcome, finalData);
      else failed = true;
    });
    // Bounded retries cover transient storage failures without repeating a provider call.
    // A persistent outage leaves an open lease: maintenance charges conservatively,
    // returns the quota unit, and closes the orphaned search when the DB is reachable.
    for (let attempt = 0; ; attempt++) {
      try { await finish(); break; } catch {
        if (attempt >= 1) throw new EvidenceFailure('storage');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    span.setAttrs({ outcome, usd: lines.reduce((n, l) => n + l.usd, 0) });
  });
  if (failed) throw new EvidenceFailure(signal.aborted ? 'stopped' : 'storage');
}
