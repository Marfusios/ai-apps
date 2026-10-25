import type { RerankInput } from '../ai/prompts/rerank.r1.js';
/** The sole scope → retrieve → rerank entry point for HTTP and evaluation. No HTTP or quota identity. */
import type { EvidenceNote, EvidenceSuggestion } from '../../shared/contracts/evidence.js';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { fitQueryText } from '../briefs/retriever.js';
import { evidenceScopeCtx, StageError, type LlmProvider, type StageResult } from '../ai/provider.js';
import { validateEvidenceScope } from '../ai/prompts/scope.e1.js';
import { QueryEmbeddingError } from '../ai/embeddings.js';
import { embeddingCostUsd, embeddingWorstCaseUsd, stageCostUsd, stageWorstCaseUsd, STAGE_CAPS } from '../ai/pricing.js';
import type { PinnedDataset } from '../dataset.js';
import type { SpendLine } from '../quota/settle.js';
import { stageSpan } from '../observability/tracing.js';
import { assertEvidenceRanking, evidenceRankingIdentity, type EvidenceRankingConfig } from './ranking-config.js';
import type { EvidenceRetriever, EvidenceRetrievalResult } from './retrieve.js';
import { applyRerank, buildRerankInput } from './rerank.js';
import { RankingSpendError, type RankingCall, type RankingSpendGate } from './spend.js';

export type LexicalSource = 'question' | 'terms' | 'question+terms' | 'fallback_question';
export interface ExecutedTexts { lexical: string; vector: string }
export type RerankOutcome = 'not_run' | 'disabled' | 'empty' | 'applied' | 'timeout' | 'aborted' | 'invalid_output' | 'refusal' | 'truncated' | 'provider_error' | 'input_too_large';
export type ScopeOutcome = 'used' | 'non_search' | 'skipped' | 'timeout' | 'invalid_output' | 'provider_error';
export interface RankingInput {
  question: string;
  filters: BriefFilters;
  /** Edits inherit these texts exactly; explicit edited terms replace both. */
  edited?: { executed: ExecutedTexts; lexicalSource: LexicalSource };
  skipScope?: boolean;
  dataset: PinnedDataset;
  signal: AbortSignal;
}
export interface RankingProviders { llm: LlmProvider; retriever: EvidenceRetriever; embeddingModel: string }
export interface RankingResult extends EvidenceRetrievalResult {
  configuration: ReturnType<typeof evidenceRankingIdentity>;
  executed: ExecutedTexts;
  lexicalSource: LexicalSource;
  suggestion: EvidenceSuggestion | null;
  note: EvidenceNote | null;
  scopeOutcome: ScopeOutcome;
  rerankOutcome: RerankOutcome;
  usage: SpendLine[];
}
export class RankingFailure extends Error {
  constructor(readonly stage: 'scope' | 'retrieve' | 'rerank' | 'spend', readonly usage: readonly SpendLine[]) { super(`evidence ranking failed: ${stage}`); }
}
const normal = (text: string) => text.replace(/\s+/gu, ' ').trim();
export const vectorText = (text: string): string => normal(fitQueryText(text));
export function rankingTexts(question: string, terms: string | null, config: EvidenceRankingConfig): { executed: ExecutedTexts; lexicalSource: LexicalSource } {
  const vector = vectorText(question);
  if (config.lexicalText === 'question') return { executed: { lexical: normal(question), vector }, lexicalSource: 'question' };
  if (!terms?.trim()) return { executed: { lexical: normal(question), vector }, lexicalSource: 'fallback_question' };
  const lexical = vectorText(config.lexicalText === 'terms' ? terms : `${question}${config.query.join}${terms}`);
  return { executed: { lexical, vector }, lexicalSource: config.lexicalText };
}
const resultLine = (stage: RankingCall['stage'], result: StageResult<unknown>): SpendLine => ({
  stage, provider: result.provider, model: result.model, usd: stageCostUsd(result.model, result.usage), tokens: { ...result.usage },
});
const failedLine = (call: RankingCall, error: unknown, started: boolean): SpendLine[] => {
  if (!started) return [];
  if (error instanceof StageError) {
    if (error.billing.kind === 'none') return [];
    if (error.billing.kind === 'usage') return [{ stage: call.stage, provider: call.provider, model: call.model,
      usd: stageCostUsd(call.model, error.billing.usage), tokens: { ...error.billing.usage } }];
  }
  return [{ stage: call.stage, provider: call.provider, model: call.model, usd: call.worstCaseUsd, uncertain: true }];
};

