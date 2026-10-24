/** One admitted evidence search. No path here can call compose or check. */
import { and, eq, inArray } from 'drizzle-orm';
import { StageError, stageCtx } from '../ai/provider.js';
import { validateEvidenceScope, EVIDENCE_SCOPE_VERSION } from '../ai/prompts/scope.e1.js';
import { STAGE_CAPS, stageCostUsd, stageWorstCaseUsd, embeddingWorstCaseUsd, embeddingCostUsd } from '../ai/pricing.js';
import { QueryEmbeddingError } from '../ai/embeddings.js';
import { comparisonReply, operationalReply, outOfScopeReply, statisticsReply } from '../briefs/static-replies.js';
import { cases, evidenceSearches } from '../db/schema/index.js';
import type { PinnedDataset } from '../dataset.js';
import type { EvidenceInterpretation } from '../../shared/contracts/evidence.js';
import { releaseQuota, type Admission } from '../quota/admit.js';
import { settle, type SpendLine } from '../quota/settle.js';
import { stageSpan, startRequestSpan } from '../observability/tracing.js';
import type { ApiContext } from '../routes/context.js';
import { finishSearch, pageOf, type EvidenceRow, type SearchData } from './store.js';

/** Failures expose only a fixed category; no upstream error, scope output, text or keys. */
export class EvidenceFailure extends Error {
  constructor(readonly category: 'scope' | 'retrieval' | 'storage' | 'stopped') { super(`evidence search failed: ${category}`); }
}

export async function runEvidence(ctx: ApiContext, row: EvidenceRow, pinned: PinnedDataset, admission: Admission,
  signal: AbortSignal, edited?: EvidenceInterpretation): Promise<void> {
  const ai = ctx.ai!, services = ctx.evidence!;
  const llm = ai.llm!, policy = ai.policy!;
  const lines: SpendLine[] = [];
  let active: 'scope' | 'retrieval' | 'storage' = 'scope';
  let scopeStarted = false, scopeRecorded = false, embedRecorded = false;
  let finalData: SearchData = { ...row.data };
  let outcome: 'results' | 'scope_reply' | 'failed' = 'failed';
  let failed = false;
  await startRequestSpan('evidence.request', { datasetGeneration: String(row.generationId) }, async (span) => {
    try {
      signal.throwIfAborted();
      let interpretation = edited;
      if (!interpretation) {
        const planned = await stageSpan('evidence.scope', { stage: 'scope', provider: llm.name, model: llm.models.scope, promptVersion: EVIDENCE_SCOPE_VERSION }, async (stage) => {
          scopeStarted = true;
          const result = await llm.evidenceScope!({ question: row.data.question }, stageCtx('scope', signal, 10_000));
          const usd = stageCostUsd(result.model, result.usage);
          lines.push({ stage: 'scope', provider: result.provider, model: result.model, usd, tokens: { ...result.usage } });
          scopeRecorded = true;
          stage.setAttrs({ ...result.usage, usd });
          return validateEvidenceScope(result.output, row.data.question);
        });
        if (planned.intent === 'case_search') interpretation = { filters: planned.filters, terms: planned.terms, unchecked: planned.unchecked };
        else {
          if (planned.intent === 'operational_advice') finalData.reply = operationalReply();
          else if (planned.intent === 'out_of_scope') finalData.reply = outOfScopeReply();
          else if (planned.intent === 'corpus_statistics') finalData.reply = statisticsReply(planned.filters);
          else {
            const asked = [...new Set(row.data.question.toUpperCase().match(/\b[A-Z]{3}\d{2}[A-Z]{2}\d{3}[A-Z]?\b/g) ?? [])].slice(0, 4);
            const existing = asked.length ? await ctx.db.select({ ntsbNo: cases.ntsbNo }).from(cases).where(and(eq(cases.generationId, row.generationId), inArray(cases.ntsbNo, asked))) : [];
            finalData.reply = comparisonReply(asked, new Set(existing.map((c) => c.ntsbNo)));
          }
          outcome = 'scope_reply';
        }
      }
      if (interpretation) {
        signal.throwIfAborted();
        // Account deletion may have happened while scope ran: no second provider call then.
        const still = await ctx.db.select({ id: evidenceSearches.id }).from(evidenceSearches).where(and(eq(evidenceSearches.id, row.id), eq(evidenceSearches.status, 'running')));
        if (!still.length) throw new EvidenceFailure('stopped');
        active = 'retrieval';
        const retrieved = await stageSpan('evidence.retrieve', { stage: 'retrieve', retrievalVersion: 'retrieval.v2' }, async (stage) => {
          const result = await services.retriever.search(pinned, interpretation!, AbortSignal.any([signal, AbortSignal.timeout(8_000)]), (u) => {
            if (embedRecorded) throw new EvidenceFailure('retrieval');
            embedRecorded = true;
            lines.push({ stage: 'embed', provider: 'openai', model: u.model, usd: u.billing === 'uncertain' ? embeddingWorstCaseUsd(u.model) : u.usd,
              tokens: { inputTokens: u.tokens }, ...(u.billing === 'uncertain' ? { uncertain: true } : {}) });
          });
          stage.setAttrs({ caseCount: result.cases.length });
          return result;
        });
        finalData = { ...finalData, interpretation, ranking: retrieved.ranking, cases: retrieved.cases };
        // Validate the exact public page before keeping its quota unit or storing success.
        pageOf({ ...row, status: 'results', data: finalData }, 1);
        outcome = 'results';
      }
      signal.throwIfAborted();
    } catch (error) {
      failed = true;
      outcome = 'failed';
      if (error instanceof StageError && !scopeRecorded) {
        scopeRecorded = true;
        if (error.billing.kind === 'usage') lines.push({ stage: 'scope', provider: error.provider, model: error.model,
          usd: stageCostUsd(error.model, error.billing.usage), tokens: { ...error.billing.usage } });
        if (error.billing.kind === 'uncertain') lines.push({ stage: 'scope', provider: llm.name, model: llm.models.scope,
          usd: stageWorstCaseUsd(llm.models.scope, STAGE_CAPS.scope), uncertain: true });
      } else if (scopeStarted && !scopeRecorded) {
        lines.push({ stage: 'scope', provider: llm.name, model: llm.models.scope, usd: stageWorstCaseUsd(llm.models.scope, STAGE_CAPS.scope), uncertain: true });
      }
      if (error instanceof QueryEmbeddingError && !embedRecorded) {
        const model = ai.startup.models!.embed;
        if (error.billing === 'usage') lines.push({ stage: 'embed', provider: 'openai', model, usd: embeddingCostUsd(model, error.billedTokens ?? STAGE_CAPS.embed.input) });
        if (error.billing === 'uncertain') lines.push({ stage: 'embed', provider: 'openai', model, usd: embeddingWorstCaseUsd(model), uncertain: true });
      }
      ctx.log.warn({ stage: active, outcome: signal.aborted ? 'stopped' : 'failed' }, 'evidence search did not finish');
    }
    // Finishing the row, refunding unsuccessful searches, and settlement commit together.
    // If deletion removed it, refund; never recreate deleted private data.
    active = 'storage';
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
      if (!settled.ok) { outcome = 'failed'; failed = true; }
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
