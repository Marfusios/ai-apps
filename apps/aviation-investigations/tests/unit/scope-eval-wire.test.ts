/** Transport repair from the scope evaluation; the server's logical scope contract uses a discriminated union. */
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { outputFormat } from '../../server/ai/anthropic.js';
import { EVIDENCE_SCOPE_SYSTEM, EvidenceScopeWireOutputSchema } from '../../server/ai/prompts/scope.e1.js';

it('encodes evidence scope in an object envelope without the rejected root anyOf/$defs combination', () => {
  const format = outputFormat(EvidenceScopeWireOutputSchema);
  expect(format.schema).toMatchObject({ type: 'object', required: ['result'], additionalProperties: false });
  expect(format.schema).not.toHaveProperty('anyOf');
  expect(format.parse('{"result":{"intent":"case_search","filters":{"state":["CA"]},"terms":"icing"}}'))
    .toMatchObject({ result: { intent: 'case_search', filters: { state: ['CA'] } } });
  expect(format.parse('{"result":{"intent":"operational_advice","filters":{}}}'))
    .toMatchObject({ result: { intent: 'operational_advice' } });
  expect(format.parse('{"result":{"intent":"case_search","filters":{"yearFrom":0},"terms":"icing"}}')).toBeNull();
  expect(format.parse('{"intent":"operational_advice","filters":{}}')).toBeNull();
});

it('keeps the evaluated scope.e3 prompt and transformed wire schema frozen at d60d912', () => {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  expect(hash(EVIDENCE_SCOPE_SYSTEM)).toBe('901abbf596ebd86ea32afb5c241c51cace149d89958ab1a8a75398930c041b04');
  expect(hash(JSON.stringify(outputFormat(EvidenceScopeWireOutputSchema).schema))).toBe('cb20cf6bc65ecd99328518c75e1513e716b92b59a272f5d86a9f022d8ddc85c9');
});
