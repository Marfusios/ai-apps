import { ImportFailure, POLICY_VERSION, sameManifest } from './contracts.js';
import { digest } from './provenance.js';
import type { Comparison } from './compare.js';
import type { Approval, Artifact, Canary } from './store.js';
import type { ManifestIdentity } from './contracts.js';
import { z } from 'zod';
import { Sha256 } from './contracts.js';

export const ApprovalSchema=z.strictObject({archive:Sha256,environment:z.enum(['dev','live']),
  baseline:z.strictObject({generationId:z.number().int().positive(),casesIndex:z.string().min(1).max(255),
    passagesIndex:z.string().min(1).max(255),publishedAt:z.iso.datetime()}),
  policy:z.literal(POLICY_VERSION),code:z.string().regex(/^[0-9a-f]{40}$/),report:Sha256,
  reasons:z.array(z.string().min(1).max(64)).min(1).max(32).refine(v=>new Set(v).size===v.length)});

/** Only comparative policy deviations are reviewable; structural/provenance/servable/money failures never are. */
export const REVIEWABLE = new Set(['events','us_count','changed','eligible_count','eligible_losses','eligible_share',
  'section_count','characters','narrative_loss','codes','dictionary','source_coverage']);
export function checkApproval(approval: Approval | null, artifact: Pick<Artifact,'archive_sha256'|'environment'>,
  baseline: ManifestIdentity, code: string, comparison: Comparison): string[] {
  if (comparison.ok) return [];
  const reasons=[...comparison.failures].sort();
  if (!reasons.every(r=>REVIEWABLE.has(r))) throw new ImportFailure('verification');
  if (!approval || approval.archive!==artifact.archive_sha256 || approval.environment!==artifact.environment
    || approval.policy!==POLICY_VERSION || approval.code!==code || approval.report!==comparison.hash
    || !sameManifest(approval.baseline,baseline) || digest([...approval.reasons].sort())!==digest(reasons)) {
    throw new ImportFailure('cohort_bounds');
  }
  return reasons;
}
export function checkDevCanary(canary:Canary|null, current:ManifestIdentity|null,
  candidate:{archive:string;content:string;code:string;deployedCode:string}, now:Date): asserts canary is Canary {
  if (!canary || !sameManifest(canary.publication,current) || canary.archive!==candidate.archive
    || canary.content!==candidate.content || canary.code!==candidate.code || canary.deployedCode!==candidate.deployedCode
    || !/^[0-9a-f]{64}$/.test(canary.probes) || !Number.isFinite(Date.parse(canary.checkedAt))
    || Date.parse(canary.checkedAt)>now.getTime() || now.getTime()-Date.parse(canary.checkedAt)>86_400_000) {
    throw new ImportFailure('dev_failed');
  }
}
