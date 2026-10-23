/**
 * Sentence splitting and citation checks for generated summaries, shared by the validator
 * (every sentence must end with the markers of the cases it is about) and the check input
 * (one claim per sentence).
 *
 * **Fail closed.** Splitting too often can only withhold a summary: a fragment without its
 * own marker fails `uncited_summary`. Merging two sentences would let an uncited one
 * borrow the other's citation, past the deterministic citation check. So anything unusual
 * withholds:
 *
 * 1. `summaryFormatProblem`: a summary is plain text on one line, written with an
 *    **allow-list** of characters (`summaryCharAllowed`): printable ASCII except Markdown
 *    and decoration, a short typographic set and Latin-1 letters with diacritics. Every
 *    other code point fails it (`summary_format`): every control, line break, invisible or
 *    format character, every space but U+0020, every sentence terminator but `.`, `!` and
 *    `?`, and every lookalike or symbol not listed (a Tibetan shad, a two-dot leader, a
 *    Lisu letter that renders as a period, a return symbol, a middle dot). HTML entities
 *    fail it too. What it guarantees: the only characters left that can end a sentence
 *    are `.`, `!` and `?`, and the only space is U+0020, so every sentence boundary is
 *    one the splitter sees.
 * 2. `splitSentences`: a sentence ends at a run of `.`, `!` or `?` ("..." and "?!" are
 *    one end), with any closing quotation marks or parenthesis after it (`"`, `'`, `”`,
 *    `’`, `)`), followed by whitespace or the end of the text, and after any `[[case:…]]`
 *    markers that follow the punctuation; markers after the last sentence's punctuation
 *    stay with it. A period does not end a sentence only in a declared context
 *    (`DECLARED`): a recognised abbreviation as a whole word, followed by whitespace and a
 *    token that cannot start a new sentence there ("No. 2", "approx. 5", "Mr. Smith",
 *    "U.S. operator", "49 U.S.C. 1154", "e.g. a school"). Nothing else: a unit
 *    ("1,000 ft."), a time ("1430 hrs."), "St.", "Inc.", "a.m.", an initial, or a period
 *    before a lower-case word or a number ends the sentence there.
 * 3. `citationPlacement`: a sentence's markers must all be at its end, immediately before
 *    or after its final punctuation (`misplaced_citation` otherwise).
 * 4. `ambiguousBoundary`: no `.`, `!` or `?` may remain inside a sentence (its final
 *    punctuation aside) except a declared context or a decimal point between digits
 *    ("5.1"), so a terminator glued to whatever follows it (".3 people", ".Three", ".*",
 *    ".¹", ".—", ".,") withholds (`ambiguous_boundary`).
 *
 * The declared contexts are the accepted residual: a sentence that really ends with one
 * of them ("Was anyone hurt? No. 3 passengers were injured") merges with the next one,
 * and the checker then judges the merged claim whole (DESIGN §5, SECURITY_REVIEW).
 *
 * Every function here runs in time linear in the text (times the bounded number of
 * markers), whatever its runs of whitespace or dots: a 1,500-character summary of any
 * shape validates in milliseconds (tests/unit/summary-corpus.test.ts).
 */

const MARKER = /\[\[case:[A-Za-z0-9]+\]\]/;
const MARKERS_G = /\[\[case:[A-Za-z0-9]+\]\]/g;
const EXACT_MARKER = /^\[\[case:[A-Za-z0-9]+\]\]$/;

const TERMINATORS = '.!?';
/** Closing quotation marks and parenthesis that belong to the sentence they follow. */
const CLOSERS = `"')”’`;

/** Printable ASCII used for Markdown and decoration, never in a plain summary (case markers are removed first). */
const DECORATION = new Set(['*', '_', '~', '|', '[', ']', '{', '}']);
/**
 * The typographic characters a summary may use beyond ASCII: English quotation marks
 * (`“ ” ‘ ’`; the closing ones belong to the sentence they end, `CLOSERS`), the en and em
 * dashes (`– —`, joining clauses), and measurement and number signs (`° ± × ½ ¼ ¾`) and
 * `§` (a statute reference, a declared context). None can end a sentence or hide a space.
 */
const TYPOGRAPHIC = new Set(['\u201C', '\u201D', '\u2018', '\u2019', '\u2013', '\u2014', '\u00B0', '\u00B1', '\u00D7', '\u00BD', '\u00BC', '\u00BE', '\u00A7']);

/**
 * The allow-list of a summary's characters (one code point): printable ASCII (U+0020 to
 * U+007E) except `DECORATION`; `TYPOGRAPHIC`; and Latin-1 letters with diacritics
 * (U+00C0 to U+00FF except `×` and `÷`) for place and person names ("Cañon City",
 * "Española"). Nothing else: no other space, control, format or invisible character, no
 * other terminator, symbol, lookalike or script.
 */
export function summaryCharAllowed(c: string): boolean {
  const cp = c.codePointAt(0)!;
  if (c.length !== (cp > 0xffff ? 2 : 1)) return false;
  if (cp >= 0x20 && cp <= 0x7e) return !DECORATION.has(c);
  if (TYPOGRAPHIC.has(c)) return true;
  return cp >= 0xc0 && cp <= 0xff && cp !== 0xd7 && cp !== 0xf7;
}

const HTML_ENTITY = /&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);/;

/**
 * True when the summary is not plain one-line text: a character outside the allow-list
 * (`summaryCharAllowed`), or an HTML entity. Leading and trailing whitespace and case
 * markers aside.
 */
