import { beforeAll, describe, expect, it } from 'vitest';
import type { CaseRecord } from '../../server/db/queries/case-records.js';
import {
  CHUNKER_VERSION,
  DEFAULT_CHUNK_OPTIONS,
  chunkSection,
  chunkSectionDetailed,
  gluedHeadingStarts,
  splitSentences,
  type PassageDraft,
  type SectionText,
} from '../../worker/index/chunk.js';
import { GLUED_HEADING_PATTERN, GLUED_HEADING_REPLACE } from '../../worker/index/analysis.js';
import { MAX_INPUT_TOKENS, buildCasePassages } from '../../worker/index/passages.js';
import { countTokens, encodeLength } from '../../worker/index/tokens.js';
import { fixtureCaseRecords } from '../support/case-records.js';

const { maxTokens, minTokens, overlapTokens } = DEFAULT_CHUNK_OPTIONS;

let records: Map<string, CaseRecord>;

beforeAll(async () => {
  records = await fixtureCaseRecords();
});

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = [
  'pilot', 'airplane', 'engine', 'runway', 'approach', 'reported', 'fuel', 'landing', 'wind', 'propeller',
  'examination', 'revealed', 'cylinder', 'altitude', 'control', 'witness', 'stated', 'about', 'feet', 'knots',
];

/** Paragraphs of sentences; `sep` between paragraphs, `space` between words, quotes around some words. */
function narrative(seed: number, paragraphs: number, opts: { sep?: string; space?: string; quotes?: [string, string] } = {}): string {
  const next = rng(seed);
  const pick = () => WORDS[Math.floor(next() * WORDS.length)] as string;
  const [open, close] = opts.quotes ?? ['"', '"'];
  const out: string[] = [];
  for (let p = 0; p < paragraphs; p += 1) {
    const sentences: string[] = [];
    const n = 3 + Math.floor(next() * 4);
    for (let s = 0; s < n; s += 1) {
      const words = Array.from({ length: 12 + Math.floor(next() * 18) }, pick);
      if (next() < 0.3) words[3] = `${open}${words[3]}${close}`;
      const sentence = words.join(opts.space ?? ' ');
      sentences.push(`${sentence[0]?.toUpperCase()}${sentence.slice(1)}.`);
    }
    out.push(sentences.join('  '));
  }
  return out.join(opts.sep ?? '\n\n');
}

const section = (text: string, kind: SectionText['kind'] = 'factual'): SectionText => ({
  sectionId: 'TEST01:factual/aircraft-1',
  revisionId: 'a'.repeat(64),
  kind,
  text,
});

function expectRoundTrip(s: SectionText, passages: readonly PassageDraft[]): void {
  for (const p of passages) {
    expect(p.text).toBe(s.text.slice(p.start, p.end));
    expect(p.tokens).toBe(countTokens(p.text));
    expect(p.text).toBe(p.text.trim());
  }
}

/** The passages cover the trimmed section with no gap: nothing is truncated. */
function expectCoverage(s: SectionText, passages: readonly PassageDraft[]): void {
  const trimmedStart = s.text.length - s.text.trimStart().length;
  const trimmedEnd = s.text.trimEnd().length;
  expect(passages[0]?.start).toBe(trimmedStart);
  expect(passages[passages.length - 1]?.end).toBe(trimmedEnd);
  for (let i = 1; i < passages.length; i += 1) {
    const prev = passages[i - 1] as PassageDraft;
    const cur = passages[i] as PassageDraft;
    expect(cur.start).toBeGreaterThan(prev.start);
    expect(cur.end).toBeGreaterThan(prev.end);
    // Overlapping, or adjacent with only whitespace between.
    expect(cur.start <= prev.end || s.text.slice(prev.end, cur.start).trim() === '').toBe(true);
  }
  passages.forEach((p, i) => {
    expect(p.part).toBe(i + 1);
    expect(p.parts).toBe(passages.length);
  });
}

