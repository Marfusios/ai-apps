/**
 * Section-aware chunking of NTSB narrative sections into passages (gate G4;
 * amendments A11 and A16).
 *
 * A section is chunked on its own; a passage never spans two sections. Offsets are
 * UTF-16 code-unit indices into the stored (canonical) section text, and
 * `text === section.text.slice(start, end)` holds for every passage. Passages are
 * trimmed: they start and end on non-whitespace. Token counts are exact
 * `cl100k_base` counts (`countTokens`).
 *
 * - **Whole sections.** A section of at most `maxTokens` (800) stays one passage. A
 *   probable cause stays whole up to that limit too (A11); it is never split at the
 *   600-ish target like the other sections.
 * - **Longer sections** are cut into sentences grouped in paragraphs (every line break
 *   ends a paragraph; NTSB narratives use single and double line breaks alike). Short
 *   heading lines ("HISTORY OF FLIGHT") stay with the paragraph after them. A heading
 *   glued to its text ("AIRCRAFT INFORMATIONThe airplane", common after HTML
 *   conversion; `GLUED_HEADING_PATTERN`) starts a new unit there and counts as a
 *   paragraph start, so a cut can fall just before it; the text is not changed. The
 *   sentences are packed into passages of about the same size: with `k` passages
 *   needed at `targetTokens`, each aims at the even share of the section, within
 *   `minTokens`..`maxTokens`, preferring a paragraph end near that size over a
 *   sentence end, never ending on a heading, and never leaving a tail below
 *   `minTokens`. Each passage after the first repeats the end of the previous one:
 *   the longest run of whole trailing sentences within `overlapTokens` (80), or, when
 *   the last sentence alone is longer, its tail from a clause or word boundary.
 * - **Oversized units (A16).** A sentence over `maxTokens`, or a probable cause over
 *   `maxTokens`, is split at the clause boundary (`,` `;` `:` `)` or a spaced dash)
 *   nearest below an even share of the unit, else at the nearest whitespace; only text
 *   without any whitespace is cut between characters. The passages that continue a
 *   split unit are marked `continuation`, with `part`/`parts` numbering. Nothing is
 *   truncated: the passages always cover the whole trimmed section.
 *
 * Deterministic: the same text and options always give the same passages. Changing
 * the algorithm or `DEFAULT_CHUNK_OPTIONS` needs a new `CHUNKER_VERSION`, which is
 * part of every passage id.
 */
import type { SectionKind } from '../../server/db/queries/case-records.js';
import { GLUED_HEADING_PATTERN } from './analysis.js';
import { countTokens } from './tokens.js';
import { narrativeParagraphs as paragraphs, isNarrativeHeading as isHeading } from '../../shared/narrative-paragraphs.js';

export const CHUNKER_VERSION = 'chunk-v2';

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
  overlapTokens: number;
}

/** The options `CHUNKER_VERSION` stands for. */
export const DEFAULT_CHUNK_OPTIONS: Readonly<ChunkOptions> = Object.freeze({
  targetTokens: 650,
  maxTokens: 800,
  minTokens: 200,
  overlapTokens: 80,
});

export interface SectionText {
  sectionId: string;
  revisionId: string;
  kind: SectionKind;
  /** The stored canonical section text. */
  text: string;
}

export interface PassageDraft {
  sectionId: string;
  revisionId: string;
  kind: SectionKind;
  /** UTF-16 code-unit offsets into the section text. */
  start: number;
  end: number;
  /** `section.text.slice(start, end)`. */
  text: string;
  /** Exact `cl100k_base` tokens of `text`. */
  tokens: number;
  /** 1-based position in the section, and the section's passage count. */
  part: number;
  parts: number;
  /** Continues an oversized unit split under A16 (a probable cause, or a sentence over `maxTokens`). */
  continuation: boolean;
  /** Tokens of the text repeated from the previous passage (0 for the first). */
  overlapTokens: number;
}

