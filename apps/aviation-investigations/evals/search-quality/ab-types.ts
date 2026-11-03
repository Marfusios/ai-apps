/** Evaluator records; ranking itself belongs exclusively to server/evidence/pipeline.ts. */
import type { SpendLine } from '../../server/quota/settle.js';
import type { ExecutedTexts, LexicalSource } from '../../server/evidence/pipeline.js';
import type { BriefFilters } from '../../shared/contracts/briefs.js';
import type { EvidenceAutomaticFilters, EvidenceScopeSuggestion } from '../../shared/contracts/evidence.js';
import type { EvidenceAutoFilterPolicy } from '../../server/evidence/auto-filters.js';
export const ARM_IDS = {
  Q0: 'er-q-v1', T0: 'er-t-v1', QT0: 'er-qt-v1',
  QH50: 'er-q-h50-v1', TH50: 'er-t-h50-v1', QTH50: 'er-qt-h50-v1',
  QH100: 'er-q-h100-v1', TH100: 'er-t-h100-v1', QTH100: 'er-qt-h100-v1',
  TS50: 'er-t-s50-v1', QTS50: 'er-qt-s50-v1',
} as const;
export type Arm = keyof typeof ARM_IDS;
export const CORE_ARMS: readonly Arm[] = ['Q0', 'T0', 'QT0', 'QH50', 'TH50', 'QTH50'];
export interface ArmIdentity { alias: Arm; version: string; sha256: string; reservationUsd: number; changedKnobs: number; depth: number }
export interface RankingQuestion { id: string; question: string; group: string; class: 'narrow' | 'broad'; area: string; relevant: string[] }
export interface ScheduledSearch { key: string; questionId: string; arm: Arm; sample: 1 | 2 | 3 }
export type TimingStage = 'scope' | 'embed' | 'retrieve' | 'rerank';
export interface StageTiming { ms: number; attempted: boolean }
export interface SearchObservation extends ScheduledSearch {
  configuration: { version: string; sha256: string }; ranking: string[]; fused: string[];
  scopeOutcome: string; lexicalSource: string; rerankOutcome: string;
  executed: { lexical: string; vector: string } | null;
  usage: SpendLine[]; actualUsd: number; reservationUsd: number; reservationIds: string[];
  timing: Record<TimingStage, StageTiming> & { attribution?: StageTiming }; totalMs: number;
  embeddingCacheHit: boolean; failure: string | null; safetyFaults: string[];
  /** Task 29: the filters the search ran with, the suggestion it made, and whether it was an edit. */
  appliedFilters?: BriefFilters; suggestion?: EvidenceScopeSuggestion | null; addedTerms?: string | null; edited?: boolean;
  /** Task 30: the automatic filter policy the search ran with, what it applied and why, and its check's outcome. */
  autoFilterPolicy?: { version: string; sha256: string }; automaticFilters?: EvidenceAutomaticFilters | null;
  autoFilterFields?: Partial<Record<'state' | 'years' | 'category', string>>; autoFilterReason?: string;
  attributionOutcome?: string; attributionCalled?: boolean;
}
/**
 * What a search runs with besides its question. The default is Task 24's: no filters.
 * An edit is the site's "Apply these filters": the parent's texts, no scope stage (Task 29).
 */
export interface SearchRequest {
  filters: BriefFilters;
  edited?: { executed: ExecutedTexts; lexicalSource: LexicalSource; addedTerms: string | null };
  skipScope?: boolean;
  /** Task 30: the automatic filter policy (default `none`, as every earlier task ran). */
  autoFilters?: EvidenceAutoFilterPolicy;
}
export interface RankingPort {
  /** Actual shared server pipeline with injected providers and the Task 24 production gate. */
  run(attempt: ScheduledSearch, question: RankingQuestion, request?: SearchRequest): Promise<SearchObservation>;
}
