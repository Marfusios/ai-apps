/** Exact request identity across the v2 -> v3 response-contract upgrade. */
import { EVIDENCE_CONTRACT_VERSION, type CreateEvidenceRequest } from '../../shared/contracts/evidence.js';
import { canonicalRequestHash } from '../quota/policy.js';

export function evidenceRequestHashes(body: CreateEvidenceRequest): { current: string; legacyV2: string | null } {
  const { turnstileToken: _token, idempotencyKey: _key, ...content } = body;
  const legacyKeys = body.kind === 'question' ? ['kind', 'question'] : ['kind', 'from', 'filters', 'terms'];
  // Hash the entire compatible body, never a projection that drops new fields.
  // An explicit v3-only key (even undefined in an internal caller) is incompatible.
  return {
    current: canonicalRequestHash({ version: EVIDENCE_CONTRACT_VERSION, ...content }),
    legacyV2: Object.keys(content).every(key => legacyKeys.includes(key))
      ? canonicalRequestHash({ version: 'evidence.v2', ...content }) : null,
  };
}
