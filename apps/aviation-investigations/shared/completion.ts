/**
 * Completion classes for NTSB records. The raw `NTSB_Admin.rec_stat` is kept as-is;
 * this mapping only decides which codes may be called completed. Completion is
 * independent of whether probable-cause text exists (UI_DESIGN §4.2).
 */

export type CompletionClass = 'completed' | 'in_progress' | 'status_unknown' | 'other_status';

export interface CompletionMapping {
  readonly version: string;
  /** True only once the mapping is confirmed with NTSB metadata. */
  readonly verified: boolean;
  readonly completedStatuses: readonly string[];
  /** Used only when `verified`; unverified mappings never claim "in progress". */
  readonly inProgressStatuses: readonly string[];
}

/**
 * Empirical mapping from the 2026-10-16 snapshot (amendment A5): every US record with
 * probable-cause text had status B. It is not confirmed by NTSB metadata, so the
 * answer-eligible cohort is a provisional development cohort and production launch
 * is blocked until `verified` is true. F is never guessed to mean final.
 */
export const COMPLETION_MAPPING_V1: CompletionMapping = {
  version: 'v1-empirical',
  verified: false,
  completedStatuses: ['B'],
  inProgressStatuses: [],
};

export const COMPLETION_BADGE: Readonly<Record<CompletionClass, string>> = {
  completed: 'COMPLETED',
  in_progress: 'IN PROGRESS',
  status_unknown: 'STATUS UNKNOWN',
  other_status: 'OTHER STATUS',
};

/**
 * `completed` for a completed status. Under a verified mapping, `in_progress` for a
 * listed in-progress status and `status_unknown` for blank or unmapped codes; under
 * an unverified mapping everything else is `other_status`. Codes match exactly
 * after trimming field padding.
 */
export function completionClassOf(
  rawStatus: string | null,
  mapping: CompletionMapping = COMPLETION_MAPPING_V1,
): CompletionClass {
  const status = (rawStatus ?? '').trim();
  if (status !== '' && mapping.completedStatuses.includes(status)) return 'completed';
  if (!mapping.verified) return 'other_status';
  if (status !== '' && mapping.inProgressStatuses.includes(status)) return 'in_progress';
  return 'status_unknown';
}

/** Completed status and nonblank probable-cause text, in any country. */
export function isCompletedWithCause(c: {
  readonly completionClass: CompletionClass;
  readonly hasProbableCause: boolean;
}): boolean {
  return c.completionClass === 'completed' && c.hasProbableCause;
}

/** The answer cohort: US events that are completed with probable-cause text. */
export function isAnswerEligible(c: {
  readonly isUs: boolean;
  readonly completionClass: CompletionClass;
  readonly hasProbableCause: boolean;
}): boolean {
  return c.isUs && isCompletedWithCause(c);
}

/** The answer cohort is provisional while the mapping is unverified. */
export function isCohortProvisional(mapping: CompletionMapping): boolean {
  return !mapping.verified;
}
