/**
 * Which of the scope's suggested state, years and aircraft category a question names explicitly
 * enough to be checked for automatic use (`attributed.v1`, Task 30 spec §2 and the design review's
 * fixes). Deterministic and structural, never semantic: a candidate only says that the question's
 * own words name exactly the suggested values, once each, in a form a filter conjunction can
 * represent. Whether those words describe the accident itself is the separate attribution check
 * (server/evidence/attribution.ts). Every rule here can only remove candidates; nothing creates a
 * filter value, and nothing reads model text except the suggested values compared against.
 *
 * Positions (`WitnessSpan`) index `normalizedQuestion(question)`: NFKC, whitespace collapsed to one
 * space, trimmed. A candidate keeps, per value, the one span of the question that names it (its
 * witness): a full state name, a whole `City, XX` place for a postal code, a category word, or the
 * complete year expression with its operator. The attribution check's quote must contain them.
 */
import type { BriefFilters } from './contracts/briefs.js';
import { AIRCRAFT_CATEGORY, US_STATE, US_STATE_CODES } from './vocab.js';

export const STATE_MENTION_VERSION = 'state-mention.v1';
export const YEAR_MENTION_VERSION = 'year-mention.v1';
export const CATEGORY_MENTION_VERSION = 'category-mention.v1';

export const AUTOMATIC_FIELDS = Object.freeze(['state', 'years', 'category'] as const);
export type AutomaticField = typeof AUTOMATIC_FIELDS[number];

/**
 * Why a field is or is not a candidate. `unsafe_text` and `conditional_or_exception` refuse every
 * field the scope suggested; `cross_field_alternative` refuses every field that was a candidate.
 */
export type CandidateReason = 'candidate' | 'disabled' | 'requested' | 'empty' | 'unsupported_value' | 'unsafe_text'
  | 'conditional_or_exception' | 'cross_field_alternative' | 'not_explicit' | 'set_mismatch' | 'negated' | 'relationship'
  | 'ambiguous_name' | 'range_mismatch' | 'ambiguous_expression' | 'repeated_mention';

/** [start, end) in `normalizedQuestion(question)`. */
export interface WitnessSpan { readonly start: number; readonly end: number }

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
/** Control, zero-width and bidirectional formatting characters; tab, newline and carriage return are whitespace. */
export const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u;
/** Quotation marks, angle brackets and single-quoted spans (as `explicitFilterText`), after NFKC. */
export const QUOTED_TEXT = /["“”«»`<>]|(?:^|\W)'[^']+'(?:\W|$)/u;
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
export const CONDITION_OR_EXCEPTION = /(?<![\p{L}\p{N}_])(?:if|unless|except|excepting|excluding|exclude|excludes|excluded|but not)(?![\p{L}\p{N}_])/iu;
/**
 * Alternative words. AirCase joins different filters with AND, so an alternative that touches a
 * candidate cannot be represented: one outside a field's own value list ("Alaska or Hawaii",
 * "helicopters or gyroplanes", "2015 or 2018") with a candidate's words among the two words before
 * or after it refuses every field ("in Alaska or at night"). Elsewhere ("fatal or serious") it does
 * not. "or later" and "or earlier" are year expressions, not alternatives.
 */
export const ALTERNATIVE_WORDS = Object.freeze(['or', 'either', 'nor'] as const);
export const ALTERNATIVE_WINDOW_WORDS = 2;
/** Comparisons: with any candidate, every field is refused. */
export const COMPARISON_WORDS = Object.freeze(['versus', 'vs', 'compare', 'compared', 'comparing', 'comparison', 'unlike',
  'rather than', 'instead of', 'whereas'] as const);
/** Words that may join two values of one list, and the qualifiers allowed around them. */
export const LIST_SEPARATORS = Object.freeze(['or', 'nor', 'and'] as const);
export const LIST_QUALIFIERS = Object.freeze(['the', 'state', 'of', 'in', 'near', 'at', 'a', 'an'] as const);
/** Exclusions and contrasts among the four words before a mention. */
export const LOCAL_NEGATIONS = Object.freeze(['not', 'no', 'outside', 'except', 'excluding', 'exclude', 'other than',
  'rather than', 'instead of', 'besides', 'beyond', 'anywhere but', 'neither', 'nor'] as const);
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
/** Multi-aircraft relationships: a category filter cannot say which aircraft is meant. */
export const RELATIONSHIP_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bcollisions?\b/iu, /\bcollid(?:e|es|ed|ing)\b/iu, /\bmid[- ]?airs?\b/iu,
  /\btow(?:s|ed|ing)?\b/iu, /\btow[- ]?planes?\b/iu, /\bformations?\b/iu,
  /\bwake\b/iu, /\bdownwash\b/iu, /\brescu(?:e|es|ed|ing|er|ers)\b/iu,
  /\b(?:two|three|four|both|multiple|several|second|another|other)\s+(?:[\p{L}-]+\s+)?(?:aircraft|planes?|jets?|airplanes?|aeroplanes?|helicopters?|choppers?|gliders?|sailplanes?|balloons?|blimps?|airships?|gyroplanes?|gyrocopters?|autogyros?|tiltrotors?|ultralights?|trikes?)\b/iu,
  /\bbetween\s+(?:a|an|the|two)\b/iu,
]);

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

