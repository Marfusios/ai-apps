/**
 * The offline scope stage of the AI-on end-to-end server (tests/e2e-real/server.ts): the fake
 * provider's scripted `scope.e3` output for each question the browser tests ask
 * (tests/e2e-real/evidence.spec.ts). Each output goes through the same schema and validator as
 * a model's would; nothing is sent anywhere.
 *
 * - `carb`: a case search with a suggestion of one filter and terms (no capability note);
 * - `poem`: `out_of_scope`, which selects the `scope` capability note;
 * - `advice`: `operational_advice`, which selects the `operational_advice` note;
 * - `scopeFails`: an output the schema refuses, so the search has no suggestion and no note;
 * - anything else: a case search suggesting the question's own words as terms, no filters.
 */
import type { FakeResult } from '../../server/ai/fake.js';
import type { EvidenceScopeInput, EvidenceScopeOutput } from '../../server/ai/prompts/scope.e1.js';

export const E2E_QUESTIONS = {
  carb: 'Carburetor icing on approach',
  poem: 'Write a poem about clouds',
  advice: 'What should I do right now, my engine is running rough',
  scopeFails: 'Fuel exhaustion on a night cross-country flight',
} as const;

/** The suggestion the fake scope stage makes for `E2E_QUESTIONS.carb`. */
export const CARB_SUGGESTION = { filters: { phase: ['approach'] }, terms: 'carburetor icing' } as const;

export function e2eEvidenceScope(input: EvidenceScopeInput): FakeResult<EvidenceScopeOutput> {
  switch (input.question) {
    case E2E_QUESTIONS.carb:
      return { output: { intent: 'case_search', filters: { phase: [...CARB_SUGGESTION.filters.phase] }, terms: CARB_SUGGESTION.terms } };
    case E2E_QUESTIONS.poem:
      return { output: { intent: 'out_of_scope', filters: {} } };
    case E2E_QUESTIONS.advice:
      return { output: { intent: 'operational_advice', filters: {} } };
    case E2E_QUESTIONS.scopeFails:
      // A model answer that is not the schema: the adapter's `invalid_output` (billed).
      return { fail: 'invalid_output' };
    default: {
      const terms = input.question.replace(/\s+/g, ' ').trim().slice(0, 300);
      return { output: { intent: 'case_search', filters: {}, terms } };
    }
  }
}
