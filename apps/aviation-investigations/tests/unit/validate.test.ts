import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ComposeOutput } from '../../shared/contracts/briefs.js';
import {
  QUOTE_MATCH_RULE_VERSION,
  caseNumberTokens,
  collapseWhitespace,
  matchQuote,
  resolvePassage,
  summaryMarkers,
  validateComposition,
  type AllowedPassage,
  type Allowlist,
  type SectionRevision,
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
    sectionStart: 100,
    scope: 'aircraft',
    aircraftKey: 1,
    ...opts,
  };
}

const DFW =
  'Further examination of the engine revealed that a castellated nut used to secure the governor lever control rod to the idler bell crank had come completely loose, and the cotter pin that secured the nut was missing.  The engine had  been replaced 5.1 hours prior to the accident by a contract maintenance facility.';
const DEN = 'The pilot stated, "I am now sure the engine was trying to seize up and I was again forced to land."  The reason for the loss of engine power was not determined.';

function allow(extra: [string, AllowedPassage][] = []): Allowlist {
  return {
    passages: new Map<string, AllowedPassage>([
      ['p-dfw', passage('DFW08TA066', DFW)],
      ['p-den', passage('DEN08LA103', DEN, { sectionId: 'DEN08LA103:analysis/aircraft-1' })],
      ...extra,
    ]),
    cases: new Set(['DFW08TA066', 'DEN08LA103']),
  };
}

function composition(over: Partial<ComposeOutput> = {}): ComposeOutput {
  return {
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
        quotes: [
          { passageId: 'p-dfw', quote: 'The engine had been replaced 5.1 hours prior to the accident', speaker: 'investigators' },
        ],
        maintenance: 'investigator_attributed',
        symptom: 'total_power_loss',
        timing: { basis: 'flight_hours', value: 5.1, bound: 'exact' },
      },
      {
        ntsbNo: 'DEN08LA103',
        why: 'Power was lost after maintenance and the reason was never determined.',
        quotes: [{ passageId: 'p-den', quote: 'The reason for the loss of engine power was not determined.', speaker: 'investigators' }],
        maintenance: 'preceding_not_established',
        symptom: 'partial_power_loss',
      },
    ],
    gaps: [],
    ...over,
  };
}

const codes = (r: ReturnType<typeof validateComposition>) => (r.ok ? [] : r.reasons.map((x) => x.code));