export async function rankEvidence(config: EvidenceRankingConfig, input: RankingInput, providers: RankingProviders,
  spend: RankingSpendGate, beforePaidCall: () => Promise<void> = async () => {}): Promise<RankingResult> {
  assertEvidenceRanking(config);
  if ((!input.edited && !input.skipScope && !providers.llm.evidenceScope) ||
      providers.llm.models.scope !== config.scope.model || providers.embeddingModel !== config.embedding.model ||
      (config.rerank && !providers.llm.rerank)) throw new RankingFailure('scope', []);

  const { llm, retriever, embeddingModel } = providers;
  const usage: SpendLine[] = [];
  const configuration = evidenceRankingIdentity(config);
  const reserve = async (call: RankingCall) => { try { return await spend.reserve(call); } catch { throw new RankingFailure('spend', [...usage]); } };
  const settle = async (ticket: unknown, lines: SpendLine[]) => {
    usage.push(...lines);
    try { await spend.settle(ticket, lines); } catch { throw new RankingFailure('spend', [...usage]); }
  };
  async function metered<T>(call: RankingCall & { stage: 'scope' | 'rerank' }, run: () => Promise<StageResult<T>>): Promise<StageResult<T>> {
    const ticket = await reserve(call);
    let started = false, result: StageResult<T> | undefined, failure: unknown;
    try { await beforePaidCall(); input.signal.throwIfAborted(); started = true; result = await run(); }
    catch (err) { failure = err; }
    if (result) {
      const u = result.usage;
      const validUsage = u && ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens'].every(k =>
        Number.isSafeInteger(u[k as keyof typeof u]) && u[k as keyof typeof u]! >= 0);
      if (!validUsage || result.model !== call.model || result.provider !== call.provider ||
          !Number.isFinite(stageCostUsd(call.model, u)) || stageCostUsd(call.model, u) > call.worstCaseUsd + 1e-9) {
        failure = new StageError('invalid_output', { stage: call.stage,
          provider: call.provider, model: call.model, promptVersion: call.stage === 'scope' ? config.scope.version : config.rerank!.prompt.version,
          billing: { kind: 'uncertain' } });
        result = undefined;
      }
    }
    await settle(ticket, result ? [resultLine(call.stage, result)] : failedLine(call, failure, started));
    if (!result) throw failure ?? new Error('missing stage result');
    return result;
  }
  let suggestion: EvidenceSuggestion | null = null, note: EvidenceNote | null = null;
  let scopeOutcome: ScopeOutcome = 'skipped';
  input.signal.throwIfAborted();
  if (!input.edited && !input.skipScope) {
    try {
      const r = await stageSpan('evidence.scope', { stage: 'scope', model: llm.models.scope, provider: llm.name, promptVersion: config.scope.version }, async span => {
        const result = await metered({ stage: 'scope', provider: llm.name, model: llm.models.scope,
          worstCaseUsd: stageWorstCaseUsd(llm.models.scope, config.scope.caps, config.scope.cachePrefixTokens) }, () => llm.evidenceScope!({ question: input.question },
          evidenceScopeCtx(AbortSignal.any([input.signal, AbortSignal.timeout(config.scope.timeoutMs)]), config.scope.timeoutMs)));
        span.setAttrs({ ...result.usage, usd: stageCostUsd(result.model, result.usage) }); return result;
      });
      const planned = validateEvidenceScope(r.output, input.question);
      if (planned.intent === 'case_search') { suggestion = { filters: planned.filters, terms: planned.terms }; scopeOutcome = 'used'; }
      else { scopeOutcome = 'non_search'; note = planned.intent === 'out_of_scope' ? 'scope' : planned.intent === 'operational_advice' ? 'operational_advice' : null; }
    } catch (error) {
      if (error instanceof RankingFailure) throw error;
      scopeOutcome = error instanceof StageError ? error.category === 'timeout' ? 'timeout' : error.category === 'invalid_output' ? 'invalid_output' : 'provider_error' : 'invalid_output';
      input.signal.throwIfAborted();
    }
  }
  const { executed, lexicalSource } = input.edited ?? rankingTexts(input.question, suggestion?.terms ?? null, config);
  input.signal.throwIfAborted(); await beforePaidCall(); input.signal.throwIfAborted();
  const embedding: RankingCall = { stage: 'embed', provider: 'openai', model: embeddingModel, worstCaseUsd: embeddingWorstCaseUsd(embeddingModel) };
  const ticket = await reserve(embedding);
  const embedLines: SpendLine[] = [];
  let result: EvidenceRetrievalResult | undefined, retrieveError: unknown, accepting = true;
  try {
    // Admission can have waited; no paid embedding after deletion/shutdown while it waited.
    await beforePaidCall(); input.signal.throwIfAborted();
    result = await stageSpan('evidence.retrieve', { stage: 'retrieve', retrievalVersion: config.retrieval.version }, async span => {
      const found = await retriever.search(input.dataset, { text: executed.vector, keywordText: executed.lexical, filters: input.filters },
        AbortSignal.any([input.signal, AbortSignal.timeout(config.retrievalTimeoutMs)]), u => {
          if (!accepting) return;
          embedLines.push({ stage: 'embed', provider: 'openai', model: u.model, usd: u.billing === 'uncertain' ? embedding.worstCaseUsd : u.usd,
            tokens: { inputTokens: u.tokens }, ...(u.billing === 'uncertain' ? { uncertain: true } : {}) });
          if (embedLines.length > 1) throw new Error('duplicate embedding usage');
        }, executed.lexical);
      span.setAttrs({ caseCount: found.cases.length }); return found;
    });
  } catch (error) { retrieveError = error; }
  finally { accepting = false; }
  if (!embedLines.length && retrieveError instanceof QueryEmbeddingError) {
    if (retrieveError.billing === 'usage') embedLines.push({ stage: 'embed', provider: 'openai', model: embeddingModel,
      usd: embeddingCostUsd(embeddingModel, retrieveError.billedTokens ?? STAGE_CAPS.embed.input) });
    if (retrieveError.billing === 'uncertain') embedLines.push({ stage: 'embed', provider: 'openai', model: embeddingModel, usd: embedding.worstCaseUsd, uncertain: true });
  }
  await settle(ticket, embedLines);
  if (!result || retrieveError) throw new RankingFailure('retrieve', [...usage]);
  if (result.cases.length !== result.ranking.length || new Set(result.cases.map(c => c.case.ntsbNo)).size !== result.cases.length ||
      result.cases.some((c, i) => c.case.ntsbNo !== result!.ranking[i]!.ntsbNo)) throw new RankingFailure('retrieve', [...usage]);
  let rerankOutcome: RerankOutcome = config.rerank ? 'empty' : 'disabled';
  const r = config.rerank;
  if (r && result.cases.length) {
    if (input.signal.aborted) rerankOutcome = 'aborted';
    else {
      let request: RerankInput | undefined;
      try { request = buildRerankInput(executed.vector, result.cases, r); } catch { rerankOutcome = 'input_too_large'; }
      if (request) {
        try {
          result = await stageSpan('evidence.rerank', { stage: 'rerank', provider: llm.name, model: r.model, depth: r.depth, promptVersion: r.prompt.version }, async span => {
            try {
              const response = await metered({ stage: 'rerank', provider: llm.name, model: r.model,
                worstCaseUsd: stageWorstCaseUsd(r.model, r.caps, r.cachePrefixTokens) }, () => llm.rerank!(request,
                { signal: AbortSignal.any([input.signal, AbortSignal.timeout(r.timeoutMs)]), timeoutMs: r.timeoutMs, maxInputTokens: r.caps.input, maxOutputTokens: r.caps.output }, r));
              span.setAttrs({ ...response.usage, usd: stageCostUsd(response.model, response.usage) });
              const ordered = applyRerank(result!, response.output, request.cases.map(c => c.id));
              rerankOutcome = 'applied'; span.setAttrs({ outcome: rerankOutcome }); return ordered;
            } catch (error) {
              if (error instanceof RankingFailure || error instanceof RankingSpendError) throw error;
              rerankOutcome = input.signal.aborted ? 'aborted' : error instanceof StageError ?
                error.category === 'timeout' ? 'timeout' : error.category === 'refusal' ? 'refusal' : error.category === 'truncated' ? 'truncated' :
                  error.category === 'invalid_output' ? 'invalid_output' : 'provider_error' : 'invalid_output';
              const line = usage.findLast(l => l.stage === 'rerank');
              span.setAttrs({ ...(line?.tokens ?? {}), usd: line?.usd ?? 0, outcome: rerankOutcome }); return result!;
            }
          });
        } catch (error) { if (error instanceof RankingFailure) throw error; throw new RankingFailure('rerank', [...usage]); }
      }
    }
  }
  return { ...result, configuration, executed, lexicalSource, suggestion, note, scopeOutcome, rerankOutcome, usage };
}
