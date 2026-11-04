/**
 * Which of the scope's suggested state, years and aircraft category a question names explicitly
 * enough to be checked for automatic use (`attributed.v1`, Task 30 spec §2, the design review and
 * the task review). Deterministic and structural, never semantic: a candidate only says that the
 * question's own words name exactly the suggested values, once each, in a form a filter conjunction
 * can represent. Whether those words describe the accident itself is the separate attribution check
 * (server/evidence/attribution.ts). Every rule here can only remove candidates; nothing creates a
 * filter value, and nothing reads model text except the suggested values compared against.
 *
 * Positions (`WitnessSpan`) index `normalizedQuestion(question)`: NFKC, whitespace collapsed to one
 * space, trimmed. A candidate keeps, per value, the one span of the question that names it (its
 * witness): a full state name, a whole `City, XX` place for a postal code, a category word (adjacent
 * words of one category as one span), or the complete year expression with its operator. The
 * attribution check's quote for each value must contain that value's witness.
 */
import type { BriefFilters } from './contracts/briefs.js';
import { AIRCRAFT_CATEGORY, US_STATE, US_STATE_CODES } from './vocab.js';

export const STATE_MENTION_VERSION = 'state-mention.v1';
export const YEAR_MENTION_VERSION = 'year-mention.v1';
export const CATEGORY_MENTION_VERSION = 'category-mention.v1';

export const AUTOMATIC_FIELDS = Object.freeze(['state', 'years', 'category'] as const);
export type AutomaticField = typeof AUTOMATIC_FIELDS[number];
/** The most values one field may send to the check, which judges each value (attr.a3). */
export const AUTOMATIC_MAX_STATES = 8;
export const AUTOMATIC_MAX_CATEGORIES = 3;

/**
 * Why a field is or is not a candidate. `unsafe_text`, `conditional_or_exception` and
 * `union_of_requests` refuse every field the scope suggested; `cross_field_alternative` refuses
 * every field that was a candidate. `referenced_event`, `title_text` and `attribute_word` refuse a
 * value whose mention describes something other than the requested accidents.
 */
export type CandidateReason = 'candidate' | 'disabled' | 'requested' | 'empty' | 'unsupported_value' | 'too_many_values'
  | 'unsafe_text' | 'conditional_or_exception' | 'union_of_requests' | 'not_restricted' | 'cross_field_alternative' | 'not_explicit'
  | 'set_mismatch' | 'negated' | 'relationship' | 'ambiguous_name' | 'referenced_event' | 'title_text' | 'attribute_word'
  | 'range_mismatch' | 'ambiguous_expression' | 'repeated_mention';

/**
 * [start, end) in `normalizedQuestion(question)`. A merged category mention ("blimp or airship")
 * also lists its words: a quote covering any one of them covers the value.
 */
export interface WitnessSpan { readonly start: number; readonly end: number; readonly parts?: readonly { readonly start: number; readonly end: number }[] }

/** A field the attribution check may approve. `witnesses` holds one span per value, in value order (one for years). */
export type AutomaticCandidate =
  | { field: 'state'; state: string[]; witnesses: WitnessSpan[] }
  | { field: 'years'; yearFrom?: number; yearTo?: number; witnesses: WitnessSpan[] }
  | { field: 'category'; category: string[]; witnesses: WitnessSpan[] };

export interface AutomaticCandidates {
  /** In field order: state, years, category. */
  candidates: AutomaticCandidate[];
  reasons: Record<AutomaticField, CandidateReason>;
}

// ---------------------------------------------------------------------------
// Fixed rules and word lists. The behavioural probes (server/evidence/candidate-probes.ts) hash
// their outputs, so changing any of these changes the policy identity.

/** Longer questions are never candidates. */
export const AUTOMATIC_QUESTION_MAX_CHARS = 600;
/**
 * Control, format and default-ignorable characters (tab, line feed and carriage return are
 * whitespace): soft hyphens, bidi marks, joiners, Hangul fillers, variation selectors and tags,
 * text a reader may not see.
 */
export const UNSAFE_CHARACTERS = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/**
 * Quotation marks: every initial and final quote except the apostrophe ’, low-9, corner and ornament
 * quotes, double primes, backticks and angle brackets, and single-quoted spans with ' or ’ (a lone
 * ’ is an apostrophe: "the pilot’s"). Tested on the question as asked and after NFKC.
 */
