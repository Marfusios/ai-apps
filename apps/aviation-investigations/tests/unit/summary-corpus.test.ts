/**
 * The summary citation rules against adversarial input (server/briefs/sentences.ts): the
 * code review's corpus of efe27ce and the re-review's of 1b1d448
 * (tests/support/summary-corpus.ts), the reviewer's exhaustive grid of terminators and
 * separators, a generated grid of sentence ends, separators and layouts, the allow-list
 * over every code point, and the worst cases for time.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
import { summaryCharAllowed, summaryFormatProblem } from '../../server/briefs/sentences.js';
import { validateComposition, type AllowedPassage, type Allowlist } from '../../server/briefs/validate.js';
import { ALLOWLIST_CASES, DENYLIST_MISSED, GRID_SEPARATORS, GRID_TERMINATORS, SUMMARY_CORPUS } from '../support/summary-corpus.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const A = '[[case:DFW08TA066]]';
const B = '[[case:DEN08LA103]]';

function passage(ntsbNo: string, text: string): AllowedPassage {
  return {
    ntsbNo,
    text,
    sha: sha(`section of ${ntsbNo}`),
    sectionId: `${ntsbNo}:analysis/aircraft-1`,
    revisionId: sha(`revision of ${ntsbNo}`),
    sectionKind: 'analysis',
    sectionStart: 0,
    scope: 'aircraft',
    aircraftKey: 1,
  };
}

const allow: Allowlist = {
  passages: new Map([
    ['P1', passage('DFW08TA066', 'The engine had been replaced 5.1 hours prior to the accident by a contract maintenance facility.')],
    ['P2', passage('DEN08LA103', 'The reason for the loss of engine power was not determined.')],
  ]),
  cases: new Set(['DFW08TA066', 'DEN08LA103']),
};

/** A composition that follows every other rule, with `summary` as its summary. */
function composition(summary: string): ComposeOutput {
  return {
    outcome: 'answer',
    summary,
    groups: [
      { kind: 'causal', caseNumbers: ['DFW08TA066'] },
      { kind: 'insufficient', caseNumbers: ['DEN08LA103'] },
    ],
    cases: [
      {
        ntsbNo: 'DFW08TA066',
        why: 'The engine lost power 5.1 hours after it was replaced.',
        quotes: [{ passageId: 'P1', quote: 'The engine had been replaced 5.1 hours prior to the accident', speaker: 'investigators' }],
        evidencePassageIds: ['P1'],
      },
      {
        ntsbNo: 'DEN08LA103',
        why: 'Power was lost after maintenance and the reason was never determined.',
        quotes: [{ passageId: 'P2', quote: 'The reason for the loss of engine power was not determined.', speaker: 'investigators' }],
        evidencePassageIds: [],
      },
    ],
    gaps: [],
  };
}

/** The reasons a withheld summary must fail for: about its sentences, not something unrelated. */
const SENTENCE_LEVEL = new Set(['uncited_summary', 'misplaced_citation', 'ambiguous_boundary', 'summary_format', 'bad_marker']);

const codesOf = (summary: string) => {
  const r = validateComposition(composition(summary), allow, { mechanicalCause: true });
  return r.ok ? null : r.reasons.map((x) => x.code);
};

describe('the adversarial summary corpus', () => {
  it('no uncited sentence, misplaced citation or ambiguous boundary validates; every well-formed summary does', () => {
    expect(SUMMARY_CORPUS).toHaveLength(237);
    const wrong: string[] = [];
    for (const c of SUMMARY_CORPUS) {
      const codes = codesOf(c.text);
      const label = `[${c.family}] ${JSON.stringify(c.text)} -> ${codes ? codes.join(',') : 'valid'}`;
      if (c.expect === 'withheld' && (codes === null || !codes.some((x) => SENTENCE_LEVEL.has(x)))) wrong.push(`should be withheld: ${label}`);
      if (c.expect !== 'withheld' && codes !== null) wrong.push(`should validate: ${label}`);
    }
    expect(wrong).toEqual([]);
  });

  it('keeps every family the review found, and the legitimate summaries', () => {
    const count = (expectation: string) => SUMMARY_CORPUS.filter((c) => c.expect === expectation).length;
    // Task 16d: one trailing-newline summary moved from valid to withheld (nothing is trimmed before the allow-list).
    expect([count('withheld'), count('valid'), count('accepted')]).toEqual([185, 38, 14]);
    for (const family of ['required', 'abbr', 'quote', 'ellipsis', 'decimal', 'qe', 'newline', 'markers', 'unicode', 'space', 'zerowidth', 'markup', 'compound', 'legit']) {
      expect(SUMMARY_CORPUS.some((c) => c.family === family), family).toBe(true);
    }
  });
});

