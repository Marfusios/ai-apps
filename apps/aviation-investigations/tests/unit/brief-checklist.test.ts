import { describe, expect, it } from 'vitest';
import { ChecklistSchema, type Checklist } from '../../shared/contracts/briefs.js';
import { interpretationChips } from '../../server/briefs/clarify.js';
import type { StepIntent } from '../../server/briefs/intent.js';
import { checklistOf } from '../../server/routes/briefs.js';

// The checklist as a read returns it (server/routes/briefs.ts `checklistOf`): the stored one,
// plus the scope stage's readings and filters once it has sent the step on to search. A stored
// intent that cannot be rendered must never turn the read into a 500 (the response is parsed
// against the contract), so the field is left out instead.

const PLANNER_WORDS = 'planner keyword words that no reader may be sent';

/** A stored intent; `over` replaces fields wholesale, so a test can store any shape. */
const storedIntent = (over: Record<string, unknown> = {}): StepIntent =>
  ({
    intent: 'case_search',
    mechanicalCause: true,
    filters: { category: ['HELI'] },
    keywordText: PLANNER_WORDS,
    readings: { timingWindow: { value: { days: 30, flightHours: 10 }, pinned: false } },
    caseNumbers: [],
    ...over,
  }) as StepIntent;

const SCOPE_DONE: Checklist = { question: 'in_scope' };

describe('the checklist of a read', () => {
  it('is the stored one before the scope stage has sent the step on, and without a stored intent', () => {
    const early: Checklist = {};
    expect(checklistOf({ checklist: early, intent: storedIntent() })).toBe(early);
    expect(checklistOf({ checklist: SCOPE_DONE, intent: null })).toBe(SCOPE_DONE);
  });

  it('adds the readings and filters from server templates once the scope stage is done, and keeps the rest', () => {
    const stored: Checklist = { question: 'in_scope', searched: { cases: 6, passages: 12 }, written: true, verified: 'passed' };
    const before = structuredClone(stored);
    const out = checklistOf({
      checklist: stored,
      intent: storedIntent({
        readings: {
          timingWindow: { value: { days: 30, flightHours: 10 }, pinned: false },
          firstFlightOnly: { value: true, pinned: true },
          failureType: { value: 'rough_running', pinned: true },
        },
      }),
    });
    expect(out).toEqual({
      ...stored,
      interpretation: {
        interpretations: [
          { field: 'timing_window', value: { days: 30, flightHours: 10 }, label: 'Within 30 days or 10 flight hours', pinned: false },
          { field: 'first_flight_only', value: true, label: 'First flight after maintenance only', pinned: true },
          { field: 'failure_type', value: 'rough_running', label: 'Engine running rough', pinned: true },
        ],
        filters: { category: ['HELI'] },
      },
    });
    // The stored checklist is not changed, and the planner's own words are never in it.
    expect(stored).toEqual(before);
    expect(JSON.stringify(out)).not.toContain(PLANNER_WORDS);
  });

  it('has no chips to show for an intent without readings, and still carries its filters', () => {
    expect(checklistOf({ checklist: SCOPE_DONE, intent: storedIntent({ readings: {} }) })).toEqual({
      question: 'in_scope',
      interpretation: { interpretations: [], filters: { category: ['HELI'] } },
    });
  });

  // Values the contract refuses: the field is left out and the read still answers.
  const outOfContract: [string, Record<string, unknown>][] = [
    ['days 0', { readings: { timingWindow: { value: { days: 0, flightHours: null }, pinned: false } } }],
    ['days 366', { readings: { timingWindow: { value: { days: 366, flightHours: null }, pinned: false } } }],
    ['flight hours 501', { readings: { timingWindow: { value: { days: null, flightHours: 501 }, pinned: false } } }],
    ['a fractional day count', { readings: { timingWindow: { value: { days: 1.5, flightHours: null }, pinned: false } } }],
    ['a window with neither days nor hours', { readings: { timingWindow: { value: { days: null, flightHours: null }, pinned: false } } }],
    ['an unknown failure type', { readings: { failureType: { value: 'explode', pinned: true } } }],
    ['a reading without its pinned flag', { readings: { failureType: { value: 'rough_running' } } }],
    ['a failure reading that is a bare string', { readings: { failureType: 'rough_running' } }],
    ['a filter value outside the vocabulary', { filters: { category: ['SUBMARINE'] } }],
    ['an unknown filter facet', { filters: { colour: ['red'] } }],
    ['a reversed year range', { filters: { yearFrom: 2020, yearTo: 2010 } }],
    ['filters that are null', { filters: null }],
    ['no filters at all', { filters: undefined }],
  ];

  // Shapes the pipeline never writes: building the chips itself throws, so the guard has to
  // sit around that call and not only around the schema check.
  const malformedShapes: [string, unknown][] = [
    ['readings missing', storedIntent({ readings: undefined })],
    ['readings null', storedIntent({ readings: null })],
    ['a timing window without its value', storedIntent({ readings: { timingWindow: { pinned: true } } })],
    ['a timing window with a null value', storedIntent({ readings: { timingWindow: { value: null, pinned: false } } })],
    ['a timing window that is a bare string', storedIntent({ readings: { timingWindow: 'soon' } })],
    ['an intent that is a bare string', 'oops'],
  ];

  it.each(outOfContract)('leaves the field out and still answers: %s', (_name, over) => {
    const out = checklistOf({ checklist: SCOPE_DONE, intent: storedIntent(over) });
    expect(out).toBe(SCOPE_DONE);
    expect(ChecklistSchema.safeParse(out).success).toBe(true);
  });

  it.each(malformedShapes)('never throws on a malformed stored intent: %s', (_name, shape) => {
    const intent = shape as StepIntent;
    // The chips builder does throw on these, which is what the guard is for.
    expect(() => interpretationChips(intent.readings)).toThrow(TypeError);
    const out = checklistOf({ checklist: SCOPE_DONE, intent });
    expect(out).toBe(SCOPE_DONE);
    expect(ChecklistSchema.safeParse(out).success).toBe(true);
  });
});