export interface ChunkStats {
  /** The section is one passage. */
  whole: boolean;
  /** A probable cause over `maxTokens`, split under A16. */
  oversizedProbableCause: boolean;
  /** Sentences over `maxTokens`, split under A16. */
  longSentences: number;
  /** Cuts between characters (text without whitespace); expected to be zero. */
  forcedCharSplits: number;
}

export interface ChunkResult {
  passages: PassageDraft[];
  stats: ChunkStats;
}

// ---------------------------------------------------------------------------
// Segmentation

/** A sentence, a piece of an oversized sentence, or a heading line; trimmed. */
interface Atom {
  start: number;
  end: number;
  tokens: number;
  /** First atom of its paragraph. */
  paraStart: boolean;
  /** A heading line (a whole short paragraph without final punctuation). */
  heading: boolean;
  /** 0: a whole sentence; 1..n: the n-th piece of a sentence split under A16. */
  piece: number;
}

const WS = /\s/u;
const isWs = (ch: string | undefined): boolean => ch !== undefined && WS.test(ch);

/** Sentence-final punctuation with any closing quotes or brackets. */
const TERMINAL = /[.!?…]+["'’”)\]]*/gu;
/** A sentence starts with a capital, a digit or an opening quote or bracket. */
const SENTENCE_START = /^[\p{Lu}\p{N}"'‘“([]/u;
const WORD_BEFORE = /([\p{L}\p{N}][\p{L}\p{N}.]*)$/u;
/**
 * Abbreviations a period does not end a sentence after (when a capital or a digit
 * follows). Lower-cased; "No." only before a digit, "Ft." (Fort) only capitalized.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'mt', 'jr', 'sr', 'lt', 'capt', 'cpt', 'sgt', 'gen', 'col', 'maj',
  'cmdr', 'cdr', 'adm', 'gov', 'sen', 'rep', 'vs', 'approx', 'fig', 'figs', 'ref', 'vol', 'para',
  'jan', 'feb', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'u.s', 'u.k', 'e.g', 'i.e',
]);

function isAbbreviation(text: string, paraStart: number, at: number, terminal: string, next: string): boolean {
  if (terminal !== '.') return false;
  const word = WORD_BEFORE.exec(text.slice(Math.max(paraStart, at - 40), at))?.[1] ?? '';
  if (word === '') return false;
  if (/^\p{Lu}$/u.test(word)) return true; // an initial: "J. Smith"
  if (word === 'Ft') return true;
  const lower = word.toLowerCase();
  if (lower === 'no' || lower === 'nos') return /^\p{N}/u.test(next);
  return ABBREVIATIONS.has(lower);
}

/** Sentences of one paragraph `[ps, pe)` (trimmed, non-empty), as `[start, end)` pairs. */
function sentences(text: string, ps: number, pe: number): [number, number][] {
  const out: [number, number][] = [];
  let s = ps;
  TERMINAL.lastIndex = ps;
  for (let m = TERMINAL.exec(text); m !== null && m.index < pe; m = TERMINAL.exec(text)) {
    const end = m.index + m[0].length;
    if (end >= pe) break;
    if (!isWs(text[end])) continue;
    let k = end;
    while (k < pe && isWs(text[k])) k += 1;
    if (k >= pe) break;
    const next = text.slice(k, k + 2);
    if (!SENTENCE_START.test(next) || isAbbreviation(text, ps, m.index, m[0], next)) continue;
    out.push([s, end]);
    s = k;
    TERMINAL.lastIndex = k;
  }
  out.push([s, pe]);
  return out;
}

/** Sentences of one paragraph of text, as strings (exposed for tests). */
export function splitSentences(paragraph: string): string[] {
  return sentences(paragraph, 0, paragraph.length).map(([a, b]) => paragraph.slice(a, b));
}

// ---------------------------------------------------------------------------
// Oversized units (A16)

interface Cut {
  /** End of the piece (exclusive; after non-whitespace). */
  end: number;
  /** Start of the rest (first non-whitespace after the cut). */
  next: number;
}

/** Whitespace boundaries inside `[s, e)`: a non-whitespace char followed by whitespace. */
function wordBoundaries(text: string, s: number, e: number): Cut[] {
  const out: Cut[] = [];
  for (let i = s + 1; i < e; i += 1) {
    if (isWs(text[i]) && !isWs(text[i - 1])) {
      let k = i;
      while (k < e && isWs(text[k])) k += 1;
      if (k < e) out.push({ end: i, next: k });
    }
  }
  return out;
}

const CLAUSE_END = /[,;:)\]]$/u;
const DASH = /^[-–—]$/u;

