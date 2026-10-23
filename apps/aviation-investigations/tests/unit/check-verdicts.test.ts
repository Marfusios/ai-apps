import { describe, expect, it } from 'vitest';
import { CheckOutputSchema, type CheckInput, type CheckOutput } from '../../server/ai/provider.js';
import { CHECK_PROMPT_VERSION, CHECK_SYSTEM, renderCheckUser } from '../../server/ai/prompts/check.v5.js';
import { CHRONOLOGY_RULES_VERSION } from '../../server/briefs/criteria.js';
import { judgeCheck, type CheckJudgement } from '../../server/briefs/verdicts.js';
import { WITHHELD_CODES } from '../../server/observability/attributes.js';

/** Two cases: A (P1, P2) and B (P3). */
const input: CheckInput = {
  criteria: ['Timing: the event happened within 30 calendar days or 10 flight hours after the relevant maintenance.'],
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

describe('judged check verdicts (check.v5, G6 #3)', () => {
  it('passes only when every claim has exactly one valid supported verdict', () => {
    const j = judge(allSupported());
    expect(j).toEqual({ ok: true, codes: [], counts: { supported: 4, contradicted: 0, not_established: 0 }, problems: [], chronologyMissed: [] });
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
    expect(CHECK_PROMPT_VERSION).toBe('check.v5');
    expect(CHECK_SYSTEM).toContain(`Timing rules (${CHRONOLOGY_RULES_VERSION})`);
    expect(CHECK_SYSTEM).not.toMatch(/when unsure/i);
    const user = renderCheckUser(input);
    expect(user).toContain('<claim id="C3" kind="criterion" case="CEN15FA269" cites="P1 P2" absence="true">');
    expect(user).toContain('<claim id="C1" kind="summary" case="CEN15FA269" cites="P1 P2" absence="false">');
  });
});
