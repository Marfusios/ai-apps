import { describe, expect, it } from 'vitest';
import { CHECK_QUOTE_MAX, CheckOutputSchema, MAX_CHECK_QUOTES, MAX_VERDICT_PASSAGES, type CheckInput, type CheckOutput } from '../../server/ai/provider.js';
import { CHECK_PROMPT_VERSION, CHECK_SYSTEM, renderCheckUser } from '../../server/ai/prompts/check.v8.js';
import { CHRONOLOGY_RULES_VERSION } from '../../server/briefs/criteria.js';
import { matchQuote, QUOTE_MAX_SOURCE } from '../../server/briefs/validate.js';
import { CHECK_QUOTE_MAX_SOURCE, CHECKER_QUOTE_RULE_VERSION, judgeCheck, matchCheckerQuote, STRUCTURAL_CHECK_CODES, type CheckJudgement } from '../../server/briefs/verdicts.js';
import { WITHHELD_CODES } from '../../server/observability/attributes.js';

/** Two cases: A (P1, P2) and B (P3). */
const input: CheckInput = {
  cases: [
    { ntsbNo: 'CEN15FA269', header: 'Grumman AA-5, partial loss of engine power during initial climb near Riverside, Missouri · 2015-07-26' },
    { ntsbNo: 'CEN24LA107', header: 'Cessna 172, loss of engine power after takeoff · 2024-01-02' },
  ],
  passages: [
    { passageId: 'P1', section: 'Analysis', scope: 'aircraft', text: 'The mechanic completed an annual inspection immediately before the flight.', ntsbNo: 'CEN15FA269' },
    { passageId: 'P2', section: 'Probable cause', scope: 'aircraft', text: 'A partial loss of engine power due to fuel contamination.', ntsbNo: 'CEN15FA269' },
    { passageId: 'P3', section: 'Probable cause', scope: 'aircraft', text: 'A loss of engine power for undetermined reasons.', ntsbNo: 'CEN24LA107' },
  ],
  claims: [
    { id: 'C1', kind: 'summary', ntsbNo: 'CEN15FA269', text: 'The engine lost power (CEN15FA269).', passageIds: ['P1', 'P2'], absence: false },
    { id: 'C2', kind: 'symptom', ntsbNo: 'CEN15FA269', text: 'The engine lost partial power.', passageIds: ['P2'], absence: false },
    {
      id: 'C3',
      kind: 'criterion',
      ntsbNo: 'CEN15FA269',
      text: 'Under the timing rules, the supplied passages of this case do not settle whether the event happened within 30 calendar days or 10 flight hours after the relevant maintenance (the annual inspection).',
      passageIds: ['P1', 'P2'],
      absence: true,
    },
    { id: 'C4', kind: 'gap', ntsbNo: 'CEN24LA107', text: 'The supplied passage gives no maintenance.', passageIds: ['P3'], absence: true },
  ],
};
const meta = [{}, {}, { criterion: 'timing_window' as const, decision: 'unknown' as const }, {}];

const allSupported = (): CheckOutput => ({
  verdicts: [
    { claim: 'C1', verdict: 'supported', passages: ['P2'] },
    { claim: 'C2', verdict: 'supported', passages: ['P2'] },
    { claim: 'C3', verdict: 'supported', passages: [] },
    { claim: 'C4', verdict: 'supported', passages: [] },
  ],
  quotes: [],
});
const judge = (out: CheckOutput): CheckJudgement => judgeCheck(input, CheckOutputSchema.parse(out), meta);
const withVerdict = (claim: string, v: Partial<CheckOutput['verdicts'][number]>): CheckOutput => {
  const out = allSupported();
  out.verdicts = out.verdicts.map((x) => (x.claim === claim ? { ...x, ...v } : x));
  return out;
};