/** A word boundary that ends a clause: after `, ; : )`, or before a spaced dash. */
function isClauseBoundary(text: string, cut: Cut): boolean {
  if (CLAUSE_END.test(text.slice(cut.end - 1, cut.end))) return true;
  return DASH.test(text[cut.next] ?? '') && isWs(text[cut.next + 1]);
}

/** Largest index `i` in `[lo, hi]` with `ok(i)` (monotone: true then false), or `lo - 1`. */
function lastTrue(lo: number, hi: number, ok: (i: number) => boolean): number {
  let a = lo;
  let b = hi;
  let found = lo - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (ok(mid)) {
      found = mid;
      a = mid + 1;
    } else {
      b = mid - 1;
    }
  }
  return found;
}

/** Code-point boundaries strictly inside `[s, e)`. */
function charBoundaries(text: string, s: number, e: number): number[] {
  const out: number[] = [];
  for (let i = s; i < e; ) {
    const cp = text.codePointAt(i) ?? 0;
    i += cp > 0xffff ? 2 : 1;
    if (i < e) out.push(i);
  }
  return out;
}

/** Where to end a piece starting at `s` of at most `goal` tokens (null: no cut needed or possible). */
function findCut(text: string, s: number, e: number, goal: number, stats: ChunkStats): Cut | null {
  const words = wordBoundaries(text, s, e);
  const w = lastTrue(0, words.length - 1, (i) => countTokens(text.slice(s, (words[i] as Cut).end)) <= goal);
  if (w >= 0) {
    const ideal = words[w] as Cut;
    const floor = s + (ideal.end - s) / 2;
    for (let i = w; i >= 0 && (words[i] as Cut).end >= floor; i -= 1) {
      if (isClauseBoundary(text, words[i] as Cut)) return words[i] as Cut;
    }
    return ideal;
  }
  // No word boundary fits the goal: cut between characters (never inside a surrogate pair).
  const chars = charBoundaries(text, s, e);
  if (chars.length === 0) return null;
  const c = Math.max(0, lastTrue(0, chars.length - 1, (i) => countTokens(text.slice(s, chars[i] as number)) <= goal));
  stats.forcedCharSplits += 1;
  const at = chars[c] as number;
  let next = at;
  while (next < e && isWs(text[next])) next += 1;
  let end = at;
  while (end > s && isWs(text[end - 1])) end -= 1;
  return { end, next };
}

/** Split `[s, e)` (over `maxTokens`) into pieces of at most `maxTokens`, near-even in size. */
function splitUnit(text: string, s: number, e: number, total: number, o: ChunkOptions, stats: ChunkStats): [number, number, number][] {
  const out: [number, number, number][] = [];
  let p = s;
  let rest = total;
  while (rest > o.maxTokens) {
    const k = Math.ceil(rest / o.targetTokens);
    const goal = Math.ceil(rest / k);
    const cut = findCut(text, p, e, goal, stats);
    if (cut === null || cut.end <= p || cut.next >= e) break;
    out.push([p, cut.end, countTokens(text.slice(p, cut.end))]);
    p = cut.next;
    rest = countTokens(text.slice(p, e));
  }
  out.push([p, e, rest]);
  return out;
}