describe('the allow-list (re-review of 1b1d448)', () => {
  it('withholds every separator the deny-list missed, for the reason given; keeps the closers and typography', () => {
    const wrong: string[] = [];
    for (const c of ALLOWLIST_CASES) {
      const codes = codesOf(c.text);
      const label = `${JSON.stringify(c.text)} (${c.note ?? ''}) -> ${codes ? codes.join(',') : 'valid'}`;
      if (c.expect === 'withheld' && (codes === null || !codes.some((x) => SENTENCE_LEVEL.has(x)))) wrong.push(`should be withheld: ${label}`);
      if (c.expect === 'withheld' && c.code && !(codes as string[] | null)?.includes(c.code)) wrong.push(`should fail ${c.code}: ${label}`);
      if (c.expect !== 'withheld' && codes !== null) wrong.push(`should validate: ${label}`);
    }
    expect(wrong).toEqual([]);
    expect(ALLOWLIST_CASES.filter((c) => c.expect === 'valid')).toHaveLength(8);
  });

  it('every code point the deny-list let through now fails summary_format', () => {
    expect(DENYLIST_MISSED.length).toBeGreaterThanOrEqual(133);
    const passed = DENYLIST_MISSED.filter(([cp]) => {
      const codes = codesOf(`The engine lost power${String.fromCodePoint(cp)} Three people were injured ${A}.`);
      return !codes?.includes('summary_format');
    });
    expect(passed.map(([cp, name]) => `U+${cp.toString(16).toUpperCase()} ${name}`)).toEqual([]);
  });

  it("the reviewer's exhaustive grid: every terminator and separator, both orientations, withheld", () => {
    expect([GRID_TERMINATORS.length, GRID_SEPARATORS.length]).toEqual([76, 44]);
    const styles: ((body: string) => string)[] = [(b) => `${b} ${A}.`, (b) => `${b}. ${A}`, (b) => `${b} ${A} ${B}.`];
    const passed: string[] = [];
    for (const [t] of GRID_TERMINATORS) {
      for (const [sep] of GRID_SEPARATORS) {
        for (const style of styles) {
          for (const text of [`The engine lost power${t}${sep}${style('Three people were injured')}`, `${style('Three people were injured')}${sep}The engine lost power${t}`]) {
            const codes = codesOf(text);
            if (codes === null || !codes.some((x) => SENTENCE_LEVEL.has(x))) passed.push(JSON.stringify(text));
          }
        }
      }
    }
    expect(passed).toEqual([]);
  });

  it('allows exactly printable ASCII but decoration, the typographic set and Latin-1 letters: every other code point fails', () => {
    const allowed: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (summaryCharAllowed(c)) allowed.push(cp);
    }
    const ascii = Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i).filter((cp) => !'*_~|[]{}'.includes(String.fromCharCode(cp)));
    const typographic = [0x201c, 0x201d, 0x2018, 0x2019, 0x2013, 0x2014, 0xb0, 0xb1, 0xd7, 0xbd, 0xbc, 0xbe, 0xa7];
    const latin1Letters = Array.from({ length: 0x100 - 0xc0 }, (_, i) => 0xc0 + i).filter((cp) => cp !== 0xd7 && cp !== 0xf7);
    expect(allowed).toEqual([...new Set([...ascii, ...typographic, ...latin1Letters])].sort((a, b) => a - b));
    expect(allowed).toHaveLength(87 + 13 + 62);
    // The lint is exactly the allow-list (plus HTML entities), wherever the character sits.
    for (const cp of [0x0f0d, 0xa0, 0x2009, 0x200b, 0x2028, 0x85, 0xb7, 0x2025, 0xa4f8, 0x1f525, 0xe0020, 0x2a, 0x7c]) {
      expect(summaryFormatProblem(`A${String.fromCodePoint(cp)}B`), cp.toString(16)).toBe(true);
    }
    for (const cp of allowed.filter((x) => x !== 0x26)) expect(summaryFormatProblem(`A${String.fromCodePoint(cp)}B`), cp.toString(16)).toBe(false);
    expect(summaryFormatProblem('A & B')).toBe(false);
    expect(summaryFormatProblem('A &amp; B')).toBe(true);
    // A lone surrogate is not a character.
    expect(summaryFormatProblem('A\uD800B')).toBe(true);
  });
});

