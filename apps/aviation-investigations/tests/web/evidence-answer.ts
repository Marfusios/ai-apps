/**
 * What the server answers an AI search: page 1 of a search for the mock's seed question, made by
 * the mock evidence server (web/mock/evidence.ts) and checked against the contract when this
 * module loads. A contract change then fails every test that uses it at once, never only when a
 * held answer is released (an invalid answer reaches the page as a 500, and a test that expects
 * nothing to open would pass for the wrong reason).
 */
import { CreateEvidenceResponseSchema, type CreateEvidenceResponse } from '../../shared/contracts/evidence';
import { MOCK_SEED_QUESTION } from '../../web/mock/briefs';
import { MockEvidence } from '../../web/mock/evidence';

const ANSWER: CreateEvidenceResponse = CreateEvidenceResponseSchema.parse(
  new MockEvidence().create({ kind: 'question', question: MOCK_SEED_QUESTION, idempotencyKey: 'evidence-answer-fixture', turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' }).body,
);

/** That answer, for the search `id` (checked again). */
export function evidenceAnswer(id: string): CreateEvidenceResponse {
  return CreateEvidenceResponseSchema.parse({ ...ANSWER, search: { ...ANSWER.search, id } });
}
