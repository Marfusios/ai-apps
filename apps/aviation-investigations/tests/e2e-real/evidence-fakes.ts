/**
 * The offline scope stage of the AI-on end-to-end server (tests/e2e-real/server.ts): the fake
 * provider's scripted `scope.e3` output for each question the browser tests ask
 * (tests/e2e-real/evidence.spec.ts), and the attributed-policy app's scripted attribution check
 * (`e2eAttribution`). Each output goes through the same schema and validator as a model's would;
 * nothing is sent anywhere.
 *
 * - `carb`: a case search with a suggestion of one filter and terms (no capability note);
 * - `poem`: `out_of_scope`, which selects the `scope` capability note;
 * - `advice`: `operational_advice`, which selects the `operational_advice` note;
 * - `scopeFails`: an output the schema refuses, so the search has no suggestion and no note;
 * - `state`, `stateMarked`: a case search with a filter, the state the question names and terms
 *   (the release app applies the state and suggests the rest; the baseline app would only suggest
 *   them all); the cases of `stateMarked`'s state hold the terms;
 * - `fields`: a case search with the state, years and aircraft category the question names, a phase
 *   and terms (the attributed-policy app applies the three, once its check approves each value, and
 *   suggests the rest);
 * - anything else: a case search suggesting the question's own words as terms, no filters.
 */
import type { FakeResult } from '../../server/ai/fake.js';
import type { AttributionInput, AttributionOutput } from '../../server/ai/prompts/attribution.a2.js';
import type { RerankInput, RerankOutput } from '../../server/ai/prompts/rerank.r1.js';
import type { EvidenceScopeInput, EvidenceScopeOutput } from '../../server/ai/prompts/scope.e1.js';

/**
 * The stand-in for Google's client both sign-in apps share (tests/e2e-real/auth-server.ts, and the
 * live-configuration app of tests/e2e-real/server.ts); synthetic.
 */
export const E2E_GOOGLE_CLIENT = { id: 'casebook-e2e.apps.googleusercontent.com', secret: 'synthetic-google-client-secret' } as const;

/** The live-configuration app's admin (`AIRCASE_ADMIN_EMAILS`): the stand-in's account for `e2e_user=admin`. */
export const E2E_ADMIN_EMAIL = 'e2e-admin@example.com';

/**
 * The fake reranker of the live-configuration app: a grade for every case it is given, 3 down to 0
 * in turn, so the leading results are put in another order than the match's.
 */
export function e2eRerank(input: RerankInput): FakeResult<RerankOutput> {
  return { output: { grades: input.cases.map((c, i) => ({ id: c.id, grade: 3 - (i % 4) })) } };
}

export const E2E_QUESTIONS = {
  carb: 'Carburetor icing on approach',
  poem: 'Write a poem about clouds',
  advice: 'What should I do right now, my engine is running rough',
  scopeFails: 'Fuel exhaustion on a night cross-country flight',
  state: 'Carburetor icing on approach in Texas',
  stateMarked: 'Carburetor icing on approach in Missouri',
  fields: 'Helicopter power loss on approach in Texas since 2008',
} as const;

/** The suggestion the fake scope stage makes for `E2E_QUESTIONS.carb`. */
export const CARB_SUGGESTION = { filters: { phase: ['approach'] }, terms: 'carburetor icing' } as const;

/** The suggestion it makes for `E2E_QUESTIONS.state`: the question names Texas. */
export const STATE_SUGGESTION = { filters: { phase: ['approach'], state: ['TX'] }, terms: 'carburetor icing' } as const;

/** The suggestion it makes for `E2E_QUESTIONS.stateMarked`: the question names Missouri. */
export const STATE_MARKED_SUGGESTION = { filters: { phase: ['approach'], state: ['MO'] }, terms: 'carburetor icing' } as const;

/** The suggestion it makes for `E2E_QUESTIONS.fields`: the question names Texas, the years since 2008 and helicopters. */
export const FIELDS_SUGGESTION = { filters: { phase: ['approach'], state: ['TX'], yearFrom: 2008, category: ['HELI'] }, terms: 'power loss' } as const;

/**
 * What the fake attribution check (attr.a2) quotes for each candidate value of `E2E_QUESTIONS.fields`,
 * by the candidate's id (`state:<code>`, `years`, `category:<code>`, server/evidence/attribution.ts):
 * the words of the question that name it.
 */
const FIELDS_QUOTES: Readonly<Record<string, string>> = { 'state:TX': 'in Texas', years: 'since 2008', 'category:HELI': 'Helicopter power loss' };
/** The accident class each field's check must report to be applied. */
const ACCIDENT_ABOUT = { state: 'accident_location', years: 'accident_date', category: 'accident_aircraft' } as const satisfies Record<AttributionInput['candidates'][number]['field'], AttributionOutput['checks'][number]['about']>;

/**
 * The attributed-policy app's attribution check: one check per candidate value, as attr.a2 asks.
 * For `E2E_QUESTIONS.fields` each value is about the accident itself, quoted with its own words; any
 * other value is no constraint, so nothing else is applied.
 */
export function e2eAttribution(input: AttributionInput): FakeResult<AttributionOutput> {
  const known = input.question === E2E_QUESTIONS.fields;
  return {
    output: {
      checks: input.candidates.map((c) => {
        const quote = known ? FIELDS_QUOTES[c.id] : undefined;
        return quote ? { id: c.id, about: ACCIDENT_ABOUT[c.field], quote } : { id: c.id, about: 'not_a_constraint' as const, quote: '' };
      }),
    },
  };
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
    case E2E_QUESTIONS.stateMarked:
      return {
        output: { intent: 'case_search', filters: { phase: [...STATE_MARKED_SUGGESTION.filters.phase], state: [...STATE_MARKED_SUGGESTION.filters.state] }, terms: STATE_MARKED_SUGGESTION.terms },
      };
    case E2E_QUESTIONS.fields: {
      const { phase, state, yearFrom, category } = FIELDS_SUGGESTION.filters;
      return { output: { intent: 'case_search', filters: { phase: [...phase], state: [...state], yearFrom, category: [...category] }, terms: FIELDS_SUGGESTION.terms } };
    }
    default: {
      const terms = input.question.replace(/\s+/g, ' ').trim().slice(0, 300);
      return { output: { intent: 'case_search', filters: {}, terms } };
    }
  }
}