describe('quote rule quote-ws-v1', () => {
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
        },
      ],
    });
    const r = validateComposition(out, a, { mechanicalCause: true });
    expect(r).toMatchObject({ ok: true, ruleVersion: QUOTE_MATCH_RULE_VERSION });
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
    const m = matchQuote(text, 'the engine lost power');
    expect(m).toEqual({ ok: true, span: { start: 30, end: 51 }, matches: 1 });
    const twice = matchQuote(text, 'engine lost power');
    expect(twice).toEqual({ ok: true, span: { start: 4, end: 21 }, matches: 2 });
  });

  it('rejects empty and whitespace-only quotes and lone surrogates', () => {
    expect(matchQuote(DFW, '  \r\n ')).toEqual({ ok: false, code: 'empty_quote' });
    expect(matchQuote('a \ud83d b', '\ud83d')).toEqual({ ok: false, code: 'malformed_quote' });
    const out = composition();
    out.cases[0]!.quotes[0]!.quote = '  ';
    expect(codes(validateComposition(out, allow(), { mechanicalCause: true }))).toEqual(['empty_quote']);
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
    const r = validateComposition(out, allow(), { mechanicalCause: true });
    expect(r).toEqual({ ok: false, ruleVersion: QUOTE_MATCH_RULE_VERSION, reasons: [{ code: 'quote_not_found', path: 'cases.0.quotes.0.quote' }] });
  });

  it('a quote must come from a passage of the case that cites it', () => {
    const out = composition();
    out.cases[0]!.quotes[0] = { passageId: 'p-den', quote: 'The reason for the loss of engine power was not determined.', speaker: 'investigators' };
    expect(codes(validateComposition(out, allow(), { mechanicalCause: true }))).toEqual(['foreign_passage']);
    out.cases[0]!.quotes[0] = { passageId: 'p-none', quote: 'anything', speaker: 'investigators' };
    expect(codes(validateComposition(out, allow(), { mechanicalCause: true }))).toEqual(['unknown_passage']);
  });

  it('unallowlisted case numbers in the why text, summary or gaps are refused, in any letter case', () => {
    const out = composition();
    out.cases[0]!.why = 'Like CEN19FA024, the engine lost power after maintenance.';
    expect(validateComposition(out, allow(), { mechanicalCause: true })).toMatchObject({
      ok: false,
      reasons: [{ code: 'unallowlisted_case_number', path: 'cases.0.why' }],
    });
    out.cases[0]!.why = 'Similar to cen19fa024.';
    expect(codes(validateComposition(out, allow(), { mechanicalCause: true }))).toEqual(['unallowlisted_case_number']);
    const summary = composition({ summary: 'Compare ERA24LA303 with this one [[case:DFW08TA066]].' });
    expect(codes(validateComposition(summary, allow(), { mechanicalCause: true }))).toEqual(['unallowlisted_case_number']);
  });

  it('allowlisted aircraft numbers of a bundle case pass', () => {
    const a = allow();
    const withAircraft: Allowlist = { passages: a.passages, cases: new Set([...a.cases, 'DFW08TA066A']) };
    const out = composition();
    out.cases[0]!.why = 'Aircraft DFW08TA066A lost power after an engine change.';
    expect(validateComposition(out, withAircraft, { mechanicalCause: true }).ok).toBe(true);
  });

  it('every case is in the bundle, used once, and in exactly one group of the right kind', () => {
    const unknown = composition();
    unknown.cases[1]!.ntsbNo = 'MIA08LA156';
    unknown.groups[1]!.caseNumbers = ['MIA08LA156'];
    unknown.summary = 'A nut came loose [[case:DFW08TA066]].';
    expect(codes(validateComposition(unknown, allow(), { mechanicalCause: true }))).toContain('unknown_case');

    const twoGroups = composition({ groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066', 'DEN08LA103'] }, { kind: 'insufficient', caseNumbers: ['DEN08LA103'] }] });
    expect(codes(validateComposition(twoGroups, allow(), { mechanicalCause: true }))).toEqual(['case_in_two_groups']);

    const ungrouped = composition({ groups: [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }] });
    expect(codes(validateComposition(ungrouped, allow(), { mechanicalCause: true }))).toEqual(['case_not_grouped']);

    const examples = composition({ groups: [{ kind: 'examples', caseNumbers: ['DFW08TA066', 'DEN08LA103'] }] });
    expect(codes(validateComposition(examples, allow(), { mechanicalCause: true }))).toEqual(['group_kind_mismatch']);
    expect(validateComposition(examples, allow(), { mechanicalCause: false }).ok).toBe(true);
    expect(codes(validateComposition(composition(), allow(), { mechanicalCause: false }))).toContain('group_kind_mismatch');
  });

  it('summary markers are well formed and name used cases', () => {
    expect(summaryMarkers('A [[case:DFW08TA066]] and [[case:DEN08LA103]].')).toEqual(['DFW08TA066', 'DEN08LA103']);
    expect(summaryMarkers('A [[case:DFW08TA066] b')).toBeNull();
    expect(summaryMarkers('A [[case:<b>x</b>]]')).toBeNull();
    expect(codes(validateComposition(composition({ summary: 'Broken [ [case:DFW08TA066]] marker.' }), allow(), { mechanicalCause: true }))).toEqual([
      'bad_marker',
    ]);
    const other = composition();
    other.cases = [other.cases[0]!];
    other.groups = [{ kind: 'causal', caseNumbers: ['DFW08TA066'] }];
    expect(codes(validateComposition(other, allow(), { mechanicalCause: true }))).toEqual(['marker_unknown_case']);
  });

  it('refuses links and markup in generated text', () => {
    const out = composition();
    out.cases[1]!.why = 'See https://example.org for more.';
    expect(codes(validateComposition(out, allow(), { mechanicalCause: true }))).toEqual(['markup_or_link']);
    out.cases[1]!.why = 'Read <b>this</b>.';
    expect(codes(validateComposition(out, allow(), { mechanicalCause: true }))).toEqual(['markup_or_link']);
    out.cases[1]!.why = 'Power dropped to < 50 percent after maintenance.';
    expect(validateComposition(out, allow(), { mechanicalCause: true }).ok).toBe(true);
  });

  it('timing values go with numeric bases only', () => {
    const out = composition();
    out.cases[0]!.timing = { basis: 'flight_hours', bound: 'exact' };
    expect(codes(validateComposition(out, allow(), { mechanicalCause: true }))).toEqual(['timing_shape']);
    out.cases[0]!.timing = { basis: 'first_flight', value: 1, bound: 'exact' };
    expect(codes(validateComposition(out, allow(), { mechanicalCause: true }))).toEqual(['timing_shape']);
  });

  it('gaps name a bundle case and cite its own passages', () => {
    const ok = composition({ gaps: [{ ntsbNo: 'DEN08LA103', note: 'No maintenance date is given.', passageIds: ['p-den'] }] });
    expect(validateComposition(ok, allow(), { mechanicalCause: true }).ok).toBe(true);
    const foreign = composition({ gaps: [{ ntsbNo: 'DEN08LA103', note: 'No maintenance date is given.', passageIds: ['p-dfw'] }] });
    expect(codes(validateComposition(foreign, allow(), { mechanicalCause: true }))).toEqual(['gap_foreign_passage']);
  });

  it('the schema must be valid: extra fields and wrong shapes fail', () => {
    const extra = { ...composition(), note: 'hidden channel' } as unknown as ComposeOutput;
    expect(codes(validateComposition(extra, allow(), { mechanicalCause: true }))).toEqual(['schema']);
    const lower = composition();
    lower.cases[0]!.ntsbNo = 'dfw08ta066';
    expect(codes(validateComposition(lower, allow(), { mechanicalCause: true }))).toContain('schema');
  });

  it('allowlist entries must carry their provenance', () => {
    const a = allow([['p-bad', passage('DFW08TA066', 'x', { sectionId: 'DEN08LA103:analysis/aircraft-1' })]]);
    expect(codes(validateComposition(composition(), a, { mechanicalCause: true }))).toEqual(['provenance']);
  });

  it('caseNumberTokens finds NTSB-number shapes only', () => {
    expect(caseNumberTokens('DFW08TA066, sea08la057b and GAA19CA123; N123AB, PA28, 14 CFR 91.')).toEqual([
      'DFW08TA066',
      'SEA08LA057B',
      'GAA19CA123',
    ]);
  });
});

