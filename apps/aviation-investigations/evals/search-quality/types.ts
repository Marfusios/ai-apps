import type { CodedQuestionSpec } from '../retrieval/coded/coded.js';
import type { GenerationSource } from '../retrieval/generation.js';
import type { EvidenceScopeOutput } from '../../server/ai/prompts/scope.e1.js';
import type { StageUsage } from '../../server/ai/provider.js';

export type Field = 'state' | 'yearRange' | 'category' | 'phase' | 'injury' | 'conditions' | 'light';
export type Filters = Record<string, string[] | number>;
export interface FieldQuestion {
  id: string; field: Field; role: 'positive' | 'control'; critical: boolean;
  wordingFamily: string; question: string; gold: Filters;
  seed: { ntsb_no: string; state: string; ev_year: number; highest_injury: string | null;
    wx_cond_basic: string | null; light_cond: string | null; source_revision: string };
  aircraft: { aircraft_key: number; category: string | null; defining_phase_group: string | null }[];
  additionalSeed?: string; additionalSeedValue?: string; additionalSeedRevision?: string;
}
export interface ABQuestion extends Pick<CodedQuestionSpec, 'id' | 'question' | 'area' | 'class' | 'filters' | 'codeSet'> {
  family: string; topic: string; relevant: string[]; group: string; paraphraseOf: string | null;
  executionFilters: Record<string, never>;
}
export interface FieldDataset { version: 'task24-fields-v1'; source: GenerationSource; questions: FieldQuestion[] }
export interface ABDataset { version: 'task24-confirmation-v1'; source: GenerationSource; questions: ABQuestion[]; narrativeQuestionIds: string[] }
export interface FieldObservation {
  id: string; output: EvidenceScopeOutput | null; error: string | null; usage: StageUsage | null;
  elapsedMs: number; reservationId: string; chargedUsd: number;
}
