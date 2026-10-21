/**
 * Text analysis shared by the search indices (amendment A12).
 *
 * Index analyzer `aviation_english`:
 *   standard tokenizer -> lowercase -> English possessive stemmer -> stop words
 *   (English list minus negations) -> English stemmer.
 *
 * Search analyzer `aviation_english_search`: the same chain with `synonym_graph`
 * inserted after the possessive stemmer, i.e. before stop words and stemming.
 * Synonym rules are parsed by the filters in front of the synonym filter; a stop
 * filter there would drop "into" from "controlled flight into terrain" and
 * Elasticsearch refuses the rule set, so the synonyms run first and the stop filter
 * then removes "into" from the expansion while keeping its position gap, exactly as
 * at index time. Expansions are stemmed like the indexed text.
 *
 * Quoted phrases (`search_quote_analyzer`) use the index analyzer: a phrase matches
 * its own words, stemmed, with stop-word gaps, and without synonym expansion.
 *
 * Normalizer `aviation_name` (make, model, city): whitespace runs collapsed, trimmed,
 * ASCII-folded and upper-cased, so "Cessna" and "CESSNA" are one facet value and
 * one filter value.
 */
import type { estypes } from '@elastic/elasticsearch';
import { AVIATION_STOP_WORDS, AVIATION_SYNONYMS } from './synonyms.js';

export const INDEX_ANALYZER = 'aviation_english';
export const SEARCH_ANALYZER = 'aviation_english_search';
export const NAME_NORMALIZER = 'aviation_name';

export const AVIATION_ANALYSIS: estypes.IndicesIndexSettingsAnalysis = {
  char_filter: {
    aviation_collapse_whitespace: { type: 'pattern_replace', pattern: '\\s+', replacement: ' ' },
  },
  filter: {
    aviation_possessive: { type: 'stemmer', language: 'possessive_english' },
    aviation_stop: { type: 'stop', stopwords: [...AVIATION_STOP_WORDS], ignore_case: false },
    aviation_synonyms: { type: 'synonym_graph', synonyms: [...AVIATION_SYNONYMS], lenient: false },
    aviation_stemmer: { type: 'stemmer', language: 'english' },
  },
  analyzer: {
    [INDEX_ANALYZER]: {
      type: 'custom',
      tokenizer: 'standard',
      filter: ['lowercase', 'aviation_possessive', 'aviation_stop', 'aviation_stemmer'],
    },
    [SEARCH_ANALYZER]: {
      type: 'custom',
      tokenizer: 'standard',
      filter: ['lowercase', 'aviation_possessive', 'aviation_synonyms', 'aviation_stop', 'aviation_stemmer'],
    },
  },
  normalizer: {
    [NAME_NORMALIZER]: {
      type: 'custom',
      char_filter: ['aviation_collapse_whitespace'],
      filter: ['trim', 'asciifolding', 'uppercase'],
    },
  },
};

/** Mapping of a narrative text field. Offsets in the postings make highlighting cheap. */
export function aviationTextField(): estypes.MappingTextProperty {
  return {
    type: 'text',
    analyzer: INDEX_ANALYZER,
    search_analyzer: SEARCH_ANALYZER,
    search_quote_analyzer: INDEX_ANALYZER,
    index_options: 'offsets',
  };
}