const GLUED = new RegExp(GLUED_HEADING_PATTERN, 'gu');
/** A word of capitals (and `&`, `/`, `'`, `(`, `)`, `-`), no digits or lower case. */
const CAPS_WORD = /^[A-Z&/'()-]*[A-Z][A-Z&/'()-]*$/u;
const GLUED_HEADING_MAX_WORDS = 8;
const GLUED_HEADING_MAX_CHARS = 80;

/** Starts of the headings glued to the text after them inside `[s, e)` (the first word of each capitals run). */
export function gluedHeadingStarts(text: string, s: number, e: number): number[] {
  const out: number[] = [];
  GLUED.lastIndex = s;
  for (let m = GLUED.exec(text); m !== null && m.index < e; m = GLUED.exec(text)) {
    const at = m.index;
    GLUED.lastIndex = at + 1;
    let start = at;
    while (start > s && !isWs(text[start - 1])) start -= 1;
    if (!CAPS_WORD.test(text.slice(start, at))) continue;
    for (let words = 1; words < GLUED_HEADING_MAX_WORDS; words += 1) {
      let j = start;
      while (j > s && text[j - 1] === ' ') j -= 1;
      if (j === start || j <= s) break;
      let k = j;
      while (k > s && !isWs(text[k - 1])) k -= 1;
      if (!CAPS_WORD.test(text.slice(k, j))) break;
      start = k;
    }
    if (at - start <= GLUED_HEADING_MAX_CHARS) out.push(start);
  }
  return out;
}

/** Sentences of `[ps, pe)` also split where a glued heading starts; true marks such a start. */
function units(text: string, ps: number, pe: number): [number, number, boolean][] {
  const headings = new Set(gluedHeadingStarts(text, ps, pe));
  const out: [number, number, boolean][] = [];
  for (const [ss, se] of sentences(text, ps, pe)) {
    let a = ss;
    for (const h of [...headings].filter((x) => x > ss && x < se).sort((x, y) => x - y)) {
      let end = h;
      while (end > a && isWs(text[end - 1])) end -= 1;
      if (end > a) out.push([a, end, headings.has(a)]);
      a = h;
    }
    out.push([a, se, headings.has(a)]);
  }
  return out;
}

/** Atoms of `[from, to)`: paragraphs, then sentences, oversized sentences split. */
function atomize(text: string, from: number, to: number, o: ChunkOptions, stats: ChunkStats): Atom[] {
  const atoms: Atom[] = [];
  for (const [ps, pe] of paragraphs(text, from, to)) {
    const heading = isHeading(text.slice(ps, pe));
    let first = true;
    for (const [ss, se, glued] of heading ? ([[ps, pe, false]] as [number, number, boolean][]) : units(text, ps, pe)) {
      // A glued heading starts a section of the original document: a soft paragraph start.
      if (glued) first = true;
      const tokens = countTokens(text.slice(ss, se));
      if (tokens <= o.maxTokens) {
        atoms.push({ start: ss, end: se, tokens, paraStart: first, heading, piece: 0 });
      } else {
        stats.longSentences += 1;
        splitUnit(text, ss, se, tokens, o, stats).forEach(([a, b, t], i) => {
          atoms.push({ start: a, end: b, tokens: t, paraStart: first && i === 0, heading: false, piece: i + 1 });
        });
      }
      first = false;
    }
  }
  return atoms;
}

// ---------------------------------------------------------------------------
// Packing

interface Packed {
  start: number;
  end: number;
  tokens: number;
  overlapTokens: number;
  /** Index of the first atom the passage adds (after any overlap). */
  firstAtom: number;
}

/** Overlap kept short of the next atom by this many tokens, and dropped below `MIN_OVERLAP`. */
const OVERLAP_SLACK = 4;
const MIN_OVERLAP = 8;

