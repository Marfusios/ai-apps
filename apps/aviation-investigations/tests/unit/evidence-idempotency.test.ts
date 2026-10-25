import { describe, expect, it } from 'vitest';
import { evidenceRequestHashes } from '../../server/evidence/idempotency.js';
import { canonicalRequestHash } from '../../server/quota/policy.js';
import { CreateEvidenceRequestSchema, type CreateEvidenceRequest } from '../../shared/contracts/evidence.js';

const key = 'legacy-retry-key', from = '0b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f';
describe('exact v2 evidence retry identity', () => {
  it.each([
    { kind: 'question', question: 'Find accidents in Alaska' },
    { kind: 'edited', from, filters: {} },
    { kind: 'edited', from, filters: { state: ['AK'] }, terms: 'engine failure' },
  ])('preserves every legacy $kind field while excluding challenge and retry tokens', content => {
    const body = CreateEvidenceRequestSchema.parse({ ...content, idempotencyKey: key, turnstileToken: 'first-token' });
    const hashes = evidenceRequestHashes(body);
    expect(hashes).toEqual({ current: canonicalRequestHash({ version: 'evidence.v3', ...content }),
      legacyV2: canonicalRequestHash({ version: 'evidence.v2', ...content }) });
    expect(evidenceRequestHashes({ ...body, idempotencyKey: 'different-retry-key', turnstileToken: 'fresh-token' })).toEqual(hashes);
  });
  it('never drops v3-only or future fields to obtain a legacy hash', () => {
    const legacy = CreateEvidenceRequestSchema.parse({ kind: 'edited', from, filters: {}, idempotencyKey: key });
    for (const extra of [{ keywords: 'question' }, { keywords: undefined }, { futureField: true }]) {
      expect(evidenceRequestHashes({ ...legacy, ...extra } as CreateEvidenceRequest).legacyV2).toBeNull();
    }
  });
  it('different content does not match either version of the original hash', () => {
    const original = CreateEvidenceRequestSchema.parse({ kind: 'edited', from, filters: {}, terms: 'engine', idempotencyKey: key });
    const hashes = Object.values(evidenceRequestHashes(original));
    for (const changes of [{ terms: 'icing' }, { filters: { state: ['AK'] } }, { from: '1b6f2c1e-8d4a-4c51-9f0e-1a2b3c4d5e6f' }]) {
      for (const hash of Object.values(evidenceRequestHashes({ ...original, ...changes } as CreateEvidenceRequest))) expect(hashes).not.toContain(hash);
    }
  });
});
