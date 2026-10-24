/** Transport repair from the scope evaluation; the server's logical scope contract uses a discriminated union. */
import { expect, it } from 'vitest';
import { outputFormat } from '../../server/ai/anthropic.js';
import { EvidenceScopeWireOutputSchema } from '../../server/ai/prompts/scope.e1.js';

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
