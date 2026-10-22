/**
 * Text analysis shared by the search indices (amendment A12, gate G3 rulings).
 *
 * Index analyzer `aviation_english`:
 *   standard tokenizer -> lowercase -> English possessive stemmer -> stop words
 *   (English list minus negations) -> stem overrides -> light English stemmer (KStem).
 *
 * KStem is conservative: unlike Porter it keeps generator/general/generation,
 * engineer/engine and experience/experiment apart. Its dictionary also keeps a few
 * inflections apart that matter here (icing/ice, conditions/condition), which
 * `STEM_OVERRIDES` joins before it runs.
 *
 * Search analyzer `aviation_english_search`: the same chain with `synonym_graph`
 * inserted after the possessive stemmer, i.e. before stop words and stemming.
 * Synonym rules are parsed by the filters in front of the synonym filter; a stop
 * filter there would drop "into" from "controlled flight into terrain" and
 * Elasticsearch refuses the rule set, so the synonyms run first and the stop filter
 * then removes "into" from the expansion while keeping its position gap, exactly as
 * at index time (ordering approved at G3). Expansions are stemmed like indexed text.
 *
 * Quoted phrases (`search_quote_analyzer`) use the index analyzer: a phrase matches
 * its own words, stemmed, with stop-word gaps, and never expands synonyms.
 *
 * Text fields hold one array value per source section or finding, with a position
 * gap of 100 between values, so a phrase (with any slop below 100) never spans two
 * sections.
 *
 * Normalizer `aviation_name` (make, model, city): whitespace runs collapsed, trimmed,
 * ASCII-folded and upper-cased, so "Cessna" and "CESSNA" are one facet value and
 * one filter value.
 */
import type { estypes } from '@elastic/elasticsearch';
import { AVIATION_STOP_WORDS, AVIATION_SYNONYMS, STEM_OVERRIDES } from './synonyms.js';

export const INDEX_ANALYZER = 'aviation_english';
export const SEARCH_ANALYZER = 'aviation_english_search';
export const NAME_NORMALIZER = 'aviation_name';
/** Positions between two values of one text field; phrase slop must stay below it. */
export const SECTION_POSITION_GAP = 100;

export const AVIATION_ANALYSIS: estypes.IndicesIndexSettingsAnalysis = {
  char_filter: {
    aviation_collapse_whitespace: { type: 'pattern_replace', pattern: '\\s+', replacement: ' ' },
  },
  filter: {
    aviation_possessive: { type: 'stemmer', language: 'possessive_english' },
    aviation_stop: { type: 'stop', stopwords: [...AVIATION_STOP_WORDS], ignore_case: false },
    aviation_synonyms: { type: 'synonym_graph', synonyms: [...AVIATION_SYNONYMS], lenient: false },
    aviation_stem_overrides: { type: 'stemmer_override', rules: [...STEM_OVERRIDES] },
    aviation_stemmer: { type: 'stemmer', language: 'light_english' },
  },
  analyzer: {
    [INDEX_ANALYZER]: {
      type: 'custom',
      tokenizer: 'standard',
      filter: ['lowercase', 'aviation_possessive', 'aviation_stop', 'aviation_stem_overrides', 'aviation_stemmer'],
    },
    [SEARCH_ANALYZER]: {
      type: 'custom',
      tokenizer: 'standard',
      filter: [
        'lowercase',
        'aviation_possessive',
        'aviation_synonyms',
        'aviation_stop',
        'aviation_stem_overrides',
        'aviation_stemmer',
      ],
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
    position_increment_gap: SECTION_POSITION_GAP,
  };
}
