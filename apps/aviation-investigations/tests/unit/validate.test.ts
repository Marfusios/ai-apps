import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
import { splitSentences } from '../../server/briefs/sentences.js';
import {
  QUOTE_MATCH_RULE_VERSION,
  QUOTE_MAX_SOURCE,
  caseNumberTokens,
  collapseWhitespace,
  derivePassageId,
  matchQuote,
  resolvePassage,
  summaryMarkers,
  timingValueAllowed,
  validateComposition,
  type AllowedPassage,
  type Allowlist,
  type CanonicalPassage,
  type RetrievedPassageRef,
} from '../../server/briefs/validate.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** A passage cut from a section at `sectionStart`. */
function passage(ntsbNo: string, text: string, opts: Partial<AllowedPassage> = {}): AllowedPassage {
  return {
    ntsbNo,
    text,
    sha: sha(`section of ${ntsbNo}`),
    sectionId: `${ntsbNo}:analysis/aircraft-1`,
    revisionId: sha(`revision of ${ntsbNo}`),
    sectionKind: 'analysis',
    sectionStart: 100,
    scope: 'aircraft',
    aircraftKey: 1,
    ...opts,
  };
}

const DFW =
  'Further examination of the engine revealed that a castellated nut used to secure the governor lever control rod to the idler bell crank had come completely loose, and the cotter pin that secured the nut was missing.  The engine had  been replaced 5.1 hours prior to the accident by a contract maintenance facility.';
const DFW_CAUSE = "The contract mechanic's failure to properly secure the castellated nut that attached the governor lever control rod to the idler bell crank.";
const DEN = 'The pilot stated, "I am now sure the engine was trying to seize up and I was again forced to land."  The reason for the loss of engine power was not determined.';

function allow(extra: [string, AllowedPassage][] = []): Allowlist {
  return {
    passages: new Map<string, AllowedPassage>([
      ['p-dfw', passage('DFW08TA066', DFW)],
      ['p-dfw-cause', passage('DFW08TA066', DFW_CAUSE, { sectionId: 'DFW08TA066:probable_cause/aircraft-1', sectionKind: 'probable_cause' })],
      ['p-den', passage('DEN08LA103', DEN)],
      ...extra,
    ]),
    cases: new Set(['DFW08TA066', 'DEN08LA103']),
  };
}

function composition(over: Partial<ComposeOutput> = {}): ComposeOutput {
  return {
    outcome: 'answer',
    summary:
      'A mechanic left a nut unsecured after an engine change [[case:DFW08TA066]]. In another case the cause was never found [[case:DEN08LA103]].',
    groups: [
      { kind: 'causal', caseNumbers: ['DFW08TA066'] },
      { kind: 'insufficient', caseNumbers: ['DEN08LA103'] },
    ],
    cases: [
      {
        ntsbNo: 'DFW08TA066',
        why: 'The engine lost power 5.1 hours after it was replaced.',
        quotes: [{ passageId: 'p-dfw', quote: 'The engine had been replaced 5.1 hours prior to the accident', speaker: 'investigators' }],
        evidencePassageIds: ['p-dfw', 'p-dfw-cause'],
        maintenance: { relation: 'investigator_attributed', passageIds: ['p-dfw-cause'] },
        symptom: { value: 'total_power_loss', passageIds: ['p-dfw'] },
        chronology: { flightHours: { value: 5.1, bound: 'exact', passageIds: ['p-dfw'] } },
      },
      {
        ntsbNo: 'DEN08LA103',
        why: 'Power was lost after maintenance and the reason was never determined.',
        quotes: [{ passageId: 'p-den', quote: 'The reason for the loss of engine power was not determined.', speaker: 'investigators' }],
        evidencePassageIds: [],
        maintenance: { relation: 'preceding_not_established', passageIds: ['p-den'] },
        symptom: { value: 'partial_power_loss', passageIds: ['p-den'] },
      },
    ],
    gaps: [],
    ...over,
  };
}

