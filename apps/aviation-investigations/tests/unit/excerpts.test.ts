import { describe, expect, it } from 'vitest';
import { EXCERPT_CONTEXT_VERSION, excerptProblems, passageSentences, type ExcerptInput } from '../../server/briefs/excerpts.js';
import { blindCorpus16e, quoteCorpus, sentenceCorpus, figures } from '../../evals/checker/excerpts.js';
import { drawBlindSample16e } from '../../evals/checker/excerpt-sample.js';
import { EXCERPT_SENTENCES_16E } from '../../evals/checker/excerpt-sentences-16e.js';

/** The excerpt `quote` of `passage` (its first occurrence), as the investigators' words in a single-aircraft event unless `over` says otherwise. */
function x(passage: string, quote: string = passage, over: Partial<ExcerptInput> = {}): ExcerptInput {
  const start = passage.indexOf(quote);
  if (start < 0) throw new Error('the quote is not in the passage');
  return { passage, span: { start, end: start + quote.length }, speaker: 'investigators', multiAircraft: false, ...over };
}
const problems = (passage: string, quote?: string, over?: Partial<ExcerptInput>) => excerptProblems(x(passage, quote, over));

describe('excerpt-context-v1: the 16d pilot\'s two displayed misses', () => {
  it('"…the first flight after completion of this work": a complete sentence that points at work it does not name', () => {
    const passage =
      'Maintenance personnel installed the tail rotor crosshead drive plate, completed the verification and performed two maintenance runs. The accident flight was the first flight after completion of this work.';
    expect(problems(passage, 'The accident flight was the first flight after completion of this work.')).toEqual(['demonstrative']);
  });

  it('"…the last 100-Hour inspection was approximately 29 hours earlier": earlier than a point the excerpt does not state', () => {
    const passage = 'The engine had been inspected three times since the overhauled engine was installed; the last 100-Hour inspection was approximately 29 hours earlier.';
    expect(problems(passage)).toEqual(['relative_time']);
  });

  it('is versioned', () => {
    expect(EXCERPT_CONTEXT_VERSION).toBe('excerpt-context-v1');
  });
});