export function summaryFormatProblem(summary: string): boolean {
  const text = summary.replace(MARKERS_G, ' ').trim();
  for (const c of text) if (!summaryCharAllowed(c)) return true;
  return HTML_ENTITY.test(text);
}

/**
 * A candidate sentence end: the punctuation (matched once, from the start of its run, so a
 * long run of dots costs linear time), the markers after it, then whitespace or the end
 * of the text.
 */
const BOUNDARY = /(?<![.!?])(?=([.!?]+["')”’]*))\1((?:\s*\[\[case:[A-Za-z0-9]+\]\])*)(?:\s+(?=\S)|\s*$)/g;

/**
 * The only periods that are not sentence ends, each a recognised abbreviation as a whole
 * word (case-sensitive) followed by whitespace and a token that cannot start a new
 * sentence there. All the dots of a matched word are declared ("U.S.C.").
 */
const DECLARED: readonly RegExp[] = [
  // "the No. 2 engine", "cylinders Nos. 3 and 4".
  /(?<![\p{L}\p{N}.])Nos?\.(?=\s+[0-9])/gu,
  // "approx. 5 minutes", "ca. 1990".
  /(?<![\p{L}\p{N}.])(?:approx|Approx|ca)\.(?=\s+[0-9])/gu,
  // "Mr. Smith". ("Dr." is left out: it also abbreviates "Drive", which can end a sentence.)
  /(?<![\p{L}\p{N}.])(?:Mr|Mrs|Ms)\.(?=\s+\p{Lu}\p{Ll})/gu,
  // "the U.S. operator", "the U.S. Code".
  /(?<![\p{L}\p{N}.])U\.S\.(?=\s+(?:\p{Ll}|Code(?![\p{L}\p{N}])))/gu,
  // "49 U.S.C. 1154(b)", "U.S.C. § 1154".
  /(?<![\p{L}\p{N}.])U\.S\.C\.(?=\s+(?:[0-9]|§))/gu,
  // "e.g. a flight school", "i.e. the left magneto".
  /(?<![\p{L}\p{N}.])(?:e\.g|i\.e)\.(?=\s+\p{Ll})/gu,
];

/** The positions of every period of `text` that belongs to a declared context. */
function declaredPeriods(text: string): Set<number> {
  const out = new Set<number>();
  for (const re of DECLARED) {
    for (const m of text.matchAll(re)) {
      for (let i = 0; i < m[0].length; i += 1) if (m[0][i] === '.') out.add((m.index ?? 0) + i);
    }
  }
  return out;
}

/** The sentences of `text`, trimmed, markers kept with the sentence they end. */
export function splitSentences(text: string): string[] {
  const declared = declaredPeriods(text);
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const at = m.index ?? 0;
    const end = m[1]!;
    const markers = m[2] ?? '';
    // A declared context's period, followed only by whitespace, continues the sentence.
    if (end === '.' && markers === '' && declared.has(at)) continue;
    const stop = at + end.length + markers.length;
    const sentence = text.slice(start, stop).trim();
    if (sentence !== '') out.push(sentence);
    start = stop;
  }
  const tail = text.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}

/**
 * A sentence without what may end it, scanned from the end: the markers after its final
 * punctuation, the closers and the punctuation (a run of `.`, `!` and `?`), and the
 * markers before it. `cited`: at least one marker was there.
 */
function bodyOf(sentence: string): { body: string; cited: boolean } {
  let rest = sentence.trimEnd();
  let cited = false;
  const dropMarkers = () => {
    while (rest.endsWith(']]')) {
      const at = rest.lastIndexOf('[[case:');
      if (at < 0 || !EXACT_MARKER.test(rest.slice(at))) return;
      rest = rest.slice(0, at).trimEnd();
      cited = true;
    }
  };
  dropMarkers();
  let j = rest.length;
  while (j > 0 && CLOSERS.includes(rest[j - 1]!)) j -= 1;
  let k = j;
  while (k > 0 && TERMINATORS.includes(rest[k - 1]!)) k -= 1;
  // Closers without punctuation before them stay in the body.
  if (k < j) rest = rest.slice(0, k).trimEnd();
  dropMarkers();
  return { body: rest, cited };
}

/**
 * Where a sentence's case markers are: all at its end, immediately before or after its
 * final punctuation (`cited`; the last sentence of the text may have no punctuation);
 * nowhere (`uncited`); or anywhere else (`misplaced`): mid-sentence, whether or not the
 * sentence also ends with one, or after a "sentence" with no word in it ("…. [[case:…]].").
 */
export function citationPlacement(sentence: string): 'cited' | 'uncited' | 'misplaced' {
  const { body, cited } = bodyOf(sentence);
  if (MARKER.test(body) || (cited && !/[\p{L}\p{N}]/u.test(body))) return 'misplaced';
  return cited ? 'cited' : 'uncited';
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/**
 * True when a `.`, `!` or `?` remains inside the sentence, its final punctuation aside,
 * other than a declared context's period or a decimal point between two digits ("5.1"):
 * a boundary the splitter could not see.
 */
export function ambiguousBoundary(sentence: string): boolean {
  const { body } = bodyOf(sentence);
  const declared = declaredPeriods(body);
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (!TERMINATORS.includes(c)) continue;
    if (c === '.' && (declared.has(i) || (isDigit(body[i - 1]) && isDigit(body[i + 1])))) continue;
    return true;
  }
  return false;
}
