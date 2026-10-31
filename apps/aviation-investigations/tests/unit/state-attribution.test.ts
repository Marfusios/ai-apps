import { describe, expect, it } from 'vitest';
import { eligibleEmittedStates } from '../../shared/state-eligibility.js';
import { STATE_V13_ABSTAIN, STATE_V13_APPLY, STATE_V13_DELIBERATE } from '../../server/evidence/state-attribution-probes.js';
import replay from '../fixtures/state-field-replay.json' with { type: 'json' };

describe('state v1.3 controller challenge', () => {
  it.each(STATE_V13_ABSTAIN)('abstains: %s', (question, states) => {
    expect(eligibleEmittedStates(question, states).states).toEqual([]);
  });
  it.each(STATE_V13_APPLY)('applies: %s', (question, states) => {
    expect(eligibleEmittedStates(question, states)).toEqual({ states: [...states], reason: 'applied' });
  });
  it.each(STATE_V13_DELIBERATE)('deliberately leaves state unapplied: %s', (question, states) => {
    expect(eligibleEmittedStates(question, states).states).toEqual([]);
  });
  it.each([
    ['Find investigations ＣＩＴＩＮＧ accidents in Ａｌａｓｋａ.', ['AK'], 'referenced_event'],
    ['Find case files with ＷＯＲＤＳ about accidents in Alaska.', ['AK'], 'title_text'],
    ['Find accidents involving aircraft ＭＡＩＮＴＡＩＮＥＤ in Alaska.', ['AK'], 'attributed_elsewhere'],
    ['Find accidents involving flights bound for an airport near Anchorage, AK.', ['AK'], 'attributed_elsewhere'],
    ['Find cases in Alaska involving pilots trained near Austin, TX.', ['AK', 'TX'], 'attributed_elsewhere'],
    ['Find investigations about the crash near Anchorage, AK.', ['AK'], 'referenced_event'],
  ] as const)('uses normalized mention boundaries and every location: %s', (question, states, reason) => {
    expect(eligibleEmittedStates(question, states)).toEqual({ states: [], reason });
  });
  it('treats the city as the start of a qualified postal mention', () => {
    expect(eligibleEmittedStates('Accidents near Prior Lake, MN.', ['MN'])).toEqual({ states: ['MN'], reason: 'applied' });
  });
  it('replays the 1,040 recorded C state outputs without provider calls', () => {
    expect(replay.cases).toHaveLength(1040);
    const guard = { tp: 0, fp: 0, fn: 0 }, pipeline = { tp: 0, fp: 0, fn: 0 };
    for (const item of replay.cases) {
      const states = eligibleEmittedStates(item.question, item.emitted).states;
      for (const [counts, applied] of [[guard, states], [pipeline, item.intent === 'case_search' ? states : []]] as const) {
        const same = JSON.stringify(applied) === JSON.stringify([...item.gold].sort());
        if (applied.length && same) counts.tp++;
        if (applied.length && !same) counts.fp++;
        if (item.gold.length && (!applied.length || !same)) counts.fn++;
      }
    }
    // Guard-only replay, not the pipeline's separate case_search intent gate.
    expect(guard).toEqual({ tp: 365, fp: 0, fn: 35 });
    expect(pipeline).toEqual({ tp: 363, fp: 0, fn: 37 });
  });
});