const codes = (r: ReturnType<typeof validateComposition>) => (r.ok ? [] : r.reasons.map((x) => x.code));
const check = (out: ComposeOutput, a: Allowlist = allow(), mechanicalCause = true) => codes(validateComposition(out, a, { mechanicalCause }));

describe('quote rule quote-ws-v2', () => {
  it('CRLF/NBSP passage quote validates', () => {
    const text = 'The fuel pump had been\r\noverhauled and installed about  2 months\tprior to the accident.\r\n';
    const a: Allowlist = {
      passages: new Map([['p-nyc', passage('NYC08LA106', text, { sectionStart: 40 })]]),
      cases: new Set(['NYC08LA106']),
    };
    const out = composition({
      summary: 'The pump was installed about two months earlier [[case:NYC08LA106]].',
      groups: [{ kind: 'defect_not_causal', caseNumbers: ['NYC08LA106'] }],
      cases: [
        {
          ntsbNo: 'NYC08LA106',
          why: 'Power was lost two months after the fuel pump was installed.',
          quotes: [{ passageId: 'p-nyc', quote: 'had been overhauled and installed about 2 months prior', speaker: 'investigators' }],
          evidencePassageIds: ['p-nyc'],
        },
      ],
    });
    const r = validateComposition(out, a, { mechanicalCause: true });
    expect(r).toMatchObject({ ok: true, ruleVersion: QUOTE_MATCH_RULE_VERSION });
    expect(QUOTE_MATCH_RULE_VERSION).toBe('quote-ws-v2');
    if (!r.ok) return;
    const [c] = r.citations;
    // The span covers the original text, CRLF and NBSPs included.
    expect(c!.text).toBe('had been\r\noverhauled and installed about  2 months\tprior');
    expect(text.slice(c!.passageSpan.start, c!.passageSpan.end)).toBe(c!.text);
    expect(c!.passageSpan).toEqual({ start: 14, end: 14 + c!.text.length });
    expect(c!.sectionSpan).toEqual({ start: 40 + 14, end: 40 + 14 + c!.text.length });
    expect(c).toMatchObject({ matches: 1, occurrence: 'first', ntsbNo: 'NYC08LA106', caseIndex: 0, quoteIndex: 0 });
  });

  it('collapses whitespace runs in the quote too, and trims it', () => {
    const m = matchQuote(DFW, '  The engine had\n been   replaced 5.1 hours ');
    expect(m).toMatchObject({ ok: true, matches: 1 });
    if (m.ok) expect(DFW.slice(m.span.start, m.span.end)).toBe('The engine had  been replaced 5.1 hours');
  });

  it('maps offsets in UTF-16 code units, past surrogate pairs', () => {
    const text = 'Pilot 🛩 said: “the engine quit”.';
    const m = matchQuote(text, 'said: “the engine quit”');
    expect(m.ok).toBe(true);
    if (m.ok) expect(text.slice(m.span.start, m.span.end)).toBe('said: “the engine quit”');
  });

  it('folds nothing but whitespace: quotation marks, case and dashes must match', () => {
    const text = 'The pilot said “the engine quit” – twice.';
    expect(matchQuote(text, 'said "the engine quit"')).toEqual({ ok: false, code: 'quote_not_found' });
    expect(matchQuote(text, 'THE ENGINE QUIT')).toEqual({ ok: false, code: 'quote_not_found' });
    expect(matchQuote(text, 'quit” - twice')).toEqual({ ok: false, code: 'quote_not_found' });
    expect(matchQuote(text, 'quit” – twice')).toMatchObject({ ok: true });
  });

  it('a repeated match uses the first occurrence and records the count', () => {
    const text = 'The engine lost power. Later, the engine lost power again.';
    expect(matchQuote(text, 'the engine lost power')).toEqual({ ok: true, span: { start: 30, end: 51 }, matches: 1 });
    expect(matchQuote(text, 'engine lost power')).toEqual({ ok: true, span: { start: 4, end: 21 }, matches: 2 });
  });

  it('rejects empty, short and lone-surrogate quotes', () => {
    expect(matchQuote(DFW, '  \r\n ')).toEqual({ ok: false, code: 'empty_quote' });
    expect(matchQuote(DFW, 'was missing.')).toEqual({ ok: false, code: 'quote_too_short' });
    expect(matchQuote(DFW, 'nut was missing.')).toMatchObject({ ok: true });
    expect(matchQuote('a \ud83d b c d', 'a \ud83d b')).toEqual({ ok: false, code: 'malformed_quote' });
    const out = composition();
    out.cases[0]!.quotes[0]!.quote = '  ';
    expect(check(out)).toEqual(['empty_quote']);
  });

  it('a short quote can never resolve to more source text than is shown: over-long resolutions are refused, never cut', () => {
    // Whitespace collapsing lets a short quote span a long source run (gate G6 #7).
    const source = `Engine ${' '.repeat(1_250)}stopped producing power.`;
    expect(source.length).toBeGreaterThan(1_267);
    expect(matchQuote(source, 'Engine stopped producing power.')).toEqual({ ok: false, code: 'quote_too_long' });
    const fits = `Engine ${' '.repeat(QUOTE_MAX_SOURCE - 31)}stopped producing power.`;
    const m = matchQuote(fits, 'Engine stopped producing power.');
    expect(m.ok && m.span.end - m.span.start).toBe(QUOTE_MAX_SOURCE);
    const a = allow([['p-long', passage('DFW08TA066', source)]]);
    const out = composition();
    out.cases[0]!.quotes.push({ passageId: 'p-long', quote: 'Engine stopped producing power.', speaker: 'investigators' });
    expect(check(out, a)).toEqual(['quote_too_long']);
  });

  it('collapseWhitespace keeps a map back to the original offsets', () => {
    const n = collapseWhitespace('a\r\n b  c');
    expect(n.text).toBe('a b c');
    expect(n.map).toEqual([0, 1, 4, 5, 7]);
  });
});

