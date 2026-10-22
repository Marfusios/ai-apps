/**
 * Sentence splitting for generated summaries, shared by the validator (every sentence
 * must cite a case) and the check input (one claim per sentence). A sentence ends at
 * `.`, `!` or `?` followed by whitespace, after any `[[case:…]]` markers that follow the
 * punctuation. It does not end after a common abbreviation ("Mr.", "U.S.", "e.g.",
 * "approx.", "No. 2") or an initial: splitting there would cut a statement in two, and
 * merging two sentences only makes a claim longer, never unchecked.
 */

/** Lower-case abbreviations (without their final period) a sentence does not end after. */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'st',
  'jr',
  'sr',
  'no',
  'nos',
  'vs',
  'etc',
  'approx',
  'appr',
  'inc',
  'co',
  'corp',
  'ltd',
  'lt',
  'capt',
  'sgt',
  'col',
  'gen',
  'cmdr',
  'ft',
  'lb',
  'lbs',
  'hr',
  'hrs',
  'min',
  'sec',
  'mi',
  'nm',
  'kt',
  'kts',
  'fig',
  'ref',
  'vol',
  'est',
  'max',
  'avg',
]);

/** "U.S", "e.g", "i.e", "a.m": letters separated by periods; or a single letter (an initial). */
const DOTTED = /^(?:[A-Za-z]\.)+[A-Za-z]$|^[A-Za-z]$/;

const BOUNDARY = /([.!?])((?:\s*\[\[case:[A-Za-z0-9]+\]\])*)(\s+)(?=\S)/g;

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
    if (m[1] === '.' && endsWithAbbreviation(text.slice(start, at))) continue;
    const end = at + m[1]!.length + (m[2] ?? '').length;
    const sentence = text.slice(start, end).trim();
    if (sentence !== '') out.push(sentence);
    start = end + (m[3] ?? '').length;
  }
  const tail = text.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}
