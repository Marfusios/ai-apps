/**
 * Task 16e held-out set (dataset v3, held-out split): new real retrieval bundles under
 * `retrieval.v2` (`QUESTIONS_16E`), whose cases are in no earlier split, built and
 * label-frozen before any 16e checker output (the protocol, `protocol.v3.ts`, says how).
 * Empty until the bundles are retrieved.
 */
import type { BriefSpec, ClaimBatch } from '../types.js';

export const V3_HOLDOUT_BRIEFS: readonly BriefSpec[] = [];
export const V3_HOLDOUT_CLAIM_BATCHES: readonly ClaimBatch[] = [];