/** Start of the overlap repeated after a passage `[start, atoms[last].end)`. */
function chooseOverlap(
  text: string,
  atoms: readonly Atom[],
  start: number,
  last: number,
  o: ChunkOptions,
): { start: number; tokens: number } | null {
  const next = atoms[last + 1];
  if (!next) return null;
  const budget = Math.min(o.overlapTokens, o.maxTokens - next.tokens - OVERLAP_SLACK);
  if (budget < MIN_OVERLAP) return null;
  const end = (atoms[last] as Atom).end;
  const fits = (s: number) => countTokens(text.slice(s, end));

  // Whole trailing sentences: the earliest atom start that keeps the overlap within budget.
  let best: { start: number; tokens: number } | null = null;
  for (let j = last; j >= 0; j -= 1) {
    const a = atoms[j] as Atom;
    if (a.start <= start) break;
    const t = fits(a.start);
    if (t > budget) break;
    best = { start: a.start, tokens: t };
  }
  if (best) return best;

  // The last sentence alone is longer: its tail from a clause, else a word, boundary.
  const tail = atoms[last] as Atom;
  const from = Math.max(tail.start, start);
  const words = wordBoundaries(text, from, end).filter((c) => c.next > start && c.next < end);
  for (const candidates of [words.filter((c) => isClauseBoundary(text, c)), words]) {
    // Overlap shrinks as the start moves right: find the first candidate that fits.
    const i = lastTrue(0, candidates.length - 1, (x) => fits((candidates[x] as Cut).next) > budget) + 1;
    const c = candidates[i];
    if (c) return { start: c.next, tokens: fits(c.next) };
  }
  return null;
}

function boundaryPenalty(atoms: readonly Atom[], j: number, o: ChunkOptions): number {
  const next = atoms[j + 1] as Atom;
  if ((atoms[j] as Atom).heading) return 10 * o.maxTokens;
  if (next.piece > 1) return 0.2 * o.targetTokens;
  if (next.paraStart) return -0.2 * o.targetTokens;
  return 0;
}