export const QUOTED_TEXT = /["`<>\u201a\u201e\u2033\u2036\u276e\u276f\u2e42\u300c-\u300f\u301d-\u301f]|(?!\u2019)[\p{Pi}\p{Pf}]|(?:^|\W)'[^']+'(?:\W|$)|(?:^|\W)\u2019[^\u2019]+\u2019(?:\W|$)/u;
/**
 * Instruction and role wording, after NFKC. Defence in depth: Task 24 found injection controls made
 * scope.e3 emit a state on 38 of 50 and years on 48 of 50. Only instruction-like phrasing counts:
 * "the pilot ignored a warning", "override the autopilot", "flight instruction" and "fuel system" stay.
 */
export const INJECTION_PATTERNS: readonly RegExp[] = Object.freeze([
  // ignore/disregard/override with an instruction target within the next two words.
  /\b(?:ignor(?:e|es|ed|ing)|disregard(?:s|ed|ing)?|overrid(?:e|es|ing|den)|overrode)(?:[^\p{L}\p{N}]+[\p{L}\p{N}'’-]+)?[^\p{L}\p{N}]+(?:instructions?|rules?|filters?|prompt|system|guidelines?|the above|previous|prior)\b/iu,
  /\b(?:previous|prior|above|earlier|system|these|those|my|your|all|the|new)\s+instructions?\b/iu,
  /\b(?:pretend\w*|prompt|assistant)\b/iu,
  /\bsystem\s+(?:prompt|message|rules?)\b/iu,
  /\b(?:set|add|apply|output|return|force|use)\s+(?:the\s+|a\s+|an\s+)?(?:state|years?|dates?|category|filters?|json)\b/iu,
]);
/** Conditions and exceptions a filter conjunction cannot represent, anywhere in the question. */
export const CONDITION_OR_EXCEPTION = /(?<![\p{L}\p{N}_])(?:if|unless|except|excepting|excepted|excluding|exclude|excludes|excluded|but not)(?![\p{L}\p{N}_])/iu;
/**
 * Two requests in one question, which the filters' AND cannot run as one search, so every field is
 * refused: an accident noun before one of these joiners, marker words or marks in one sentence (not
 * inside one field's value list), and after it an accident noun, or directly (past "the" and marker
 * words) a pronoun head or a state or category word ("Alaska accidents and helicopter accidents",
 * "Alaska accidents, helicopter accidents", "accidents in Alaska and those involving helicopters").
 * Values of two fields in different sentences too ("Find Alaska accidents. Also helicopter
 * accidents."). Only these nouns: "the investigation archive for gusts and ... the event location"
 * is one request.
 */
export const UNION_EVENT_NOUNS = Object.freeze(['accident', 'accidents', 'crash', 'crashes', 'incident', 'incidents', 'mishap',
  'mishaps'] as const);
export const UNION_JOINERS = Object.freeze(['and', 'or', 'as well as', 'plus', 'along with', 'together with', '&', '/'] as const);
export const UNION_MARKERS = Object.freeze(['also', 'too', 'then', 'alternatively', 'otherwise', 'else', 'failing that',
  'in addition to', 'in addition', 'besides', 'separately'] as const);
/** Comma, semicolon, en and em dash, and a spaced hyphen. */
export const UNION_PUNCTUATION = Object.freeze([',', ';', '\u2013', '\u2014', ' - '] as const);
export const UNION_PRONOUN_HEADS = Object.freeze(['one', 'ones', 'those', 'any', 'anything', 'whatever', 'others'] as const);
/**
 * Alternative words. AirCase joins different filters with AND, so an alternative that touches a
 * candidate cannot be represented. With two or more fields named in the question (candidates or
 * not), any of these outside one field's own value list ("Alaska or Hawaii", "helicopters or
 * gyroplanes", "2015 or 2018") refuses every candidate. With one, only one that has a candidate's
 * words among the two words before or after it does ("in Alaska or at night"; "fatal or serious
 * accidents in Alaska" keeps its state). "or later" and "or earlier" are year expressions.
 */
export const ALTERNATIVE_WORDS = Object.freeze(['or', 'either', 'nor'] as const);
export const ALTERNATIVE_WINDOW_WORDS = 2;
/** Comparisons: with any candidate, every field is refused. */
export const COMPARISON_WORDS = Object.freeze(['versus', 'vs', 'compare', 'compared', 'comparing', 'comparison', 'unlike',
  'rather than', 'instead of', 'whereas'] as const);
/** Words that may join two values of one list, and the qualifiers allowed around them. */
export const LIST_SEPARATORS = Object.freeze(['or', 'nor', 'and'] as const);
export const LIST_QUALIFIERS = Object.freeze(['the', 'state', 'of', 'in', 'near', 'at', 'a', 'an'] as const);
/**
 * Exclusions and contrasts among the four words before a mention. Also: a word ending in n't,
 * "but" after every/all/any ("every state but Alaska"), a non- or ex- prefix on the mention itself,
 * and "aside" directly after it ("Alaska aside").
 */
export const LOCAL_NEGATIONS = Object.freeze(['not', 'no', 'never', 'without', 'nowhere', 'none', 'outside', 'except',
  'excluding', 'exclude', 'other than', 'rather than', 'instead of', 'besides', 'beyond', 'anywhere but', 'apart from',
  'far from', 'neither', 'nor', 'avoid', 'avoids', 'avoided', 'avoiding', 'elsewhere', 'leaving out', 'aside', 'skipping',
  'omitting', 'minus'] as const);
export const NEGATION_BUT_LEADS = Object.freeze(['every', 'all', 'any'] as const);
export const NEGATION_AFTER_WORDS = Object.freeze(['aside'] as const);
export const NEGATION_WINDOW_WORDS = 4;

/** Place nouns that make a directly preceding state name part of another place's name ("Kansas City"). */
export const STATE_PLACE_SUFFIXES = Object.freeze(['city', 'county', 'river', 'bay', 'lake', 'sound', 'valley', 'canyon',
  'island', 'islands', 'panhandle', 'keys', 'gulf', 'strait', 'peninsula', 'range', 'mountain', 'mountains'] as const);
/** Prepositions before a `City, XX` postal place (or the question's start). */
export const POSTAL_PREPOSITIONS = Object.freeze(['in', 'near', 'at'] as const);

/**
 * The words naming each aircraft category (the vocabulary except UNK). Longest match first. Not
 * "plane", "aircraft", "jet", "fixed-wing" (gliders and ultralights are fixed-wing too) or
 * "rotorcraft" (gyroplanes are rotorcraft too).
 */
export const CATEGORY_WORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  AIR: Object.freeze(['airplane', 'airplanes', 'aeroplane', 'aeroplanes']),
  HELI: Object.freeze(['helicopter', 'helicopters', 'chopper', 'choppers']),
  GLI: Object.freeze(['glider', 'gliders', 'sailplane', 'sailplanes']),
  BALL: Object.freeze(['hot air balloon', 'hot air balloons', 'hot-air balloon', 'hot-air balloons', 'balloon', 'balloons']),
  BLIM: Object.freeze(['blimp', 'blimps', 'airship', 'airships']),
  GYRO: Object.freeze(['gyroplane', 'gyroplanes', 'gyrocopter', 'gyrocopters', 'autogyro', 'autogyros', 'gyrocraft']),
  PLFT: Object.freeze(['powered-lift', 'tiltrotor', 'tiltrotors']),
  ULTR: Object.freeze(['ultralight', 'ultralights']),
  WSFT: Object.freeze(['weight-shift', 'trike', 'trikes']),
  PPAR: Object.freeze(['powered parachute', 'powered parachutes']),
});
/** Words of one category with at most this many words between them are one mention ("weight-shift trike", "blimp or airship"). */
export const CATEGORY_MERGE_WORDS = 2;
/** Multi-aircraft relationships: a category filter cannot say which aircraft is meant. */
export const RELATIONSHIP_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bcollisions?\b/iu, /\bcollid(?:e|es|ed|ing)\b/iu, /\bmid[- ]?airs?\b/iu,
  /\btow(?:s|ed|ing)?\b/iu, /\btow[- ]?planes?\b/iu, /\bformations?\b/iu,
  /\bwake\b/iu, /\bdownwash\b/iu, /\brescu(?:e|es|ed|ing|er|ers)\b/iu,
  /\b(?:two|three|four|both|multiple|several|second|another|other)\s+(?:[\p{L}-]+\s+)?(?:aircraft|planes?|jets?|airplanes?|aeroplanes?|helicopters?|choppers?|gliders?|sailplanes?|balloons?|blimps?|airships?|gyroplanes?|gyrocopters?|autogyros?|tiltrotors?|ultralights?|trikes?)\b/iu,
  /\bbetween\s+(?:a|an|the|two)\b/iu,
  // Another aircraft or traffic near the accident aircraft ("with an aircraft nearby").
  /\baircraft\s+nearby\b/iu, /\bnearby\s+(?:aircraft|traffic)\b/iu, /\ban\s+aircraft\s+(?:nearby|close\s+by|in\s+the\s+vicinity)\b/iu,
  /\b(?:other|conflicting)\s+traffic\b/iu, /\bsecond\s+aircraft\b/iu, /\bthe\s+other\s+aircraft\b/iu,
  /\ba\s+second\s+(?:airplane|helicopter|aircraft)\b/iu,
]);
/**
 * A category word directly followed by one of these names a person, a business, a part, a kit, a
 * simulator or a model ("airplane parts", "helicopter rotor", "glider kit"), not the accident aircraft.
 */
export const CATEGORY_ATTRIBUTE_NOUNS = Object.freeze(['pilot', 'pilots', 'instructor', 'instructors', 'student', 'students',
  'rating', 'ratings', 'rated', 'license', 'licence', 'licensed', 'certificate', 'dealership', 'dealer', 'dealers', 'operator',
  'operators', 'company', 'companies', 'manufacturer', 'festival', 'crew', 'tires', 'tyres', 'instruction', 'training', 'school',
  'club', 'part', 'parts', 'engine', 'engines', 'propeller', 'propellers', 'rotor', 'rotors', 'wing', 'wings', 'kit', 'kits',
  'simulator', 'simulators', 'model', 'models'] as const);
/** Of those, the parts: a rejected mention of an unsuggested category before one always refuses the field ("airplane engine failures"). */
export const CATEGORY_PART_NOUNS = Object.freeze(['part', 'parts', 'engine', 'engines', 'propeller', 'propellers', 'rotor', 'rotors',
  'wing', 'wings', 'kit', 'kits', 'model', 'models'] as const);
/** Experience in a category ("hours in helicopters", "transitioned from gliders") within the three words before it. */
export const CATEGORY_EXPERIENCE_WORDS = Object.freeze(['hours', 'time', 'experience', 'rated', 'rating', 'trained', 'training',
  'instruction', 'transitioned', 'transferred'] as const);
export const CATEGORY_EXPERIENCE_PREPOSITIONS = Object.freeze(['in', 'on', 'from'] as const);
/** A category used as a comparison ("like a helicopter", "faster than a glider") within the three words before it. */
export const CATEGORY_COMPARISON_PHRASES = Object.freeze(['like a', 'like an', 'such as', 'than a', 'than an'] as const);
export const CATEGORY_ATTRIBUTE_WINDOW_WORDS = 3;
/**
 * Another event: a reference word followed within six words by an event noun or pronoun, with the
 * value between them or within four words after the noun ("investigations citing accidents in
 * Alaska", "accidents like those in Alaska"). "like to" is no reference, nor is a reference word
 * that opens the question, after an optional please, can you or could you ("Compare helicopter
 * accidents in ..."). A reading list or a discussion is no other event.
 */
export const REFERENCE_WORDS = Object.freeze(['cite', 'cites', 'cited', 'citing', 'citation', 'mention', 'mentions', 'mentioned',
  'mentioning', 'reference', 'references', 'referenced', 'referencing', 'refer', 'refers', 'referred', 'referring', 'compare',
  'compared', 'comparing', 'comparable', 'resemble', 'resembles', 'resembled', 'resembling', 'similar', 'like', 'unlike', 'follow',
  'follows', 'followed', 'following', 'lesson', 'lessons'] as const);