function fixtureSections(): SectionText[] {
  return [...records.values()].flatMap((r) =>
    r.sections.map((s) => ({ sectionId: s.sectionId, revisionId: s.revisionId, kind: s.kind, text: s.text })),
  );
}

describe('countTokens', () => {
  it('equals full cl100k_base encoding on fixture text and edge cases', () => {
    const samples = [
      ...fixtureSections().map((s) => s.text),
      'CRLF\r\nline\r\n\r\nends',
      'non breaking space and “smart” ‘quotes’ — dashes…',
      'emoji ✈️ 🛩 and accents: café, Zürich',
      "contractions: it's, they're, we'll, I'd",
      '<|endoftext|> special-token text is plain text',
      '   leading and trailing spaces   ',
      '12345678901234567890 numbers 1.5 3,000',
      '',
    ];
    for (const t of samples) expect(countTokens(t)).toBe(encodeLength(t));
  });
});

describe('chunkSection', () => {
  it('pins the options CHUNKER_VERSION stands for', () => {
    // Changing them (or the algorithm) changes passage ids: bump CHUNKER_VERSION with them.
    expect({ version: CHUNKER_VERSION, ...DEFAULT_CHUNK_OPTIONS }).toEqual({
      version: 'chunk-v2',
      targetTokens: 650,
      maxTokens: 800,
      minTokens: 200,
      overlapTokens: 80,
    });
  });

  it('round-trips offsets on CRLF, NBSP and smart-quote text', () => {
    const variants = [
      narrative(1, 14, { sep: '\r\n\r\n' }),
      narrative(2, 14, { sep: '\r\n' }),
      narrative(3, 14, { space: ' ' }),
      narrative(4, 14, { quotes: ['“', '”'] }),
      narrative(5, 14, { quotes: ['‘', '’'], sep: '\r\n\r\n', space: '  ' }),
      `  \r\n${narrative(6, 12)}\r\n\r\n  `,
    ];
    for (const text of variants) {
      const s = section(text);
      const passages = chunkSection(s);
      expect(passages.length).toBeGreaterThan(1);
      expectRoundTrip(s, passages);
      expectCoverage(s, passages);
    }
  });

  it('round-trips offsets on every fixture section', () => {
    for (const s of fixtureSections()) {
      const passages = chunkSection(s);
      expect(passages.length).toBeGreaterThan(0);
      expectRoundTrip(s, passages);
      expectCoverage(s, passages);
    }
  });

  it('keeps sections of at most maxTokens whole, above the target too', () => {
    let text = narrative(7, 1);
    for (let seed = 8; ; seed += 1) {
      const longer = `${text}\n\n${narrative(seed, 1)}`;
      if (countTokens(longer) > maxTokens) break;
      text = longer;
    }
    expect(countTokens(text)).toBeGreaterThan(DEFAULT_CHUNK_OPTIONS.targetTokens);
    const { passages, stats } = chunkSectionDetailed(section(text));
    expect(passages).toHaveLength(1);
    expect(stats.whole).toBe(true);
    expect(passages[0]).toMatchObject({ start: 0, end: text.length, part: 1, parts: 1, continuation: false, overlapTokens: 0 });
  });

  it('never splits a probable cause of at most maxTokens', () => {
    for (const r of records.values()) {
      for (const s of r.sections.filter((x) => x.kind === 'probable_cause')) {
        const passages = chunkSection({ ...s, text: s.text });
        expect(passages).toHaveLength(1);
        expect(passages[0]?.text).toBe(s.text.trim());
      }
    }
    // Longer than the target, still whole.
    let cause = 'The pilot’s failure to maintain control.';
    while (countTokens(`${cause} ${narrative(cause.length, 1)}`) <= maxTokens) cause = `${cause} ${narrative(cause.length, 1)}`;
    expect(countTokens(cause)).toBeGreaterThan(DEFAULT_CHUNK_OPTIONS.targetTokens);
    expect(chunkSection(section(cause, 'probable_cause'))).toHaveLength(1);
  });

  it('splits a probable cause over maxTokens into marked continuation passages (A16)', () => {
    const cause = narrative(9, 10, { sep: ' ' });
    expect(countTokens(cause)).toBeGreaterThan(maxTokens);
    const s = section(cause, 'probable_cause');
    const { passages, stats } = chunkSectionDetailed(s);
    expect(stats.oversizedProbableCause).toBe(true);
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.map((p) => p.continuation)).toEqual(passages.map((_, i) => i > 0));
    expectRoundTrip(s, passages);
    expectCoverage(s, passages);
    for (const p of passages) expect(p.tokens).toBeLessThanOrEqual(maxTokens);
  });

  it('splits a sentence over maxTokens at clause boundaries and marks the continuation (A16)', () => {
    const next = rng(10);
    const clauses = Array.from({ length: 90 }, () =>
      Array.from({ length: 8 }, () => WORDS[Math.floor(next() * WORDS.length)] as string).join(' '),
    );
    const sentence = `The ${clauses.join(', ')}.`;
    expect(countTokens(sentence)).toBeGreaterThan(maxTokens);
    const text = `${narrative(11, 2)}\n\n${sentence}\n\n${narrative(12, 2)}`;
    const s = section(text);
    const { passages, stats } = chunkSectionDetailed(s);
    expect(stats.longSentences).toBe(1);
    expect(stats.forcedCharSplits).toBe(0);
    expectRoundTrip(s, passages);
    expectCoverage(s, passages);
    const at = text.indexOf(sentence);
    const inside = passages.filter((p) => p.end > at && p.end < at + sentence.length - 1);
    expect(inside.length).toBeGreaterThan(0);
    for (const p of inside) expect(p.text.endsWith(',')).toBe(true);
    const continuing = passages.filter((p) => p.continuation);
    expect(continuing.length).toBeGreaterThan(0);
    for (const p of continuing) expect(p.start).toBeGreaterThan(at);
  });

  it('cuts text without whitespace between characters rather than truncating it', () => {
    const blob = 'ab1'.repeat(1500);
    const s = section(`Intro sentence.\n\n${blob}`);
    const { passages, stats } = chunkSectionDetailed(s);
    expect(stats.forcedCharSplits).toBeGreaterThan(0);
    expectRoundTrip(s, passages);
    expectCoverage(s, passages);
    for (const p of passages) expect(p.tokens).toBeLessThanOrEqual(maxTokens);
  });

  it('keeps every passage within maxTokens and every embedding input within 8,192 tokens', () => {
    const big = [narrative(13, 40), narrative(14, 25, { sep: '\n' }), narrative(15, 60, { sep: '\r\n\r\n' })];
    for (const text of big) for (const p of chunkSection(section(text))) expect(p.tokens).toBeLessThanOrEqual(maxTokens);
    for (const r of records.values()) {
      if (!r.answerEligible) continue;
      for (const p of buildCasePassages(r).passages) {
        expect(p.tokens).toBeLessThanOrEqual(maxTokens);
        expect(p.inputTokens).toBeLessThanOrEqual(MAX_INPUT_TOKENS);
        expect(p.inputTokens).toBe(countTokens(p.input));
      }
    }
  });

  it('overlaps consecutive passages by whole trailing sentences within overlapTokens', () => {
    const texts = [narrative(16, 30), ...fixtureSections().map((s) => s.text)];
    let checked = 0;
    for (const text of texts) {
      const passages = chunkSection(section(text));
      for (let i = 1; i < passages.length; i += 1) {
        const prev = passages[i - 1] as PassageDraft;
        const cur = passages[i] as PassageDraft;
        expect(cur.start).toBeLessThan(prev.end);
        const shared = text.slice(cur.start, prev.end);
        expect(cur.text.startsWith(shared)).toBe(true);
        expect(prev.text.endsWith(shared)).toBe(true);
        expect(cur.overlapTokens).toBe(countTokens(shared));
        expect(cur.overlapTokens).toBeGreaterThan(0);
        expect(cur.overlapTokens).toBeLessThanOrEqual(overlapTokens);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('sizes the passages of a long section evenly, without tiny tails', () => {
    for (const text of [narrative(17, 30), narrative(18, 9), narrative(19, 55, { sep: '\n' })]) {
      const passages = chunkSection(section(text));
      expect(passages.length).toBeGreaterThan(1);
      for (const p of passages) expect(p.tokens).toBeGreaterThanOrEqual(minTokens);
      const sizes = passages.map((p) => p.tokens);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(DEFAULT_CHUNK_OPTIONS.targetTokens / 2);
    }
  });

  it('ends passages at paragraph ends where it can and never right after a heading', () => {
    const headings = ['HISTORY OF FLIGHT', 'PERSONNEL INFORMATION', 'AIRCRAFT INFORMATION', 'METEOROLOGICAL INFORMATION', 'WRECKAGE AND IMPACT INFORMATION'];
    const text = headings.map((h, i) => `${h}\n\n${narrative(20 + i, 4)}`).join('\n\n');
    const passages = chunkSection(section(text));
    expect(passages.length).toBeGreaterThan(2);
    for (const p of passages.slice(0, -1)) {
      expect(headings.some((h) => p.text.endsWith(h))).toBe(false);
      expect(text.slice(p.end, p.end + 1)).toBe('\n');
    }
  });

  it('splits sentences, but not at abbreviations, initials or decimals', () => {
    expect(
      splitSentences(
        'The No. 2 engine of the U.S. Army helicopter, flown by J. Smith, used 3.5 gal. per hour. ' +
          'It landed at Ft. Worth about 1:30 p.m. The pilot said "it quit!" Then it restarted? Yes… ' +
          'Approx. 300 ft. The wind was calm, e.g. No gusts. See Fig. 3 and Oct. 5 records. done. (End)',
      ),
    ).toEqual([
      'The No. 2 engine of the U.S. Army helicopter, flown by J. Smith, used 3.5 gal. per hour.',
      'It landed at Ft. Worth about 1:30 p.m.',
      'The pilot said "it quit!"',
      'Then it restarted?',
      'Yes…',
      'Approx. 300 ft.',
      'The wind was calm, e.g. No gusts.',
      'See Fig. 3 and Oct. 5 records. done.',
      '(End)',
    ]);
  });

  it('keeps astral characters whole: offsets never fall inside a surrogate pair', () => {
    const insideSurrogatePair = (text: string, i: number) =>
      i > 0 && i < text.length && /[\ud800-\udbff]/.test(text[i - 1] ?? '') && /[\udc00-\udfff]/.test(text[i] ?? '');
    const astral = ['\u{1F6E9}\uFE0F', '\u{1D400}\u{1D401}', '\u{1F600}', '\u{20000}'];
    const text = narrative(41, 20)
      .split(' ')
      .map((w, i) => (i % 7 === 0 ? `${w}${astral[i % astral.length]}` : w))
      .join(' ');
    const s = section(text);
    const passages = chunkSection(s);
    expect(passages.length).toBeGreaterThan(1);
    expectRoundTrip(s, passages);
    expectCoverage(s, passages);
    for (const p of passages) {
      expect(insideSurrogatePair(text, p.start)).toBe(false);
      expect(insideSurrogatePair(text, p.end)).toBe(false);
    }
    // Astral letters and digits without whitespace: cut between characters, never inside one.
    const blob = '\u{1D400}1'.repeat(1500);
    const only = section(blob);
    const { passages: cut, stats } = chunkSectionDetailed(only);
    expect(stats.forcedCharSplits).toBeGreaterThan(0);
    expectRoundTrip(only, cut);
    expectCoverage(only, cut);
    for (const p of cut) {
      expect(p.tokens).toBeLessThanOrEqual(maxTokens);
      expect(insideSurrogatePair(blob, p.start)).toBe(false);
      expect(insideSurrogatePair(blob, p.end)).toBe(false);
    }
  });

  it('finds headings glued to their text, and not acronyms, plurals or case numbers', () => {
    const starts = (t: string) => gluedHeadingStarts(t, 0, t.length).map((i) => t.slice(i, i + 12));
    expect(starts('ft msl. PERSONNEL INFORMATIONThe pilot')).toEqual(['PERSONNEL IN']);
    expect(starts('HISTORY OF FLIGHTOn December 14')).toEqual(['HISTORY OF F']);
    expect(starts('the airplane. WRECKAGE AND IMPACT INFORMATIONThe airplane')).toEqual(['WRECKAGE AND']);
    expect(starts('Review of METARs, NOTAMs and SEA08LA057 in IMC, then VMC.')).toEqual([]);
  });

  it('agrees with the analyzer char filter on where glued headings split', () => {
    const samples = [
      'ft msl. PERSONNEL INFORMATIONThe pilot; HISTORY OF FLIGHTOn December; TESTS AND RESEARCHAircraft',
      'METARs, NOTAMs, SEA08LA057, IMC, VMC, CFITs, ABCs, USAir, McDONNELL DOUGLAS',
    ];
    for (const t of samples) {
      const zeroWidth = t.replace(new RegExp(GLUED_HEADING_PATTERN, 'gu'), ' ');
      expect(t.replace(new RegExp(GLUED_HEADING_REPLACE.pattern, 'gu'), GLUED_HEADING_REPLACE.replacement)).toBe(zeroWidth);
    }
    expect(samples[1]?.replace(new RegExp(GLUED_HEADING_PATTERN, 'gu'), ' ')).toBe(samples[1]);
  });

  it('prefers cutting right before a glued heading (a soft paragraph start)', () => {
    const headings = ['HISTORY OF FLIGHT', 'PERSONNEL INFORMATION', 'AIRCRAFT INFORMATION', 'METEOROLOGICAL INFORMATION', 'WRECKAGE AND IMPACT INFORMATION'];
    // One paragraph, as HTML conversion leaves it: "...last sentence. HEADINGThe next...",
    // each heading's part about one passage long, so a cut at each heading is in reach.
    const part = (h: string, seed: number) => {
      let body = narrative(seed, 1, { sep: ' ' });
      for (let k = 1; countTokens(`${h}${body}`) < 440; k += 1) body = `${body} ${narrative(seed * 100 + k, 1, { sep: ' ' })}`;
      return `${h}${body}`;
    };
    const text = headings.map((h, i) => part(h, 60 + i)).join(' ');
    const s = section(text);
    const passages = chunkSection(s);
    expect(passages.length).toBeGreaterThan(2);
    expectRoundTrip(s, passages);
    const starts = new Set(gluedHeadingStarts(text, 0, text.length));
    expect(starts.size).toBe(headings.length);
    // Every cut lands right before a heading: the passage ends where the heading's unit begins.
    for (const p of passages.slice(0, -1)) {
      const next = text.slice(p.end).search(/\S/) + p.end;
      expect(starts.has(next)).toBe(true);
    }
  });

  it('is deterministic', () => {
    const s = section(narrative(40, 25, { sep: '\r\n' }));
    expect(chunkSection(s)).toEqual(chunkSection(s));
  });

  it('returns nothing for whitespace-only text and rejects inconsistent options', () => {
    expect(chunkSection(section(' \r\n\t '))).toEqual([]);
    expect(() => chunkSection(section('x'), { targetTokens: 900, maxTokens: 800, minTokens: 200, overlapTokens: 80 })).toThrow(/invalid chunk options/);
    expect(() => chunkSection(section('x'), { targetTokens: 650, maxTokens: 800, minTokens: 50, overlapTokens: 80 })).toThrow(/invalid chunk options/);
  });
});