function pack(text: string, atoms: readonly Atom[], o: ChunkOptions, sectionId: string): Packed[] {
  const n = atoms.length;
  // Approximate sizes from atom counts (+1 token for a line break between atoms);
  // every passage is counted exactly before it is accepted.
  const gap = atoms.map((a, i) => (i + 1 < n && /[\r\n]/u.test(text.slice(a.end, (atoms[i + 1] as Atom).start)) ? 1 : 0));
  const cum: number[] = [0];
  atoms.forEach((a, i) => cum.push((cum[i] as number) + a.tokens + (gap[i] as number)));
  const span = (i: number, j: number) => (cum[j + 1] as number) - (cum[i] as number) - (gap[j] as number);

  const out: Packed[] = [];
  let i = 0;
  let overlap: { start: number; tokens: number } | null = null;
  while (i < n) {
    const ov = overlap?.tokens ?? 0;
    const start = overlap?.start ?? (atoms[i] as Atom).start;
    const rest = span(i, n - 1);
    if (ov + rest <= o.maxTokens) {
      const tokens = countTokens(text.slice(start, (atoms[n - 1] as Atom).end));
      if (tokens <= o.maxTokens) {
        out.push({ start, end: (atoms[n - 1] as Atom).end, tokens, overlapTokens: ov, firstAtom: i });
        break;
      }
    }
    // Aim at an even share of what is left, so the passages come out alike in size.
    const k = Math.max(2, Math.ceil((ov + rest - o.overlapTokens) / (o.targetTokens - o.overlapTokens)));
    const goal = (ov + rest + (k - 1) * o.overlapTokens) / k;
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let j = i; j < n - 1; j += 1) {
      const size = ov + span(i, j);
      if (size > o.maxTokens) break;
      if (size < o.minTokens || span(j + 1, n - 1) + o.overlapTokens < o.minTokens) continue;
      const cost = Math.abs(size - goal) + boundaryPenalty(atoms, j, o);
      if (cost < bestCost) {
        best = j;
        bestCost = cost;
      }
    }
    if (best < 0) {
      best = i;
      for (let j = i + 1; j < n - 1 && ov + span(i, j) <= o.maxTokens; j += 1) best = j;
    }
    let s = start;
    let tokens = countTokens(text.slice(s, (atoms[best] as Atom).end));
    while (tokens > o.maxTokens && best > i) {
      best -= 1;
      tokens = countTokens(text.slice(s, (atoms[best] as Atom).end));
    }
    let ovTokens = ov;
    if (tokens > o.maxTokens && s !== (atoms[i] as Atom).start) {
      s = (atoms[i] as Atom).start;
      ovTokens = 0;
      tokens = countTokens(text.slice(s, (atoms[best] as Atom).end));
    }
    if (tokens > o.maxTokens) {
      // Atoms are at most maxTokens by construction; refuse rather than truncate.
      throw new Error(`${sectionId}: cannot fit [${s}, ${(atoms[best] as Atom).end}) in ${o.maxTokens} tokens (${tokens})`);
    }
    out.push({ start: s, end: (atoms[best] as Atom).end, tokens, overlapTokens: ovTokens, firstAtom: i });
    overlap = chooseOverlap(text, atoms, s, best, o);
    i = best + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API

function checkOptions(o: ChunkOptions): void {
  const ok =
    Number.isInteger(o.minTokens) &&
    Number.isInteger(o.targetTokens) &&
    Number.isInteger(o.maxTokens) &&
    Number.isInteger(o.overlapTokens) &&
    o.overlapTokens >= 0 &&
    o.minTokens > 0 &&
    o.overlapTokens < o.minTokens &&
    o.minTokens <= o.targetTokens &&
    o.targetTokens <= o.maxTokens;
  if (!ok) throw new Error(`invalid chunk options: ${JSON.stringify(o)}`);
}

/** Chunk one section; see the module comment. Also returns what A16 changed. */
export function chunkSectionDetailed(section: SectionText, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): ChunkResult {
  checkOptions(opts);
  const { text } = section;
  const stats: ChunkStats = { whole: false, oversizedProbableCause: false, longSentences: 0, forcedCharSplits: 0 };
  let from = 0;
  let to = text.length;
  while (from < to && isWs(text[from])) from += 1;
  while (to > from && isWs(text[to - 1])) to -= 1;
  if (from === to) return { passages: [], stats };

  const draft = (start: number, end: number, tokens: number, part: number, parts: number, continuation: boolean, overlapTokens: number): PassageDraft => ({
    sectionId: section.sectionId,
    revisionId: section.revisionId,
    kind: section.kind,
    start,
    end,
    text: text.slice(start, end),
    tokens,
    part,
    parts,
    continuation,
    overlapTokens,
  });

  const total = countTokens(text.slice(from, to));
  if (total <= opts.maxTokens) {
    stats.whole = true;
    return { passages: [draft(from, to, total, 1, 1, false, 0)], stats };
  }
  const probableCause = section.kind === 'probable_cause';
  stats.oversizedProbableCause = probableCause;
  const atoms = atomize(text, from, to, opts, stats);
  const packed = pack(text, atoms, opts, section.sectionId);
  return {
    passages: packed.map((p, i) =>
      draft(
        p.start,
        p.end,
        p.tokens,
        i + 1,
        packed.length,
        probableCause ? i > 0 : (atoms[p.firstAtom] as Atom).piece > 1,
        p.overlapTokens,
      ),
    ),
    stats,
  };
}

/** Passages of one section: `text === section.text.slice(start, end)` for each. */
export function chunkSection(section: SectionText, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): PassageDraft[] {
  return chunkSectionDetailed(section, opts).passages;
}