describe('validateComposition', () => {
  it('accepts a composition that follows every rule and resolves its citations', () => {
    const r = validateComposition(composition(), allow(), { mechanicalCause: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.citations.map((c) => [c.ntsbNo, c.passageId, c.text])).toEqual([
      ['DFW08TA066', 'p-dfw', 'The engine had  been replaced 5.1 hours prior to the accident'],
      ['DEN08LA103', 'p-den', 'The reason for the loss of engine power was not determined.'],
    ]);
    expect(r.citations[0]).toMatchObject({ sectionId: 'DFW08TA066:analysis/aircraft-1', sectionSha: sha('section of DFW08TA066') });
  });

  it('quote not in passage is refused', () => {
    const out = composition();
    out.cases[0]!.quotes[0]!.quote = 'The engine had been replaced 5 hours prior to the accident';
    expect(validateComposition(out, allow(), { mechanicalCause: true })).toEqual({
      ok: false,
      ruleVersion: QUOTE_MATCH_RULE_VERSION,
      reasons: [{ code: 'quote_not_found', path: 'cases.0.quotes.0.quote' }],
    });
  });

  it('a quote and every cited passage come from the case that cites them', () => {
    const out = composition();
    out.cases[0]!.quotes[0] = { passageId: 'p-den', quote: 'The reason for the loss of engine power was not determined.', speaker: 'investigators' };
    expect(check(out)).toEqual(['foreign_passage']);
    out.cases[0]!.quotes[0] = { passageId: 'p-none', quote: 'anything at all here', speaker: 'investigators' };
    expect(check(out)).toEqual(['unknown_passage']);
    const cited = composition();
    cited.cases[0]!.chronology!.flightHours!.passageIds = ['p-den'];
    expect(check(cited)).toEqual(['foreign_passage']);
    const invented = composition();
    invented.cases[0]!.maintenance!.passageIds = ['p-invented'];
    expect(check(invented)).toEqual(['unknown_passage']);
  });

  it('structured claims cite their own support; statements of absence may cite none', () => {
    const noSupport = composition();
    noSupport.cases[0]!.evidencePassageIds = [];
    expect(check(noSupport)).toEqual(['missing_support']);
    // Every stated chronology fact cites the passages that state it.
    for (const fact of [
      { flightHours: { value: 5.1, bound: 'exact' as const, passageIds: [] } },
      { calendarDays: { value: 40, bound: 'exact' as const, passageIds: [] } },
      { flight: { value: 'later' as const, passageIds: [] } },
      { qualitative: { passageIds: [] } },
    ]) {
      const timing = composition();
      timing.cases[0]!.chronology = fact;
      expect(check(timing), Object.keys(fact)[0]).toEqual(['missing_support']);
    }
    const absent = composition();
    absent.cases[1]!.maintenance = { relation: 'no_evidence', passageIds: [] };
    expect(check(absent)).toEqual([]);
  });

  it('unallowlisted case numbers in the why text, summary or gaps are refused, in any letter case', () => {
    const out = composition();
    out.cases[0]!.why = 'Like CEN19FA024, the engine lost power after maintenance.';
    expect(validateComposition(out, allow(), { mechanicalCause: true })).toMatchObject({
      ok: false,
      reasons: [{ code: 'unallowlisted_case_number', path: 'cases.0.why' }],
    });
    out.cases[0]!.why = 'Similar to cen19fa024.';
    expect(check(out)).toEqual(['unallowlisted_case_number']);
    expect(check(composition({ summary: 'Compare ERA24LA303 with this one [[case:DFW08TA066]].' }))).toEqual(['unallowlisted_case_number']);
  });

  it('allowlisted aircraft numbers of a bundle case pass, and A/B shorthand names both', () => {
    const a = allow();
    const withAircraft: Allowlist = { passages: a.passages, cases: new Set([...a.cases, 'DFW08TA066A']) };
    const out = composition();
    out.cases[0]!.why = 'Aircraft DFW08TA066A lost power after an engine change.';
    expect(check(out, withAircraft)).toEqual([]);
    out.cases[0]!.why = 'Aircraft DFW08TA066A/B collided after an engine change.';
    expect(check(out, withAircraft)).toEqual(['unallowlisted_case_number']);
    const both: Allowlist = { passages: a.passages, cases: new Set([...a.cases, 'DFW08TA066A', 'DFW08TA066B']) };
    expect(check(out, both)).toEqual([]);
    expect(caseNumberTokens('DCA25MA108A/B and dca25ma108a/b/c')).toEqual([
      'DCA25MA108A',
      'DCA25MA108B',
      'DCA25MA108A',
      'DCA25MA108B',
      'DCA25MA108C',
    ]);
  });

  it('every case is in the bundle, used once, and in exactly one group of the right kind', () => {
    const unknown = composition();
    unknown.cases[1]!.ntsbNo = 'MIA08LA156';
    unknown.groups[1]!.caseNumbers = ['MIA08LA156'];
    unknown.summary = 'A nut came loose [[case:DFW08TA066]].';
    expect(check(unknown)).toContain('unknown_case');
    expect(check(composition({ groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066', 'DEN08LA103'] }, { kind: 'insufficient', caseNumbers: ['DEN08LA103'] }] }))).toEqual([
      'case_in_two_groups',
    ]);
    expect(check(composition({ groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }] }))).toEqual(['case_not_grouped']);
    const examples = composition({ groups: [{ kind: 'examples', caseNumbers: ['DFW08TA066', 'DEN08LA103'] }] });
    expect(check(examples)).toEqual(['group_kind_mismatch']);
    expect(check(examples, allow(), false)).toEqual([]);
    expect(check(composition(), allow(), false)).toContain('group_kind_mismatch');
  });

  it('an explicit abstention presents nothing; an answer presents at least one case', () => {
    const abstain = composition({ outcome: 'no_supported_match', summary: '', groups: [], cases: [] });
    expect(check(abstain)).toEqual([]);
    const withGap = { ...abstain, gaps: [{ ntsbNo: 'DFW08TA066', note: 'The supplied passages put the engine change 5.1 hours earlier.', passageIds: ['p-dfw'] }] };
    expect(check(withGap)).toEqual([]);
    expect(check({ ...abstain, summary: 'Nothing fits [[case:DFW08TA066]].' })).toContain('outcome_mismatch');
    expect(check(composition({ cases: [], groups: [], summary: '' }))).toContain('outcome_mismatch');
  });

  it('every summary sentence cites a case', () => {
    expect(check(composition({ summary: 'Maintenance matters a great deal. A nut came loose [[case:DFW08TA066]]. [[case:DEN08LA103]] Cause unknown.' }))).toEqual([
      'uncited_summary',
      'uncited_summary',
    ]);
    // Abbreviations do not end a sentence: "U.S." and "approx." stay inside the cited sentence.
    expect(check(composition({ summary: 'A U.S. operator flew approx. 5.1 hours after an engine change [[case:DFW08TA066]]. Its cause was never found [[case:DEN08LA103]].' }))).toEqual([]);
  });

  it('summary markers are well formed and name used cases', () => {
    expect(summaryMarkers('A [[case:DFW08TA066]] and [[case:DEN08LA103]].')).toEqual(['DFW08TA066', 'DEN08LA103']);
    expect(summaryMarkers('A [[case:DFW08TA066] b')).toBeNull();
    expect(summaryMarkers('A [[case:<b>x</b>]]')).toBeNull();
    expect(check(composition({ summary: 'Broken [ [case:DFW08TA066]] marker.' }))).toEqual(['bad_marker']);
    const other = composition();
    other.cases = [other.cases[0]!];
    other.groups = [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }];
    expect(check(other)).toEqual(['marker_unknown_case']);
  });

  it('refuses links and markup in generated text', () => {
    const out = composition();
    out.cases[1]!.why = 'See https://example.org for more.';
    expect(check(out)).toEqual(['markup_or_link']);
    out.cases[1]!.why = 'Read <b>this</b>.';
    expect(check(out)).toEqual(['markup_or_link']);
    out.cases[1]!.why = 'Power dropped to < 50 percent after maintenance.';
    expect(check(out)).toEqual([]);
  });

  it('chronology facts are independent, typed and at the allowed precision (one canonical number)', () => {
    const out = composition();
    // "40 days and 20 flight hours" and "the second flight": three facts, each with its passages.
    out.cases[0]!.chronology = {
      flightHours: { value: 20, bound: 'exact', passageIds: ['p-dfw'] },
      calendarDays: { value: 40, bound: 'exact', passageIds: ['p-dfw'] },
      flight: { value: 'later', passageIds: ['p-dfw'] },
    };
    expect(check(out)).toEqual([]);
    out.cases[0]!.chronology = { flightHours: { bound: 'exact', passageIds: ['p-dfw'] } } as never;
    expect(check(out)).toEqual(['schema']);
    out.cases[0]!.chronology = { flight: { value: 'second', passageIds: ['p-dfw'] } } as never;
    expect(check(out)).toEqual(['schema']);
    out.cases[0]!.chronology = { flightHours: { value: 5.10001, bound: 'exact', passageIds: ['p-dfw'] } };
    expect(check(out)).toEqual(['timing_precision']);
    out.cases[0]!.chronology = { calendarDays: { value: 17.5, bound: 'about', passageIds: ['p-dfw'] } };
    expect(check(out)).toEqual(['timing_precision']);
    expect(timingValueAllowed('flight_hours', 5.1)).toBe(true);
    expect(timingValueAllowed('flight_hours', 12)).toBe(true);
    expect(timingValueAllowed('flight_hours', 0.05)).toBe(false);
    expect(timingValueAllowed('calendar_days', 60)).toBe(true);
  });

  it('gaps name a bundle case and cite its own passages', () => {
    expect(check(composition({ gaps: [{ ntsbNo: 'DEN08LA103', note: 'No maintenance date is given.', passageIds: ['p-den'] }] }))).toEqual([]);
    expect(check(composition({ gaps: [{ ntsbNo: 'DEN08LA103', note: 'No maintenance date is given.', passageIds: ['p-dfw'] }] }))).toEqual([
      'gap_foreign_passage',
    ]);
  });

  it('the schema must be valid: extra fields and wrong shapes fail', () => {
    const extra = { ...composition(), note: 'hidden channel' } as unknown as ComposeOutput;
    expect(check(extra)).toEqual(['schema']);
    const lower = composition();
    lower.cases[0]!.ntsbNo = 'dfw08ta066';
    expect(check(lower)).toContain('schema');
  });

  it('allowlist entries must carry their provenance', () => {
    const a = allow([['p-bad', passage('DFW08TA066', 'x', { sectionId: 'DEN08LA103:analysis/aircraft-1' })]]);
    expect(check(composition(), a)).toEqual(['provenance']);
  });

  it('caseNumberTokens finds NTSB-number shapes only', () => {
    expect(caseNumberTokens('DFW08TA066, sea08la057b and GAA19CA123; N123AB, PA28, 14 CFR 91.')).toEqual([
      'DFW08TA066',
      'SEA08LA057B',
      'GAA19CA123',
    ]);
  });
});

