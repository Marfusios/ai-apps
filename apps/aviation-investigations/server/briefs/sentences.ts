/**
 * Sentence splitting for generated summaries, shared by the validator (every sentence
 * must end with the markers of the cases it is about) and the check input (one claim per
 * sentence).
 *
 * **When in doubt, split.** Splitting too often can only withhold a summary: a fragment
 * without its own marker fails `uncited_summary`. Merging two sentences would let an
 * uncited one borrow the other's citation, past the deterministic citation check. So:
 *
 * - A sentence ends at `.`, `!` or `?`, with any closing quotes or parentheses after it,
 *   followed by whitespace or the end of the text, and after any `[[case:…]]` markers
 *   that follow the punctuation. Markers after the last sentence's punctuation stay with
 *   it ("…was bad. [[case:B]]" at the end of the text is one sentence).
 * - A period right after a marker always ends the sentence ("…overhaul [[case:A]]. 3…").
 * - Otherwise a period is not a sentence end only after a recognised abbreviation followed
 *   by a token that cannot start a new sentence there (`CONTEXTS`): "No."/"Nos." before a
 *   number, "approx."/"ca." before a number, "Mr."/"Mrs."/"Ms." before a capitalised name,
 *   "U.S." before a lower-case word or "Code", "U.S.C." before a number or "§", and
 *   "e.g."/"i.e." before a lower-case word. Nothing else: a unit ("1,000 ft."), a time
 *   ("1430 hrs."), a place or company abbreviation ("St.", "Inc."), a title other than
 *   those, an initial, or any period before a lower-case word or a number ends the
 *   sentence there, so a summary that uses them mid-sentence is withheld (the compose
 *   prompt asks for words written out).
 *
 * `citationPlacement` then requires a sentence's markers at its end, immediately before
 * or after its final punctuation; a marker anywhere else is an ambiguous boundary
 * (`misplaced_citation` in the validator).
 */

const MARKER = /\[\[case:[A-Za-z0-9]+\]\]/;
/** Zero or more case markers, each after optional whitespace. */
const MARKERS = String.raw`(?:\s*\[\[case:[A-Za-z0-9]+\]\])*`;
/** Final punctuation, with any closing quotation marks or parentheses after it. */
const END = String.raw`[.!?]["'”’)]*`;

/** A candidate sentence end: the punctuation, the markers after it, then whitespace or the end of the text. */
const BOUNDARY = new RegExp(String.raw`(${END})(${MARKERS})(?:\s+(?=\S)|\s*$)`, 'g');

/** Text ending in a case marker: a period after it closes a cited sentence. */
const AFTER_MARKER = /\[\[case:[A-Za-z0-9]+\]\]\s*$/;

/**
 * The only periods that do not end a sentence: after `word` (the text just before the
 * period, case-sensitive), when the next token matches `next`. Each is a context where a
 * new sentence cannot start.
 */
const CONTEXTS: readonly { word: RegExp; next: RegExp }[] = [
  // "the No. 2 engine", "cylinders Nos. 3 and 4".
  { word: /^Nos?$/, next: /^\d/ },
  // "approx. 5 minutes", "ca. 1990".
  { word: /^(?:approx|Approx|ca)$/, next: /^\d/ },
  // "Mr. Smith". ("Dr." is left out: it also abbreviates "Drive", which can end a sentence.)
  { word: /^(?:Mr|Mrs|Ms)$/, next: /^\p{Lu}\p{Ll}/u },
  // "the U.S. operator", "the U.S. Code".
  { word: /^U\.S$/, next: /^(?:\p{Ll}|Code\b)/u },
  // "49 U.S.C. 1154(b)", "U.S.C. § 1154".
  { word: /^U\.S\.C$/, next: /^(?:\d|§)/ },
  // "e.g. a flight school", "i.e. the left magneto".
  { word: /^(?:e\.g|i\.e)$/, next: /^\p{Ll}/u },
];

function abbreviationContinues(before: string, next: string): boolean {
  const word = /(?:^|[^A-Za-z.])([A-Za-z.]+)$/.exec(before)?.[1] ?? '';
  return CONTEXTS.some((c) => c.word.test(word) && c.next.test(next));
}

/** The sentences of `text`, trimmed, markers kept with the sentence they end. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const at = m.index ?? 0;
    const end = m[1]!;
    const markers = m[2] ?? '';
    const before = text.slice(start, at);
    if (end === '.' && markers === '' && !AFTER_MARKER.test(before) && abbreviationContinues(before, text.slice(at + m[0].length))) continue;
    const stop = at + end.length + markers.length;
    const sentence = text.slice(start, stop).trim();
    if (sentence !== '') out.push(sentence);
    start = stop;
  }
  const tail = text.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}

/** A sentence's body, the markers before its final punctuation, the punctuation and the markers after it. */
const PLACEMENT = new RegExp(String.raw`^([\s\S]*?)(${MARKERS})\s*(${END})?(${MARKERS})\s*$`);

/**
 * Where a sentence's case markers are: all at its end, immediately before or after its
 * final punctuation (`cited`); nowhere (`uncited`); or anywhere else, mid-sentence
 * (`misplaced`), whether or not it also ends with one.
 */
export function citationPlacement(sentence: string): 'cited' | 'uncited' | 'misplaced' {
  const m = PLACEMENT.exec(sentence);
  if (!m) return 'misplaced';
  if (MARKER.test(m[1] ?? '')) return 'misplaced';
  return (m[2] ?? '') + (m[4] ?? '') === '' ? 'uncited' : 'cited';
}
