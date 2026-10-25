/** Frozen behaviour, including input preparation and provider settings; hash before caching output. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { DEFAULT_EVIDENCE_RANKING, EVIDENCE_RANKING_VERSIONS, type EvidenceRankingVersion } from '../../shared/evidence-ranking.js';
import { EVIDENCE_SCOPE_CAPS, CACHED_PREFIX_MAX } from '../ai/pricing.js';
import { EVIDENCE_SCOPE_SYSTEM, EVIDENCE_SCOPE_VERSION, EvidenceScopeWireOutputSchema } from '../ai/prompts/scope.e1.js';
import { RERANK_SYSTEM, RERANK_VERSION, RERANK_USER_TEMPLATE, RerankInputSchema, RerankOutputSchema } from '../ai/prompts/rerank.r1.js';
import { EVIDENCE_RETRIEVAL } from './retrieve.js';
import { RERANK_INPUT_VERSION, rerankInputIdentityFixture } from './rerank.js';
import { canonicalConfig } from '../search/retrieval-config.js';

export type HighlightPolicy = 'suggested-or-executed' | 'executed-lexical';
export type LexicalText = 'question' | 'terms' | 'question+terms';
export interface RerankConfig {
  readonly model: 'claude-haiku-5-5' | 'claude-sonnet-5-5';
  readonly depth: 50 | 100;
  readonly input: {
    readonly version: typeof RERANK_INPUT_VERSION; readonly tokenizer: 'cl100k_base';
    readonly caseTokens: number; readonly totalTokens: number;
    readonly aircraftTokens: number; readonly phaseTokens: number;
    readonly causeTokens: number; readonly excerptTokens: number;
    readonly truncate: 'whole-sentences-from-end'; readonly identifiers: 'masked-in-case-text';
  };
  readonly caps: { readonly input: number; readonly output: number };
  readonly cachePrefixTokens: number;
  readonly timeoutMs: number;
  readonly prompt: { readonly version: 'rerank.r1'; readonly sha256: string; readonly schemaSha256: string };
  readonly settings: { readonly thinking: 'off'; readonly effort: 'low'; readonly retries: 0; readonly cache: 'system-5m' };
}
export interface EvidenceRankingConfig {
  readonly version: EvidenceRankingVersion;
  readonly lexicalText: LexicalText;
  readonly rerank: RerankConfig | null;
  readonly rerankProtocol: {
    readonly userTemplate: string;
    readonly input: { readonly version: typeof RERANK_INPUT_VERSION; readonly renderedFixtureSha256: string };
  };
  readonly embedding: { readonly model: 'text-embedding-3-small'; readonly dimensions: 1536 };
  readonly scope: { readonly model: 'claude-haiku-5-5'; readonly settings: { readonly thinking: 'off'; readonly effort: 'low'; readonly retries: 0; readonly cache: 'system-5m' }; readonly schemaSha256: string; readonly version: string; readonly sha256: string; readonly caps: typeof EVIDENCE_SCOPE_CAPS; readonly cachePrefixTokens: number; readonly timeoutMs: number };
  readonly retrieval: typeof EVIDENCE_RETRIEVAL;
  readonly query: { readonly bound: 'fitQueryText-cl100k-v1'; readonly tokens: 1000; readonly join: '\n'; readonly highlights: HighlightPolicy };
  readonly retrievalTimeoutMs: 8000;
  readonly deadlineMs: number;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const rerank = (model: RerankConfig['model'], depth: RerankConfig['depth']): RerankConfig => ({
  model, depth,
  input: { version: RERANK_INPUT_VERSION, tokenizer: 'cl100k_base', caseTokens: 500, totalTokens: depth * 500 + 1500,
    aircraftTokens: 60, phaseTokens: 50, causeTokens: 220, excerptTokens: 260,
    truncate: 'whole-sentences-from-end', identifiers: 'masked-in-case-text' },
  // Measured by the free provider preflight; no generation is needed to size these.
  caps: { input: depth === 50 ? 55_000 : 95_000, output: depth === 50 ? 2000 : 4000 },
  cachePrefixTokens: 1500, timeoutMs: depth === 50 ? 20_000 : 30_000,
  prompt: { version: RERANK_VERSION, sha256: hash(RERANK_SYSTEM), schemaSha256: hash(JSON.stringify([z.toJSONSchema(RerankInputSchema), z.toJSONSchema(RerankOutputSchema)])) },
  settings: { thinking: 'off', effort: 'low', retries: 0, cache: 'system-5m' },
});
// Same preparation policy in all current configurations. Include the protocol even
// when disabled, so every emitted identity covers this implementation's renderer.
const rerankProtocol = freeze({
  userTemplate: RERANK_USER_TEMPLATE,
  input: { version: RERANK_INPUT_VERSION,
    renderedFixtureSha256: hash(rerankInputIdentityFixture(rerank('claude-haiku-5-5', 50))) },
} satisfies EvidenceRankingConfig['rerankProtocol']);
const configs = EVIDENCE_RANKING_VERSIONS.map(version => {
  const lexicalText: LexicalText = version.startsWith('er-qt-') ? 'question+terms' : version.startsWith('er-t-') ? 'terms' : 'question';
  const r = version.includes('-h50-') ? rerank('claude-haiku-5-5', 50) : version.includes('-h100-') ? rerank('claude-haiku-5-5', 100) : version.includes('-s50-') ? rerank('claude-sonnet-5-5', 50) : null;
  return [version, freeze({ version, lexicalText, rerank: r, rerankProtocol,
    embedding: { model: 'text-embedding-3-small', dimensions: 1536 },
    scope: { model: 'claude-haiku-5-5', settings: { thinking: 'off', effort: 'low', retries: 0, cache: 'system-5m' }, schemaSha256: hash(JSON.stringify(z.toJSONSchema(EvidenceScopeWireOutputSchema))), version: EVIDENCE_SCOPE_VERSION, sha256: hash(EVIDENCE_SCOPE_SYSTEM), caps: EVIDENCE_SCOPE_CAPS, cachePrefixTokens: CACHED_PREFIX_MAX, timeoutMs: 10_000 },
    retrieval: EVIDENCE_RETRIEVAL,
    query: { bound: 'fitQueryText-cl100k-v1', tokens: 1000, join: '\n', highlights: version === DEFAULT_EVIDENCE_RANKING ? 'suggested-or-executed' : 'executed-lexical' },
    retrievalTimeoutMs: 8000,
    deadlineMs: 30_000 + (r?.timeoutMs ?? 0),
  } satisfies EvidenceRankingConfig)] as const;
});
export const EVIDENCE_RANKING_CONFIGS: Readonly<Record<EvidenceRankingVersion, EvidenceRankingConfig>> = Object.freeze(Object.fromEntries(configs)) as Record<EvidenceRankingVersion, EvidenceRankingConfig>;
export function evidenceRankingConfig(version: EvidenceRankingVersion = DEFAULT_EVIDENCE_RANKING): EvidenceRankingConfig {
  const config = EVIDENCE_RANKING_CONFIGS[version];
  if (!config) throw new Error('unknown evidence ranking configuration');
  return config;
}
/** Same canonical sorted-key representation as the retrieval configurations. */
export const canonicalEvidenceRanking = (config: EvidenceRankingConfig): string => canonicalConfig(config);
export const evidenceRankingIdentity = (config: EvidenceRankingConfig) => ({ version: config.version, sha256: hash(canonicalEvidenceRanking(config)) });
export function assertEvidenceRanking(config: EvidenceRankingConfig): void {
  if (canonicalEvidenceRanking(config) !== canonicalEvidenceRanking(evidenceRankingConfig(config.version))) throw new Error('unregistered evidence ranking configuration');
}