// ---------------------------------------------------------------------------

const T = '\\p{L}\\p{N}_';
const B = `(?<![${T}])`;
const E = `(?![${T}])`;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (list: readonly string[]) => [...list].sort((a, b) => b.length - a.length).map(escape).join('|');

const STATE_CODES = new Set<string>(US_STATE_CODES);
const STATE_CODE = new Map(US_STATE_CODES.map(code => [US_STATE[code]!.toLowerCase(), code] as const));
/** Longest names first, so "West Virginia" is never also "Virginia". */
const STATE_NAME_RE = new RegExp(`${B}(?:${words([...STATE_CODE.keys()])})${E}`, 'giu');
const PLACE_SUFFIX = new RegExp(`^ (?:${words(STATE_PLACE_SUFFIXES)})${E}`, 'iu');
const POSTAL = new RegExp(`(?:^|${B}(?:${POSTAL_PREPOSITIONS.map(p => `[${p[0]!.toUpperCase()}${p[0]}]${escape(p.slice(1))}`).join('|')}) )`
  + `([A-Z][A-Za-z.'-]*(?: [A-Z][A-Za-z.'-]*){0,4}), ?([A-Z]{2})${E}`, 'dgu');
const ALLOWED_CATEGORIES = new Set(Object.keys(AIRCRAFT_CATEGORY).filter(code => code !== 'UNK'));
const CATEGORY_CODE = new Map(Object.entries(CATEGORY_WORDS).flatMap(([code, list]) => list.map(w => [w, code] as const)));
const CATEGORY_RE = new RegExp(`${B}(?:${words([...CATEGORY_CODE.keys()])})${E}`, 'giu');
const ALTERNATIVE_RE = new RegExp(`${B}(?:${words(ALTERNATIVE_WORDS)})${E}`, 'giu');
const COMPARISON_RE = new RegExp(`${B}(?:${words(COMPARISON_WORDS)})${E}`, 'iu');
const LIST_WORDS = new Set<string>([...LIST_SEPARATORS, ...LIST_QUALIFIERS]);
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
/** Operators before a range that would change its ends ("after 2015 through 2018"). */
const RANGE_OPERATOR = new RegExp(`${B}(?:after|before|since|until|till|through|thru|up to|by) $`, 'iu');
const DECADE_ARTICLE = new RegExp(`${B}(?:in )?the $`, 'diu');

