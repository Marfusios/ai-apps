/** The cost gate: admission, settlement, spend metering, pacing and AI status (DESIGN §7–§9). */
export {
  accountDailyLimit,
  admitPaidRequest,
  createTrialIdentity,
  recordAttempt,
  rejectionStatus,
  releaseQuota,
  setResultRef,
  type Admission,
  type AdmissionInput,
  type AdmissionResult,
  type AttemptInput,
  type AttemptResult,
  type PauseReason,
  type Rejection,
  type RejectionReason,
  type ReleaseResult,
  type ReplayedAdmission,
} from './admit.js';
export {
  dailyAllowanceUsd,
  remainingCategoryUsd,
  remainingDaysInMonth,
  spendSnapshot,
  type LedgerState,
  type SpendSnapshot,
} from './pacing.js';
export {
  DEFAULT_RATE_LIMITS,
  IDEMPOTENCY_TTL_MS,
  LEASE_TTL_MS,
  PIPELINE_DEADLINE_MS,
  QuotaConfigError,
  QuotaInputError,
  UnknownPrincipalError,
  accountIdentityHash,
  canonicalRequestHash,
  quotaPolicy,
  type Principal,
  type QuotaBudgets,
  type QuotaLimits,
  type QuotaPolicy,
} from './policy.js';
export { runControlMaintenance, startControlMaintenance, type MaintenanceJob, type MaintenanceResult } from './maintenance.js';
export { pruneControls, type PruneReport } from './retention.js';
export {
  expireLeases,
  settle,
  settleReservation,
  type SettleResult,
  type SpendLine,
  type SpendUsage,
} from './settle.js';
export {
  reserveSpend,
  settleSpend,
  type IngestionCategory,
  type ReserveSpendInput,
  type SpendRefusal,
  type SpendRequest,
  type SpendReservation,
} from './spend.js';
export { aiStatus, type AiRemaining, type AiState, type AiStatus, type AiStatusOptions, type AiStatusReason } from './status.js';
export { readAiSwitch, setAiSwitch, setAnonymousAi, type AiSwitchState } from './switch.js';
