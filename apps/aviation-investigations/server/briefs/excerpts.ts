/**
 * The excerpt-context policy, version **`excerpt-context-v1`** (Task 16e; gate G6, the 16d
 * verdict's finding 1): an excerpt whose meaning depends on text outside it is never
 * displayed. The quotation rule (`quote-ws-v2`, server/briefs/validate.ts) proves that the
 * words exist in the passage; this policy decides, in code and before any model reads the
 * claim, whether they can be read alone. It supplements the evidence checker's semantic
 * judgement and never replaces it: an excerpt the policy keeps is still judged, and one it
 * omits is still sent to the checker (its verdict is diagnostic and counts toward the
 * case's contradictions), but it is never shown.
 *
 * **Fail closed.** The rules fire on the words, not on a judgement of the sentence, and a
 * complete sentence is not independent because it is complete ("The accident flight was
 * the first flight after completion of this work."). Version 1 supplies no surrounding
 * context: an excerpt that needs an antecedent or an anchor outside it is omitted, never
 * extended, because nothing here can prove that added words hold the antecedent (the 16d
 * review's "this work" points at three sentences of installation, verification and
 * maintenance runs). The false omissions are measured on a labelled corpus of real NTSB
 * excerpts (evals/checker/excerpts.ts, `pnpm eval:checker excerpts`).
 *
 * **What the policy reads**: the passage text and the excerpt's span in it (as validated),
 * the speaker the composition gives the quote, and whether the event had more than one
 * aircraft. It returns content-free problem codes, empty when the excerpt is kept:
 * - `partial_sentence`: the excerpt is not whole sentences of the passage. Words the
 *   excerpt leaves out of its sentences can carry a negation, a condition, a possibility,
 *   a source or the setting ("did not reveal any anomalies that …", "Had the F-16 been
 *   equipped …", "a service bulletin … included a warning that …", "During a subsequent
 *   test-run of the engine, …", "…, but he did not check it after finishing"), and a cut
 *   start drops its subject ("could be rotated …", "which eliminated system redundancy").
 *   Leaving out the final punctuation or closing quotation mark is not a cut, nor is a
 *   section heading the stored text runs into the sentence ("WRECKAGE AND IMPACT
 *   INFORMATIONPostaccident examination …"). For a pilot's or a witness's account, the
 *   lead-in that says who reported the words may be left out ("The pilot reported that
 *   …", "…, the pilot stated, “…”"): the quote's speaker label carries it. A list item is
 *   judged as a sentence: a bulleted probable-cause finding stands alone, a fragment of a
 *   list of possibilities may not, and the words do not tell them apart (left to the
 *   checker).
 * - `leading_reference`: the excerpt opens with a word that points outside it: a
 *   demonstrative or pronoun ("This …", "These …", "It failed …", "He …", "They …"), or a
 *   connective that continues earlier text ("Then …", "However …", "Therefore …", "But
 *   …"). An expletive "It" ("It was determined that …", "It is likely that …"), an
 *   existential "There", and "Both", "Either" or "Neither" before a noun ("Neither pilot
 *   …") are not references.
 * - `pronoun`: "he", "she", "him", "her" or "his" in an excerpt that names no person
 *   ("making it difficult for him to see"): it does not say who. In a pilot's account of a
 *   single-aircraft event, they are the pilot.
 * - `demonstrative`: "this", "these" or "those" anywhere, or "that" after a preposition
 *   ("at that time", "in response to that alarm"), pointing at something the excerpt does
 *   not name: "this work", "these repairs", "these lines". "This accident", "this
 *   investigation", "this report" and the like name the case itself and are kept, and so
 *   is a demonstrative whose noun the excerpt names before it ("Cylinders 1 and 2 were
 *   removed; these cylinders …", "an annual inspection …, the first flight since that
 *   maintenance").
 * - `relative_time`: a time measured from an anchor the excerpt does not state: "2 days
 *   later", "approximately 29 hours earlier", "a short time later", "the previous day",
 *   "the day before", "that morning", "earlier that day". A time with its anchor stated is
 *   kept: "2 days before the accident", "about 198 hours after the cylinders were
 *   replaced", "the day before the accident flight".
 * - `relative_sequence`: a flight counted from something the excerpt does not state ("the
 *   next flight", "the airplane's next flight", "the second flight", "its first flight"),
 *   or "then" placing the excerpt after earlier events ("The nut then gradually loosened
 *   …"). It is kept with its anchor: "the first flight after the annual inspection", "the
 *   first flight subsequent to the installation".
 * - `comparison`: a comparison with nothing in the excerpt to compare with: "similar",
 *   "comparable", "identical", "likewise", "the same", "the other", "the rest", "the
 *   former", "the latter", "aforementioned". "Similar to …" and "the same … as …" carry
 *   their object and are kept, and so is "the other airplane" (pilot, aircraft) in an
 *   event with two aircraft, which names its aircraft through the case. Additive words
 *   ("also", "again", "too", "another") are kept: they do not change what the excerpt
 *   states.
 *
 * The policy's verdict is the same for every reader and every model. It is part of the
 * validated composition (`ResolvedCitation.excerpt`), and the display projection never
 * shows an excerpt with a problem (server/briefs/display.ts, `display-deps-v2`).
 */

