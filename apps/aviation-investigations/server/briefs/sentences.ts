/**
 * Sentence splitting for generated summaries, shared by the validator (every sentence
 * must cite a case) and the check input (one claim per sentence). A sentence ends at
 * `.`, `!` or `?` followed by whitespace, after any `[[case:…]]` markers that follow the
 * punctuation. **Case markers after the punctuation always end the sentence**, whatever
 * word comes before ("…in the U.S. [[case:…]] Next sentence."), so an uncited sentence
 * can never hide behind a cited one. Without markers, a sentence does not end after a
 * title ("Mr.", "Capt."), "approx." or "vs.", a dotted abbreviation ("U.S.", "e.g.") or an
 * initial, nor after "No.", "Fig.", "Ref." or "Vol." before a number ("No. 2"): splitting
 * there would cut a statement in two. Words that often end a sentence ("no", "min",
 * "max", "est", "hr", units, "etc.") are not treated as abbreviations: splitting after
 * one can only add a sentence that must cite a case, while merging could hide one.
 */

/** Lower-case abbreviations (without their final period) a sentence never ends after: titles, and qualifiers before a value. */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'capt', 'lt', 'sgt', 'col', 'gen', 'cmdr', 'approx', 'appr', 'vs']);

/** Abbreviations only before a number ("No. 2", "Fig. 3"); a sentence can end after the word itself ("The answer was no."). */
const BEFORE_NUMBER = new Set(['no', 'nos', 'fig', 'ref', 'vol']);

/** "U.S", "e.g", "i.e", "a.m": letters separated by periods; or a single letter (an initial). */
const DOTTED = /^(?:[A-Za-z]\.)+[A-Za-z]$|^[A-Za-z]$/;

const BOUNDARY = /([.!?])((?:\s*\[\[case:[A-Za-z0-9]+\]\])*)(\s+)(?=\S)/g;

function endsWithAbbreviation(before: string, next: string): boolean {
  const word = /([A-Za-z.]+)$/.exec(before)?.[1] ?? '';
  if (word === '') return false;
  const lower = word.toLowerCase();
  return ABBREVIATIONS.has(lower) || DOTTED.test(word) || (BEFORE_NUMBER.has(lower) && /^\d/.test(next));
}

/** The sentences of `text`, trimmed, markers kept with the sentence they follow. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const at = m.index ?? 0;
    const markers = m[2] ?? '';
    // Markers after the punctuation always end the sentence.
    if (m[1] === '.' && markers === '' && endsWithAbbreviation(text.slice(start, at), text.slice(at + m[0].length))) continue;
    const end = at + m[1]!.length + markers.length;
    const sentence = text.slice(start, end).trim();
    if (sentence !== '') out.push(sentence);
    start = end + (m[3] ?? '').length;
  }
  const tail = text.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}
