/**
 * Sentence splitting for generated summaries, shared by the validator (every sentence
 * must cite a case) and the check input (one claim per sentence). A sentence ends at
 * `.`, `!` or `?` followed by whitespace, after any `[[case:…]]` markers that follow the
 * punctuation:
 *
 * - **Case markers after the punctuation always end the sentence and stay with it**,
 *   whatever word comes before ("…in the U.S. [[case:…]] Next sentence.", "…at 1430
 *   hrs. [[case:…]] Next…"), so an uncited sentence can never hide behind a cited one.
 *   So does a period right after markers ("…after the overhaul [[case:…]]. 3 more…").
 * - Otherwise, a period followed by a lower-case letter or a digit ends nothing:
 *   it is an abbreviation inside the sentence ("2 hrs. after", "approx. 5", "No. 2
 *   engine", "1,000 ft. above", "Acme Inc. overhauled"). NTSB text, and so the summaries
 *   quoting it, use such abbreviations often; cutting there would make an uncited
 *   fragment of a cited sentence.
 * - Before an upper-case letter, a period ends the sentence unless it closes a title
 *   ("Mr.", "Capt."), a place or company abbreviation that precedes a name ("St. Louis",
 *   "Mt. Hood", "Ft. Worth", "Acme Inc. Aviation"), "approx." or "vs.", a dotted
 *   abbreviation ("U.S.", "U.S.C.", "e.g.") or an initial.
 *
 * Words that often end a sentence ("no", "min", "hrs", units, "etc.") are not treated as
 * abbreviations before an upper-case letter: a sentence ending there without a marker is
 * an uncited sentence. Merging two sentences only makes one claim longer (the checker
 * judges it whole); it never leaves text unchecked.
 */

/** Lower-case abbreviations (without their final period) a sentence does not end after, before a capitalized word. */
const ABBREVIATIONS = new Set([
  // Titles.
  'mr',
  'mrs',
  'ms',
  'dr',
  'capt',
  'lt',
  'sgt',
  'col',
  'gen',
  'cmdr',
  // Before a place name: Saint, Mount, Fort.
  'st',
  'mt',
  'ft',
  // Company suffixes, often followed by the rest of a name.
  'inc',
  'co',
  'corp',
  'ltd',
  // Qualifiers before a value.
  'approx',
  'appr',
  'vs',
]);

/** "U.S", "U.S.C", "e.g", "i.e", "a.m": letters separated by periods; or a single letter (an initial). */
const DOTTED = /^(?:[A-Za-z]\.)+[A-Za-z]$|^[A-Za-z]$/;

/** A lower-case letter or a digit: what follows an abbreviation inside a sentence, never a new sentence's start. */
const CONTINUES = /^[\p{Ll}\p{Nd}]/u;

const BOUNDARY = /([.!?])((?:\s*\[\[case:[A-Za-z0-9]+\]\])*)(\s+)(?=\S)/g;

/** Text ending in a case marker: a period after it closes a cited sentence. */
const AFTER_MARKER = /\[\[case:[A-Za-z0-9]+\]\]\s*$/;

function endsWithAbbreviation(before: string): boolean {
  const word = /([A-Za-z.]+)$/.exec(before)?.[1] ?? '';
  if (word === '') return false;
  return ABBREVIATIONS.has(word.toLowerCase()) || DOTTED.test(word);
}

/** The sentences of `text`, trimmed, markers kept with the sentence they follow. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const at = m.index ?? 0;
    const markers = m[2] ?? '';
    // Markers on either side of the punctuation end the sentence; otherwise a period may close an abbreviation.
    const before = text.slice(start, at);
    if (m[1] === '.' && markers === '' && !AFTER_MARKER.test(before)) {
      const next = text.slice(at + m[0].length);
      if (CONTINUES.test(next) || endsWithAbbreviation(before)) continue;
    }
    const end = at + m[1]!.length + markers.length;
    const sentence = text.slice(start, end).trim();
    if (sentence !== '') out.push(sentence);
    start = end + (m[3] ?? '').length;
  }
  const tail = text.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}