/** The text the rules read and the spans index: NFKC, whitespace collapsed to one space, trimmed. */
export function normalizedQuestion(question: string): string {
  return question.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

interface Mention { field: AutomaticField; value: string; start: number; end: number; qualified?: boolean; postal?: boolean }
interface YearExpression { start: number; end: number; yearFrom?: number; yearTo?: number }
interface Scan {
  text: string;
  state: Mention[];
  category: Mention[];
  /** Year and decade tokens, for value lists. */
  yearTokens: Mention[];
  expressions: YearExpression[];
  /** A year construct the interval grammar cannot represent exactly: no years candidate. */
  yearsAmbiguous: boolean;
  /** A condition or exception anywhere. */
  conditional: boolean;
  /** Every field's values, in text order, and each one's value-list run (the index of its run's first value). */
  mentions: Mention[];
  run: number[];
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
const inside = (a: { start: number; end: number }, spans: readonly { start: number; end: number }[]) => spans.some(s => s.start <= a.start && a.end <= s.end);

function stateMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const occupied: { start: number; end: number }[] = [];
  // A qualified postal place first: a state name inside it ("Washington, DC") is the place's name.
  for (const m of text.matchAll(POSTAL)) {
    const code = m[2]!;
    if (!STATE_CODES.has(code)) continue;
    const span = { start: m.indices![1]![0], end: m.indices![2]![1] };
    out.push({ field: 'state', value: code, ...span, qualified: true, postal: true });
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

function categoryMentions(text: string): Mention[] {
  return [...text.matchAll(CATEGORY_RE)].map(m => ({ field: 'category' as const, value: CATEGORY_CODE.get(m[0].toLowerCase())!,
    start: m.index!, end: m.index! + m[0].length }));
}

/** Gap words between two values of one list: separators and qualifiers only. */
function listGap(gap: string): boolean {
  return gap.replace(/[,;:/&()\-–—.]/gu, ' ').split(' ').every(w => w === '' || LIST_WORDS.has(w.toLowerCase()));
}

const wordsOf = (text: string) => [...text.matchAll(WORD)].map(m => ({ start: m.index!, end: m.index! + m[0].length, word: m[0].toLowerCase() }));

/** A negation among the four words before `start`, not counting words of a year expression ("no later than 2019"). */
function negated(s: Scan, start: number): boolean {
  const before = ` ${wordsOf(s.text.slice(0, start)).filter(w => !inside(w, s.expressions)).slice(-NEGATION_WINDOW_WORDS).map(w => w.word).join(' ')} `;
  return LOCAL_NEGATIONS.some(n => before.includes(` ${n} `));
}

function yearScan(text: string): { tokens: Mention[]; expressions: YearExpression[]; ambiguous: boolean } {
  const all: (Mention & { decade: boolean })[] = [
    ...[...text.matchAll(YEAR_TOKEN)].map(m => ({ field: 'years' as const, value: m[1]!, start: m.index!, end: m.index! + m[0].length, decade: false })),
    ...[...text.matchAll(DECADE_TOKEN)].map(m => ({ field: 'years' as const, value: m[1]!, start: m.index!, end: m.index! + m[0].length, decade: true })),
  ].sort((a, b) => a.start - b.start);
  const expressions: YearExpression[] = [];
  let ambiguous = false;
  // "after A and/but before B" is one interval, A+1 to B-1, when that is not empty.
  const consumed = new Set<number>();
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i]!, b = all[i + 1]!;
    if (a.decade || b.decade || !AFTER_BEFORE_GAP.test(text.slice(a.end, b.start))) continue;
    const op = AFTER_OPERATOR.exec(text.slice(0, a.start));
    if (!op) continue;
    consumed.add(i).add(i + 1);
    const from = Number(a.value) + 1, to = Number(b.value) - 1;
    if (from > to || YEAR_SUFFIX.test(text.slice(b.end)) || YEAR_CONTINUATION.test(text.slice(b.end))) ambiguous = true;
    else expressions.push({ start: op.index, end: b.end, yearFrom: from, yearTo: to });
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
      if (range < 0 || a > b || RANGE_OPERATOR.test(text.slice(0, range))) { ambiguous = true; continue; }
      expressions.push({ start: range, end: last.end, yearFrom: a, yearTo: b });
      continue;
    }
    const suffixMatch = YEAR_SUFFIX.exec(after);
    if (first.decade) {
      if (suffixMatch && !/^ on(?![\p{L}\p{N}_])/iu.test(after) || YEAR_CONTINUATION.test(after)) { ambiguous = true; continue; }
      const article = DECADE_ARTICLE.exec(before);
      if (article) expressions.push({ start: article.index, end: first.end, yearFrom: Number(first.value), yearTo: Number(first.value) + 9 });
      continue;
    }
    const y = Number(first.value);
    const operator = YEAR_OPERATOR.exec(before);
    const op = operator?.[1]!.toLowerCase(), start = operator ? operator.indices![1]![0] : first.start;
    const sf = suffixMatch?.[1]!.toLowerCase().replace(/^,/, '').trim();
    // "on" ends a year only after "from" ("from 2015 on"); elsewhere it is a preposition.
    const suffix = sf === 'on' && op !== 'from' ? undefined : sf;
    if (!suffix && YEAR_CONTINUATION.test(after)) { ambiguous = true; continue; }
    const end = suffix ? first.end + suffixMatch![0].length : first.end;
    if (suffix) {
      const later = suffix === 'or later' || suffix === 'and later' || suffix.startsWith('onward') || suffix === 'on';
      // A suffix completes a bare year, "in"/"during" one, or "from" before on/onward; any other operator conflicts.
      if (op === 'from' ? !(suffix === 'on' || suffix.startsWith('onward')) : op !== undefined && op !== 'in' && op !== 'during') { ambiguous = true; continue; }
      expressions.push({ start, end, ...(later ? { yearFrom: y } : { yearTo: y }) });
      continue;
    }
    if (op && op !== 'from') {
      const interval = op === 'since the end of' || op === 'after' ? { yearFrom: y + 1 } : op === 'since' || op === 'no earlier than' ? { yearFrom: y }
        : op === 'before' ? { yearTo: y - 1 } : op === 'through' || op === 'up to' || op === 'no later than' ? { yearTo: y } : { yearFrom: y, yearTo: y };
      expressions.push({ start, end, ...interval });
      continue;
    }
    const noun = YEAR_EVENT_NOUN.exec(after);
    if (!op && noun && !YEAR_MODIFIER.test(before)) expressions.push({ start: first.start, end: first.end + noun[0].length, yearFrom: y, yearTo: y });
  }
  return { tokens: all, expressions, ambiguous };
}