export const REFERENCE_OPENERS = Object.freeze(['please', 'can you', 'could you'] as const);
/** Writing about another event: one of these words with about/on/of within the next two words acts as a reference word there. */
export const REFERENCE_WRITING_WORDS = Object.freeze(['wrote', 'write', 'writes', 'written', 'writing'] as const);
export const REFERENCE_WRITING_PREPOSITIONS = Object.freeze(['about', 'on', 'of'] as const);
export const REFERENCE_WRITING_WINDOW_WORDS = 2;
export const REFERENCED_EVENT_NOUNS = Object.freeze(['accident', 'accidents', 'crash', 'crashes', 'incident', 'incidents', 'event',
  'events', 'mishap', 'mishaps', 'occurrence', 'occurrences', 'case', 'cases', 'one', 'ones', 'those', 'that'] as const);
export const REFERENCE_NOUN_WINDOW_WORDS = 6;
export const REFERENCE_AFTER_NOUN_WORDS = 4;
/**
 * Title or text wording within the six words before a value: the value names words, not accidents.
 * A summary or abstract counts only directly before a naming verb ("whose summary mentions Alaska",
 * not "accident summaries for Ohio").
 */
export const TITLE_WORDS = Object.freeze(['title', 'titles', 'titled', 'heading', 'headings', 'header', 'headers', 'headline',
  'headlines', 'caption', 'captions', 'wording', 'words', 'phrase', 'phrases', 'text'] as const);
export const TITLE_SUMMARY_WORDS = Object.freeze(['summary', 'summaries', 'abstract', 'abstracts'] as const);
export const TITLE_NAMING_VERBS = Object.freeze(['mentions', 'says', 'reads', 'titled', 'named', 'called'] as const);
export const TITLE_WINDOW_WORDS = 6;
/**
 * Words that say a field does not limit the request ("wherever the investigated event occurred",
 * "whatever year the accident happened"): that field is no candidate (`not_restricted`).
 */
export const NOT_RESTRICTED_PHRASES: Readonly<Record<AutomaticField, readonly string[]>> = Object.freeze({
  state: Object.freeze(['wherever', 'regardless of where', 'no matter where', 'anywhere in the country', 'anywhere in the US',
    'anywhere in the U.S.', 'anywhere else']),
  years: Object.freeze(['whenever', 'whatever year', 'regardless of when', 'no matter when', 'in any year']),
  category: Object.freeze(['whatever aircraft', 'any aircraft type', 'regardless of aircraft', 'regardless of the aircraft',
    'no matter what aircraft']),
});

/** Nouns a bare year may directly precede ("2019 accidents"). */
export const YEAR_EVENT_NOUNS = Object.freeze(['accident', 'accidents', 'incident', 'incidents', 'event', 'events', 'crash',
  'crashes', 'occurrence', 'occurrences', 'mishap', 'mishaps', 'investigation', 'investigations', 'case', 'cases'] as const);
/** Units after a four-digit number that make it a quantity, not a year ("2000 feet"). */
export const YEAR_UNIT_WORDS = Object.freeze(['feet', 'foot', 'ft', 'meter', 'meters', 'metre', 'metres', 'm', 'hour', 'hours',
  'hr', 'hrs', 'h', 'rpm', 'lb', 'lbs', 'pound', 'pounds', 'knot', 'knots', 'kt', 'kts', 'mile', 'miles', 'mi', 'nm', 'km',
  'gallon', 'gallons', 'gal', 'psi', 'hp', 'mph', 'kg', 'degree', 'degrees'] as const);
/** Words before a bare year that make its interval partial or approximate ("mid-2019 accidents"). */
export const YEAR_MODIFIERS = Object.freeze(['around', 'about', 'approximately', 'approx', 'circa', 'c', 'roughly', 'nearly',
  'almost', 'early', 'mid', 'late', 'end', 'start', 'beginning', 'summer', 'winter', 'spring', 'fall', 'autumn', 'january',
  'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan',
  'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'pre', 'post', 'until', 'till', 'by',
  'than', 'to', 'from'] as const);
/**
 * The only words that may stand before "the" of a decade ("in the 1990s"; the question's start too).
 * "of" only directly after an event noun ("accidents of the 1990s", not "the end of the 1990s").
 */
export const DECADE_LEAD_WORDS = Object.freeze(['in', 'during', 'of', 'throughout', 'from'] as const);
/**
 * A word directly before in/during/throughout/from that selects part of the interval or one end of
 * an open one ("late in the 1990s", "early in 2019", "starting in 2015", "ending in 2015").
 */
export const YEAR_PORTION_WORDS = Object.freeze(['early', 'earlier', 'late', 'later', 'mid', 'middle', 'end', 'start',
  'beginning', 'half', 'part', 'rest', 'most', 'first', 'last', 'final', 'close', 'turn', 'dawn', 'starting', 'started',
  'commencing', 'ending', 'ended', 'finishing', 'continuing'] as const);
/** Approximation words directly before a range ("around 2015 to 2018"): its ends are not exact. */
export const YEAR_APPROXIMATIONS = Object.freeze(['around', 'about', 'approximately', 'approx', 'circa', 'c', 'roughly', 'nearly',
  'almost'] as const);
/** Decades that also name a century ("the 1900s", "the 2000s"): never an exact interval. */
export const CENTURY_DECADES = Object.freeze(['1900', '2000'] as const);
/** A duration or offset before an operator ("a year after", "shortly before", "some time after"): the interval is not exact. */
export const YEAR_OFFSET_WORDS = Object.freeze(['year', 'years', 'month', 'months', 'week', 'weeks', 'day', 'days', 'decade',
  'decades', 'shortly', 'right', 'just', 'soon', 'immediately', 'long', 'well', 'directly', 'sometime', 'straight', 'some time',
  'a while'] as const);
/**
 * A preposition or operator that, joined by and/or/& (a comma or semicolon may come first) to a
 * year operator, combines two intervals ("in and after 2015", "in, and after 2015", "including and
 * after 2015").
 */
export const YEAR_JOINED_OPERATORS = Object.freeze(['in', 'during', 'on', 'at', 'after', 'before', 'since', 'through', 'until',
  'till', 'by', 'from', 'to', 'throughout', 'within', 'prior to', 'up to', 'including'] as const);
/** Words a year expression attributed elsewhere follows ("aircraft built in 1981"): not the accident's date. */
export const YEAR_ATTRIBUTE_WORDS = Object.freeze(['trained', 'maintained', 'inspected', 'overhauled', 'built', 'manufactured',
  'made', 'rebuilt', 'repaired', 'modified', 'registered', 'certificated', 'certified', 'licensed', 'issued', 'published',
  'released', 'born', 'hired', 'founded', 'sold', 'bought', 'purchased', 'delivered', 'installed', 'certificate',
  'certificates', 'license', 'licenses', 'licence', 'licences', 'rating', 'ratings', 'model'] as const);
export const YEAR_ATTRIBUTE_WINDOW_WORDS = 4;
/**
 * After a year expression, a joiner-like word or mark with a year, a decade or a temporal word among
 * the three words after it changes the interval, which is then not exact ("in 2015 to the
 * present", "in 2015 and also 2016", "in 2015, and the years since"). Any other follower is fine
 * ("in 2020 concerning landing flare", "before 2011, centered on directional control"). "at"
 * counts only before earliest or latest, and "inclusive" directly after the expression only after a
 * closed interval ("2015 to 2018 inclusive", not "after 2015 inclusive").
 */
export const YEAR_JOINER_FOLLOWERS = Object.freeze(['to', 'into', 'through', 'thru', 'till', 'until', 'and', 'or', 'as', 'but',
  'with', 'including', 'along', 'plus', 'inclusive', '&', ',', ';', ':', '\u2013', '\u2014', '-'] as const);
export const YEAR_TEMPORAL_WORDS = Object.freeze(['now', 'present', 'today', 'date', 'day', 'current', 'currently', 'forward',
  'onward', 'onwards', 'later', 'earlier', 'previously', 'subsequently', 'henceforth', 'recently', 'still', 'since', 'after',
  'before', 'beyond', 'end', 'late', 'early', 'mid', 'beginning', 'start', 'inclusive', 'year', 'years', 'decade', 'decades',
  'earliest', 'latest', 'thereafter', 'afterward', 'afterwards', 'prior', 'newer', 'older', 'thereabouts', 'until', 'till',
  'through', 'thru', 'into'] as const);
export const YEAR_TEMPORAL_WINDOW_WORDS = 3;
/** Words directly after a year expression that make it approximate ("in 2015 thereabouts", "2015 give or take"). */
export const YEAR_APPROXIMATE_FOLLOWERS = Object.freeze(['thereabouts', 'approximately', 'roughly', 'circa', 'approx',
  'give or take', 'more or less', 'plus or minus'] as const);

