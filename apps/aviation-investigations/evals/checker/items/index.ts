/** Every calibration item: claim batches (paid-run regressions and controls) and complete briefs. */
import type { BriefSpec, ClaimBatch } from '../types.js';
import { BRIEFS as ALL_BRIEFS } from './briefs.js';
import { DEV_BATCHES } from './dev.js';
import { HOLDOUT_BATCHES } from './holdout.js';
import { PAID_RUN } from './paid-run.js';

export const CLAIM_BATCHES: readonly ClaimBatch[] = [PAID_RUN, ...DEV_BATCHES, ...HOLDOUT_BATCHES];
export const BRIEFS: readonly BriefSpec[] = ALL_BRIEFS;
