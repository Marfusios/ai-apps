/** The sole scope → retrieve → rerank entry point for HTTP and evaluation. No HTTP or quota identity. */
import { automaticState, autoFilterPolicy, autoFilterIdentity, type EvidenceAutoFilterPolicy, type AutoFilterReason } from './auto-filters.js';
import type { RerankInput } from '../ai/prompts/rerank.r1.js';
import type { EvidenceNote, EvidenceScopeSuggestion, EvidenceAutomaticFilters } from '../../shared/contracts/evidence.js';
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
import { RankingStopped, rankingFailureOutcome, type RankingFailureOutcome } from './outcomes.js';
import { RankingSpendError, type RankingCall, type RankingSpendGate } from './spend.js';

export type LexicalSource = 'question' | 'terms' | 'question+terms' | 'fallback_question';
export interface ExecutedTexts { lexical: string; vector: string }
export type RerankOutcome = 'not_run' | 'disabled' | 'empty' | 'applied' | 'skipped_uncertain_allowance' | RankingFailureOutcome;
export type ScopeOutcome = 'used' | 'non_search' | 'skipped' | RankingFailureOutcome;
export type RankingPhase = 'scope' | 'retrieval' | 'rerank';
export interface RankingObserver {
  onStage?: (stage: RankingPhase) => void;
  onFallback?: (failure: { stage: 'scope' | 'rerank'; outcome: RankingFailureOutcome }) => void;
}
export interface RankingInput {
  question: string;
  filters: BriefFilters;
  /** Edits inherit these texts exactly; explicit edited terms replace both. */
  edited?: { executed: ExecutedTexts; lexicalSource: LexicalSource };
  /** Explicit evaluator skip, distinct from the allowance that skips both optional stages. */
  skipScope?: boolean;
  uncertainAllowanceReached?: boolean;
  autoFilters?: EvidenceAutoFilterPolicy;
  dataset: PinnedDataset;
  signal: AbortSignal;
}
export interface RankingProviders { llm: LlmProvider; retriever: EvidenceRetriever; embeddingModel: string }
export interface RankingResult extends EvidenceRetrievalResult {
  configuration: ReturnType<typeof evidenceRankingIdentity>;
  executed: ExecutedTexts;
  lexicalSource: LexicalSource;
  suggestion: EvidenceScopeSuggestion | null;
  appliedFilters: BriefFilters;
  automaticFilters: EvidenceAutomaticFilters | null;
  autoFilterPolicy: ReturnType<typeof autoFilterIdentity>;
  autoFilterReason: AutoFilterReason;
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
  if (config.lexicalText === 'question+terms') {
    const q = normal(question);
    const suffix = lexical.startsWith(q + ' ') ? lexical.slice(q.length + 1) : '';
    const survives = [...normal(terms).matchAll(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)]
      .some(word => word.index + word[0].length <= suffix.length);
    // No whole appended word survived the bound. Drop any partial word too.
    // The question-only baseline above deliberately keeps its unbounded lexical text.
    if (!survives) return { executed: { lexical: vector, vector }, lexicalSource: 'fallback_question' };
  }
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
  spend: RankingSpendGate, beforePaidCall: () => Promise<void> = async () => {},
  observer: RankingObserver = {}): Promise<RankingResult> {
  assertEvidenceRanking(config);
  const skipScope = input.skipScope || input.uncertainAllowanceReached;
  if ((!input.edited && !skipScope && !providers.llm.evidenceScope) ||
      providers.llm.models.scope !== config.scope.model) throw new RankingFailure('scope', []);
  if (providers.embeddingModel !== config.embedding.model) throw new RankingFailure('retrieve', []);
  if (config.rerank && !input.uncertainAllowanceReached && !providers.llm.rerank) throw new RankingFailure('rerank', []);

  const { llm, retriever, embeddingModel } = providers;
  const usage: SpendLine[] = [];
  const configuration = evidenceRankingIdentity(config);
  // Observability cannot change dispatch, ordering or accounting, even if a logger fails.
  const enter = (stage: RankingPhase) => { try { observer.onStage?.(stage); } catch { /* metadata only */ } };
  const fallback = (stage: 'scope' | 'rerank', outcome: RankingFailureOutcome) => {
    try { observer.onFallback?.({ stage, outcome }); } catch { /* metadata only */ }
  };
  const guard = async () => {
    try { input.signal.throwIfAborted(); await beforePaidCall(); input.signal.throwIfAborted(); }
    catch { throw new RankingStopped(); }
  };
  const reserve = async (call: RankingCall) => { try { return await spend.reserve(call); } catch { throw new RankingFailure('spend', [...usage]); } };
  const settle = async (ticket: unknown, lines: SpendLine[]) => {
    usage.push(...lines);
    try { await spend.settle(ticket, lines); } catch { throw new RankingFailure('spend', [...usage]); }
  };
  async function metered<T>(call: RankingCall & { stage: 'scope' | 'rerank' }, run: () => Promise<StageResult<T>>): Promise<StageResult<T>> {
    const ticket = await reserve(call);
    let started = false, result: StageResult<T> | undefined, failure: unknown;
    try { await guard(); started = true; result = await run(); }
    catch (err) {
      failure = !started || err instanceof StageError ? err : new StageError('unexpected', {
        stage: call.stage, provider: call.provider, model: call.model,
        promptVersion: call.stage === 'scope' ? config.scope.version : config.rerank!.prompt.version,
        billing: { kind: 'uncertain' },
      });
    }
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
  let suggestion: EvidenceScopeSuggestion | null = null, note: EvidenceNote | null = null;
  let scopeOutcome: ScopeOutcome = 'skipped';
  enter('scope');
  input.signal.throwIfAborted();
  if (!input.edited && !skipScope) {
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
      scopeOutcome = rankingFailureOutcome(error, input.signal);
      fallback('scope', scopeOutcome);
      if (error instanceof RankingStopped) throw new RankingFailure('scope', [...usage]);
      input.signal.throwIfAborted();
    }
  }
  const { executed, lexicalSource } = input.edited ?? rankingTexts(input.question, suggestion?.terms ?? null, config);
  const policy = input.autoFilters ?? autoFilterPolicy();
  const automatic = automaticState(policy, input.question, suggestion?.filters ?? null, Boolean(input.edited), scopeOutcome === 'non_search');
  const appliedFilters = automatic.filters ? { ...input.filters, ...automatic.filters } : input.filters;
  if (automatic.filters && suggestion) {
    const { state: _applied, ...filters } = suggestion.filters;
    suggestion = { ...suggestion, filters };
  }
  enter('retrieval');
  try { await guard(); } catch { throw new RankingFailure('retrieve', [...usage]); }
  const embedding: RankingCall = { stage: 'embed', provider: 'openai', model: embeddingModel, worstCaseUsd: embeddingWorstCaseUsd(embeddingModel) };
  const ticket = await reserve(embedding);
  const embedLines: SpendLine[] = [];
  let result: EvidenceRetrievalResult | undefined, retrieveError: unknown, accepting = true;
  try {
    // Admission can have waited; no paid embedding after deletion/shutdown while it waited.
    await guard();
    result = await stageSpan('evidence.retrieve', { stage: 'retrieve', retrievalVersion: config.retrieval.version }, async span => {
      const found = await retriever.search(input.dataset, { text: executed.vector, keywordText: executed.lexical, filters: appliedFilters },
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
  let rerankOutcome: RerankOutcome = config.rerank ? input.uncertainAllowanceReached ? 'skipped_uncertain_allowance' : 'empty' : 'disabled';
  const r = config.rerank;
  if (r && !input.uncertainAllowanceReached && result.cases.length) {
    enter('rerank');
    if (input.signal.aborted) { rerankOutcome = 'stopped'; fallback('rerank', rerankOutcome); }
    else {
      let request: RerankInput | undefined;
      try { request = buildRerankInput(executed.vector, result.cases, r); } catch { rerankOutcome = 'input_too_large'; fallback('rerank', rerankOutcome); }
      if (request) {
        try {
          result = await stageSpan('evidence.rerank', { stage: 'rerank', provider: llm.name, model: r.model, depth: r.depth, promptVersion: r.prompt.version }, async span => {
            try {
              const response = await metered({ stage: 'rerank', provider: llm.name, model: r.model,
                worstCaseUsd: stageWorstCaseUsd(r.model, r.caps, r.cachePrefixTokens) }, () => llm.rerank!(request,
                { signal: AbortSignal.any([input.signal, AbortSignal.timeout(r.timeoutMs)]), timeoutMs: r.timeoutMs, maxInputTokens: r.caps.input, maxOutputTokens: r.caps.output }, config));
              span.setAttrs({ ...response.usage, usd: stageCostUsd(response.model, response.usage) });
              const ordered = applyRerank(result!, response.output, request.cases.map(c => c.id));
              rerankOutcome = 'applied'; span.setAttrs({ outcome: rerankOutcome }); return ordered;
            } catch (error) {
              if (error instanceof RankingFailure || error instanceof RankingSpendError) throw error;
              rerankOutcome = rankingFailureOutcome(error, input.signal);
              fallback('rerank', rerankOutcome);
              const line = usage.findLast(l => l.stage === 'rerank');
              span.setAttrs({ ...(line?.tokens ?? {}), usd: line?.usd ?? 0, outcome: rerankOutcome }); return result!;
            }
          });
        } catch (error) { if (error instanceof RankingFailure) throw error; throw new RankingFailure('rerank', [...usage]); }
      }
    }
  }
  return { ...result, appliedFilters, automaticFilters: automatic.filters, autoFilterPolicy: autoFilterIdentity(policy), autoFilterReason: automatic.reason, configuration, executed, lexicalSource, suggestion, note, scopeOutcome, rerankOutcome, usage };
}
