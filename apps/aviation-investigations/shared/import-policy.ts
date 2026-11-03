/** Shared reason classes for server retry policy and fixed UI explanations. */
import type { AdminImportRun } from './contracts/admin.js';
export const TEMPORARY_REASONS = new Set<NonNullable<AdminImportRun['reason']>>([
  'source_unavailable',
  'source_changed_during_download',
  'post_success',
  'cache_miss',
  'monthly_budget',
  'busy',
  'backup_window',
  'lock_lost',
  'timeout',
  'interrupted',
  'dev_failed',
  'baseline_changed',
]);
