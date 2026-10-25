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
 * - `state`: a case search with a filter, the state the question names and terms (the v3 app
 *   applies the state and searches the terms; the baseline app would only suggest them);
 * - anything else: a case search suggesting the question's own words as terms, no filters.
 *
 * The reranker of the v3 app (`e2eRerank`) grades every case it is sent, fixed grades by place.
 */
import type { FakeResult } from '../../server/ai/fake.js';
import type { RerankInput, RerankOutput } from '../../server/ai/prompts/rerank.r1.js';
import type { EvidenceScopeInput, EvidenceScopeOutput } from '../../server/ai/prompts/scope.e1.js';

export const E2E_QUESTIONS = {
  carb: 'Carburetor icing on approach',
  poem: 'Write a poem about clouds',
  advice: 'What should I do right now, my engine is running rough',
  scopeFails: 'Fuel exhaustion on a night cross-country flight',
  state: 'Carburetor icing on approach in Texas',
} as const;

/** The suggestion the fake scope stage makes for `E2E_QUESTIONS.carb`. */
export const CARB_SUGGESTION = { filters: { phase: ['approach'] }, terms: 'carburetor icing' } as const;

/** The suggestion it makes for `E2E_QUESTIONS.state`: the question names Texas. */
export const STATE_SUGGESTION = { filters: { phase: ['approach'], state: ['TX'] }, terms: 'carburetor icing' } as const;

/** Grades for every case sent, by place: the last case first (a visible change of order), the rest as related. */
export function e2eRerank(input: RerankInput): FakeResult<RerankOutput> {
  return { output: { grades: input.cases.map((c, i) => ({ id: c.id, grade: i === input.cases.length - 1 ? 3 : 2 })) } };
}

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
    case E2E_QUESTIONS.state:
      return { output: { intent: 'case_search', filters: { phase: [...STATE_SUGGESTION.filters.phase], state: [...STATE_SUGGESTION.filters.state] }, terms: STATE_SUGGESTION.terms } };
    default: {
      const terms = input.question.replace(/\s+/g, ' ').trim().slice(0, 300);
      return { output: { intent: 'case_search', filters: {}, terms } };
    }
  }
}