describe('excerpt-context-v1: each rule', () => {
  it('partial sentences: a cut start or end, and what the cut drops', () => {
    const passage = 'Examination of the engine and fuel system did not reveal any anomalies that would have resulted in a loss of engine power.';
    expect(problems(passage, 'anomalies that would have resulted in a loss of engine power')).toEqual(['partial_sentence']);
    const test = 'During a subsequent test-run of the engine, the engine lost all power whenever the right magneto was selected.';
    expect(problems(test, 'the engine lost all power')).toEqual(['partial_sentence']);
    expect(problems('He checked the "off" position when receiving the airplane, but he did not check it after finishing.', 'He checked the "off" position when receiving the airplane')).toContain('partial_sentence');
    // The whole sentence, with or without its final period: kept.
    expect(problems(passage)).toEqual([]);
    expect(problems(passage, passage.slice(0, -1))).toEqual([]);
    // A heading the stored text runs into the sentence is not part of it.
    const heading = 'WRECKAGE AND IMPACT INFORMATIONPostaccident examination revealed that the drive plate was not secured.';
    expect(problems(heading, 'Postaccident examination revealed that the drive plate was not secured.')).toEqual([]);
    // "… stated the following:" announces words the excerpt does not hold.
    expect(problems('The flight manual stated the following:')).toEqual(['partial_sentence']);
  });

  it('a pilot\'s account may leave out its lead-in; the investigators\' words may not', () => {
    const passage = 'The pilot reported that the accident flight was the first flight in the airplane since its annual inspection, which occurred about 6 weeks before the accident.';
    const quote = 'the accident flight was the first flight in the airplane since its annual inspection, which occurred about 6 weeks before the accident';
    expect(problems(passage, quote, { speaker: 'pilot' })).toEqual([]);
    expect(problems(passage, quote)).toEqual(['partial_sentence']);
    const stated = 'In the Pilot/Operator Accident Report Form, the pilot stated, “Fuel line fitting disconnected from the pump elbow.”';
    expect(problems(stated, 'Fuel line fitting disconnected from the pump elbow.', { speaker: 'pilot' })).toEqual([]);
  });

  it('leading references: pointers, pronouns and connectives; not an expletive "It", "There" or a determiner', () => {
    for (const s of [
      'These cylinders exhibited pitting damage from the spacer.',
      'This deformation may have inhibited the proper frictional resistance in the threads.',
      'It failed during the climb after takeoff.',
      'Then the engine lost power during the climb.',
      'However, the engine continued to run at reduced power.',
      'Eventually, the bearing can shift enough to cut off the oil supply.',
      'The tests showed that fuel vapor emanated from the carburetor.',
    ]) {
      expect(problems(s), s).toContain('leading_reference');
    }
    for (const s of [
      'It is likely that the mechanic failed to adequately tighten the fuel lines when he reinstalled them.',
      'It could not be determined why the fitting loosened.',
      'There was no evidence of a preimpact failure of the engine.',
      'Neither pilot was using their handheld radio to broadcast their intended traffic patterns.',
      'Both magnetos were removed and tested on a test bench.',
    ]) {
      expect(problems(s), s).toEqual([]);
    }
  });

  it('pronouns: a person named in the excerpt, or the pilot in a pilot\'s account of a single-aircraft event', () => {
    const smoke = 'Oil covered the windshield and smoke filled the cockpit, making it difficult for him to see out of the airplane.';
    expect(problems(smoke)).toEqual(['pronoun']);
    expect(problems(smoke, smoke, { speaker: 'pilot' })).toEqual([]);
    expect(problems(smoke, smoke, { speaker: 'pilot', multiAircraft: true })).toEqual(['pronoun']);
    expect(problems('During his preflight inspection, the pilot did not check the fuel quantity.')).toEqual([]);
    expect(problems('At the first fuel stop of the trip, they drained water from the fuel system.')).toEqual(['pronoun']);
    expect(problems('Several people reported that the pilot often performed maintenance; none indicated who maintained the elevator controls.')).toEqual([]);
    // First person in words given as the investigators' own quotes someone else.
    expect(problems('Send the gear motor unit to us for inspection and lubrication.')).toEqual(['pronoun']);
  });

  it('demonstratives: kept when they name the case, or a noun the excerpt names before them', () => {
    expect(problems('The probable cause of this accident was the pilot’s failure to secure the fuel cap.')).toEqual([]);
    expect(problems('The airframe maintenance records indicated that the elevator cables were replaced at that time.')).toEqual(['demonstrative']);
    expect(problems('Maintenance records also revealed that during this inspection, repairs were made to the trunnion.')).toEqual(['demonstrative']);
    expect(problems('The airplane had recently undergone an annual inspection, and the accident flight was the first flight since that maintenance was performed.')).toEqual([]);
    expect(problems('The improper installation of the securing hardware of a driveshaft section, which resulted in that section of driveshaft disconnecting.')).toEqual([]);
  });

  it('relative times: kept with their anchor', () => {
    for (const s of [
      'The accident flight was conducted 2 days later, and lasted about 30 minutes.',
      'The pilot had refueled the airplane earlier.',
      'The mechanic replaced the magneto the previous day.',
      'The airplane was flown the day before.',
      'The operator reported six engine fires within the previous 6 months.',
    ]) {
      expect(problems(s), s).toContain('relative_time');
    }
    for (const s of [
      'The engine failure occurred about 198 hours after the cylinders were replaced.',
      'Eleven days before the accident flight, the pilot observed decreased manifold pressure.',
      'The airplane had undergone maintenance a few days before the accident.',
      'About 5 minutes after takeoff, the engine lost total power.',
      'The mechanic replaced the magneto the day before the accident.',
      'The pilot reported discrepancies, a rough running engine (which was later attributed to water ingestion) among them.',
    ]) {
      expect(problems(s), s).toEqual([]);
    }
  });

  it('relative sequences: a flight counted from something unstated, and "then"', () => {
    expect(problems('The accident flight was the airplane’s next flight.')).toEqual(['relative_sequence']);
    expect(problems('On the second flight, the engine lost power.')).toEqual(['relative_sequence']);
    expect(problems('The nut then gradually loosened and fell off, which allowed the bolt to become loose.')).toEqual(['relative_sequence']);
    expect(problems('The next entry was dated April 17, 2013, and stated that an overhauled propeller was installed.')).toEqual(['relative_sequence']);
    expect(problems('The accident flight was the first flight after the airplane’s annual inspection.')).toEqual([]);
    expect(problems('The airborne segment of the first flight subsequent to the installation of the new engine systems lasted about 5 minutes.')).toEqual([]);
  });

  it('comparisons: kept with their object, and "the other airplane" in a two-aircraft event', () => {
    expect(problems('Similar debris was found in the previously installed manifold valve.')).toEqual(['comparison']);
    expect(problems('The most recent engine maintenance was performed 6 days before the accident by the same mechanic.')).toEqual(['comparison']);
    expect(problems('Examination of the debris found that it was similar in composition to a sample of torque putty.')).toEqual([]);
    const other = 'The failure of both pilots to see and avoid the other airplane, which resulted in a midair collision.';
    expect(problems(other, other, { multiAircraft: true })).toEqual([]);
    expect(problems(other)).toEqual(['comparison']);
    // Additive words do not change what the excerpt states.
    expect(problems('Also causal was the mechanic’s inadequate inspection of the airplane fuel system.')).toEqual([]);
  });

  it('passage sentences: abbreviations do not end a sentence, line breaks do', () => {
    const text = 'The No. 2 cylinder was removed. Approx. 5 quarts of oil remained.\nThe U.S. operator agreed.';
    expect(passageSentences(text).map((s) => text.slice(s.start, s.end))).toEqual(['The No. 2 cylinder was removed.', 'Approx. 5 quarts of oil remained.', 'The U.S. operator agreed.']);
  });
});