describe('sentence splitting', () => {
  it('does not split after common abbreviations or initials', () => {
    expect(splitSentences('Mr. Smith, the pilot, saw it. The U.S. operator, e.g. a school, flew approx. 2 hours. Done!')).toEqual([
      'Mr. Smith, the pilot, saw it.',
      'The U.S. operator, e.g. a school, flew approx. 2 hours.',
      'Done!',
    ]);
    expect(splitSentences('One [[case:A1B2C3]]. Two. Three [[case:D4E5F6]] [[case:G7H8I9]]! Four?')).toEqual([
      'One [[case:A1B2C3]].',
      'Two.',
      'Three [[case:D4E5F6]] [[case:G7H8I9]]!',
      'Four?',
    ]);
    expect(splitSentences('Loose nut. [[case:A1B2C3]] Next one.')).toEqual(['Loose nut. [[case:A1B2C3]]', 'Next one.']);
    expect(splitSentences('Capt. Jones flew cylinder No. 2 at approx. 500 feet, vs. 300 planned.')).toHaveLength(1);
  });

  it('case markers after the punctuation always end the sentence, even after an abbreviation', () => {
    const summary = 'The engine failed after an overhaul in the U.S. [[case:DFW08TA066]] Maintenance is always to blame.';
    expect(splitSentences(summary)).toEqual(['The engine failed after an overhaul in the U.S. [[case:DFW08TA066]]', 'Maintenance is always to blame.']);
    expect(splitSentences('Seen by Mr. [[case:DFW08TA066]] Nobody else.')).toEqual(['Seen by Mr. [[case:DFW08TA066]]', 'Nobody else.']);
    // So the uncited sentence is caught.
    const out = composition({ summary });
    out.cases = out.cases.slice(0, 1);
    out.groups = [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }];
    expect(validateComposition(out, allow(), { mechanicalCause: true })).toMatchObject({ ok: false, reasons: [{ code: 'uncited_summary', path: 'summary.1' }] });
  });

  it('words that often end a sentence are not abbreviations; "No." is one only before a number', () => {
    expect(splitSentences('The engine ran for 10 min. Maintenance is always to blame [[case:DFW08TA066]].')).toEqual([
      'The engine ran for 10 min.',
      'Maintenance is always to blame [[case:DFW08TA066]].',
    ]);
    for (const word of ['no', 'min', 'max', 'est', 'St', 'sec', 'hr', 'ft', 'etc']) {
      expect(splitSentences(`It was ${word}. Another one.`), word).toEqual([`It was ${word}.`, 'Another one.']);
    }
    expect(splitSentences('The answer was no. Cylinder No. 2 failed.')).toEqual(['The answer was no.', 'Cylinder No. 2 failed.']);
  });
});

