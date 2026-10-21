import { describe, expect, it } from 'vitest';
import {
  COMPLETION_BADGE,
  COMPLETION_MAPPING_V1,
  completionClassOf,
  isAnswerEligible,
  isCohortProvisional,
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

describe('isAnswerEligible', () => {
  it('completed B with cause is answer-eligible', () => {
    expect(isAnswerEligible({ completionClass: completionClassOf('B'), hasProbableCause: true })).toBe(true);
  });

  it('B without cause stays completed but not eligible', () => {
    const completionClass = completionClassOf('B');
    expect(completionClass).toBe('completed');
    expect(isAnswerEligible({ completionClass, hasProbableCause: false })).toBe(false);
  });

  it('a cause alone does not make a non-completed record eligible', () => {
    expect(isAnswerEligible({ completionClass: 'other_status', hasProbableCause: true })).toBe(false);
    expect(isAnswerEligible({ completionClass: 'in_progress', hasProbableCause: true })).toBe(false);
    expect(isAnswerEligible({ completionClass: 'status_unknown', hasProbableCause: true })).toBe(false);
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
