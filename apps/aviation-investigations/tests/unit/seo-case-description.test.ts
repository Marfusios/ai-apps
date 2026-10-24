/**
 * A case page's description (server/seo/case-description.ts): the case's type, number, date,
 * aircraft and injuries, then its probable cause or, without one, what its status is; cut at a
 * word to 200 characters. Case records come from the mock API's fixture projection; expected
 * strings are written out.
 */
import { describe, expect, it } from 'vitest';
import { caseDescription, injuryPhrase, statusSentence, truncateAtWord } from '../../server/seo/case-description.js';
import { mockCase as fixture } from '../support/mock-cases.js';

describe('a case description', () => {
  it('a case: type, number, date, aircraft and injuries, then the probable cause, cut at a word to 200 characters', () => {
    const text = caseDescription(fixture('DFW08TA066'));
    expect(text).toBe(
      "NTSB accident investigation DFW08TA066, 8 Feb 2008: N66372 (Hughes OH-6), minor injuries. Probable cause: The contract mechanic's failure to properly secure the castellated nut that attached the…",
    );
    expect(text.length).toBeLessThanOrEqual(200);
  });

  it('a short one is not cut, and several aircraft are joined with "and"', () => {
    expect(caseDescription(fixture('SEA08LA057'))).toBe(
      "NTSB accident investigation SEA08LA057, 1 Jan 2008: N8037W (Piper PA 28-180) and N15EX (Barnard/Stancil Glastar), no injuries. Probable cause: The departing pilot's inadequate visual lookout.",
    );
    expect(caseDescription(fixture('DCA25MA108'))).toMatch(
      /^NTSB accident investigation DCA25MA108, 30 Jan 2025: N709PS \(Bombardier CL-600-2C10\) and UNREG \(Sikorsky UH60\), 67 fatal\. Probable cause: The Federal Aviation Administration’s .+…$/,
    );
  });

  it('a record without probable-cause text says what its status is, with the raw NTSB status', () => {
    expect(caseDescription(fixture('CEN23LA137'))).toBe(
      'NTSB accident investigation CEN23LA137, 4 Mar 2023: N131HL (Piper PA-46-600TP), no injuries. Other investigation status (NTSB status P).',
    );
    expect(caseDescription(fixture('CEN22LA442'))).toBe(
      'NTSB accident investigation CEN22LA442, 27 Sep 2022: N7207 (Piper PA-18), no injuries. Other investigation status (NTSB status blank).',
    );
    // Completed without probable-cause text: what the case page says beside its badge.
    expect(caseDescription(fixture('ENG08WA029'))).toBe(
      'NTSB incident investigation ENG08WA029, 6 Jun 2008: OB-1799-P (Boeing 737-2A5), no injuries. Probable-cause text unavailable.',
    );
  });

  it('each completion class has its own words (a verified mapping classes records in progress or unknown)', () => {
    expect(statusSentence({ class: 'completed', rawStatus: 'B' })).toBe('Probable-cause text unavailable.');
    expect(statusSentence({ class: 'in_progress', rawStatus: 'P' })).toBe('Investigation in progress (NTSB status P).');
    expect(statusSentence({ class: 'status_unknown', rawStatus: null })).toBe('Investigation status unknown (NTSB status blank).');
    expect(statusSentence({ class: 'status_unknown', rawStatus: '  ' })).toBe('Investigation status unknown (NTSB status blank).');
    expect(statusSentence({ class: 'other_status', rawStatus: ' F ' })).toBe('Other investigation status (NTSB status F).');
    const inProgress = fixture('CEN23LA137');
    inProgress.completion = { ...inProgress.completion, class: 'in_progress', mappingVerified: true };
    expect(caseDescription(inProgress)).toMatch(/, no injuries\. Investigation in progress \(NTSB status P\)\.$/);
  });

  it('a record with probable-cause text gives it whatever its status', () => {
    const conflict = fixture('SEA08LA057');
    conflict.completion = { ...conflict.completion, class: 'other_status', rawStatus: 'P' };
    expect(caseDescription(conflict)).toMatch(/Probable cause: The departing pilot's inadequate visual lookout\.$/);
  });

  it('leaves out what is not recorded: the event type, the date, a registration', () => {
    const d = fixture('CEN23LA137');
    d.eventType = { code: null, label: 'Not reported' };
    d.date = null;
    d.aircraft[0]!.registration = '  ';
    expect(caseDescription(d)).toBe('NTSB investigation CEN23LA137: Piper PA-46-600TP, no injuries. Other investigation status (NTSB status P).');
    d.eventType = { code: 'UNK', label: 'Unknown event type' };
    d.aircraft = [];
    expect(caseDescription(d)).toBe('NTSB investigation CEN23LA137: Unidentified aircraft, no injuries. Other investigation status (NTSB status P).');
    d.eventType = { code: 'INC', label: 'Incident' };
    expect(caseDescription(d)).toMatch(/^NTSB incident investigation CEN23LA137: /);
  });

  it('collapses the narrative’s whitespace and drops control characters', () => {
    const d = fixture('SEA08LA057');
    d.sections = d.sections.map((s) => (s.kind === 'probable_cause' ? { ...s, text: 'The pilot’s\n\ninadequate\tlookout.\u0000\u0007  ' } : s));
    expect(caseDescription(d)).toMatch(/Probable cause: The pilot’s inadequate lookout\.$/);
  });
});

describe('injury phrase', () => {
  const of = (fatal: number | null, serious: number | null, minor: number | null, code: string | null = null, label = 'Not reported') =>
    injuryPhrase({ injuries: { fatal, serious, minor, uninjured: null }, highestInjury: { code, label } });

  it('names the most serious injury recorded', () => {
    expect(of(1, 2, 3)).toBe('1 fatal');
    expect(of(3, 0, 0)).toBe('3 fatal');
    expect(of(0, 2, 5)).toBe('serious injuries');
    expect(of(0, 0, 1)).toBe('minor injuries');
    expect(of(0, 0, 0)).toBe('no injuries');
  });

  it('never says "no injuries" when the counts are not recorded', () => {
    expect(of(null, null, null)).toBe('injuries not reported');
    expect(of(0, null, 0, 'FATL', 'Fatal')).toBe('highest injury: fatal');
    expect(of(null, null, 2)).toBe('minor injuries');
  });
});

describe('truncating at a word', () => {
  it('keeps text that fits', () => {
    expect(truncateAtWord('a'.repeat(200), 200)).toBe('a'.repeat(200));
    expect(truncateAtWord('short text', 200)).toBe('short text');
  });

  it('cuts at the last whole word, ends in "…", and stays within the limit', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const cut = truncateAtWord(words, 200);
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut.endsWith('…')).toBe(true);
    const kept = cut.slice(0, -1);
    expect(words.startsWith(`${kept} `)).toBe(true);
  });

  it('keeps a word that ends exactly at the limit, and drops punctuation before the ellipsis', () => {
    // 199 characters, then a space: the last word fits whole.
    const fits = `${'x'.repeat(194)} abcd efgh`;
    expect(truncateAtWord(fits, 200)).toBe(`${'x'.repeat(194)} abcd…`);
    expect(truncateAtWord(`${'x'.repeat(190)} clause, and more words`, 200)).toBe(`${'x'.repeat(190)} clause…`);
  });

  it('cuts a single overlong word, and counts characters, not UTF-16 units', () => {
    expect(truncateAtWord('y'.repeat(300), 200)).toBe(`${'y'.repeat(199)}…`);
    const emoji = '🛩'.repeat(300);
    const cut = truncateAtWord(emoji, 200);
    expect(Array.from(cut).length).toBeLessThanOrEqual(200);
    expect(cut).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
});
