/**
 * Search-time synonyms and stop words for NTSB narrative text (amendment A12).
 *
 * The list is deliberately small and versioned with the index (`CASES_INDEX_VERSION`):
 * changing a rule means a new index version and a rebuild. Rules use the Solr format
 * of Elasticsearch's `synonym_graph` filter and are applied only at search time, before
 * stop words and stemming, so they are written in lower case and unstemmed.
 *
 * - Spelling variants of one word are equivalent (`a, b, c`).
 * - Abbreviations expand one way and keep themselves (`abbr => abbr, expansion`): a
 *   search for "imc" also finds "instrument meteorological conditions" as a phrase,
 *   while a search for the spelled-out words keeps its own meaning (all words, any
 *   position) instead of turning into a phrase search.
 * - `stall` and `spin` are distinct mechanisms and never synonyms; "stall/spin" is
 *   split into both words by the tokenizer.
 */

export const AVIATION_SYNONYMS: readonly string[] = [
  'carb, carburetor, carburettor',
  'carb ice, carb icing => carb ice, carburetor icing, carburettor icing',
  'cfi => cfi, flight instructor',
  'wx => wx, weather',
  'imc => imc, instrument meteorological conditions',
  'vmc => vmc, visual meteorological conditions',
  'atc => atc, air traffic control',
  'ifr => ifr, instrument flight rules',
  'vfr => vfr, visual flight rules',
  'agl => agl, above ground level',
  'msl => msl, mean sea level',
  'cfit => cfit, controlled flight into terrain',
  'mx => mx, maintenance',
];

/** Lucene's English stop set, the `_english_` list of Elasticsearch's `stop` filter. */
export const ENGLISH_STOP_WORDS: readonly string[] = [
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it',
  'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'will', 'with',
];

/**
 * Negations always kept: "no anomalies" and "not determined" carry the finding. Only
 * `no` and `not` are in the English stop set; the others are listed so that no future
 * stop list can drop them.
 */
export const NEGATION_WORDS: readonly string[] = ['no', 'not', 'nor', 'none', 'never', 'without'];

/** The English stop set minus negations. */
export const AVIATION_STOP_WORDS: readonly string[] = ENGLISH_STOP_WORDS.filter((w) => !NEGATION_WORDS.includes(w));
