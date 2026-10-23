/** Every calibration item: claim batches (paid-run regressions and controls) and complete briefs. */
import type { BriefSpec, ClaimBatch } from '../types.js';
import { BRIEFS as ALL_BRIEFS } from './briefs.js';
import { DEV_BATCHES } from './dev.js';
import { HOLDOUT_BATCHES } from './holdout.js';
import { PAID_RUN } from './paid-run.js';
import { V2_DEV_BRIEFS, V2_DEV_CLAIM_BATCHES, V2_MAX_SIZE } from './v2-dev.js';
import { V2_HOLDOUT_BRIEFS, V2_HOLDOUT_CLAIM_BATCHES } from './v2-holdout.js';
import { V3_HOLDOUT_BRIEFS, V3_HOLDOUT_CLAIM_BATCHES } from './v3-holdout.js';

/** The 16c items (dataset v1; in v2 both of their splits are development). */
export const CLAIM_BATCHES: readonly ClaimBatch[] = [PAID_RUN, ...DEV_BATCHES, ...HOLDOUT_BATCHES];
export const BRIEFS: readonly BriefSpec[] = ALL_BRIEFS;

/** The 16d additions (dataset v2): development regressions and maximum-size briefs, and the new held-out set. */
export const V2_CLAIM_BATCHES: readonly ClaimBatch[] = [...V2_DEV_CLAIM_BATCHES, ...V2_HOLDOUT_CLAIM_BATCHES];
export const V2_BRIEFS: readonly BriefSpec[] = [...V2_DEV_BRIEFS, ...V2_HOLDOUT_BRIEFS];
export { V2_MAX_SIZE };

/** The 16e held-out set (dataset v3); everything earlier is development in v3. */
export const V3_CLAIM_BATCHES: readonly ClaimBatch[] = V3_HOLDOUT_CLAIM_BATCHES;
export const V3_BRIEFS: readonly BriefSpec[] = V3_HOLDOUT_BRIEFS;
