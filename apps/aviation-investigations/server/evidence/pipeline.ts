/** The sole scope → (attribution) → retrieve → rerank entry point for HTTP and evaluation. No HTTP or quota identity. */
import { attributionStage, automaticFieldsOf, automaticState, assertAutoFilterPolicy, autoFilterPolicy, autoFilterIdentity, type EvidenceAutoFilterPolicy, type AutoFilterReason } from './auto-filters.js';
import { attributedFilters, attributionInput, checkedAttribution, type AutoFieldReason } from './attribution.js';
import { attributionWorstCaseUsd } from './pricing.js';
import type { RerankInput } from '../ai/prompts/rerank.r1.js';
import type { AttributionOutput } from '../ai/prompts/attribution.a2.js';
import type { EvidenceNote, EvidenceScopeSuggestion, EvidenceAutomaticFilters } from '../../shared/contracts/evidence.js';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import { automaticCandidates, type AutomaticField } from '../../shared/automatic-candidates.js';
import { fitQueryText } from '../briefs/retriever.js';
import { evidenceAttributionCtx, evidenceScopeCtx, StageError, type LlmProvider, type StageResult } from '../ai/provider.js';
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
import { questionQuery, remainingSuggestion } from './disclosure.js';

export type LexicalSource = 'question' | 'terms' | 'question+terms' | 'fallback_question';
export interface ExecutedTexts { lexical: string; vector: string }
export type RerankOutcome = 'not_run' | 'disabled' | 'empty' | 'applied' | 'skipped_uncertain_allowance' | RankingFailureOutcome;
export type ScopeOutcome = 'used' | 'non_search' | 'skipped' | RankingFailureOutcome;
/** The attribution check: not run (no candidate, or not an attributed policy), answered, or failed. */
export type AttributionOutcome = 'not_run' | 'applied' | RankingFailureOutcome;
export type RankingPhase = 'scope' | 'retrieval' | 'rerank';
export interface RankingExecution {
  executed: ExecutedTexts;
  lexicalSource: LexicalSource;
  /** Exact added-terms suffix after query fitting; null when none were executed. */
  addedTerms: string | null;
  appliedFilters: BriefFilters;
  automaticFilters: EvidenceAutomaticFilters | null;
  autoFilterPolicy: ReturnType<typeof autoFilterIdentity>;
  autoFilterReason: AutoFilterReason;
  /** Private, enums only: why each of an attributed policy's fields was or was not applied. */
  autoFilterFields: Partial<Record<AutomaticField, AutoFieldReason>>;
  /** Private: what the attribution check did. */
  attributionOutcome: AttributionOutcome;
}
export interface RankingObserver {
  onQuestion?: (result: 'suggestions' | 'note' | 'nothing_to_suggest' | 'unavailable', failed: boolean) => void;
  onRetrieved?: (cases: number) => void;
  onOrdered?: (applied: boolean, skipped: boolean) => void;
  onExecution?: (execution: RankingExecution) => void;
  /**
   * Private, enums only: an attributed policy's facts once its decision is made and any check has
   * settled, so a search that then stops or fails still records what the check did.
   */
  onAttribution?: (facts: Pick<RankingExecution, 'attributionOutcome' | 'autoFilterFields'>) => void;
  onStage?: (stage: RankingPhase) => void;
  onFallback?: (failure: { stage: 'scope' | 'rerank' | 'attribution'; outcome: RankingFailureOutcome }) => void;
}
export interface RankingInput {
  question: string;
  filters: BriefFilters;
  /** Edits inherit these texts exactly; explicit edited terms replace both. */
  edited?: { executed: ExecutedTexts; lexicalSource: LexicalSource; addedTerms?: string | null };
  /** Explicit evaluator skip, distinct from the allowance that skips both optional stages. */
  skipScope?: boolean;
  uncertainAllowanceReached?: boolean;
  autoFilters?: EvidenceAutoFilterPolicy;
  dataset: PinnedDataset;
  signal: AbortSignal;
}
export interface RankingProviders { llm: LlmProvider; retriever: EvidenceRetriever; embeddingModel: string }
export interface RankingResult extends EvidenceRetrievalResult, RankingExecution {
  configuration: ReturnType<typeof evidenceRankingIdentity>;
  suggestion: EvidenceScopeSuggestion | null;
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
export function rankingTexts(question: string, terms: string | null, config: EvidenceRankingConfig): { executed: ExecutedTexts; lexicalSource: LexicalSource; addedTerms: string | null } {
  const vector = vectorText(question);
  if (config.lexicalText === 'question') return { executed: { lexical: normal(question), vector }, lexicalSource: 'question', addedTerms: null };
  if (!terms?.trim()) return { executed: { lexical: normal(question), vector }, lexicalSource: 'fallback_question', addedTerms: null };
  const lexical = vectorText(config.lexicalText === 'terms' ? terms : `${question}${config.query.join}${terms}`);
  let addedTerms = lexical;
  if (config.lexicalText === 'question+terms') {
    const q = normal(question);
    const suffix = lexical.startsWith(q + ' ') ? lexical.slice(q.length + 1) : '';
    addedTerms = suffix;
    const survives = [...normal(terms).matchAll(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)]
      .some(word => word.index + word[0].length <= suffix.length);
    // No whole appended word survived the bound. Drop any partial word too.
    // The question-only baseline above deliberately keeps its unbounded lexical text.
    if (!survives) return { executed: { lexical: vector, vector }, lexicalSource: 'fallback_question', addedTerms: null };
  }
  return { executed: { lexical, vector }, lexicalSource: config.lexicalText, addedTerms };
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
  const policy = input.autoFilters ?? autoFilterPolicy();
  assertAutoFilterPolicy(policy);
  const attribution = attributionStage(policy);
  const skipScope = input.skipScope || input.uncertainAllowanceReached;
  if ((!input.edited && !skipScope && (!providers.llm.evidenceScope || attribution && !providers.llm.evidenceAttribution)) ||
      providers.llm.models.scope !== config.scope.model) throw new RankingFailure('scope', []);
  if (providers.embeddingModel !== config.embedding.model) throw new RankingFailure('retrieve', []);
  if (config.rerank && !input.uncertainAllowanceReached && !providers.llm.rerank) throw new RankingFailure('rerank', []);

  const { llm, retriever, embeddingModel } = providers;
  const usage: SpendLine[] = [];
  const configuration = evidenceRankingIdentity(config);
  // Observability cannot change dispatch, ordering or accounting, even if a logger fails.
  const enter = (stage: RankingPhase) => { try { observer.onStage?.(stage); } catch { /* metadata only */ } };
  const fallback = (stage: 'scope' | 'rerank' | 'attribution', outcome: RankingFailureOutcome) => {
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
  const promptVersion = (stage: 'scope' | 'rerank' | 'attribution') =>
    stage === 'scope' ? config.scope.version : stage === 'rerank' ? config.rerank!.prompt.version : attribution!.prompt.version;
  async function metered<T>(call: RankingCall & { stage: 'scope' | 'rerank' | 'attribution' }, run: () => Promise<StageResult<T>>): Promise<StageResult<T>> {
    const ticket = await reserve(call);
    let started = false, result: StageResult<T> | undefined, failure: unknown;
    try { await guard(); started = true; result = await run(); }
    catch (err) {
      failure = !started || err instanceof StageError ? err : new StageError('unexpected', {
        stage: call.stage, provider: call.provider, model: call.model, promptVersion: promptVersion(call.stage),
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
          provider: call.provider, model: call.model, promptVersion: promptVersion(call.stage),
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
  const { executed, lexicalSource, addedTerms = null } = input.edited ?? rankingTexts(input.question, suggestion?.terms ?? null, config);
  let automatic: { filters: EvidenceAutomaticFilters | null; reason: AutoFilterReason };
  let autoFilterFields: Partial<Record<AutomaticField, AutoFieldReason>> = {};
  let attributionOutcome: AttributionOutcome = 'not_run';
  if (!attribution) automatic = automaticState(policy, input.question, suggestion?.filters ?? null, Boolean(input.edited), scopeOutcome === 'non_search');
  else if (input.edited) automatic = { filters: null, reason: 'edited' };
  else if (!suggestion) automatic = { filters: null, reason: scopeOutcome === 'non_search' ? 'non_search' : 'scope_unavailable' };
  else {
    // Still the scope phase: candidates, then at most one attribution check, metered like scope.
    const fields = automaticFieldsOf(policy);
    const { candidates, reasons } = automaticCandidates(input.question, suggestion.filters, input.filters, fields);
    let answer: AttributionOutput | null = null, stopped = false;
    if (candidates.length) {
      const request = attributionInput(input.question, candidates);
      attributionOutcome = await stageSpan('evidence.attribution', { stage: 'attribution', model: attribution.model, provider: llm.name, promptVersion: attribution.prompt.version }, async span => {
        try {
          const result = await metered({ stage: 'attribution', provider: llm.name, model: attribution.model, worstCaseUsd: attributionWorstCaseUsd(attribution) },
            () => llm.evidenceAttribution!(request, evidenceAttributionCtx(AbortSignal.any([input.signal, AbortSignal.timeout(attribution.timeoutMs)]), attribution.timeoutMs)));
          span.setAttrs({ ...result.usage, usd: stageCostUsd(result.model, result.usage) });
          // A structurally incomplete answer applies nothing at all; its known usage stays settled.
          answer = checkedAttribution(request, result.output);
          const outcome = answer ? 'applied' as const : 'invalid_output' as const;
          span.setAttrs({ outcome }); return outcome;
        } catch (error) {
          if (error instanceof RankingFailure) throw error;
          stopped = error instanceof RankingStopped;
          const outcome = rankingFailureOutcome(error, input.signal);
          const line = usage.findLast(l => l.stage === 'attribution');
          span.setAttrs({ ...(line?.tokens ?? {}), usd: line?.usd ?? 0, outcome });
          if (stopped) span.markStopped();
          return outcome;
        }
      });
      if (attributionOutcome !== 'applied') fallback('attribution', attributionOutcome);
    }
    const decision = attributedFilters(input.question, candidates, answer);
    autoFilterFields = Object.fromEntries(fields.map(f => [f, decision.fields[f] ?? `not_candidate:${reasons[f]}`]));
    try { observer.onAttribution?.({ attributionOutcome, autoFilterFields: { ...autoFilterFields } }); } catch { /* private diagnostics only */ }
    if (candidates.length) {
      // A failed check is a fallback; a stopped search (deletion, shutdown, cancel) is not.
      if (stopped) throw new RankingFailure('scope', [...usage]);
      input.signal.throwIfAborted();
    }
    automatic = { filters: decision.filters, reason: decision.filters ? 'applied' : 'not_applied' };
  }
  const appliedFilters = automatic.filters ? { ...input.filters, ...automatic.filters } : input.filters;
  if (automatic.filters && suggestion) {
    // The suggestion loses exactly the applied facets: the state, both year bounds, the category.
    const a = automatic.filters;
    const applied = new Set([...(a.state ? ['state'] : []), ...(a.yearFrom !== undefined || a.yearTo !== undefined ? ['yearFrom', 'yearTo'] : []), ...(a.category ? ['category'] : [])]);
    suggestion = { ...suggestion, filters: Object.fromEntries(Object.entries(suggestion.filters).filter(([key]) => !applied.has(key))) as BriefFilters };
  }
  // Use the page's disclosure rule: terms already executed as keywords and filters
  // already applied are no longer suggestions. Edited searches stay skipped.
  if (!input.edited) {
    const visible = remainingSuggestion(questionQuery(lexicalSource, addedTerms), suggestion);
    const failed = !['used', 'non_search', 'skipped'].includes(scopeOutcome);
    try {
      observer.onQuestion?.(failed ? 'unavailable' : visible ? 'suggestions' : note ? 'note' : 'nothing_to_suggest', failed);
    } catch { /* progress is optional */ }
  }
  const execution: RankingExecution = { executed, lexicalSource, addedTerms, appliedFilters, automaticFilters: automatic.filters,
    autoFilterPolicy: autoFilterIdentity(policy), autoFilterReason: automatic.reason, autoFilterFields, attributionOutcome };
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
      // Record what is actually dispatched, after all cancellation/admission guards.
      try { observer.onExecution?.(structuredClone(execution)); } catch { /* private diagnostics cannot affect retrieval */ }
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
  try { observer.onRetrieved?.(result.cases.length); } catch { /* progress is optional */ }
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
  try { observer.onOrdered?.((rerankOutcome as RerankOutcome) === 'applied', ['disabled', 'empty', 'skipped_uncertain_allowance'].includes(rerankOutcome)); } catch { /* progress is optional */ }
  return { ...result, ...execution, configuration, suggestion, note, scopeOutcome, rerankOutcome, usage };
}
