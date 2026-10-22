/**
 * Search-time synonyms, stem overrides and stop words for NTSB narrative text
 * (amendment A12).
 *
 * Everything here is versioned with the index (`CASES_INDEX_VERSION`): changing a rule
 * means a new index version and a rebuild. Synonym rules use the Solr format of
 * Elasticsearch's `synonym_graph` filter. They run only at search time, after
 * lowercasing and before stop words and stemming, so they are written in lower case
 * and unstemmed, with explicit plurals where a plural is common.
 *
 * - Equivalences (`a, b, c`) where every form means the same thing: spelling
 *   variants (carb/carburetor/carburettor) and abbreviations whose long form is
 *   unambiguous (IMC, VMC, ATC, IFR, VFR, AGL, MSL, CFIT, CFI). A spelled-out query
 *   then also finds the abbreviation; note that a multi-word alternative is matched
 *   as a phrase, so "air traffic control" searches the phrase or "atc".
 * - One-way rules (`abbr => abbr, expansion`) where the long form is an ordinary word
 *   that should not pull in an abbreviation with other uses (wx, mx), and for
 *   "carb ice", whose expansion would otherwise turn every "carburetor icing" query
 *   into a phrase search.
 * - Quoted phrases never expand: the fields' `search_quote_analyzer` is the index
 *   analyzer, so `"carb ice"` matches only those words.
 * - `stall` and `spin` are distinct mechanisms and never synonyms; "stall/spin" is
 *   split into both words by the tokenizer.
 */

export const AVIATION_SYNONYMS: readonly string[] = [
  'carb, carbs, carburetor, carburetors, carburettor, carburettors',
  'carb ice, carb icing => carb ice, carburetor icing, carburettor icing',
  'cfi, cfis, flight instructor, flight instructors',
  'imc, instrument meteorological conditions',
  'vmc, visual meteorological conditions',
  'atc, air traffic control',
  'ifr, instrument flight rules',
  'vfr, visual flight rules',
  'agl, above ground level',
  'msl, mean sea level',
  'cfit, controlled flight into terrain',
  'wx => wx, weather',
  'mx => mx, maintenance',
];

/**
 * Stems fixed before the light English (KStem) stemmer, which leaves these inflections
 * apart because its dictionary knows them as words ("icing", "conditions") or
 * mis-stems them ("overheated" -> "overheate"). Applied at index and search time.
 */
export const STEM_OVERRIDES: readonly string[] = [
  'icing => ice',
  'freezing => freeze',
  'cracked => crack',
  'impacted => impact',
  'determined => determine',
  'conditions => condition',
  'landed => land',
  'disconnected => disconnect',
  'overheated => overheat',
  'disoriented => disorientate',
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
