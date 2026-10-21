import { describe, expect, it } from 'vitest';
import {
  COMPLETION_BADGE,
  COMPLETION_MAPPING_V1,
  completionClassOf,
  isAnswerEligible,
  isCohortProvisional,
  isCompletedWithCause,
  type CompletionMapping,
} from '../../shared/completion.js';

const VERIFIED: CompletionMapping = {
  version: 'test-verified',
  verified: true,
  completedStatuses: ['B'],
  inProgressStatuses: ['P'],
};

describe('COMPLETION_MAPPING_V1', () => {
  it('is the empirical, unverified mapping from amendment A5', () => {
    expect(COMPLETION_MAPPING_V1).toEqual({
      version: 'v1-empirical',
      verified: false,
      completedStatuses: ['B'],
      inProgressStatuses: [],
    });
  });

  it('marks the answer cohort provisional while unverified', () => {
    expect(isCohortProvisional(COMPLETION_MAPPING_V1)).toBe(true);
    expect(isCohortProvisional(VERIFIED)).toBe(false);
  });
});

describe('completionClassOf', () => {
  it('classifies B as completed', () => {
    expect(completionClassOf('B', COMPLETION_MAPPING_V1)).toBe('completed');
  });

  it('P is other_status while mapping unverified', () => {
    expect(completionClassOf('P', COMPLETION_MAPPING_V1)).toBe('other_status');
  });

  it('never guesses F or blank while unverified', () => {
    expect(completionClassOf('F', COMPLETION_MAPPING_V1)).toBe('other_status');
    expect(completionClassOf('', COMPLETION_MAPPING_V1)).toBe('other_status');
    expect(completionClassOf(null, COMPLETION_MAPPING_V1)).toBe('other_status');
  });

  it('uses in_progress and status_unknown only under a verified mapping', () => {
    expect(completionClassOf('B', VERIFIED)).toBe('completed');
    expect(completionClassOf('P', VERIFIED)).toBe('in_progress');
    expect(completionClassOf('F', VERIFIED)).toBe('status_unknown');
    expect(completionClassOf(null, VERIFIED)).toBe('status_unknown');
    expect(completionClassOf('', VERIFIED)).toBe('status_unknown');
  });

  it('matches status codes exactly after trimming padding', () => {
    expect(completionClassOf(' B ', COMPLETION_MAPPING_V1)).toBe('completed');
    expect(completionClassOf('b', COMPLETION_MAPPING_V1)).toBe('other_status');
  });

  it('defaults to the v1 mapping', () => {
    expect(completionClassOf('B')).toBe('completed');
    expect(completionClassOf('P')).toBe('other_status');
  });
});

describe('isCompletedWithCause', () => {
  it('completed B with cause is completed with cause', () => {
    expect(isCompletedWithCause({ completionClass: completionClassOf('B'), hasProbableCause: true })).toBe(true);
  });

  it('B without cause stays completed but not completed with cause', () => {
    const completionClass = completionClassOf('B');
    expect(completionClass).toBe('completed');
    expect(isCompletedWithCause({ completionClass, hasProbableCause: false })).toBe(false);
  });

  it('a cause alone does not make a non-completed record qualify', () => {
    for (const completionClass of ['other_status', 'in_progress', 'status_unknown'] as const) {
      expect(isCompletedWithCause({ completionClass, hasProbableCause: true })).toBe(false);
    }
  });
});

describe('isAnswerEligible', () => {
  it('completed B with cause in the US is answer-eligible', () => {
    expect(isAnswerEligible({ isUs: true, completionClass: completionClassOf('B'), hasProbableCause: true })).toBe(true);
  });

  it('B without cause stays completed but not eligible', () => {
    expect(isAnswerEligible({ isUs: true, completionClass: completionClassOf('B'), hasProbableCause: false })).toBe(false);
  });

  it('a non-US completed record with cause is not eligible', () => {
    expect(isAnswerEligible({ isUs: false, completionClass: 'completed', hasProbableCause: true })).toBe(false);
  });

  it('a US record outside the completed set is not eligible', () => {
    expect(isAnswerEligible({ isUs: true, completionClass: 'other_status', hasProbableCause: true })).toBe(false);
  });
});

describe('COMPLETION_BADGE', () => {
  it('uses the UI badge copy', () => {
    expect(COMPLETION_BADGE).toEqual({
      completed: 'COMPLETED',
      in_progress: 'IN PROGRESS',
      status_unknown: 'STATUS UNKNOWN',
      other_status: 'OTHER STATUS',
    });
  });
});