describe('resolvePassage', () => {
  const sectionText = 'Intro text.\r\nThe engine had  been replaced 5.1 hours prior to the accident.';
  const section: SectionRevision = {
    ntsbNo: 'DFW08TA066',
    sectionId: 'DFW08TA066:analysis/aircraft-1',
    revisionId: sha('rev'),
    scope: 'aircraft',
    aircraftKey: 1,
    text: sectionText,
    sha256: sha(sectionText),
  };
  const ref = {
    passageId: 'p1',
    ntsbNo: 'DFW08TA066',
    sectionId: section.sectionId,
    revisionId: section.revisionId,
    scope: 'aircraft' as const,
    aircraftKey: 1,
    start: 13,
    end: sectionText.length,
    text: sectionText.slice(13),
  };

  it('accepts a passage that is exactly its section text at its offsets', () => {
    expect(resolvePassage(ref, section)).toEqual({
      ok: true,
      allowed: {
        ntsbNo: 'DFW08TA066',
        text: sectionText.slice(13),
        sha: section.sha256,
        sectionId: section.sectionId,
        revisionId: section.revisionId,
        sectionStart: 13,
        scope: 'aircraft',
        aircraftKey: 1,
      },
    });
  });

  it('refuses a broken chain', () => {
    expect(resolvePassage(ref, undefined)).toEqual({ ok: false, problem: 'no_section' });
    expect(resolvePassage({ ...ref, text: `${ref.text} ` }, section)).toEqual({ ok: false, problem: 'text_mismatch' });
    expect(resolvePassage(ref, { ...section, sha256: sha('other') })).toEqual({ ok: false, problem: 'section_hash_mismatch' });
    expect(resolvePassage({ ...ref, scope: 'event', aircraftKey: null }, section)).toEqual({ ok: false, problem: 'scope_mismatch' });
    expect(resolvePassage({ ...ref, revisionId: sha('rev2') }, section)).toEqual({ ok: false, problem: 'section_mismatch' });
    expect(resolvePassage({ ...ref, end: sectionText.length + 1 }, section)).toEqual({ ok: false, problem: 'offsets' });
  });
});