function scan(text: string): Scan {
  const state = stateMentions(text), category = categoryMentions(text), years = yearScan(text);
  // Value lists: consecutive values of one field with only separators and qualifiers between.
  const mentions = [...state, ...category, ...years.tokens].sort((a, b) => a.start - b.start);
  const run = mentions.map((_, i) => i);
  for (let i = 1; i < mentions.length; i++) {
    if (mentions[i]!.field === mentions[i - 1]!.field && listGap(text.slice(mentions[i - 1]!.end, mentions[i]!.start))) run[i] = run[i - 1]!;
  }
  return { text, state, category, yearTokens: years.tokens, expressions: years.expressions, yearsAmbiguous: years.ambiguous,
    conditional: CONDITION_OR_EXCEPTION.test(text), mentions, run };
}

/**
 * An alternative or comparison the AND of filters cannot represent, given the candidates found: a
 * comparison word, or an alternative word outside one field's value list with a candidate's words
 * among the two words before or after it.
 */
function crossField(s: Scan, candidates: readonly AutomaticCandidate[]): boolean {
  if (COMPARISON_RE.test(s.text)) return true;
  const witnesses = candidates.flatMap(c => c.witnesses);
  const postal = s.state.filter(m => m.postal);
  const words = wordsOf(s.text);
  const { mentions, run } = s;
  for (const w of s.text.matchAll(ALTERNATIVE_RE)) {
    const span = { start: w.index!, end: w.index! + w[0].length };
    if (postal.some(p => overlaps(p, span)) || inside(span, s.expressions)) continue; // "Portland, OR", "2015 or later"
    const word = w[0].toLowerCase();
    if (word === 'or' && /^ (?:later|earlier)(?![\p{L}\p{N}_])/iu.test(s.text.slice(span.end))) continue;
    const next = mentions.findIndex(m => m.start >= span.end);
    // Inside one field's own value list ("Alaska or Hawaii"), or "either" before such a list.
    const inList = word === 'either'
      ? next >= 0 && listGap(s.text.slice(span.end, mentions[next]!.start)) && mentions.some((m, i) => i > next && run[i] === next
        && /(?<![\p{L}\p{N}_])n?or(?![\p{L}\p{N}_])/iu.test(s.text.slice(mentions[i - 1]!.end, m.start)))
      : next > 0 && mentions[next - 1]!.end <= span.start && run[next] === run[next - 1];
    if (inList) continue;
    // The word holding it (itself, or a hyphenated "Ohio-or-Iowa") and the two words on each side.
    const at = words.findIndex(x => overlaps(x, span));
    const near = words.slice(Math.max(0, at - ALTERNATIVE_WINDOW_WORDS), at + 1 + ALTERNATIVE_WINDOW_WORDS);
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
  return { reason: 'candidate', values, witnesses: values.map(v => mentions.find(m => m.value === v)!).map(m => ({ start: m.start, end: m.end })) };
}

function stateField(s: Scan, emitted: readonly string[]): { reason: CandidateReason; candidate?: AutomaticCandidate } {
  if (!s.state.length) return { reason: 'not_explicit' };
  if (s.state.some(m => negated(s, m.start))) return { reason: 'negated' };
  // Washington alone could be the District of Columbia's city: it needs "state of", "state" or "City, WA".
  if (s.state.some(m => m.value === 'WA' && !m.qualified)) return { reason: 'ambiguous_name' };
  const d = setDecision(s.text, s.state, emitted);
  return d.reason === 'candidate' ? { reason: d.reason, candidate: { field: 'state', state: d.values!, witnesses: d.witnesses! } } : { reason: d.reason };
}

function categoryField(s: Scan, emitted: readonly string[]): { reason: CandidateReason; candidate?: AutomaticCandidate } {
  const m = s.category;
  if (!m.length) return { reason: 'not_explicit' };
  if (RELATIONSHIP_PATTERNS.some(re => re.test(s.text))) return { reason: 'relationship' };
  // Two categories that are not one list ("a glider landing forced an airplane"), or a list of
  // individual aircraft ("a helicopter and an airplane"), describe several aircraft.
  for (let i = 1; i < m.length; i++) {
    const gap = s.text.slice(m[i - 1]!.end, m[i]!.start);
    if (m[i]!.value !== m[i - 1]!.value && (!listGap(gap) || /(?<![\p{L}\p{N}_])(?:and|with)(?![\p{L}\p{N}_])[^]*(?<![\p{L}\p{N}_])(?:a|an)(?![\p{L}\p{N}_])/iu.test(gap))) {
      return { reason: 'relationship' };
    }
  }
  if (m.some(x => negated(s, x.start))) return { reason: 'negated' };
  const d = setDecision(s.text, m, emitted);
  return d.reason === 'candidate' ? { reason: d.reason, candidate: { field: 'category', category: d.values!, witnesses: d.witnesses! } } : { reason: d.reason };
}

function yearsField(s: Scan, e: BriefFilters): { reason: CandidateReason; candidate?: AutomaticCandidate } {
  if (s.yearsAmbiguous) return { reason: 'ambiguous_expression' };
  if (!s.expressions.length) return { reason: 'not_explicit' };
  const intervals = new Set(s.expressions.map(x => `${x.yearFrom ?? ''}:${x.yearTo ?? ''}`));
  if (intervals.size > 1) return { reason: 'ambiguous_expression' };
  if (s.expressions.length > 1) return { reason: 'repeated_mention' };
  const x = s.expressions[0]!;
  if (negated(s, x.start)) return { reason: 'negated' };
  // The suggestion as given, an absent bound open, must be exactly the expression's interval.
  if (x.yearFrom !== e.yearFrom || x.yearTo !== e.yearTo) return { reason: 'range_mismatch' };
  return { reason: 'candidate', candidate: { field: 'years', ...(x.yearFrom !== undefined ? { yearFrom: x.yearFrom } : {}),
    ...(x.yearTo !== undefined ? { yearTo: x.yearTo } : {}), witnesses: [{ start: x.start, end: x.end }] } };
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
    || QUOTED_TEXT.test(text) || INJECTION_PATTERNS.some(re => re.test(text));
  let scanned: Scan | undefined;
  let candidates: AutomaticCandidate[] = [];
  const reasons = {} as Record<AutomaticField, CandidateReason>;
  for (const field of AUTOMATIC_FIELDS) {
    let reason: CandidateReason;
    if (!fields.includes(field)) reason = 'disabled';
    else if (requestedField(field, requested)) reason = 'requested';
    else if (emptyField(field, emitted)) reason = 'empty';
    else if (unsupported(field, emitted)) reason = 'unsupported_value';
    else if (unsafe) reason = 'unsafe_text';
    else {
      const s = scanned ??= scan(text);
      const decision = s.conditional ? { reason: 'conditional_or_exception' as const } : field === 'state' ? stateField(s, emitted.state!)
        : field === 'category' ? categoryField(s, emitted.category!) : yearsField(s, emitted);
      reason = decision.reason;
      if ('candidate' in decision && decision.candidate) candidates.push(decision.candidate);
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
