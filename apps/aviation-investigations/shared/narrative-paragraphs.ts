/** Canonical NTSB paragraph boundaries, shared with chunk-v2; text is never rewritten. */
export const NARRATIVE_PARAGRAPHS_VERSION = 'ntsb-paragraphs.v1';
const isWs = (ch: string | undefined): boolean => ch !== undefined && /\s/u.test(ch);

/** A line that ends a sentence or introduces what follows. */
const ENDS_LINE = /[.!?:;…]["'’”)\]]*$/u;
const STARTS_LOWER = /^\p{Ll}/u;

/**
 * Paragraphs of `[from, to)`, trimmed, as `[start, end)` pairs: non-empty lines,
 * except that a single line break inside a sentence (the line ends without
 * punctuation and the next starts in lower case: hard-wrapped text) joins the lines.
 */
export function narrativeParagraphs(text: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  const lines = /[^\r\n]+/gu;
  lines.lastIndex = from;
  for (let m = lines.exec(text); m !== null && m.index < to; m = lines.exec(text)) {
    let s = m.index;
    let e = Math.min(m.index + m[0].length, to);
    while (s < e && isWs(text[s])) s += 1;
    while (e > s && isWs(text[e - 1])) e -= 1;
    if (e <= s) continue;
    const prev = out[out.length - 1];
    if (prev) {
      const breaks = text.slice(prev[1], s).match(/\r\n|\r|\n/gu)?.length ?? 0;
      if (breaks === 1 && !ENDS_LINE.test(text.slice(prev[0], prev[1])) && STARTS_LOWER.test(text.slice(s, s + 2))) {
        prev[1] = e;
        continue;
      }
    }
    out.push([s, e]);
  }
  return out;
}

const HEADING_MAX_CHARS = 80;
const HEADING_MAX_WORDS = 10;
const ENDS_SENTENCE = /[.!?…]["'’”)\]]*$/u;

export function isNarrativeHeading(line: string): boolean {
  return (
    line.length <= HEADING_MAX_CHARS &&
    line.split(/\s+/u).length <= HEADING_MAX_WORDS &&
    !ENDS_SENTENCE.test(line) &&
    /\p{L}/u.test(line)
  );
}

/** Headings remain attached to the following paragraph, as the chunker's cut policy requires. */
export function wholeNarrativeParagraphs(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let heading = false;
  for (const [start, end] of narrativeParagraphs(text, 0, text.length)) {
    if (heading) out[out.length - 1]!.end = end;
    else out.push({ start, end });
    heading = isNarrativeHeading(text.slice(start, end));
  }
  return out;
}