export const EXCERPT_CONTEXT_VERSION = 'excerpt-context-v1';

export const EXCERPT_PROBLEMS = ['partial_sentence', 'leading_reference', 'pronoun', 'demonstrative', 'relative_time', 'relative_sequence', 'comparison'] as const;
export type ExcerptProblem = (typeof EXCERPT_PROBLEMS)[number];

export interface ExcerptInput {
  /** The passage's text, exactly as stored. */
  passage: string;
  /** The excerpt's span in the passage text (UTF-16 offsets), as validation resolved it. */
  span: { start: number; end: number };
  /** Whose words the composition says they are. */
  speaker: 'investigators' | 'pilot' | 'witness';
  /** The event involved more than one aircraft. */
  multiAircraft: boolean;
}

/** The policy's verdict on one excerpt: shown only when `problems` is empty. */
export interface ExcerptVerdict {
  rules: typeof EXCERPT_CONTEXT_VERSION;
  problems: ExcerptProblem[];
}

// ---------------------------------------------------------------------------
// Sentences of a passage

/**
 * Words whose period continues the sentence when another word follows on the same line
 * ("No. 2", "approx. 5", "Mr. Smith", "U.S. Air Force", "e.g. the", "Inc. reported").
 */
const ABBREVIATION =
  /(?:^|[\s(“"'‘])(?:No|Nos|no|nos|approx|Approx|ca|Mr|Mrs|Ms|Dr|St|Mt|Ft|Inc|Co|Corp|Ltd|Jr|Sr|vs|Fig|Figs|Ref|Vol|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|e\.g|i\.e|U\.S|U\.K|a\.m|p\.m|ft|lbs?|hrs?|oz|gal|qt|deg|kts?|mph|psi)\.$/;

/**
 * Sentence spans of a passage (offsets into it): a sentence ends at a run of `.`, `!` or
 * `?` (with any closing marks) before whitespace and an upper-case letter, a digit or an
 * opening mark, unless the period is an abbreviation's; every line break ends one too.
 */
export function passageSentences(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  const push = (end: number) => {
    let s = start;
    while (s < end && /\s/.test(text[s]!)) s += 1;
    let e = end;
    while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
    if (e > s) out.push({ start: s, end: e });
  };
  const boundary = /([.!?]+["')”’\]]*)(\s+)(?=["“‘'([]?[A-Z0-9])|\n+/g;
  for (const m of text.matchAll(boundary)) {
    const at = m.index ?? 0;
    if (m[0].startsWith('\n')) {
      push(at);
      start = at + m[0].length;
      continue;
    }
    const punct = m[1]!;
    const stop = at + punct.length;
    if (punct === '.' && !m[2]!.includes('\n') && ABBREVIATION.test(text.slice(Math.max(0, at - 12), at + 1))) continue;
    push(stop);
    start = stop;
  }
  push(text.length);
  return out;
}

// ---------------------------------------------------------------------------
// Word lists (lower case)

/** Words that open an excerpt and point outside it. */
const LEADING = new Set([
  'this', 'these', 'that', 'those', 'such', 'it', 'its', 'they', 'their', 'them', 'theirs', 'he', 'his', 'him', 'she',
  'her', 'hers', 'other', 'others', 'then', 'thus', 'therefore', 'hence', 'consequently', 'subsequently', 'afterward',
  'afterwards', 'later', 'earlier', 'meanwhile', 'instead', 'still', 'yet', 'but', 'and', 'or', 'nor', 'so', 'however',
  'nevertheless', 'nonetheless', 'furthermore', 'moreover', 'likewise', 'similarly', 'accordingly', 'here', 'which',
  'whom', 'whose', 'thereafter', 'otherwise', 'besides', 'again', 'respectively', 'both', 'either', 'neither', 'former',
  'latter', 'eventually', 'ultimately', 'finally',
]);
/** An opening generic noun that points back ("The area …", "The tests showed …"), unlike a part or party of the case. */
const LEADING_GENERIC = /^the\s+(?:area|issue|problem|condition|situation|matter|tests?|items?|discrepanc(?:y|ies)|process|procedure|method|remainder)\b/i;
/** "Both pilots", "Neither pilot", "Either magneto": a determiner before a noun, not a pronoun. */
const DETERMINER_LEADS = new Set(['both', 'either', 'neither']);
/** What follows "Both", "Either" or "Neither" when it is a pronoun ("Both were …", "Neither of …"). */
const PRONOUN_FOLLOWERS = /^(?:of|were|was|is|are|had|have|has|did|do|does|could|would|should|may|might|must|can|will|appeared|seemed|showed|revealed|exhibited|contained|failed)$/i;

/** An opening "It" that is an expletive, not a reference ("It was determined that", "It is likely that", "It could not be determined"). */
const EXPLETIVE_IT =
  /^it\s+(?:(?:is|was|has\s+been|had\s+been|could|can|cannot|may|might|would|will|appears?|appeared|seems?|seemed|remains?|remained)\s+)+(?:not\s+)?(?:be\s+)?(?:possible|impossible|likely|unlikely|probable|improbable|plausible|unknown|unclear|undetermined|uncertain|determined|found|noted|concluded|estimated|reported|believed|observed|evident|apparent|clear|important|necessary|recommended|considered|expected|assumed|that|to)\b/;

/** People a "he", "she", "him", "her" or "his" can name. */
const PERSONS =
  /\b(?:pilots?|copilots?|co-pilots?|captain|first\s+officer|instructors?|cfi|students?|mechanics?|technicians?|inspectors?|owners?|operators?|witness(?:es)?|passengers?|controllers?|director|examiner|repairman|manager|president|employee|person|individual|crew(?:member)?s?|airman|man|woman|renter|buyer|seller|builder|assembler|lessee|fueler|lineman|dispatcher|son|father|husband|wife|friend|brother|chief|supervisor|engineer|specialist|representative|agent|officer|trooper|deputy|dom)\b/i;

/** A plural noun, crudely: a word ending in "s" (`NOT_PLURAL` aside), or "personnel", "crew", "people". */
const PLURAL = /^(?:[a-z-]{3,}s|personnel|crew|people|staff)$/;
const NOT_PLURAL = new Set(['was', 'has', 'does', 'this', 'its', 'his', 'hers', 'ours', 'theirs', 'yes', 'thus', 'less', 'plus', 'unless', 'always', 'perhaps', 'across', 'towards', 'afterwards', 'whereas', 'various', 'previous', 'serious', 'obvious', 'numerous', 'gas', 'chassis', 'pass', 'loss', 'mass', 'class', 'brass', 'glass', 'process', 'access', 'address', 'stress', 'bus', 'status', 'focus', 'radius', 'canvas', 'lens', 'atlas']);
/** Nouns "this", "these" and "those" may point at without leaving the case: the case itself. */
const CASE_ANCHORS = new Set(['accident', 'accidents', 'investigation', 'report', 'event', 'incident', 'mishap', 'crash', 'case', 'collision']);
/** Maintenance words: "that maintenance" names an inspection, repair or other work the excerpt named before it (`MAINTENANCE_EVENTS`). */
const MAINTENANCE_WORDS = /^(?:maintenance|work|inspection|inspections|repair|repairs|overhaul|overhauls|installation|replacement|service|servicing|modification|modifications|alteration|alterations|annual)$/i;
/** Words that name a maintenance event ("maintenance" itself is often a modifier: "maintenance records", "maintenance personnel"). */
const MAINTENANCE_EVENTS = /^(?:work|inspection|inspections|repair|repairs|overhaul|overhauls|installation|replacement|modification|modifications|alteration|alterations)$/i;

/** A pilot's or witness's lead-in that says who reported the words ("The pilot reported that", "the pilot stated, “"). */
const REPORT_LEAD_IN = /\b(?:reported|stated|said|recalled|wrote|explained|indicated|added|remarked|described|noted|told\s+(?:the\s+)?[A-Za-z-]+(?:\s+[A-Za-z-]+)?)(?:\s+that)?\s*[,:]?\s*["“‘']?\s*$/i;
/** …and the same after the words (", the pilot said."). */
const REPORT_TAIL = /^\s*["”’']?\s*,?\s*(?:the\s+)?(?:pilot|witness|he|she|they|student|instructor|owner|mechanic)\s+(?:reported|stated|said|added|recalled|wrote)\s*[.!]?\s*["”’']?\s*$/i;
/** A section heading the stored text runs into the next sentence ("WRECKAGE AND IMPACT INFORMATION"). */
const HEADING = /^[\sA-Z0-9&,.'’()/:-]*$/;

/** Units of a relative time. */
const UNITS = '(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|flights?|flight\\s+hours?|hrs?)';
/** Amounts: numbers, number words, "a few", "several" and the like. */
const AMOUNT =
  '(?:\\d+(?:[.,]\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|hundred|several|few|a\\s+few|many|some|a\\s+couple\\s+of|couple\\s+of)';
/** "2 days later", "approximately 29 hours earlier", "a few minutes after" (an anchor may follow: read separately). */
const AMOUNT_RELATIVE = new RegExp(
  `\\b(?:about\\s+|approximately\\s+|nearly\\s+|almost\\s+|over\\s+|more\\s+than\\s+|less\\s+than\\s+|just\\s+|only\\s+|roughly\\s+|around\\s+)?${AMOUNT}\\s+(?:more\\s+)?${UNITS}\\s+(later|earlier|ago|before|after|prior|previously|beforehand|afterward|afterwards|thereafter|since|following)\\b`,
  'gi',
);
/** Relative times without an amount. */
const BARE_RELATIVE =
  /\b(?:a\s+short\s+(?:time|while)\s+(?:later|after|before|earlier)|shortly\s+(?:thereafter|afterward|afterwards|after|before)|soon\s+(?:thereafter|afterward|afterwards|after)|moments?\s+(?:later|after|before|earlier)|not\s+long\s+(?:after|before)|some\s+time\s+(?:later|after|before|earlier)|(?:earlier|later)\s+(?:that|the\s+same)\s+(?:day|morning|afternoon|evening|night|week)|(?:that|the\s+same)\s+(?:day|morning|afternoon|evening|night|week|month)|the\s+(?:day|night|evening|morning|week|month|year)\s+(?:before|prior|after|earlier|later)|the\s+(?:previous|prior|preceding|next|following|subsequent)\s+(?:day|night|evening|morning|afternoon|week|weekend|month|year)|(?<![\w-])(?:earlier|later|afterward|afterwards|thereafter|beforehand)(?![\w-]))/gi;
/**
 * An object after a preposition that anchors what precedes it ("before the accident",
 * "after that inspection"), not a bare pointer ("before that.", "after it", "since then").
 * A demonstrative with its noun is left to the demonstrative rule, which keeps it only when
 * the excerpt names the noun.
 */
const OBJECT = String.raw`\s+(?!(?:it|them|then|which|there)\b|(?:that|this|these|those)\s*(?:[,.;:!?)”’"']|$))[A-Za-z0-9“"'‘]`;
/** What anchors a relative time that does not end in its preposition: "… later than", "the same day as the accident". */
const ANCHOR_AFTER = new RegExp(`^\\s*(?:,\\s*)?(?:before|after|prior\\s+to|following|since|than|of|as|subsequent\\s+to)${OBJECT}`, 'i');
/** An object that anchors a time ending in its preposition ("2 days before the accident", "prior to the flight"). */
const OBJECT_AFTER = new RegExp(`^(?:\\s+to)?${OBJECT}`, 'i');

/** "the next flight", "its first flight", "the second flight" (an anchor may follow). */
const SEQUENCE =
  /\b(?:the|its|his|her|their|that|this|a|an|the\s+airplane['’]s|the\s+aircraft['’]s|the\s+helicopter['’]s)\s+(?:(?:very|immediately)\s+)?(?:next|following|previous|prior|preceding|subsequent|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|1st|2nd|3rd|4th|5th)\s+(?:(?:test|maintenance|post-maintenance|ferry|local|cross-country|training|revenue|check|functional|solo)\s+)?(?:flights?|legs?|trips?|engine\s+runs?|ground\s+runs?)\b/gi;
/** "the next entry", "the next morning": a next item of something the excerpt does not state (flights: `SEQUENCE`). */
const NEXT_ITEM = /\b(?:the|its|his|her|their)\s+next\s+(?!(?:flights?|legs?|trips?)\b)[a-z]+/gi;
/** "within the previous 6 months", "during the past year": a period counted back or forward from an unstated time. */
const PERIOD = /\b(?:within|during|in|over|for)\s+the\s+(?:previous|prior|preceding|last|past|next|following)\s+(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|few)\s+)?(?:hours?|days?|weeks?|months?|years?|flights?)\b/gi;
/** What anchors a counted flight: "after the annual inspection", "since its annual inspection", "subsequent to the installation". */
const SEQUENCE_ANCHOR = new RegExp(`^\\s*(?:,\\s*)?(?:(?:in|of)\\s+the\\s+(?:airplane|aircraft|helicopter)\\s+)?(?:after|since|following|subsequent\\s+to)${OBJECT}`, 'i');

/** Comparisons that need something to compare with. */
const COMPARISONS =
  /\b(?:similar(?:ly)?|comparable|identical|likewise|the\s+same|the\s+other(?:s)?|the\s+rest(?!\s+of\b)|the\s+former|the\s+latter|aforementioned|above-mentioned|in\s+contrast)\b/gi;
/** What makes a comparison carry its own object: "similar to", "similar in composition to", "similar recommendations to", "the same as". */
const COMPARISON_OBJECT = /^\s*(?:[\w-]+\s+){0,3}(?:to|with|as|than)\b/i;
/** "the other airplane" in an event with two aircraft names its aircraft through the case. */
const OTHER_AIRCRAFT = /^\s+(?:airplanes?|aircraft|pilots?|helicopters?|balloons?|gliders?|crews?|airship|gyroplanes?)\b/i;

// ---------------------------------------------------------------------------

interface Word {
  text: string;
  lower: string;
  start: number;
  end: number;
}

function wordsOf(text: string): Word[] {
  return [...text.matchAll(/[A-Za-z][A-Za-z'’-]*|\d+(?:[.,]\d+)?/g)].map((m) => ({
    text: m[0],
    lower: m[0].toLowerCase().replace(/[’']s$/, ''),
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
}

/** The text without opening quotation marks and parentheses. */
const openingTrimmed = (s: string) => s.replace(/^[\s“"'‘([]+/, '');

/** A crude stem: the lower-case word without a plural or past ending ("these cylinders" ← "cylinder"). */
const stem = (w: string) => w.toLowerCase().replace(/(?:ies|es|s|ed|ing)$/, '').slice(0, 7);

/** True when the dropped text holds no word or number. */
const onlyPunctuation = (s: string) => !/[\p{L}\p{N}]/u.test(s);

/** Whether the excerpt is whole sentences of its passage (module comment, `partial_sentence`). */
function wholeSentences(x: ExcerptInput): boolean {
  const sentences = passageSentences(x.passage);
  const first = sentences.find((s) => s.start <= x.span.start && x.span.start < s.end);
  const last = [...sentences].reverse().find((s) => s.start < x.span.end && x.span.end <= s.end);
  const prefix = first ? x.passage.slice(first.start, x.span.start) : '';
  const suffix = last ? x.passage.slice(x.span.end, last.end) : '';
  const account = x.speaker !== 'investigators';
  const prefixOk = onlyPunctuation(prefix) || (HEADING.test(prefix) && /[A-Z]{2}/.test(prefix)) || (account && REPORT_LEAD_IN.test(prefix));
  const suffixOk = onlyPunctuation(suffix) || (account && REPORT_TAIL.test(suffix));
  return prefixOk && suffixOk;
}

/** The policy's problems with one excerpt (empty: it may be shown). */
export function excerptProblems(x: ExcerptInput): ExcerptProblem[] {
  const problems = new Set<ExcerptProblem>();
  const text = x.passage.slice(x.span.start, x.span.end);
  const words = wordsOf(text);
  const opening = openingTrimmed(text);
  const openingWords = wordsOf(opening);
  const lead = openingWords[0]?.lower ?? '';

  // Whole sentences, which include what they announce ("… stated the following:").
  if (!wholeSentences(x) || /\b(?:the\s+following|as\s+follows)\s*:\s*["”’']?\s*$/i.test(text)) problems.add('partial_sentence');

  // The opening word.
  if (LEADING.has(lead)) {
    const next = openingWords[1];
    const determiner = DETERMINER_LEADS.has(lead) && next !== undefined && !PRONOUN_FOLLOWERS.test(next.text);
    const expletive = lead === 'it' && EXPLETIVE_IT.test(opening.toLowerCase());
    const anchored = (lead === 'this' || lead === 'these' || lead === 'those') && next !== undefined && CASE_ANCHORS.has(next.lower);
    if (!determiner && !expletive && !anchored) problems.add('leading_reference');
  }
  if (LEADING_GENERIC.test(opening)) problems.add('leading_reference');

  // Pronouns naming a person: the excerpt must name a person (before or after them); in a
  // pilot's account of a single-aircraft event they are the pilot.
  const personal = words.some((w) => /^(?:he|him|his|she|her|hers|himself|herself)$/.test(w.lower));
  if (personal && !PERSONS.test(text) && !(x.speaker === 'pilot' && !x.multiAircraft)) problems.add('pronoun');
  // "they" and "them" after the opening need a plural named before them ("the pilots … they").
  for (const [i, w] of words.entries()) {
    if (i === 0 || (w.lower !== 'they' && w.lower !== 'them' && w.lower !== 'themselves')) continue;
    if (!words.slice(0, i).some((v) => PLURAL.test(v.lower) && !NOT_PLURAL.has(v.lower)) && !PERSONS.test(text.slice(0, w.start))) problems.add('pronoun');
  }
  // "I", "we", "us": words given as the investigators' own quote someone else; in an account they are its speaker.
  if (x.speaker === 'investigators' && words.some((w) => /^(?:i|me|my|mine|we|us|our|ours)$/.test(w.lower) && w.text !== 'US')) problems.add('pronoun');

  // Demonstratives: "this", "these", "those" anywhere; "that" after a preposition.
  const named = (noun: Word | undefined, before: number) => {
    if (!noun || !/^[a-z]/i.test(noun.text)) return false;
    const earlier = words.filter((v) => v.end <= before);
    return earlier.some((v) => stem(v.text) === stem(noun.text)) || (MAINTENANCE_WORDS.test(noun.text) && earlier.some((v) => MAINTENANCE_EVENTS.test(v.text)));
  };
  for (const [i, w] of words.entries()) {
    const that = w.lower === 'that' && i > 0 && /^(?:at|on|in|after|before|since|during|from|until|by|following|to|with|for|of|about|under|upon)$/.test(words[i - 1]!.lower);
    if (w.lower !== 'this' && w.lower !== 'these' && w.lower !== 'those' && !that) continue;
    const next = words[i + 1];
    // "after that the engine …" is a conjunction, not a pointer.
    if (that && next && /^(?:the|a|an|he|she|it|they|there|his|her|its|their)$/.test(next.lower)) continue;
    if (next && CASE_ANCHORS.has(next.lower)) continue;
    if (named(next, w.start)) continue;
    problems.add('demonstrative');
    break;
  }

  // Relative times without their anchor.
  for (const m of text.matchAll(AMOUNT_RELATIVE)) {
    const rel = m[1]!.toLowerCase();
    const after = text.slice((m.index ?? 0) + m[0].length);
    const preposition = rel === 'before' || rel === 'after' || rel === 'prior' || rel === 'since' || rel === 'following';
    if (preposition ? OBJECT_AFTER.test(after) : ANCHOR_AFTER.test(after)) continue;
    problems.add('relative_time');
    break;
  }
  if (!problems.has('relative_time')) {
    for (const m of text.matchAll(BARE_RELATIVE)) {
      const after = text.slice((m.index ?? 0) + m[0].length);
      const preposition = /(?:before|after|prior)$/i.test(m[0]);
      if (preposition ? OBJECT_AFTER.test(after) : ANCHOR_AFTER.test(after)) continue;
      // "was later attributed to …": later than the events the sentence itself states.
      if (/^later$/i.test(m[0]) && /^\s+[a-z]+ed\b/.test(after)) continue;
      problems.add('relative_time');
      break;
    }
  }
  for (const m of text.matchAll(PERIOD)) {
    if (ANCHOR_AFTER.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    problems.add('relative_time');
    break;
  }

  // Flights counted from something unstated, and "then".
  for (const m of text.matchAll(SEQUENCE)) {
    if (SEQUENCE_ANCHOR.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    problems.add('relative_sequence');
    break;
  }
  if (words.some((w, i) => w.lower === 'then' && i > 0)) problems.add('relative_sequence');
  for (const m of text.matchAll(NEXT_ITEM)) {
    if (ANCHOR_AFTER.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    problems.add('relative_sequence');
    break;
  }

  // Comparisons with nothing to compare with.
  for (const m of text.matchAll(COMPARISONS)) {
    const after = text.slice((m.index ?? 0) + m[0].length);
    const word = m[0].toLowerCase().replace(/\s+/g, ' ');
    if (COMPARISON_OBJECT.test(after)) continue;
    if ((word === 'the other' || word === 'the others') && x.multiAircraft && OTHER_AIRCRAFT.test(after)) continue;
    problems.add('comparison');
    break;
  }

  return EXCERPT_PROBLEMS.filter((p) => problems.has(p));
}

/** The policy's verdict on one excerpt. */
export function excerptVerdict(x: ExcerptInput): ExcerptVerdict {
  return { rules: EXCERPT_CONTEXT_VERSION, problems: excerptProblems(x) };
}