describe('excerpt-context-v1 on its corpora (evals/checker/excerpts.ts)', () => {
  it('omits every calibration quote labelled a context loss or misleading excerpt, and no reviewed standalone one', () => {
    const f = figures(quoteCorpus());
    expect(f.catches.k).toBe(f.catches.n);
    expect(f.falseOmissions.k).toBe(0);
  });

  it('the sentence sample: false omissions stay rare', () => {
    const f = figures(sentenceCorpus());
    expect(f.items).toBe(200);
    expect(f.falseOmissions.rate!).toBeLessThanOrEqual(0.02);
  });
});

describe('the blind sample (Task 16e): the labelled file is exactly the fixed draw', () => {
  it('holds the 200 drawn sentences, in order, each labelled', () => {
    const draw = drawBlindSample16e();
    expect(draw).toHaveLength(200);
    expect(EXCERPT_SENTENCES_16E.map(({ id, ntsbNo, passageId, section, text }) => ({ id, ntsbNo, passageId, section, text }))).toEqual(
      draw.map(({ id, ntsbNo, passageId, section, text }) => ({ id, ntsbNo, passageId, section, text })),
    );
    for (const s of EXCERPT_SENTENCES_16E) if (s.label === 'needs_context') expect(s.reason, s.id).toBeTruthy();
  });
});

describe('excerpt-context-v1 on the blind sample (the measurement)', () => {
  it('records the frozen rule\'s measured figures: a changed rule needs a new blind sample', () => {
    const f = figures(blindCorpus16e());
    expect(f).toMatchObject({ items: 200, standalone: 166, needsContext: 34 });
    expect(f.falseOmissions).toMatchObject({ k: 7, n: 166 });
    expect(f.catches).toMatchObject({ k: 18, n: 34 });
  });
});