// ---------------------------------------------------------------------------

const T = '\\p{L}\\p{N}_';
const B = `(?<![${T}])`;
const E = `(?![${T}])`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (list: readonly string[]) => [...list].sort((a, b) => b.length - a.length).map(escape).join('|');
const set = (list: readonly string[]) => new Set<string>(list);

const STATE_CODES = set(US_STATE_CODES);
const STATE_CODE = new Map(US_STATE_CODES.map(code => [US_STATE[code]!.toLowerCase(), code] as const));
/** Longest names first, so "West Virginia" is never also "Virginia". */
const STATE_NAME_RE = new RegExp(`${B}(?:${words([...STATE_CODE.keys()])})${E}`, 'giu');
const PLACE_SUFFIX = new RegExp(`^ (?:${words(STATE_PLACE_SUFFIXES)})${E}`, 'iu');
const POSTAL = new RegExp(`(?:^|${B}(?:${POSTAL_PREPOSITIONS.map(p => `[${p[0]!.toUpperCase()}${p[0]}]${escape(p.slice(1))}`).join('|')}) )`
  + `([A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,4}), ?([A-Z]{2})${E}`, 'dgu');
const ALLOWED_CATEGORIES = new Set(Object.keys(AIRCRAFT_CATEGORY).filter(code => code !== 'UNK'));
const CATEGORY_CODE = new Map(Object.entries(CATEGORY_WORDS).flatMap(([code, list]) => list.map(w => [w, code] as const)));
const CATEGORY_RE = new RegExp(`${B}(?:${words([...CATEGORY_CODE.keys()])})${E}`, 'giu');
const CATEGORY_ATTRIBUTE_AFTER = new RegExp(`^[ -]+(${words(CATEGORY_ATTRIBUTE_NOUNS)})${E}`, 'iu');
const ALTERNATIVE_RE = new RegExp(`${B}(?:${words(ALTERNATIVE_WORDS)})${E}`, 'giu');
const COMPARISON_RE = new RegExp(`${B}(?:${words(COMPARISON_WORDS)})${E}`, 'iu');
const UNION_MARKER_RE = new RegExp(`${B}(?:${words([...UNION_JOINERS, ...UNION_MARKERS].filter(j => /\w/.test(j)))})${E}|[&/]|${words(UNION_PUNCTUATION)}`, 'giu');
const UNION_NOUN_RE = new RegExp(`${B}(?:${words(UNION_EVENT_NOUNS)})${E}`, 'giu');
const HEADS = set(UNION_PRONOUN_HEADS), MARKER_SKIP = set(['the', ...UNION_MARKERS.filter(m => !m.includes(' '))]);
const LIST_WORDS = set([...LIST_SEPARATORS, ...LIST_QUALIFIERS]);
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

const YEAR_TOKEN = new RegExp(`(?<![${T}]|\\p{N}[.,/])(19\\d\\d|20\\d\\d|2100)(?![${T}]|[.,/]\\p{N}|[ -](?:${words(YEAR_UNIT_WORDS)})${E})`, 'gu');
const DECADE_TOKEN = new RegExp(`${B}(19\\d0|20\\d0)s${E}`, 'gu');
/** An operator directly before a single year, and the interval it gives. */
const YEAR_OPERATOR = new RegExp(`${B}(since the end of|no later than|no earlier than|since|after|before|through|up to|from|in|during) (?:the year )?$`, 'diu');
/** Supported words after a single year: "2015 or later", "2015 and earlier", "2015 onward", "from 2015 on". */
const YEAR_SUFFIX = new RegExp(`^(,? (?:or|and) (?:later|earlier)| onwards?| on)${E}`, 'iu');
/** "after 2015 and before 2020", "after 2015 but before 2020". */
const AFTER_BEFORE_GAP = /^ (?:and|but) before (?:the year )?$/iu;
const AFTER_OPERATOR = new RegExp(`${B}after (?:the year )?$`, 'iu');
const YEAR_MODIFIER = new RegExp(`${B}(?:${words(YEAR_MODIFIERS)})[ .-]*$`, 'iu');
const YEAR_EVENT_NOUN = new RegExp(`^ (?:${words(YEAR_EVENT_NOUNS)})${E}`, 'iu');
/** Other words after a year that change its interval ("2015+", "2015 and beyond", "2015 or so"). */
const YEAR_CONTINUATION = new RegExp(`^(?: ?\\+| ?-ish${E}|,? (?:and|or|&) (?:later|earlier|after|afterwards?|before|beyond|since|onwards?|on|up|newer|older|prior|so|thereafter)${E}| (?:onwards?|forward|or so|ish|and up|plus)${E})`, 'iu');
/** A two-digit second year ("2015-18"): a range this grammar does not read. */
const SHORT_RANGE = /^[-–—]\d{1,2}(?!\d)/u;
/** Operators before a range that would change its ends ("after 2015 through 2018"), and approximations ("around 2015 to 2018"). */
const RANGE_OPERATOR = new RegExp(`${B}(?:after|before|since|until|till|through|thru|up to|by) $`, 'iu');
const APPROX_BEFORE = new RegExp(`${B}(?:${words(YEAR_APPROXIMATIONS)})[ .]*$`, 'iu');
const DECADE_ARTICLE = new RegExp(`(?:^|${B}(${words(DECADE_LEAD_WORDS)}) )the $`, 'diu');
const ANY_ARTICLE = new RegExp(`${B}the $`, 'iu');
const JOINED_OPERATOR = new RegExp(`${B}(?:${words(YEAR_JOINED_OPERATORS)})[,;]? (?:and/or|and|or|&) $`, 'iu');
const OFFSET_BEFORE = new RegExp(`${B}(?:${words(YEAR_OFFSET_WORDS)}) $`, 'iu');
const JOINER_FOLLOWERS = set(YEAR_JOINER_FOLLOWERS), TEMPORAL = set(YEAR_TEMPORAL_WORDS);
const APPROX_FOLLOWER = new RegExp(`^(?:${words(YEAR_APPROXIMATE_FOLLOWERS)})${E}`, 'iu');
const FOLLOWER_MARK = new RegExp(`^(?:${words(YEAR_JOINER_FOLLOWERS.filter(f => !/\p{L}/u.test(f)))})+`, 'u');
const YEAR_WORD = /^(?:(?:19|20)\d\d|2100|(?:19|20)\d0s)$/u;
const PORTIONS = set(YEAR_PORTION_WORDS), EVENT_NOUNS = set([...YEAR_EVENT_NOUNS, ...UNION_EVENT_NOUNS]);
const REFERENCES = set(REFERENCE_WORDS), REFERENCED_NOUNS = set(REFERENCED_EVENT_NOUNS);
const OPENERS = new RegExp(`^(?:(?:${words(REFERENCE_OPENERS)}) )*$`, 'u');
const PARTS = set(CATEGORY_PART_NOUNS), SUMMARIES = set(TITLE_SUMMARY_WORDS), NAMING = set(TITLE_NAMING_VERBS);
const AFTER_NEGATION = new RegExp(`^ (?:${words(NEGATION_AFTER_WORDS)})${E}`, 'iu');
const WRITING = set(REFERENCE_WRITING_WORDS), WRITING_PREPOSITIONS = set(REFERENCE_WRITING_PREPOSITIONS);
const NOT_RESTRICTED = Object.fromEntries(AUTOMATIC_FIELDS.map(f => [f, new RegExp(`${B}(?:${words(NOT_RESTRICTED_PHRASES[f]!)})${E}`, 'iu')])) as
  Record<AutomaticField, RegExp>;
const TITLES = set(TITLE_WORDS), YEAR_ATTRIBUTES = set(YEAR_ATTRIBUTE_WORDS);
const EXPERIENCE = set(CATEGORY_EXPERIENCE_WORDS), EXPERIENCE_PREPOSITIONS = set(CATEGORY_EXPERIENCE_PREPOSITIONS);