describe('resolvePassage: the canonical passage row', () => {
  const sectionText = 'Intro text.\r\nThe engine had  been replaced 5.1 hours prior to the accident.';
  const revisionId = sha('rev');
  const canonical: CanonicalPassage = {
    passageId: derivePassageId(revisionId, 13, sectionText.length, 'chunk-v2'),
    chunkerVersion: 'chunk-v2',
    ntsbNo: 'DFW08TA066',
    sectionId: 'DFW08TA066:analysis/aircraft-1',
    revisionId,
    sectionKind: 'analysis',
    scope: 'aircraft',
    aircraftKey: 1,
    start: 13,
    end: sectionText.length,
    sectionText,
    sectionSha: sha(sectionText),
  };
  const ref: RetrievedPassageRef = {
    passageId: canonical.passageId,
    ntsbNo: 'DFW08TA066',
    sectionId: canonical.sectionId,
    revisionId,
    sectionKind: 'analysis',
    scope: 'aircraft',
    aircraftKey: 1,
    start: 13,
    end: sectionText.length,
    text: sectionText.slice(13),
  };

  it('accepts a passage that is exactly its canonical row and section text', () => {
    expect(resolvePassage(ref, canonical)).toEqual({
      ok: true,
      allowed: {
        ntsbNo: 'DFW08TA066',
        text: sectionText.slice(13),
        sha: canonical.sectionSha,
        sectionId: canonical.sectionId,
        revisionId,
        sectionKind: 'analysis',
        sectionStart: 13,
        scope: 'aircraft',
        aircraftKey: 1,
      },
    });
  });

  it('a valid analysis slice labelled probable_cause with an invented passage id is rejected', () => {
    const invented = { ...ref, passageId: 'f'.repeat(64), sectionKind: 'probable_cause' as const };
    // No canonical row has that id.
    expect(resolvePassage(invented, undefined)).toEqual({ ok: false, problem: 'no_passage' });
    // Even under the real id, the label must be the canonical kind.
    expect(resolvePassage({ ...ref, sectionKind: 'probable_cause' }, canonical)).toEqual({ ok: false, problem: 'kind_mismatch' });
    // A canonical row whose id does not follow the approved derivation is refused too.
    expect(resolvePassage({ ...ref, passageId: 'f'.repeat(64) }, { ...canonical, passageId: 'f'.repeat(64) })).toEqual({ ok: false, problem: 'passage_id' });
  });

  it('refuses a broken chain', () => {
    expect(resolvePassage({ ...ref, text: `${ref.text} ` }, canonical)).toEqual({ ok: false, problem: 'text_mismatch' });
    expect(resolvePassage(ref, { ...canonical, sectionSha: sha('other') })).toEqual({ ok: false, problem: 'section_hash_mismatch' });
    expect(resolvePassage({ ...ref, scope: 'event', aircraftKey: null }, canonical)).toEqual({ ok: false, problem: 'scope_mismatch' });
    expect(resolvePassage({ ...ref, revisionId: sha('rev2') }, canonical)).toEqual({ ok: false, problem: 'section_mismatch' });
    expect(resolvePassage({ ...ref, start: 12 }, canonical)).toEqual({ ok: false, problem: 'offsets' });
    expect(resolvePassage(ref, { ...canonical, end: sectionText.length + 1, passageId: derivePassageId(revisionId, 13, sectionText.length + 1, 'chunk-v2') })).toEqual({
      ok: false,
      problem: 'no_passage',
    });
  });
});