describe('judged check verdicts (check.v8, G6 #3)', () => {
  it('passes only when every claim has exactly one valid supported verdict', () => {
    const j = judge(allSupported());
    expect(j).toEqual({
      ok: true,
      codes: [],
      structural: [],
      counts: { supported: 4, contradicted: 0, not_established: 0 },
      problems: [],
      claims: [0, 1, 2, 3].map(() => ({ verdict: 'supported', confirmed: true })),
      chronologyMissed: [],
    });
  });

  it('per claim: only a valid supported verdict confirms; a rejected claim is not structural', () => {
    const j = judge(withVerdict('C2', { verdict: 'not_established', passages: [] }));
    expect(j.structural).toEqual([]);
    expect(j.claims.map((c) => c.confirmed)).toEqual([true, false, true, true]);
    expect(j.claims[1]).toEqual({ verdict: 'not_established', confirmed: false });
    // Support from an uncited passage: the claim is not confirmed and the output is structurally invalid.
    const invalid = judge(withVerdict('C2', { passages: ['P1'] }));
    expect(invalid.claims[1]).toEqual({ verdict: 'supported', confirmed: false });
    expect(invalid.structural).toEqual(['check_invalid_evidence']);
    const missing = allSupported();
    missing.verdicts.pop();
    expect(judge(missing).structural).toEqual(['check_missing_verdict']);
    expect(judge(missing).claims[3]).toEqual({ verdict: null, confirmed: false });
    expect([...STRUCTURAL_CHECK_CODES].sort()).toEqual(['check_duplicate_verdict', 'check_invalid_evidence', 'check_invalid_quote', 'check_missing_verdict', 'check_unknown_claim']);
  });

  it('deterministic completeness: a missing, repeated or unknown claim id withholds', () => {
    const missing = allSupported();
    missing.verdicts.pop();
    expect(judge(missing)).toMatchObject({ ok: false, codes: ['check_missing_verdict'], problems: [{ claim: 'C4', index: 3, kind: 'gap', code: 'check_missing_verdict' }] });
    expect(judge({ verdicts: [], quotes: [] }).problems.map((p) => p.claim)).toEqual(['C1', 'C2', 'C3', 'C4']);
    const repeated = allSupported();
    repeated.verdicts.push({ claim: 'C2', verdict: 'supported', passages: ['P2'] });
    expect(judge(repeated)).toMatchObject({ ok: false, codes: ['check_duplicate_verdict'] });
    // A repeat cannot overturn the first verdict, whatever it says.
    const overturned = withVerdict('C2', { verdict: 'contradicted', passages: ['P2'] });
    overturned.verdicts.push({ claim: 'C2', verdict: 'supported', passages: ['P2'] });
    expect(judge(overturned).codes).toEqual(['contradicted', 'check_duplicate_verdict']);
    const unknown = allSupported();
    unknown.verdicts.push({ claim: 'C9', verdict: 'supported', passages: ['P1'] });
    expect(judge(unknown)).toMatchObject({ ok: false, codes: ['check_unknown_claim'], problems: [{ claim: 'C9', index: -1, kind: 'unknown' }] });
  });

  it('any verdict other than supported withholds, whatever the claim kind; an absence claim needs supported too', () => {
    expect(judge(withVerdict('C2', { verdict: 'not_established', passages: [] }))).toMatchObject({
      ok: false,
      codes: ['not_established'],
      counts: { supported: 3, contradicted: 0, not_established: 1 },
    });
    // "No maintenance was mentioned" is never authorized by not_established.
    expect(judge(withVerdict('C4', { verdict: 'not_established', passages: [] })).codes).toEqual(['not_established']);
    expect(judge(withVerdict('C1', { verdict: 'contradicted', passages: ['P1'] })).codes).toEqual(['contradicted']);
  });

  it('a contradicted "do not settle" criterion claim is chronology_missed, and still withholds', () => {
    const out = withVerdict('C3', { verdict: 'contradicted', passages: ['P1'] });
    out.quotes = [{ claim: 'C3', passage: 'P1', text: 'completed an annual inspection immediately before the flight' }];
    expect(judge(out)).toMatchObject({
      ok: false,
      codes: ['contradicted', 'chronology_missed'],
      chronologyMissed: [{ claim: 'C3', index: 2, ntsbNo: 'CEN15FA269', criterion: 'timing_window' }],
    });
    // Contradicting another kind of claim is not a chronology miss.
    expect(judge(withVerdict('C2', { verdict: 'contradicted', passages: ['P2'] })).chronologyMissed).toEqual([]);
  });

  it('references: supported rests on the passages the claim cites; evidence stays inside the claim’s cases', () => {
    // Correct statement, but the citation does not establish it: support found elsewhere is not support.
    expect(judge(withVerdict('C2', { passages: ['P1'] })).codes).toEqual(['check_invalid_evidence']);
    // A supported non-absence verdict names its support.
    expect(judge(withVerdict('C2', { passages: [] })).codes).toEqual(['check_invalid_evidence']);
    // Another case's passage, or one never supplied.
    expect(judge(withVerdict('C4', { passages: ['P1'] })).codes).toEqual(['check_invalid_evidence']);
    expect(judge(withVerdict('C1', { passages: ['P7'] })).codes).toEqual(['check_invalid_evidence']);
    expect(judge(withVerdict('C2', { verdict: 'contradicted', passages: ['P3'] })).codes).toEqual(['contradicted', 'check_invalid_evidence']);
    // A contradiction names the passages that conflict.
    expect(judge(withVerdict('C2', { verdict: 'contradicted', passages: [] })).codes).toEqual(['contradicted', 'check_invalid_evidence']);
    // A supported absence claim may name any of the passages it cites.
    expect(judge(withVerdict('C3', { passages: ['P1', 'P2'] })).ok).toBe(true);
  });

  it('quotes: verified word for word against the canonical passage, only for a contradiction, once per claim', () => {
    const contradicted = () => withVerdict('C1', { verdict: 'contradicted', passages: ['P2'] });
    const quote = (text: string, passage = 'P2', claim = 'C1') => ({ ...contradicted(), quotes: [{ claim, passage, text }] });
    expect(judge(quote('A partial loss of   engine power')).codes).toEqual(['contradicted']);
    expect(judge(quote('A total loss of engine power')).codes).toEqual(['contradicted', 'check_invalid_quote']);
    expect(judge(quote('A partial loss', 'P1')).codes).toEqual(['contradicted', 'check_invalid_quote']);
    expect(judge(quote('A partial')).codes).toEqual(['contradicted', 'check_invalid_quote']);
    expect(judge({ ...allSupported(), quotes: [{ claim: 'C2', passage: 'P2', text: 'A partial loss of engine power' }] }).codes).toEqual(['check_invalid_quote']);
    const twice = quote('A partial loss of engine power');
    twice.quotes.push({ claim: 'C1', passage: 'P2', text: 'due to fuel contamination' });
    expect(judge(twice).codes).toEqual(['contradicted', 'check_invalid_quote']);
  });

  it('every judged-check code is a withheld code, and the prompt states the timing rules and no "when unsure" rule', () => {
    for (const code of ['contradicted', 'not_established', 'chronology_missed', 'check_missing_verdict', 'check_invalid_quote']) {
      expect(WITHHELD_CODES).toContain(code);
    }
    expect(CHECK_PROMPT_VERSION).toBe('check.v8');
    expect(CHECK_SYSTEM).toContain(`Timing rules (${CHRONOLOGY_RULES_VERSION})`);
    expect(CHRONOLOGY_RULES_VERSION).toBe('chronology-rules-v2');
    expect(CHECK_SYSTEM).not.toMatch(/when unsure/i);
    const user = renderCheckUser(input);
    expect(user).toContain('<claim id="C3" kind="criterion" case="CEN15FA269" cites="P1 P2" absence="true">');
    expect(user).toContain('<claim id="C1" kind="summary" case="CEN15FA269" cites="P1 P2" absence="false">');
    expect(user).toContain('<case id="CEN15FA269">Grumman AA-5, partial loss of engine power during initial climb near Riverside, Missouri · 2015-07-26</case>');
  });

  it('check.v7 and v8: no criteria in the input, no blanket complete-sentence exception, context for complete sentences, meaning not wording', () => {
    expect(renderCheckUser(input)).not.toContain('<criteria>');
    expect(CHECK_SYSTEM).not.toContain('<criteria>');
    // The v5 exception the gate struck (16d reply §6): a complete sentence still needs its antecedent.
    expect(CHECK_SYSTEM).not.toMatch(/A whole sentence of a finding, analysis or probable cause keeps its meaning/);
    expect(CHECK_SYSTEM).toContain('"This failure caused the loss of power" does not say which failure');
    expect(CHECK_SYSTEM).toContain('This holds for complete sentences too');
    expect(CHECK_SYSTEM).toContain('Judge meaning, not wording');
    expect(CHECK_SYSTEM).toContain('6 weeks is 42 days');
    // check.v8 (development round 2): think through every claim, pointing words, cut excerpts, missed defects, the header's date, narrated flights.
    expect(CHECK_SYSTEM).toContain('Think before you answer. Work through the claims one at a time');
    expect(CHECK_SYSTEM).toContain('Once you have worked through every claim, return exactly one verdict for every claim');
    expect(CHECK_SYSTEM).toContain('"neither pilot" in an event with two');
    expect(CHECK_SYSTEM).toContain('When the excerpt is part of a sentence, read the whole sentence it comes from');
    expect(CHECK_SYSTEM).toContain('"an inadequate inspection led to fuel contamination" is not established');
    expect(CHECK_SYSTEM).toContain("The header's date is not a passage date");
    expect(CHECK_SYSTEM).toContain('the dates of the maintenance and of the event when the passages state both');
    expect(CHECK_SYSTEM).toContain('A passage that narrates the flights after the maintenance in order states which flight the accident flight was');
    // The bounds the parser enforces are the ones the prompt states.
    expect(CHECK_SYSTEM).toContain(`at most ${MAX_VERDICT_PASSAGES}`);
    expect(CHECK_SYSTEM).toContain(`at most ${CHECK_QUOTE_MAX.toLocaleString('en-US')} characters`);
    expect(CHECK_SYSTEM).toContain(`at most ${MAX_CHECK_QUOTES} quotes in all`);
  });

  it('checker-quote-v1: a separately versioned bound; the public citation rule keeps its 600', () => {
    expect(CHECKER_QUOTE_RULE_VERSION).toBe('checker-quote-v1');
    expect(CHECK_QUOTE_MAX_SOURCE).toBe(1_000);
    expect(QUOTE_MAX_SOURCE).toBe(600);
    // 999 characters of words, ending on a word.
    const long = 'abcdefghi '.repeat(100).slice(0, 999);
    expect(long.length).toBe(999);
    const passage = `Lead ${long} tail.`;
    expect(long.length).toBeGreaterThan(600);
    expect(matchQuote(passage, long)).toMatchObject({ ok: false, code: 'quote_too_long' });
    expect(matchCheckerQuote(passage, long).ok).toBe(true);
    const tooLong = `${long} ${'x'.repeat(10)}`;
    expect(matchCheckerQuote(`${tooLong} end`, tooLong)).toMatchObject({ ok: false, code: 'quote_too_long' });
    // A long contradiction quote is valid evidence for the judge.
    const big: CheckInput = { ...input, passages: input.passages.map((p) => (p.passageId === 'P2' ? { ...p, text: passage } : p)) };
    const out = withVerdict('C2', { verdict: 'contradicted', passages: ['P2'] });
    out.quotes = [{ claim: 'C2', passage: 'P2', text: long }];
    expect(judgeCheck(big, CheckOutputSchema.parse(out), meta).codes).toEqual(['contradicted']);
  });

  it('check-output-v2 parser bounds: 12 passages a verdict, 8 quotes, 1,000-character quotes; anything over fails the parse', () => {
    const at = allSupported();
    at.verdicts[0]!.passages = Array.from({ length: 12 }, (_, i) => `P${i + 1}`);
    at.quotes = Array.from({ length: 8 }, (_, i) => ({ claim: `C${i + 1}`, passage: 'P1', text: 'x'.repeat(1_000) }));
    expect(CheckOutputSchema.safeParse(at).success).toBe(true);
    const over = structuredClone(at);
    over.verdicts[0]!.passages.push('P13');
    expect(CheckOutputSchema.safeParse(over).success).toBe(false);
    const quotes = structuredClone(at);
    quotes.quotes.push({ claim: 'C9', passage: 'P1', text: 'a b c' });
    expect(CheckOutputSchema.safeParse(quotes).success).toBe(false);
    const longQuote = structuredClone(at);
    longQuote.quotes[0]!.text = 'x'.repeat(1_001);
    expect(CheckOutputSchema.safeParse(longQuote).success).toBe(false);
  });
});