describe('a generated grid of sentence ends, separators and layouts', () => {
  // Every way the review found to end a sentence without a split the validator can see.
  const ends = [
    '.', '!', '?', '...', '."', '.)', '.\u201D', '.\u00BB', '.]', '.*', '.**', '\u2026', '\u3002', '\uFF0E', '\u203D',
    '.\u00B9', '.\u2014', '.\u2020', '.,', '.;', '.:', '.|', '!?', '.\u00BF',
  ];
  const separators = [' ', '\n', '\u00A0', '\t', '', '\u200B', '\u00AD', '\u2060', ' \u200B', '\u200B ', '\u0085', '\u2003', '\u2028', '\u2029', '\r\n', '\u000B', '\u000C', '\uFEFF'];
  const layouts: ((end: string, sep: string) => string)[] = [
    (e, s) => `The engine lost power${e}${s}Three people were injured ${A}.`,
    (e, s) => `The engine lost power${e}${s}3 people were injured ${A}.`,
    (e, s) => `The engine lost power${e}${s}then it quit ${A}.`,
    (e, s) => `The engine lost power${e}${s}Three people were injured. ${A}`,
    (e, s) => `Three people were injured ${A}${e}${s}The engine lost power.`,
    (e, s) => `Three people were injured. ${A}${s}The engine lost power${e}`,
  ];

  it('withholds every combination for a sentence-level reason', () => {
    const passed: string[] = [];
    for (const e of ends) {
      for (const s of separators) {
        for (const layout of layouts) {
          const text = layout(e, s);
          const codes = codesOf(text);
          if (codes === null || !codes.some((x) => SENTENCE_LEVEL.has(x))) passed.push(JSON.stringify(text));
        }
      }
    }
    expect(passed).toEqual([]);
  });
});

describe('worst cases for time', () => {
  it('validates a 1,500-character summary of any shape in linear time', () => {
    const shapes = [
      `The engine lost power${' '.repeat(1450)}and then it quit ${A}.`,
      `The engine lost power${'\u00A0'.repeat(1450)}and then it quit ${A}.`,
      `a${' '.repeat(1480)}x`,
      `${A}${' '.repeat(1450)}junk`,
      `a${' '.repeat(700)}${A}${' '.repeat(700)}x`,
      `${(`${A}    `).repeat(60)}x`,
      '.'.repeat(1500),
      `${'.'.repeat(1470)} ${A}`,
      '. '.repeat(750),
      'No. 1 '.repeat(250),
      'U.S. '.repeat(300),
      'a. '.repeat(500),
      `${'."'.repeat(700)} x`,
    ];
    for (const text of shapes) {
      const t0 = performance.now();
      codesOf(text.slice(0, 1_500));
      // Before round 5 the citation placement took 0.7 to 1 s on the whitespace runs.
      expect(performance.now() - t0, JSON.stringify(text.slice(0, 40))).toBeLessThan(100);
    }
  });
});