/** The text the rules read and the spans index: NFKC, whitespace collapsed to one space, trimmed. */
export function normalizedQuestion(question: string): string {
  return question.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

interface Span { start: number; end: number }
interface Mention extends Span {
  field: AutomaticField; value: string; qualified?: boolean; postal?: boolean; ambiguous?: boolean;
  /** The words of a merged category mention ("blimp or airship"), each checked on its own. */
  parts?: Span[];
}
interface YearExpression extends Span {
  yearFrom?: number; yearTo?: number; attributed?: boolean;
  /** The words the check's quote must hold, when narrower than the expression (a decade without its lead word). */
  witness?: Span;
}
interface Word extends Span { word: string }
interface Scan {
  text: string;
  words: Word[];
  state: Mention[];
  category: Mention[];
  /** Year and decade tokens, for value lists. */
  yearTokens: Mention[];
  expressions: YearExpression[];
  /** Every operator-and-year phrase read, exact or not ("no later than 2019"): never a negation. */
  yearPhrases: Span[];
  /** A year construct the interval grammar cannot represent exactly: no years candidate. */
  yearsAmbiguous: boolean;
  /** Spans of other-event phrases: a reference word to four words after its event noun. */
  referenced: Span[];
  /** Every field's values, in text order, and each one's value-list run (the index of its run's first value). */
  mentions: Mention[];
  run: number[];
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
const inside = (a: Span, spans: readonly Span[]) => spans.some(s => s.start <= a.start && a.end <= s.end);
const wordsOf = (text: string): Word[] => [...text.matchAll(WORD)].map(m => ({ start: m.index!, end: m.index! + m[0].length, word: m[0].toLowerCase() }));
/** The `n` words before `start`. */
const wordsBefore = (s: Scan, start: number, n: number) => s.words.filter(w => w.end <= start).slice(-n);

function stateMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const occupied: Span[] = [];
  // A qualified postal place first: a state name inside it ("Spokane, WA") is the place's name. After a
  // state name, OR is the conjunction, not Oregon ("Alaska, OR helicopter accidents"). Any other place
  // that is itself a state name ("Washington, DC", "Delaware, OH") is no postal reading and no state name: ambiguous.
  for (const m of text.matchAll(POSTAL)) {
    const code = m[2]!, place = m[1]!, stateName = STATE_CODE.has(place.toLowerCase());
    const span = { start: m.indices![1]![0], end: m.indices![2]![1] };
    if (!STATE_CODES.has(code) || code === 'OR' && stateName) continue;
    out.push({ field: 'state', value: code, ...span, ...(stateName ? { ambiguous: true } : { qualified: true, postal: true }) });
    occupied.push(span);
  }
  // One left-to-right pass: a matched name, even one naming another place, is never also a shorter one.
  for (const m of text.matchAll(STATE_NAME_RE)) {
    const span = { start: m.index!, end: m.index! + m[0].length };
    if (occupied.some(o => overlaps(o, span)) || PLACE_SUFFIX.test(text.slice(span.end))) continue;
    const qualified = /(?<![\p{L}\p{N}_])state of $/iu.test(text.slice(0, span.start)) || /^ state(?![\p{L}\p{N}_])/iu.test(text.slice(span.end));
    out.push({ field: 'state', value: STATE_CODE.get(m[0].toLowerCase())!, ...span, qualified });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Category words; words of one category close together ("weight-shift trike", "blimp or airship") are one mention. */
function categoryMentions(text: string): Mention[] {
  const raw = [...text.matchAll(CATEGORY_RE)].map(m => ({ field: 'category' as const, value: CATEGORY_CODE.get(m[0].toLowerCase())!,
    start: m.index!, end: m.index! + m[0].length }));
  const out: Mention[] = [];
  for (const m of raw) {
    const last = out.at(-1);
    const part = { start: m.start, end: m.end };
    if (last && last.value === m.value && wordsOf(text.slice(last.end, m.start)).length <= CATEGORY_MERGE_WORDS) {
      last.end = m.end;
      last.parts!.push(part);
    } else out.push({ ...m, parts: [part] });
  }
  return out;
}

/** Gap words between two values of one list: separators and qualifiers only. */
function listGap(gap: string): boolean {
  return gap.replace(/[,;:/&()\-–—.]/gu, ' ').split(' ').every(w => w === '' || LIST_WORDS.has(w.toLowerCase()));
}

/**
 * A negation among the four words before a mention (not counting words of a year expression), a
 * non- or ex- prefix on it, or "aside" directly after it.
 */
function negated(s: Scan, at: Span): boolean {
  if (/(?<![\p{L}\p{N}_])(?:non[-\u2010\u2011 ]|ex[-\u2010\u2011])$/iu.test(s.text.slice(0, at.start)) || AFTER_NEGATION.test(s.text.slice(at.end))) return true;
  const window = s.words.filter(w => w.end <= at.start && !inside(w, s.yearPhrases)).slice(-NEGATION_WINDOW_WORDS).map(w => w.word);
  const joined = ` ${window.join(' ')} `;
  if (LOCAL_NEGATIONS.some(n => joined.includes(` ${n} `))) return true;
  if (window.some(w => /n['’]t$/u.test(w))) return true;
  const but = window.lastIndexOf('but');
  return but > 0 && window.slice(0, but).some(w => (NEGATION_BUT_LEADS as readonly string[]).includes(w));
}

/**
 * Other-event phrases: a reference word (or a writing word and its about/on/of), an event noun or
 * pronoun within six words after it, through the four words after the noun.
 */
function referencedSpans(words: Word[]): Span[] {
  const out: Span[] = [];
  words.forEach((w, r) => {
    let from = r;
    if (WRITING.has(w.word)) {
      const p = words.slice(r + 1, r + 1 + REFERENCE_WRITING_WINDOW_WORDS).findIndex(x => WRITING_PREPOSITIONS.has(x.word));
      if (p < 0) return;
      from = r + 1 + p;
    } else if (!REFERENCES.has(w.word) || w.word === 'like' && words[r + 1]?.word === 'to'
      // A reference word that opens the question is its verb ("Compare helicopter accidents in ...").
      || OPENERS.test(words.slice(0, r).map(x => `${x.word} `).join(''))) return;
    const n = words.slice(from + 1, from + 1 + REFERENCE_NOUN_WINDOW_WORDS).findIndex(x => REFERENCED_NOUNS.has(x.word));
    if (n < 0) return;
    const last = words[Math.min(words.length - 1, from + 1 + n + REFERENCE_AFTER_NOUN_WORDS)]!;
    if (words[r + 1]) out.push({ start: words[r + 1]!.start, end: last.end });
  });
  return out;
}

/**
 * Why one mention is not of the requested accidents, or null; `part` when a category word names a
 * part ("airplane engine"). Each word of a merged category mention counts.
 */
function valueRejection(s: Scan, m: Mention | YearExpression, field: AutomaticField): { reason: CandidateReason; part: boolean } | null {
  if (field === 'category') {
    let attribute = false, part = false;
    for (const p of (m as Mention).parts ?? [m]) {
      const noun = CATEGORY_ATTRIBUTE_AFTER.exec(s.text.slice(p.end));
      if (noun) { attribute = true; part ||= PARTS.has(noun[1]!.toLowerCase()); }
      const before = wordsBefore(s, p.start, CATEGORY_ATTRIBUTE_WINDOW_WORDS).map(w => w.word);
      if (before.some((w, i) => EXPERIENCE.has(w) && EXPERIENCE_PREPOSITIONS.has(before[i + 1] ?? ''))
        || CATEGORY_COMPARISON_PHRASES.some(c => ` ${before.join(' ')} `.includes(` ${c} `))) attribute = true;
    }
    if (attribute) return { reason: 'attribute_word', part };
  }
  if (s.referenced.some(r => overlaps(r, m))) return { reason: 'referenced_event', part: false };
  const titled = wordsBefore(s, m.start, TITLE_WINDOW_WORDS).some(w => TITLES.has(w.word)
    || SUMMARIES.has(w.word) && NAMING.has(s.words[s.words.indexOf(w) + 1]?.word ?? ''));
  return titled ? { reason: 'title_text', part: false } : null;
}

/**
 * Whether what follows a year expression leaves its interval exact: no approximation, and no
 * joiner-like word or mark with a year, decade or temporal word among the next three words; "at"
 * only before earliest or latest; "inclusive" only after a closed interval.
 */
function exactFollower(text: string, end: number, closed: boolean): boolean {
  const after = text.slice(end).replace(/^ ?\(/u, ' ').trimStart();
  if (APPROX_FOLLOWER.test(after)) return false;
  const mark = FOLLOWER_MARK.exec(after);
  const first = mark ? mark[0] : wordsOf(after)[0];
  if (!first || !mark && (first as Word).start !== 0) return true;
  const word = mark ? '&' : (first as Word).word, rest = after.slice(mark ? mark[0].length : (first as Word).end);
  const next = wordsOf(rest).slice(0, YEAR_TEMPORAL_WINDOW_WORDS).map(w => w.word);
  const temporal = next.some(w => TEMPORAL.has(w) || YEAR_WORD.test(w));
  if (word === 'inclusive') return closed && !temporal;
  if (word === 'at') return !next.includes('earliest') && !next.includes('latest');
  return !JOINER_FOLLOWERS.has(word) || !temporal;
}

/** A model year: directly after a/an/the or a possessive, directly before a word that is no event noun or joiner ("a 1978 Cessna"). */
function modelYear(text: string, t: Span): boolean {
  const next = /^ ([\p{L}][\p{L}\p{N}'’-]*)/u.exec(text.slice(t.end))?.[1]?.toLowerCase();
  return /(?:(?<![\p{L}\p{N}_])(?:a|an|the)|\p{L}['’]s|\p{L}s['’]) $/iu.test(text.slice(0, t.start))
    && next !== undefined && !EVENT_NOUNS.has(next) && !JOINER_FOLLOWERS.has(next) && !LIST_WORDS.has(next);
}

function yearScan(text: string, words: Word[]): { tokens: Mention[]; expressions: YearExpression[]; phrases: Span[]; ambiguous: boolean } {
  const all: (Mention & { decade: boolean })[] = [
    ...[...text.matchAll(YEAR_TOKEN)].map(m => ({ field: 'years' as const, value: m[1]!, start: m.index!, end: m.index! + m[0].length, decade: false })),
    ...[...text.matchAll(DECADE_TOKEN)].map(m => ({ field: 'years' as const, value: m[1]!, start: m.index!, end: m.index! + m[0].length, decade: true })),
  ].sort((a, b) => a.start - b.start);
  const expressions: YearExpression[] = [], phrases: Span[] = [];
  let ambiguous = all.some(t => !t.decade && SHORT_RANGE.test(text.slice(t.end)));
  /** An operator starting at `at` that another operator joins ("in and after"), or that a duration offsets ("a year after"). */
  const operatorUnsafe = (at: number, offsettable: boolean) => JOINED_OPERATOR.test(text.slice(0, at)) || offsettable && OFFSET_BEFORE.test(text.slice(0, at));
  const push = (x: YearExpression) => {
    if (!exactFollower(text, x.end, x.yearFrom !== undefined && x.yearTo !== undefined)) { ambiguous = true; return; }
    const before = words.filter(w => w.end <= x.start).slice(-YEAR_ATTRIBUTE_WINDOW_WORDS);
    expressions.push({ ...x, attributed: before.some(w => YEAR_ATTRIBUTES.has(w.word)) });
  };
  // "after A and/but before B" is one interval, A+1 to B-1, when that is not empty.
  const consumed = new Set<number>();
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i]!, b = all[i + 1]!;
    if (a.decade || b.decade || !AFTER_BEFORE_GAP.test(text.slice(a.end, b.start))) continue;
    const op = AFTER_OPERATOR.exec(text.slice(0, a.start));
    if (!op) continue;
    consumed.add(i).add(i + 1);
    const from = Number(a.value) + 1, to = Number(b.value) - 1;
    if (from > to || operatorUnsafe(op.index, true) || YEAR_SUFFIX.test(text.slice(b.end)) || YEAR_CONTINUATION.test(text.slice(b.end))) ambiguous = true;
    else push({ start: op.index, end: b.end, yearFrom: from, yearTo: to });
  }
  const tokens = all.filter((_, i) => !consumed.has(i));
  // Tokens joined by list or range words form one chain: a range of two years, or an unsupported list.
  const chains: (typeof tokens)[] = [];
  for (const t of tokens) {
    const last = chains.at(-1)?.at(-1);
    const gap = last ? text.slice(last.end, t.start).toLowerCase() : '';
    if (last && gap.replace(/[,;&/+()\-–—]/gu, ' ').split(' ')
      .every(w => ['', 'the', 'year', 'years', 'in', 'of', 'and', 'or', 'nor', 'to', 'through', 'thru', 'until', 'till', 'versus', 'vs', 'vs.', 'from'].includes(w))) {
      chains.at(-1)!.push(t);
    } else chains.push([t]);
  }
  for (const chain of chains) {
    const first = chain[0]!, last = chain.at(-1)!, after = text.slice(last.end), before = text.slice(0, first.start);
    if (chain.length > 2 || chain.some(t => t.decade) && chain.length > 1) { ambiguous = true; continue; }
    if (chain.length === 2) {
      if (YEAR_SUFFIX.test(after) && !/^ on(?![\p{L}\p{N}_])/iu.test(after) || YEAR_CONTINUATION.test(after)) { ambiguous = true; continue; }
      const a = Number(first.value), b = Number(last.value), gap = text.slice(first.end, last.start).toLowerCase();
      const between = /(?<![\p{L}\p{N}_])between $/iu.exec(before), from = /(?<![\p{L}\p{N}_])from $/iu.exec(before);
      const range = /^ ?[-–] ?$/u.test(gap) || /^ (?:to|through) $/u.test(gap) ? (from ? from.index : first.start) : gap === ' and ' && between ? between.index : -1;
      if (range < 0 || a > b || RANGE_OPERATOR.test(text.slice(0, range)) || APPROX_BEFORE.test(text.slice(0, range))
        || operatorUnsafe(range, false)) { ambiguous = true; continue; }
      push({ start: range, end: last.end, yearFrom: a, yearTo: b });
      continue;
    }
    const suffixMatch = YEAR_SUFFIX.exec(after);
    if (first.decade) {
      if (suffixMatch && !/^ on(?![\p{L}\p{N}_])/iu.test(after) || YEAR_CONTINUATION.test(after)) { ambiguous = true; continue; }
      if (!ANY_ARTICLE.test(before)) continue; // "1990s accidents": no decade expression
      const lead = DECADE_ARTICLE.exec(before);
      // Only "in/during/of/throughout/from the 1990s" (or "The 1990s" first); "the 1900s/2000s" may also be a century.
      if (!lead || (CENTURY_DECADES as readonly string[]).includes(first.value)) { ambiguous = true; continue; }
      const start = lead.indices![1] ? lead.indices![1]![0] : lead.index, leadWord = lead[1]?.toLowerCase();
      const previous = words.filter(w => w.end <= start).at(-1)?.word ?? '';
      if (leadWord === 'of' && !EVENT_NOUNS.has(previous) || leadWord && PORTIONS.has(previous)
        || leadWord === 'from' && /^ on(?![\p{L}\p{N}_])/iu.test(after) || operatorUnsafe(start, false)) { ambiguous = true; continue; }
      // The check's quote need not hold the lead word: "the 1990s" is the value's witness.
      push({ start, end: first.end, yearFrom: Number(first.value), yearTo: Number(first.value) + 9, witness: { start: first.start - 4, end: first.end } });
      continue;
    }
    const y = Number(first.value);
    const operator = YEAR_OPERATOR.exec(before);
    const op = operator?.[1]!.toLowerCase(), start = operator ? operator.indices![1]![0] : first.start;
    if (operator) phrases.push({ start, end: first.end });
    const sf = suffixMatch?.[1]!.toLowerCase().replace(/^,/, '').trim();
    // "on" ends a year only after "from" ("from 2015 on"); elsewhere it is a preposition.
    const suffix = sf === 'on' && op !== 'from' ? undefined : sf;
    if (!suffix && YEAR_CONTINUATION.test(after)) { ambiguous = true; continue; }
    if (operator && operatorUnsafe(start, !['in', 'during', 'from'].includes(op!))) { ambiguous = true; continue; }
    if ((op === 'in' || op === 'during') && PORTIONS.has(words.filter(w => w.end <= start).at(-1)?.word ?? '')) { ambiguous = true; continue; }
    const end = suffix ? first.end + suffixMatch![0].length : first.end;
    if (suffix) {
      const later = suffix === 'or later' || suffix === 'and later' || suffix.startsWith('onward') || suffix === 'on';
      // A suffix completes a bare year, "in"/"during" one, or "from" before on/onward; any other operator conflicts.
      if (op === 'from' ? !(suffix === 'on' || suffix.startsWith('onward')) : op !== undefined && op !== 'in' && op !== 'during') { ambiguous = true; continue; }
      push({ start, end, ...(later ? { yearFrom: y } : { yearTo: y }) });
      continue;
    }
    if (op && op !== 'from') {
      const interval = op === 'since the end of' || op === 'after' ? { yearFrom: y + 1 } : op === 'since' || op === 'no earlier than' ? { yearFrom: y }
        : op === 'before' ? { yearTo: y - 1 } : op === 'through' || op === 'up to' || op === 'no later than' ? { yearTo: y } : { yearFrom: y, yearTo: y };
      push({ start, end, ...interval });
      continue;
    }
    const noun = YEAR_EVENT_NOUN.exec(after);
    if (!op && noun && !YEAR_MODIFIER.test(before)) push({ start: first.start, end: first.end + noun[0].length, yearFrom: y, yearTo: y });
  }
  // A year or decade in no expression ("in 2015 and also 2016", "starting from 2015", "to late 2018")
  // leaves the interval unknown, unless it is a model year or inside an attributed expression.
  if (all.some(t => !expressions.some(x => x.start <= t.start && t.end <= x.end) && (t.decade || !modelYear(text, t)))) ambiguous = true;
  return { tokens: all, expressions, phrases: [...phrases, ...expressions], ambiguous };
}

/** Sentence ends: . ! ? before a capital or the end (a "." after one or two letters is an abbreviation: "St.", "U.S."). */
function sentenceEnds(text: string): number[] {
  return [...text.matchAll(/[.!?](?=\s+\p{Lu}|\s*$)/gu)].filter(m => m[0] !== '.' || !/(?<![\p{L}])\p{L}{1,2}$/u.test(text.slice(0, m.index))).map(m => m.index!);
}

/** The values the question names, by field: state and category mentions and year expressions not attributed elsewhere. */
const named = (s: Scan): (Span & { field: AutomaticField })[] =>
  [...s.state, ...s.category, ...s.expressions.filter(x => !x.attributed).map(x => ({ start: x.start, end: x.end, field: 'years' as const }))];

/** Whether `at` lies inside a mention or between two values of one value list. */
function inValueList(s: Scan, at: Span): boolean {
  if (s.mentions.some(m => overlaps(m, at))) return true;
  const next = s.mentions.findIndex(m => m.start >= at.end);
  return next > 0 && s.mentions[next - 1]!.end <= at.start && s.run[next] === s.run[next - 1];
}

/**
 * Two requests (UNION_EVENT_NOUNS): values of two fields in different sentences, or within one
 * sentence an accident noun before a joiner, marker word or mark and, after it, an accident noun or,
 * directly, a pronoun head or a state or category word.
 */
function unionOfRequests(s: Scan): boolean {
  const { text } = s;
  const ends = sentenceEnds(text);
  const values = named(s);
  if (new Set(values.map(v => v.field)).size > 1 && new Set(values.map(v => ends.filter(e => e < v.start).length)).size > 1) return true;
  const nouns = [...text.matchAll(UNION_NOUN_RE)].map(m => ({ start: m.index!, end: m.index! + m[0].length }));
  const starts = new Set([...s.state, ...s.category].map(m => m.start));
  for (const j of text.matchAll(UNION_MARKER_RE)) {
    const at = { start: j.index!, end: j.index! + j[0].length };
    if (inValueList(s, at) || inside(at, s.expressions)) continue;
    const from = Math.max(-1, ...ends.filter(e => e < at.start)), to = Math.min(text.length, ...ends.filter(e => e >= at.end));
    if (!nouns.some(n => n.end <= at.start && n.start > from)) continue;
    if (nouns.some(n => n.start >= at.end && n.end <= to)) return true;
    const head = s.words.filter(w => w.start >= at.end && w.end <= to).find(w => !MARKER_SKIP.has(w.word));
    if (head && (HEADS.has(head.word) || starts.has(head.start))) return true;
  }
  return false;
}

function scan(text: string): Scan {
  const words = wordsOf(text);
  const state = stateMentions(text), category = categoryMentions(text), years = yearScan(text, words);
  // Value lists: consecutive values of one field with only separators and qualifiers between.
  const mentions = [...state, ...category, ...years.tokens].sort((a, b) => a.start - b.start);
  const run = mentions.map((_, i) => i);
  for (let i = 1; i < mentions.length; i++) {
    if (mentions[i]!.field === mentions[i - 1]!.field && listGap(text.slice(mentions[i - 1]!.end, mentions[i]!.start))) run[i] = run[i - 1]!;
  }
  return { text, words, state, category, yearTokens: years.tokens, expressions: years.expressions, yearPhrases: years.phrases, yearsAmbiguous: years.ambiguous,
    referenced: referencedSpans(words), mentions, run };
}

/**
 * An alternative or comparison the AND of filters cannot represent, given the candidates found: a
 * comparison word; with two or more fields named in the question, any alternative word outside one
 * field's value list; with one, such a word with a candidate's words among the two words before or
 * after it.
 */
function crossField(s: Scan, candidates: readonly AutomaticCandidate[]): boolean {
  if (COMPARISON_RE.test(s.text)) return true;
  const several = new Set(named(s).map(v => v.field)).size > 1;
  const witnesses = candidates.flatMap(c => c.witnesses);
  const postal = s.state.filter(m => m.postal || m.ambiguous);
  const { mentions, run } = s;
  for (const w of s.text.matchAll(ALTERNATIVE_RE)) {
    const span = { start: w.index!, end: w.index! + w[0].length };
    // "Portland, OR", "2015 or later", "blimp or airship" (one category mention).
    if (postal.some(p => overlaps(p, span)) || inside(span, s.expressions) || inside(span, s.category)) continue;
    const word = w[0].toLowerCase();
    if (word === 'or' && /^ (?:later|earlier)(?![\p{L}\p{N}_])/iu.test(s.text.slice(span.end))) continue;
    const next = mentions.findIndex(m => m.start >= span.end);
    // Inside one field's own value list ("Alaska or Hawaii"), or "either" before such a list.
    const inList = word === 'either'
      ? next >= 0 && listGap(s.text.slice(span.end, mentions[next]!.start)) && mentions.some((m, i) => i > next && run[i] === next
        && /(?<![\p{L}\p{N}_])n?or(?![\p{L}\p{N}_])/iu.test(s.text.slice(mentions[i - 1]!.end, m.start)))
      : next > 0 && mentions[next - 1]!.end <= span.start && run[next] === run[next - 1];
    if (inList) continue;
    if (several) return true;
    // The word holding it (itself, or a hyphenated "Ohio-or-Iowa") and the two words on each side.
    const at = s.words.findIndex(x => overlaps(x, span));
    const near = s.words.slice(Math.max(0, at - ALTERNATIVE_WINDOW_WORDS), at + 1 + ALTERNATIVE_WINDOW_WORDS);
    if (near.some(x => witnesses.some(v => overlaps(x, v)))) return true;
  }
  return false;
}

const requestedField = (field: AutomaticField, r: BriefFilters) => field === 'years'
  ? r.yearFrom !== undefined || r.yearTo !== undefined : (r[field]?.length ?? 0) > 0;
const emptyField = (field: AutomaticField, e: BriefFilters) => field === 'years'
  ? e.yearFrom === undefined && e.yearTo === undefined : (e[field]?.length ?? 0) === 0;
const validYear = (v: number | undefined) => v === undefined || Number.isInteger(v) && v >= 1900 && v <= 2100;
function unsupported(field: AutomaticField, e: BriefFilters): boolean {
  if (field === 'state') return e.state!.some(s => !STATE_CODES.has(s));
  if (field === 'category') return e.category!.some(c => !ALLOWED_CATEGORIES.has(c));
  return !validYear(e.yearFrom) || !validYear(e.yearTo) || e.yearFrom !== undefined && e.yearTo !== undefined && e.yearFrom > e.yearTo;
}
const tooMany = (field: AutomaticField, e: BriefFilters) => field === 'state' ? new Set(e.state).size > AUTOMATIC_MAX_STATES
  : field === 'category' && new Set(e.category).size > AUTOMATIC_MAX_CATEGORIES;

/**
 * One witness per value, or why not: the field's named values are exactly the suggested set, and
 * each is named once. A state's postal code also standing alone elsewhere ("Juneau, AK and AK
 * waters") is a second occurrence too.
 */
function setDecision(text: string, mentions: Mention[], emitted: readonly string[]): { reason: CandidateReason; values?: string[]; witnesses?: WitnessSpan[] } {
  const values = [...new Set(emitted)].sort();
  const explicit = [...new Set(mentions.map(m => m.value))].sort();
  if (explicit.join() !== values.join()) return { reason: 'set_mismatch' };
  const occurrences = (v: string) => mentions.filter(m => m.value === v).length + (mentions[0]!.field !== 'state' ? 0
    : [...text.matchAll(new RegExp(`${B}${v}${E}`, 'gu'))].filter(b => !mentions.some(m => overlaps(m, { start: b.index!, end: b.index! + v.length }))).length);
  if (values.some(v => occurrences(v) > 1)) return { reason: 'repeated_mention' };
  return { reason: 'candidate', values, witnesses: values.map(v => mentions.find(m => m.value === v)!).map(m => ({ start: m.start, end: m.end,
    ...(m.parts && m.parts.length > 1 ? { parts: m.parts.map(p => ({ start: p.start, end: p.end })) } : {}) })) };
}

/**
 * The mentions left once those of other events, titles or attributes are set aside, or the reason
 * when a suggested value's own mention is one of those. An unsuggested value's such mention is set
 * aside only apart from the kept values' lists and never when it names a part ("helicopter and
 * airplane engine failures"); otherwise the field could apply fewer values than the question names.
 */
function keptMentions(s: Scan, mentions: Mention[], field: AutomaticField, emitted: readonly string[]): { reason?: CandidateReason; kept: Mention[] } {
  const kept: Mention[] = [], aside: { m: Mention; reason: CandidateReason; part: boolean }[] = [];
  for (const m of mentions) {
    const rejection = valueRejection(s, m, field);
    if (!rejection) kept.push(m);
    else if (emitted.includes(m.value)) return { reason: rejection.reason, kept: [] };
    else aside.push({ m, ...rejection });
  }
  const runOf = (m: Mention) => s.run[s.mentions.indexOf(m)];
  const refused = aside.find(a => a.part || kept.some(k => runOf(k) === runOf(a.m)));
  return refused ? { reason: refused.reason, kept: [] } : { kept };
}

function stateField(s: Scan, emitted: readonly string[]): { reason: CandidateReason; candidate?: AutomaticCandidate } {
  if (!s.state.length) return { reason: 'not_explicit' };
  const { reason, kept } = keptMentions(s, s.state, 'state', emitted);
  if (reason) return { reason };
  if (!kept.length) return { reason: 'not_explicit' };
  if (kept.some(m => negated(s, m))) return { reason: 'negated' };
  // Washington alone could be the District of Columbia's city: it needs "state of", "state" or "City, WA".
  if (kept.some(m => m.ambiguous || m.value === 'WA' && !m.qualified)) return { reason: 'ambiguous_name' };
  const d = setDecision(s.text, kept, emitted);
  return d.reason === 'candidate' ? { reason: d.reason, candidate: { field: 'state', state: d.values!, witnesses: d.witnesses! } } : { reason: d.reason };
}

function categoryField(s: Scan, emitted: readonly string[]): { reason: CandidateReason; candidate?: AutomaticCandidate } {
  if (!s.category.length) return { reason: 'not_explicit' };
  if (RELATIONSHIP_PATTERNS.some(re => re.test(s.text))) return { reason: 'relationship' };
  const { reason, kept: m } = keptMentions(s, s.category, 'category', emitted);
  if (reason) return { reason };
  if (!m.length) return { reason: 'not_explicit' };
  // Two categories that are not one list ("a glider landing forced an airplane"), or a list of
  // individual aircraft ("a helicopter and an airplane"), describe several aircraft.
  for (let i = 1; i < m.length; i++) {
    const gap = s.text.slice(m[i - 1]!.end, m[i]!.start);
    if (m[i]!.value !== m[i - 1]!.value && (!listGap(gap) || /(?<![\p{L}\p{N}_])(?:and|with)(?![\p{L}\p{N}_])[^]*(?<![\p{L}\p{N}_])(?:a|an)(?![\p{L}\p{N}_])/iu.test(gap))) {
      return { reason: 'relationship' };
    }
  }
  if (m.some(x => (x.parts ?? [x]).some(p => negated(s, p)))) return { reason: 'negated' };
  const d = setDecision(s.text, m, emitted);
  return d.reason === 'candidate' ? { reason: d.reason, candidate: { field: 'category', category: d.values!, witnesses: d.witnesses! } } : { reason: d.reason };
}

function yearsField(s: Scan, e: BriefFilters): { reason: CandidateReason; candidate?: AutomaticCandidate } {
  if (s.yearsAmbiguous) return { reason: 'ambiguous_expression' };
  if (!s.expressions.length) return { reason: 'not_explicit' };
  const equal = (x: YearExpression) => x.yearFrom === e.yearFrom && x.yearTo === e.yearTo;
  // A year attributed elsewhere ("aircraft built in 1981") is neither the accident's date nor an ambiguity.
  const live = s.expressions.filter(x => !x.attributed);
  const attributed = s.expressions.some(x => x.attributed && equal(x));
  if (!live.length) return { reason: attributed ? 'attribute_word' : 'not_explicit' };
  if (new Set(live.map(x => `${x.yearFrom ?? ''}:${x.yearTo ?? ''}`)).size > 1) return { reason: 'ambiguous_expression' };
  if (live.length > 1) return { reason: 'repeated_mention' };
  const x = live[0]!;
  if (negated(s, x)) return { reason: 'negated' };
  const rejection = valueRejection(s, x, 'years');
  if (rejection) return { reason: rejection.reason };
  // The suggestion as given, an absent bound open, must be exactly the expression's interval.
  if (!equal(x)) return { reason: attributed ? 'attribute_word' : 'range_mismatch' };
  return { reason: 'candidate', candidate: { field: 'years', ...(x.yearFrom !== undefined ? { yearFrom: x.yearFrom } : {}),
    ...(x.yearTo !== undefined ? { yearTo: x.yearTo } : {}), witnesses: [x.witness ?? { start: x.start, end: x.end }] } };
}

/**
 * The candidates among `emitted` (the scope's suggested filters) for `question`, only for `fields`.
 * A field the request already constrains (`requested`) is never automatic. Pure and bounded: at
 * most 600 characters are scanned.
 */
export function automaticCandidates(question: string, emitted: BriefFilters, requested: BriefFilters,
  fields: readonly AutomaticField[] = AUTOMATIC_FIELDS): AutomaticCandidates {
  const text = normalizedQuestion(question);
  const unsafe = question.length > AUTOMATIC_QUESTION_MAX_CHARS || UNSAFE_CHARACTERS.test(question)
    || QUOTED_TEXT.test(question) || QUOTED_TEXT.test(text) || INJECTION_PATTERNS.some(re => re.test(text));
  let scanned: Scan | undefined;
  // Question-level refusals after the structural ones, computed once.
  let global: CandidateReason | null | undefined;
  const questionLevel = () => global === undefined
    ? global = CONDITION_OR_EXCEPTION.test(text) ? 'conditional_or_exception' : unionOfRequests(scanned ??= scan(text)) ? 'union_of_requests' : null
    : global;
  let candidates: AutomaticCandidate[] = [];
  const reasons = {} as Record<AutomaticField, CandidateReason>;
  for (const field of AUTOMATIC_FIELDS) {
    let reason: CandidateReason;
    if (!fields.includes(field)) reason = 'disabled';
    else if (requestedField(field, requested)) reason = 'requested';
    else if (emptyField(field, emitted)) reason = 'empty';
    else if (unsupported(field, emitted)) reason = 'unsupported_value';
    else if (tooMany(field, emitted)) reason = 'too_many_values';
    else if (unsafe) reason = 'unsafe_text';
    else if (questionLevel()) reason = questionLevel()!;
    else if (NOT_RESTRICTED[field].test(text)) reason = 'not_restricted';
    else {
      const s = scanned ??= scan(text);
      const decision = field === 'state' ? stateField(s, emitted.state!) : field === 'category' ? categoryField(s, emitted.category!) : yearsField(s, emitted);
      reason = decision.reason;
      if (decision.candidate) candidates.push(decision.candidate);
    }
    reasons[field] = reason;
  }
  // Alternatives and comparisons that involve a candidate refuse every candidate.
  if (candidates.length && crossField(scanned!, candidates)) {
    for (const c of candidates) reasons[c.field] = 'cross_field_alternative';
    candidates = [];
  }
  return { candidates, reasons };
}
